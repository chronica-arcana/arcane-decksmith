/**
 * Spielkern des digitalen Spieltischs (reine Logik, ohne Cloudflare-Abhängigkeiten, in Node testbar).
 *
 * Der **Server** hält den ganzen Spielstand. Jeder Spieler bekommt nur seine eigene Sicht (`gameView`):
 * die eigene Hand, bei den anderen nur Kartenzahlen; Bibliotheken sieht nie jemand.
 *
 * Automatisiert sind die Abläufe, die sich aus den Regeln eindeutig ergeben:
 *  - Zugstruktur (Enttappen, Ziehen, Phasen), Priorität und Stapel (Zauber wirken, Auflösen, Neutralisieren)
 *  - Mana: Manapool und automatisches Tappen von Quellen beim Bezahlen (Hybrid, X, Phyrexian, Kommandantensteuer)
 *  - Land spielen (eines pro Zug), Beschwörungsmüdigkeit, Kampf (Angreifer, Blocker, Erstschlag, Doppelschlag,
 *    Todesberührung, Lebensverbindung, Trampeln, Flug/Reichweite/Drohung) samt Schaden und Sterben
 *  - Kommandanten: Steuer, Kommandantenschaden aus dem Kampf, Rückkehr in die Kommandozone
 *  - Ausscheiden (0 Leben, 10 Giftmarken, 21 Kommandantenschaden) und Spielende
 * Nicht automatisiert sind Kartentexte (Fähigkeiten, Auslöser, Ziele): Das legen die Spieler gemeinsam fest;
 * über „Fähigkeit auf den Stapel“ und das manuelle Bewegen von Karten lässt sich alles abbilden.
 */
import { buildDef } from "./cardFacts.js";
import { emptyPool, describeCost, planPayment, poolTotal } from "./manaPayment.js";

export const GAME_VERSION = 2;
export const ZONES = ["library", "hand", "battlefield", "graveyard", "exile", "command"];
const PUBLIC_ZONES = new Set(["battlefield", "graveyard", "exile", "command"]);
/** Schritte eines Zuges. Aufnahme der Karte und Enttappen geschehen automatisch zu Beginn. */
export const PHASES = ["main1", "attackers", "blockers", "damage", "main2", "end"];
export const PLAYER_COUNTERS = ["poison", "energy", "experience"];
export const START_LIFE = { standard: 20, commander: 40 };
export const HAND_SIZE = 7;
export const MAX_LOG = 200;
export const MAX_TOKENS = 60;
export const MAX_COUNTERS = 99;
export const MAX_STACK = 30;

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = error => ({ ok: false, error });
const ok = () => ({ ok: true });
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(value))));
const isInt = value => Number.isInteger(value);
const PLAYER_LABELS = { poison: "Giftmarken", energy: "Energie", experience: "Erfahrung" };

export const ZONE_LABELS = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};

/** Fisher-Yates-Mischen; `random` liefert Zahlen in [0, 1). */
export function shuffle(list, random = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ---------------------------------------------------------------------------
// Grundlagen
// ---------------------------------------------------------------------------

function addLog(game, text) {
  game.logSeq += 1;
  game.log.push({ n: game.logSeq, text });
  if (game.log.length > MAX_LOG) game.log.splice(0, game.log.length - MAX_LOG);
}

const tick = game => (game.seq += 1);

function newId(game, prefix = "c") {
  game.nextId += 1;
  return `${prefix}${game.nextId}`;
}

const defOf = (game, card) => game.xdefs[card.def] ?? game.defs[card.def];
const nameOf = (game, id) => defOf(game, game.cards[id])?.name ?? "Karte";
const hasKeyword = (game, card, keyword) => defOf(game, card).keywords?.includes(keyword) ?? false;

const counterOf = (card, kind) => card.counters[kind] ?? 0;
const bonus = card => counterOf(card, "+1/+1") - counterOf(card, "-1/-1");
const powerOf = (game, card) => (defOf(game, card).power ?? 0) + bonus(card);
const toughnessOf = (game, card) => (defOf(game, card).toughness ?? 0) + bonus(card);

function emptyPlayer(name) {
  return {
    name,
    life: 20,
    poison: 0,
    energy: 0,
    experience: 0,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    command: [],
    looking: null,
    mulligans: 0,
    kept: false,
    eliminated: null,
    cmdDamage: {},
    cmdCasts: {},
    pool: emptyPool(),
    autoPass: true,
    turnStartSeq: 0,
    prompts: []
  };
}

function addCard(game, userId, defId, zone, extra = {}) {
  const id = newId(game);
  game.cards[id] = {
    id,
    owner: userId,
    def: defId,
    tapped: false,
    faceDown: false,
    counters: {},
    revealed: false,
    token: false,
    damage: 0,
    deathtouched: false,
    sinceSeq: 0,
    ...extra
  };
  game.players[userId][zone].push(id);
  return id;
}

function drawCards(game, userId, count) {
  const player = game.players[userId];
  let drawn = 0;
  for (let i = 0; i < count && player.library.length > 0; i += 1) {
    player.hand.push(player.library.pop()); // oben = Ende der Liste
    drawn += 1;
  }
  return drawn;
}

const alive = game => game.seats.filter(userId => !game.players[userId].eliminated);

/** Reihenfolge der lebenden Spieler ab (einschließlich) `fromUserId`. */
function orderFrom(game, fromUserId) {
  const start = Math.max(0, game.seats.indexOf(fromUserId));
  const rotated = [...game.seats.slice(start), ...game.seats.slice(0, start)];
  return rotated.filter(userId => !game.players[userId].eliminated);
}

/**
 * Erstellt ein neues Spiel aus einem Raum (jeder Spieler mit seinem geprüften Deck-Schnappschuss).
 * @param {{ room: object, random?: () => number, now?: number, facts?: Map<string, object> }} input
 */
export function createGame({ room, random = Math.random, now = Date.now(), facts = new Map() }) {
  const entries = Object.entries(room.players).sort((a, b) => a[1].seat - b[1].seat);
  const game = {
    version: GAME_VERSION,
    format: room.format,
    phase: "mulligan",
    seats: entries.map(([userId]) => userId),
    players: {},
    cards: {},
    defs: {},
    xdefs: {},
    nextId: 0,
    seq: 0,
    log: [],
    logSeq: 0,
    stack: [],
    priority: null,
    passed: [],
    combat: null,
    pendingDiscard: null,
    turn: { number: 0, active: null, phase: "main1", first: null, landsPlayed: 0 },
    startedAt: now,
    endedAt: null,
    winner: null,
    summary: null
  };

  for (const [userId, info] of entries) {
    const player = emptyPlayer(info.name);
    player.life = START_LIFE[room.format] ?? 20;
    player.deckName = info.deck.name;
    game.players[userId] = player;
    const addDef = card => {
      const key = `${userId}:${card.id}`;
      game.defs[key] = buildDef(card, facts.get(card.id));
      return key;
    };
    for (const card of info.deck.commanders ?? []) {
      const key = addDef(card);
      for (let i = 0; i < (card.count || 1); i += 1) addCard(game, userId, key, "command", { cmd: true });
    }
    for (const card of info.deck.main) {
      const key = addDef(card);
      for (let i = 0; i < card.count; i += 1) addCard(game, userId, key, "library");
    }
    shuffle(player.library, random);
    drawCards(game, userId, HAND_SIZE);
  }

  addLog(game, "Das Spiel beginnt. Jeder Spieler hat sieben Karten gezogen und entscheidet über den Mulligan.");
  return game;
}

/** Trennt die unveränderlichen Kartendaten ab (werden nur einmal gespeichert). */
export function splitGame(game) {
  const { defs, ...dynamic } = game;
  return { dynamic, defs };
}
export const joinGame = (dynamic, defs) => (dynamic && defs ? { ...dynamic, defs } : null);

// ---------------------------------------------------------------------------
// Karten-Hilfen
// ---------------------------------------------------------------------------

function locate(game, userId, id) {
  const card = game.cards[id];
  if (!card || card.owner !== userId) return null;
  const player = game.players[userId];
  for (const zone of ZONES) {
    const index = player[zone].indexOf(id);
    if (index !== -1) return { zone, index, card, player };
  }
  return null;
}

function onBattlefield(game, id) {
  const card = game.cards[id];
  return card ? game.players[card.owner].battlefield.includes(id) : false;
}

/** Beschwörungsmüdigkeit: Kreatur steht nicht seit Beginn des letzten eigenen Zuges unter Kontrolle. */
function isSick(game, card) {
  const def = defOf(game, card);
  return def.types.creature && !hasKeyword(game, card, "haste") && card.sinceSeq > game.players[card.owner].turnStartSeq;
}

function resetCardState(card) {
  card.tapped = false;
  card.faceDown = false;
  card.counters = {};
  card.revealed = false;
  card.damage = 0;
  card.deathtouched = false;
}

function enterBattlefield(game, card) {
  card.sinceSeq = tick(game);
  const def = defOf(game, card);
  if (def.types.planeswalker && def.loyalty) card.counters.loyalty = def.loyalty;
}

function manaSources(game, userId) {
  const sources = [];
  for (const id of game.players[userId].battlefield) {
    const card = game.cards[id];
    const def = defOf(game, card);
    if (!def.mana || card.tapped || card.faceDown || isSick(game, card)) continue;
    sources.push({ id, units: def.mana });
  }
  return sources;
}

/** Kommandanten verlassen Spielzonen: Der Besitzer darf sie in die Kommandozone zurücklegen. */
function offerCommanderReturn(game, card, to) {
  if (!card.cmd || to === "command" || to === "battlefield" || to === "stack") return;
  const prompts = game.players[card.owner].prompts;
  if (!prompts.some(prompt => prompt.id === card.id)) prompts.push({ type: "commander", id: card.id });
}

/** Karte stirbt oder wird neutralisiert → Friedhof (Spielsteine verschwinden). */
function toGraveyard(game, card, from = "battlefield") {
  const owner = game.players[card.owner];
  for (const zone of ZONES) {
    const index = owner[zone].indexOf(card.id);
    if (index !== -1) owner[zone].splice(index, 1);
  }
  if (card.token) {
    delete game.cards[card.id];
    return;
  }
  resetCardState(card);
  owner.graveyard.push(card.id);
  if (from === "battlefield") offerCommanderReturn(game, card, "graveyard");
}

// ---------------------------------------------------------------------------
// Spielende, Ausscheiden
// ---------------------------------------------------------------------------

function finishGame(game, now, aborted = false) {
  const survivors = alive(game);
  game.phase = "ended";
  game.endedAt = now;
  game.priority = null;
  game.winner = !aborted && survivors.length === 1 ? survivors[0] : null;
  game.summary = {
    aborted,
    winner: game.winner,
    turns: game.turn.number,
    startedAt: game.startedAt,
    endedAt: now,
    format: game.format,
    players: game.seats.map(userId => ({
      userId,
      name: game.players[userId].name,
      deckName: game.players[userId].deckName ?? "",
      eliminated: game.players[userId].eliminated,
      life: game.players[userId].life
    }))
  };
  if (aborted) addLog(game, "Das Spiel wurde abgebrochen.");
  else if (game.winner) addLog(game, `${game.players[game.winner].name} gewinnt das Spiel.`);
  else addLog(game, "Das Spiel ist beendet (Unentschieden).");
}

function eliminate(game, userId, reason, now, random = Math.random) {
  const player = game.players[userId];
  if (player.eliminated || game.phase === "ended") return;
  player.eliminated = reason;
  player.pool = emptyPool();
  addLog(game, `${player.name} scheidet aus (${reason}).`);
  if (alive(game).length <= 1) {
    finishGame(game, now);
    return;
  }
  if (game.phase !== "playing") return;
  // Zauber des ausgeschiedenen Spielers verschwinden, Kampf mit ihm wird beendet.
  game.stack = game.stack.filter(item => {
    if (item.controller !== userId) return true;
    if (item.cardId && game.cards[item.cardId]) toGraveyard(game, game.cards[item.cardId], "stack");
    return false;
  });
  if (game.combat) {
    const involved = game.combat.attackers.some(a => a.target === userId || game.cards[a.id]?.owner === userId);
    if (involved && game.turn.active === userId) game.combat = null;
    else if (involved) {
      game.combat.attackers = game.combat.attackers.filter(a => a.target !== userId && game.cards[a.id]?.owner !== userId);
      game.combat.blocks = game.combat.blocks.filter(b => game.cards[b.blocker]?.owner !== userId);
    }
  }
  if (game.pendingDiscard?.userId === userId) game.pendingDiscard = null;
  if (game.turn.active === userId) {
    const next = orderFrom(game, userId)[0];
    game.combat = null;
    game.turn.number += 1;
    startTurn(game, next);
  } else {
    if (game.combat?.phaseWaiting) settleCombatWaiting(game);
    settle(game, random);
  }
}

function checkElimination(game, userId, now) {
  const player = game.players[userId];
  if (player.eliminated) return;
  if (player.life <= 0) eliminate(game, userId, "0 Lebenspunkte", now);
  else if (player.poison >= 10) eliminate(game, userId, "10 Giftmarken", now);
  else if (Object.values(player.cmdDamage).some(value => value >= 21)) eliminate(game, userId, "21 Kommandantenschaden", now);
}

// ---------------------------------------------------------------------------
// Zugstruktur, Priorität, Stapel
// ---------------------------------------------------------------------------

function clearPools(game) {
  for (const userId of game.seats) game.players[userId].pool = emptyPool();
}

function startTurn(game, userId, { skipDraw = false } = {}) {
  const player = game.players[userId];
  game.turn.active = userId;
  game.turn.phase = "main1";
  game.turn.landsPlayed = 0;
  game.combat = null;
  game.pendingDiscard = null;
  player.turnStartSeq = tick(game);
  for (const id of player.battlefield) game.cards[id].tapped = false;
  clearPools(game);
  addLog(game, `Zug ${game.turn.number}: ${player.name} ist am Zug (alles enttappt).`);
  if (!skipDraw) {
    const drawn = drawCards(game, userId, 1);
    addLog(game, drawn ? `${player.name} zieht eine Karte.` : `${player.name} kann keine Karte ziehen (Bibliothek leer).`);
  }
  game.priority = userId;
  game.passed = [];
}

function finishTurn(game) {
  for (const card of Object.values(game.cards)) {
    card.damage = 0;
    card.deathtouched = false;
  }
  clearPools(game);
  const next = orderFrom(game, game.turn.active)[1] ?? orderFrom(game, game.turn.active)[0];
  game.turn.number += 1;
  startTurn(game, next);
}

function hasPotentialAttackers(game, userId) {
  return game.players[userId].battlefield.some(id => {
    const card = game.cards[id];
    const def = defOf(game, card);
    return def.types.creature && !card.tapped && !card.faceDown && !isSick(game, card) && !hasKeyword(game, card, "defender");
  });
}

function enterPhase(game, phase) {
  game.turn.phase = phase;
  game.priority = game.turn.active;
  game.passed = [];
  clearPools(game);
}

/** Alle haben nacheinander gepasst und der Stapel ist leer: nächster Schritt. */
function advanceStep(game, now, random) {
  switch (game.turn.phase) {
    case "main1":
      if (hasPotentialAttackers(game, game.turn.active) && alive(game).length > 1) enterPhase(game, "attackers");
      else enterPhase(game, "main2");
      return;
    case "attackers":
      enterPhase(game, "main2");
      return;
    case "damage":
      dealCombatDamage(game, now);
      game.combat = null;
      if (game.phase === "playing") enterPhase(game, "main2");
      return;
    case "main2":
      enterPhase(game, "end");
      return;
    case "end": {
      const active = game.players[game.turn.active];
      if (active.hand.length > HAND_SIZE) {
        game.pendingDiscard = { userId: game.turn.active, count: active.hand.length - HAND_SIZE };
        game.priority = null;
        addLog(game, `${active.name} muss ${game.pendingDiscard.count} Karte${game.pendingDiscard.count === 1 ? "" : "n"} abwerfen (Handkartenlimit).`);
        return;
      }
      finishTurn(game);
      return;
    }
    default:
      void random;
  }
}

function resolveTop(game) {
  const item = game.stack.pop();
  if (!item) return;
  if (item.kind === "ability") {
    addLog(game, `Fähigkeit von ${game.players[item.controller].name} löst sich auf: ${item.text}`);
    return;
  }
  const card = game.cards[item.cardId];
  if (!card) return;
  const def = defOf(game, card);
  const owner = game.players[card.owner];
  if (def.types.instant || def.types.sorcery) {
    owner.graveyard.push(card.id);
    addLog(game, `${def.name} löst sich auf → Friedhof.`);
  } else {
    owner.battlefield.push(card.id);
    enterBattlefield(game, card);
    addLog(game, `${def.name} löst sich auf → Schlachtfeld.`);
  }
}

/** Entscheidet nach jeder Änderung, wer Priorität hat bzw. ob der Stapel aufgelöst oder der Schritt beendet wird. */
function settle(game, random = Math.random, now = Date.now()) {
  if (game.phase !== "playing" || game.settling) return;
  game.settling = true;
  try {
    settleLoop(game, random, now);
  } finally {
    delete game.settling;
  }
}

function settleLoop(game, random, now) {
  for (let guard = 0; guard < 50; guard += 1) {
    if (game.pendingDiscard || game.combat?.phaseWaiting) return;
    const order = orderFrom(game, game.priority ?? game.turn.active);
    const waiting = order.filter(userId => !game.passed.includes(userId));
    if (waiting.length === 0) {
      if (game.stack.length > 0) {
        resolveTop(game);
        checkStateBased(game, now);
        game.passed = [];
        game.priority = game.turn.active;
        if (game.phase !== "playing") return;
        continue;
      }
      advanceStep(game, now, random);
      if (game.phase !== "playing" || game.pendingDiscard || game.combat?.phaseWaiting) return;
      continue;
    }
    const next = waiting[0];
    if (game.stack.length === 0 && next !== game.turn.active && game.players[next].autoPass) {
      game.passed.push(next);
      continue;
    }
    game.priority = next;
    return;
  }
}

// ---------------------------------------------------------------------------
// Kampf
// ---------------------------------------------------------------------------

function defendersOf(game) {
  return [...new Set(game.combat.attackers.map(attacker => attacker.target))].filter(id => !game.players[id].eliminated);
}

function canBlockAnything(game, userId) {
  return game.players[userId].battlefield.some(id => {
    const card = game.cards[id];
    return defOf(game, card).types.creature && !card.tapped && !card.faceDown;
  });
}

/** Wenn alle Verteidiger entschieden haben (oder nicht blocken können), beginnt der Schadensschritt. */
function settleCombatWaiting(game) {
  const combat = game.combat;
  if (!combat) return;
  for (const userId of defendersOf(game)) {
    if (!combat.done.includes(userId) && !canBlockAnything(game, userId)) combat.done.push(userId);
  }
  if (defendersOf(game).every(userId => combat.done.includes(userId))) {
    combat.phaseWaiting = false;
    enterPhase(game, "damage");
  }
}

function dealCombatDamage(game, now) {
  const combat = game.combat;
  if (!combat) return;
  const living = id => game.cards[id] && onBattlefield(game, id);
  const anyFirst = id => hasKeyword(game, game.cards[id], "first strike") || hasKeyword(game, game.cards[id], "double strike");
  const involved = [...combat.attackers.map(a => a.id), ...combat.blocks.map(b => b.blocker)].filter(living);
  const stepNeeded = involved.some(anyFirst);

  const runStep = firstStrikeStep => {
    const deals = id => {
      const first = hasKeyword(game, game.cards[id], "first strike");
      const dbl = hasKeyword(game, game.cards[id], "double strike");
      return firstStrikeStep ? first || dbl : !first || dbl;
    };
    /** @type {Array<{source: string, card?: string, player?: string, amount: number}>} */
    const hits = [];
    for (const attacker of combat.attackers) {
      if (!living(attacker.id) || !deals(attacker.id)) continue;
      const card = game.cards[attacker.id];
      const power = Math.max(0, powerOf(game, card));
      const blockers = combat.blocks.filter(b => b.attacker === attacker.id && living(b.blocker)).map(b => b.blocker);
      const wasBlocked = combat.blocks.some(b => b.attacker === attacker.id);
      if (power === 0) continue;
      if (!wasBlocked) {
        hits.push({ source: card.id, player: attacker.target, amount: power });
        continue;
      }
      let left = power;
      const deathtouch = hasKeyword(game, card, "deathtouch");
      blockers.forEach((blockerId, index) => {
        const blocker = game.cards[blockerId];
        const lethal = deathtouch ? 1 : Math.max(0, toughnessOf(game, blocker) - blocker.damage);
        const give = index === blockers.length - 1 && !hasKeyword(game, card, "trample") ? left : Math.min(left, lethal);
        if (give > 0) hits.push({ source: card.id, card: blockerId, amount: give });
        left -= give;
      });
      if (hasKeyword(game, card, "trample") && left > 0) hits.push({ source: card.id, player: attacker.target, amount: left });
    }
    for (const block of combat.blocks) {
      if (!living(block.blocker) || !living(block.attacker) || !deals(block.blocker)) continue;
      const power = Math.max(0, powerOf(game, game.cards[block.blocker]));
      if (power > 0) hits.push({ source: block.blocker, card: block.attacker, amount: power });
    }
    for (const hit of hits) {
      const source = game.cards[hit.source];
      if (!source) continue;
      if (hit.card && game.cards[hit.card]) {
        game.cards[hit.card].damage += hit.amount;
        if (hasKeyword(game, source, "deathtouch")) game.cards[hit.card].deathtouched = true;
      }
      if (hit.player) {
        const target = game.players[hit.player];
        target.life -= hit.amount;
        if (source.cmd) target.cmdDamage[source.owner] = (target.cmdDamage[source.owner] ?? 0) + hit.amount;
      }
      if (hasKeyword(game, source, "lifelink")) game.players[source.owner].life += hit.amount;
    }
    if (hits.length > 0) {
      const summary = hits
        .map(hit => `${nameOf(game, hit.source)} → ${hit.card ? nameOf(game, hit.card) : game.players[hit.player].name}: ${hit.amount}`)
        .join(", ");
      addLog(game, `Kampfschaden${firstStrikeStep ? " (Erstschlag)" : ""}: ${summary}.`);
    }
    checkStateBased(game, now);
    for (const userId of game.seats) checkElimination(game, userId, now);
  };

  if (stepNeeded) runStep(true);
  if (game.phase === "playing") runStep(false);
}

/** Zustandsbasierte Aktionen: Kreaturen mit tödlichem Schaden oder Widerstandskraft 0, Planeswalker ohne Loyalität. */
function checkStateBased(game, now) {
  void now;
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    for (const userId of game.seats) {
      for (const id of [...game.players[userId].battlefield]) {
        const card = game.cards[id];
        const def = defOf(game, card);
        let dies = false;
        if (def.types.creature && !card.faceDown) {
          const toughness = toughnessOf(game, card);
          if (toughness <= 0) dies = true;
          else if (!hasKeyword(game, card, "indestructible") && (card.damage >= toughness || (card.deathtouched && card.damage > 0))) dies = true;
        }
        if (def.types.planeswalker && def.loyalty !== null && counterOf(card, "loyalty") <= 0) dies = true;
        if (dies) {
          addLog(game, `${def.name} (${game.players[userId].name}) kommt auf den Friedhof.`);
          toGraveyard(game, card);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------
// Sicht pro Spieler
// ---------------------------------------------------------------------------

/** Was kann dieser Spieler mit der Karte aus der Hand (bzw. Kommandozone) jetzt tun? */
export function playOptions(game, userId, id) {
  const found = locate(game, userId, id);
  if (!found || (found.zone !== "hand" && found.zone !== "command")) return null;
  const def = defOf(game, found.card);
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;

  if (def.types.land) {
    const okNow = playing && found.zone === "hand" && game.priority === userId && mainPhase && game.turn.landsPlayed < 1;
    return { kind: "land", ok: okNow };
  }
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const timingOk = playing && game.priority === userId && (instantSpeed || mainPhase);
  let affordable = false;
  if (timingOk) {
    const tax = found.zone === "command" ? 2 * (player.cmdCasts[id] ?? 0) : 0;
    affordable = planPayment({ manaCost: def.manaCost, extraGeneric: tax, pool: player.pool, sources: manaSources(game, userId) }).ok;
  }
  return { kind: "spell", ok: timingOk && affordable, timingOk };
}

function cardView(game, id, viewerId, { hideFace = false } = {}) {
  const card = game.cards[id];
  const def = defOf(game, card);
  const view = {
    id,
    owner: card.owner,
    tapped: card.tapped,
    counters: card.counters,
    token: card.token,
    faceDown: card.faceDown,
    damage: card.damage,
    sick: isSick(game, card),
    cmd: Boolean(card.cmd),
    kind: def.types.land ? "land" : def.types.creature ? "creature" : "other",
    attacking: Boolean(game.combat?.attackers.some(a => a.id === id)),
    blocking: game.combat?.blocks.find(b => b.blocker === id)?.attacker ?? null
  };
  if (hideFace) return { ...view, kind: "other" };
  const creature = def.types.creature;
  return {
    ...view,
    name: def.name,
    typeLine: def.typeLine,
    manaValue: def.manaValue,
    manaCost: def.manaCost,
    imageUri: def.imageUri,
    keywords: def.keywords,
    power: creature ? (def.powerText !== null && def.power === null ? null : powerOf(game, card)) : null,
    toughness: creature ? (def.toughnessText !== null && def.toughness === null ? null : toughnessOf(game, card)) : null,
    mana: Boolean(def.mana),
    manaColors: def.mana ? [...new Set(def.mana.flat())] : [],
    ...(card.owner === viewerId ? { play: playOptions(game, viewerId, id) } : {})
  };
}

/** Sicht eines Spielers auf das Spiel. Verdeckte Karten anderer (Hand, Bibliothek, verdeckt gelegte) werden nie mitgeschickt. */
export function gameView(game, viewerId) {
  const players = game.seats.map(userId => {
    const p = game.players[userId];
    const mine = userId === viewerId;
    return {
      userId,
      name: p.name,
      deckName: p.deckName,
      life: p.life,
      poison: p.poison,
      energy: p.energy,
      experience: p.experience,
      eliminated: p.eliminated,
      mulligans: p.mulligans,
      kept: p.kept,
      pool: p.pool,
      autoPass: mine ? p.autoPass : undefined,
      prompts: mine ? p.prompts : [],
      counts: {
        library: p.library.length,
        hand: p.hand.length,
        battlefield: p.battlefield.length,
        graveyard: p.graveyard.length,
        exile: p.exile.length,
        command: p.command.length
      },
      hand: mine
        ? p.hand.map(id => cardView(game, id, viewerId))
        : p.hand.filter(id => game.cards[id].revealed).map(id => cardView(game, id, viewerId)),
      battlefield: p.battlefield.map(id => cardView(game, id, viewerId, { hideFace: !mine && game.cards[id].faceDown })),
      graveyard: p.graveyard.map(id => cardView(game, id, viewerId)),
      exile: p.exile.map(id => cardView(game, id, viewerId, { hideFace: !mine && game.cards[id].faceDown })),
      command: p.command.map(id => cardView(game, id, viewerId)),
      looking: mine && p.looking ? p.looking.map(id => cardView(game, id, viewerId)) : null,
      cmdDamage: p.cmdDamage,
      cmdCasts: p.cmdCasts
    };
  });
  return {
    format: game.format,
    phase: game.phase,
    you: viewerId,
    turn: game.turn,
    priority: game.priority,
    stack: game.stack.map(item => ({
      sid: item.sid,
      controller: item.controller,
      kind: item.kind,
      text: item.text ?? "",
      card: item.cardId ? cardView(game, item.cardId, viewerId) : null
    })),
    combat: game.combat
      ? {
          attackers: game.combat.attackers,
          blocks: game.combat.blocks,
          awaiting: game.combat.phaseWaiting ? defendersOf(game).filter(id => !game.combat.done.includes(id)) : []
        }
      : null,
    pendingDiscard: game.pendingDiscard,
    winner: game.winner,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    players,
    log: game.log.slice(-100)
  };
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

const FREE_DURING_DISCARD = new Set(["discard", "concede", "dice", "coin"]);

/**
 * Wendet eine Aktion eines Spielers an und verändert dabei `game`.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function applyAction(game, userId, action, { random = Math.random, now = Date.now() } = {}) {
  const player = game.players[userId];
  if (!player) return fail("Du bist nicht Teil dieses Spiels.");
  if (!isObject(action) || typeof action.type !== "string") return fail("Ungültige Aktion.");
  if (game.phase === "ended") return fail("Das Spiel ist beendet.");
  if (player.eliminated) return fail("Du bist ausgeschieden.");

  if (game.phase === "mulligan") return mulliganAction(game, userId, action, random, now);

  if (game.pendingDiscard && !FREE_DURING_DISCARD.has(action.type)) {
    return fail(
      game.pendingDiscard.userId === userId
        ? `Du musst zuerst ${game.pendingDiscard.count} Karte${game.pendingDiscard.count === 1 ? "" : "n"} abwerfen.`
        : "Warte, bis der aktive Spieler seine Karten abgeworfen hat."
    );
  }

  const result = handleAction(game, userId, action, random, now);
  if (result.ok && game.phase === "playing") {
    checkStateBased(game, now);
    for (const id of game.seats) checkElimination(game, id, now);
  }
  return result;
}

function handleAction(game, userId, action, random, now) {
  const player = game.players[userId];
  switch (action.type) {
    case "draw": {
      const count = isInt(action.count) ? clampInt(action.count, 1, 20) : 1;
      const drawn = drawCards(game, userId, count);
      addLog(game, `${player.name} zieht ${drawn === 1 ? "eine Karte" : `${drawn} Karten`}.`);
      return ok();
    }
    case "mill": {
      const count = isInt(action.count) ? clampInt(action.count, 1, 50) : 1;
      const names = [];
      for (let i = 0; i < count && player.library.length > 0; i += 1) {
        const id = player.library.pop();
        player.graveyard.push(id);
        names.push(nameOf(game, id));
      }
      addLog(game, `${player.name} mahlt ${names.length} Karte${names.length === 1 ? "" : "n"}: ${names.join(", ") || "–"}.`);
      return ok();
    }
    case "shuffle":
      shuffle(player.library, random);
      player.looking = null;
      addLog(game, `${player.name} mischt die Bibliothek.`);
      return ok();
    case "look": {
      const all = action.count === "all";
      const count = all ? player.library.length : isInt(action.count) ? clampInt(action.count, 1, 50) : 0;
      if (!all && count < 1) return fail("Anzahl fehlt.");
      player.looking = player.library.slice(-count).reverse(); // oberste zuerst
      addLog(
        game,
        all ? `${player.name} durchsucht die Bibliothek.` : `${player.name} sieht sich die obersten ${Math.min(count, player.library.length)} Karten der Bibliothek an.`
      );
      return ok();
    }
    case "closeLook":
      player.looking = null;
      return ok();
    case "move":
      return moveAction(game, userId, action);
    case "tap": {
      const found = locate(game, userId, action.id);
      if (!found || found.zone !== "battlefield") return fail("Diese Karte liegt nicht auf deinem Schlachtfeld.");
      found.card.tapped = typeof action.tapped === "boolean" ? action.tapped : !found.card.tapped;
      return ok();
    }
    case "untapAll":
      for (const id of player.battlefield) game.cards[id].tapped = false;
      addLog(game, `${player.name} enttappt alle Permanents.`);
      return ok();
    case "flip": {
      const found = locate(game, userId, action.id);
      if (!found || (found.zone !== "battlefield" && found.zone !== "exile")) return fail("Diese Karte kann nicht umgedreht werden.");
      found.card.faceDown = !found.card.faceDown;
      addLog(game, `${player.name} dreht eine Karte ${found.card.faceDown ? "verdeckt" : `auf (${nameOf(game, found.card.id)})`}.`);
      return ok();
    }
    case "reveal": {
      const found = locate(game, userId, action.id);
      if (!found || found.zone !== "hand") return fail("Nur Handkarten können gezeigt werden.");
      found.card.revealed = !found.card.revealed;
      addLog(game, found.card.revealed ? `${player.name} zeigt ${nameOf(game, found.card.id)}.` : `${player.name} versteckt eine Handkarte wieder.`);
      return ok();
    }
    case "counter":
      return counterAction(game, userId, action);
    case "token":
      return tokenAction(game, userId, action);
    case "life": {
      let delta;
      if (isInt(action.set)) delta = clampInt(action.set, -999, 999) - player.life;
      else if (isInt(action.delta)) delta = clampInt(action.delta, -999, 999);
      else return fail("Ungültige Lebenspunkte.");
      if (delta === 0) return ok();
      player.life += delta;
      addLog(game, `${player.name}: Leben ${delta > 0 ? "+" : ""}${delta} (jetzt ${player.life}).`);
      return ok();
    }
    case "pcounter": {
      if (!PLAYER_COUNTERS.includes(action.kind) || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > 20) {
        return fail("Ungültiger Spielermarker.");
      }
      player[action.kind] = Math.max(0, player[action.kind] + action.delta);
      addLog(game, `${player.name}: ${PLAYER_LABELS[action.kind]} ${action.delta > 0 ? "+" : ""}${action.delta} (jetzt ${player[action.kind]}).`);
      return ok();
    }
    case "cmddmg": {
      const source = game.players[action.from];
      if (!source || action.from === userId) return fail("Ungültiger Kommandant.");
      if (game.format !== "commander") return fail("Kommandantenschaden gibt es nur bei Commander.");
      if (!isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > 21) return fail("Ungültiger Schaden.");
      const next = Math.max(0, (player.cmdDamage[action.from] ?? 0) + action.delta);
      player.cmdDamage[action.from] = next;
      addLog(game, `${player.name} erhält Kommandantenschaden von ${source.name}: ${next} insgesamt.`);
      return ok();
    }
    case "dice": {
      const sides = isInt(action.sides) ? clampInt(action.sides, 2, 100) : 6;
      addLog(game, `${player.name} würfelt W${sides}: ${1 + Math.floor(random() * sides)}.`);
      return ok();
    }
    case "coin":
      addLog(game, `${player.name} wirft eine Münze: ${random() < 0.5 ? "Kopf" : "Zahl"}.`);
      return ok();
    case "autoPass":
      if (typeof action.value !== "boolean") return fail("Ungültige Einstellung.");
      player.autoPass = action.value;
      if (game.priority !== userId) settle(game, random, now);
      return ok();
    case "tapMana":
      return tapManaAction(game, userId, action);
    case "playLand":
      return playLandAction(game, userId, action);
    case "cast":
      return castAction(game, userId, action);
    case "ability": {
      if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
      const text = typeof action.text === "string" ? action.text.replace(/[\n\r]+/g, " ").trim().slice(0, 100) : "";
      if (!text) return fail("Beschreibung der Fähigkeit fehlt.");
      if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");
      game.stack.push({ sid: newId(game, "s"), kind: "ability", controller: userId, text, cardId: null });
      game.priority = userId;
      game.passed = [];
      addLog(game, `${player.name} legt eine Fähigkeit auf den Stapel: ${text}`);
      return ok();
    }
    case "pass": {
      if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
      game.passed.push(userId);
      settle(game, random, now);
      return ok();
    }
    case "counterSpell": {
      if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
      const index = game.stack.findIndex(item => item.sid === action.sid);
      if (index === -1) return fail("Dieser Zauber liegt nicht (mehr) auf dem Stapel.");
      const [item] = game.stack.splice(index, 1);
      if (item.cardId && game.cards[item.cardId]) {
        const card = game.cards[item.cardId];
        addLog(game, `${nameOf(game, card.id)} wird neutralisiert.`);
        toGraveyard(game, card, "stack");
        offerCommanderReturn(game, card, "graveyard");
      } else addLog(game, `Eine Fähigkeit wird neutralisiert: ${item.text}`);
      game.passed = [];
      return ok();
    }
    case "declareAttackers":
      return declareAttackersAction(game, userId, action, random, now);
    case "declareBlockers":
      return declareBlockersAction(game, userId, action);
    case "endTurn": {
      if (game.turn.active !== userId) return fail("Du bist nicht am Zug.");
      if (game.stack.length > 0) return fail("Der Stapel muss zuerst aufgelöst werden.");
      if (game.combat?.phaseWaiting) return fail("Der Kampf läuft noch (Blocker werden bestimmt).");
      game.combat = null;
      game.turn.phase = "end";
      game.passed = [];
      clearPools(game);
      advanceStep(game, now, random);
      settle(game, random, now);
      return ok();
    }
    case "discard": {
      const pending = game.pendingDiscard;
      if (!pending || pending.userId !== userId) return fail("Du musst gerade nichts abwerfen.");
      const ids = Array.isArray(action.ids) ? action.ids : [];
      if (new Set(ids).size !== pending.count || ids.length !== pending.count) {
        return fail(`Wähle genau ${pending.count} Karte${pending.count === 1 ? "" : "n"} zum Abwerfen.`);
      }
      for (const id of ids) if (!player.hand.includes(id)) return fail("Diese Karte ist nicht in deiner Hand.");
      for (const id of ids) {
        player.hand.splice(player.hand.indexOf(id), 1);
        player.graveyard.push(id);
      }
      addLog(game, `${player.name} wirft ${ids.length} Karte${ids.length === 1 ? "" : "n"} ab: ${ids.map(id => nameOf(game, id)).join(", ")}.`);
      game.pendingDiscard = null;
      finishTurn(game);
      return ok();
    }
    case "commanderZone": {
      const prompt = player.prompts.find(item => item.id === action.id);
      if (!prompt) return fail("Dazu gibt es keine offene Frage.");
      player.prompts = player.prompts.filter(item => item.id !== action.id);
      if (action.yes === true) {
        const found = locate(game, userId, action.id);
        if (!found || found.zone === "command" || found.zone === "battlefield") return ok();
        player[found.zone].splice(found.index, 1);
        resetCardState(found.card);
        player.command.push(found.card.id);
        addLog(game, `${player.name} legt ${nameOf(game, found.card.id)} in die Kommandozone.`);
      }
      return ok();
    }
    case "concede":
      eliminate(game, userId, "aufgegeben", now, random);
      return ok();
    default:
      return fail("Unbekannte Aktion.");
  }
}

function counterAction(game, userId, action) {
  const found = locate(game, userId, action.id);
  if (!found || (found.zone !== "battlefield" && found.zone !== "command")) return fail("Marker gehen nur auf Karten im Spiel.");
  const kind = typeof action.kind === "string" ? action.kind.trim().slice(0, 20) : "";
  if (!kind || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > MAX_COUNTERS) return fail("Ungültiger Marker.");
  const counters = found.card.counters;
  const next = Math.min(MAX_COUNTERS, Math.max(0, (counters[kind] ?? 0) + action.delta));
  if (next === 0) delete counters[kind];
  else counters[kind] = next;
  if (Object.keys(counters).length > 6) {
    delete counters[kind];
    return fail("Höchstens 6 verschiedene Markerarten je Karte.");
  }
  // +1/+1 und -1/-1 heben sich auf
  const both = Math.min(counters["+1/+1"] ?? 0, counters["-1/-1"] ?? 0);
  if (both > 0) {
    for (const key of ["+1/+1", "-1/-1"]) {
      counters[key] -= both;
      if (counters[key] === 0) delete counters[key];
    }
  }
  return ok();
}

function tokenAction(game, userId, action) {
  const player = game.players[userId];
  const name = typeof action.name === "string" ? action.name.replace(/[^\p{L}\p{N} /+*'.,:-]/gu, "").trim().slice(0, 40) : "";
  if (!name) return fail("Name des Spielsteins fehlt.");
  const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
  if (tokens >= MAX_TOKENS) return fail(`Höchstens ${MAX_TOKENS} Spielsteine je Spieler.`);
  const id = newId(game, "t");
  const key = `token:${id}`;
  const stats = name.match(/(\d+)\/(\d+)/);
  const power = stats ? Number(stats[1]) : null;
  const toughness = stats ? Number(stats[2]) : null;
  game.xdefs[key] = {
    name,
    typeLine: stats ? "Token Creature" : "Token",
    manaValue: 0,
    imageUri: null,
    manaCost: "",
    types: { creature: Boolean(stats), land: false, instant: false, sorcery: false, artifact: false, enchantment: false, planeswalker: false, battle: false, legendary: false, basicLand: false },
    power,
    toughness,
    powerText: stats ? stats[1] : null,
    toughnessText: stats ? stats[2] : null,
    loyalty: null,
    keywords: [],
    mana: null
  };
  game.cards[id] = {
    id, owner: userId, def: key, tapped: false, faceDown: false, counters: {}, revealed: false, token: true,
    damage: 0, deathtouched: false, sinceSeq: tick(game)
  };
  player.battlefield.push(id);
  addLog(game, `${player.name} erzeugt einen Spielstein: ${name}.`);
  return ok();
}

function tapManaAction(game, userId, action) {
  const found = locate(game, userId, action.id);
  if (!found || found.zone !== "battlefield") return fail("Diese Karte liegt nicht auf deinem Schlachtfeld.");
  const def = defOf(game, found.card);
  if (!def.mana) return fail("Diese Karte erzeugt kein einfaches Mana.");
  if (found.card.tapped) return fail("Diese Karte ist bereits getappt.");
  if (isSick(game, found.card)) return fail("Diese Kreatur ist noch beschwörungsmüde.");
  const additions = [];
  for (const options of def.mana) {
    let color = options[0];
    if (options.length > 1) {
      if (typeof action.color === "string" && options.includes(action.color)) color = action.color;
      else return fail("Bitte eine Manafarbe wählen.");
    }
    additions.push(color);
  }
  found.card.tapped = true;
  for (const color of additions) found.player.pool[color] += 1;
  return ok();
}

function playLandAction(game, userId, action) {
  if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  if (!found || found.zone !== "hand") return fail("Das Land muss in deiner Hand sein.");
  if (!defOf(game, found.card).types.land) return fail("Das ist kein Land.");
  if (game.turn.active !== userId || (game.turn.phase !== "main1" && game.turn.phase !== "main2") || game.stack.length > 0) {
    return fail("Länder spielst du nur in deiner Hauptphase bei leerem Stapel.");
  }
  if (game.turn.landsPlayed >= 1) return fail("Du hast in diesem Zug schon ein Land gespielt (mit „Manuell bewegen“ trotzdem möglich).");
  found.player.hand.splice(found.index, 1);
  found.player.battlefield.push(found.card.id);
  enterBattlefield(game, found.card);
  game.turn.landsPlayed += 1;
  addLog(game, `${found.player.name} spielt ${nameOf(game, found.card.id)}.`);
  return ok();
}

function castAction(game, userId, action) {
  const player = game.players[userId];
  if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  if (!found || (found.zone !== "hand" && found.zone !== "command")) return fail("Zaubern kannst du nur aus der Hand oder der Kommandozone.");
  const def = defOf(game, found.card);
  if (def.types.land) return fail("Länder werden mit „Land spielen“ gelegt.");
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  if (!instantSpeed && !mainPhase) {
    return fail("Dieser Zauber geht nur in deiner Hauptphase bei leerem Stapel (Sofortzauber und Blitz jederzeit).");
  }
  if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");

  const x = isInt(action.x) ? clampInt(action.x, 0, 99) : 0;
  const tax = found.zone === "command" ? 2 * (player.cmdCasts[found.card.id] ?? 0) : 0;
  let paid = "";
  if (action.free === true) {
    paid = " ohne Manakosten";
  } else {
    const plan = planPayment({ manaCost: def.manaCost, x, extraGeneric: tax, pool: player.pool, sources: manaSources(game, userId) });
    if (!plan.ok) {
      return fail(`Nicht genug Mana für ${describeCost(def.manaCost, x, tax)}${tax ? " (inkl. Kommandantensteuer)" : ""}. Tappe Quellen oder wirke „ohne Kosten“.`);
    }
    for (const id of plan.tap) game.cards[id].tapped = true;
    for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
    for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
    if (plan.lifeLoss) player.life -= plan.lifeLoss;
    paid = ` (${describeCost(def.manaCost, x, tax)})`;
  }
  player[found.zone].splice(found.index, 1);
  if (found.zone === "command") player.cmdCasts[found.card.id] = (player.cmdCasts[found.card.id] ?? 0) + 1;
  found.card.revealed = false;
  game.stack.push({ sid: newId(game, "s"), kind: "spell", controller: userId, cardId: found.card.id, x });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} wirkt ${def.name}${paid}.`);
  return ok();
}

function declareAttackersAction(game, userId, action, random, now) {
  if (game.turn.active !== userId) return fail("Du bist nicht am Zug.");
  if (game.turn.phase !== "attackers") return fail("Angreifer bestimmst du im Angriffsschritt.");
  if (game.stack.length > 0) return fail("Der Stapel muss zuerst aufgelöst werden.");
  const list = Array.isArray(action.attackers) ? action.attackers : [];
  if (list.length > 40) return fail("Zu viele Angreifer.");
  const opponents = alive(game).filter(id => id !== userId);
  const attackers = [];
  const seen = new Set();
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== "string" || seen.has(entry.id)) return fail("Ungültige Angreifer.");
    seen.add(entry.id);
    const card = game.cards[entry.id];
    if (!card || card.owner !== userId || !game.players[userId].battlefield.includes(entry.id)) return fail("Angreifer müssen auf deinem Schlachtfeld liegen.");
    const def = defOf(game, card);
    if (!def.types.creature || card.faceDown) return fail(`${def.name} ist keine Kreatur.`);
    if (card.tapped) return fail(`${def.name} ist getappt.`);
    if (isSick(game, card)) return fail(`${def.name} ist beschwörungsmüde.`);
    if (hasKeyword(game, card, "defender")) return fail(`${def.name} kann nicht angreifen (Verteidiger).`);
    const target = typeof entry.target === "string" ? entry.target : opponents.length === 1 ? opponents[0] : "";
    if (!opponents.includes(target)) return fail("Wähle für jeden Angreifer einen Gegner.");
    attackers.push({ id: entry.id, target });
  }
  if (attackers.length === 0) {
    addLog(game, `${game.players[userId].name} greift nicht an.`);
    enterPhase(game, "main2");
    settle(game, random, now);
    return ok();
  }
  for (const attacker of attackers) {
    const card = game.cards[attacker.id];
    if (!hasKeyword(game, card, "vigilance")) card.tapped = true;
  }
  game.combat = { attackers, blocks: [], done: [], phaseWaiting: true };
  game.turn.phase = "blockers";
  game.priority = null;
  game.passed = [];
  addLog(
    game,
    `${game.players[userId].name} greift an: ${attackers.map(a => `${nameOf(game, a.id)} → ${game.players[a.target].name}`).join(", ")}.`
  );
  settleCombatWaiting(game);
  return ok();
}

function declareBlockersAction(game, userId, action) {
  const combat = game.combat;
  if (!combat || !combat.phaseWaiting || game.turn.phase !== "blockers") return fail("Es werden gerade keine Blocker bestimmt.");
  if (!defendersOf(game).includes(userId) || combat.done.includes(userId)) return fail("Du musst nicht (mehr) blocken.");
  const list = Array.isArray(action.blocks) ? action.blocks : [];
  const usedBlockers = new Set();
  const chosen = [];
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.blocker !== "string" || typeof entry.attacker !== "string") return fail("Ungültige Blocker.");
    if (usedBlockers.has(entry.blocker)) return fail("Jede Kreatur blockt höchstens einen Angreifer.");
    usedBlockers.add(entry.blocker);
    const blocker = game.cards[entry.blocker];
    if (!blocker || blocker.owner !== userId || !game.players[userId].battlefield.includes(entry.blocker)) return fail("Blocker müssen auf deinem Schlachtfeld liegen.");
    const bdef = defOf(game, blocker);
    if (!bdef.types.creature || blocker.faceDown) return fail(`${bdef.name} ist keine Kreatur.`);
    if (blocker.tapped) return fail(`${bdef.name} ist getappt und kann nicht blocken.`);
    const attacker = combat.attackers.find(a => a.id === entry.attacker && a.target === userId);
    if (!attacker) return fail("Du kannst nur Angreifer blocken, die dich angreifen.");
    const acard = game.cards[attacker.id];
    if (hasKeyword(game, acard, "flying") && !hasKeyword(game, blocker, "flying") && !hasKeyword(game, blocker, "reach")) {
      return fail(`${bdef.name} kann ${nameOf(game, acard.id)} nicht blocken (Flug).`);
    }
    chosen.push({ blocker: entry.blocker, attacker: entry.attacker });
  }
  for (const attacker of combat.attackers.filter(a => a.target === userId)) {
    const count = chosen.filter(b => b.attacker === attacker.id).length;
    if (count === 1 && hasKeyword(game, game.cards[attacker.id], "menace")) {
      return fail(`${nameOf(game, attacker.id)} hat Drohung und muss von mindestens zwei Kreaturen geblockt werden.`);
    }
  }
  combat.blocks.push(...chosen);
  combat.done.push(userId);
  addLog(
    game,
    chosen.length === 0
      ? `${game.players[userId].name} blockt nicht.`
      : `${game.players[userId].name} blockt: ${chosen.map(b => `${nameOf(game, b.blocker)} ← ${nameOf(game, b.attacker)}`).join(", ")}.`
  );
  settleCombatWaiting(game);
  return ok();
}

function mulliganAction(game, userId, action, random, now) {
  const player = game.players[userId];
  if (action.type === "concede") {
    eliminate(game, userId, "aufgegeben", now, random);
    if (game.phase === "mulligan" && alive(game).every(id => game.players[id].kept)) startPlaying(game, random);
    return ok();
  }
  if (action.type === "dice" || action.type === "coin") return handleAction(game, userId, action, random, now);
  if (player.kept) return fail("Du hast deine Starthand bereits behalten.");

  if (action.type === "mulligan") {
    if (player.mulligans >= HAND_SIZE - 1) return fail("Weitere Mulligans sind nicht möglich.");
    player.library.push(...player.hand);
    player.hand = [];
    shuffle(player.library, random);
    drawCards(game, userId, HAND_SIZE);
    player.mulligans += 1;
    addLog(game, `${player.name} nimmt einen Mulligan (${player.mulligans}).`);
    return ok();
  }

  if (action.type === "keep") {
    const free = game.format === "commander" ? 1 : 0;
    const bottomCount = Math.max(0, player.mulligans - free);
    const bottom = Array.isArray(action.bottom) ? action.bottom : [];
    if (new Set(bottom).size !== bottom.length || bottom.length !== bottomCount) {
      return fail(bottomCount === 0 ? "Du musst keine Karten unter die Bibliothek legen." : `Lege genau ${bottomCount} Karte${bottomCount === 1 ? "" : "n"} unter die Bibliothek.`);
    }
    for (const id of bottom) {
      if (!player.hand.includes(id)) return fail("Diese Karte ist nicht in deiner Hand.");
    }
    for (const id of bottom) {
      player.hand.splice(player.hand.indexOf(id), 1);
      player.library.unshift(id); // unten = Anfang der Liste
    }
    player.kept = true;
    addLog(game, `${player.name} behält die Starthand${bottomCount ? ` (${bottomCount} Karte${bottomCount === 1 ? "" : "n"} unten)` : ""}.`);
    if (alive(game).every(id => game.players[id].kept)) startPlaying(game, random);
    return ok();
  }
  return fail("Zuerst muss jeder Spieler seine Starthand behalten oder einen Mulligan nehmen.");
}

function startPlaying(game, random) {
  game.phase = "playing";
  const candidates = alive(game);
  const first = candidates[Math.floor(random() * candidates.length)];
  game.turn.first = first;
  game.turn.number = 1;
  addLog(game, `${game.players[first].name} beginnt (zufällig bestimmt).`);
  startTurn(game, first, { skipDraw: game.seats.length === 2 });
}

function moveAction(game, userId, action) {
  const player = game.players[userId];
  const found = locate(game, userId, action.id);
  if (!found) return fail("Das ist nicht deine Karte.");
  if (!ZONES.includes(action.to)) return fail("Unbekannte Zone.");
  const { zone: from, card } = found;
  const to = action.to;
  if (from === "library" && !player.looking?.includes(card.id)) {
    return fail("Karten aus der Bibliothek kannst du nur bewegen, nachdem du sie angesehen hast.");
  }

  const wasFaceDown = card.faceDown;
  player[from].splice(found.index, 1);
  if (player.looking) player.looking = player.looking.filter(id => id !== card.id);

  // Spielsteine verschwinden, sobald sie das Schlachtfeld verlassen.
  if (card.token && to !== "battlefield") {
    addLog(game, `${player.name}: Spielstein ${nameOf(game, card.id)} verschwindet.`);
    delete game.cards[card.id];
    return ok();
  }

  const publicFrom = PUBLIC_ZONES.has(from) && !wasFaceDown;
  if (from !== to) resetCardState(card);
  if (to === "library") {
    if (action.position === "bottom") player.library.unshift(card.id);
    else player.library.push(card.id);
  } else {
    player[to].push(card.id);
  }
  if (to === "battlefield" && from !== "battlefield") enterBattlefield(game, card);
  if (from === "command" && to !== "command") {
    player.cmdCasts[card.id] = (player.cmdCasts[card.id] ?? 0) + 1;
  }
  if (action.faceDown === true && (to === "battlefield" || to === "exile")) card.faceDown = true;
  if (from === "battlefield") offerCommanderReturn(game, card, to);

  const hiddenMove = (!PUBLIC_ZONES.has(to) || card.faceDown) && !publicFrom;
  const name = hiddenMove ? "eine Karte" : nameOf(game, card.id);
  addLog(game, `${player.name} bewegt ${name}: ${ZONE_LABELS[from]} → ${ZONE_LABELS[to]}${to === "library" ? (action.position === "bottom" ? " (unten)" : " (oben)") : ""}.`);
  return ok();
}

/** Spiel abbrechen (Raum geschlossen oder abgelaufen); liefert die Zusammenfassung für den Verlauf. */
export function abortGame(game, now = Date.now()) {
  if (game.phase === "ended") return game.summary;
  finishGame(game, now, true);
  return game.summary;
}

/** Spieler verlässt mitten im Spiel: gilt als aufgegeben. */
export function playerLeft(game, userId, { random = Math.random, now = Date.now() } = {}) {
  if (!game.players[userId] || game.phase === "ended") return;
  eliminate(game, userId, "hat den Raum verlassen", now, random);
  if (game.phase === "mulligan" && alive(game).every(id => game.players[id].kept)) startPlaying(game, random);
}

export { poolTotal };
