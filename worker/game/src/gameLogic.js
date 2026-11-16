/**
 * Spielkern des digitalen Spieltischs (reine Logik, ohne Cloudflare-Abhängigkeiten, in Node testbar).
 *
 * Grundsatz: Der **Server** hält den ganzen Spielstand. Jeder Spieler bekommt nur seine eigene Sicht
 * (`gameView`): die eigene Hand, bei den anderen nur Kartenzahlen; Bibliotheken sieht nie jemand (Mischen
 * und Ziehen passieren hier). Es gibt keine Regelautomatik – Spieler bewegen ihre eigenen Karten selbst.
 * Automatisch sind nur Komfortfunktionen: Starthand, Mulligan, Zugwechsel (Enttappen und Ziehen),
 * Ausscheiden bei 0 Leben, 10 Giftmarken oder 21 Kommandantenschaden.
 */

export const GAME_VERSION = 1;
export const ZONES = ["library", "hand", "battlefield", "graveyard", "exile", "command"];
/** Zonen, in denen alle Spieler die Karten sehen. */
const PUBLIC_ZONES = new Set(["battlefield", "graveyard", "exile", "command"]);
export const PHASES = ["beginning", "main1", "combat", "main2", "end"];
export const PLAYER_COUNTERS = ["poison", "energy", "experience"];
export const START_LIFE = { standard: 20, commander: 40 };
export const HAND_SIZE = 7;
export const MAX_LOG = 200;
export const MAX_TOKENS = 60;
export const MAX_COUNTERS = 99;

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fail = error => ({ ok: false, error });
const ok = () => ({ ok: true });
const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(value))));
const isInt = value => Number.isInteger(value);

/** Fisher-Yates-Mischen; `random` liefert Zahlen in [0, 1). */
export function shuffle(list, random = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function addLog(game, text) {
  game.logSeq += 1;
  game.log.push({ n: game.logSeq, text });
  if (game.log.length > MAX_LOG) game.log.splice(0, game.log.length - MAX_LOG);
}

function newId(game, prefix = "c") {
  game.nextId += 1;
  return `${prefix}${game.nextId}`;
}

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
    cmdCasts: {}
  };
}

function addCard(game, userId, defId, zone) {
  const id = newId(game);
  game.cards[id] = { id, owner: userId, def: defId, tapped: false, faceDown: false, counters: {}, revealed: false, token: false };
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

/**
 * Erstellt ein neues Spiel aus einem Raum (jeder Spieler mit seinem geprüften Deck-Schnappschuss).
 * @param {{ room: object, random?: () => number, now?: number }} input
 */
export function createGame({ room, random = Math.random, now = Date.now() }) {
  const entries = Object.entries(room.players).sort((a, b) => a[1].seat - b[1].seat);
  const game = {
    version: GAME_VERSION,
    format: room.format,
    phase: "mulligan",
    seats: entries.map(([userId]) => userId),
    players: {},
    cards: {},
    defs: {},
    nextId: 0,
    log: [],
    logSeq: 0,
    turn: { number: 0, active: null, phase: "beginning", first: null },
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
    const defKey = card => `${userId}:${card.id}`;
    const addDef = card => {
      game.defs[defKey(card)] = {
        name: card.name,
        typeLine: card.typeLine ?? "",
        manaValue: card.manaValue ?? 0,
        imageUri: card.imageUri ?? null
      };
      return defKey(card);
    };
    for (const card of info.deck.commanders ?? []) {
      const key = addDef(card);
      for (let i = 0; i < (card.count || 1); i += 1) addCard(game, userId, key, "command");
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

// ---------------------------------------------------------------------------
// Sicht pro Spieler
// ---------------------------------------------------------------------------

function cardView(game, id, { hideFace = false } = {}) {
  const card = game.cards[id];
  const view = {
    id,
    owner: card.owner,
    tapped: card.tapped,
    counters: card.counters,
    token: card.token,
    faceDown: card.faceDown
  };
  if (hideFace) return view;
  const def = game.defs[card.def];
  return { ...view, name: def?.name ?? "?", typeLine: def?.typeLine ?? "", manaValue: def?.manaValue ?? 0, imageUri: def?.imageUri ?? null };
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
      counts: {
        library: p.library.length,
        hand: p.hand.length,
        battlefield: p.battlefield.length,
        graveyard: p.graveyard.length,
        exile: p.exile.length,
        command: p.command.length
      },
      hand: mine
        ? p.hand.map(id => cardView(game, id))
        : p.hand.filter(id => game.cards[id].revealed).map(id => cardView(game, id)),
      battlefield: p.battlefield.map(id => cardView(game, id, { hideFace: !mine && game.cards[id].faceDown })),
      graveyard: p.graveyard.map(id => cardView(game, id)),
      exile: p.exile.map(id => cardView(game, id, { hideFace: !mine && game.cards[id].faceDown })),
      command: p.command.map(id => cardView(game, id)),
      looking: mine && p.looking ? p.looking.map(id => cardView(game, id)) : null,
      cmdDamage: p.cmdDamage,
      cmdCasts: p.cmdCasts
    };
  });
  return {
    format: game.format,
    phase: game.phase,
    you: viewerId,
    turn: game.turn,
    winner: game.winner,
    startedAt: game.startedAt,
    endedAt: game.endedAt,
    players,
    log: game.log.slice(-100)
  };
}

// ---------------------------------------------------------------------------
// Hilfen
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

const cardName = (game, id) => game.defs[game.cards[id].def]?.name ?? "Karte";

function alive(game) {
  return game.seats.filter(userId => !game.players[userId].eliminated);
}

function finishGame(game, now, aborted = false) {
  const survivors = alive(game);
  game.phase = "ended";
  game.endedAt = now;
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

function nextActive(game, fromUserId) {
  const order = game.seats;
  const start = order.indexOf(fromUserId);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step) % order.length];
    if (!game.players[candidate].eliminated) return candidate;
  }
  return null;
}

function startTurn(game, userId, { skipDraw = false } = {}) {
  const player = game.players[userId];
  game.turn.active = userId;
  game.turn.phase = "beginning";
  for (const id of player.battlefield) game.cards[id].tapped = false;
  addLog(game, `Zug ${game.turn.number}: ${player.name} ist am Zug (Karten enttappt).`);
  if (!skipDraw) {
    const drawn = drawCards(game, userId, 1);
    addLog(game, drawn ? `${player.name} zieht eine Karte.` : `${player.name} kann keine Karte ziehen (Bibliothek leer).`);
  }
}

function eliminate(game, userId, reason, now) {
  const player = game.players[userId];
  if (player.eliminated || game.phase === "ended") return;
  player.eliminated = reason;
  addLog(game, `${player.name} scheidet aus (${reason}).`);
  if (alive(game).length <= 1) {
    finishGame(game, now);
    return;
  }
  if (game.phase === "playing" && game.turn.active === userId) {
    const next = nextActive(game, userId);
    game.turn.number += 1;
    startTurn(game, next);
  }
}

function checkElimination(game, userId, now) {
  const player = game.players[userId];
  if (player.eliminated) return;
  if (player.life <= 0) eliminate(game, userId, "0 Lebenspunkte", now);
  else if (player.poison >= 10) eliminate(game, userId, "10 Giftmarken", now);
  else if (Object.values(player.cmdDamage).some(value => value >= 21)) eliminate(game, userId, "21 Kommandantenschaden", now);
}

function resetCardState(card) {
  card.tapped = false;
  card.faceDown = false;
  card.counters = {};
  card.revealed = false;
}

function startPlaying(game, random, now) {
  game.phase = "playing";
  const first = game.seats[Math.floor(random() * game.seats.length)];
  game.turn.first = first;
  game.turn.number = 1;
  addLog(game, `${game.players[first].name} beginnt (zufällig bestimmt).`);
  startTurn(game, first, { skipDraw: game.seats.length === 2 });
  void now;
}

// ---------------------------------------------------------------------------
// Aktionen
// ---------------------------------------------------------------------------

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
        names.push(cardName(game, id));
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
      addLog(game, `${player.name} dreht eine Karte ${found.card.faceDown ? "verdeckt" : `auf (${cardName(game, found.card.id)})`}.`);
      return ok();
    }
    case "reveal": {
      const found = locate(game, userId, action.id);
      if (!found || found.zone !== "hand") return fail("Nur Handkarten können gezeigt werden.");
      found.card.revealed = !found.card.revealed;
      addLog(game, found.card.revealed ? `${player.name} zeigt ${cardName(game, found.card.id)}.` : `${player.name} versteckt eine Handkarte wieder.`);
      return ok();
    }
    case "counter": {
      const found = locate(game, userId, action.id);
      if (!found || (found.zone !== "battlefield" && found.zone !== "command")) return fail("Marker gehen nur auf Karten im Spiel.");
      const kind = typeof action.kind === "string" ? action.kind.trim().slice(0, 20) : "";
      if (!kind || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > MAX_COUNTERS) return fail("Ungültiger Marker.");
      const next = Math.min(MAX_COUNTERS, Math.max(0, (found.card.counters[kind] ?? 0) + action.delta));
      if (next === 0) delete found.card.counters[kind];
      else found.card.counters[kind] = next;
      if (Object.keys(found.card.counters).length > 6) {
        delete found.card.counters[kind];
        return fail("Höchstens 6 verschiedene Markerarten je Karte.");
      }
      return ok();
    }
    case "token": {
      const name = typeof action.name === "string" ? action.name.replace(/[^\p{L}\p{N} /+*'.,:-]/gu, "").trim().slice(0, 40) : "";
      if (!name) return fail("Name des Spielsteins fehlt.");
      const tokens = Object.values(game.cards).filter(card => card.token && card.owner === userId).length;
      if (tokens >= MAX_TOKENS) return fail(`Höchstens ${MAX_TOKENS} Spielsteine je Spieler.`);
      const id = newId(game, "t");
      const defKey = `token:${id}`;
      game.defs[defKey] = { name, typeLine: "Token", manaValue: 0, imageUri: null };
      game.cards[id] = { id, owner: userId, def: defKey, tapped: false, faceDown: false, counters: {}, revealed: false, token: true };
      player.battlefield.push(id);
      addLog(game, `${player.name} erzeugt einen Spielstein: ${name}.`);
      return ok();
    }
    case "life": {
      let delta;
      if (isInt(action.set)) delta = clampInt(action.set, -999, 999) - player.life;
      else if (isInt(action.delta)) delta = clampInt(action.delta, -999, 999);
      else return fail("Ungültige Lebenspunkte.");
      if (delta === 0) return ok();
      player.life += delta;
      addLog(game, `${player.name}: Leben ${delta > 0 ? "+" : ""}${delta} (jetzt ${player.life}).`);
      checkElimination(game, userId, now);
      return ok();
    }
    case "pcounter": {
      if (!PLAYER_COUNTERS.includes(action.kind) || !isInt(action.delta) || action.delta === 0 || Math.abs(action.delta) > 20) {
        return fail("Ungültiger Spielermarker.");
      }
      player[action.kind] = Math.max(0, player[action.kind] + action.delta);
      addLog(game, `${player.name}: ${PLAYER_LABELS[action.kind]} ${action.delta > 0 ? "+" : ""}${action.delta} (jetzt ${player[action.kind]}).`);
      checkElimination(game, userId, now);
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
      checkElimination(game, userId, now);
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
    case "nextPhase": {
      if (game.turn.active !== userId) return fail("Du bist nicht am Zug.");
      const index = PHASES.indexOf(game.turn.phase);
      if (index >= PHASES.length - 1) return fail("Beende stattdessen den Zug.");
      game.turn.phase = PHASES[index + 1];
      return ok();
    }
    case "endTurn": {
      if (game.turn.active !== userId) return fail("Du bist nicht am Zug.");
      const next = nextActive(game, userId);
      game.turn.number += 1;
      startTurn(game, next);
      return ok();
    }
    case "concede":
      eliminate(game, userId, "aufgegeben", now);
      return ok();
    default:
      return fail("Unbekannte Aktion.");
  }
}

const PLAYER_LABELS = { poison: "Giftmarken", energy: "Energie", experience: "Erfahrung" };

function mulliganAction(game, userId, action, random, now) {
  const player = game.players[userId];
  if (action.type === "concede") {
    eliminate(game, userId, "aufgegeben", now);
    if (game.phase === "mulligan" && alive(game).every(id => game.players[id].kept)) startPlaying(game, random, now);
    return ok();
  }
  if (action.type === "dice" || action.type === "coin") return ok();
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
    if (alive(game).every(id => game.players[id].kept)) startPlaying(game, random, now);
    return ok();
  }
  return fail("Zuerst muss jeder Spieler seine Starthand behalten oder einen Mulligan nehmen.");
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
    delete game.cards[card.id];
    addLog(game, `${player.name}: Spielstein ${game.defs[card.def]?.name ?? ""} verschwindet.`);
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
  if (from === "command" && to !== "command") {
    player.cmdCasts[card.id] = (player.cmdCasts[card.id] ?? 0) + 1;
  }
  if (action.faceDown === true && (to === "battlefield" || to === "exile")) card.faceDown = true;

  const hiddenMove = (!PUBLIC_ZONES.has(to) || card.faceDown) && !publicFrom;
  const name = hiddenMove ? "eine Karte" : cardName(game, card.id);
  addLog(game, `${player.name} bewegt ${name}: ${ZONE_LABELS[from]} → ${ZONE_LABELS[to]}${to === "library" ? (action.position === "bottom" ? " (unten)" : " (oben)") : ""}.`);
  return ok();
}

export const ZONE_LABELS = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};

/** Spiel abbrechen (Raum geschlossen oder abgelaufen); liefert die Zusammenfassung für den Verlauf. */
export function abortGame(game, now = Date.now()) {
  if (game.phase === "ended") return game.summary;
  finishGame(game, now, true);
  return game.summary;
}

/** Spieler verlässt mitten im Spiel: gilt als aufgegeben. */
export function playerLeft(game, userId, { random = Math.random, now = Date.now() } = {}) {
  if (!game.players[userId] || game.phase === "ended") return;
  eliminate(game, userId, "hat den Raum verlassen", now);
  if (game.phase === "mulligan" && alive(game).every(id => game.players[id].kept)) startPlaying(game, random, now);
}
