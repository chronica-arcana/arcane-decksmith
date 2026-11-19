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

const stationDefs = new WeakMap();
/** Raumschiff mit genug Ladungsmarkern: Artefaktkreatur (gleiche Definition, nur mit Kreaturentyp). */
function stationCreature(base) {
  let creature = stationDefs.get(base);
  if (!creature) {
    creature = { ...base, typeLine: /Creature/.test(base.typeLine ?? "") ? base.typeLine : `${base.typeLine}${base.typeLine ? " " : ""}Creature`, types: { ...base.types, creature: true } };
    stationDefs.set(base, creature);
  }
  return creature;
}
const defOf = (game, card) => {
  const base = game.xdefs[card.def] ?? game.defs[card.def];
  const station = base?.rules?.station;
  return station?.at && (card.counters?.charge ?? 0) >= station.at ? stationCreature(base) : base;
};
/** Auslöser/Dauereffekte/Fähigkeiten einer Raumschiff-Stufe („N+ | …“) wirken erst ab N Ladungsmarkern. */
const tierOn = (card, item) => !item.minCharge || (card.counters?.charge ?? 0) >= item.minCharge;
const nameOf = (game, id) => defOf(game, game.cards[id])?.name ?? "Karte";
/** Untertypen aus der Typzeile („Legendary Creature — Vampire Knight“ → ["vampire", "knight"]). */
const subtypesOf = def => String(def.typeLine ?? "").split("—")[1]?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
/** Passt der (ggf. pluralisierte) Untertyp „Knights“/„Elves“ auf die Karte? */
function hasSubtype(def, word) {
  if (def.rules?.changeling && def.types?.creature) return true;
  const types = subtypesOf(def);
  const w = word.toLowerCase();
  return [w, w.replace(/s$/, ""), w.replace(/ves$/, "f"), w.replace(/ves$/, "fe"), w.replace(/ies$/, "y"), w.replace(/men$/, "man")].some(candidate => types.includes(candidate));
}

let staticDepth = 0;
/** Dauereffekte wie „Creatures you control get +1/+1“ (Boni und Schlüsselwörter), die auf diese Karte wirken. */
function staticEffects(game, card) {
  const result = { p: 0, th: 0, grants: [], revokes: [] };
  if (!defOf(game, card).types.creature || !onBattlefield(game, card.id)) return result;
  for (const userId of game.seats) {
    for (const id of game.players[userId].battlefield) {
      const source = game.cards[id];
      for (const effect of defOf(game, source).rules?.statics ?? []) {
        if (!tierOn(source, { minCharge: effect.minCharge })) continue;
        const applies =
          effect.scope === "self" ? source.id === card.id
          : effect.scope === "you" ? source.owner === card.owner
          : effect.scope === "youOther" ? source.owner === card.owner && source.id !== card.id
          : effect.scope === "opp" ? source.owner !== card.owner
          : true;
        if (!applies) continue;
        if (effect.tokenOnly && !card.token) continue;
        if (effect.duringYourTurn && game.turn.active !== source.owner) continue;
        if (effect.anyOf && !effect.anyOf.some(word => (word in defOf(game, card).types ? defOf(game, card).types[word] : hasSubtype(defOf(game, card), word)))) continue;
        if (effect.counter && !(effect.counter === "any" ? Object.values(card.counters).some(value => value > 0) : card.counters[effect.counter] > 0)) continue;
        if (effect.colors && !colorsOfCard(game, card).some(color => effect.colors.includes(color))) continue;
        if (effect.subtype && ["artifact", "enchantment", "legendary"].includes(effect.subtype.replace(/s$/, ""))) {
          if (!defOf(game, card).types[effect.subtype.replace(/s$/, "")]) continue;
        } else if (effect.subtype && !hasSubtype(defOf(game, card), effect.subtype)) continue;
        if (effect.chosen && !(source.chosenType && hasSubtype(defOf(game, card), source.chosenType))) continue;
        if (effect.spec) {
          // Filter mit Schlüsselwort („creatures with flying get +1/+1“) fragt Dauereffekte ab: Rekursion sperren
          const needsKeywords = Boolean(effect.spec.keyword || effect.spec.noKeyword);
          if (needsKeywords && staticDepth > 0) continue;
          if (needsKeywords) staticDepth += 1;
          let fits;
          try {
            fits = passesSpecFilter(game, card.id, effect.spec, source.owner, source);
          } finally {
            if (needsKeywords) staticDepth -= 1;
          }
          if (!fits) continue;
        }
        result.p += effect.p;
        result.th += effect.th;
        if (effect.perQ && staticDepth === 0) {
          // „gets +1/+1 for each …“: zählt mit gesperrter Rekursion (Zählfilter können Stärke abfragen)
          staticDepth += 1;
          try {
            const n = evalQuantity(game, { controller: source.owner, source: source.id, targets: [] }, effect.perQ.q);
            result.p += effect.perQ.p * n;
            result.th += effect.perQ.th * n;
          } finally {
            staticDepth -= 1;
          }
        }
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
      if (attach) {
        result.p += attach.p;
        result.th += attach.th;
        if (attach.perQ) {
          const n = evalQuantity(game, { controller: source.owner, source: source.id, targets: [] }, attach.perQ.q);
          result.p += attach.perQ.p * n;
          result.th += attach.perQ.th * n;
        }
        result.grants.push(...attach.grants);
        result.revokes.push(...(attach.revokes ?? []));
      }
      const per = defOf(game, source).rules?.attachPer;
      if (per) {
        const n = perCount(game, { controller: source.owner }, per.per);
        result.p += per.p * n;
        result.th += per.th * n;
      }
      const conditional = defOf(game, source).rules?.attachLegendary;
      if (conditional && defOf(game, card).types.legendary) {
        result.p += conditional.p;
        result.th += conditional.th;
        result.grants.push(...conditional.grants);
        result.revokes.push(...conditional.revokes);
      }
    }
  }
  return result;
}
const KEYWORD_COUNTERS = new Set(["flying", "first strike", "double strike", "deathtouch", "haste", "hexproof", "indestructible", "lifelink", "menace", "reach", "trample", "vigilance"]);
let conditionDepth = 0; // Sperre: bedingte Schlüsselwörter prüfen keine bedingten Schlüsselwörter anderer Karten
const condGrantsOf = (game, card, def) => {
  if (!def.rules?.condGrants || conditionDepth > 0 || !onBattlefield(game, card.id)) return [];
  conditionDepth += 1;
  try {
    return def.rules.condGrants.filter(item => evalCondition(game, { controller: card.owner, source: card.id, targets: [] }, item.cond)).flatMap(item => item.kws);
  } finally {
    conditionDepth -= 1;
  }
};
const keywordsOfCard = (game, card) => {
  const def = defOf(game, card);
  const condGrants = condGrantsOf(game, card, def);
  const base = [...(def.keywords ?? []), ...condGrants, ...(def.rules?.selfGrants ?? []), ...(def.rules?.selfGrantsYourTurn && game.turn?.active === card.owner ? def.rules.selfGrantsYourTurn : []), ...(def.rules?.tiers ?? []).filter(tier => tierOn(card, { minCharge: tier.n })).flatMap(tier => tier.kws)];
  const effects = staticEffects(game, card);
  const counterKeywords = Object.keys(card.counters ?? {}).filter(kind => card.counters[kind] > 0 && KEYWORD_COUNTERS.has(kind));
  const goaded = (card.goadedBy ?? []).length > 0 ? ["must-attack", "goaded"] : [];
  const grants = [...effects.grants, ...(card.tk ?? []), ...counterKeywords, ...goaded];
  const all = grants.length > 0 ? [...base, ...grants] : base;
  return effects.revokes.length > 0 ? all.filter(keyword => !effects.revokes.includes(keyword)) : all;
};
const hasKeyword = (game, card, keyword) => keywordsOfCard(game, card).includes(keyword);

/** Farben einer Karte aus den Manasymbolen der Kosten (Spielsteine: farblos). */
const colorsOfDef = def => (def?.rules?.devoid ? [] : [...new Set(String(def?.manaCost ?? "").match(/[WUBRG]/g) ?? [])]);
const colorsOfCard = (game, card) => colorsOfDef(defOf(game, card));
/** Hat das Ziel Schutz vor den Farben der Quelle? */
/** Quelle eines Zaubers/einer Fähigkeit: Farben (für Schutz) und Karten-ID („another target“). */
const srcOfDef = (def, id) => ({ colors: colorsOfDef(def), id });
const srcOfCard = (game, card) => srcOfDef(defOf(game, card), card.id);
const protectedFrom = (game, card, sourceColors) => {
  const protection = [...(defOf(game, card).rules?.protection ?? [])];
  for (const id of game.players[card.owner]?.battlefield ?? []) {
    const other = game.cards[id];
    if (other?.attachedTo === card.id) protection.push(...(defOf(game, other).rules?.attach?.protection ?? []));
  }
  return sourceColors.some(color => protection.includes(color));
};

/** „Do this only once each turn“: höchstens einmal je Zug und Karte. */
function onceAllowed(game, source, trigger) {
  if (!trigger.effects?.some(effect => effect.type === "onceTurn")) return true;
  const key = `${source.id}|${trigger.text}`;
  game.onceUsed = game.onceUsed ?? {};
  if (game.onceUsed[key] === game.turn.number) return false;
  game.onceUsed[key] = game.turn.number;
  return true;
}

/** Karten, auf die sich „it/they/that token“ beziehen: zuletzt erzeugte Spielsteine oder zuletzt übernommene Karte. */
function lastCards(ctx) {
  if ((ctx.madeTokens ?? []).length > 0) return ctx.madeTokens;
  if (ctx.lastControlled) return [ctx.lastControlled];
  if (ctx.subjectCard) return [ctx.subjectCard]; // „Whenever a creature … enters, it gains haste“
  return [];
}

/** „Whenever you put one or more counters on a creature“ und „whenever a +1/+1 counter is put on ~“. */
function fireCountersPut(game, card, kind) {
  if (game.phase !== "playing") return;
  card.lastCounterKind = kind;
  game.turn.counterPut = { ...(game.turn.counterPut ?? {}), [card.owner]: game.turn.number };
  fireGlobal(game, "countersPut", card);
  if (kind === "+1/+1") fireTriggers(game, card, "selfCounter");
}

/** Ersatzeffekte wie Hardened Scales: „that many plus one +1/+1 counters“ für Kreaturen des Kontrolleurs. */
function counterAmount(game, card, kind, n) {
  if (kind !== "+1/+1" || n <= 0) return n;
  let bonus = 0;
  for (const id of game.players[card.owner]?.battlefield ?? []) bonus += defOf(game, game.cards[id]).rules?.counterBonus ?? 0;
  return n + bonus;
}

const counterOf = (card, kind) => card.counters[kind] ?? 0;
const bonus = card => counterOf(card, "+1/+1") - counterOf(card, "-1/-1");
const dynamicBase = (game, card, toughness = false) => {
  const rule = defOf(game, card).rules?.dynamicPT;
  if (toughness && rule?.powerOnly) return 0;
  return rule ? perCount(game, { controller: card.owner, source: card.id }, rule.per) * (rule.mult ?? 1) : 0;
};
const powerOf = (game, card) => (defOf(game, card).power ?? 0) + dynamicBase(game, card) + bonus(card) + (card.tp ?? 0) + staticEffects(game, card).p;
const toughnessOf = (game, card) => (defOf(game, card).toughness ?? 0) + dynamicBase(game, card, true) + bonus(card) + (card.tt ?? 0) + staticEffects(game, card).th;

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
    autoStart: false, // Karten ziehst du standardmäßig per Klick auf die Bibliothek
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
    if (game.phase === "playing") {
      if (player.drawTurn !== game.turn?.number) {
        player.drawTurn = game.turn?.number;
        player.drawsThisTurn = 0;
      }
      player.drawsThisTurn += 1;
      if (player.drawsThisTurn === 2) fireGlobal(game, "youDrawSecond", userId);
      fireGlobal(game, "youDraw", userId);
      fireGlobal(game, "oppDraw", userId);
    }
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
  card.goadedBy = [];
  card.owner = card.origOwner ?? card.owner;
  card.stolenUntilEot = false;
  card.chosenType = null;
  card.chosenColor = null;
  card.foretoldTurn = undefined;
  card.playUntil = undefined;
  card.playBy = undefined;
  if (card.cloneOf) {
    card.def = card.cloneOf; // eine Kopie ist außerhalb des Schlachtfelds wieder die Karte selbst
    delete card.cloneOf;
  }
  delete card.freeCast;
}

function enterBattlefield(game, card) {
  card.sinceSeq = tick(game);
  const def = defOf(game, card);
  if (def.types.planeswalker && def.loyalty) card.counters.loyalty = def.loyalty;
  if (def.rules?.entersWithCounters) {
    const rule = def.rules.entersWithCounters;
    const n = rule.n === "X" ? card.enterX ?? 0 : rule.n;
    if (n > 0) card.counters[rule.kind] = (card.counters[rule.kind] ?? 0) + counterAmount(game, card, rule.kind, n);
  }
  if (def.types.creature && game.seats.some(userId => userId !== card.owner && game.players[userId].battlefield.some(id => defOf(game, game.cards[id]).rules?.oppEnterTapped))) card.tapped = true;
  if (def.rules?.entersTapped) card.tapped = true;
  else if (def.rules?.entersTappedUnless && !entryConditionMet(game, card, def.rules.entersTappedUnless)) card.tapped = true;
  else if (def.rules?.shock) game.triggerQueue.push({ kind: "entry", entry: "shock", cardId: card.id, controller: card.owner, life: def.rules.shock.life });
  else if (def.rules?.reveal) game.triggerQueue.push({ kind: "entry", entry: "reveal", cardId: card.id, controller: card.owner, types: def.rules.reveal.types });
  if (def.rules?.chooseType) game.triggerQueue.push({ kind: "entry", entry: "chooseType", cardId: card.id, controller: card.owner });
  if (def.rules?.cloneOnEnter && game.phase === "playing") {
    card.pendingClone = true;
    game.triggerQueue.push({ kind: "entry", entry: "clone", cardId: card.id, controller: card.owner });
  }
  if (def.rules?.chooseColor) game.triggerQueue.push({ kind: "entry", entry: "chooseColor", cardId: card.id, controller: card.owner, except: def.rules.chooseColor.except });
  if (game.phase === "playing") fireGlobal(game, "permanentEnters", card);
  if (def.types.creature) {
    for (const id of game.players[card.owner].battlefield) {
      const bonus = defOf(game, game.cards[id]).rules?.etbBonus;
      if (!bonus || id === card.id || (bonus.nontoken && card.token)) continue;
      card.counters[bonus.kind] = (card.counters[bonus.kind] ?? 0) + 1;
    }
  }
  fireTriggers(game, card, "etb");
  if (def.rules?.saga) addLore(game, card);
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
  if (condition.kind === "oppCount") return alive(game).filter(id => id !== card.owner).length >= condition.n;
  if (condition.kind === "oppLands") {
    return game.seats.filter(id => id !== card.owner).reduce((sum, id) => sum + game.players[id].battlefield.filter(cardId => defOf(game, game.cards[cardId]).types.land).length, 0) >= condition.n;
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

/** Manaoptionen einer Karte (bei „Thriving“-Ländern kommt die gewählte Farbe dazu). */
function effectiveMana(game, card) {
  const def = defOf(game, card);
  // „Lands you control have ‚{T}: Add one mana of any color.‘“ (Chromatic Lantern)
  if (def.types.land && game.players[card.owner].battlefield.some(id => defOf(game, game.cards[id]).rules?.landsAnyColor)) return [["W", "U", "B", "R", "G"]];
  if (!def.mana) return null;
  if (def.rules?.chooseColor && card.chosenColor) return def.mana.map(unit => (unit.includes(card.chosenColor) ? unit : [...unit, card.chosenColor]));
  return def.mana;
}

function manaSources(game, userId) {
  const sources = [];
  for (const id of game.players[userId].battlefield) {
    const card = game.cards[id];
    const def = defOf(game, card);
    const units = effectiveMana(game, card);
    if (!units || card.tapped || card.faceDown || isSick(game, card)) continue;
    const cond = def.rules?.manaCond;
    if (cond) {
      const mine = game.players[userId].battlefield.map(cardId => game.cards[cardId]);
      const ok = cond.type === "artifact" ? mine.some(c => defOf(game, c).types.artifact) : mine.some(c => defOf(game, c).types.creature && powerOf(game, c) >= 4);
      if (!ok) continue;
    }
    sources.push({ id, units });
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
/** Karten, die „bis diese Karte das Spiel verlässt“ im Exil lagen, kommen zurück aufs Schlachtfeld (Oblivion Ring). */
function releaseExiled(game, card) {
  const ids = card.exiledIds ?? [];
  card.exiledIds = [];
  for (const id of ids) {
    const back = game.cards[id];
    if (!back) continue;
    const owner = game.players[back.origOwner ?? back.owner];
    const index = owner.exile.indexOf(id);
    if (index === -1 || owner.eliminated) continue;
    owner.exile.splice(index, 1);
    owner.battlefield.push(id);
    back.owner = owner === game.players[back.owner] ? back.owner : back.origOwner ?? back.owner;
    enterBattlefield(game, back);
    addLog(game, `${nameOf(game, id)} kehrt aus dem Exil aufs Schlachtfeld zurück (${nameOf(game, card.id)} hat das Spiel verlassen).`);
  }
}

/** Zusammengesetzte Definition einer mutierten Kreatur: Eigenschaften der obersten Karte, Fähigkeiten aller Karten. */
function mergedDef(game, parts) {
  const defs = parts.map(part => game.xdefs[part.def] ?? game.defs[part.def]);
  const top = defs[0];
  const rules = { ...top.rules, triggers: [], activated: [], statics: [], notes: [], selfGrants: [], tiers: [] };
  for (const item of defs) {
    rules.triggers.push(...(item.rules?.triggers ?? []));
    rules.statics.push(...(item.rules?.statics ?? []));
    rules.notes.push(...(item.rules?.notes ?? []));
    rules.selfGrants.push(...(item.rules?.selfGrants ?? []));
    rules.activated.push(...(item.rules?.activated ?? []));
  }
  rules.activated = rules.activated.map((ability, index) => ({ ...ability, index }));
  return { ...top, rules, keywords: [...new Set(defs.flatMap(item => item.keywords ?? []))] };
}

/** Mutate: Die zaubernde Karte wird über oder unter die Kreatur gelegt, beide sind eine Kreatur. */
function mutateInto(game, spellCard, host, over) {
  const hostParts = host.mutStack ?? [{ id: host.id, def: host.def }];
  const parts = over ? [{ id: spellCard.id, def: spellCard.def }, ...hostParts] : [...hostParts, { id: spellCard.id, def: spellCard.def }];
  const key = `mut:${host.id}`;
  host.mutStack = parts;
  game.xdefs[key] = mergedDef(game, parts);
  host.def = key;
  addLog(game, `${nameOf(game, spellCard.id)} mutiert ${over ? "über" : "unter"} die Kreatur und bildet ${game.xdefs[key].name}.`);
  fireTriggers(game, host, "mutates");
}

/** Verlässt eine mutierte Kreatur das Spielfeld, wird sie in ihre Einzelkarten zerlegt. Gibt die übrigen Karten zurück. */
function splitMutated(game, card) {
  if (!card.mutStack) return [];
  const own = card.mutStack.find(part => part.id === card.id);
  const others = card.mutStack.filter(part => part.id !== card.id).map(part => part.id);
  delete game.xdefs[`mut:${card.id}`];
  if (own) card.def = own.def;
  card.mutStack = undefined;
  return others;
}

function placeParts(game, ids, zone) {
  for (const id of ids) {
    const part = game.cards[id];
    if (!part) continue;
    resetCardState(part);
    game.players[part.origOwner ?? part.owner][zone].push(id);
  }
}

/** Eigene Kreaturen, auf die ein Mutate-Zauber zielen darf (keine Menschen). */
const mutateTargets = (game, userId) => game.players[userId].battlefield.filter(id => {
  const def = defOf(game, game.cards[id]);
  return def.types.creature && !hasSubtype(def, "Human") && (game.cards[id].origOwner ?? game.cards[id].owner) === userId;
});

/** „Whenever you sacrifice a <Typ>“: vor dem Opfern melden (die Karte ist dann noch bekannt). */
function noteSacrifice(game, card) {
  if (game.phase === "playing" && card) fireGlobal(game, "youSacrifice", card);
}

/** „Whenever you discard (or cycle) a card“: ein Auslöser je abgeworfener Karte. */
function fireDiscards(game, ids) {
  if (game.phase !== "playing") return;
  // Madness: die abgeworfene Karte geht ins Exil; ihr Besitzer darf sie für die Madness-Kosten wirken
  for (const id of ids) {
    const card = game.cards[id];
    const madness = card ? defOf(game, card).rules?.madness : null;
    const owner = card ? game.players[card.owner] : null;
    if (!madness || !owner || !owner.graveyard.includes(id) || (defOf(game, card).rules?.spell?.specs?.length ?? 0) > 0) continue;
    owner.graveyard.splice(owner.graveyard.indexOf(id), 1);
    owner.exile.push(id);
    game.triggerQueue.push({ kind: "madness", cardId: id, controller: card.owner });
    addLog(game, `${nameOf(game, id)} wird mit Madness abgeworfen (Exil).`);
  }
  for (const id of ids) if (game.cards[id]) fireGlobal(game, "youDiscard", game.cards[id]);
}

function toGraveyard(game, card, from = "battlefield") {
  const holder = game.players[card.owner]; // Kontrolleur (liegt dort auf dem Feld)
  const owner = game.players[card.origOwner ?? card.owner]; // Besitzer (dort landet die Karte)
  if (from === "battlefield") {
    releaseExiled(game, card);
    for (const other of Object.values(game.cards)) {
      if (other.attachedTo !== card.id || !onBattlefield(game, other.id)) continue;
      for (const trigger of defOf(game, other).rules?.triggers ?? []) {
        if (trigger.event === "equippedDies") game.triggerQueue.push({ controller: other.owner, source: other.id, sourceName: defOf(game, other).name, trigger });
      }
    }
    fireTriggers(game, card, "dies");
    if (defOf(game, card).types.creature) fireGlobal(game, "creatureDies", card);
  }
  const parts = from === "battlefield" ? splitMutated(game, card) : [];
  for (const zone of ZONES) {
    const index = holder[zone].indexOf(card.id);
    if (index !== -1) holder[zone].splice(index, 1);
  }
  if (card.token) {
    delete game.cards[card.id];
    placeParts(game, parts, "graveyard");
    return;
  }
  placeParts(game, parts, "graveyard");
  card.lastCounters = { ...card.counters };
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
  game.turn.attackedWith = 0;
  game.turn.attackedOpponents = {};
  game.turn.extraLands = 0;
  game.turn.manualStart = player.autoStart === false && !skipDraw;
  player.turnsTaken = (player.turnsTaken ?? 0) + 1;
  game.combat = null;
  game.pendingDiscard = null;
  player.turnStartSeq = tick(game);
  // Goad endet, wenn der nächste Zug des aufstachelnden Spielers beginnt
  for (const card of Object.values(game.cards)) if (card.goadedBy?.includes(userId)) card.goadedBy = card.goadedBy.filter(id => id !== userId);
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
    beginMain1(game);
  } else if (player.autoStart === false) {
    // Karte ziehen: durch Anklicken der Bibliothek (danach geht es automatisch weiter).
    game.turn.phase = "draw";
  } else {
    game.turn.phase = "main1";
    const drawn = drawCards(game, userId, 1);
    game.turn.drew = drawn > 0;
    addLog(game, drawn ? `${player.name} zieht eine Karte.` : `${player.name} kann keine Karte ziehen (Bibliothek leer).`);
    beginMain1(game);
  }
}

/** Kontrolle über eine Karte übernehmen (bis zum Zugende oder dauerhaft). Beschwörungsmüdigkeit gilt für den neuen Kontrolleur. */
/** Ward: Wählt ein Spieler eine gegnerische Karte mit Ward als Ziel, kostet das zusätzlich (hier gleich beim Wirken bezahlt). */
/** Zusätzliche Kosten (Karten opfern oder abwerfen, Leben zahlen): was der Spieler wählen müsste. */
function payRequirements(game, userId, extras, selfId) {
  const player = game.players[userId];
  return (extras ?? []).map(extra => {
    if (extra.kind === "life" || extra.kind === "removeCounter" || extra.kind === "energy") return { ...extra, options: [] };
    if (extra.kind === "discard") return { ...extra, options: player.hand.filter(id => id !== selfId) };
    if (extra.kind === "removeAnyCounter") {
      return { ...extra, options: player.battlefield.filter(id => Object.values(game.cards[id].counters).some(value => value > 0) && !(extra.nonland && defOf(game, game.cards[id]).types.land)) };
    }
    const options = player.battlefield.filter(id => {
      if (extra.other && id === selfId) return false;
      const card = game.cards[id];
      if (extra.kind === "tap" && card.tapped) return false;
      const def = defOf(game, card);
      if (extra.artifactCreature) return def.types.artifact && def.types.creature;
      if (extra.nontoken && card.token) return false;
      if (extra.spec) return (extra.spec.kind === "permanent" || def.types[extra.spec.kind === "myCreature" ? "creature" : extra.spec.kind]) && passesSpecFilter(game, id, extra.spec, userId, { id: selfId });
      const types = def.types;
      return extra.what === "permanent" ? true : extra.what === "nonland" ? !types.land : types[extra.what] ?? hasSubtype(def, extra.what);
    });
    return { ...extra, options };
  });
}

const canPayExtras = (game, userId, extras, selfId) =>
  payRequirements(game, userId, extras, selfId).every(item => {
    if (item.kind === "life") return game.players[userId].life >= (item.n === "X" ? 0 : item.n); // Leben bis auf 0 zahlen ist erlaubt
    if (item.kind === "energy") return game.players[userId].energy >= item.n;
    if (item.kind === "removeCounter") return item.counter === "any" ? Object.values(game.cards[selfId]?.counters ?? {}).reduce((a, b) => a + b, 0) >= item.n : (game.cards[selfId]?.counters[item.counter] ?? 0) >= item.n;
    return item.options.length >= item.n;
  });

/** Prüft die gewählten Karten für zusätzliche Kosten. Rückgabe: `{ picks }` oder `{ error }`. */
function resolvePay(game, userId, extras, pay, selfId) {
  const picks = [];
  const chosen = Array.isArray(pay) ? pay.filter(id => typeof id === "string") : [];
  let cursor = 0;
  for (const item of payRequirements(game, userId, extras, selfId)) {
    if (item.kind === "life") {
      if (game.players[userId].life < item.n) return { error: `Du hast nicht genug Leben (${item.n} zu zahlen).` };
      picks.push({ item, ids: [] });
      continue;
    }
    if (item.kind === "energy") {
      if (game.players[userId].energy < item.n) return { error: `Du hast nicht genug Energie (${item.n} zu zahlen).` };
      picks.push({ item, ids: [] });
      continue;
    }
    if (item.kind === "removeCounter") {
      const have = item.counter === "any" ? Object.values(game.cards[selfId]?.counters ?? {}).reduce((a, b) => a + b, 0) : game.cards[selfId]?.counters[item.counter] ?? 0;
      if (have < item.n) return { error: `Es ist kein ${item.counter}-Marker mehr auf der Karte.` };
      picks.push({ item, ids: [] });
      continue;
    }
    const ids = chosen.slice(cursor, cursor + item.n);
    cursor += item.n;
    if (ids.length !== item.n || new Set(ids).size !== ids.length || ids.some(id => !item.options.includes(id))) {
      return { error: item.kind === "discard" ? `Wähle ${item.n} Karte${item.n === 1 ? "" : "n"} zum Abwerfen.` : `Wähle ${item.n} Karte${item.n === 1 ? "" : "n"} zum Opfern.` };
    }
    picks.push({ item, ids });
  }
  return { picks };
}

function applyPay(game, userId, picks, name, selfId) {
  const player = game.players[userId];
  for (const { item, ids } of picks) {
    if (item.kind === "life") {
      player.life -= item.n;
      pushFx(game, { type: "damage", player: userId, amount: item.n });
      addLog(game, `${player.name} zahlt ${item.n} Leben (${name}).`);
    } else if (item.kind === "removeAnyCounter") {
      for (const id of ids) {
        const card = game.cards[id];
        const kinds = Object.keys(card?.counters ?? {}).filter(kind => card.counters[kind] > 0);
        const kind = kinds.find(k => k !== "+1/+1") ?? kinds[0];
        if (!kind) continue;
        card.counters[kind] -= 1;
        if (card.counters[kind] <= 0) delete card.counters[kind];
        addLog(game, `${player.name} entfernt einen ${kind}-Marker von ${nameOf(game, id)} (${name}).`);
      }
    } else if (item.kind === "energy") {
      player.energy -= item.n;
      addLog(game, `${player.name} zahlt ${item.n} Energie (${name}).`);
    } else if (item.kind === "removeCounter") {
      const card = game.cards[selfId];
      if (card && item.counter === "any") {
        const kind = Object.keys(card.counters).find(k => card.counters[k] > 0);
        if (kind) {
          card.counters[kind] -= item.n;
          if (card.counters[kind] <= 0) delete card.counters[kind];
        }
      } else if (card) {
        card.counters[item.counter] -= item.n;
        if (card.counters[item.counter] <= 0) delete card.counters[item.counter];
      }
    } else if (item.kind === "tap") {
      for (const id of ids) game.cards[id].tapped = true;
      addLog(game, `${player.name} tappt: ${ids.map(id => nameOf(game, id)).join(", ")} (${name}).`);
    } else if (item.kind === "discard") {
      for (const id of ids) {
        player.hand.splice(player.hand.indexOf(id), 1);
        player.graveyard.push(id);
      }
      addLog(game, `${player.name} wirft ab: ${ids.map(id => nameOf(game, id)).join(", ")} (${name}).`);
    } else {
      for (const id of ids) {
        if (game.cards[id] && onBattlefield(game, id)) {
          addLog(game, `${player.name} opfert ${nameOf(game, id)} (${name}).`);
          noteSacrifice(game, game.cards[id]);
          toGraveyard(game, game.cards[id]);
        }
      }
    }
  }
}

/** Darf die Karte aus dem Exil gespielt werden („you may play that card this turn“)? */
/** „You may cast … without paying its mana cost“: Erlaubnis für diesen Zug (Friedhof, Exil oder Hand). */
const freeCastOk = (game, userId, card, zone) => Boolean(card.freeCast && card.freeCast.by === userId && card.freeCast.turn === game.turn.number && ["graveyard", "exile", "hand"].includes(zone));
const impulseOk = (game, userId, card, zone) => zone === "exile" && card.playBy === userId && (card.playUntil ?? -1) >= game.turn.number;
/** „You may play lands from your graveyard.“ */
const landsFromGraveyard = (game, userId) => game.players[userId].battlefield.some(id => defOf(game, game.cards[id]).rules?.landsFromGraveyard);
/** „Your opponents can't cast spells during your turn.“ */
const castLocked = (game, userId) => game.turn.active !== userId && game.players[game.turn.active]?.battlefield.some(id => defOf(game, game.cards[id]).rules?.noOppCastOnMyTurn);

/** „If you control a commander, you may cast ~ without paying its mana cost.“ */
const hasFreeCast = (game, userId, def) => Boolean(def.rules?.freeWithCommander) && game.players[userId].battlefield.some(id => game.cards[id].cmd);

/** Kostenverringerung wie „costs {1} less for each creature on the battlefield“ (in Mana). */
function costReduction(game, def, userId) {
  let total = 0;
  const rule = def.rules?.costReduction;
  if (rule) {
    const owners = rule.mine && userId ? [userId] : game.seats;
    const matches = cardId => {
      const other = defOf(game, game.cards[cardId]);
      return rule.per in other.types ? other.types[rule.per] : hasSubtype(other, rule.per);
    };
    const count = owners.reduce((sum, id) => sum + game.players[id].battlefield.filter(matches).length, 0);
    total += rule.amount * count;
  }
  if (def.rules?.condCost && userId && evalCondition(game, { controller: userId, source: null, targets: [] }, def.rules.condCost.cond)) total += def.rules.condCost.amount;
  // Dauerhafte Kostenverringerung anderer Permanents („Artifact spells you cast cost {1} less“)
  if (userId) {
    for (const id of game.players[userId].battlefield) {
      const mod = defOf(game, game.cards[id]).rules?.costMod;
      if (!mod) continue;
      const types = def.types;
      const matches = mod.anyOf ? mod.anyOf.some(word => hasSubtype(def, word)) : mod.what === "noncreature" ? !types.creature && !types.land : mod.what === "instant and sorcery" ? types.instant || types.sorcery : mod.what in types ? types[mod.what] : hasSubtype(def, mod.what);
      if (matches) total += mod.amount;
    }
  }
  return total;
}

/** Zahlung mit Hilfsmitteln: Delve (Friedhofskarten exilieren) und Convoke (Kreaturen tappen) ersetzen bei Bedarf generisches Mana. */
function planWithAlternatives(game, userId, def, args) {
  const first = planPayment(args);
  if (first.ok) return { plan: first, delve: [], convoke: [] };
  const player = game.players[userId];
  const delveCards = def.rules?.delve ? [...player.graveyard] : [];
  const convokeCards = def.rules?.convoke
    ? player.battlefield.filter(id => defOf(game, game.cards[id]).types.creature && !game.cards[id].tapped).sort((a, b) => powerOf(game, game.cards[a]) - powerOf(game, game.cards[b]))
    : [];
  for (let k = 1; k <= delveCards.length + convokeCards.length; k += 1) {
    const d = Math.min(k, delveCards.length);
    const plan = planPayment({ ...args, extraGeneric: (args.extraGeneric ?? 0) - k });
    if (plan.ok) return { plan, delve: delveCards.slice(0, d), convoke: convokeCards.slice(0, k - d) };
  }
  return { plan: first, delve: [], convoke: [] };
}

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
  // „Untap all artifacts you control during each other player's untap step.“
  for (const other of game.seats) {
    if (other === userId || !game.players[other].battlefield.some(id => defOf(game, game.cards[id]).rules?.untapArtifactsOthers)) continue;
    for (const id of game.players[other].battlefield) if (defOf(game, game.cards[id]).types.artifact) game.cards[id].tapped = false;
  }
  for (const id of game.players[userId].battlefield) {
    const card = game.cards[id];
    if (card.frozen) {
      card.frozen = false; // „doesn't untap during its controller's next untap step“
      continue;
    }
    if (card.counters.stun > 0 && card.tapped) {
      // Betäubungsmarker: statt zu enttappen wird ein Marker entfernt
      card.counters.stun -= 1;
      if (card.counters.stun <= 0) delete card.counters.stun;
      continue;
    }
    if (card.tapped) count += 1;
    card.tapped = false;
  }
  return count;
}

function finishTurn(game) {
  for (const card of Object.values(game.cards)) {
    card.damage = 0;
    card.deathtouched = false;
    card.tp = 0;
    card.tt = 0;
    if (card.baseDef) {
      delete game.xdefs[card.def];
      card.def = card.baseDef;
      card.baseDef = undefined;
    }
    card.tk = [];
    card.regen = false;
    card.noCombat = false;
    card.shield = 0;
  }
  for (const player of Object.values(game.players)) player.shield = 0;
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
    return def.types.creature && !card.tapped && !card.faceDown && !isSick(game, card) && !hasKeyword(game, card, "defender") && !hasKeyword(game, card, "cant-attack");
  });
}

/** Sagas: ein Wissensmarker, dann löst das passende Kapitel aus; nach dem letzten Kapitel wird die Saga geopfert. */
function addLore(game, card) {
  const def = defOf(game, card);
  if (!def.rules?.saga || !onBattlefield(game, card.id)) return;
  card.counters.lore = (card.counters.lore ?? 0) + 1;
  const chapter = card.counters.lore;
  const max = def.rules.saga.max;
  if (chapter >= max) {
    // Zuerst auf den Stapel, damit es nach dem letzten Kapitel aufgelöst wird
    game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger: { event: "chapter", text: "Saga: Opfern nach dem letzten Kapitel", effects: [{ type: "sacrificeSelf" }], specs: [], unparsed: [], summary: "Die Saga wird geopfert." } });
  }
  for (const trigger of def.rules.triggers ?? []) {
    if (trigger.event === "chapter" && trigger.chapter === chapter) game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger });
  }
  addLog(game, `${def.name}: Kapitel ${chapter} (Wissensmarker).`);
}

function enterPhase(game, phase) {
  game.turn.phase = phase;
  game.priority = game.turn.active;
  game.passed = [];
  clearPools(game);
  if (phase === "main1") beginMain1(game);
  if (phase === "main2" && game.phase === "playing") {
    fireGlobal(game, "mainPhase", game.turn.active);
    flushTriggers(game);
  }
}

/** Beginn der ersten Hauptphase (nach dem Ziehen): Sagas erhalten einen Wissensmarker. */
function beginMain1(game) {
  if (game.phase !== "playing") return;
  if (!game.turn.drawBlocked) fireGlobal(game, "drawStep", game.turn.active); // „At the beginning of each player's draw step“
  for (const id of [...game.players[game.turn.active].battlefield]) if (game.cards[id]) addLore(game, game.cards[id]);
  fireGlobal(game, "mainPhase", game.turn.active);
  flushTriggers(game);
}

/** Alle haben nacheinander gepasst und der Stapel ist leer: nächster Schritt. */
function advanceStep(game, now, random) {
  switch (game.turn.phase) {
    case "draw":
      enterPhase(game, "main1");
      return;
    case "main1":
      if (hasPotentialAttackers(game, game.turn.active) && alive(game).length > 1) {
        enterPhase(game, "attackers");
        fireGlobal(game, "beginCombat", game.turn.active);
        flushTriggers(game);
      }
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
      if (game.monarch === game.turn.active) {
        const drawn = drawCards(game, game.turn.active, 1);
        addLog(game, `${game.players[game.turn.active].name} zieht als Monarch ${drawn ? "eine Karte" : "keine Karte (Bibliothek leer)"}.`);
      }
      fireGlobal(game, "endStep", game.turn.active);
      flushTriggers(game);
      // Im Endschritt wird niemand nach Antworten gefragt: Er wird übersprungen, sobald keine Auslöser mehr offen sind.
      const someoneCanRespond = game.seats.some(id => id !== game.turn.active && !game.players[id].eliminated && game.players[id].askResponse !== false && canRespond(game, id));
      if (game.stack.length === 0 && !game.choice && !someoneCanRespond) advanceStep(game, now, random);
      return;
    case "end": {
      for (const id of game.delayedReturns ?? []) {
        const card = game.cards[id];
        const owner = card ? game.players[card.origOwner ?? card.owner] : null;
        if (!card || !owner?.exile.includes(id)) continue;
        owner.exile.splice(owner.exile.indexOf(id), 1);
        owner.battlefield.push(id);
        enterBattlefield(game, card);
        addLog(game, `${nameOf(game, id)} kehrt zu Beginn des Endsegments aufs Schlachtfeld zurück.`);
      }
      game.delayedReturns = [];
      for (const userId of game.seats) {
        for (const id of [...game.players[userId].battlefield]) {
          if (game.cards[id]?.sacEnd) {
            game.cards[id].sacEnd = false;
            addLog(game, `${nameOf(game, id)} wird zu Beginn des Endsegments geopfert.`);
            toGraveyard(game, game.cards[id]);
          } else if (game.cards[id]?.exileEnd) {
            game.cards[id].exileEnd = false;
            addLog(game, `${nameOf(game, id)} wird zu Beginn des Endsegments ins Exil geschickt.`);
            leaveTo(game, game.cards[id], "exile");
          } else if (game.cards[id]?.handEnd) {
            game.cards[id].handEnd = false;
            addLog(game, `${nameOf(game, id)} kehrt zu Beginn des Endsegments auf die Hand zurück.`);
            leaveTo(game, game.cards[id], "hand");
          }
        }
      }
      const active = game.players[game.turn.active];
      const noLimit = active.battlefield.some(id => defOf(game, game.cards[id]).rules?.noHandLimit);
      if (active.hand.length > HAND_SIZE && !noLimit) {
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

/** Werte der Ziele vor der Wirkung („last known information“): Stärke, Widerstandskraft, Manawert, Kontrolleur. */
function snapshotTargets(game, targets) {
  const snap = {};
  for (const id of targets ?? []) {
    const card = game.cards[id];
    if (!card) continue;
    const def = defOf(game, card);
    snap[id] = { power: def.types.creature ? powerOf(game, card) : 0, toughness: def.types.creature ? toughnessOf(game, card) : 0, mv: def.manaValue ?? 0, controller: card.owner };
  }
  return snap;
}

function resolveTop(game) {
  const item = game.stack.pop();
  if (!item) return;
  const controller = game.players[item.controller];
  if (item.kind === "ability") {
    const ctx = { controller: item.controller, source: item.source, sourceName: item.sourceName, targets: item.targets ?? [], unparsed: item.unparsed ?? [], subject: item.subject, subjectCard: item.subjectCard, paidPower: item.paidPower, damage: item.damage, snap: snapshotTargets(game, item.targets) };
    if ((item.specs?.length ?? 0) > 0 && !targetsLegal(game, item.specs, ctx.targets, item.controller, item.source && game.cards[item.source] ? { ...srcOfCard(game, game.cards[item.source]), subject: item.subject } : undefined)) {
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
    const spell = base.modes ? (Array.isArray(item.modeList) ? combineModes(base.modes, item.modeList) : base.modes[item.mode] ?? { effects: [], specs: [], unparsed: [] }) : base;
    if (spell.specs.length > 0 && !targetsLegal(game, spell.specs, item.targets ?? [], item.controller, srcOfDef(def, card.id))) {
      addLog(game, `${def.name} verpufft (Ziel nicht mehr gültig).`);
    } else {
      addLog(game, `${def.name} löst sich auf.`);
      runEffects(game, spell.effects, { controller: item.controller, source: card.id, sourceName: def.name, targets: item.targets ?? [], unparsed: spell.unparsed, x: item.x, flashback: Boolean(item.flashback), snap: snapshotTargets(game, item.targets), castInfo: { greatestPower: item.greatestPower ?? 0, fromExile: Boolean(item.fromExile) } });
    }
    if (!item.copy) (item.flashback || item.exileAfter ? owner.exile : owner.graveyard).push(card.id);
  } else if (def.rules?.aura) {
    const specs = def.rules.spell?.specs ?? [];
    if (specs.length > 0 && !targetsLegal(game, specs, item.targets ?? [], item.controller, srcOfDef(def, card.id))) {
      addLog(game, `${def.name} verpufft (Ziel nicht mehr gültig).`);
      toGraveyard(game, card, "stack");
      return;
    }
    owner.battlefield.push(card.id);
    enterBattlefield(game, card);
    card.attachedTo = item.targets?.[0] ?? null;
    addLog(game, `${def.name} löst sich auf → hängt an ${card.attachedTo ? nameOf(game, card.attachedTo) : "…"}.`);
  } else if (item.mutate && game.cards[item.mutate] && mutateTargets(game, item.controller).includes(item.mutate)) {
    mutateInto(game, card, game.cards[item.mutate], item.over !== false);
  } else {
    owner.battlefield.push(card.id);
    card.enterX = item.x;
    enterBattlefield(game, card);
    if (item.evoked) {
      game.triggerQueue.push({ controller: item.controller, source: card.id, sourceName: def.name, trigger: { event: "etb", text: "Evoke: opfern", effects: [{ type: "sacrificeSelf" }], specs: [], unparsed: [], summary: "Evoke: wird geopfert." } });
      addLog(game, `${def.name} wurde mit Evoke gewirkt und wird geopfert.`);
    }
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
  if (hasKeyword(game, attacker, "unblockable")) return "unblockbar";
  if (hasKeyword(game, attacker, "flying") && !hasKeyword(game, blocker, "flying") && !hasKeyword(game, blocker, "reach")) return "Flug";
  const blockerDef = defOf(game, blocker);
  const blockerColors = colorsOfDef(blockerDef);
  if (hasKeyword(game, attacker, "fear") && !blockerDef.types.artifact && !blockerColors.includes("B")) return "Furcht";
  if (hasKeyword(game, attacker, "intimidate") && !blockerDef.types.artifact && !blockerColors.some(color => colorsOfCard(game, attacker).includes(color))) return "Einschüchtern";
  for (const land of ["plains", "island", "swamp", "mountain", "forest"]) {
    if (hasKeyword(game, attacker, `${land}walk`) && game.players[blocker.owner].battlefield.some(id => defOf(game, game.cards[id]).types.land && hasSubtype(defOf(game, game.cards[id]), land))) return "Landwandern";
  }
  if (defOf(game, attacker).rules?.blockMinPower && powerOf(game, blocker) < defOf(game, attacker).rules.blockMinPower) return "Zu schwach zum Blocken";
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
    return defOf(game, card).types.creature && !card.tapped && !card.faceDown && !hasKeyword(game, card, "cant-block");
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
  game.dmgStepFired = {}; // „one or more creatures … deal combat damage“: je Auslöser einmal
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
      const dealt = inflictDamage(game, source, hit.card ?? hit.player, hit.amount, { combat: true });
      if (dealt > 0 && hit.player && game.monarch === hit.player && source.owner !== hit.player) {
        game.monarch = source.owner;
        addLog(game, `${game.players[source.owner].name} wird durch Kampfschaden zum Monarchen.`);
      }
      if (dealt > 0 && hit.player) {
        fireGlobal(game, "creatureDealsCombatDamage", source);
        fireGlobal(game, "creaturesDealDamage", source); // je Auslöser höchstens einmal pro Kampfschaden (siehe fireGlobal)
        fireTriggers(game, source, "dealsCombatDamage", hit.player);
        for (const item of game.triggerQueue) if (item.source === source.id && item.trigger.event === "dealsCombatDamage" && item.damage === undefined) item.damage = dealt; // „that much damage“
        for (const other of Object.values(game.cards)) {
          if (other.attachedTo !== source.id || !onBattlefield(game, other.id)) continue;
          for (const trigger of defOf(game, other).rules?.triggers ?? []) {
            if (trigger.event === "equippedDealsCombatDamage") game.triggerQueue.push({ controller: other.owner, source: other.id, sourceName: defOf(game, other).name, trigger });
          }
        }
      }
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
        if (def.types.creature && !card.faceDown && !card.pendingClone) { // ein Klon wählt seine Kopie beim Eintritt
          const toughness = toughnessOf(game, card);
          if (toughness <= 0) dies = true;
          else if (!hasKeyword(game, card, "indestructible") && (card.damage >= toughness || (card.deathtouched && card.damage > 0))) dies = true;
        }
        if (def.types.planeswalker && def.loyalty !== null && counterOf(card, "loyalty") <= 0) dies = true;
        if (card.attachedTo && (!game.cards[card.attachedTo] || !onBattlefield(game, card.attachedTo))) {
          card.attachedTo = null;
          if (def.rules?.aura) dies = true; // eine Aura ohne Ziel kommt auf den Friedhof
        }
        if (dies && card.regen && def.types.creature) {
          card.regen = false;
          card.tapped = true;
          card.damage = 0;
          card.deathtouched = false;
          if (game.combat) {
            game.combat.attackers = game.combat.attackers.filter(a => a.id !== card.id);
            game.combat.blocks = game.combat.blocks.filter(b => b.blocker !== card.id && b.attacker !== card.id);
          }
          addLog(game, `${def.name} regeneriert (getappt, Schaden entfernt).`);
          changed = true;
          continue;
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
    case "permanent": return !def.types.instant && !def.types.sorcery;
    default:
      // „forest“, „plains|island|swamp|mountain“: Grundland-Typen in der Typzeile
      return /^[a-z|]+$/.test(String(what)) && what !== "card" ? new RegExp(`\\b(${what})\\b`, "i").test(def.typeLine ?? "") : true;
  }
}

/** Passt ein gewirkter Zauber zum Filter von „Whenever you cast a <Filter> spell“? */
function castFilterOk(def, filter) {
  if (filter.anyTypes && !filter.anyTypes.some(type => def.types[type])) return false;
  if (filter.nonTypes?.some(type => def.types[type])) return false;
  if (filter.legendary && !def.types.legendary) return false;
  if (filter.historic && !(def.types.legendary || def.types.artifact || /\bSaga\b/.test(def.typeLine ?? ""))) return false;
  const colors = colorsOfDef(def);
  if (filter.multicolored && colors.length < 2) return false;
  if (filter.colorless && colors.length > 0) return false;
  if (filter.mvMin !== undefined && (def.manaValue ?? 0) < filter.mvMin) return false;
  if (filter.mvMax !== undefined && (def.manaValue ?? 0) > filter.mvMax) return false;
  if (filter.hasX && !/\{X\}/.test(def.manaCost ?? "")) return false;
  return true;
}

/** Passt das auslösende Permanent zum Filter eines allgemeinen Auslösers (Typ der Zielangabe plus Filter)? */
function subjectMatches(game, card, spec, source) {
  const types = defOf(game, card).types;
  const kind = spec.kind === "myCreature" ? "creature" : spec.kind;
  if (kind !== "permanent" && !types[kind]) return false;
  return passesSpecFilter(game, card.id, spec, source.owner, source);
}

/** Zusätzliche Bedingungen einer Zielangabe („nonblack“, „tapped“, „an opponent controls“, „with power 4 or greater“ …). */
function passesSpecFilter(game, id, spec, controller, src) {
  const card = game.cards[id];
  const def = defOf(game, card);
  if (spec.another && src?.id === id) return false;
  if (spec.token === true && !card.token) return false;
  if (spec.token === false && card.token) return false;
  if (spec.counter && !(spec.counter === "any" ? Object.values(card.counters ?? {}).some(value => value > 0) : (card.counters?.[spec.counter] ?? 0) > 0)) return false;
  if (spec.noKeyword && hasKeyword(game, card, spec.noKeyword)) return false;
  if (spec.enteredThisTurn && !(card.sinceSeq > (game.players[game.turn.active]?.turnStartSeq ?? 0))) return false;
  if (spec.subtypes && !spec.subtypes.some(word => hasSubtype(def, word))) return false;
  if (spec.ctrl === "opp" && card.owner === controller) return false;
  if (spec.ctrl === "subject" && card.owner !== src?.subject) return false;
  if (spec.ctrl === "you" && card.owner !== controller) return false;
  if (spec.tapped === true && !card.tapped) return false;
  if (spec.tapped === false && card.tapped) return false;
  if (spec.attacking && !game.combat?.attackers.some(a => a.id === id)) return false;
  if (spec.blocking && !game.combat?.blocks.some(b => b.blocker === id)) return false;
  if (spec.nonColors?.length > 0 && colorsOfDef(def).some(color => spec.nonColors.includes(color))) return false;
  if (spec.colors?.length > 0 && !colorsOfDef(def).some(color => spec.colors.includes(color))) return false;
  if (spec.nonTypes?.some(type => def.types[type])) return false;
  if (spec.anyTypes && !spec.anyTypes.some(type => def.types[type])) return false;
  if (spec.types?.some(type => !def.types[type])) return false;
  if (spec.legendary === true && !def.types.legendary) return false;
  if (spec.legendary === false && def.types.legendary) return false;
  if (spec.keyword && !hasKeyword(game, card, spec.keyword)) return false;
  if (spec.stat) {
    const value = spec.stat.of === "power" ? powerOf(game, card) : toughnessOf(game, card);
    if (spec.stat.op === "gte" ? value < spec.stat.n : value > spec.stat.n) return false;
  }
  return true;
}

/** Gültige Ziele (Karten-IDs, Spieler-IDs oder Stapel-IDs) für eine Zielangabe. */
function validTargets(game, spec, controller, src = { colors: [], id: null }) {
  const players = alive(game);
  const battlefield = [];
  for (const userId of game.seats) {
    for (const id of game.players[userId].battlefield) {
      const card = game.cards[id];
      const def = defOf(game, card);
      if (card.owner !== controller && (hasKeyword(game, card, "hexproof") || hasKeyword(game, card, "shroud"))) continue;
      if ((src?.colors?.length ?? 0) > 0 && protectedFrom(game, card, src.colors)) continue;
      battlefield.push({ id, def });
    }
  }
  const pick = predicate => battlefield.filter(item => predicate(item.def.types) && passesSpecFilter(game, item.id, spec, controller, src)).map(item => item.id);
  switch (spec.kind) {
    case "player": return players;
    case "opponent": return players.filter(id => id !== controller);
    case "creature": return pick(t => t.creature);
    case "myCreature": return battlefield.filter(item => item.def.types.creature && game.cards[item.id].owner === controller && passesSpecFilter(game, item.id, spec, controller, src)).map(item => item.id);
    case "gyAny": return [...game.players[controller].graveyard];
    case "gyAnyPlayer": return game.seats.flatMap(id => game.players[id].graveyard);
    case "gyLandAny": return game.seats.flatMap(id => game.players[id].graveyard).filter(id => defOf(game, game.cards[id]).types.land);
    case "gyInstSorcAny": return game.seats.flatMap(id => game.players[id].graveyard).filter(id => defOf(game, game.cards[id]).types.instant || defOf(game, game.cards[id]).types.sorcery);
    case "gyCreatureAny": return game.seats.flatMap(id => game.players[id].graveyard).filter(id => defOf(game, game.cards[id]).types.creature);
    case "gyInstSorc":
      return game.players[controller].graveyard.filter(id => {
        const def = defOf(game, game.cards[id]);
        return (spec.onlyInstant ? def.types.instant : def.types.instant || def.types.sorcery) && !(spec.mvMax !== undefined && (def.manaValue ?? 0) > spec.mvMax);
      });
    case "gyCreature":
    case "gyArtifact":
    case "gyEnchantment":
    case "gyLand":
    case "gyPermanent": {
      const what = spec.kind.slice(2).toLowerCase();
      return game.players[controller].graveyard.filter(id => {
        const def = defOf(game, game.cards[id]);
        if (spec.mvMax !== undefined && (def.manaValue ?? 0) > spec.mvMax) return false;
        if (spec.powerMax !== undefined && (def.power ?? 0) > spec.powerMax) return false;
        if (spec.subtypes && !spec.subtypes.some(word => hasSubtype(def, word))) return false;
        return what === "permanent" ? !def.types.instant && !def.types.sorcery : typeMatches(def, what);
      });
    }
    case "playerOrPlaneswalker": return [...players, ...pick(t => t.planeswalker)];
    case "planeswalker": return pick(t => t.planeswalker);
    case "artifact": return pick(t => t.artifact);
    case "enchantment": return pick(t => t.enchantment);
    case "land": return pick(t => t.land);
    case "permanent": return battlefield.filter(item => passesSpecFilter(game, item.id, spec, controller, src)).map(item => item.id);
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

const targetOptions = (game, specs, controller, src) => specs.map(spec => ({ kind: spec.kind, options: validTargets(game, spec, controller, src) }));

function targetsLegal(game, specs, targets, controller, src) {
  if (!Array.isArray(targets) || targets.length !== specs.length) return false;
  return specs.every((spec, index) => (spec.optional && targets[index] === "") || validTargets(game, spec, controller, src).includes(targets[index]));
}

/** Spielstein, der eine Karte kopiert (Encore, Eternalize, Embalm). */
/** Definition einer Kopie mit Ausnahmen (nicht legendär, andere Stärke, zusätzliche Typen, Schlüsselwörter, Farbe). */
function copyDef(base, mods = {}) {
  const subtypes = (mods.addSubtypes ?? []).map(word => word[0].toUpperCase() + word.slice(1));
  const [front, back = ""] = String(base.typeLine ?? "").split(" — ");
  const typeLine = `${mods.nonlegendary ? front.replace(/\bLegendary\s*/, "") : front}${mods.artifact && !/Artifact/.test(front) ? " Artifact" : ""}${subtypes.length || back ? ` — ${[back, ...subtypes].filter(Boolean).join(" ")}` : ""}`.trim();
  return {
    ...base,
    typeLine,
    types: { ...base.types, ...(mods.nonlegendary ? { legendary: false } : {}), ...(mods.artifact ? { artifact: true } : {}) },
    ...(mods.power !== undefined ? { power: mods.power, toughness: mods.toughness, powerText: String(mods.power), toughnessText: String(mods.toughness) } : {}),
    ...(mods.color ? { manaCost: `{${mods.color}}` } : {}),
    keywords: [...new Set([...(base.keywords ?? []), ...(mods.kws ?? [])])]
  };
}

function createCopyToken(game, userId, base, mode, opp, mods) {
  if (mods) {
    const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
    if (tokens >= MAX_TOKENS) return null;
    const id = newId(game, "t");
    const key = `token:${id}`;
    const made = copyDef(base, mods);
    game.xdefs[key] = { ...made, typeLine: /^Token/.test(made.typeLine) ? made.typeLine : `Token ${made.typeLine}`, manaValue: base.manaValue };
    game.cards[id] = { id, owner: userId, def: key, tapped: false, faceDown: false, counters: {}, revealed: false, token: true, damage: 0, deathtouched: false, sinceSeq: tick(game), tp: 0, tt: 0 };
    game.players[userId].battlefield.push(id);
    return id;
  }
  const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
  if (tokens >= MAX_TOKENS) return null;
  const id = newId(game, "t");
  const key = `token:${id}`;
  const zombie = mode === "eternalize" || mode === "embalm";
  const typeLine = zombie ? `Token ${(base.typeLine ?? "").replace(/^(Legendary )?/, "").replace(/ — .*$/, "")} — Zombie ${(base.typeLine ?? "").split(" — ")[1] ?? ""}`.trim() : `Token ${base.typeLine}`;
  game.xdefs[key] = {
    ...base,
    typeLine,
    types: { ...base.types, legendary: false },
    manaCost: zombie ? (mode === "eternalize" ? "{B}" : "{W}") : base.manaCost,
    power: mode === "eternalize" ? 4 : base.power,
    toughness: mode === "eternalize" ? 4 : base.toughness,
    powerText: mode === "eternalize" ? "4" : base.powerText,
    toughnessText: mode === "eternalize" ? "4" : base.toughnessText,
    keywords: mode === "encore" ? [...new Set([...(base.keywords ?? []), "haste"])] : base.keywords
  };
  game.cards[id] = {
    id, owner: userId, def: key, tapped: false, faceDown: false, counters: {}, revealed: false, token: true,
    damage: 0, deathtouched: false, sinceSeq: tick(game), tp: 0, tt: 0,
    ...(mode === "encore" ? { sacEnd: true, tk: ["must-attack"] } : {})
  };
  game.players[userId].battlefield.push(id);
  return id;
}

function createToken(game, userId, { name, power, toughness, artifact = false, typeLine, oracleText, mana = null, keywords = [] }) {
  const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
  if (tokens >= MAX_TOKENS) return null;
  const id = newId(game, "t");
  const key = `token:${id}`;
  const creature = power !== null && power !== undefined;
  game.xdefs[key] = {
    name,
    typeLine: typeLine ?? `Token${artifact ? " Artifact" : ""}${creature ? " Creature" : ""}`,
    manaValue: 0,
    imageUri: null,
    manaCost: "",
    types: { creature, land: false, instant: false, sorcery: false, artifact, enchantment: false, planeswalker: false, battle: false, legendary: false, basicLand: false },
    power: creature ? power : null,
    toughness: creature ? toughness : null,
    powerText: creature ? String(power) : null,
    toughnessText: creature ? String(toughness) : null,
    loyalty: null,
    keywords,
    mana,
    rules: oracleText ? parseCardText({ name, typeLine: typeLine ?? "Token Artifact", oracleText }) : { spell: null, triggers: [], activated: [], notes: [] }
  };
  if (mana && oracleText) game.xdefs[key].rules.sacMana = true;
  game.cards[id] = {
    id, owner: userId, def: key, tapped: false, faceDown: false, counters: {}, revealed: false, token: true,
    damage: 0, deathtouched: false, sinceSeq: tick(game), tp: 0, tt: 0
  };
  game.players[userId].battlefield.push(id);
  // Spielsteine kommen wie andere Permanents ins Spiel (Auslöser „whenever a creature enters“ usw.)
  if (game.phase === "playing") enterBattlefield(game, game.cards[id]);
  return id;
}

const NAMED_TOKENS = {
  Treasure: { typeLine: "Token Artifact — Treasure", oracleText: "{T}, Sacrifice this artifact: Add one mana of any color.", mana: [["W", "U", "B", "R", "G"]] },
  Food: { typeLine: "Token Artifact — Food", oracleText: "{2}, {T}, Sacrifice this artifact: You gain 3 life." },
  Clue: { typeLine: "Token Artifact — Clue", oracleText: "{2}, Sacrifice this artifact: Draw a card." },
  Lander: { typeLine: "Token Artifact — Lander", oracleText: "{2}, {T}, Sacrifice this artifact: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle." },
  Map: { typeLine: "Token Artifact — Map", oracleText: "{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery." },
  Gold: { typeLine: "Token Artifact — Gold", oracleText: "Sacrifice this artifact: Add one mana of any color.", mana: [["W", "U", "B", "R", "G"]] },
  Powerstone: { typeLine: "Token Artifact — Powerstone", oracleText: "{T}: Add {C}.", mana: [["C"]] },
  Blood: { typeLine: "Token Artifact — Blood", oracleText: "{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card." }
};

/** Spielsteine, die beim Bezahlen geopfert werden (Schatz). */
function spendSacrificial(game, ids) {
  for (const id of ids) {
    const card = game.cards[id];
    if (card?.token && defOf(game, card).rules?.sacMana && onBattlefield(game, id)) {
      addLog(game, `${nameOf(game, id)} wird geopfert.`);
      noteSacrifice(game, card);
      toGraveyard(game, card);
    }
  }
}

function playersOf(game, who, ctx) {
  switch (who.k) {
    case "you": return [ctx.controller];
    case "target": return ctx.targets[who.t] && game.players[ctx.targets[who.t]] && !game.players[ctx.targets[who.t]].eliminated ? [ctx.targets[who.t]] : [];
    case "eachOpp": return alive(game).filter(id => id !== ctx.controller);
    case "each": return alive(game);
    case "ids": return who.ids.filter(id => game.players[id] && !game.players[id].eliminated);
    case "subject": return ctx.subject && game.players[ctx.subject] && !game.players[ctx.subject].eliminated ? [ctx.subject] : [];
    case "controllerOf": {
      const id = ctx.targets[who.t];
      const owner = ctx.snap?.[id]?.controller ?? game.cards[id]?.owner;
      return owner && game.players[owner] && !game.players[owner].eliminated ? [owner] : [];
    }
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
  // Verhinderung: „Prevent all combat damage … by that creature“ und Schadensschilde
  if (combat && (source?.noCombat || game.cards[targetId]?.noCombat)) return 0;
  {
    const holder = game.players[targetId] ?? game.cards[targetId];
    if (holder?.shield > 0) {
      const absorbed = Math.min(holder.shield, amount);
      holder.shield -= absorbed;
      amount -= absorbed;
      addLog(game, `${absorbed} Schaden wird verhindert.`);
      if (amount <= 0) return 0;
    }
  }
  if (game.players[targetId]) {
    const target = game.players[targetId];
    if (infect) target.poison += amount;
    else target.life -= amount;
    if (target.dmgTurn !== game.turn?.number) {
      target.dmgTurn = game.turn?.number;
      target.dmgTaken = 0;
    }
    target.dmgTaken += amount;
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
    if (card.counters.shield > 0 && (def.types.creature || def.types.planeswalker)) {
      card.counters.shield -= 1;
      if (card.counters.shield <= 0) delete card.counters.shield;
      addLog(game, `${def.name}: Ein Schildmarker verhindert den Schaden von ${sourceName} und wird entfernt.`);
      return 0;
    }
    if (def.types.creature) {
      if (infect || wither) card.counters["-1/-1"] = (card.counters["-1/-1"] ?? 0) + amount;
      else card.damage += amount;
      pushFx(game, { type: "damage", card: targetId, amount });
      if (source && hasKeyword(game, source, "deathtouch")) card.deathtouched = true;
      dealt = amount;
      for (const trigger of def.rules?.triggers ?? []) {
        if (trigger.event === "dealtDamage") game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger, damage: amount });
      }
    }
    if (def.types.planeswalker) {
      card.counters.loyalty = Math.max(0, (card.counters.loyalty ?? 0) - amount);
      pushFx(game, { type: "damage", card: targetId, amount });
      dealt = amount;
    }
    if (!combat) addLog(game, `${sourceName} fügt ${def.name} ${amount} Schaden zu.`);
  }
  if (dealt > 0 && combat && source && game.players[targetId] && defOf(game, source).rules?.toxic) {
    game.players[targetId].poison += defOf(game, source).rules.toxic;
    addLog(game, `${game.players[targetId].name} erhält ${defOf(game, source).rules.toxic} Giftmarke(n) (Toxic).`);
  }
  if (dealt > 0 && source && hasKeyword(game, source, "lifelink")) {
    game.players[source.owner].life += dealt;
    pushFx(game, { type: "heal", player: source.owner, amount: dealt });
    noteLifeGain(game, source.owner, dealt);
    fireGlobal(game, "youGainLife", source.owner);
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
  if (card.counters.shield > 0) {
    card.counters.shield -= 1;
    if (card.counters.shield <= 0) delete card.counters.shield;
    addLog(game, `${def.name}: Ein Schildmarker verhindert die Zerstörung und wird entfernt.`);
    return;
  }
  if (card.regen && def.types.creature) {
    card.regen = false;
    card.tapped = true;
    card.damage = 0;
    addLog(game, `${def.name} regeneriert statt zerstört zu werden.`);
    return;
  }
  addLog(game, `${def.name} wird zerstört.`);
  toGraveyard(game, card);
}

function leaveTo(game, card, zone) {
  if (onBattlefield(game, card.id)) releaseExiled(game, card);
  const holder = game.players[card.owner];
  const owner = game.players[card.origOwner ?? card.owner];
  const parts = onBattlefield(game, card.id) ? splitMutated(game, card) : [];
  for (const z of ZONES) {
    const index = holder[z].indexOf(card.id);
    if (index !== -1) holder[z].splice(index, 1);
  }
  placeParts(game, parts, zone);
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
        if (trigger.event !== event || !tierOn(source, trigger)) continue;
        const scope = trigger.scope ?? { owner: "you", another: false };
        const subjectOwner = typeof subject === "string" ? subject : subject.owner;
        if (scope.owner === "you" && subjectOwner !== source.owner) continue;
        if (scope.owner === "opp" && subjectOwner === source.owner) continue;
        if (scope.another && typeof subject !== "string" && subject.id === source.id) continue;
        if (trigger.cond === "evolve" && (typeof subject === "string" || !(powerOf(game, subject) > powerOf(game, source) || toughnessOf(game, subject) > toughnessOf(game, source)))) continue;
        if (scope.subtype && (typeof subject === "string" || !hasSubtype(defOf(game, subject), scope.subtype))) continue;
        if (trigger.counterKind && (typeof subject === "string" || subject.lastCounterKind !== trigger.counterKind)) continue;
        if (scope.counter && (typeof subject === "string" || !(scope.counter === "any" ? Object.values(subject.counters).some(value => value > 0) : subject.counters[scope.counter] > 0))) continue;
        if (scope.creatureType && (typeof subject === "string" || !(defOf(game, subject).types[scope.creatureType] ?? hasSubtype(defOf(game, subject), scope.creatureType)))) continue;
        if (trigger.sacrificeWhat && (typeof subject === "string" || !(trigger.sacrificeWhat in defOf(game, subject).types ? defOf(game, subject).types[trigger.sacrificeWhat] : hasSubtype(defOf(game, subject), trigger.sacrificeWhat)) || (trigger.sacrificeNontoken && subject.token))) continue;
        if (trigger.attackerSubtype && !(game.combat?.attackers ?? []).some(attacker => game.cards[attacker.id] && hasSubtype(defOf(game, game.cards[attacker.id]), trigger.attackerSubtype))) continue;
        if (trigger.minAttackers && (game.combat?.attackers?.length ?? 0) < trigger.minAttackers) continue;
        if (trigger.mainWhich && trigger.mainWhich !== "each" && trigger.mainWhich !== game.turn.phase) continue;
        if (trigger.attackerSpec && !(game.combat?.attackers ?? []).some(attacker => game.cards[attacker.id] && game.cards[attacker.id].owner === source.owner && passesSpecFilter(game, attacker.id, trigger.attackerSpec, source.owner, source))) continue;
        if (scope.nontoken && typeof subject !== "string" && subject.token) continue;
        if (scope.permType && (typeof subject === "string" || !(scope.permType in defOf(game, subject).types ? defOf(game, subject).types[scope.permType] : hasSubtype(defOf(game, subject), scope.permType)))) continue;
        if (scope.anyOf && (typeof subject === "string" || !scope.anyOf.some(word => hasSubtype(defOf(game, subject), word)))) continue;
        if (scope.commander && (typeof subject === "string" || !subject.cmd)) continue;
        if (scope.spec && (typeof subject === "string" || !subjectMatches(game, subject, scope.spec, source))) continue;
        if (scope.legendary && (typeof subject === "string" || !defOf(game, subject).types.legendary)) continue;
        if (trigger.kinds && (typeof subject === "string" || !trigger.kinds.some(kind => defOf(game, subject).types[kind]))) continue;
        if (trigger.castFilter && (typeof subject === "string" || !castFilterOk(defOf(game, subject), trigger.castFilter))) continue;
        if (scope.minPower !== undefined && (typeof subject === "string" || powerOf(game, subject) < scope.minPower)) continue;
        if (scope.maxPower !== undefined && (typeof subject === "string" || powerOf(game, subject) > scope.maxPower)) continue;
        if (trigger.chosenType && (!source.chosenType || typeof subject === "string" || !hasSubtype(defOf(game, subject), source.chosenType))) continue;
        if (event === "creaturesDealDamage") {
          // „one or more …“: je Auslöser höchstens einmal pro Kampfschaden-Schritt
          const key = `${source.id}|${trigger.text}`;
          game.dmgStepFired = game.dmgStepFired ?? {};
          if (game.dmgStepFired[key]) continue;
          game.dmgStepFired[key] = true;
        }
        if (!onceAllowed(game, source, trigger)) continue;
        game.triggerQueue.push({ controller: source.owner, source: source.id, sourceName: def.name, trigger, subject: subjectOwner, subjectCard: typeof subject === "string" ? null : subject.id });
      }
    }
  }
}

function fireTriggers(game, card, event, subject) {
  const def = defOf(game, card);
  // Von Ausrüstung/Aura verliehene Auslöser („Equipped creature has "Whenever ~ attacks, …"“)
  for (const id of game.players[card.owner]?.battlefield ?? []) {
    const gear = game.cards[id];
    if (gear?.attachedTo !== card.id) continue;
    for (const trigger of defOf(game, gear).rules?.attachTriggers ?? []) {
      if (trigger.event === event) game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger, subject });
    }
  }
  // „Artifact creatures you control have "Whenever ~ deals combat damage …"“
  for (const id of game.players[card.owner]?.battlefield ?? []) {
    for (const granted of defOf(game, game.cards[id]).rules?.grantedTriggers ?? []) {
      if (granted.trigger.event !== event) continue;
      const matches = granted.what in def.types ? def.types[granted.what] && def.types.creature : hasSubtype(def, granted.what);
      if (matches && onBattlefield(game, card.id)) game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger: granted.trigger, subject });
    }
  }
  for (const trigger of def.rules?.triggers ?? []) {
    if (trigger.event === event && tierOn(card, trigger) && onceAllowed(game, card, trigger)) game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger, subject });
  }
  // Verliehenes Melee („Creatures you control have melee“): Auslöser beim Angriff, sofern die Karte es nicht selbst hat
  if (event === "attacks" && !(def.rules?.triggers ?? []).some(trigger => trigger.text === "Melee") && hasKeyword(game, card, "melee")) {
    game.triggerQueue.push({ controller: card.owner, source: card.id, sourceName: def.name, trigger: MELEE_TRIGGER, subject });
  }
}
const MELEE_TRIGGER = { event: "attacks", text: "Melee", effects: [{ type: "melee" }], specs: [], unparsed: [], summary: "Melee: +1/+1 für jeden angegriffenen Gegner." };

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
  if (entry.entry === "chooseColor") {
    const colors = ["W", "U", "B", "R", "G"].filter(color => color !== entry.except);
    game.choice = {
      userId: entry.controller,
      kind: "cards",
      prompt: `${name}: Wähle eine Farbe.`,
      options: colors.map(color => `color:${color}`),
      labels: { "color:W": "Weiß", "color:U": "Blau", "color:B": "Schwarz", "color:R": "Rot", "color:G": "Grün" },
      min: 1,
      max: 1,
      step: { type: "chooseColor", cardId: card.id },
      queue: [],
      ctx: null
    };
    return;
  }
  if (entry.entry === "clone") {
    const rule = defOf(game, card).rules.cloneOnEnter;
    const fits = other => {
      const types = defOf(game, other).types;
      return rule.what === "permanent" ? true : rule.what.includes("artifact") && types.artifact ? true : rule.what.includes("creature") ? types.creature : types[rule.what];
    };
    const options = game.seats.flatMap(id => game.players[id].battlefield).filter(id => id !== card.id && fits(game.cards[id]) && (!rule.mine || game.cards[id].owner === entry.controller));
    if (options.length === 0) {
      delete card.pendingClone;
      return;
    }
    game.choice = {
      userId: entry.controller,
      kind: "cards",
      prompt: `${name}: Als Kopie welcher Karte soll es ins Spiel kommen? (Keine = als es selbst)`,
      options,
      min: 0,
      max: 1,
      step: { type: "clone", cardId: card.id },
      queue: [],
      ctx: null
    };
    return;
  }
  if (entry.entry === "chooseType") {
    const types = new Set();
    for (const other of Object.values(game.cards)) {
      const def = defOf(game, other);
      if (!/Creature|Tribal|Kindred/.test(def.typeLine ?? "")) continue;
      for (const word of subtypesOf(def)) types.add(word);
    }
    const names = [...types].sort().map(word => word.charAt(0).toUpperCase() + word.slice(1));
    if (names.length === 0) return;
    game.choice = {
      userId: entry.controller,
      kind: "cards",
      prompt: `${name}: Wähle einen Kreaturentyp.`,
      options: names.map(word => `type:${word}`),
      labels: Object.fromEntries(names.map(word => [`type:${word}`, word])),
      min: 1,
      max: 1,
      step: { type: "chooseType", cardId: card.id },
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
    if (next.kind === "madness") {
      const card = game.cards[next.cardId];
      const player = game.players[next.controller];
      const madness = card ? defOf(game, card).rules?.madness : null;
      if (!card || !madness || !player.exile.includes(card.id)) continue;
      const affordable = !madness.hasX && player.life > madness.life && planPayment({ manaCost: madness.cost, pool: player.pool, sources: manaSources(game, next.controller) }).ok;
      if (!affordable) {
        player.exile.splice(player.exile.indexOf(card.id), 1);
        player.graveyard.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt in den Friedhof (Madness nicht bezahlbar).`);
        continue;
      }
      openChoice(game, {
        userId: next.controller,
        kind: "yesno",
        prompt: `Madness: ${nameOf(game, card.id)} für ${describeCost(madness.cost)}${madness.life ? ` und ${madness.life} Leben` : ""} wirken?`,
        options: ["yes", "no"],
        labels: { yes: "Wirken", no: "In den Friedhof" },
        min: 1,
        max: 1,
        step: { type: "madness", cardId: card.id },
        queue: [],
        ctx: null
      });
      continue;
    }
    const { trigger } = next;
    const base = {
      controller: next.controller,
      source: next.source,
      sourceName: next.sourceName,
      subject: next.subject,
      subjectCard: next.subjectCard,
      damage: next.damage,
      text: trigger.summary || trigger.text,
      effects: trigger.effects,
      specs: trigger.specs,
      unparsed: trigger.unparsed
    };
    if (trigger.modes) {
      // Modaler Auslöser: erst den Modus wählen (bei „choose two“ zwei), dann ggf. Ziele
      openChoice(game, {
        userId: next.controller,
        kind: trigger.pick > 1 ? "cards" : "yesno",
        prompt: `${next.sourceName}: Wähle einen Modus.`,
        options: trigger.modes.map((_, index) => String(index)),
        labels: Object.fromEntries(trigger.modes.map((mode, index) => [String(index), mode.label])),
        min: trigger.pick ?? 1,
        max: trigger.pick ?? 1,
        step: { type: "triggerMode", base, trigger },
        queue: [],
        ctx: null
      });
      continue;
    }
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
  const src = base.source && game.cards[base.source] ? { ...srcOfCard(game, game.cards[base.source]), subject: base.subject } : undefined;
  const options = validTargets(game, spec, controller, src);
  if (options.length === 0) {
    if (spec.optional) {
      // kein Ziel vorhanden: der Auslöser läuft ohne dieses Ziel weiter
      const rest = [...picked, ""];
      if (rest.length < base.specs.length) return openTriggerTarget(game, controller, base, rest, sourceName, text);
      pushAbility(game, { ...base, targets: rest });
      return true;
    }
    addLog(game, `${sourceName}: Auslöser verfällt (kein gültiges Ziel).`);
    return false;
  }
  game.choice = {
    userId: controller,
    kind: "targets",
    prompt: `Ziel ${base.specs.length > 1 ? `${picked.length + 1} von ${base.specs.length} ` : ""}für ${sourceName}: ${String(text ?? base.text).replace("~", sourceName)}`,
    options,
    min: spec.optional ? 0 : 1,
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
    const manualCard = ctx.source ? game.cards[ctx.source] : null;
    game.manual = { userId: ctx.controller, text: ctx.unparsed.join(" "), source: ctx.sourceName ?? "", hints: manualHints(ctx.unparsed.join(" ")), cardId: manualCard?.id ?? null, imageUri: manualCard ? defOf(game, manualCard).imageUri ?? null : null };
    addLog(game, `${game.players[ctx.controller].name} muss einen Kartentext manuell umsetzen: ${ctx.unparsed.join(" ")}`);
  }
}

function openChoice(game, choice) {
  game.choice = { min: 0, max: 1, queue: [], ...choice };
  return true;
}

/** Merkt sich, wie viel Leben ein Spieler in diesem Zug erhalten hat („if you gained life this turn“). */
function noteLifeGain(game, userId, amount) {
  const player = game.players[userId];
  if (!player || amount <= 0) return;
  if (player.lifeGainTurn !== game.turn.number) {
    player.lifeGainTurn = game.turn.number;
    player.lifeGained = 0;
  }
  player.lifeGained += amount;
}

/** Verschiebt Zielindizes eines Effekts (für zusammengesetzte Modi). */
function shiftTargets(effect, offset) {
  if (!offset) return effect;
  const next = { ...effect };
  for (const key of ["t", "from", "to"]) if (typeof next[key] === "number") next[key] += offset;
  if (next.to && typeof next.to === "object" && typeof next.to.t === "number") next.to = { ...next.to, t: next.to.t + offset };
  if (next.source && typeof next.source === "object" && typeof next.source.t === "number") next.source = { ...next.source, t: next.source.t + offset };
  if (next.forTargetController !== undefined) next.forTargetController += offset;
  if (next.who && typeof next.who === "object" && typeof next.who.t === "number") next.who = { ...next.who, t: next.who.t + offset };
  if (Array.isArray(next.effects)) next.effects = next.effects.map(item => shiftTargets(item, offset));
  return next;
}

/** Mehrere gewählte Modi zu einem Effekt mit gemeinsamen Zielen zusammenfügen (in Kartenreihenfolge). */
function combineModes(modes, list) {
  const out = { effects: [], specs: [], unparsed: [] };
  for (const index of [...list].sort((a, b) => a - b)) {
    const mode = modes[index];
    if (!mode) continue;
    const offset = out.specs.length;
    out.specs.push(...mode.specs);
    out.effects.push(...mode.effects.map(effect => shiftTargets(effect, offset)));
    out.unparsed.push(...mode.unparsed);
  }
  return out;
}

/** Wie viele Modi darf der Spieler wählen? */
function modeLimits(game, userId, spell) {
  const count = spell.modeCount ?? { min: 1, max: 1 };
  const commander = count.commanderMax && game.players[userId].battlefield.some(id => game.cards[id].cmd);
  return { min: Math.max(1, count.min), max: commander ? Math.max(count.max, count.commanderMax) : count.max };
}

/** Prüft eine Bedingung (siehe parseCondition in quantity.js) für den Kontrolleur aus `ctx`. */
function evalCondition(game, ctx, cond) {
  const controller = game.players[ctx.controller];
  const sourceCard = ctx.source ? game.cards[ctx.source] : null;
  const mine = controller.battlefield.map(id => game.cards[id]);
  return Boolean(
    (cond.kind === "creaturePower" && mine.some(card => defOf(game, card).types.creature && powerOf(game, card) >= cond.n)) ||
    (cond.kind === "commander" && mine.some(card => card.cmd)) ||
    (cond.kind === "controls" && (validTargets(game, { ...cond.spec, ctrl: "you" }, ctx.controller, { colors: [], id: ctx.source }).filter(id => !(cond.other && id === ctx.source)).length >= cond.n) !== Boolean(cond.negate)) ||
    (cond.kind === "attacked" && (game.turn.attackedOpponents?.[ctx.controller]?.length ?? 0) > 0) ||
    (cond.kind === "gainedLife" && controller.lifeGainTurn === game.turn.number && (controller.lifeGained ?? 0) >= cond.n) ||
    (cond.kind === "monarch" && game.monarch === ctx.controller) ||
    (cond.kind === "selfTapped" && sourceCard?.tapped) ||
    (cond.kind === "oppMoreLands" && game.seats.some(id => id !== ctx.controller && game.players[id].battlefield.filter(c => defOf(game, game.cards[c]).types.land).length > controller.battlefield.filter(c => defOf(game, game.cards[c]).types.land).length)) ||
    (cond.kind === "life" && (cond.op === "gte" ? controller.life >= cond.n : controller.life <= cond.n)) ||
    (cond.kind === "emptyHand" && controller.hand.length === 0) ||
    (cond.kind === "graveyard" && controller.graveyard.length >= cond.n) ||
    (cond.kind === "castFromExile" && Boolean(ctx.castInfo?.fromExile)) ||
    (cond.kind === "yourTurn" && game.turn.active === ctx.controller) ||
    (cond.kind === "notYourTurn" && game.turn.active !== ctx.controller) ||
    (cond.kind === "selfUntapped" && sourceCard && !sourceCard.tapped) ||
    (cond.kind === "counterPutThisTurn" && game.turn.counterPut?.[ctx.controller] === game.turn.number) ||
    (cond.kind === "controlsCount" && mine.filter(card => typeMatches(defOf(game, card), cond.what) || hasSubtype(defOf(game, card), cond.what)).length >= cond.n) ||
    (cond.kind === "castCount" && controller.castTurn === game.turn.number && (cond.noncreature ? controller.noncreatureCasts ?? 0 : controller.castsThisTurn ?? 0) >= cond.n) ||
    (cond.kind === "oppGraveyard" && game.seats.some(id => id !== ctx.controller && game.players[id].graveyard.length >= cond.n))
  );
}

/** Wertet eine Mengenangabe aus (siehe quantity.js). */
function evalQuantity(game, ctx, q) {
  const me = game.players[ctx.controller];
  const source = ctx.source ? game.cards[ctx.source] : null;
  const itCard = () => (ctx.subjectCard && game.cards[ctx.subjectCard]) || (ctx.targets?.[0] && game.cards[ctx.targets[0]]) || source;
  const statOf = (card, stat, snapId) => {
    const snap = snapId ? ctx.snap?.[snapId] : null;
    if (!card) return snap ? snap[stat] ?? 0 : 0;
    const def = defOf(game, card);
    if (stat === "mv") return def.manaValue ?? snap?.mv ?? 0;
    if (onBattlefield(game, card.id) && def.types.creature) return stat === "power" ? powerOf(game, card) : toughnessOf(game, card);
    return snap?.[stat] ?? (stat === "power" ? def.power ?? 0 : def.toughness ?? 0);
  };
  let value = 0;
  switch (q.kind) {
    case "stat": {
      const card = q.ref === "self" ? source : q.ref === "sacrificed" ? (ctx.sacrificed ? game.cards[ctx.sacrificed] : null) : q.ref === "attached" ? (source?.attachedTo ? game.cards[source.attachedTo] : null) : itCard();
      value = statOf(card, q.stat, q.ref === "sacrificed" ? ctx.sacrificed : card?.id);
      break;
    }
    case "opponents": value = alive(game).filter(id => id !== ctx.controller).length; break;
    case "lifeLost": value = ctx.lifeLost ?? 0; break;
    case "oppAttacked": value = game.turn.attackedOpponents?.[ctx.controller]?.length ?? 0; break;
    case "zone": value = (q.zone === "hand" ? me.hand : me.graveyard).filter(id => !q.type || (q.type === "instant and sorcery" ? defOf(game, game.cards[id]).types.instant || defOf(game, game.cards[id]).types.sorcery : typeMatches(defOf(game, game.cards[id]), q.type))).length; break;
    case "counters": {
      const card = q.ref === "self" ? source : itCard();
      value = card ? (q.counter === "any" ? Object.values(card.counters).reduce((a, b) => a + b, 0) : card.counters[q.counter] ?? 0) : 0;
      break;
    }
    case "greatest": {
      const ids = me.battlefield.filter(id => typeMatches(defOf(game, game.cards[id]), q.what) && !(q.other && id === ctx.source));
      value = Math.max(0, ...ids.map(id => statOf(game.cards[id], q.stat)));
      break;
    }
    case "distinctLands": value = new Set(me.battlefield.filter(id => defOf(game, game.cards[id]).types.land).map(id => defOf(game, game.cards[id]).name)).size; break;
    case "attacking": value = (game.combat?.attackers ?? []).filter(attacker => game.cards[attacker.id]?.owner === ctx.controller).length; break;
    case "count": {
      const owners = q.who === "you" ? [ctx.controller] : q.who === "opp" ? game.seats.filter(id => id !== ctx.controller) : q.who === "subject" ? [ctx.subject ?? game.cards[ctx.targets?.[0]]?.owner ?? ctx.targets?.[0]].filter(Boolean) : game.seats;
      value = validTargets(game, { ...q.spec, ctrl: undefined }, ctx.controller, { colors: [], id: ctx.source }).filter(id => game.cards[id] && owners.includes(game.cards[id].owner)).length;
      break;
    }
    default: value = 0;
  }
  return Math.max(0, value * (q.mult ?? 1));
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
    case "card in your graveyard": return mine.graveyard.length;
    case "land card in your graveyard": return mine.graveyard.filter(id => defOf(game, game.cards[id]).types.land).length;
    case "artifact card in your graveyard": return mine.graveyard.filter(id => defOf(game, game.cards[id]).types.artifact).length;
    case "creature card in your graveyard": return mine.graveyard.filter(id => defOf(game, game.cards[id]).types.creature).length;
    case "artifact your opponents control": return game.seats.filter(id => id !== ctx.controller).reduce((sum, id) => sum + ofType(game.players[id].battlefield, "artifact"), 0);
    case "land your opponents control": return game.seats.filter(id => id !== ctx.controller).reduce((sum, id) => sum + ofType(game.players[id].battlefield, "land"), 0);
    case "other creature you control": return ofType(mine.battlefield, "creature") - (ctx.source && mine.battlefield.includes(ctx.source) && defOf(game, game.cards[ctx.source]).types.creature ? 1 : 0);
    case "opponent": return alive(game).filter(id => id !== ctx.controller).length;
    case "attacking creature": return game.combat?.attackers?.length ?? 0;
    case "creature you control with a +1/+1 counter": return mine.battlefield.filter(id => defOf(game, game.cards[id]).types.creature && (game.cards[id].counters["+1/+1"] ?? 0) > 0).length;
    default: return 0;
  }
}

function runEffect(game, rawEffect, ctx, rest) {
  // X: berechnete Menge („where X is …“) oder der beim Wirken gewählte Wert.
  if (rawEffect.xRef) {
    const value = evalQuantity(game, ctx, rawEffect.xRef);
    const fill = v => (v === "X" ? value : v === "-X" ? -value : v);
    rawEffect = { ...rawEffect, n: rawEffect.n === "X" ? value * (rawEffect.negate ? -1 : 1) : fill(rawEffect.n), p: fill(rawEffect.p), th: fill(rawEffect.th), ...(rawEffect.count !== undefined ? { count: fill(rawEffect.count) } : {}), xRef: undefined };
  } else if (rawEffect.p === "X" || rawEffect.th === "X" || rawEffect.p === "-X" || rawEffect.th === "-X") {
    const value = Math.max(0, ctx.x ?? 0);
    const fill = v => (v === "X" ? value : v === "-X" ? -value : v);
    rawEffect = { ...rawEffect, p: fill(rawEffect.p), th: fill(rawEffect.th) };
  }
  let effect = rawEffect.n === "X" ? { ...rawEffect, n: Math.max(0, ctx.x ?? 0) * (rawEffect.negate ? -1 : 1) } : rawEffect;
  if (effect.per) effect = { ...effect, n: effect.n * perCount(game, ctx, effect.per) };
  if (effect.perQ) effect = { ...effect, n: effect.n * evalQuantity(game, ctx, effect.perQ), perQ: undefined };
  const ref = effect.xFrom ?? effect.nFrom;
  if (ref) {
    const targetId = ctx.targets[ref.t];
    const info = ctx.snap?.[targetId] ?? snapshotTargets(game, [targetId])[targetId] ?? {};
    let value = info[ref.stat] ?? 0;
    if (ref.cast) value = (ctx.castInfo?.[ref.cast] ?? 0) * (ref.mult ?? 1);
    if (ref.digMv) value = ctx.digMv ?? 0;
    if (ref.damage) value = ctx.damage ?? 0;
    if (ref.discarded) value = ctx.discarded ?? 0;
    effect = { ...effect, n: ref.negate ? -value : value };
  }
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
      if (effect.onlyFromExile && !ctx.castInfo?.fromExile) return false;
      for (const id of playersOf(game, effect.who, ctx)) {
        game.players[id].life += effect.n;
        if (effect.n < 0) ctx.lifeLost = (ctx.lifeLost ?? 0) - effect.n;
        if (effect.n > 0) {
          noteLifeGain(game, id, effect.n);
          fireGlobal(game, "youGainLife", id);
        }
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
          ctx.discarded = (ctx.discarded ?? 0) + gone.length;
          fireDiscards(game, gone);
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
      if (effect.nFromDamage) effect = { ...effect, n: Math.max(0, ctx.damage ?? 0) };
      if (to.k === "eachOtherOpp") for (const id of alive(game).filter(p => p !== ctx.controller && p !== ctx.subject)) dealDamage(game, source, id, effect.n);
      if (to.k === "target") dealDamage(game, source, ctx.targets[to.t], effect.n);
      else if (to.k === "you") dealDamage(game, source, ctx.controller, effect.n);
      else if (to.k === "eachOpp") for (const id of alive(game).filter(p => p !== ctx.controller)) dealDamage(game, source, id, effect.n);
      else if (to.k === "each") for (const id of alive(game)) dealDamage(game, source, id, effect.n);
      else if (to.k === "flyingAndPlayers") {
        for (const userId of game.seats) for (const id of [...game.players[userId].battlefield]) if (defOf(game, game.cards[id]).types.creature && hasKeyword(game, game.cards[id], "flying")) dealDamage(game, source, id, effect.n);
        for (const id of alive(game)) dealDamage(game, source, id, effect.n);
      } else if (to.k === "everything") {
        for (const userId of game.seats) for (const id of [...game.players[userId].battlefield]) if (defOf(game, game.cards[id]).types.creature) dealDamage(game, source, id, effect.n);
        for (const id of alive(game)) dealDamage(game, source, id, effect.n);
      } else {
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
      const decider = effect.who ? playersOf(game, effect.who, ctx)[0] : ctx.controller;
      if (!decider) return false;
      return openChoice(game, {
        userId: decider,
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
        if (effect.greatest) {
          const best = Math.max(...options.map(id => powerOf(game, game.cards[id])));
          const strongest = options.filter(id => powerOf(game, game.cards[id]) === best);
          options.splice(0, options.length, ...strongest);
        }
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
          queue: remaining.length > 0 ? [{ type: "sacrifice", who: { k: "ids", ids: remaining }, what: effect.what, greatest: effect.greatest }, ...rest] : rest,
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
      const holder = card ? (effect.anyGraveyard ? game.seats.map(id => game.players[id]).find(p => p.graveyard.includes(card.id)) : controller.graveyard.includes(card.id) ? controller : null) : null;
      if (!card || !holder) return false;
      holder.graveyard.splice(holder.graveyard.indexOf(card.id), 1);
      if (effect.to === "top") {
        holder.library.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt aus dem Friedhof oben auf die Bibliothek (${name}).`);
        return false;
      }
      if (effect.to === "hand") {
        controller.hand.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt aus dem Friedhof auf die Hand (${name}).`);
        return false;
      }
      controller.battlefield.push(card.id);
      card.owner = ctx.controller; // der Besitzer bleibt (origOwner); du kontrollierst die Karte
      enterBattlefield(game, card);
      if (effect.tapped) card.tapped = true;
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
    case "destroyAll": {
      const kinds = Array.isArray(effect.what) ? effect.what : [effect.what];
      for (const userId of game.seats) {
        for (const id of [...game.players[userId].battlefield]) {
          const c = game.cards[id];
          if (!c) continue;
          const def = defOf(game, c);
          if (!kinds.some(kind => typeMatches(def, kind))) continue;
          if (effect.nontoken && c.token) continue;
          if (effect.nonTypes?.some(type => def.types[type])) continue;
          if (effect.exceptMade && (ctx.madeTokens ?? []).includes(id)) continue;
          if (effect.onlyTapped && !c.tapped) continue;
          if (effect.subtype && !hasSubtype(def, effect.subtype)) continue;
          if (effect.nonSubtype && hasSubtype(def, effect.nonSubtype)) continue;
          if (effect.noCounters && Object.values(c.counters).some(value => value > 0)) continue;
          if (effect.oppOnly && c.owner === ctx.controller) continue;
          if (effect.filter) {
            const value = effect.filter.of === "power" ? powerOf(game, c) : effect.filter.of === "toughness" ? toughnessOf(game, c) : def.manaValue ?? 0;
            const limit = effect.filter.n === "X" ? ctx.x ?? 0 : effect.filter.n;
            if (effect.filter.op === "gte" ? value < limit : value > limit) continue;
          }
          if (effect.mode === "exile") leaveTo(game, c, "exile");
          else destroyCard(game, c);
        }
      }
      return false;
    }
    case "exile":
      if (targetCard) {
        addLog(game, `${nameOf(game, targetCard.id)} wird ins Exil geschickt (${name}).`);
        const keep = effect.until && sourceCard && onBattlefield(game, sourceCard.id);
        const exiledId = targetCard.id;
        const isToken = targetCard.token;
        leaveTo(game, targetCard, "exile");
        if (!isToken) ctx.lastExiled = [exiledId];
        if (keep && !isToken) sourceCard.exiledIds = [...(sourceCard.exiledIds ?? []), exiledId];
      }
      return false;
    case "tuck":
      if (targetCard && onBattlefield(game, targetCard.id)) {
        addLog(game, `${nameOf(game, targetCard.id)} kommt ${effect.pos === "top" ? "oben auf" : "unter"} die Bibliothek (${name}).`);
        const owner = game.players[targetCard.origOwner ?? targetCard.owner];
        const isToken = targetCard.token;
        leaveTo(game, targetCard, "library");
        if (!isToken && effect.pos === "bottom") {
          owner.library.pop();
          owner.library.unshift(targetCard.id);
        }
      }
      return false;
    case "exileAllGraveyards": {
      for (const id of game.seats) {
        const holder = game.players[id];
        holder.exile.push(...holder.graveyard);
        holder.graveyard = [];
      }
      addLog(game, `Alle Friedhöfe werden ins Exil geschickt (${name}).`);
      return false;
    }
    case "exileGraveyard": {
      const id = ctx.targets[effect.t];
      const player = game.players[id];
      if (!player) return false;
      const count = player.graveyard.length;
      player.exile.push(...player.graveyard);
      player.graveyard = [];
      addLog(game, `Der Friedhof von ${player.name} wird ins Exil geschickt (${count} Karte${count === 1 ? "" : "n"}, ${name}).`);
      return false;
    }
    case "discardHand": {
      let greatest = 0;
      for (const id of playersOf(game, effect.who, ctx)) {
        const player = game.players[id];
        const count = player.hand.length;
        greatest = Math.max(greatest, count);
        player.graveyard.push(...player.hand);
        player.hand = [];
        ctx.discarded = (ctx.discarded ?? 0) + count;
        addLog(game, `${player.name} wirft die ganze Hand ab (${count} Karte${count === 1 ? "" : "n"}, ${name}).`);
      }
      if (effect.drawGreatest) for (const id of playersOf(game, effect.who, ctx)) drawCards(game, id, greatest);
      return false;
    }
    case "ifCounterThisTurn": {
      if (sourceCard?.counterTurn !== game.turn.number) return false;
      for (let i = 0; i < effect.effects.length; i += 1) if (runEffect(game, effect.effects[i], ctx, [...effect.effects.slice(i + 1), ...rest])) return true;
      return false;
    }
    case "goad": {
      const ids = effect.all
        ? game.seats.filter(id => id !== ctx.controller).flatMap(id => game.players[id].battlefield).filter(id => defOf(game, game.cards[id]).types.creature)
        : effect.eachOfTarget !== undefined
          ? (game.players[ctx.targets[effect.eachOfTarget]]?.battlefield ?? []).filter(id => defOf(game, game.cards[id]).types.creature)
          : effect.subjectCard
            ? [ctx.subjectCard].filter(Boolean)
            : [ctx.targets[effect.t]].filter(Boolean);
      for (const id of ids) {
        const card = game.cards[id];
        if (!card || !onBattlefield(game, id)) continue;
        card.goadedBy = [...new Set([...(card.goadedBy ?? []), ctx.controller])];
      }
      addLog(game, `${name}: ${ids.length} Kreatur(en) aufgestachelt.`);
      return false;
    }
    case "tapEach": {
      const pool = effect.ofTarget !== undefined ? game.players[ctx.targets[effect.ofTarget]]?.battlefield ?? [] : game.seats.flatMap(id => game.players[id].battlefield);
      const hits = pool.filter(id => {
        const c = game.cards[id];
        if (effect.spec.kind === "myCreature" && c.owner !== ctx.controller) return false;
        return subjectMatches(game, c, effect.spec, sourceCard ?? { owner: ctx.controller, id: ctx.source });
      });
      for (const id of hits) game.cards[id].tapped = !effect.untap;
      addLog(game, `${name}: ${hits.length} Permanent(s) ${effect.untap ? "enttappt" : "getappt"}.`);
      return false;
    }
    case "countersEach": {
      const holders = game.seats.map(id => game.players[id]);
      const hits = holders.flatMap(holder => [...holder.battlefield]).filter(id => {
        const c = game.cards[id];
        if (effect.spec.kind === "myCreature" && c.owner !== ctx.controller) return false;
        return subjectMatches(game, c, effect.spec, sourceCard ?? { owner: ctx.controller, id: ctx.source });
      });
      for (const id of hits) {
        const c = game.cards[id];
        c.counters[effect.kind] = Math.min(MAX_COUNTERS, (c.counters[effect.kind] ?? 0) + counterAmount(game, c, effect.kind, effect.n));
        fireCountersPut(game, c, effect.kind);
        c.counterTurn = game.turn.number;
      }
      addLog(game, `${hits.length} Permanent(s) erhalten ${effect.n}× ${effect.kind} (${name}).`);
      return false;
    }
    case "countersAll": {
      const holders = effect.opp ? game.seats.filter(id => id !== ctx.controller).map(id => game.players[id]) : [controller];
      for (const id of holders.flatMap(holder => [...holder.battlefield])) {
        const c = game.cards[id];
        if (!defOf(game, c).types.creature || (effect.other && c.id === ctx.source)) continue;
        if (effect.subtype && !hasSubtype(defOf(game, c), effect.subtype)) continue;
        if (effect.attacking && !game.combat?.attackers?.some(attacker => attacker.id === c.id)) continue;
        c.counters[effect.kind] = Math.min(MAX_COUNTERS, (c.counters[effect.kind] ?? 0) + counterAmount(game, c, effect.kind, effect.n));
        fireCountersPut(game, c, effect.kind);
        c.counterTurn = game.turn.number;
      }
      addLog(game, `Jede ${effect.other ? "andere " : ""}Kreatur von ${controller.name} erhält ${effect.n}× ${effect.kind} (${name}).`);
      return false;
    }
    case "digUntil": {
      const revealed = [];
      let found = null;
      while (controller.library.length > 0) {
        const id = controller.library.pop();
        if (typeMatches(defOf(game, game.cards[id]), effect.what)) {
          found = id;
          break;
        }
        revealed.push(id);
      }
      shuffle(revealed);
      controller.library.unshift(...revealed); // der Rest unter die Bibliothek, in zufälliger Reihenfolge
      if (found) {
        controller.hand.push(found);
        ctx.digMv = defOf(game, game.cards[found]).manaValue ?? 0;
        addLog(game, `${controller.name} deckt ${revealed.length + 1} Karten auf und nimmt ${nameOf(game, found)} auf die Hand (${name}).`);
      } else addLog(game, `${controller.name} deckt die Bibliothek auf, findet aber keine passende Karte (${name}).`);
      return false;
    }
    case "digRest":
      return false;
    case "regenerate": {
      const card = effect.self ? sourceCard : targetCard;
      if (card) {
        card.regen = true;
        addLog(game, `${nameOf(game, card.id)} erhält einen Regenerationsschild bis zum Zugende (${name}).`);
      }
      return false;
    }
    case "prevent": {
      const id = ctx.targets[effect.t];
      const holder = game.players[id] ?? game.cards[id];
      if (holder) {
        holder.shield = (holder.shield ?? 0) + effect.n;
        addLog(game, `Die nächsten ${effect.n} Schaden an ${game.players[id]?.name ?? nameOf(game, id)} werden in diesem Zug verhindert (${name}).`);
      }
      return false;
    }
    case "noCombat": {
      const card = game.cards[ctx.targets[effect.t]];
      if (card) card.noCombat = true;
      return false;
    }
    case "counterTo":
      return false;
    case "flicker": {
      const card = targetCard;
      if (!card || !onBattlefield(game, card.id)) return false;
      const ownerId = card.origOwner ?? card.owner;
      const returnTo = effect.control === "you" ? ctx.controller : ownerId;
      const isToken = card.token;
      leaveTo(game, card, "exile");
      if (isToken) return false;
      const owner = game.players[ownerId];
      owner.exile.splice(owner.exile.indexOf(card.id), 1);
      game.players[returnTo].battlefield.push(card.id);
      card.owner = returnTo;
      enterBattlefield(game, card);
      addLog(game, `${nameOf(game, card.id)} wird exiliert und kommt sofort zurück (${name}).`);
      return false;
    }
    case "grantAll": {
      for (const id of [...controller.battlefield]) {
        const c = game.cards[id];
        if (effect.what === "creature" && !defOf(game, c).types.creature) continue;
        if (effect.withCounter && !Object.values(c.counters).some(value => value > 0)) continue;
        c.tk = [...(c.tk ?? []), ...effect.kws];
      }
      addLog(game, `Deine ${effect.what === "permanent" ? "Permanents" : "Kreaturen"} erhalten ${effect.kws.join(", ")} bis zum Zugende (${name}).`);
      return false;
    }
    case "bounceOwn": {
      const options = controller.battlefield.filter(id => {
        const types = defOf(game, game.cards[id]).types;
        return effect.what === "permanent" ? true : types[effect.what];
      });
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle ${effect.what === "permanent" ? "ein Permanent" : "eines deiner Permanents"}, das zurück auf die Hand geht.`,
        options,
        min: 1,
        max: 1,
        step: { type: "bounceLand" },
        queue: rest,
        ctx
      });
    }
    case "tapOrUntap": {
      if (!targetCard) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "yesno",
        prompt: `${name}: ${nameOf(game, targetCard.id)} tappen oder enttappen?`,
        labels: { yes: "Tappen", no: "Enttappen" },
        options: ["yes", "no"],
        min: 1,
        max: 1,
        step: { type: "tapOrUntap", id: targetCard.id },
        queue: rest,
        ctx
      });
    }
    case "payGate":
    case "mayPay": {
      const payerId = effect.payer ? playersOf(game, effect.payer, ctx)[0] : ctx.controller;
      if (!payerId) return false;
      const plan = planPayment({ manaCost: effect.cost, pool: game.players[payerId].pool, sources: manaSources(game, payerId) });
      if (!plan.ok) {
        // wer nicht zahlen kann: „unless pays“ → Effekt läuft; „may pay“ → nichts
        if (effect.type === "mayPay") ctx.didMay = false;
        else for (let i = 0; i < effect.effects.length; i += 1) if (runEffect(game, effect.effects[i], ctx, [...effect.effects.slice(i + 1), ...rest])) return true;
        return false;
      }
      return openChoice(game, {
        userId: payerId,
        kind: "yesno",
        prompt: effect.type === "mayPay" ? `${name}: ${effect.cost} zahlen?` : `${name}: ${effect.cost} zahlen, damit der Effekt ausbleibt?`,
        labels: { yes: `${effect.cost} bezahlen`, no: "Nicht bezahlen" },
        options: ["yes", "no"],
        min: 1,
        max: 1,
        step: { type: "payGate", cost: effect.cost, payerId, effects: effect.effects ?? [], mode: effect.type },
        queue: rest,
        ctx
      });
    }
    case "namedToken": {
      const template = NAMED_TOKENS[effect.name];
      if (!template) return false;
      if (effect.forTargetController !== undefined) {
        const targetId = ctx.targets[effect.forTargetController];
        const stackItem = ctx.snap?.[targetId];
        const recipient = game.cards[targetId]?.owner ?? stackItem?.controller ?? game.stack.find(item => item.sid === targetId)?.controller ?? ctx.targetController;
        if (recipient && game.players[recipient]) {
          for (let i = 0; i < effect.n; i += 1) createToken(game, recipient, { name: effect.name, power: null, toughness: null, artifact: true, ...template });
          addLog(game, `${game.players[recipient].name} erzeugt ${effect.n}× ${effect.name}-Spielstein (${name}).`);
        }
        return false;
      }
      let made = 0;
      for (let i = 0; i < effect.n; i += 1) {
        const tokenId = createToken(game, ctx.controller, { name: effect.name, power: null, toughness: null, artifact: true, ...template });
        if (!tokenId) continue;
        made += 1;
        if (effect.tapped) game.cards[tokenId].tapped = true;
      }
      addLog(game, `${controller.name} erzeugt ${made}× ${effect.name}-Spielstein (${name}).`);
      return false;
    }
    case "manaAny":
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle die Farbe des Manas.`,
        options: ["W", "U", "B", "R", "G"].map(color => `color:${color}`),
        labels: { "color:W": "Weiß", "color:U": "Blau", "color:B": "Schwarz", "color:R": "Rot", "color:G": "Grün" },
        min: 1,
        max: 1,
        step: { type: "manaAny", n: effect.n ?? 1 },
        queue: rest,
        ctx
      });
    case "putBack": {
      const options = [...controller.hand];
      if (options.length === 0) return false;
      const count = Math.min(effect.n, options.length);
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle ${count} Karte${count === 1 ? "" : "n"} von der Hand, die oben auf die Bibliothek kommen (zuerst Gewählte liegen unten).`,
        options,
        min: count,
        max: count,
        step: { type: "putBack" },
        queue: rest,
        ctx
      });
    }
    case "revealHand": {
      const id = ctx.targets[effect.t];
      if (!game.players[id]) return false;
      ctx.revealFrom = id;
      addLog(game, `${game.players[id].name} zeigt die Hand: ${game.players[id].hand.map(card => nameOf(game, card)).join(", ") || "leer"} (${name}).`);
      return false;
    }
    case "chooseFromRevealed": {
      const from = ctx.revealFrom ? game.players[ctx.revealFrom] : null;
      if (!from) return false;
      const options = from.hand.filter(id => {
        const types = defOf(game, game.cards[id]).types;
        return !effect.exclude.some(type => types[type]);
      });
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle eine Karte aus der Hand von ${from.name}.`,
        options,
        min: 1,
        max: 1,
        step: { type: "chooseRevealed" },
        queue: rest,
        ctx
      });
    }
    case "discardChosen": {
      const from = ctx.revealFrom ? game.players[ctx.revealFrom] : null;
      const id = ctx.chosenCard;
      if (!from || !id || !from.hand.includes(id)) return false;
      from.hand.splice(from.hand.indexOf(id), 1);
      from.graveyard.push(id);
      addLog(game, `${from.name} wirft ${nameOf(game, id)} ab (${name}).`);
      return false;
    }
    case "revealTop": {
      const id = controller.library.at(-1);
      ctx.rev = id ?? null;
      ctx.revDone = false;
      if (id) addLog(game, `${controller.name} deckt ${nameOf(game, id)} auf (${name}).`);
      return false;
    }
    case "revealIf": {
      const id = ctx.rev;
      if (!id || !controller.library.includes(id)) return false;
      if (typeMatches(defOf(game, game.cards[id]), effect.what)) {
        controller.library.splice(controller.library.indexOf(id), 1);
        controller.battlefield.push(id);
        enterBattlefield(game, game.cards[id]);
        ctx.revDone = true;
        addLog(game, `${nameOf(game, id)} kommt aufs Schlachtfeld (${name}).`);
      }
      return false;
    }
    case "revealElse": {
      const id = ctx.rev;
      if (!id || ctx.revDone || !controller.library.includes(id)) return false;
      controller.library.splice(controller.library.indexOf(id), 1);
      controller.hand.push(id);
      addLog(game, `${nameOf(game, id)} kommt auf die Hand (${name}).`);
      return false;
    }
    case "bite":
    case "fight": {
      const aId = ctx.targets[effect.type === "bite" ? effect.from : effect.a];
      const bId = ctx.targets[effect.type === "bite" ? effect.to : effect.b];
      const a = game.cards[aId];
      const b = game.cards[bId];
      if (!a || !b || !onBattlefield(game, aId) || !onBattlefield(game, bId)) return false;
      const dmg = Math.max(0, powerOf(game, a));
      const trample = effect.type === "bite" && rest.some(item => item.type === "biteTrample") && hasKeyword(game, a, "trample");
      const lethalLeft = Math.max(0, toughnessOf(game, b) - b.damage);
      inflictDamage(game, a, bId, dmg);
      if (trample && dmg > lethalLeft) inflictDamage(game, a, b.owner, dmg - lethalLeft);
      if (effect.type === "fight") inflictDamage(game, b, aId, Math.max(0, powerOf(game, b)));
      addLog(game, `${nameOf(game, aId)} ${effect.type === "fight" ? "kämpft gegen" : "beißt"} ${nameOf(game, bId)} (${name}).`);
      return false;
    }
    case "biteTrample":
      return false;
    case "returnSelf": {
      const card = sourceCard;
      if (!card) return false;
      const owner = game.players[card.origOwner ?? card.owner];
      const index = owner.graveyard.indexOf(card.id);
      if (index === -1) return false;
      owner.graveyard.splice(index, 1);
      owner.hand.push(card.id);
      addLog(game, `${nameOf(game, card.id)} kehrt auf die Hand zurück (${name}).`);
      return false;
    }
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
    case "copySpell": {
      const original = effect.subject
        ? [...game.stack].reverse().find(item => item.kind === "spell" && item.cardId === ctx.subjectCard)
        : game.stack.find(item => item.sid === ctx.targets[effect.t]);
      const cardDef = original?.cardId ? defOf(game, game.cards[original.cardId]) : null;
      if (!original || !cardDef || !(cardDef.types.instant || cardDef.types.sorcery)) return false;
      for (let i = 0; i < effect.n && game.stack.length < MAX_STACK; i += 1) {
        game.stack.push({ ...original, sid: newId(game, "s"), controller: ctx.controller, copy: true, targets: [...(original.targets ?? [])] });
        addLog(game, `${controller.name} kopiert ${cardDef.name} (${name}).`);
      }
      game.passed = [];
      return false;
    }
    case "counterSpell": {
      const index = game.stack.findIndex(item => item.sid === ctx.targets[effect.t]);
      if (index !== -1) ctx.targetController = game.stack[index].controller;
      if (index !== -1 && game.stack[index].cardId && defOf(game, game.cards[game.stack[index].cardId]).rules?.uncounterable) {
        addLog(game, `${nameOf(game, game.stack[index].cardId)} kann nicht neutralisiert werden.`);
        return false;
      }
      if (index !== -1 && effect.unlessPay) {
        const payer = game.stack[index].controller;
        const plan = planPayment({ manaCost: effect.unlessPay, pool: game.players[payer].pool, sources: manaSources(game, payer) });
        if (plan.ok) {
          return openChoice(game, {
            userId: payer,
            kind: "yesno",
            prompt: `${name}: ${effect.unlessPay} bezahlen, damit dein Zauber nicht neutralisiert wird?`,
            labels: { yes: `${effect.unlessPay} bezahlen`, no: "Nicht bezahlen (neutralisiert)" },
            options: ["yes", "no"],
            min: 1,
            max: 1,
            step: { type: "unlessPay", sid: ctx.targets[effect.t], cost: effect.unlessPay, sourceName: name },
            queue: rest,
            ctx
          });
        }
      }
      if (index !== -1) {
        const [item] = game.stack.splice(index, 1);
        if (item.cardId && game.cards[item.cardId]) {
          const marker = rest.find(entry => entry.type === "counterTo");
          const spellCard = game.cards[item.cardId];
          if (marker && !spellCard.token) {
            const owner = game.players[spellCard.origOwner ?? spellCard.owner];
            if (marker.to === "top") owner.library.push(spellCard.id);
            else owner.hand.push(spellCard.id);
            addLog(game, `${nameOf(game, spellCard.id)} wird neutralisiert und ${marker.to === "top" ? "oben auf die Bibliothek" : "auf die Hand"} gelegt (${name}).`);
          } else {
            addLog(game, `${nameOf(game, item.cardId)} wird neutralisiert (${name}).`);
            toGraveyard(game, spellCard, "stack");
            offerCommanderReturn(game, spellCard, "graveyard");
          }
        }
      }
      return false;
    }
    case "counters": {
      const card = effect.subjectCard ? game.cards[ctx.subjectCard] : effect.self ? sourceCard : targetCard;
      if (card && onBattlefield(game, card.id)) {
        card.counters[effect.kind] = Math.min(MAX_COUNTERS, (card.counters[effect.kind] ?? 0) + counterAmount(game, card, effect.kind, effect.n));
        fireCountersPut(game, card, effect.kind);
        if (effect.n > 0) card.counterTurn = game.turn.number;
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
      const xv = effect.xPer ? perCount(game, ctx, effect.xPer) : 0;
      if (effect.p === "X") effect = { ...effect, p: xv };
      if (effect.th === "X") effect = { ...effect, th: xv };
      for (const userId of game.seats) {
        if ((scope === "you" && userId !== ctx.controller) || (scope === "opp" && userId === ctx.controller)) continue;
        for (const id of game.players[userId].battlefield) {
          const c = game.cards[id];
          if (effect.anyOf && !effect.anyOf.some(word => hasSubtype(defOf(game, c), word))) continue;
          if (effect.attackingOnly && !game.combat?.attackers?.some(attacker => attacker.id === c.id)) continue;
          if (effect.nonType && defOf(game, c).types[effect.nonType]) continue;
          if (effect.spec && !passesSpecFilter(game, id, effect.spec, ctx.controller, sourceCard ?? { id: ctx.source })) continue;
          if (defOf(game, c).types.creature) {
            c.tp = (c.tp ?? 0) + effect.p;
            c.tt = (c.tt ?? 0) + effect.th;
            if (effect.kws?.length) c.tk = [...(c.tk ?? []), ...effect.kws];
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
        const tokenId = createToken(game, effect.forWho ? playersOf(game, effect.forWho, ctx)[0] ?? ctx.controller : ctx.controller, { name: effect.name, power: effect.p, toughness: effect.th, artifact: effect.artifact, keywords: effect.keywords ?? [] });
        if (tokenId) {
          made += 1;
          if (effect.tapped && game.cards[tokenId]) game.cards[tokenId].tapped = true;
          if (effect.attacking && game.combat && game.cards[tokenId]) {
            // greift denselben Spieler an wie die Quelle, sonst den ersten Gegner (Regel 508.4: wird nicht „angreifend erklärt“)
            const target = game.combat.attackers.find(attacker => attacker.id === ctx.source)?.target ?? alive(game).find(id => id !== game.cards[tokenId].owner);
            if (target) game.combat.attackers.push({ id: tokenId, target });
          }
          ctx.lastToken = tokenId;
          ctx.madeTokens = [...(ctx.madeTokens ?? []), tokenId];
        }
      }
      addLog(game, `${controller.name} erzeugt ${made}× ${effect.name} ${effect.p}/${effect.th} (${name}).`);
      return false;
    }
    case "search": {
      const actorId = effect.forWho ? playersOf(game, effect.forWho, ctx)[0] : ctx.controller;
      if (!actorId) return false;
      const actor = game.players[actorId];
      const options = actor.library.filter(id => typeMatches(defOf(game, game.cards[id]), effect.what));
      shuffle(actor.library);
      addLog(game, `${actor.name} durchsucht die Bibliothek (${name}).`);
      if (options.length === 0) return false;
      const count = Math.min(effect.count ?? 1, options.length);
      return openChoice(game, {
        userId: actorId,
        kind: "cards",
        prompt: `Wähle ${count > 1 ? `bis zu ${count} Karten` : "eine Karte"} (${String(effect.what) === "card" ? "beliebig" : String(effect.what).replace(/\|/g, " oder ")}) aus deiner Bibliothek (${name}).`,
        options,
        min: 0,
        max: count,
        step: { type: "search", to: effect.to, tapped: effect.tapped, sameType: effect.sameType, untapIf: rest.find(item => item.type === "searchUntapIf")?.n },
        queue: rest,
        ctx
      });
    }
    case "tuckSelf": {
      const card = sourceCard;
      if (!card) return false;
      const owner = game.players[card.origOwner ?? card.owner];
      for (const zone of ZONES) {
        const index = owner[zone].indexOf(card.id);
        if (index !== -1 && zone !== "library") owner[zone].splice(index, 1);
      }
      if (!owner.library.includes(card.id)) owner.library.unshift(card.id);
      addLog(game, `${nameOf(game, card.id)} kommt unter die Bibliothek (${name}).`);
      return false;
    }
    case "untapAllMine": {
      for (const id of controller.battlefield) if (typeMatches(defOf(game, game.cards[id]), effect.what)) game.cards[id].tapped = false;
      addLog(game, `${controller.name} enttappt alle Kreaturen (${name}).`);
      return false;
    }
    case "topLandMay": {
      const top = controller.library[controller.library.length - 1];
      if (top === undefined || !defOf(game, game.cards[top]).types.land) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "yesno",
        prompt: `${name}: Oben liegt ${nameOf(game, top)}. Aufs Schlachtfeld legen${effect.tapped ? " (getappt)" : ""}?`,
        options: ["yes", "no"],
        labels: { yes: "Aufs Schlachtfeld", no: "Liegen lassen" },
        min: 1,
        max: 1,
        step: { type: "topLand", id: top, tapped: effect.tapped },
        queue: rest,
        ctx
      });
    }
    case "attachTargetTo": {
      const gear = game.cards[ctx.targets[effect.t]];
      const holder = game.cards[ctx.targets[effect.to]];
      if (!gear || !holder || !onBattlefield(game, gear.id) || !onBattlefield(game, holder.id)) return false;
      gear.attachedTo = holder.id;
      addLog(game, `${nameOf(game, gear.id)} wird an ${nameOf(game, holder.id)} angehängt (${name}).`);
      return false;
    }
    case "attachToSelf": {
      const gear = game.cards[ctx.targets[effect.t]];
      if (!gear || !sourceCard || !onBattlefield(game, gear.id) || !onBattlefield(game, sourceCard.id)) return false;
      gear.attachedTo = sourceCard.id;
      addLog(game, `${nameOf(game, gear.id)} wird an ${nameOf(game, sourceCard.id)} angehängt (${name}).`);
      return false;
    }
    case "freeCast":
    case "freeCastFromHand":
    case "freeCastLast": {
      const ids =
        effect.type === "freeCast" ? [ctx.targets[effect.t]].filter(Boolean)
        : effect.type === "freeCastLast" ? (ctx.lastExiled ?? [])
        : controller.hand.filter(id => {
          const def = defOf(game, game.cards[id]);
          if (def.types.land || (def.manaValue ?? 0) > effect.mvMax) return false;
          return !effect.what || typeMatches(def, effect.what) || (effect.what === "instant or sorcery" && (def.types.instant || def.types.sorcery));
        });
      const group = newId(game, "f");
      for (const id of ids) if (game.cards[id]) game.cards[id].freeCast = { by: ctx.controller, turn: game.turn.number, group };
      ctx.freeGroup = group;
      if (ids.length > 0) addLog(game, `${controller.name} darf ${ids.length === 1 ? nameOf(game, ids[0]) : "einen passenden Zauber"} in diesem Zug ohne Manakosten wirken (${name}).`);
      return false;
    }
    case "freeCastExile": {
      for (const card of Object.values(game.cards)) if (card.freeCast?.group === ctx.freeGroup) card.freeCast.exileAfter = true;
      return false;
    }
    case "copyOf": {
      const ref = effect.source;
      const original = ref.k === "self" ? sourceCard : ref.k === "target" ? game.cards[ctx.targets[ref.t]] : (ctx.madeTokens?.length ? game.cards[ctx.madeTokens.at(-1)] : null) ?? (ctx.lastExiled?.length ? game.cards[ctx.lastExiled.at(-1)] : null) ?? (ctx.subjectCard ? game.cards[ctx.subjectCard] : null);
      if (!original) return false;
      const base = defOf(game, original);
      for (let i = 0; i < effect.n; i += 1) {
        const id = createCopyToken(game, ctx.controller, base, null, null, effect.mods);
        if (!id) break;
        if (effect.tapped) game.cards[id].tapped = true;
        ctx.madeTokens = [...(ctx.madeTokens ?? []), id];
        enterBattlefield(game, game.cards[id]);
      }
      addLog(game, `${controller.name} erzeugt ${effect.n > 1 ? `${effect.n} Kopien` : "eine Kopie"} von ${base.name} als Spielstein (${name}).`);
      return false;
    }
    case "returnSelfFromGy": {
      const card = sourceCard;
      const owner = card ? game.players[card.origOwner ?? card.owner] : null;
      if (!card || !owner?.graveyard.includes(card.id)) return false;
      owner.graveyard.splice(owner.graveyard.indexOf(card.id), 1);
      if (effect.to === "hand") {
        owner.hand.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt aus dem Friedhof auf die Hand (${name}).`);
      } else {
        owner.battlefield.push(card.id);
        enterBattlefield(game, card);
        if (effect.tapped) card.tapped = true;
        addLog(game, `${nameOf(game, card.id)} kehrt aus dem Friedhof aufs Schlachtfeld zurück (${name}).`);
      }
      return false;
    }
    case "sacrificeOwn": {
      const options = controller.battlefield.filter(id => {
        if (effect.other && id === ctx.source) return false;
        const def = defOf(game, game.cards[id]);
        if (effect.what === "token") return game.cards[id].token;
        return effect.what === "permanent" ? true : effect.what === "nonland" ? !def.types.land : typeMatches(def, effect.what) || hasSubtype(def, effect.what);
      });
      if (options.length === 0) {
        ctx.didMay = false;
        return false;
      }
      ctx.didMay = true;
      if (options.length === 1) {
        ctx.sacrificed = options[0];
        ctx.snap = { ...(ctx.snap ?? {}), ...snapshotTargets(game, options) };
        addLog(game, `${controller.name} opfert ${nameOf(game, options[0])} (${name}).`);
        noteSacrifice(game, game.cards[options[0]]);
        toGraveyard(game, game.cards[options[0]]);
        return false;
      }
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wähle, was du opferst (${name}).`,
        options,
        min: 1,
        max: 1,
        step: { type: "sacrificeOne" },
        queue: rest,
        ctx
      });
    }
    case "wheel": {
      for (const id of alive(game)) {
        const holder = game.players[id];
        holder.library.push(...holder.hand, ...holder.graveyard);
        holder.hand = [];
        holder.graveyard = [];
        shuffle(holder.library);
        drawCards(game, id, effect.n);
      }
      addLog(game, `Alle mischen Hand und Friedhof in die Bibliothek und ziehen ${effect.n} Karten (${name}).`);
      return false;
    }
    case "commanderToHand": {
      const id = controller.command.find(cardId => game.cards[cardId]?.cmd);
      if (!id) return false;
      controller.command.splice(controller.command.indexOf(id), 1);
      controller.hand.push(id);
      addLog(game, `${controller.name} nimmt ${nameOf(game, id)} aus der Kommandozone auf die Hand (${name}).`);
      return false;
    }
    case "untapLands": {
      const lands = controller.battlefield.filter(id => game.cards[id].tapped && defOf(game, game.cards[id]).types.land).slice(0, effect.n);
      for (const id of lands) game.cards[id].tapped = false;
      addLog(game, `${controller.name} enttappt ${lands.length} Länder (${name}).`);
      return false;
    }
    case "attachSubject": {
      const target = ctx.subjectCard ? game.cards[ctx.subjectCard] : null;
      if (!sourceCard || !target || !onBattlefield(game, sourceCard.id) || !onBattlefield(game, target.id)) return false;
      sourceCard.attachedTo = target.id;
      addLog(game, `${nameOf(game, sourceCard.id)} wird an ${nameOf(game, target.id)} angehängt (${name}).`);
      return false;
    }
    case "unearth": {
      if (!sourceCard || !controller.graveyard.includes(sourceCard.id)) return false;
      controller.graveyard.splice(controller.graveyard.indexOf(sourceCard.id), 1);
      controller.battlefield.push(sourceCard.id);
      enterBattlefield(game, sourceCard);
      sourceCard.tk = [...(sourceCard.tk ?? []), "haste"];
      sourceCard.exileEnd = true;
      addLog(game, `${nameOf(game, sourceCard.id)} kehrt mit Unearth zurück (Eile, am Zugende ins Exil).`);
      return false;
    }
    case "ifCond": {
      const met = evalCondition(game, ctx, effect.cond);
      if (!met) return false;
      for (let i = 0; i < effect.effects.length; i += 1) if (runEffect(game, effect.effects[i], ctx, [...effect.effects.slice(i + 1), ...rest])) return true;
      return false;
    }
    case "returnExiledEnd": {
      for (const id of ctx.lastExiled ?? []) game.delayedReturns = [...(game.delayedReturns ?? []), id];
      return false;
    }
    case "exileTop": {
      const ids = [];
      for (let i = 0; i < effect.n && controller.library.length > 0; i += 1) {
        const id = controller.library.pop();
        controller.exile.push(id);
        ids.push(id);
      }
      ctx.lastExiled = ids;
      addLog(game, `${controller.name} legt ${ids.map(id => nameOf(game, id)).join(", ") || "nichts"} aus der Bibliothek ins Exil (${name}).`);
      return false;
    }
    case "playExiled": {
      const until = game.turn.number + (effect.next ? Math.max(1, alive(game).length) : 0);
      for (const id of ctx.lastExiled ?? []) {
        const card = game.cards[id];
        if (!card) continue;
        card.playUntil = until;
        card.playBy = ctx.controller;
      }
      if ((ctx.lastExiled ?? []).length > 0) addLog(game, `${controller.name} darf ${(ctx.lastExiled ?? []).map(id => nameOf(game, id)).join(", ")} ${effect.next ? "bis zum Ende des nächsten Zuges" : "in diesem Zug"} aus dem Exil spielen (${name}).`);
      return false;
    }
    case "grantLast": {
      for (const id of lastCards(ctx)) if (game.cards[id] && onBattlefield(game, id)) game.cards[id].tk = [...(game.cards[id].tk ?? []), ...effect.kws];
      return false;
    }
    case "delayedLast": {
      for (const id of lastCards(ctx)) {
        const card = game.cards[id];
        if (!card || !onBattlefield(game, id)) continue;
        if (effect.what === "sacrifice") card.sacEnd = true;
        else card.exileEnd = true;
      }
      return false;
    }
    case "delayedSelf":
      if (sourceCard && onBattlefield(game, sourceCard.id)) sourceCard.handEnd = true;
      return false;
    case "selfGrant":
      if (sourceCard && onBattlefield(game, sourceCard.id)) sourceCard.tk = [...(sourceCard.tk ?? []), ...effect.kws];
      return false;
    case "onceTurn":
      return false;
    case "jobSelect": {
      const hero = effect.token === "Rebel"
        ? createToken(game, ctx.controller, { name: "Rebel", power: 2, toughness: 2, typeLine: "Token Creature — Phyrexian Rebel" })
        : createToken(game, ctx.controller, { name: "Hero", power: 1, toughness: 1, typeLine: "Token Creature — Hero" });
      if (hero && sourceCard && onBattlefield(game, sourceCard.id)) {
        sourceCard.attachedTo = hero;
        addLog(game, `${nameOf(game, sourceCard.id)} hängt sich an einen Hero-Spielstein (${name}).`);
      }
      return false;
    }
    case "hideaway": {
      const n = Math.min(effect.n, controller.library.length);
      if (n === 0 || !sourceCard) return false;
      const top = controller.library.slice(-n);
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle eine der obersten ${n} Karten, die verdeckt ins Exil kommt (der Rest geht unten in die Bibliothek).`,
        options: top,
        min: 1,
        max: 1,
        step: { type: "hideaway", source: sourceCard.id, top },
        queue: rest,
        ctx
      });
    }
    case "playHidden": {
      if (!sourceCard?.hidden || !game.cards[sourceCard.hidden]) {
        addLog(game, `${name}: Es gibt keine versteckte Karte.`);
        return false;
      }
      const cond = effect.cond;
      const met =
        !cond ||
        (cond.kind === "totalPower" && controller.battlefield.reduce((sum, id) => sum + (defOf(game, game.cards[id]).types.creature ? Math.max(0, powerOf(game, game.cards[id])) : 0), 0) >= cond.n) ||
        (cond.kind === "creaturePower" && controller.battlefield.some(id => defOf(game, game.cards[id]).types.creature && powerOf(game, game.cards[id]) >= cond.n)) ||
        (cond.kind === "oppDamage" && game.seats.some(id => id !== ctx.controller && game.players[id].dmgTurn === game.turn.number && game.players[id].dmgTaken >= cond.n)) ||
        (cond.kind === "attacked" && (game.turn.attackedWith ?? 0) >= cond.n);
      if (!met) {
        addLog(game, `${name}: Die Bedingung ist nicht erfüllt.`);
        return false;
      }
      const hidden = game.cards[sourceCard.hidden];
      const hiddenDef = defOf(game, hidden);
      if (hiddenDef.types.instant || hiddenDef.types.sorcery) {
        addLog(game, `${name}: ${hiddenDef.name} ist ein Spontan-/Hexereizauber – bitte von Hand wirken (die Karte bleibt im Exil).`);
        hidden.faceDown = false;
        sourceCard.hidden = null;
        game.manual = { userId: ctx.controller, text: `${hiddenDef.name} ohne Manakosten wirken (liegt im Exil).`, source: name, hints: [], cardId: hidden.id, imageUri: hiddenDef.imageUri ?? null };
        return false;
      }
      controller.exile.splice(controller.exile.indexOf(hidden.id), 1);
      hidden.faceDown = false;
      sourceCard.hidden = null;
      controller.battlefield.push(hidden.id);
      enterBattlefield(game, hidden);
      addLog(game, `${controller.name} spielt ${hiddenDef.name} kostenlos (${name}).`);
      return false;
    }
    case "gyReturnAll": {
      const holders = effect.allGraveyards ? game.seats.map(id => game.players[id]) : [controller];
      for (const holder of holders) for (const id of [...holder.graveyard]) {
        const card = game.cards[id];
        if (!card || !typeMatches(defOf(game, card), effect.what)) continue;
        holder.graveyard.splice(holder.graveyard.indexOf(id), 1);
        controller.battlefield.push(id);
        if (card.owner !== ctx.controller) {
          card.origOwner = card.origOwner ?? card.owner;
          card.owner = ctx.controller;
        }
        enterBattlefield(game, card);
        if (effect.tapped) card.tapped = true;
      }
      addLog(game, `${controller.name} legt alle passenden Karten aus dem Friedhof aufs Schlachtfeld (${name}).`);
      return false;
    }
    case "handToField": {
      const options = controller.hand.filter(id => typeMatches(defOf(game, game.cards[id]), effect.what) && !(effect.mvMax !== undefined && (defOf(game, game.cards[id]).manaValue ?? 0) > effect.mvMax));
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `Wähle ${effect.what === "land" ? "ein Land" : "eine Karte"} aus deiner Hand, die aufs Schlachtfeld kommt (${name}).`,
        options,
        min: 1,
        max: 1,
        step: { type: "handField", tapped: effect.tapped },
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
    case "exileSelf":
      if (sourceCard && onBattlefield(game, sourceCard.id)) {
        addLog(game, `${nameOf(game, sourceCard.id)} wird exiliert.`);
        leaveTo(game, sourceCard, "exile");
      }
      return false;
    case "untapSelf":
      if (sourceCard) sourceCard.tapped = false;
      return false;
    case "sacrificeSelf":
      if (sourceCard && onBattlefield(game, sourceCard.id)) {
        addLog(game, `${controller.name} opfert ${nameOf(game, sourceCard.id)}.`);
        noteSacrifice(game, sourceCard);
        toGraveyard(game, sourceCard);
      }
      return false;
    case "energy":
      controller.energy += effect.n;
      addLog(game, `${controller.name} erhält ${effect.n} Energie (${name}).`);
      return false;
    case "monstrosity":
      if (sourceCard && !sourceCard.monstrous) {
        sourceCard.monstrous = true;
        sourceCard.counters["+1/+1"] = (sourceCard.counters["+1/+1"] ?? 0) + counterAmount(game, sourceCard, "+1/+1", effect.n);
        sourceCard.counterTurn = game.turn.number;
        addLog(game, `${nameOf(game, sourceCard.id)} wird monströs (${effect.n} +1/+1-Marker).`);
      }
      return false;
    case "proliferate": {
      // vereinfacht und automatisch: eigene Marker (außer −1/−1) und gegnerische schädliche Marker (−1/−1, Gift) werden erhöht
      let count = 0;
      for (const userId of game.seats) {
        for (const id of game.players[userId].battlefield) {
          const c = game.cards[id];
          for (const kind of Object.keys(c.counters)) {
            const mine = c.owner === ctx.controller;
            const harmful = kind === "-1/-1";
            if ((mine && !harmful) || (!mine && harmful)) {
              c.counters[kind] += 1;
              count += 1;
            }
          }
        }
        if (userId !== ctx.controller && game.players[userId].poison > 0) {
          game.players[userId].poison += 1;
          count += 1;
        }
      }
      addLog(game, `${controller.name} verbreitet Marker (${count}×, ${name}).`);
      return false;
    }
    case "undying": {
      const card = sourceCard;
      if (!card) return false;
      const owner = game.players[card.origOwner ?? card.owner];
      if (!owner.graveyard.includes(card.id) || (card.lastCounters?.[effect.kind] ?? 0) > 0) return false;
      owner.graveyard.splice(owner.graveyard.indexOf(card.id), 1);
      owner.battlefield.push(card.id);
      card.owner = owner === game.players[card.owner] ? card.owner : card.origOwner ?? card.owner;
      enterBattlefield(game, card);
      card.counters[effect.kind] = (card.counters[effect.kind] ?? 0) + 1;
      addLog(game, `${nameOf(game, card.id)} kehrt mit einem ${effect.kind}-Marker zurück (${effect.kind === "+1/+1" ? "Undying" : "Persist"}).`);
      return false;
    }
    case "melee": {
      if (!sourceCard || !game.combat) return false;
      const defenders = new Set(game.combat.attackers.filter(a => game.cards[a.id]?.owner === ctx.controller).map(a => attackTargetOwner(game, a.target)));
      sourceCard.tp = (sourceCard.tp ?? 0) + defenders.size;
      sourceCard.tt = (sourceCard.tt ?? 0) + defenders.size;
      addLog(game, `${nameOf(game, sourceCard.id)} erhält +${defenders.size}/+${defenders.size} (Melee).`);
      return false;
    }
    case "adapt": {
      if (!sourceCard || (sourceCard.counters["+1/+1"] ?? 0) > 0) return false;
      sourceCard.counters["+1/+1"] = counterAmount(game, sourceCard, "+1/+1", effect.n);
      sourceCard.counterTurn = game.turn.number;
      addLog(game, `${nameOf(game, sourceCard.id)} adaptiert: ${effect.n} +1/+1-Marker.`);
      return false;
    }
    case "monarch":
      game.monarch = ctx.controller;
      addLog(game, `${controller.name} wird zum Monarchen.`);
      return false;
    case "lookTop": {
      const n = Math.min(effect.n, controller.library.length);
      ctx.look = controller.library.slice(-n);
      addLog(game, `${controller.name} sieht sich die obersten ${n} Karten an (${name}).`);
      return false;
    }
    case "lookTake": {
      const options = (ctx.look ?? []).filter(id => effect.what === "card" || typeMatches(defOf(game, game.cards[id]), effect.what));
      if (options.length === 0) return false;
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle ${effect.count > 1 ? `bis zu ${effect.count} Karten` : "eine Karte"} (${String(effect.what) === "card" ? "beliebig" : String(effect.what).replace(/\|/g, " oder ")}) für deine Hand.`,
        options,
        min: effect.optional ? 0 : Math.min(effect.count, options.length),
        max: Math.min(effect.count, options.length),
        step: { type: "lookTake" },
        queue: rest,
        ctx
      });
    }
    case "lookRest": {
      const left = (ctx.look ?? []).filter(id => controller.library.includes(id));
      for (const id of left) controller.library.splice(controller.library.indexOf(id), 1);
      if (effect.to === "graveyard") {
        controller.graveyard.push(...left);
        addLog(game, `${controller.name} legt ${left.length} Karten auf den Friedhof (${name}).`);
      } else {
        shuffle(left);
        controller.library.unshift(...left);
        addLog(game, `${controller.name} legt ${left.length} Karten in zufälliger Reihenfolge unter die Bibliothek (${name}).`);
      }
      ctx.look = [];
      return false;
    }
    case "rearrange": {
      const n = Math.min(effect.n, controller.library.length);
      if (n <= 1) return false;
      const top = controller.library.slice(-n);
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Lege die obersten ${n} Karten zurück – in der Reihenfolge, in der du sie anklickst (zuerst Gewählte kommen oben).`,
        options: top,
        min: n,
        max: n,
        step: { type: "rearrange" },
        queue: rest,
        ctx
      });
    }
    case "shuffleLib":
      shuffle(controller.library);
      addLog(game, `${controller.name} mischt die Bibliothek.`);
      return false;
    case "extraLandTurn":
      game.turn.extraLands = (game.turn.extraLands ?? 0) + 1;
      addLog(game, `${controller.name} darf in diesem Zug ein zusätzliches Land spielen (${name}).`);
      return false;
    case "ifXAtLeast": {
      if ((ctx.x ?? 0) < effect.n) return false;
      for (let i = 0; i < effect.effects.length; i += 1) if (runEffect(game, effect.effects[i], ctx, [...effect.effects.slice(i + 1), ...rest])) return true;
      return false;
    }
    case "manaChoice":
      return openChoice(game, {
        userId: ctx.controller,
        kind: "cards",
        prompt: `${name}: Wähle das Mana.`,
        options: effect.options.map((option, index) => `mana:${index}`),
        labels: Object.fromEntries(effect.options.map((option, index) => [`mana:${index}`, option.map(symbol => `{${symbol}}`).join("")])),
        min: 1,
        max: 1,
        step: { type: "manaChoice", options: effect.options },
        queue: rest,
        ctx
      });
    case "searchUntapIf":
      return false;
    case "chaosWarp": {
      const card = targetCard;
      if (!card || !onBattlefield(game, card.id)) return false;
      const ownerId = card.origOwner ?? card.owner;
      const owner = game.players[ownerId];
      const isToken = card.token;
      leaveTo(game, card, "library");
      if (!isToken) {
        owner.library.pop();
        owner.library.push(card.id);
      }
      shuffle(owner.library);
      const topId = owner.library.at(-1);
      addLog(game, `${owner.name} mischt ${nameOf(game, card.id)} in die Bibliothek und deckt ${topId ? nameOf(game, topId) : "nichts"} auf (${name}).`);
      if (topId && !defOf(game, game.cards[topId]).types.instant && !defOf(game, game.cards[topId]).types.sorcery) {
        owner.library.pop();
        owner.battlefield.push(topId);
        enterBattlefield(game, game.cards[topId]);
      }
      return false;
    }
    case "copyToken": {
      const base = sourceCard ? defOf(game, sourceCard) : null;
      if (!base) return false;
      const targets = effect.mode === "encore" ? alive(game).filter(id => id !== ctx.controller) : [ctx.controller];
      for (const opp of targets) {
        const id = createCopyToken(game, ctx.controller, base, effect.mode, opp);
        if (id) addLog(game, `${controller.name} erhält eine Spielstein-Kopie von ${base.name} (${name}).`);
      }
      return false;
    }
    case "moveCounter": {
      const from = game.cards[ctx.targets[effect.from]];
      const to = game.cards[ctx.targets[effect.to]];
      if (!from || !to || from.id === to.id || !onBattlefield(game, from.id) || !onBattlefield(game, to.id)) return false;
      const kinds = Object.keys(from.counters).filter(kind => from.counters[kind] > 0);
      if (kinds.length === 0) return false;
      const kind = kinds.includes("+1/+1") ? "+1/+1" : kinds[0];
      const amount = effect.all ? from.counters[kind] : 1;
      from.counters[kind] -= amount;
      if (from.counters[kind] <= 0) delete from.counters[kind];
      to.counters[kind] = Math.min(MAX_COUNTERS, (to.counters[kind] ?? 0) + amount);
      to.counterTurn = game.turn.number;
      addLog(game, `${amount}× ${kind} wandert von ${nameOf(game, from.id)} auf ${nameOf(game, to.id)} (${name}).`);
      fireGlobal(game, "countersPut", to);
      return false;
    }
    case "doubleCounters": {
      const card = game.cards[ctx.targets[effect.t]];
      if (card && onBattlefield(game, card.id)) {
        for (const kind of Object.keys(card.counters)) card.counters[kind] *= 2;
        addLog(game, `Die Marker auf ${nameOf(game, card.id)} werden verdoppelt (${name}).`);
      }
      return false;
    }
    case "freeze": {
      const card = effect.t !== null && effect.t !== undefined ? game.cards[ctx.targets[effect.t]] : ctx.subjectCard ? game.cards[ctx.subjectCard] : ctx.lastControlled ? game.cards[ctx.lastControlled] : null;
      if (card) {
        card.frozen = true;
        addLog(game, `${nameOf(game, card.id)} bleibt im nächsten Enttappschritt getappt (${name}).`);
      }
      return false;
    }
    case "explore": {
      const card = effect.t !== undefined ? game.cards[ctx.targets[effect.t]] : effect.who === "self" ? sourceCard : ctx.subjectCard ? game.cards[ctx.subjectCard] : null;
      if (!card || !onBattlefield(game, card.id)) return false;
      const top = controller.library[controller.library.length - 1];
      if (top === undefined) return false;
      const topDef = defOf(game, game.cards[top]);
      if (topDef.types.land) {
        controller.library.pop();
        controller.hand.push(top);
        addLog(game, `${nameOf(game, card.id)} erkundet: ${topDef.name} ist ein Land und kommt auf die Hand (${name}).`);
      } else {
        card.counters["+1/+1"] = (card.counters["+1/+1"] ?? 0) + counterAmount(game, card, "+1/+1", 1);
        addLog(game, `${nameOf(game, card.id)} erkundet: ${topDef.name} liegt oben, ${nameOf(game, card.id)} erhält einen +1/+1-Marker (${name}).`);
      }
      return false;
    }
    case "station": {
      if (!sourceCard || !onBattlefield(game, sourceCard.id)) return false;
      const amount = ctx.paidPower ?? 0;
      sourceCard.counters.charge = (sourceCard.counters.charge ?? 0) + amount;
      addLog(game, `${nameOf(game, sourceCard.id)} erhält ${amount} Ladungsmarker (${name}).`);
      return false;
    }
    case "animate": {
      const card = sourceCard;
      if (!card || !onBattlefield(game, card.id)) return false;
      const base = defOf(game, card);
      card.baseDef = card.baseDef ?? card.def;
      const key = `anim:${card.id}`;
      game.xdefs[key] = {
        ...base,
        typeLine: /Creature/.test(base.typeLine ?? "") ? base.typeLine : `${base.typeLine}${base.typeLine ? " " : ""}Creature`,
        types: { ...base.types, creature: true },
        power: effect.p ?? base.power ?? 0,
        toughness: effect.th ?? base.toughness ?? 0,
        powerText: String(effect.p ?? base.power ?? 0),
        toughnessText: String(effect.th ?? base.toughness ?? 0),
        keywords: [...new Set([...(base.keywords ?? []), ...(effect.kws ?? [])])]
      };
      card.def = key;
      addLog(game, `${nameOf(game, card.id)} wird bis zum Zugende zur Kreatur (${name}).`);
      return false;
    }
    case "livingWeapon": {
      const germ = createToken(game, ctx.controller, { name: "Phyrexian Germ", power: 0, toughness: 0, typeLine: "Token Creature — Phyrexian Germ" });
      if (germ && sourceCard && onBattlefield(game, sourceCard.id)) {
        sourceCard.attachedTo = germ;
        addLog(game, `${nameOf(game, sourceCard.id)} hängt sich an einen Germ-Spielstein (${name}).`);
      }
      return false;
    }
    default:
      addLog(game, `Hinweis: Der Effekt „${effect.type}“ dieser Karte wird nicht automatisch umgesetzt.`);
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
  if (choice.step?.type === "search" && choice.step.sameType && ids.length === 2) {
    const typeOf = id => (String(defOf(game, game.cards[id]).typeLine).match(/\b(Plains|Island|Swamp|Mountain|Forest|Wastes)\b/) ?? [])[1];
    if (typeOf(ids[0]) !== typeOf(ids[1])) return fail("Die beiden Länder müssen einen gemeinsamen Landtyp teilen.");
  }
  game.choice = null;
  const player = game.players[userId];
  const step = choice.step;
  const ctx = choice.ctx;
  switch (step.type) {
    case "trigger": {
      const picked = [...(step.picked ?? []), ids[0] ?? ""];
      if (picked.length < step.item.specs.length) {
        if (!openTriggerTarget(game, userId, step.item, picked, step.item.sourceName, step.item.text)) game.choice = null;
        return ok();
      }
      pushAbility(game, { ...step.item, targets: picked });
      break;
    }
    case "clone": {
      const card = game.cards[step.cardId];
      if (card) delete card.pendingClone;
      const chosen = game.cards[ids[0]];
      if (!card || !chosen || !onBattlefield(game, card.id)) break;
      const rule = defOf(game, card).rules?.cloneOnEnter ?? { mods: {} };
      const key = `clone:${card.id}`;
      game.xdefs[key] = copyDef(defOf(game, chosen), rule.mods);
      card.cloneOf = card.cloneOf ?? card.def;
      card.def = key;
      if (rule.mods?.plusCounters) {
        const n = rule.mods.plusCounters === "x" ? card.enterX ?? 0 : ({ one: 1, two: 2, three: 3 }[rule.mods.plusCounters] ?? Number(rule.mods.plusCounters) ?? 0);
        if (n > 0) card.counters["+1/+1"] = (card.counters["+1/+1"] ?? 0) + n;
      }
      addLog(game, `${player.name}: ${nameOf(game, card.id)} kommt als Kopie von ${defOf(game, chosen).name} ins Spiel.`);
      fireTriggers(game, card, "etb");
      break;
    }
    case "topLand": {
      const card = game.cards[step.id];
      if (ids[0] !== "yes" || !card || player.library[player.library.length - 1] !== card.id) break;
      player.library.pop();
      player.battlefield.push(card.id);
      enterBattlefield(game, card);
      if (step.tapped) card.tapped = true;
      addLog(game, `${player.name} legt ${nameOf(game, card.id)} von der Bibliothek aufs Schlachtfeld.`);
      break;
    }
    case "madness": {
      const card = game.cards[step.cardId];
      const madness = card ? defOf(game, card).rules?.madness : null;
      if (!card || !madness || !player.exile.includes(card.id)) break;
      player.exile.splice(player.exile.indexOf(card.id), 1);
      const plan = ids[0] === "yes" ? planPayment({ manaCost: madness.cost, pool: player.pool, sources: manaSources(game, userId) }) : null;
      if (!plan?.ok || player.life <= madness.life) {
        player.graveyard.push(card.id);
        addLog(game, `${nameOf(game, card.id)} kommt in den Friedhof.`);
        break;
      }
      for (const id of plan.tap) game.cards[id].tapped = true;
      spendSacrificial(game, plan.tap);
      for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
      for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
      if (madness.life) player.life -= madness.life;
      game.stack.push({ sid: newId(game, "s"), kind: "spell", controller: userId, cardId: card.id, x: 0, flashback: false, mode: null, targets: [], fromExile: true });
      game.priority = userId;
      game.passed = [];
      addLog(game, `${player.name} wirkt ${nameOf(game, card.id)} für Madness (${describeCost(madness.cost)}).`);
      break;
    }
    case "triggerMode": {
      const mode = ids.length > 1 ? combineModes(step.trigger.modes, ids.map(Number)) : step.trigger.modes[Number(ids[0])];
      if (!mode) break;
      const base = { ...step.base, text: mode.label ?? ids.map(index => step.trigger.modes[Number(index)]?.label).join(" "), effects: mode.effects, specs: mode.specs, unparsed: mode.unparsed };
      if (mode.specs.length === 0) pushAbility(game, { ...base, targets: [] });
      else openTriggerTarget(game, userId, base, [], base.sourceName, mode.label);
      break;
    }
    case "chooseColor": {
      const card = game.cards[step.cardId];
      if (card) card.chosenColor = ids[0].slice(6);
      break;
    }
    case "chooseType": {
      const card = game.cards[step.cardId];
      if (card) {
        card.chosenType = ids[0].slice(5);
        addLog(game, `${nameOf(game, card.id)}: gewählter Kreaturentyp ist ${card.chosenType}.`);
      }
      break;
    }
    case "manaAny": {
      const color = ids[0].slice(6);
      player.pool[color] = (player.pool[color] ?? 0) + (step.n ?? 1);
      addLog(game, `${player.name} erhält ${step.n ?? 1} Mana (${color}).`);
      break;
    }
    case "putBack": {
      for (const id of ids) {
        player.hand.splice(player.hand.indexOf(id), 1);
        player.library.push(id);
      }
      addLog(game, `${player.name} legt ${ids.length} Karte${ids.length === 1 ? "" : "n"} oben auf die Bibliothek.`);
      break;
    }
    case "chooseRevealed":
      ctx.chosenCard = ids[0];
      break;
    case "lookTake":
      for (const id of ids) {
        player.library.splice(player.library.indexOf(id), 1);
        player.hand.push(id);
        addLog(game, `${player.name} nimmt ${nameOf(game, id)} auf die Hand.`);
      }
      break;
    case "rearrange":
      for (const id of ids) player.library.splice(player.library.indexOf(id), 1);
      for (const id of [...ids].reverse()) player.library.push(id);
      addLog(game, `${player.name} legt ${ids.length} Karten in neuer Reihenfolge zurück.`);
      break;
    case "manaChoice": {
      const option = step.options[Number(ids[0].slice(5))] ?? [];
      for (const color of option) player.pool[color] = (player.pool[color] ?? 0) + 1;
      addLog(game, `${player.name} erhält ${option.join("")}.`);
      break;
    }
    case "tapOrUntap": {
      const card = game.cards[step.id];
      if (card) card.tapped = ids[0] === "yes";
      break;
    }
    case "payGate": {
      const paying = ids[0] === "yes";
      if (paying) {
        const plan = planPayment({ manaCost: step.cost, pool: game.players[step.payerId].pool, sources: manaSources(game, step.payerId) });
        if (plan.ok) {
          for (const id of plan.tap) game.cards[id].tapped = true;
          spendSacrificial(game, plan.tap);
          for (const color of Object.keys(plan.poolUsed)) game.players[step.payerId].pool[color] -= plan.poolUsed[color];
          for (const color of Object.keys(plan.poolAdd)) game.players[step.payerId].pool[color] += plan.poolAdd[color];
          addLog(game, `${game.players[step.payerId].name} bezahlt ${step.cost}.`);
        }
      }
      if (step.mode === "mayPay") ctx.didMay = paying;
      else if (!paying) choice.queue = [...step.effects, ...choice.queue];
      break;
    }
    case "unlessPay": {
      const index = game.stack.findIndex(item => item.sid === step.sid);
      if (index === -1) break;
      const payer = game.stack[index].controller;
      const plan = ids[0] === "yes" ? planPayment({ manaCost: step.cost, pool: game.players[payer].pool, sources: manaSources(game, payer) }) : null;
      if (plan?.ok) {
        for (const id of plan.tap) game.cards[id].tapped = true;
  spendSacrificial(game, plan.tap);
        for (const color of Object.keys(plan.poolUsed)) game.players[payer].pool[color] -= plan.poolUsed[color];
        for (const color of Object.keys(plan.poolAdd)) game.players[payer].pool[color] += plan.poolAdd[color];
        addLog(game, `${game.players[payer].name} bezahlt ${step.cost}: der Zauber bleibt (${step.sourceName}).`);
      } else {
        const [item] = game.stack.splice(index, 1);
        if (item.cardId && game.cards[item.cardId]) {
          addLog(game, `${nameOf(game, item.cardId)} wird neutralisiert (${step.sourceName}).`);
          toGraveyard(game, game.cards[item.cardId], "stack");
          offerCommanderReturn(game, game.cards[item.cardId], "graveyard");
        }
      }
      break;
    }
    case "may":
      ctx.didMay = ids[0] === "yes";
      if (ctx.didMay) choice.queue = [...step.effects, ...choice.queue];
      break;
    case "sacrificeOne": {
      const card = game.cards[ids[0]];
      if (ctx && card) {
        ctx.sacrificed = card.id;
        ctx.snap = { ...(ctx.snap ?? {}), ...snapshotTargets(game, [card.id]) };
      }
      if (card && onBattlefield(game, card.id)) {
        addLog(game, `${game.players[userId].name} opfert ${nameOf(game, card.id)}.`);
        noteSacrifice(game, card);
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
      if (ctx) ctx.discarded = (ctx.discarded ?? 0) + ids.length;
      fireDiscards(game, ids);
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
    case "hideaway": {
      const picked = game.cards[ids[0]];
      if (!picked) break;
      player.library.splice(player.library.indexOf(picked.id), 1);
      const rest = step.top.filter(id => id !== picked.id && player.library.includes(id));
      for (const id of rest) player.library.splice(player.library.indexOf(id), 1);
      shuffle(rest);
      player.library.unshift(...rest); // unten in zufälliger Reihenfolge
      picked.faceDown = true;
      player.exile.push(picked.id);
      const host = game.cards[step.source];
      if (host) host.hidden = picked.id;
      addLog(game, `${player.name} legt eine Karte verdeckt ins Exil (Hideaway), der Rest kommt nach unten.`);
      break;
    }
    case "search":
    case "handField":
    case "gyReturn": {
      for (const [position, id] of ids.entries()) {
        const card = game.cards[id];
        const from = step.type === "search" ? player.library : step.type === "handField" ? player.hand : player.graveyard;
        from.splice(from.indexOf(id), 1);
        const target = step.type === "handField" ? "battlefield" : step.to === "split" ? (position === 0 ? "battlefield" : "hand") : step.to;
        if (target === "top") {
          player.library.push(id);
          addLog(game, `${player.name} legt eine Karte oben auf die Bibliothek.`);
          continue;
        }
        if (target === "battlefield") {
          player.battlefield.push(id);
          enterBattlefield(game, card);
          if (step.tapped) card.tapped = true;
          if (step.untapIf && player.battlefield.filter(landId => defOf(game, game.cards[landId]).types.land).length >= step.untapIf) card.tapped = false;
          if (step.counters) card.counters["+1/+1"] = (card.counters["+1/+1"] ?? 0) + step.counters;
        } else player.hand.push(id);
        addLog(game, `${player.name} nimmt ${nameOf(game, id)} ${target === "hand" ? "auf die Hand" : "aufs Schlachtfeld"}.`);
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
  const foretoldOk = Boolean(found && found.zone === "exile" && found.card.foretoldTurn !== undefined && found.card.foretoldTurn < game.turn.number && defOf(game, found.card).rules?.foretell);
  const impulse = Boolean(found && impulseOk(game, userId, found.card, found.zone));
  const free = Boolean(found && freeCastOk(game, userId, found.card, found.zone));
  const gyLand = Boolean(found && found.zone === "graveyard" && defOf(game, found.card).types.land && landsFromGraveyard(game, userId));
  if (!found || (found.zone !== "hand" && found.zone !== "command" && !flashbackOk && !foretoldOk && !impulse && !gyLand && !free)) return null;
  const def = defOf(game, found.card);
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;

  if (def.types.land) {
    const okNow = playing && (found.zone === "hand" || impulse || gyLand) && game.priority === userId && mainPhase && game.turn.landsPlayed < 1 + (game.turn.extraLands ?? 0) + player.battlefield.reduce((sum, id) => sum + (defOf(game, game.cards[id]).rules?.extraLand ?? 0), 0);
    return { kind: "land", ok: okNow };
  }
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const timingOk = playing && hasWindow(game, userId) && (instantSpeed || mainPhase || free) && !castLocked(game, userId);
  let affordable = false;
  if (timingOk) {
    const tax = found.zone === "command" ? 2 * (player.cmdCasts[id] ?? 0) : 0;
    affordable = planWithAlternatives(game, userId, def, { manaCost: free ? "" : flashbackOk ? def.rules.flashback : foretoldOk ? def.rules.foretell : hasFreeCast(game, userId, def) ? "" : def.manaCost, extraGeneric: tax - costReduction(game, def, userId), pool: player.pool, sources: manaSources(game, userId) }).plan.ok;
    if (affordable && def.rules?.additionalCost && !canPayExtras(game, userId, def.rules.additionalCost, id)) affordable = false;
  }
  const spell = def.rules?.spell;
  return {
    kind: "spell",
    ok: timingOk && affordable,
    timingOk,
    pays: def.rules?.additionalCost ? payRequirements(game, userId, def.rules.additionalCost, id) : [],
    targets: spell && !spell.modes && spell.specs.length > 0 ? targetOptions(game, spell.specs, userId, srcOfDef(def, id)) : [],
    modes: spell?.modes?.map(mode => ({ label: mode.label, summary: mode.summary, targets: targetOptions(game, mode.specs, userId, srcOfDef(def, id)), manual: mode.unparsed.length > 0 })),
    ...(spell?.modes && (spell.modeCount || false) ? { modeCount: modeLimits(game, userId, spell) } : {}),
    manual: Boolean(spell && !spell.modes && spell.unparsed.length > 0)
  };
}

/** Aktivierbare Fähigkeiten einer eigenen Karte auf dem Schlachtfeld (mit gültigen Zielen). */
export function abilityOptions(game, userId, card) {
  const def = defOf(game, card);
  const owner = game.players[card.owner];
  const where = onBattlefield(game, card.id) ? "battlefield" : owner?.graveyard.includes(card.id) ? "graveyard" : owner?.hand.includes(card.id) ? "hand" : null;
  const list = (def.rules?.activated ?? []).filter(ability => (ability.zone ?? "battlefield") === where);
  if (list.length === 0 || card.owner !== userId) return [];
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  return list.map(ability => {
    let okNow = playing && tierOn(card, ability) && hasWindow(game, userId) && (!ability.sorcery || mainPhase) && ability.effects.length + ability.unparsed.length > 0;
    if (okNow && ability.cost.tap && (card.tapped || isSick(game, card))) okNow = false;
    if (okNow && ability.cost.loyalty !== undefined) {
      okNow = card.loyaltyTurn !== game.turn.number && (card.counters.loyalty ?? 0) + ability.cost.loyalty >= 0;
    }
    if (okNow && ability.cost.extra && !canPayExtras(game, userId, ability.cost.extra, card.id)) okNow = false;
    if (okNow && ability.cost.crew && !pickCrew(game, userId, card.id, ability.cost.crew)) okNow = false;
    if (okNow && ability.cost.mana) {
      const sources = manaSources(game, userId).filter(source => source.id !== card.id);
      okNow = planPayment({ manaCost: ability.cost.mana, pool: player.pool, sources }).ok;
    }
    return {
      index: ability.index,
      text: ability.summary || ability.text.replace(/~/g, def.name),
      costLabel: [ability.cost.tap ? "{T}" : "", ability.cost.mana, ability.cost.sacrifice ? "Opfern" : "", ability.cost.loyalty !== undefined ? (ability.cost.loyalty > 0 ? `+${ability.cost.loyalty}` : `${ability.cost.loyalty}`) : ""].filter(Boolean).join(", "),
      ok: okNow,
      pays: ability.cost.extra ? payRequirements(game, userId, ability.cost.extra, card.id) : [],
      targets: targetOptions(game, ability.specs, userId, srcOfDef(def, card.id)),
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
    ...((card.goadedBy ?? []).length > 0 ? { goaded: true, goadedBy: card.goadedBy } : {}),
    kind: def.types.land ? "land" : def.types.creature ? "creature" : "other",
    chosenType: card.chosenType ?? null,
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
    power: creature ? (def.powerText !== null && def.power === null && !def.rules?.dynamicPT ? null : powerOf(game, card)) : null,
    toughness: creature ? (def.toughnessText !== null && def.toughness === null && !def.rules?.dynamicPT ? null : toughnessOf(game, card)) : null,
    abilities: card.owner === viewerId && (onBattlefield(game, id) || game.players[card.owner].graveyard.includes(id) || game.players[card.owner].hand.includes(id)) ? abilityOptions(game, viewerId, card) : [],
    cycle: card.owner === viewerId ? cycleOptions(game, viewerId, card) : null,
    foretell: card.owner === viewerId ? foretellOptions(game, viewerId, card) : null,
    evoke: card.owner === viewerId ? evokeOptions(game, viewerId, card) : null,
    mutate: card.owner === viewerId ? mutateOptions(game, viewerId, card) : null,
    mutated: card.mutStack ? card.mutStack.length : 0,
    rulesNotes: (def.rules?.notes ?? []).slice(0, 4).map(note => note.replace(/~/g, def.name)),
    mana: Boolean(def.mana),
    manaColors: def.mana ? [...new Set(effectiveMana(game, card).flat())] : [],
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
    monarch: game.monarch ?? null,
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
const HINT_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const hintNumber = word => (/^\d+$/.test(word) ? Number(word) : HINT_WORDS[String(word).toLowerCase()] ?? null);

/**
 * Vorschläge für das manuelle Fenster: Aus dem nicht automatisch verstandenen Kartentext werden einfache Schritte abgeleitet.
 * Schritte ohne Ziel sind direkt ausführbare Aktionen; Schritte mit Ziel erklären, wo man klickt.
 * @returns {{ label: string, action?: object }[]}
 */
export function manualHints(text) {
  const hints = [];
  const lower = String(text ?? "").toLowerCase();
  const seen = new Set();
  const add = hint => {
    if (seen.has(hint.label) || hints.length >= 6) return;
    seen.add(hint.label);
    hints.push(hint);
  };
  let m;
  const drawRe = /\b(?:you )?draws? (a|an|one|two|three|four|five|six|seven|\d+) cards?\b/g;
  while ((m = drawRe.exec(lower))) {
    const n = hintNumber(m[1]);
    if (n) add({ label: `${n} Karte${n === 1 ? "" : "n"} ziehen`, action: { type: "draw", count: n } });
  }
  const gainRe = /\byou gain (\d+) life\b/g;
  while ((m = gainRe.exec(lower))) add({ label: `${m[1]} Leben erhalten`, action: { type: "life", delta: Number(m[1]) } });
  const loseRe = /\byou lose (\d+) life\b/g;
  while ((m = loseRe.exec(lower))) add({ label: `${m[1]} Leben verlieren`, action: { type: "life", delta: -Number(m[1]) } });
  const millRe = /\bmill (a|one|two|three|four|five|\d+) cards?\b/g;
  while ((m = millRe.exec(lower))) {
    const n = hintNumber(m[1]);
    if (n) add({ label: `${n} Karte${n === 1 ? "" : "n"} millen`, action: { type: "mill", count: n } });
  }
  const tokenRe = /\bcreate (a|an|one|two|three|four|\d+) (?:tapped )?(\d+)\/(\d+) [a-z ]*?([a-z]+) (?:artifact )?creature tokens?/g;
  while ((m = tokenRe.exec(lower))) {
    const n = hintNumber(m[1]) ?? 1;
    const name = `${m[4][0].toUpperCase()}${m[4].slice(1)} ${m[2]}/${m[3]}`;
    add({ label: `${n > 1 ? `${n}× ` : ""}Spielstein ${name} erzeugen`, action: { type: "token", name }, repeat: n });
  }
  const namedRe = /\bcreate (a|an|one|two|three|\d+) (?:tapped )?(treasure|food|clue|gold|map|lander|blood|powerstone) tokens?/g;
  while ((m = namedRe.exec(lower))) {
    const n = hintNumber(m[1]) ?? 1;
    const name = m[2][0].toUpperCase() + m[2].slice(1);
    add({ label: `${n > 1 ? `${n}× ` : ""}${name}-Spielstein erzeugen`, action: { type: "token", name }, repeat: n });
  }
  if ((m = lower.match(/\b(?:scry|look at the top) (a|one|two|three|four|five|six|\d+)\b/))) {
    const n = hintNumber(m[1]);
    if (n) add({ label: `Oberste ${n} Karte${n === 1 ? "" : "n"} ansehen`, action: { type: "look", count: n } });
  }
  if (/\bdeals? (?:\d+|x|that much) damage\b/.test(lower)) add({ label: "Schaden: Kreatur rechtsklicken → „Schaden“, Spieler über die Lebenspunkte" });
  if (/\b(destroy|exile|return [^.]* to (?:its|their) owner's hand)\b/.test(lower)) add({ label: "Zerstören, Exil oder Hand: Karte rechtsklicken → passende Zone" });
  if (/\+1\/\+1 counters?|-1\/-1 counters?|counters? on\b/.test(lower)) add({ label: "Marker: Kreatur rechtsklicken → Marker hinzufügen/entfernen" });
  if (/\bsearch your library\b/.test(lower)) add({ label: "Bibliothek durchsuchen: Bibliothek anklicken → ansehen", action: { type: "look", count: "all" } });
  if (/\b(tap|untap)\b/.test(lower)) add({ label: "Tappen/Enttappen: Karte rechtsklicken" });
  return hints;
}

const MANUAL_ACTIONS = new Set([
  "draw", "mill", "shuffle", "look", "closeLook", "move", "tap", "untapAll", "flip", "reveal", "counter", "token",
  "life", "pcounter", "cmddmg", "pool", "ability", "counterSpell", "damage", "moveOther"
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
      // im manuellen Fenster auch Karten der Gegner (z. B. „Tap target creature“)
      const card = game.cards[action.id];
      if (!card || !onBattlefield(game, card.id)) return fail("Diese Karte liegt nicht auf dem Schlachtfeld.");
      card.tapped = typeof action.tapped === "boolean" ? action.tapped : !card.tapped;
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
    case "damage": {
      // Handarbeit (nur im manuellen Fenster): Schaden auf einer beliebigen Kreatur markieren oder entfernen
      const card = game.cards[action.id];
      if (!card || !onBattlefield(game, card.id) || !defOf(game, card).types.creature) return fail("Schaden geht nur auf Kreaturen im Spiel.");
      if (!isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > 99) return fail("Ungültiger Schaden.");
      card.damage = Math.max(0, card.damage + action.delta);
      addLog(game, `${player.name}: ${nameOf(game, card.id)} ${action.delta > 0 ? `erhält ${action.delta} Schaden` : `verliert ${-action.delta} Schaden`} (von Hand).`);
      return ok();
    }
    case "moveOther": {
      // Handarbeit: eine beliebige Karte auf dem Schlachtfeld zerstören, exilieren oder zurück auf die Hand ihres Besitzers schicken
      const card = game.cards[action.id];
      if (!card || !onBattlefield(game, card.id)) return fail("Die Karte liegt nicht auf dem Schlachtfeld.");
      if (!["graveyard", "exile", "hand"].includes(action.to)) return fail("Unbekannte Zone.");
      addLog(game, `${player.name} schickt ${nameOf(game, card.id)} ${action.to === "graveyard" ? "auf den Friedhof" : action.to === "exile" ? "ins Exil" : "zurück auf die Hand"} (von Hand).`);
      if (action.to === "graveyard") toGraveyard(game, card);
      else leaveTo(game, card, action.to);
      return ok();
    }
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
      if (result.ok) {
        flushTriggers(game); // Auslöser auf das Wirken (z. B. „Whenever an opponent casts a spell“) liegen über dem Zauber
        settle(game, random, now); // löst sich von selbst auf, wenn niemand antworten kann
      }
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
    case "foretell":
      return foretellAction(game, userId, action);
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
      if (game.turn.phase === "attackers" && game.turn.active === userId && !game.combat && game.stack.length === 0) {
        const forced = forcedAttackers(game, userId);
        if (forced.length > 0) return fail(`${nameOf(game, forced[0])} muss angreifen, wenn möglich.`);
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
  let found = locate(game, userId, action.id);
  if (!found && game.cards[action.id] && onBattlefield(game, action.id)) {
    const owner = game.players[game.cards[action.id].owner];
    found = { zone: "battlefield", index: owner.battlefield.indexOf(action.id), card: game.cards[action.id], player: owner };
  }
  if (!found || (found.zone !== "battlefield" && found.zone !== "command")) return fail("Marker gehen nur auf Karten im Spiel.");
  const kind = typeof action.kind === "string" ? action.kind.trim().slice(0, 20) : "";
  if (!kind || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > MAX_COUNTERS) return fail("Ungültiger Marker.");
  const counters = found.card.counters;
  const next = Math.min(MAX_COUNTERS, Math.max(0, (counters[kind] ?? 0) + action.delta));
  if (action.delta > 0) found.card.counterTurn = game.turn.number;
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
  for (const options of effectiveMana(game, found.card)) {
    let color = options[0];
    if (options.length > 1) {
      if (typeof action.color === "string" && options.includes(action.color)) color = action.color;
      else return fail("Bitte eine Manafarbe wählen.");
    }
    additions.push(color);
  }
  found.card.tapped = true;
  for (const color of additions) found.player.pool[color] += 1;
  spendSacrificial(game, [found.card.id]);
  return ok();
}

function playLandAction(game, userId, action) {
  if (game.priority !== userId) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  const fromElsewhere = found && ((found.zone === "exile" && impulseOk(game, userId, found.card, "exile")) || (found.zone === "graveyard" && landsFromGraveyard(game, userId)));
  if (!found || (found.zone !== "hand" && !fromElsewhere)) return fail("Das Land muss in deiner Hand sein.");
  if (!defOf(game, found.card).types.land) return fail("Das ist kein Land.");
  if (game.turn.active !== userId || (game.turn.phase !== "main1" && game.turn.phase !== "main2") || game.stack.length > 0) {
    return fail("Länder spielst du nur in deiner Hauptphase bei leerem Stapel.");
  }
  const extraLands = (game.turn.extraLands ?? 0) + found.player.battlefield.reduce((sum, id) => sum + (defOf(game, game.cards[id]).rules?.extraLand ?? 0), 0);
  if (game.turn.landsPlayed >= 1 + extraLands) return fail("Du hast in diesem Zug schon ein Land gespielt (mit „Manuell bewegen“ trotzdem möglich).");
  found.player[found.zone].splice(found.index, 1);
  found.card.playUntil = undefined;
  found.card.playBy = undefined;
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
  const foretold = Boolean(found && found.zone === "exile" && found.card.foretoldTurn !== undefined && def?.rules?.foretell);
  if (foretold && found.card.foretoldTurn >= game.turn.number) return fail("Vorhergesagte Karten kannst du erst in einem späteren Zug wirken.");
  const impulse = Boolean(found && impulseOk(game, userId, found.card, found.zone));
  const free = Boolean(found && freeCastOk(game, userId, found.card, found.zone));
  if (castLocked(game, userId)) return fail("Während des Zuges dieses Gegners darfst du keine Zauber wirken.");
  if (!found || !def || (found.zone !== "hand" && found.zone !== "command" && !flashback && !foretold && !impulse && !free)) {
    return fail("Zaubern kannst du nur aus der Hand, der Kommandozone, (mit Rückblende) aus dem Friedhof oder (vorhergesagt) aus dem Exil.");
  }
  if (def.types.land) return fail("Länder werden mit „Land spielen“ gelegt.");
  const instantSpeed = def.types.instant || def.keywords.includes("flash");
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  if (!instantSpeed && !mainPhase && !free) {
    return fail("Dieser Zauber geht nur in deiner Hauptphase bei leerem Stapel (Sofortzauber und Blitz jederzeit).");
  }
  if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");
  const freeInfo = free ? found.card.freeCast : null;
  if (freeInfo) for (const other of Object.values(game.cards)) if (other.freeCast?.group === freeInfo.group) delete other.freeCast; // nur eine Karte je Erlaubnis
  const spellRules = def.rules?.spell;
  let activeRules = spellRules;
  let mode = null;
  let modeList = null;
  if (spellRules?.modes && Array.isArray(action.modes)) {
    const limits = modeLimits(game, userId, spellRules);
    modeList = [...new Set(action.modes.filter(index => Number.isInteger(index) && spellRules.modes[index]))];
    if (modeList.length < limits.min || modeList.length > limits.max) return fail(limits.min === limits.max ? `Wähle genau ${limits.min} Modi.` : `Wähle ${limits.min} bis ${limits.max} Modi.`);
    activeRules = combineModes(spellRules.modes, modeList);
  } else if (spellRules?.modes) {
    mode = action.mode;
    if (!Number.isInteger(mode) || !spellRules.modes[mode]) return fail("Wähle zuerst einen Modus für diesen Zauber.");
    activeRules = spellRules.modes[mode];
  }
  const specs = activeRules?.specs ?? [];
  if (specs.length > 0 && !targetsLegal(game, specs, action.targets, userId, srcOfDef(def, found.card.id))) return fail("Wähle gültige Ziele für diesen Zauber.");

  const x = isInt(action.x) ? clampInt(action.x, 0, 99) : 0;
  const tax = found.zone === "command" ? 2 * (player.cmdCasts[found.card.id] ?? 0) : 0;
  const extraCost = def.rules?.additionalCost?.map(item => (item.n === "X" ? { ...item, n: x } : item)); // „pay X life“
  const extraPay = resolvePay(game, userId, extraCost, action.pay, found.card.id);
  if (extraPay.error) return fail(extraPay.error);
  const ward = specs.length > 0 ? wardExtra(game, userId, action.targets) : "";
  const evoked = action.evoke === true && Boolean(def.rules?.evoke) && found.zone === "hand";
  const mutating = typeof action.mutate === "string" && Boolean(def.rules?.mutate) && found.zone === "hand";
  if (mutating && !mutateTargets(game, userId).includes(action.mutate)) return fail("Mutate: Wähle eine eigene Kreatur, die kein Mensch ist.");
  const cost = (freeInfo ? "" : flashback ? def.rules.flashback : foretold ? def.rules.foretell : evoked ? def.rules.evoke : mutating ? def.rules.mutate : hasFreeCast(game, userId, def) ? "" : def.manaCost) + ward;
  const alt = planWithAlternatives(game, userId, def, { manaCost: cost, x, extraGeneric: tax - costReduction(game, def, userId), pool: player.pool, sources: chosenSources(manaSources(game, userId), action) });
  const plan = alt.plan;
  if (!plan.ok) {
    return fail(`Nicht genug Mana für ${describeCost(cost, x, tax)}${tax ? " (inkl. Kommandantensteuer)" : ""}${ward ? " (inkl. Ward)" : ""}.`);
  }
  for (const id of alt.convoke) {
    game.cards[id].tapped = true;
    addLog(game, `${nameOf(game, id)} wird zum Bezahlen getappt (Convoke).`);
  }
  if (alt.delve.length > 0) {
    for (const id of alt.delve) {
      player.graveyard.splice(player.graveyard.indexOf(id), 1);
      player.exile.push(id);
    }
    addLog(game, `${alt.delve.length} Friedhofskarte${alt.delve.length === 1 ? "" : "n"} werden exiliert (Delve).`);
  }
  for (const id of plan.tap) game.cards[id].tapped = true;
  spendSacrificial(game, plan.tap);
  for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
  for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  if (plan.lifeLoss) player.life -= plan.lifeLoss;
  const paid = ` (${describeCost(cost, x, tax)}${flashback ? ", Rückblende" : ""})`;
  player[found.zone].splice(found.index, 1);
  applyPay(game, userId, extraPay.picks, def.name); // erst danach: das Abwerfen verschiebt sonst die Position der Karte
  if (found.zone === "command") player.cmdCasts[found.card.id] = (player.cmdCasts[found.card.id] ?? 0) + 1;
  found.card.revealed = false;
  const greatestPower = player.battlefield.reduce((max, id) => (defOf(game, game.cards[id]).types.creature ? Math.max(max, powerOf(game, game.cards[id])) : max), 0);
  found.card.faceDown = false;
  game.stack.push({ sid: newId(game, "s"), kind: "spell", controller: userId, cardId: found.card.id, x, flashback, mode, targets: specs.length > 0 ? action.targets : [], greatestPower, fromExile: found.zone === "exile", evoked, ...(modeList ? { modeList } : {}), ...(freeInfo?.exileAfter ? { exileAfter: true } : {}), ...(mutating ? { mutate: action.mutate, over: action.over !== false } : {}) });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} wirkt ${def.name}${paid}.`);
  if (def.types.creature) fireGlobal(game, "castCreature", found.card);
  else fireGlobal(game, "castNoncreature", found.card);
  fireGlobal(game, "castSpell", found.card);
  fireGlobal(game, "castKind", found.card);
  if (player.castTurn !== game.turn.number) {
    player.castTurn = game.turn.number;
    player.castsThisTurn = 0;
  }
  player.castsThisTurn += 1;
  if (player.noncreatureTurn !== game.turn.number) {
    player.noncreatureTurn = game.turn.number;
    player.noncreatureCasts = 0;
  }
  if (!def.types.creature) player.noncreatureCasts += 1;
  if (player.castsThisTurn === 2) fireGlobal(game, "castSecond", found.card);
  if (def.rules?.storm && (def.types.instant || def.types.sorcery)) {
    const original = game.stack.find(item => item.cardId === found.card.id && item.kind === "spell" && !item.copy);
    for (let i = 0; i < player.castsThisTurn - 1 && original && game.stack.length < MAX_STACK; i += 1) {
      game.stack.push({ ...original, sid: newId(game, "s"), copy: true, targets: [...(original.targets ?? [])] });
    }
    if (player.castsThisTurn > 1) addLog(game, `Storm: ${def.name} wird ${player.castsThisTurn - 1}× kopiert.`);
  }
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
/** Vorhersagen (Foretell): in deinem Zug für {2} verdeckt ins Exil, später für die Vorhersagekosten wirken. */
function foretellOptions(game, userId, card) {
  const def = defOf(game, card);
  const cost = def.rules?.foretell;
  if (!cost || !game.players[userId].hand.includes(card.id)) return null;
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const ok = playing && game.turn.active === userId && hasWindow(game, userId) && planPayment({ manaCost: "{2}", pool: player.pool, sources: manaSources(game, userId) }).ok;
  return { ok, cost };
}

function foretellAction(game, userId, action) {
  const player = game.players[userId];
  if (!hasWindow(game, userId)) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  if (!found || found.zone !== "hand" || !defOf(game, found.card).rules?.foretell) return fail("Diese Karte kann nicht vorhergesagt werden.");
  if (game.turn.active !== userId) return fail("Vorhersagen darfst du nur in deinem eigenen Zug.");
  const plan = planPayment({ manaCost: "{2}", pool: player.pool, sources: chosenSources(manaSources(game, userId), action) });
  if (!plan.ok) return fail("Nicht genug Mana für {2}.");
  for (const id of plan.tap) game.cards[id].tapped = true;
  spendSacrificial(game, plan.tap);
  for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
  for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  player.hand.splice(player.hand.indexOf(found.card.id), 1);
  player.exile.push(found.card.id);
  found.card.faceDown = true;
  found.card.foretoldTurn = game.turn.number;
  addLog(game, `${player.name} sagt eine Karte vorher (verdeckt im Exil).`);
  return ok();
}

/** Evoke: alternative Kosten; die Kreatur wird beim Ins-Spiel-Kommen geopfert. */
function evokeOptions(game, userId, card) {
  const def = defOf(game, card);
  if (!def.rules?.evoke || !game.players[userId].hand.includes(card.id)) return null;
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  const timing = playing && hasWindow(game, userId) && (def.keywords.includes("flash") || mainPhase);
  const ok = timing && planPayment({ manaCost: def.rules.evoke, pool: player.pool, sources: manaSources(game, userId) }).ok;
  return { ok, cost: def.rules.evoke };
}

function mutateOptions(game, userId, card) {
  const def = defOf(game, card);
  if (!def.rules?.mutate || !game.players[userId].hand.includes(card.id)) return null;
  const player = game.players[userId];
  const playing = game.phase === "playing" && !player.eliminated && !game.pendingDiscard && !game.choice && !game.manual;
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  const targets = mutateTargets(game, userId).map(id => ({ id, name: nameOf(game, id) }));
  const ok = playing && hasWindow(game, userId) && (def.keywords.includes("flash") || mainPhase) && targets.length > 0 && planPayment({ manaCost: def.rules.mutate, pool: player.pool, sources: manaSources(game, userId) }).ok;
  return { ok, cost: def.rules.mutate, targets };
}

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
  spendSacrificial(game, plan.tap);
  for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
  for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  toGraveyard(game, found.card, "hand");
  fireTriggers(game, found.card, "cycled"); // „When you cycle this card“
  fireGlobal(game, "youCycle", found.card);
  fireDiscards(game, [found.card.id]);
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

/** Wählt automatisch die schwächste Gruppe ungetappter Kreaturen, deren Gesamtstärke für die Besatzung reicht (so wenige wie möglich). */
function pickCrew(game, userId, vehicleId, need) {
  const pool = game.players[userId].battlefield
    .filter(id => id !== vehicleId && defOf(game, game.cards[id]).types.creature && !game.cards[id].tapped)
    .map(id => ({ id, power: Math.max(0, powerOf(game, game.cards[id])) }))
    .slice(0, 14);
  let best = null;
  for (let mask = 1; mask < 1 << pool.length; mask += 1) {
    const chosen = pool.filter((_, i) => mask & (1 << i));
    const sum = chosen.reduce((total, item) => total + item.power, 0);
    if (sum < need) continue;
    if (!best || chosen.length < best.chosen.length || (chosen.length === best.chosen.length && sum < best.sum)) best = { chosen, sum };
  }
  return best ? best.chosen.map(item => item.id) : null;
}

function activateAction(game, userId, action) {
  const player = game.players[userId];
  if (!hasWindow(game, userId)) return fail("Du hast gerade keine Priorität.");
  const found = locate(game, userId, action.id);
  const ability = found ? defOf(game, found.card).rules?.activated?.[action.index] : null;
  const wantZone = ability?.zone ?? "battlefield";
  if (!found || found.zone !== wantZone) return fail(wantZone === "graveyard" ? "Die Karte muss auf deinem Friedhof liegen." : "Die Karte muss auf deinem Schlachtfeld liegen.");
  const card = found.card;
  const def = defOf(game, card);
  if (!ability) return fail("Diese Fähigkeit gibt es nicht.");
  if (!tierOn(card, ability)) return fail("Dafür sind noch nicht genug Ladungsmarker auf der Karte.");
  const mainPhase = game.turn.active === userId && (game.turn.phase === "main1" || game.turn.phase === "main2") && game.stack.length === 0;
  if (ability.sorcery && !mainPhase) return fail("Diese Fähigkeit geht nur in deiner Hauptphase bei leerem Stapel.");
  if (game.stack.length >= MAX_STACK) return fail("Der Stapel ist voll.");
  if (ability.cost.tap && (card.tapped || isSick(game, card))) return fail(card.tapped ? "Die Karte ist bereits getappt." : "Diese Kreatur ist noch beschwörungsmüde.");
  if (ability.cost.loyalty !== undefined) {
    if (card.loyaltyTurn === game.turn.number) return fail("Pro Zug darf nur eine Loyalitätsfähigkeit je Planeswalker benutzt werden.");
    if ((card.counters.loyalty ?? 0) + ability.cost.loyalty < 0) return fail("Nicht genug Loyalität.");
  }
  if (ability.specs.length > 0 && !targetsLegal(game, ability.specs, action.targets, userId, srcOfDef(def, card.id))) return fail("Wähle gültige Ziele für diese Fähigkeit.");

  const extraPay = resolvePay(game, userId, ability.cost.extra, action.pay, card.id);
  if (extraPay.error) return fail(extraPay.error);
  let crewed = [];
  if (ability.cost.crew) {
    crewed = pickCrew(game, userId, card.id, ability.cost.crew);
    if (!crewed) return fail(`Besatzung ${ability.cost.crew}: Du hast nicht genug ungetappte Kreaturen mit der nötigen Gesamtstärke.`);
  }
  const abilityWard = ability.specs.length > 0 ? wardExtra(game, userId, action.targets) : "";
  const abilityMana = (ability.cost.mana ?? "") + abilityWard;
  if (abilityMana) {
    const sources = chosenSources(manaSources(game, userId).filter(source => source.id !== card.id), action);
    const plan = planPayment({ manaCost: abilityMana, pool: player.pool, sources });
    if (!plan.ok) return fail(`Nicht genug Mana für ${describeCost(abilityMana)}${abilityWard ? " (inkl. Ward)" : ""}.`);
    for (const id of plan.tap) game.cards[id].tapped = true;
  spendSacrificial(game, plan.tap);
    for (const color of Object.keys(plan.poolUsed)) player.pool[color] -= plan.poolUsed[color];
    for (const color of Object.keys(plan.poolAdd)) player.pool[color] += plan.poolAdd[color];
  }
  if (ability.cost.tap) {
    card.tapped = true;
    fireTriggers(game, card, "becomesTapped");
  }
  for (const id of crewed) {
    game.cards[id].tapped = true;
    fireTriggers(game, game.cards[id], "becomesTapped");
  }
  if (crewed.length > 0) addLog(game, `${player.name} tappt zur Besatzung: ${crewed.map(id => nameOf(game, id)).join(", ")}.`);
  applyPay(game, userId, extraPay.picks, def.name, card.id);
  if (ability.cost.sacrifice) {
    addLog(game, `${player.name} opfert ${def.name}.`);
    noteSacrifice(game, card);
    toGraveyard(game, card);
  }
  if (ability.cost.discardSelf && player.hand.includes(card.id)) {
    player.hand.splice(player.hand.indexOf(card.id), 1);
    player.graveyard.push(card.id);
    addLog(game, `${player.name} wirft ${def.name} ab.`);
    fireDiscards(game, [card.id]);
  }
  if (ability.cost.exileSelf) {
    if (onBattlefield(game, card.id)) {
      addLog(game, `${player.name} schickt ${def.name} ins Exil.`);
      leaveTo(game, card, "exile");
    } else {
      player.graveyard.splice(player.graveyard.indexOf(card.id), 1);
      player.exile.push(card.id);
      addLog(game, `${player.name} legt ${def.name} aus dem Friedhof ins Exil.`);
    }
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
    unparsed: ability.unparsed,
    paidPower: extraPay.picks.filter(pick => pick.item.kind === "tap").flatMap(pick => pick.ids).reduce((sum, id) => sum + Math.max(0, powerOf(game, game.cards[id])), 0)
  });
  game.priority = userId;
  game.passed = [];
  addLog(game, `${player.name} aktiviert ${def.name}: ${ability.summary || ability.text.replace(/~/g, def.name)}`);
  return ok();
}

/** Kreaturen, die angreifen müssen, wenn sie können („attacks each combat if able“, Goad). */
function forcedAttackers(game, userId) {
  // Kostet ein Angriff etwas (Ghostly Prison …), besteht keine Pflicht, die Kosten zu zahlen (Regel 508.1d).
  if (game.seats.some(seat => seat !== userId && game.players[seat].battlefield.some(id => defOf(game, game.cards[id]).rules?.attackTax))) return [];
  return game.players[userId].battlefield.filter(id => {
    const c = game.cards[id];
    if (!defOf(game, c).types.creature || c.tapped || c.faceDown || isSick(game, c)) return false;
    return hasKeyword(game, c, "must-attack") && !hasKeyword(game, c, "defender") && !hasKeyword(game, c, "cant-attack");
  });
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
    if (hasKeyword(game, card, "cant-attack")) return fail(`${def.name} kann nicht angreifen.`);
    const target = typeof entry.target === "string" ? entry.target : opponents.length === 1 ? opponents[0] : "";
    const walker = game.cards[target];
    const walkerOk = walker && onBattlefield(game, target) && defOf(game, walker).types.planeswalker && opponents.includes(walker.owner);
    if (!opponents.includes(target) && !walkerOk) return fail("Wähle für jeden Angreifer einen Gegner oder einen gegnerischen Planeswalker.");
    const goaders = card.goadedBy ?? [];
    if (goaders.includes(attackTargetOwner(game, target)) && opponents.some(id => !goaders.includes(id))) return fail(`${def.name} ist aufgestachelt und muss einen anderen Spieler angreifen.`);
    attackers.push({ id: entry.id, target });
  }
  const missing = forcedAttackers(game, userId).find(id => !attackers.some(a => a.id === id));
  if (missing) return fail(`${nameOf(game, missing)} muss angreifen, wenn möglich.`);
  if (attackers.length === 0) {
    addLog(game, `${game.players[userId].name} greift nicht an.`);
    enterPhase(game, "main2");
    settle(game, random, now);
    return ok();
  }
  // Angriffssteuer (Ghostly Prison, Propaganda): wird beim Angriff automatisch bezahlt
  const taxByDefender = new Map();
  for (const attacker of attackers) {
    const defenderId = attackTargetOwner(game, attacker.target);
    taxByDefender.set(defenderId, (taxByDefender.get(defenderId) ?? 0) + 1);
  }
  let taxCost = "";
  for (const [defenderId, count] of taxByDefender) {
    for (const id of game.players[defenderId].battlefield) {
      const per = defOf(game, game.cards[id]).rules?.attackTax;
      if (per) taxCost += `{${per * count}}`;
    }
  }
  if (taxCost) {
    const plan = planPayment({ manaCost: taxCost, pool: game.players[userId].pool, sources: manaSources(game, userId) });
    if (!plan.ok) return fail(`Für diesen Angriff musst du ${taxCost} bezahlen (Angriffssteuer), hast aber nicht genug Mana.`);
    for (const id of plan.tap) game.cards[id].tapped = true;
    spendSacrificial(game, plan.tap);
    for (const color of Object.keys(plan.poolUsed)) game.players[userId].pool[color] -= plan.poolUsed[color];
    for (const color of Object.keys(plan.poolAdd)) game.players[userId].pool[color] += plan.poolAdd[color];
    addLog(game, `${game.players[userId].name} bezahlt ${taxCost} Angriffssteuer.`);
  }
  for (const attacker of attackers) {
    const card = game.cards[attacker.id];
    if (!hasKeyword(game, card, "vigilance")) {
      card.tapped = true;
      fireTriggers(game, card, "becomesTapped");
    }
    fireTriggers(game, card, "attacks");
    fireGlobal(game, "creatureAttacks", card);
    for (const other of Object.values(game.cards)) {
      if (other.attachedTo !== card.id || !onBattlefield(game, other.id)) continue;
      for (const trigger of defOf(game, other).rules?.triggers ?? []) {
        if (trigger.event === "attachedAttacks") game.triggerQueue.push({ controller: other.owner, source: other.id, sourceName: defOf(game, other).name, trigger });
      }
    }
  }
  game.combat = { attackers, blocks: [], done: [], phaseWaiting: true };
  game.turn.attackedWith = attackers.length;
  game.turn.attackedOpponents = { ...(game.turn.attackedOpponents ?? {}), [userId]: [...new Set(attackers.map(attacker => attackTargetOwner(game, attacker.target)).filter(Boolean))] };
  fireGlobal(game, "youAttack", userId); // „Whenever you attack“ (einmal je Angriff)
  fireGlobal(game, "anyAttack", userId); // „Whenever one or more creatures attack“
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
    if (hasKeyword(game, blocker, "cant-block")) return fail(`${bdef.name} kann nicht blocken.`);
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
  for (const entry of chosen) if (game.cards[entry.blocker]) fireTriggers(game, game.cards[entry.blocker], "blocks");
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
  if (from === "battlefield" && card.mutStack) placeParts(game, splitMutated(game, card), to === "battlefield" ? "graveyard" : to);

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
