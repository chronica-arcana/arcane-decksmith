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
import { describeEffect as describeEffectText, parseCardText } from "./cardText.js";
import { emptyPool, describeCost, planPayment, poolTotal } from "./manaPayment.js";

export const GAME_VERSION = 3;
export const ZONES = ["library", "hand", "battlefield", "graveyard", "exile", "command"];
const PUBLIC_ZONES = new Set(["battlefield", "graveyard", "exile", "command"]);
/** Schritte eines Zuges. Aufnahme der Karte und Enttappen geschehen automatisch zu Beginn. */
export const PHASES = ["draw", "main1", "attackers", "blockers", "damage", "main2", "end"];
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

/** Kurzlebige Effekte für die Anzeige (Schaden, Heilung): die letzten werden mit jeder Sicht mitgeschickt. */
function pushFx(game, fx) {
  game.fxSeq += 1;
  game.fx.push({ id: game.fxSeq, ...fx });
  if (game.fx.length > 16) game.fx.splice(0, game.fx.length - 16);
}

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
/** Dauereffekte wie „Creatures you control get +1/+1“ (Boni und Schlüsselwörter), die auf diese Karte wirken. */
function staticEffects(game, card) {
  const result = { p: 0, th: 0, grants: [] };
  if (!defOf(game, card).types.creature || !onBattlefield(game, card.id)) return result;
  for (const userId of game.seats) {
    for (const id of game.players[userId].battlefield) {
      const source = game.cards[id];
      for (const effect of defOf(game, source).rules?.statics ?? []) {
        const applies =
          effect.scope === "you" ? source.owner === card.owner
          : effect.scope === "youOther" ? source.owner === card.owner && source.id !== card.id
          : effect.scope === "opp" ? source.owner !== card.owner
          : true;
        if (!applies) continue;
        result.p += effect.p;
        result.th += effect.th;
        result.grants.push(...effect.grants);
      }
    }
  }
  // Ausrüstung und Auren, die an dieser Kreatur hängen
  for (const userId of game.seats) {
    for (const id of game.players[userId].battlefield) {
      const source = game.cards[id];
      if (source.attachedTo !== card.id) continue;
      const attach = defOf(game, source).rules?.attach;
      if (!attach) continue;
      result.p += attach.p;
      result.th += attach.th;
      result.grants.push(...attach.grants);
    }
  }
  return result;
}
const keywordsOfCard = (game, card) => {
  const base = defOf(game, card).keywords ?? [];
  const grants = [...staticEffects(game, card).grants, ...(card.tk ?? [])];
  return grants.length > 0 ? [...base, ...grants] : base;
};
const hasKeyword = (game, card, keyword) => keywordsOfCard(game, card).includes(keyword);

/** Farben einer Karte aus den Manasymbolen der Kosten (Spielsteine: farblos). */
const colorsOfDef = def => [...new Set(String(def?.manaCost ?? "").match(/[WUBRG]/g) ?? [])];
const colorsOfCard = (game, card) => colorsOfDef(defOf(game, card));
/** Hat das Ziel Schutz vor den Farben der Quelle? */
const protectedFrom = (game, card, sourceColors) => {
  const protection = defOf(game, card).rules?.protection ?? [];
  return sourceColors.some(color => protection.includes(color));
};

const counterOf = (card, kind) => card.counters[kind] ?? 0;
const bonus = card => counterOf(card, "+1/+1") - counterOf(card, "-1/-1");
const powerOf = (game, card) => (defOf(game, card).power ?? 0) + bonus(card) + (card.tp ?? 0) + staticEffects(game, card).p;
const toughnessOf = (game, card) => (defOf(game, card).toughness ?? 0) + bonus(card) + (card.tt ?? 0) + staticEffects(game, card).th;

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
    askResponse: true,
    autoStart: true,
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
    tp: 0,
    tt: 0,
    origOwner: userId,
    ...extra
  };
  game.players[userId][zone].push(id);
  return id;
}

function drawCards(game, userId, count) {
  const player = game.players[userId];
  let drawn = 0;
  for (let i = 0; i < count; i += 1) {
    if (player.library.length === 0) {
      player.drewEmpty = true; // Ziehen aus leerer Bibliothek: Niederlage bei der nächsten Prüfung
      break;
    }
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
    choice: null,
    manual: null,
    triggerQueue: [],
    fx: [],
    fxSeq: 0,
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
      const def = buildDef(card, facts.get(card.id));
      def.rules = parseCardText({ name: def.name, typeLine: def.typeLine, oracleText: def.oracleText });
      delete def.oracleText;
      game.defs[key] = def;
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
  card.attachedTo = null;
  card.tk = [];
  card.owner = card.origOwner ?? card.owner;
  card.stolenUntilEot = false;
}

function enterBattlefield(game, card) {
  card.sinceSeq = tick(game);
  const def = defOf(game, card);
  if (def.types.planeswalker && def.loyalty) card.counters.loyalty = def.loyalty;
  if (def.rules?.entersTapped) card.tapped = true;
  else if (def.rules?.entersTappedUnless && !entryConditionMet(game, card, def.rules.entersTappedUnless)) card.tapped = true;
  else if (def.rules?.shock) game.triggerQueue.push({ kind: "entry", entry: "shock", cardId: card.id, controller: card.owner, life: def.rules.shock.life });
  else if (def.rules?.reveal) game.triggerQueue.push({ kind: "entry", entry: "reveal", cardId: card.id, controller: card.owner, types: def.rules.reveal.types });
  fireTriggers(game, card, "etb");
  if (def.types.land) fireGlobal(game, "landEnters", card);
  if (def.types.creature) fireGlobal(game, "creatureEnters", card);
}

/** Ist die Bedingung von „enters tapped unless …“ erfüllt (dann kommt das Land ungetappt)? */
function entryConditionMet(game, card, condition) {
  const others = game.players[card.owner].battlefield.map(id => game.cards[id]).filter(other => other.id !== card.id);
  if (condition.kind === "lands") {
    const count = others.filter(other => {
      const def = defOf(game, other);
      return def.types.land && (!condition.basic || def.types.basicLand);
    }).length;
    return condition.op === "gte" ? count >= condition.n : count <= condition.n;
  }
  if (condition.kind === "types") {
    return others.some(other => {
      const def = defOf(game, other);
      return def.types.land && condition.types.some(type => new RegExp(`\\b${type}\\b`, "i").test(def.typeLine));
    });
  }
  if (condition.kind === "lowLife") return alive(game).some(id => game.players[id].life <= condition.n);
  if (condition.kind === "turn") return (game.players[card.owner].turnsTaken ?? 1) <= condition.n;
  if (condition.kind === "controls") {
    return others.some(other => {
      const def = defOf(game, other);
      if (condition.legendary && !def.types.legendary) return false;
      const word = condition.type;
      if (def.types[word] !== undefined) return def.types[word];
      return new RegExp(`\\b${word}\\b`, "i").test(def.typeLine);
    });
  }
  return true;
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

/** Hat der Spieler beim Wirken bestimmte Länder gewählt (`action.tap`), zahlen nur diese; sonst sucht das Spiel selbst die beste Zahlung. */
function chosenSources(sources, action) {
  if (!Array.isArray(action?.tap) || action.tap.length === 0 || action.tap.length > 60) return sources;
  const wanted = new Set(action.tap.filter(id => typeof id === "string"));
  return sources.filter(source => wanted.has(source.id));
}

/** Kommandanten verlassen Spielzonen: Der Besitzer darf sie in die Kommandozone zurücklegen. */
function offerCommanderReturn(game, card, to) {
  if (!card.cmd || to === "command" || to === "battlefield" || to === "stack") return;
  const prompts = game.players[card.owner].prompts;
  if (!prompts.some(prompt => prompt.id === card.id)) prompts.push({ type: "commander", id: card.id });
}

/** Karte stirbt oder wird neutralisiert → Friedhof (Spielsteine verschwinden). */
function toGraveyard(game, card, from = "battlefield") {
  const holder = game.players[card.owner]; // Kontrolleur (liegt dort auf dem Feld)
  const owner = game.players[card.origOwner ?? card.owner]; // Besitzer (dort landet die Karte)
  if (from === "battlefield") {
    fireTriggers(game, card, "dies");
    if (defOf(game, card).types.creature) fireGlobal(game, "creatureDies", card);
  }
  for (const zone of ZONES) {
    const index = holder[zone].indexOf(card.id);
    if (index !== -1) holder[zone].splice(index, 1);
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
    const involved = game.combat.attackers.some(a => attackTargetOwner(game, a.target) === userId || game.cards[a.id]?.owner === userId);
    if (involved && game.turn.active === userId) game.combat = null;
    else if (involved) {
      game.combat.attackers = game.combat.attackers.filter(a => attackTargetOwner(game, a.target) !== userId && game.cards[a.id]?.owner !== userId);
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

function commanderCount(game, ownerId) {
  return Object.values(game.cards).filter(card => card.cmd && (card.origOwner ?? card.owner) === ownerId).length;
}

function checkElimination(game, userId, now) {
  const player = game.players[userId];
  if (player.eliminated) return;
  if (player.life <= 0) eliminate(game, userId, "0 Lebenspunkte", now);
  else if (player.poison >= 10) eliminate(game, userId, "10 Giftmarken", now);
  else if (player.drewEmpty) eliminate(game, userId, "Karte aus leerer Bibliothek gezogen", now);
  else if (Object.values(player.cmdDamageCards ?? {}).some(value => value >= 21)) eliminate(game, userId, "21 Kommandantenschaden", now);
  else if (
    Object.entries(player.cmdDamage).some(([owner, value]) => value >= 21 && commanderCount(game, owner) <= 1)
  ) eliminate(game, userId, "21 Kommandantenschaden", now);
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
  game.turn.landsPlayed = 0;
  game.turn.drawn = false;
  game.turn.drawBlocked = skipDraw;
  game.turn.drew = false;
  game.turn.fog = false;
  game.turn.manualStart = player.autoStart === false && !skipDraw;
  player.turnsTaken = (player.turnsTaken ?? 0) + 1;
  game.combat = null;
  game.pendingDiscard = null;
  player.turnStartSeq = tick(game);
  clearPools(game);
  game.priority = userId;
  game.passed = [];
  // Enttappen und Versorgung laufen immer automatisch.
  untapAll(game, userId);
  addLog(game, `Zug ${game.turn.number}: ${player.name} ist am Zug (alles enttappt).`);
  fireGlobal(game, "upkeep", userId);
  if (skipDraw) {
    game.turn.phase = "main1";
    addLog(game, `${player.name} zieht im ersten Zug keine Karte.`);
  } else if (player.autoStart === false) {
    // Karte ziehen: durch Anklicken der Bibliothek (danach geht es automatisch weiter).
    game.turn.phase = "draw";
  } else {
    game.turn.phase = "main1";
    const drawn = drawCards(game, userId, 1);
    game.turn.drew = drawn > 0;
    addLog(game, drawn ? `${player.name} zieht eine Karte.` : `${player.name} kann keine Karte ziehen (Bibliothek leer).`);
  }
}

/** Kontrolle über eine Karte übernehmen (bis zum Zugende oder dauerhaft). Beschwörungsmüdigkeit gilt für den neuen Kontrolleur. */
/** Ward: Wählt ein Spieler eine gegnerische Karte mit Ward als Ziel, kostet das zusätzlich (hier gleich beim Wirken bezahlt). */
function wardExtra(game, userId, targets) {
  let extra = "";
  for (const id of targets ?? []) {
    const card = game.cards[id];
    if (card && card.owner !== userId && onBattlefield(game, id)) extra += defOf(game, card).rules?.ward ?? "";
  }
  return extra;
}

function takeControl(game, card, newController, untilEot) {
  if (card.owner === newController || !onBattlefield(game, card.id)) return false;
  const from = game.players[card.owner];
  from.battlefield.splice(from.battlefield.indexOf(card.id), 1);
  game.players[newController].battlefield.push(card.id);
  card.owner = newController;
  card.stolenUntilEot = Boolean(untilEot);
  card.attachedTo = card.attachedTo && game.cards[card.attachedTo]?.owner === newController ? card.attachedTo : null;
  card.sinceSeq = tick(game);
  return true;
}

/** Am Zugende gehen „bis zum Zugende“-Kontrollwechsel zurück an den Besitzer. */
function returnStolen(game) {
  for (const card of Object.values(game.cards)) {
    if (!card.stolenUntilEot || card.owner === (card.origOwner ?? card.owner)) continue;
    if (!onBattlefield(game, card.id)) continue;
    const back = card.origOwner;
    const from = game.players[card.owner];
    from.battlefield.splice(from.battlefield.indexOf(card.id), 1);
    if (game.players[back] && !game.players[back].eliminated) game.players[back].battlefield.push(card.id);
    card.owner = back;
    card.stolenUntilEot = false;
    addLog(game, `${nameOf(game, card.id)} kehrt zu ${game.players[back]?.name ?? "seinem Besitzer"} zurück.`);
  }
}

function untapAll(game, userId) {
  let count = 0;
  for (const id of game.players[userId].battlefield) {
    if (game.cards[id].tapped) count += 1;
    game.cards[id].tapped = false;
  }
  return count;
}

function finishTurn(game) {
  for (const card of Object.values(game.cards)) {
    card.damage = 0;
    card.deathtouched = false;
    card.tp = 0;
    card.tt = 0;
    card.tk = [];
  }
  clearPools(game);
  returnStolen(game);
  let next = orderFrom(game, game.turn.active)[1] ?? orderFrom(game, game.turn.active)[0];
  while (game.extraTurns?.length > 0) {
    const extra = game.extraTurns.shift();
    if (game.players[extra] && !game.players[extra].eliminated) {
      next = extra;
      break;
    }
  }
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
    case "draw":
      enterPhase(game, "main1");
      return;
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
      flushTriggers(game);
      if (game.phase === "playing") enterPhase(game, "main2");
      return;
    case "main2":
      enterPhase(game, "end");
      fireGlobal(game, "endStep", game.turn.active);
      flushTriggers(game);
      // Im Endschritt wird niemand nach Antworten gefragt: Er wird übersprungen, sobald keine Auslöser mehr offen sind.
      const someoneCanRespond = game.seats.some(id => id !== game.turn.active && !game.players[id].eliminated && game.players[id].askResponse !== false && canRespond(game, id));
      if (game.stack.length === 0 && !game.choice && !someoneCanRespond) advanceStep(game, now, random);
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
  const controller = game.players[item.controller];
  if (item.kind === "ability") {
    const ctx = { controller: item.controller, source: item.source, sourceName: item.sourceName, targets: item.targets ?? [], unparsed: item.unparsed ?? [] };
    if ((item.specs?.length ?? 0) > 0 && !targetsLegal(game, item.specs, ctx.targets, item.controller, item.source && game.cards[item.source] ? colorsOfCard(game, game.cards[item.source]) : [])) {
      addLog(game, `${item.sourceName}: Fähigkeit verpufft (Ziel nicht mehr gültig).`);
      return;
    }
    addLog(game, `Fähigkeit von ${controller.name} löst sich auf: ${(item.text ?? "").replace("~", item.sourceName ?? "")}`);
    runEffects(game, item.effects ?? [], ctx);
    return;
  }
  const card = game.cards[item.cardId];
  if (!card) return;
  const def = defOf(game, card);
  const owner = game.players[card.owner];
  if (def.types.instant || def.types.sorcery) {
    const base = def.rules?.spell ?? { effects: [], specs: [], unparsed: [] };
    const spell = base.modes ? base.modes[item.mode] ?? { effects: [], specs: [], unparsed: [] } : base;
    if (spell.specs.length > 0 && !targetsLegal(game, spell.specs, item.targets ?? [], item.controller, colorsOfDef(def))) {
      addLog(game, `${def.name} verpufft (Ziel nicht mehr gültig).`);
    } else {
      addLog(game, `${def.name} löst sich auf.`);
      runEffects(game, spell.effects, { controller: item.controller, source: card.id, sourceName: def.name, targets: item.targets ?? [], unparsed: spell.unparsed, x: item.x, flashback: Boolean(item.flashback) });
    }
    (item.flashback ? owner.exile : owner.graveyard).push(card.id);
  } else if (def.rules?.aura) {
    const specs = def.rules.spell?.specs ?? [];
    if (specs.length > 0 && !targetsLegal(game, specs, item.targets ?? [], item.controller, colorsOfDef(def))) {
      addLog(game, `${def.name} verpufft (Ziel nicht mehr gültig).`);
      toGraveyard(game, card, "stack");
      return;
    }
    owner.battlefield.push(card.id);
    enterBattlefield(game, card);
    card.attachedTo = item.targets?.[0] ?? null;
    addLog(game, `${def.name} löst sich auf → hängt an ${card.attachedTo ? nameOf(game, card.attachedTo) : "…"}.`);
  } else {
    owner.battlefield.push(card.id);
    enterBattlefield(game, card);
    addLog(game, `${def.name} löst sich auf → Schlachtfeld.`);
  }
}

/**
 * Darf der Spieler jetzt Sofortzauber und Fähigkeiten nutzen? Mit Priorität – und im Blockschritt, während die Verteidiger noch
 * entscheiden, jeder lebende Spieler (Antwort auf den Angriff, bevor Blocker bestimmt sind).
 */
function hasWindow(game, userId) {
  if (game.priority === userId) return true;
  return Boolean(game.combat?.phaseWaiting && game.stack.length === 0 && !game.players[userId].eliminated);
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

/**
 * Kann der Spieler jetzt auf den Stapel antworten? Nur wenn er eine Karte auf der Hand (oder in der Kommandozone) hat, die er jetzt
 * wirken kann – also eine „leuchtende“ Karte (Sofortzauber oder Blitz mit bezahlbarem Mana). Fähigkeiten auf dem Feld lösen keine Rückfrage aus.
 */
function canRespond(game, userId) {
  const saved = game.priority;
  game.priority = userId;
  try {
    const player = game.players[userId];
    for (const zone of ["hand", "command"]) {
      for (const id of player[zone]) {
        const options = playOptions(game, userId, id);
        if (options?.kind === "spell" && options.ok) return true;
      }
    }
    return false;
  } finally {
    game.priority = saved;
  }
}

/** Schritte, an deren Ende ein Gegner mit passendem Sofortzauber gefragt wird. */
const STEP_WINDOWS = new Set(["main1", "attackers", "damage", "main2", "end"]);

function settleLoop(game, random, now) {
  for (let guard = 0; guard < 50; guard += 1) {
    if (game.pendingDiscard || game.choice || game.manual || (game.combat?.phaseWaiting && game.stack.length === 0)) return;
    const order = orderFrom(game, game.priority ?? game.turn.active);
    const waiting = order.filter(userId => !game.passed.includes(userId));
    if (waiting.length === 0) {
      if (game.stack.length > 0) {
        resolveTop(game);
        checkStateBased(game, now);
        flushTriggers(game);
        game.passed = [];
        game.priority = game.turn.active;
        if (game.phase !== "playing") return;
        continue;
      }
      advanceStep(game, now, random);
      if (game.phase !== "playing" || game.pendingDiscard || game.choice || game.manual || game.combat?.phaseWaiting) return;
      continue;
    }
    const next = waiting[0];
    if (game.stack.length === 0) {
      // Ohne Stapel wird nur der aktive Spieler gefragt (Phasen weiterschalten); alle anderen passen von selbst.
      // Ausnahme: Am Ende jedes Schritts darf auch ein Gegner mit leuchtendem Sofortzauber antworten (nur wenn er das so eingestellt hat).
      const window = STEP_WINDOWS.has(game.turn.phase) && game.players[next].askResponse !== false && canRespond(game, next);
      if (next !== game.turn.active && !window) {
        game.passed.push(next);
        continue;
      }
    } else {
      // Mit Stapel: nur nachfragen, wenn dieser Spieler wirklich antworten kann (Sofortzauber, Blitz, Fähigkeit) und nicht
      // der Besitzer des obersten Eintrags ist. Sonst löst das Spiel den Stapel ohne Zutun auf.
      const top = game.stack.at(-1);
      const asks = game.players[next].askResponse !== false && next !== top.controller && canRespond(game, next);
      if (!asks) {
        game.passed.push(next);
        continue;
      }
    }
    game.priority = next;
    return;
  }
}

// ---------------------------------------------------------------------------
// Kampf
// ---------------------------------------------------------------------------

/** Warum kann `blocker` den Angreifer nicht blocken? (`null`, wenn er es kann.) */
export function cannotBlockReason(game, attacker, blocker) {
  if (hasKeyword(game, attacker, "flying") && !hasKeyword(game, blocker, "flying") && !hasKeyword(game, blocker, "reach")) return "Flug";
  const blockerDef = defOf(game, blocker);
  const blockerColors = colorsOfDef(blockerDef);
  if (hasKeyword(game, attacker, "fear") && !blockerDef.types.artifact && !blockerColors.includes("B")) return "Furcht";
  if (hasKeyword(game, attacker, "intimidate") && !blockerDef.types.artifact && !blockerColors.some(color => colorsOfCard(game, attacker).includes(color))) return "Einschüchtern";
  if (hasKeyword(game, attacker, "skulk") && powerOf(game, blocker) > powerOf(game, attacker)) return "Schleichen";
  if (protectedFrom(game, attacker, blockerColors)) return "Schutz";
  return null;
}

/** Wer verteidigt? Ein Angriff gilt einem Spieler oder einem Planeswalker (dann dessen Kontrolleur). */
export function attackTargetOwner(game, target) {
  return game.players[target] ? target : game.cards[target]?.owner;
}

function defendersOf(game) {
  return [...new Set(game.combat.attackers.map(attacker => attackTargetOwner(game, attacker.target)))].filter(id => id && game.players[id] && !game.players[id].eliminated);
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
  if (game.turn.fog) {
    addLog(game, "Der gesamte Kampfschaden dieses Zuges wird verhindert.");
    return;
  }
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
        hits.push({ source: card.id, ...(game.players[attacker.target] ? { player: attacker.target } : { card: attacker.target }), amount: power });
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
      if (hasKeyword(game, card, "trample") && left > 0) hits.push({ source: card.id, ...(game.players[attacker.target] ? { player: attacker.target } : { card: attacker.target }), amount: left });
    }
    for (const block of combat.blocks) {
      if (!living(block.blocker) || !living(block.attacker) || !deals(block.blocker)) continue;
      const power = Math.max(0, powerOf(game, game.cards[block.blocker]));
      if (power > 0) hits.push({ source: block.blocker, card: block.attacker, amount: power });
    }
    for (const hit of hits) {
      const source = game.cards[hit.source];
      if (!source) continue;
      inflictDamage(game, source, hit.card ?? hit.player, hit.amount, { combat: true });
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
        if (card.attachedTo && (!game.cards[card.attachedTo] || !onBattlefield(game, card.attachedTo))) {
          card.attachedTo = null;
          if (def.rules?.aura) dies = true; // eine Aura ohne Ziel kommt auf den Friedhof
        }
        if (dies) {
          addLog(game, `${def.name} (${game.players[userId].name}) kommt auf den Friedhof.`);
          toGraveyard(game, card);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // Legendenregel: gleichnamige legendäre Permanents eines Spielers – er behält eines.
  if (!game.choice) {
    for (const userId of game.seats) {
      const byName = new Map();
      for (const id of game.players[userId].battlefield) {
        const def = defOf(game, game.cards[id]);
        if (!def.types.legendary) continue;
        byName.set(def.name, [...(byName.get(def.name) ?? []), id]);
      }
      const group = [...byName.values()].find(ids => ids.length > 1);
      if (group) {
        game.choice = {
          userId,
          kind: "cards",
          prompt: `Legendenregel: Wähle ${nameOf(game, group[0])}, die du behältst (die anderen kommen auf den Friedhof).`,
          options: group,
          min: 1,
          max: 1,
          step: { type: "legend", group },
          queue: [],
          ctx: null
        };
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Kartentext-Engine: Ziele, Effekte, Auslöser, Fähigkeiten, Auswahlen
// ---------------------------------------------------------------------------

const SPELL_KINDS = new Set(["spell", "creatureSpell", "noncreatureSpell", "instantOrSorcerySpell"]);

function typeMatches(def, what) {
  switch (what) {
    case "basic land": return def.types.basicLand;
    case "land": return def.types.land;
    case "creature": return def.types.creature;
    case "artifact": return def.types.artifact;
    case "enchantment": return def.types.enchantment;
    case "planeswalker": return def.types.planeswalker;
    case "instant": return def.types.instant;
    case "sorcery": return def.types.sorcery;
    default: return true;
  }
}

/** Gültige Ziele (Karten-IDs, Spieler-IDs oder Stapel-IDs) für eine Zielangabe. */
function validTargets(game, spec, controller, sourceColors = []) {
  const players = alive(game);
  const battlefield = [];
  for (const userId of game.seats) {
    for (const id of game.players[userId].battlefield) {
      const card = game.cards[id];
      const def = defOf(game, card);
      if (card.owner !== controller && (hasKeyword(game, card, "hexproof") || hasKeyword(game, card, "shroud"))) continue;
      if (sourceColors.length > 0 && protectedFrom(game, card, sourceColors)) continue;
      battlefield.push({ id, def });
    }
  }
  const pick = predicate => battlefield.filter(item => predicate(item.def.types)).map(item => item.id);
  switch (spec.kind) {
    case "player": return players;
    case "opponent": return players.filter(id => id !== controller);
    case "creature": return pick(t => t.creature);
    case "myCreature": return battlefield.filter(item => item.def.types.creature && game.cards[item.id].owner === controller).map(item => item.id);
    case "gyCreature":
    case "gyArtifact":
    case "gyEnchantment":
    case "gyLand":
    case "gyPermanent": {
      const what = spec.kind.slice(2).toLowerCase();
      return game.players[controller].graveyard.filter(id => {
        const def = defOf(game, game.cards[id]);
        return what === "permanent" ? !def.types.instant && !def.types.sorcery : typeMatches(def, what);
      });
    }
    case "planeswalker": return pick(t => t.planeswalker);
    case "artifact": return pick(t => t.artifact);
    case "enchantment": return pick(t => t.enchantment);
    case "land": return pick(t => t.land);
    case "permanent": return battlefield.map(item => item.id);
    case "nonland": return pick(t => !t.land);
    case "creatureOrPlaneswalker": return pick(t => t.creature || t.planeswalker);
    case "artifactOrEnchantment": return pick(t => t.artifact || t.enchantment);
    case "any": return [...players, ...pick(t => t.creature || t.planeswalker)];
    default:
      if (SPELL_KINDS.has(spec.kind)) {
        return game.stack
          .filter(item => {
            if (item.kind !== "spell" || !game.cards[item.cardId]) return false;
            const t = defOf(game, game.cards[item.cardId]).types;
            if (spec.kind === "creatureSpell") return t.creature;
            if (spec.kind === "noncreatureSpell") return !t.creature;
            if (spec.kind === "instantOrSorcerySpell") return t.instant || t.sorcery;
            return true;
          })
          .map(item => item.sid);
      }
      return [];
  }
}

const targetOptions = (game, specs, controller, sourceColors = []) => specs.map(spec => ({ kind: spec.kind, options: validTargets(game, spec, controller, sourceColors) }));

function targetsLegal(game, specs, targets, controller, sourceColors = []) {
  if (!Array.isArray(targets) || targets.length !== specs.length) return false;
  return specs.every((spec, index) => validTargets(game, spec, controller, sourceColors).includes(targets[index]));
}

function createToken(game, userId, { name, power, toughness, artifact = false }) {
  const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
  if (tokens >= MAX_TOKENS) return null;
  const id = newId(game, "t");
  const key = `token:${id}`;
  const creature = power !== null && power !== undefined;
  game.xdefs[key] = {
    name,
    typeLine: `Token${artifact ? " Artifact" : ""}${creature ? " Creature" : ""}`,
    manaValue: 0,
    imageUri: null,
    manaCost: "",
    types: { creature, land: false, instant: false, sorcery: false, artifact, enchantment: false, planeswalker: false, battle: false, legendary: false, basicLand: false },
    power: creature ? power : null,
    toughness: creature ? toughness : null,
    powerText: creature ? String(power) : null,
    toughnessText: creature ? String(toughness) : null,
    loyalty: null,
    keywords: [],
    mana: null,
    rules: { spell: null, triggers: [], activated: [], notes: [] }
  };
  game.cards[id] = {
    id, owner: userId, def: key, tapped: false, faceDown: false, counters: {}, revealed: false, token: true,
    damage: 0, deathtouched: false, sinceSeq: tick(game), tp: 0, tt: 0
  };
  game.players[userId].battlefield.push(id);
  return id;
}

function playersOf(game, who, ctx) {
  switch (who.k) {
    case "you": return [ctx.controller];
    case "target": return ctx.targets[who.t] && game.players[ctx.targets[who.t]] && !game.players[ctx.targets[who.t]].eliminated ? [ctx.targets[who.t]] : [];
    case "eachOpp": return alive(game).filter(id => id !== ctx.controller);
    case "each": return alive(game);
    case "ids": return who.ids.filter(id => game.players[id] && !game.players[id].eliminated);
    default: return [];
  }
}

/**
 * Fügt einem Spieler oder einer Karte Schaden zu und beachtet dabei Schutz, Gift (Infect), Wither, Todesberührung, Lebensverbindung,
 * Planeswalker-Loyalität und Kommandantenschaden. Gilt für Kampf- und Zauberschaden.
 */
function inflictDamage(game, source, targetId, amount, { combat = false } = {}) {
  if (amount <= 0) return 0;
  const sourceName = source ? defOf(game, source).name : "Effekt";
  const sourceColors = source ? colorsOfCard(game, source) : [];
  const infect = source && hasKeyword(game, source, "infect");
  const wither = source && hasKeyword(game, source, "wither");
  let dealt = 0;
  if (game.players[targetId]) {
    const target = game.players[targetId];
    if (infect) target.poison += amount;
    else target.life -= amount;
    pushFx(game, { type: "damage", player: targetId, amount });
    if (!combat) addLog(game, `${sourceName} fügt ${target.name} ${amount} ${infect ? "Giftmarken" : "Schaden"} zu.`);
    if (source?.cmd) {
      target.cmdDamage[source.origOwner ?? source.owner] = (target.cmdDamage[source.origOwner ?? source.owner] ?? 0) + amount;
      target.cmdDamageCards = target.cmdDamageCards ?? {};
      target.cmdDamageCards[source.id] = (target.cmdDamageCards[source.id] ?? 0) + amount;
    }
    dealt = amount;
  } else {
    const card = game.cards[targetId];
    if (!card || !onBattlefield(game, targetId)) return 0;
    if (source && protectedFrom(game, card, sourceColors)) {
      addLog(game, `${defOf(game, card).name} hat Schutz: der Schaden von ${sourceName} wird verhindert.`);
      return 0;
    }
    const def = defOf(game, card);
    if (def.types.creature) {
      if (infect || wither) card.counters["-1/-1"] = (card.counters["-1/-1"] ?? 0) + amount;
      else card.damage += amount;
      pushFx(game, { type: "damage", card: targetId, amount });
      if (source && hasKeyword(game, source, "deathtouch")) card.deathtouched = true;
      dealt = amount;
    }
    if (def.types.planeswalker) {
      card.counters.loyalty = Math.max(0, (card.counters.loyalty ?? 0) - amount);
      pushFx(game, { type: "damage", card: targetId, amount });
      dealt = amount;
    }
    if (!combat) addLog(game, `${sourceName} fügt ${def.name} ${amount} Schaden zu.`);
  }
  if (dealt > 0 && source && hasKeyword(game, source, "lifelink")) {
    game.players[source.owner].life += dealt;
    pushFx(game, { type: "heal", player: source.owner, amount: dealt });
  }
  return dealt;
}

function dealDamage(game, source, targetId, amount) {
  inflictDamage(game, source, targetId, amount);
}

function destroyCard(game, card) {
  if (!onBattlefield(game, card.id)) return;
  const def = defOf(game, card);
  if (hasKeyword(game, card, "indestructible")) {
    addLog(game, `${def.name} ist unzerstörbar.`);
    return;
  }
  addLog(game, `${def.name} wird zerstört.`);
  toGraveyard(game, card);
}

function leaveTo(game, card, zone) {
  const holder = game.players[card.owner];
  const owner = game.players[card.origOwner ?? card.owner];
  for (const z of ZONES) {
    const index = holder[z].indexOf(card.id);
    if (index !== -1) holder[z].splice(index, 1);
  }
  if (card.token) {
    delete game.cards[card.id];
    return;
  }
  offerCommanderReturn(game, card, zone);
  resetCardState(card);
  owner[zone].push(card.id);
}

/** Auslöser anderer Permanents auf ein Ereignis (Kreatur stirbt/betritt, Land betritt, Beginn der Versorgung, Endphase). */
function fireGlobal(game, event, subject) {
  for (const userId of game.seats) {
    for (const id of [...game.players[userId].battlefield]) {
      const source = game.cards[id];
      if (!source) continue;
      const def = defOf(game, source);
      for (const trigger of def.rules?.triggers ?? []) {
        if (trigger.event !== event) continue;
        const scope = trigger.scope ?? { owner: "you", another: false };
        const subjectOwner = typeof subject === "string" ? subject : subject.owner;
        if (scope.owner === "you" && subjectOwner !== source.owner) continue;
        if (scope.owner === "opp" && subjectOwner === source.owner) continue;
        if (scope.another && typeof subject !== "string" && subject.id === source.id) continue;
        game.triggerQueue.push({ controller: source.owner, source: source.id, sourceName: def.name, trigger });
      }
    }
  }
}

function fireTriggers(game, card, event) {
  const def = defOf(game, card);
  for (const trigger of def.rules?.triggers ?? []) {
    if (trigger.event === event) game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger });
  }
}

function pushAbility(game, item) {
  if (game.stack.length >= MAX_STACK) return;
  game.stack.push({ sid: newId(game, "s"), kind: "ability", cardId: null, ...item });
  game.passed = [];
  if (!game.combat?.phaseWaiting) game.priority = game.turn.active;
}

/** Länder mit Wahl beim Ins-Spiel-Kommen: Shock-Land (Leben zahlen) und „Karte zeigen“. Ohne Möglichkeit kommt das Land getappt. */
function openEntryChoice(game, entry) {
  const card = game.cards[entry.cardId];
  const player = game.players[entry.controller];
  if (!card || !onBattlefield(game, card.id)) return;
  const name = nameOf(game, card.id);
  if (entry.entry === "shock") {
    if (player.life <= entry.life) {
      card.tapped = true;
      return;
    }
    game.choice = {
      userId: entry.controller,
      kind: "yesno",
      prompt: `${name}: ${entry.life} Leben zahlen, damit es ungetappt ins Spiel kommt?`,
      labels: { yes: `${entry.life} Leben zahlen (ungetappt)`, no: "Nicht zahlen (getappt)" },
      options: ["yes", "no"],
      min: 1,
      max: 1,
      step: { type: "shock", cardId: card.id, life: entry.life },
      queue: [],
      ctx: null
    };
    return;
  }
  const options = player.hand.filter(id => {
    const typeLine = defOf(game, game.cards[id]).typeLine;
    return entry.types.some(type => new RegExp(`\\b${type}\\b`, "i").test(typeLine));
  });
  if (options.length === 0) {
    card.tapped = true;
    return;
  }
  game.choice = {
    userId: entry.controller,
    kind: "cards",
    prompt: `${name}: Zeige eine Karte (${entry.types.join(" oder ")}) aus deiner Hand, damit es ungetappt ins Spiel kommt. Sonst kommt es getappt.`,
    options,
    min: 0,
    max: 1,
    step: { type: "reveal", cardId: card.id },
    queue: [],
    ctx: null
  };
}

/** Wartende Auslöser auf den Stapel legen; bei Auslösern mit Ziel wählt der Besitzer das Ziel. */
function flushTriggers(game) {
  while (game.triggerQueue.length > 0 && !game.choice) {
    const next = game.triggerQueue.shift();
    if (next.kind === "entry") {
      openEntryChoice(game, next);
      continue;
    }
    const { trigger } = next;
    const base = {
      controller: next.controller,
      source: next.source,
      sourceName: next.sourceName,
      text: trigger.summary || trigger.text,
      effects: trigger.effects,
      specs: trigger.specs,
      unparsed: trigger.unparsed
    };
    if (trigger.effects.length === 0 && trigger.unparsed.length === 0) continue;
    if (trigger.specs.length === 0) {
      pushAbility(game, { ...base, targets: [] });
      continue;
    }
    openTriggerTarget(game, next.controller, base, [], next.sourceName, trigger.text);
  }
}

/** Fragt das nächste Ziel eines Auslösers ab (bei mehreren Zielen nacheinander). Gibt `false` zurück, wenn es kein gültiges Ziel gibt. */
function openTriggerTarget(game, controller, base, picked, sourceName, text) {
  const spec = base.specs[picked.length];
  const colors = base.source && game.cards[base.source] ? colorsOfCard(game, game.cards[base.source]) : [];
  const options = validTargets(game, spec, controller, colors);
  if (options.length === 0) {
    addLog(game, `${sourceName}: Auslöser verfällt (kein gültiges Ziel).`);
    return false;
  }
  game.choice = {
    userId: controller,
    kind: "targets",
    prompt: `Ziel ${base.specs.length > 1 ? `${picked.length + 1} von ${base.specs.length} ` : ""}für ${sourceName}: ${String(text ?? base.text).replace("~", sourceName)}`,
    options,
    min: 1,
    max: 1,
    step: { type: "trigger", item: base, picked },
    queue: [],
    ctx: null
  };
  return true;
}

/** Führt Effekte aus. Gibt `true` zurück, wenn eine Auswahl geöffnet wurde (der Rest wartet in `choice.queue`). */
function runEffects(game, effects, ctx) {
  for (let i = 0; i < effects.length; i += 1) {
    if (runEffect(game, effects[i], ctx, effects.slice(i + 1))) return true;
  }
  afterEffects(game, ctx);
  return false;
}

function afterEffects(game, ctx) {
  if (ctx.unparsed?.length > 0) {
    game.manual = { userId: ctx.controller, text: ctx.unparsed.join(" "), source: ctx.sourceName ?? "" };
    addLog(game, `${game.players[ctx.controller].name} muss einen Kartentext manuell umsetzen: ${ctx.unparsed.join(" ")}`);
  }
}

function openChoice(game, choice) {
  game.choice = { min: 0, max: 1, queue: [], ...choice };
  return true;
}

/** Anzahl für „… for each …“. */
function perCount(game, ctx, per) {
  const mine = game.players[ctx.controller];
  const ofType = (ids, type) => ids.filter(id => defOf(game, game.cards[id]).types[type]).length;
  const everyone = type => game.seats.reduce((sum, id) => sum + ofType(game.players[id].battlefield, type), 0);
  switch (per) {
    case "creature you control": return ofType(mine.battlefield, "creature");
    case "land you control": return ofType(mine.battlefield, "land");
    case "artifact you control": return ofType(mine.battlefield, "artifact");
    case "creature your opponents control": return game.seats.filter(id => id !== ctx.controller).reduce((sum, id) => sum + ofType(game.players[id].battlefield, "creature"), 0);
    case "creature": return everyone("creature");
    case "land": return everyone("land");
    case "artifact": return everyone("artifact");
    case "card in your hand": return mine.hand.length;
    case "opponent": return alive(game).filter(id => id !== ctx.controller).length;
    default: return 0;
  }
}

function runEffect(game, rawEffect, ctx, rest) {
  // X wird mit dem beim Wirken gewählten Wert ersetzt.
  let effect = rawEffect.n === "X" ? { ...rawEffect, n: Math.max(0, ctx.x ?? 0) * (rawEffect.negate ? -1 : 1) } : rawEffect;
  if (effect.per) effect = { ...effect, n: effect.n * perCount(game, ctx, effect.per) };
  const controller = game.players[ctx.controller];
  const name = ctx.sourceName ?? "Effekt";
  const sourceCard = ctx.source ? game.cards[ctx.source] : null;
  const targetCard = effect.t !== undefined ? game.cards[ctx.targets[effect.t]] : null;
  switch (effect.type) {
    case "draw":
      for (const id of playersOf(game, effect.who, ctx)) {
        const drawn = drawCards(game, id, effect.n);
        addLog(game, `${game.players[id].name} zieht ${drawn === 1 ? "eine Karte" : `${drawn} Karten`} (${name}).`);
      }
      return false;
    case "life":
      for (const id of playersOf(game, effect.who, ctx)) {
        game.players[id].life += effect.n;
        pushFx(game, { type: effect.n >= 0 ? "heal" : "damage", player: id, amount: Math.abs(effect.n) });
        addLog(game, `${game.players[id].name}: Leben ${effect.n > 0 ? "+" : ""}${effect.n} (jetzt ${game.players[id].life}, ${name}).`);
      }
      return false;
    case "mill":
      for (const id of playersOf(game, effect.who, ctx)) {
        const player = game.players[id];
        const names = [];
        for (let i = 0; i < effect.n && player.library.length > 0; i += 1) {
          const cardId = player.library.pop();
          player.graveyard.push(cardId);
          names.push(nameOf(game, cardId));
        }
        addLog(game, `${player.name} mahlt: ${names.join(", ") || "–"} (${name}).`);
      }
      return false;
    case "discard": {
      const ids = playersOf(game, effect.who, ctx);
      for (let index = 0; index < ids.length; index += 1) {
        const player = game.players[ids[index]];
        if (player.hand.length === 0) continue;
        if (player.hand.length <= effect.n) {
          const gone = player.hand.splice(0, player.hand.length);
          player.graveyard.push(...gone);
          addLog(game, `${player.name} wirft ab: ${gone.map(id => nameOf(game, id)).join(", ")} (${name}).`);
          continue;
        }
        return openChoice(game, {
          userId: ids[index],
          kind: "cards",
          prompt: `Wirf ${effect.n} Karte${effect.n === 1 ? "" : "n"} ab (${name}).`,
          options: [...player.hand],
          min: effect.n,
          max: effect.n,
          step: { type: "discard" },
          queue: [{ type: "discard", who: { k: "ids", ids: ids.slice(index + 1) }, n: effect.n }, ...rest],
          ctx
        });
      }
      return false;
    }
    case "scry": {
      const count = Math.min(effect.n, controller.library.length);
      if (count === 0) return false;
      const options = controller.library.slice(-count).reverse();
      addLog(game, `${controller.name} wühlt ${count} (${name}).`);
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wühlen ${count}: Wähle die Karten, die unter die Bibliothek kommen (die übrigen bleiben oben).`,
        options,
        min: 0,
        max: count,
        step: { type: "scry" },
        queue: rest,
        ctx
      });
    }
    case "damage": {
      const source = sourceCard ?? null;
      const to = effect.to;
      if (to.k === "target") dealDamage(game, source, ctx.targets[to.t], effect.n);
      else if (to.k === "eachOpp") for (const id of alive(game).filter(p => p !== ctx.controller)) dealDamage(game, source, id, effect.n);
      else if (to.k === "each") for (const id of alive(game)) dealDamage(game, source, id, effect.n);
      else {
        for (const userId of game.seats) {
          for (const id of [...game.players[userId].battlefield]) {
            const c = game.cards[id];
            if (!defOf(game, c).types.creature) continue;
            if (to.k === "eachOppCreature" && c.owner === ctx.controller) continue;
            dealDamage(game, source, id, effect.n);
          }
        }
      }
      return false;
    }
    case "destroy":
      if (targetCard) destroyCard(game, targetCard);
      return false;
    case "may": {
      const text = effect.effects.map(item => describeEffectText(item)).filter(Boolean).join(" ");
      return openChoice(game, {
        userId: ctx.controller,
        kind: "yesno",
        prompt: `${name}: ${text || "Optionalen Effekt ausführen?"}`,
        options: ["yes", "no"],
        labels: { yes: "Ja", no: "Nein" },
        min: 1,
        max: 1,
        step: { type: "may", effects: effect.effects },
        queue: rest,
        ctx
      });
    }
    case "ifDid": {
      if (!ctx.didMay) return false;
      for (let i = 0; i < effect.effects.length; i += 1) {
        if (runEffect(game, effect.effects[i], ctx, [...effect.effects.slice(i + 1), ...rest])) return true;
      }
      return false;
    }
    case "sacrifice": {
      const ids = playersOf(game, effect.who, ctx);
      const matches = userId => game.players[userId].battlefield.filter(id => {
        const types = defOf(game, game.cards[id]).types;
        return effect.what === "permanent" ? true : effect.what === "nonland" ? !types.land : types[effect.what];
      });
      for (let i = 0; i < ids.length; i += 1) {
        const userId = ids[i];
        const options = matches(userId);
        if (options.length === 0) continue;
        if (options.length === 1) {
          addLog(game, `${game.players[userId].name} opfert ${nameOf(game, options[0])} (${name}).`);
          toGraveyard(game, game.cards[options[0]]);
          continue;
        }
        const remaining = ids.slice(i + 1);
        return openChoice(game, {
          userId,
          kind: "cards",
          prompt: `Opfere ${{ creature: "eine Kreatur", artifact: "ein Artefakt", enchantment: "eine Verzauberung", land: "ein Land", permanent: "ein Permanent", nonland: "ein Nichtland-Permanent" }[effect.what] ?? "ein Permanent"} (${name}).`,
          options,
          min: 1,
          max: 1,
          step: { type: "sacrificeOne" },
          queue: remaining.length > 0 ? [{ type: "sacrifice", who: { k: "ids", ids: remaining }, what: effect.what }, ...rest] : rest,
          ctx
        });
      }
      return false;
    }
    case "control": {
      if (!targetCard || !takeControl(game, targetCard, ctx.controller, effect.untilEot)) return false;
      ctx.lastControlled = targetCard.id;
      addLog(game, `${controller.name} übernimmt die Kontrolle über ${nameOf(game, targetCard.id)}${effect.untilEot ? " bis zum Zugende" : ""} (${name}).`);
      return false;
    }
    case "untapLast": {
      const card = ctx.lastControlled ? game.cards[ctx.lastControlled] : null;
      if (card) card.tapped = false;
      return false;
    }
    case "hasteLast": {
      const card = ctx.lastControlled ? game.cards[ctx.lastControlled] : null;
      if (card) card.tk = [...(card.tk ?? []), "haste"];
      return false;
    }
    case "fog":
      game.turn.fog = true;
      addLog(game, `Kampfschaden wird in diesem Zug verhindert (${name}).`);
      return false;
    case "extraTurn":
      game.extraTurns = [...(game.extraTurns ?? []), ctx.controller];
      addLog(game, `${controller.name} erhält nach diesem Zug einen zusätzlichen Zug (${name}).`);
      return false;
    case "grantKw": {
      const card = effect.self ? sourceCard : targetCard;
      if (card) card.tk = [...(card.tk ?? []), ...effect.kws];
      return false;
    }
    case "attach": {
      const host = targetCard;
      if (!sourceCard || !host || !onBattlefield(game, sourceCard.id) || !onBattlefield(game, host.id)) return false;
      sourceCard.attachedTo = host.id;
      addLog(game, `${nameOf(game, sourceCard.id)} wird an ${nameOf(game, host.id)} gehängt.`);
      return false;
    }
    case "grantTemp": {
      const host = sourceCard?.attachedTo ? game.cards[sourceCard.attachedTo] : null;
      if (host) host.tk = [...(host.tk ?? []), ...effect.kws];
      return false;
    }
    case "reanimate": {
      const card = targetCard;
      if (!card || !controller.graveyard.includes(card.id)) return false;
      controller.graveyard.splice(controller.graveyard.indexOf(card.id), 1);
      if (effect.to === "hand") {
        controller.hand.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt aus dem Friedhof auf die Hand (${name}).`);
        return false;
      }
      controller.battlefield.push(card.id);
      enterBattlefield(game, card);
      const extra = (effect.counters ?? 0) + (rest.find(item => item.type === "reanimateCounters")?.n ?? 0);
      if (extra > 0) card.counters["+1/+1"] = (card.counters["+1/+1"] ?? 0) + extra;
      addLog(game, `${nameOf(game, card.id)} kehrt aus dem Friedhof aufs Schlachtfeld zurück${extra ? ` mit ${extra} +1/+1-Markern` : ""} (${name}).`);
      return false;
    }
    case "flashbackTokenCounters": {
      const token = ctx.lastToken ? game.cards[ctx.lastToken] : null;
      if (ctx.flashback && token) token.counters["+1/+1"] = (token.counters["+1/+1"] ?? 0) + effect.n;
      return false;
    }
    case "reanimateCounters":
    case "noop":
      return false;
    case "destroyAll":
      for (const userId of game.seats) {
        for (const id of [...game.players[userId].battlefield]) {
          const c = game.cards[id];
          if (c && typeMatches(defOf(game, c), effect.what)) destroyCard(game, c);
        }
      }
      return false;
    case "exile":
      if (targetCard) {
        addLog(game, `${nameOf(game, targetCard.id)} wird ins Exil geschickt (${name}).`);
        leaveTo(game, targetCard, "exile");
      }
      return false;
    case "bounce":
      if (targetCard) {
        addLog(game, `${nameOf(game, targetCard.id)} geht zurück auf die Hand (${name}).`);
        leaveTo(game, targetCard, "hand");
      }
      return false;
    case "bounceOwnLand": {
      const options = controller.battlefield.filter(id => defOf(game, game.cards[id]).types.land);
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wähle ein Land, das zurück auf deine Hand geht (${name}).`,
        options,
        min: 1,
        max: 1,
        step: { type: "bounceLand" },
        queue: rest,
        ctx
      });
    }
    case "tap":
    case "untap":
      if (targetCard) targetCard.tapped = effect.type === "tap";
      return false;
    case "counterSpell": {
      const index = game.stack.findIndex(item => item.sid === ctx.targets[effect.t]);
      if (index !== -1) {
        const [item] = game.stack.splice(index, 1);
        if (item.cardId && game.cards[item.cardId]) {
          addLog(game, `${nameOf(game, item.cardId)} wird neutralisiert (${name}).`);
          toGraveyard(game, game.cards[item.cardId], "stack");
          offerCommanderReturn(game, game.cards[item.cardId], "graveyard");
        }
      }
      return false;
    }
    case "counters": {
      const card = effect.self ? sourceCard : targetCard;
      if (card && onBattlefield(game, card.id)) {
        card.counters[effect.kind] = Math.min(MAX_COUNTERS, (card.counters[effect.kind] ?? 0) + effect.n);
        const both = Math.min(card.counters["+1/+1"] ?? 0, card.counters["-1/-1"] ?? 0);
        if (both > 0) {
          for (const key of ["+1/+1", "-1/-1"]) {
            card.counters[key] -= both;
            if (card.counters[key] === 0) delete card.counters[key];
          }
        }
        addLog(game, `${nameOf(game, card.id)} erhält ${effect.n}× ${effect.kind} (${name}).`);
      }
      return false;
    }
    case "pump": {
      const card = effect.self ? sourceCard : targetCard;
      if (card && onBattlefield(game, card.id)) {
        card.tp = (card.tp ?? 0) + effect.p;
        card.tt = (card.tt ?? 0) + effect.th;
        addLog(game, `${nameOf(game, card.id)} erhält ${effect.p >= 0 ? "+" : ""}${effect.p}/${effect.th >= 0 ? "+" : ""}${effect.th} bis zum Zugende (${name}).`);
      }
      return false;
    }
    case "pumpAll": {
      const scope = effect.scope ?? "you";
      for (const userId of game.seats) {
        if ((scope === "you" && userId !== ctx.controller) || (scope === "opp" && userId === ctx.controller)) continue;
        for (const id of game.players[userId].battlefield) {
          const c = game.cards[id];
          if (defOf(game, c).types.creature) {
            c.tp = (c.tp ?? 0) + effect.p;
            c.tt = (c.tt ?? 0) + effect.th;
          }
        }
      }
      const who = scope === "you" ? "Deine Kreaturen" : scope === "opp" ? "Kreaturen deiner Gegner" : "Alle Kreaturen";
      addLog(game, `${who} erhalten ${effect.p >= 0 ? "+" : ""}${effect.p}/${effect.th >= 0 ? "+" : ""}${effect.th} bis zum Zugende (${name}).`);
      return false;
    }
    case "surveil": {
      const count = Math.min(effect.n, controller.library.length);
      if (count === 0) return false;
      addLog(game, `${controller.name} überwacht ${count} (${name}).`);
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Überwachen ${count}: Wähle die Karten, die auf den Friedhof kommen (die übrigen bleiben oben).`,
        options: controller.library.slice(-count).reverse(),
        min: 0,
        max: count,
        step: { type: "surveil" },
        queue: rest,
        ctx
      });
    }
    case "token": {
      let made = 0;
      for (let i = 0; i < effect.n; i += 1) {
        const tokenId = createToken(game, ctx.controller, { name: effect.name, power: effect.p, toughness: effect.th, artifact: effect.artifact });
        if (tokenId) {
          made += 1;
          ctx.lastToken = tokenId;
        }
      }
      addLog(game, `${controller.name} erzeugt ${made}× ${effect.name} ${effect.p}/${effect.th} (${name}).`);
      return false;
    }
    case "search": {
      const options = controller.library.filter(id => typeMatches(defOf(game, game.cards[id]), effect.what));
      shuffle(controller.library);
      addLog(game, `${controller.name} durchsucht die Bibliothek (${name}).`);
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wähle eine Karte (${effect.what === "card" ? "beliebig" : effect.what}) aus deiner Bibliothek (${name}).`,
        options,
        min: 0,
        max: 1,
        step: { type: "search", to: effect.to, tapped: effect.tapped },
        queue: rest,
        ctx
      });
    }
    case "gyReturn": {
      const options = controller.graveyard.filter(id => typeMatches(defOf(game, game.cards[id]), effect.what));
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wähle eine Karte aus deinem Friedhof (${name}).`,
        options,
        min: 1,
        max: 1,
        step: { type: "gyReturn", to: effect.to, counters: rest.find(item => item.type === "reanimateCounters")?.n ?? 0 },
        queue: rest,
        ctx
      });
    }
    case "mana":
      for (const color of effect.symbols) controller.pool[color] += 1;
      addLog(game, `${controller.name} erhält ${effect.symbols.join("")} (${name}).`);
      return false;
    default:
      return false;
  }
}

/** Antwort auf eine offene Auswahl (Ziel, Karten abwerfen/suchen/wühlen …). */
function chooseAction(game, userId, action, random, now) {
  const choice = game.choice;
  if (!choice || choice.userId !== userId) return fail("Du musst gerade nichts auswählen.");
  const ids = Array.isArray(action.ids) ? action.ids : [];
  if (new Set(ids).size !== ids.length || ids.some(id => !choice.options.includes(id))) return fail("Ungültige Auswahl.");
  if (ids.length < choice.min || ids.length > choice.max) {
    return fail(choice.min === choice.max ? `Wähle genau ${choice.min}.` : `Wähle zwischen ${choice.min} und ${choice.max}.`);
  }
  game.choice = null;
  const player = game.players[userId];
  const step = choice.step;
  const ctx = choice.ctx;
  switch (step.type) {
    case "trigger": {
      const picked = [...(step.picked ?? []), ids[0]];
      if (picked.length < step.item.specs.length) {
        if (!openTriggerTarget(game, userId, step.item, picked, step.item.sourceName, step.item.text)) game.choice = null;
        return ok();
      }
      pushAbility(game, { ...step.item, targets: picked });
      break;
    }
    case "may":
      ctx.didMay = ids[0] === "yes";
      if (ctx.didMay) choice.queue = [...step.effects, ...choice.queue];
      break;
    case "sacrificeOne": {
      const card = game.cards[ids[0]];
      if (card && onBattlefield(game, card.id)) {
        addLog(game, `${game.players[userId].name} opfert ${nameOf(game, card.id)}.`);
        toGraveyard(game, card);
      }
      break;
    }
    case "discard":
      for (const id of ids) {
        player.hand.splice(player.hand.indexOf(id), 1);
        player.graveyard.push(id);
      }
      addLog(game, `${player.name} wirft ab: ${ids.map(id => nameOf(game, id)).join(", ")}.`);
      break;
    case "shock": {
      const card = game.cards[step.cardId];
      if (ids[0] === "yes") {
        player.life -= step.life;
        pushFx(game, { type: "damage", player: userId, amount: step.life });
        addLog(game, `${player.name} zahlt ${step.life} Leben: ${nameOf(game, step.cardId)} kommt ungetappt.`);
      } else if (card) {
        card.tapped = true;
        addLog(game, `${nameOf(game, step.cardId)} kommt getappt ins Spiel.`);
      }
      break;
    }
    case "reveal": {
      const card = game.cards[step.cardId];
      if (ids.length > 0) addLog(game, `${player.name} zeigt ${nameOf(game, ids[0])}: ${nameOf(game, step.cardId)} kommt ungetappt.`);
      else if (card) {
        card.tapped = true;
        addLog(game, `${nameOf(game, step.cardId)} kommt getappt ins Spiel.`);
      }
      break;
    }
    case "legend": {
      for (const id of step.group) {
        const card = game.cards[id];
        if (id !== ids[0] && card && onBattlefield(game, id)) {
          addLog(game, `${nameOf(game, id)} kommt wegen der Legendenregel auf den Friedhof.`);
          toGraveyard(game, card);
        }
      }
      break;
    }
    case "bounceLand": {
      const card = game.cards[ids[0]];
      if (card) {
        addLog(game, `${nameOf(game, card.id)} geht zurück auf die Hand.`);
        leaveTo(game, card, "hand");
      }
      break;
    }
    case "surveil":
      for (const id of ids) {
        player.library.splice(player.library.indexOf(id), 1);
        player.graveyard.push(id);
      }
      addLog(game, `${player.name} legt ${ids.length} Karte${ids.length === 1 ? "" : "n"} auf den Friedhof.`);
      break;
    case "scry": {
      for (const id of ids) {
        player.library.splice(player.library.indexOf(id), 1);
        player.library.unshift(id);
      }
      addLog(game, `${player.name} legt ${ids.length} Karte${ids.length === 1 ? "" : "n"} unter die Bibliothek.`);
      break;
    }
    case "search":
    case "gyReturn": {
      for (const id of ids) {
        const card = game.cards[id];
        const from = step.type === "search" ? player.library : player.graveyard;
        from.splice(from.indexOf(id), 1);
        if (step.to === "battlefield") {
          player.battlefield.push(id);
          enterBattlefield(game, card);
          if (step.tapped) card.tapped = true;
          if (step.counters) card.counters["+1/+1"] = (card.counters["+1/+1"] ?? 0) + step.counters;
        } else player.hand.push(id);
        addLog(game, `${player.name} nimmt ${nameOf(game, id)} ${step.to === "hand" ? "auf die Hand" : "aufs Schlachtfeld"}.`);
      }
      break;
    }
    default:
      break;
  }
  if (ctx) runEffects(game, choice.queue, ctx);
  flushTriggers(game);
  settle(game, random, now);
  return ok();
}

// ---------------------------------------------------------------------------
// Sicht pro Spieler
// ---------------------------------------------------------------------------

/** Was kann dieser Spieler mit der Karte aus der Hand (bzw. Kommandozone) jetzt tun? */
export function playOptions(game, userId, id) {
  const found = locate(game, userId, id);
  const flashbackOk = found && found.zone === "graveyard" && Boolean(defOf(game, found.card).rules?.flashback);
  if (!found || (found.zone !== "hand" && found.zone !== "command" && !flashbackOk)) return null;
  const def = defOf(game, found.card);
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;

  if (def.types.land) {
    const okNow = playing && found.zone === "hand" && game.priority === userId && mainPhase && game.turn.landsPlayed < 1;
    return { kind: "land", ok: okNow };
  }
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const timingOk = playing && hasWindow(game, userId) && (instantSpeed || mainPhase);
  let affordable = false;
  if (timingOk) {
    const tax = found.zone === "command" ? 2 * (player.cmdCasts[id] ?? 0) : 0;
    affordable = planPayment({ manaCost: flashbackOk ? def.rules.flashback : def.manaCost, extraGeneric: tax, pool: player.pool, sources: manaSources(game, userId) }).ok;
  }
  const spell = def.rules?.spell;
  return {
    kind: "spell",
    ok: timingOk && affordable,
    timingOk,
    targets: spell && !spell.modes && spell.specs.length > 0 ? targetOptions(game, spell.specs, userId, colorsOfDef(def)) : [],
    modes: spell?.modes?.map(mode => ({ label: mode.summary || mode.label, targets: targetOptions(game, mode.specs, userId, colorsOfDef(def)), manual: mode.unparsed.length > 0 })),
    manual: Boolean(spell && !spell.modes && spell.unparsed.length > 0)
  };
}

/** Aktivierbare Fähigkeiten einer eigenen Karte auf dem Schlachtfeld (mit gültigen Zielen). */
export function abilityOptions(game, userId, card) {
  const def = defOf(game, card);
  const list = def.rules?.activated ?? [];
  if (list.length === 0 || card.owner !== userId) return [];
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  return list.map(ability => {
    let okNow = playing && hasWindow(game, userId) && (!ability.sorcery || mainPhase) && ability.effects.length + ability.unparsed.length > 0;
    if (okNow && ability.cost.tap && (card.tapped || isSick(game, card))) okNow = false;
    if (okNow && ability.cost.loyalty !== undefined) {
      okNow = card.loyaltyTurn !== game.turn.number && (card.counters.loyalty ?? 0) + ability.cost.loyalty >= 0;
    }
    if (okNow && ability.cost.mana) {
      const sources = manaSources(game, userId).filter(source => source.id !== card.id);
      okNow = planPayment({ manaCost: ability.cost.mana, pool: player.pool, sources }).ok;
    }
    return {
      index: ability.index,
      text: ability.summary || ability.text.replace(/~/g, def.name),
      costLabel: [ability.cost.tap ? "{T}" : "", ability.cost.mana, ability.cost.sacrifice ? "Opfern" : "", ability.cost.loyalty !== undefined ? (ability.cost.loyalty > 0 ? `+${ability.cost.loyalty}` : `${ability.cost.loyalty}`) : ""].filter(Boolean).join(", "),
      ok: okNow,
      targets: targetOptions(game, ability.specs, userId, colorsOfDef(def)),
      manual: ability.unparsed.length > 0
    };
  });
}

let attachmentCache = null;
function attachmentMap(game) {
  if (attachmentCache?.game === game) return attachmentCache.map;
  const map = new Map();
  for (const other of Object.values(game.cards)) {
    if (!other.attachedTo) continue;
    if (!map.has(other.attachedTo)) map.set(other.attachedTo, []);
    map.get(other.attachedTo).push(other.id);
  }
  return map;
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
    attachedTo: card.attachedTo ?? null,
    attachedName: card.attachedTo && game.cards[card.attachedTo] ? nameOf(game, card.attachedTo) : null,
    attachments: (attachmentMap(game).get(id) ?? []).map(otherId => nameOf(game, otherId)),
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
    keywords: keywordsOfCard(game, card),
    power: creature ? (def.powerText !== null && def.power === null ? null : powerOf(game, card)) : null,
    toughness: creature ? (def.toughnessText !== null && def.toughness === null ? null : toughnessOf(game, card)) : null,
    abilities: card.owner === viewerId && onBattlefield(game, id) ? abilityOptions(game, viewerId, card) : [],
    cycle: card.owner === viewerId ? cycleOptions(game, viewerId, card) : null,
    rulesNotes: (def.rules?.notes ?? []).slice(0, 4).map(note => note.replace(/~/g, def.name)),
    mana: Boolean(def.mana),
    manaColors: def.mana ? [...new Set(def.mana.flat())] : [],
    ...(card.owner === viewerId ? { play: playOptions(game, viewerId, id) } : {})
  };
}

/** Sicht eines Spielers auf das Spiel. Verdeckte Karten anderer (Hand, Bibliothek, verdeckt gelegte) werden nie mitgeschickt. */
export function gameView(game, viewerId) {
  attachmentCache = null;
  attachmentCache = { game, map: attachmentMap(game) };
  try {
    return buildGameView(game, viewerId);
  } finally {
    attachmentCache = null;
  }
}

function buildGameView(game, viewerId) {
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
      askResponse: p.askResponse,
      autoStart: mine ? p.autoStart : undefined,
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
      sourceName: item.sourceName ?? "",
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
    fx: game.fx.slice(-12),
    choice: game.choice
      ? {
          userId: game.choice.userId,
          kind: game.choice.kind,
          prompt: game.choice.prompt,
          min: game.choice.min,
          max: game.choice.max,
          options:
            game.choice.userId === viewerId
              ? game.choice.options.map(id => {
                  if (game.choice.labels && game.choice.labels[id]) return { id, label: game.choice.labels[id] };
                  if (game.players[id]) return { id, player: { userId: id, name: game.players[id].name } };
                  if (game.cards[id]) return { id, card: cardView(game, id, viewerId) };
                  const item = game.stack.find(entry => entry.sid === id);
                  return { id, card: item?.cardId ? cardView(game, item.cardId, viewerId) : null, spell: true };
                })
              : []
        }
      : null,
    manual: game.manual,
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
/** Handarbeit am Spielstand: nur erlaubt, wenn ein Kartentext nicht automatisch umgesetzt werden kann. */
const MANUAL_ACTIONS = new Set([
  "draw", "mill", "shuffle", "look", "closeLook", "move", "tap", "untapAll", "flip", "reveal", "counter", "token",
  "life", "pcounter", "cmddmg", "pool", "ability", "counterSpell"
]);

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

  if (game.choice && action.type !== "choose" && !["concede", "dice", "coin"].includes(action.type)) {
    return fail(game.choice.userId === userId ? "Triff zuerst die offene Auswahl." : `${game.players[game.choice.userId].name} trifft gerade eine Auswahl.`);
  }
  if (game.manual && !MANUAL_ACTIONS.has(action.type) && !["manualDone", "concede", "dice", "coin"].includes(action.type)) {
    return fail(game.manual.userId === userId ? "Setze zuerst den Kartentext um und bestätige mit „Fertig“." : `${game.players[game.manual.userId].name} setzt gerade einen Kartentext manuell um.`);
  }
  if (MANUAL_ACTIONS.has(action.type) && game.manual?.userId !== userId) {
    return fail("Das regelt das Spiel automatisch. Manuell eingreifen kannst du nur, wenn ein Kartentext nicht automatisch umgesetzt werden kann.");
  }

  const result = handleAction(game, userId, action, random, now);
  if (result.ok && game.phase === "playing") {
    checkStateBased(game, now);
    flushTriggers(game);
    for (const id of game.seats) checkElimination(game, id, now);
    // Auslöser und Zauber auf dem Stapel lösen sich auf, sobald niemand mehr antworten kann.
    if (game.phase === "playing" && game.stack.length > 0) settle(game, random, now);
  }
  repairGame(game);
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
    case "askResponse":
      if (typeof action.value !== "boolean") return fail("Ungültige Einstellung.");
      player.askResponse = action.value;
      return ok();
    case "tapMana":
      return tapManaAction(game, userId, action);
    case "pool": {
      if (!["W", "U", "B", "R", "G", "C"].includes(action.color) || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > 5) {
        return fail("Ungültige Manaangabe.");
      }
      player.pool[action.color] = Math.min(99, Math.max(0, player.pool[action.color] + action.delta));
      return ok();
    }
    case "playLand":
      return playLandAction(game, userId, action);
    case "cast": {
      const result = castAction(game, userId, action);
      if (result.ok) settle(game, random, now); // löst sich von selbst auf, wenn niemand antworten kann
      return result;
    }
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
    case "autoStart":
      if (typeof action.value !== "boolean") return fail("Ungültige Einstellung.");
      player.autoStart = action.value;
      return ok();
    case "drawStep": {
      if (game.turn.active !== userId || game.turn.phase !== "draw") return fail("Karten ziehst du im Zieh-Schritt deines Zuges.");
      if (game.turn.drawBlocked) return fail("Der Startspieler zieht im ersten Zug keine Karte.");
      if (game.turn.drawn) return fail("Du hast in diesem Zug bereits gezogen.");
      const drawn = drawCards(game, userId, 1);
      game.turn.drawn = true;
      game.turn.drew = drawn > 0;
      addLog(game, drawn ? `${player.name} zieht eine Karte.` : `${player.name} kann keine Karte ziehen (Bibliothek leer).`);
      enterPhase(game, "main1"); // nach dem Ziehen geht es automatisch weiter
      return ok();
    }
    case "choose":
      return chooseAction(game, userId, action, random, now);
    case "cycle": {
      const result = cycleAction(game, userId, action);
      if (result.ok) settle(game, random, now);
      return result;
    }
    case "activate": {
      const result = activateAction(game, userId, action);
      if (result.ok) settle(game, random, now);
      return result;
    }
    case "manualDone":
      if (game.manual?.userId !== userId) return fail("Es gibt nichts zu bestätigen.");
      game.manual = null;
      addLog(game, `${player.name} hat den Kartentext umgesetzt.`);
      settle(game, random, now);
      return ok();
    case "pass": {
      if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
      if (game.turn.phase === "draw" && game.turn.active === userId && !game.turn.drawn && !game.turn.drawBlocked && game.stack.length === 0) {
        return fail("Ziehe zuerst eine Karte: Klicke auf deine Bibliothek.");
      }
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
  const stats = name.match(/(\d+)\/(\d+)/);
  const id = createToken(game, userId, { name, power: stats ? Number(stats[1]) : null, toughness: stats ? Number(stats[2]) : null });
  if (!id) return fail(`Höchstens ${MAX_TOKENS} Spielsteine je Spieler.`);
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
  if (!hasWindow(game, userId)) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  const def = found ? defOf(game, found.card) : null;
  const flashback = Boolean(found && found.zone === "graveyard" && def?.rules?.flashback);
  if (!found || !def || (found.zone !== "hand" && found.zone !== "command" && !flashback)) {
    return fail("Zaubern kannst du nur aus der Hand, der Kommandozone oder (mit Rückblende) aus dem Friedhof.");
  }
  if (def.types.land) return fail("Länder werden mit „Land spielen“ gelegt.");
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  if (!instantSpeed && !mainPhase) {
    return fail("Dieser Zauber geht nur in deiner Hauptphase bei leerem Stapel (Sofortzauber und Blitz jederzeit).");
  }
  if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");
  const spellRules = def.rules?.spell;
  let activeRules = spellRules;
  let mode = null;
  if (spellRules?.modes) {
    mode = action.mode;
    if (!Number.isInteger(mode) || !spellRules.modes[mode]) return fail("Wähle zuerst einen Modus für diesen Zauber.");
    activeRules = spellRules.modes[mode];
  }
  const specs = activeRules?.specs ?? [];
  if (specs.length > 0 && !targetsLegal(game, specs, action.targets, userId, colorsOfDef(def))) return fail("Wähle gültige Ziele für diesen Zauber.");

  const x = isInt(action.x) ? clampInt(action.x, 0, 99) : 0;
  const tax = found.zone === "command" ? 2 * (player.cmdCasts[found.card.id] ?? 0) : 0;
  const ward = specs.length > 0 ? wardExtra(game, userId, action.targets) : "";
  const cost = (flashback ? def.rules.flashback : def.manaCost) + ward;
  const plan = planPayment({ manaCost: cost, x, extraGeneric: tax, pool: player.pool, sources: chosenSources(manaSources(game, userId), action) });
  if (!plan.ok) {
    return fail(`Nicht genug Mana für ${describeCost(cost, x, tax)}${tax ? " (inkl. Kommandantensteuer)" : ""}${ward ? " (inkl. Ward)" : ""}.`);
  }
  for (const id of plan.tap) game.cards[id].tapped = true;
  for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
  for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  if (plan.lifeLoss) player.life -= plan.lifeLoss;
  const paid = ` (${describeCost(cost, x, tax)}${flashback ? ", Rückblende" : ""})`;
  player[found.zone].splice(found.index, 1);
  if (found.zone === "command") player.cmdCasts[found.card.id] = (player.cmdCasts[found.card.id] ?? 0) + 1;
  found.card.revealed = false;
  game.stack.push({ sid: newId(game, "s"), kind: "spell", controller: userId, cardId: found.card.id, x, flashback, mode, targets: specs.length > 0 ? action.targets : [] });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} wirkt ${def.name}${paid}.`);
  if (!def.types.creature) {
    for (const id of player.battlefield) {
      const card = game.cards[id];
      if (hasKeyword(game, card, "prowess")) {
        card.tp = (card.tp ?? 0) + 1;
        card.tt = (card.tt ?? 0) + 1;
      }
    }
  }
  return ok();
}

/** Cycling: Karte aus der Hand abwerfen und Mana zahlen, dann eine Karte ziehen (oder nach einem Land suchen). */
function cycleOptions(game, userId, card) {
  const def = defOf(game, card);
  const cycling = def.rules?.cycling;
  if (!cycling || !game.players[userId].hand.includes(card.id)) return null;
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const payable = playing && hasWindow(game, userId) && planPayment({ manaCost: cycling.cost, pool: player.pool, sources: manaSources(game, userId) }).ok;
  return { ok: payable, cost: cycling.cost, search: cycling.search };
}

function cycleAction(game, userId, action) {
  if (!hasWindow(game, userId)) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  if (!found || found.zone !== "hand") return fail("Cycling geht nur mit Karten aus deiner Hand.");
  const def = defOf(game, found.card);
  const cycling = def.rules?.cycling;
  if (!cycling) return fail("Diese Karte hat kein Cycling.");
  const player = game.players[userId];
  const plan = planPayment({ manaCost: cycling.cost, pool: player.pool, sources: chosenSources(manaSources(game, userId), action) });
  if (!plan.ok) return fail(`Nicht genug Mana für Cycling ${describeCost(cycling.cost)}.`);
  for (const id of plan.tap) game.cards[id].tapped = true;
  for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
  for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  toGraveyard(game, found.card, "hand");
  const search = cycling.search;
  const effects = search
    ? [{ type: "search", what: ["plains", "island", "swamp", "mountain", "forest"].includes(search) ? "basic land" : search, to: "hand", tapped: false }]
    : [{ type: "draw", who: { k: "you" }, n: 1 }];
  game.stack.push({
    sid: newId(game, "s"),
    kind: "ability",
    controller: userId,
    cardId: null,
    source: found.card.id,
    sourceName: def.name,
    text: search ? `Durchsucht die Bibliothek nach einem ${search === "basic land" ? "Basic Land" : "Land"} und legt es auf die Hand.` : "Du ziehst 1 Karte.",
    effects,
    specs: [],
    targets: [],
    unparsed: []
  });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} spielt Cycling: ${def.name} wird abgeworfen.`);
  return ok();
}

function activateAction(game, userId, action) {
  const player = game.players[userId];
  if (!hasWindow(game, userId)) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  if (!found || found.zone !== "battlefield") return fail("Die Karte muss auf deinem Schlachtfeld liegen.");
  const card = found.card;
  const def = defOf(game, card);
  const ability = def.rules?.activated?.[action.index];
  if (!ability) return fail("Diese Fähigkeit gibt es nicht.");
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  if (ability.sorcery && !mainPhase) return fail("Diese Fähigkeit geht nur in deiner Hauptphase bei leerem Stapel.");
  if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");
  if (ability.cost.tap && (card.tapped || isSick(game, card))) return fail(card.tapped ? "Die Karte ist bereits getappt." : "Diese Kreatur ist noch beschwörungsmüde.");
  if (ability.cost.loyalty !== undefined) {
    if (card.loyaltyTurn === game.turn.number) return fail("Pro Zug darf nur eine Loyalitätsfähigkeit je Planeswalker benutzt werden.");
    if ((card.counters.loyalty ?? 0) + ability.cost.loyalty < 0) return fail("Nicht genug Loyalität.");
  }
  if (ability.specs.length > 0 && !targetsLegal(game, ability.specs, action.targets, userId, colorsOfDef(def))) return fail("Wähle gültige Ziele für diese Fähigkeit.");

  const abilityWard = ability.specs.length > 0 ? wardExtra(game, userId, action.targets) : "";
  const abilityMana = (ability.cost.mana ?? "") + abilityWard;
  if (abilityMana) {
    const sources = chosenSources(manaSources(game, userId).filter(source => source.id !== card.id), action);
    const plan = planPayment({ manaCost: abilityMana, pool: player.pool, sources });
    if (!plan.ok) return fail(`Nicht genug Mana für ${describeCost(abilityMana)}${abilityWard ? " (inkl. Ward)" : ""}.`);
    for (const id of plan.tap) game.cards[id].tapped = true;
    for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
    for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  }
  if (ability.cost.tap) card.tapped = true;
  if (ability.cost.sacrifice) {
    addLog(game, `${player.name} opfert ${def.name}.`);
    toGraveyard(game, card);
  }
  if (ability.cost.loyalty !== undefined) {
    card.counters.loyalty = (card.counters.loyalty ?? 0) + ability.cost.loyalty;
    card.loyaltyTurn = game.turn.number;
  }
  game.stack.push({
    sid: newId(game, "s"),
    kind: "ability",
    controller: userId,
    cardId: null,
    source: card.id,
    sourceName: def.name,
    text: ability.summary || ability.text,
    effects: ability.effects,
    specs: ability.specs,
    targets: ability.specs.length > 0 ? action.targets : [],
    unparsed: ability.unparsed
  });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} aktiviert ${def.name}: ${ability.summary || ability.text.replace(/~/g, def.name)}`);
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
    const walker = game.cards[target];
    const walkerOk = walker && onBattlefield(game, target) && defOf(game, walker).types.planeswalker && opponents.includes(walker.owner);
    if (!opponents.includes(target) && !walkerOk) return fail("Wähle für jeden Angreifer einen Gegner oder einen gegnerischen Planeswalker.");
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
    fireTriggers(game, card, "attacks");
  }
  game.combat = { attackers, blocks: [], done: [], phaseWaiting: true };
  game.turn.phase = "blockers";
  game.priority = null;
  game.passed = [];
  addLog(
    game,
    `${game.players[userId].name} greift an: ${attackers.map(a => `${nameOf(game, a.id)} → ${game.players[a.target]?.name ?? nameOf(game, a.target)}`).join(", ")}.`
  );
  settleCombatWaiting(game);
  return ok();
}

function declareBlockersAction(game, userId, action) {
  const combat = game.combat;
  if (!combat || !combat.phaseWaiting || game.turn.phase !== "blockers") return fail("Es werden gerade keine Blocker bestimmt.");
  if (game.stack.length > 0) return fail("Der Stapel muss zuerst aufgelöst werden.");
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
    const attacker = combat.attackers.find(a => a.id === entry.attacker && attackTargetOwner(game, a.target) === userId);
    if (!attacker) return fail("Du kannst nur Angreifer blocken, die dich angreifen.");
    const acard = game.cards[attacker.id];
    const why = cannotBlockReason(game, acard, blocker);
    if (why) return fail(`${bdef.name} kann ${nameOf(game, acard.id)} nicht blocken (${why}).`);
    chosen.push({ blocker: entry.blocker, attacker: entry.attacker });
  }
  for (const attacker of combat.attackers.filter(a => attackTargetOwner(game, a.target) === userId)) {
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
  game.turn.beganAt = Date.now();
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

/**
 * Selbstheilung: Wartet niemand auf eine Auswahl oder einen Kartentext und hat trotzdem kein lebender Spieler die Priorität,
 * bekommt der aktive Spieler sie. So kann der Zustand „alle warten auf alle“ nicht entstehen.
 */
export function repairGame(game) {
  if (game.phase !== "playing") return false;
  if (game.choice || game.manual || game.pendingDiscard || game.combat?.phaseWaiting) return false;
  const holder = game.priority ? game.players[game.priority] : null;
  if (holder && !holder.eliminated) return false;
  const active = game.turn.active && !game.players[game.turn.active]?.eliminated ? game.turn.active : alive(game)[0];
  if (!active) return false;
  game.priority = active;
  game.passed = [];
  addLog(game, "Der Spielzustand wurde korrigiert.");
  return true;
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

/** Hilfsfunktionen für den Bot (nur lesend). */
export const _internals = { defOf, powerOf, toughnessOf, hasKeyword, onBattlefield, alive, cannotBlockReason, attackTargetOwner };
