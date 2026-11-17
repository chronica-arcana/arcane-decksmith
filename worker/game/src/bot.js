/**
 * Bot-Gegner. Er spielt serverseitig mit dem Deck, das der Spieler für ihn gewählt hat (aus der eigenen Sammlung), und nutzt dieselben Regeln
 * wie jeder Spieler: Er sieht nur seine eigene Hand, nie fremde Karten. `nextBotAction` liefert die nächste Aktion für den Bot oder `null`,
 * wenn er gerade nichts tun muss.
 *
 * Spielweise: einfache, solide Heuristiken (Länder legen, teuerste bezahlbare Zauber zuerst, feindliche Zauber auf Gegner, hilfreiche auf eigene
 * Karten, sichere Angriffe, gute Blocks, Mulligan bei zu wenig oder zu vielen Ländern).
 */
import { _internals, gameView } from "./gameLogic.js";

const { defOf, powerOf, toughnessOf, hasKeyword } = _internals;

export const BOT_PREFIX = "bot-";
export const isBotId = userId => typeof userId === "string" && userId.startsWith(BOT_PREFIX);

const HOSTILE = new Set(["damage", "destroy", "exile", "bounce", "tap", "counterSpell"]);
const FRIENDLY = new Set(["counters", "pump", "untap"]);

const value = card => (card.manaValue ?? 0) * 2 + (card.power ?? 0) + (card.toughness ?? 0);

/** Wer muss gerade handeln? (Auswahl, manuelles Fenster, Handkartenlimit, Blocker, Priorität) */
export function waitingPlayer(game) {
  if (game.phase === "ended") return null;
  if (game.phase === "mulligan") return game.seats.find(id => !game.players[id].kept && !game.players[id].eliminated) ?? null;
  if (game.choice) return game.choice.userId;
  if (game.manual) return game.manual.userId;
  if (game.pendingDiscard) return game.pendingDiscard.userId;
  if (game.combat?.phaseWaiting) {
    return [...new Set(game.combat.attackers.map(a => a.target))].find(id => !game.combat.done.includes(id) && !game.players[id].eliminated) ?? null;
  }
  return game.priority;
}

// ---------------------------------------------------------------------------
// Ziele
// ---------------------------------------------------------------------------

/** Wofür steht Ziel `index` in den Effekten? */
function intentOf(effects, index) {
  for (const effect of effects) {
    const usesTarget = effect.t === index || (effect.to?.k === "target" && effect.to.t === index) || (effect.who?.k === "target" && effect.who.t === index);
    if (!usesTarget) continue;
    if (HOSTILE.has(effect.type)) return "hostile";
    if (effect.type === "damage") return "hostile";
    if (effect.type === "counters") return effect.kind === "-1/-1" ? "hostile" : "friendly";
    if (effect.type === "pump") return effect.p < 0 || effect.th < 0 ? "hostile" : "friendly";
    if (FRIENDLY.has(effect.type)) return "friendly";
    if (effect.type === "life") return effect.n < 0 || effect.negate ? "hostile" : "friendly";
    if (effect.type === "draw") return "friendly";
    if (effect.type === "mill" || effect.type === "discard") return "hostile";
  }
  return "hostile";
}

function pickTarget(game, botId, options, intent, damage) {
  const mine = id => game.cards[id]?.owner === botId || id === botId;
  const cards = options.filter(id => game.cards[id]);
  const players = options.filter(id => game.players[id]);
  const stack = options.filter(id => game.stack.some(item => item.sid === id));
  if (stack.length > 0) {
    const theirs = stack.filter(sid => game.stack.find(item => item.sid === sid)?.controller !== botId);
    return theirs.length > 0 ? theirs.at(-1) : null; // oberster Zauber des Gegners
  }
  if (intent === "friendly") {
    const own = [...cards.filter(mine), ...players.filter(mine)];
    if (own.length === 0) return null;
    return own.sort((a, b) => (game.cards[b] ? powerOf(game, game.cards[b]) : 0) - (game.cards[a] ? powerOf(game, game.cards[a]) : 0))[0];
  }
  const foeCards = cards.filter(id => !mine(id));
  const foePlayers = players.filter(id => !mine(id));
  const kill = damage ? foeCards.filter(id => toughnessOf(game, game.cards[id]) - game.cards[id].damage <= damage) : [];
  const best = list => [...list].sort((a, b) => value(viewOf(game, b)) - value(viewOf(game, a)))[0];
  if (kill.length > 0) return best(kill);
  if (foePlayers.length > 0 && (damage || foeCards.length === 0)) return foePlayers.sort((a, b) => game.players[a].life - game.players[b].life)[0];
  if (foeCards.length > 0) return best(foeCards);
  return foePlayers[0] ?? null;
}

const viewOf = (game, ref) => {
  const card = typeof ref === "string" ? game.cards[ref] : ref;
  const def = defOf(game, card);
  return { manaValue: def.manaValue, power: powerOf(game, card), toughness: toughnessOf(game, card) };
};

/** Wählt für jedes Ziel einer Zielangabe eines Zaubers/einer Fähigkeit das beste gültige Ziel (oder `null`, wenn keines sinnvoll ist). */
function chooseTargets(game, botId, effects, targetOptions) {
  const targets = [];
  for (let i = 0; i < targetOptions.length; i += 1) {
    const intent = intentOf(effects, i);
    const damage = effects.find(effect => effect.type === "damage" && effect.to?.k === "target" && effect.to.t === i)?.n;
    const target = pickTarget(game, botId, targetOptions[i].options, intent, typeof damage === "number" ? damage : undefined);
    if (target === null) return null;
    // feindliche Zauber nie auf eigene Karten oder sich selbst
    if (intent === "hostile" && (game.cards[target]?.owner === botId || target === botId)) return null;
    targets.push(target);
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Mulligan, Kampf
// ---------------------------------------------------------------------------

function mulliganDecision(game, botId) {
  const player = game.players[botId];
  const lands = player.hand.filter(id => defOf(game, game.cards[id]).types.land).length;
  const free = game.format === "commander" ? 1 : 0;
  const bottomCount = Math.max(0, player.mulligans - free);
  const acceptable = lands >= 2 && lands <= 5;
  if (!acceptable && player.mulligans < 2) return { type: "mulligan" };
  // Karten unter die Bibliothek: überzählige Länder, sonst die teuersten Zauber
  const ranked = [...player.hand].sort((a, b) => {
    const da = defOf(game, game.cards[a]);
    const db = defOf(game, game.cards[b]);
    const score = (def, id) => (def.types.land ? (lands > 3 ? 100 : -100) : def.manaValue) + (id.length ? 0 : 0);
    return score(db, b) - score(da, a);
  });
  return { type: "keep", bottom: ranked.slice(0, bottomCount) };
}

function declareAttackers(game, botId) {
  const me = game.players[botId];
  const opponents = game.seats.filter(id => id !== botId && !game.players[id].eliminated);
  if (opponents.length === 0) return { type: "pass" };
  const target = [...opponents].sort((a, b) => game.players[a].life - game.players[b].life)[0];
  const foes = game.players[target].battlefield.map(id => game.cards[id]).filter(card => {
    const def = defOf(game, card);
    return def.types.creature && !card.tapped;
  });
  const ready = me.battlefield
    .map(id => game.cards[id])
    .filter(card => {
      const def = defOf(game, card);
      return def.types.creature && !card.tapped && !card.faceDown && !hasKeyword(game, card, "defender") && !(card.sinceSeq > me.turnStartSeq && !hasKeyword(game, card, "haste"));
    });
  const totalPower = ready.reduce((sum, card) => sum + powerOf(game, card), 0);
  const lethal = foes.length === 0 ? totalPower >= game.players[target].life : false;
  const chosen = ready.filter(card => {
    const power = powerOf(game, card);
    const toughness = toughnessOf(game, card);
    if (power <= 0) return false;
    if (lethal || foes.length === 0) return true;
    const canBlock = foes.filter(foe => !hasKeyword(game, card, "flying") || hasKeyword(game, foe, "flying") || hasKeyword(game, foe, "reach"));
    if (canBlock.length === 0) return true;
    return canBlock.every(foe => powerOf(game, foe) < toughness) && power >= 2;
  });
  if (chosen.length === 0) return { type: "pass" };
  // mindestens einen Verteidiger daheim lassen, wenn der Gegner Kreaturen hat und wir wenig Leben haben
  const foePower = game.players[target].battlefield.reduce((sum, id) => sum + (defOf(game, game.cards[id]).types.creature ? powerOf(game, game.cards[id]) : 0), 0);
  const attackers = me.life <= foePower && chosen.length === ready.length && chosen.length > 1 ? chosen.slice(1) : chosen;
  return { type: "declareAttackers", attackers: attackers.map(card => ({ id: card.id, target })) };
}

function declareBlockers(game, botId) {
  const me = game.players[botId];
  const attackers = game.combat.attackers.filter(a => a.target === botId).map(a => game.cards[a.id]).filter(Boolean);
  const blockers = me.battlefield.map(id => game.cards[id]).filter(card => defOf(game, card).types.creature && !card.tapped && !card.faceDown);
  const used = new Set();
  const blocks = [];
  let incoming = attackers.reduce((sum, card) => sum + powerOf(game, card), 0);
  const order = [...attackers].sort((a, b) => powerOf(game, b) - powerOf(game, a));
  for (const attacker of order) {
    if (hasKeyword(game, attacker, "menace")) continue;
    const aPower = powerOf(game, attacker);
    const aToughness = toughnessOf(game, attacker);
    const options = blockers.filter(blocker => {
      if (used.has(blocker.id)) return false;
      return !hasKeyword(game, attacker, "flying") || hasKeyword(game, blocker, "flying") || hasKeyword(game, blocker, "reach");
    });
    const safeKill = options.filter(b => powerOf(game, b) >= aToughness && toughnessOf(game, b) > aPower);
    const trade = options.filter(b => powerOf(game, b) >= aToughness && value(viewOf(game, attacker)) >= value(viewOf(game, b)));
    const chump = [...options].sort((a, b) => value(viewOf(game, a)) - value(viewOf(game, b)));
    let pick = safeKill[0] ?? trade[0];
    if (!pick && me.life - incoming <= 3 && chump.length > 0) pick = chump[0];
    if (pick) {
      used.add(pick.id);
      blocks.push({ blocker: pick.id, attacker: attacker.id });
      incoming -= aPower;
    }
  }
  return { type: "declareBlockers", blocks };
}

// ---------------------------------------------------------------------------
// Auswahlen
// ---------------------------------------------------------------------------

function handLands(game, botId) {
  return game.players[botId].hand.filter(id => defOf(game, game.cards[id]).types.land).length;
}

/** Schlechteste Karten zuerst (zum Abwerfen oder Unter-die-Bibliothek-Legen). */
function worstFirst(game, botId, ids) {
  const lands = handLands(game, botId);
  const score = id => {
    const def = defOf(game, game.cards[id]);
    return def.types.land ? (lands > 3 ? 100 : -100) : def.manaValue;
  };
  return [...ids].sort((a, b) => score(b) - score(a));
}

function pickChoice(game, botId) {
  const choice = game.choice;
  const options = choice.options;
  const step = choice.step ?? {};
  const clamp = ids => {
    const picked = ids.slice(0, choice.max);
    while (picked.length < choice.min) picked.push(options.find(id => !picked.includes(id)));
    return picked;
  };
  switch (step.type) {
    case "shock":
      return [game.players[botId].life > 8 ? "yes" : "no"];
    case "reveal":
      return [options[0]];
    case "trigger": {
      const item = step.item;
      const target = chooseTargets(game, botId, item.effects, [{ options }]);
      return [target?.[0] ?? options[0]];
    }
    case "discard":
      return clamp(worstFirst(game, botId, options));
    case "scry":
    case "surveil": {
      const lands = handLands(game, botId);
      const bad = options.filter(id => {
        const def = defOf(game, game.cards[id]);
        return def.types.land ? lands >= 3 : def.manaValue >= 6;
      });
      return bad.slice(0, choice.max);
    }
    case "gyReturn":
      return clamp([...options].sort((a, b) => defOf(game, game.cards[b]).manaValue - defOf(game, game.cards[a]).manaValue));
    case "bounceLand":
      return clamp([...options].sort((a, b) => Number(game.cards[b].tapped) - Number(game.cards[a].tapped)));
    case "search": {
      // möglichst ein Basic Land einer Farbe, die auf dem Feld noch fehlt
      const owned = new Set(game.players[botId].battlefield.map(id => defOf(game, game.cards[id]).mana?.flat()).flat().filter(Boolean));
      const missing = options.find(id => (defOf(game, game.cards[id]).mana?.flat() ?? []).some(color => !owned.has(color)));
      return clamp([missing ?? options[0]]);
    }
    default:
      return clamp(options);
  }
}

// ---------------------------------------------------------------------------
// Hauptphasen
// ---------------------------------------------------------------------------

const REACTIVE = effects => effects.some(effect => effect.type === "counterSpell");

function mainPhaseAction(game, botId) {
  const v = gameView(game, botId);
  const me = v.players.find(player => player.userId === botId);

  // 1. Land legen
  const land = me.hand.find(card => card.play?.kind === "land" && card.play.ok);
  if (land) return { type: "playLand", id: land.id };

  // 2. Zauber: teuerste bezahlbare zuerst
  const castable = [...me.hand, ...me.command]
    .filter(card => card.play?.kind === "spell" && card.play.ok && !/\{X\}/i.test(card.manaCost ?? ""))
    .sort((a, b) => value(b) - value(a));
  for (const card of castable) {
    const def = defOf(game, game.cards[card.id]);
    const rules = def.rules?.spell;
    const modes = card.play.modes;
    if (modes?.length) {
      const index = modes.findIndex((mode, i) => !mode.manual && rules.modes[i].effects.length > 0 && !REACTIVE(rules.modes[i].effects) && (mode.targets.length === 0 || chooseTargets(game, botId, rules.modes[i].effects, mode.targets)));
      if (index === -1) continue;
      const targets = chooseTargets(game, botId, rules.modes[index].effects, card.play.modes[index].targets) ?? [];
      return { type: "cast", id: card.id, mode: index, ...(targets.length ? { targets } : {}) };
    }
    if (card.play.manual) continue;
    if (rules && REACTIVE(rules.effects)) continue; // Neutralisieren hebt sich der Bot für Antworten auf
    if (rules && rules.effects.length === 0 && (def.types.instant || def.types.sorcery)) continue;
    const specs = card.play.targets ?? [];
    let targets = [];
    if (specs.length > 0) {
      targets = chooseTargets(game, botId, rules.effects, specs);
      if (!targets) continue;
    }
    return { type: "cast", id: card.id, ...(targets.length ? { targets } : {}) };
  }

  // 3. Fähigkeiten mit sinnvollem Ziel (nur wenn sie keine Opferkosten haben)
  for (const card of me.battlefield) {
    const def = defOf(game, game.cards[card.id]);
    for (const ability of card.abilities ?? []) {
      if (!ability.ok || ability.manual) continue;
      const rules = def.rules.activated[ability.index];
      if (rules.cost.sacrifice) continue;
      let targets = [];
      if (ability.targets.length > 0) {
        targets = chooseTargets(game, botId, rules.effects, ability.targets);
        if (!targets) continue;
      }
      return { type: "activate", id: card.id, index: ability.index, ...(targets.length ? { targets } : {}) };
    }
  }

  return { type: "pass" };
}

function respondAction(game, botId) {
  const v = gameView(game, botId);
  const me = v.players.find(player => player.userId === botId);
  const top = game.stack.at(-1);
  if (!top || top.controller === botId) return { type: "pass" };
  for (const card of me.hand) {
    if (card.play?.kind !== "spell" || !card.play.ok || card.play.manual) continue;
    const def = defOf(game, game.cards[card.id]);
    const rules = def.rules?.spell;
    if (!rules || !REACTIVE(rules.effects)) continue;
    const options = card.play.targets?.[0]?.options ?? [];
    if (options.includes(top.sid)) return { type: "cast", id: card.id, targets: [top.sid] };
  }
  return { type: "pass" };
}

/** Der Bot, der gerade handeln muss (beim Mulligan entscheiden alle gleichzeitig), sonst `null`. */
export function botToAct(game) {
  if (game.phase === "ended") return null;
  if (game.phase === "mulligan") return game.seats.find(id => isBotId(id) && !game.players[id].kept && !game.players[id].eliminated) ?? null;
  const who = waitingPlayer(game);
  return who && isBotId(who) ? who : null;
}

/** Nächste Aktion des Bots oder `null`, wenn er nicht an der Reihe ist. */
export function nextBotAction(game, botId) {
  const me = game.players[botId];
  if (!me || me.eliminated || game.phase === "ended") return null;
  if (botToAct(game) !== botId && waitingPlayer(game) !== botId) return null;

  if (game.phase === "mulligan") return mulliganDecision(game, botId);
  if (game.choice) return { type: "choose", ids: pickChoice(game, botId) };
  if (game.manual) return { type: "manualDone" };
  if (game.pendingDiscard) {
    return { type: "discard", ids: worstFirst(game, botId, me.hand).slice(0, game.pendingDiscard.count) };
  }
  if (me.prompts.length > 0) return { type: "commanderZone", id: me.prompts[0].id, yes: true };
  if (game.combat?.phaseWaiting) return declareBlockers(game, botId);

  if (game.stack.length > 0) return respondAction(game, botId);
  if (game.turn.active !== botId) return { type: "pass" };

  switch (game.turn.phase) {
    case "draw":
      return game.turn.drawBlocked || game.turn.drawn ? { type: "pass" } : { type: "drawStep" };
    case "main1":
    case "main2":
      return mainPhaseAction(game, botId);
    case "attackers":
      return declareAttackers(game, botId);
    default:
      return { type: "pass" };
  }
}
