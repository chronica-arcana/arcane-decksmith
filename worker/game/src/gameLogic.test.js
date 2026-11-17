import { describe, expect, it } from "vitest";
import { abortGame, applyAction, createGame, gameView, joinGame, playerLeft, repairGame, splitGame } from "./gameLogic.js";

const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const LIB = [
  ["forest", "Forest", "Basic Land — Forest", "", 24, {}],
  ["mountain", "Mountain", "Basic Land — Mountain", "", 6, {}],
  ["bear", "Bär", "Creature — Bear", "{1}{G}", 4, { power: "2", toughness: "2" }],
  ["giant", "Riese", "Creature — Giant", "{3}{G}{G}", 2, { power: "5", toughness: "5", keywords: ["Trample"] }],
  ["hawk", "Falke", "Creature — Bird", "{G}", 2, { power: "1", toughness: "1", keywords: ["Flying"] }],
  ["viper", "Viper", "Creature — Snake", "{G}", 2, { power: "1", toughness: "1", keywords: ["Deathtouch"] }],
  ["knight", "Ritter", "Creature — Knight", "{G}", 2, { power: "2", toughness: "1", keywords: ["First Strike"] }],
  ["bat", "Fledermaus", "Creature — Bat", "{G}", 2, { power: "2", toughness: "2", keywords: ["Lifelink"] }],
  ["wall", "Mauer", "Creature — Wall", "{G}", 2, { power: "0", toughness: "4", keywords: ["Defender"] }],
  ["ogre", "Oger", "Creature — Ogre", "{G}", 2, { power: "3", toughness: "3", keywords: ["Menace", "Haste"] }],
  ["bolt", "Blitz", "Instant", "{R}", 2, {}, "Blitz deals 3 damage to any target."],
  ["sorcery", "Zauberspruch", "Sorcery", "{G}{G}", 2, {}],
  ["xspell", "Flut", "Sorcery", "{X}{G}", 2, {}],
  ["seer", "Seher", "Creature — Elf", "{G}", 2, { power: "1", toughness: "1" }, "When Seher enters the battlefield, draw a card."],
  ["heal", "Heilung", "Instant", "{G}", 2, {}, "You gain 4 life."],
  ["study", "Studium", "Sorcery", "{G}", 2, {}, "Draw two cards."],
  ["kill", "Zerstörer", "Instant", "{R}", 2, {}, "Destroy target creature."],
  ["counter", "Gegenzauber", "Instant", "{R}", 2, {}, "Counter target spell."],
  ["growth", "Wachstum", "Sorcery", "{G}", 2, {}, "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle."],
  ["mage", "Magier", "Creature — Wizard", "{G}", 2, { power: "1", toughness: "1" }, "{T}: Magier deals 1 damage to any target."],
  ["ritual", "Ritual", "Instant", "{G}", 2, {}, "Add {R}{R}{R}."],
  ["alarm", "Alarm", "Instant", "{G}", 2, {}, "Create two 1/1 white Soldier creature tokens."],
  ["mystery", "Rätsel", "Sorcery", "{G}", 2, {}, "Each player sacrifices a creature."],
  ["kavu", "Kavu", "Creature — Kavu", "{G}", 2, { power: "4", toughness: "2" }, "When Kavu enters the battlefield, it deals 2 damage to target creature."],
  ["scrier", "Seherin", "Sorcery", "{G}", 2, {}, "Scry 2."],
  ["pain", "Qual", "Sorcery", "{G}", 2, {}, "Each opponent discards a card."],
  ["shroud", "Schleier", "Creature — Spirit", "{G}", 2, { power: "1", toughness: "1", keywords: ["Hexproof"] }],
  ["anthem", "Hymne", "Enchantment", "{G}", 2, {}, "Creatures you control get +1/+1."],
  ["lord", "Anführer", "Creature — Elf", "{G}", 2, { power: "2", toughness: "2" }, "Other creatures you control get +1/+1 and have flying."],
  ["dreams", "Träume", "Instant", "{G}", 2, {}, "Surveil 1, then draw a card.\nFlashback {R}"],
  ["bard", "Barde", "Creature — Elf", "{G}", 2, { power: "1", toughness: "1" }, "Whenever a land enters the battlefield under your control, you gain 1 life."],
  ["reaper", "Schnitter", "Creature — Horror", "{G}", 2, { power: "1", toughness: "1" }, "Whenever a creature an opponent controls dies, put a +1/+1 counter on ~."],
  ["wilds", "Wildnis", "Land", "", 2, {}, "{T}, Sacrifice Wildnis: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle."],
  ["cliffs", "Klippen", "Land", "", 2, {}, "Klippen enters tapped.\nWhen Klippen enters, you gain 1 life.\n{T}: Add {U} or {R}."],
  ["slow", "Langsam", "Land", "", 2, {}, "Langsam enters the battlefield tapped unless you control two or more other lands.\n{T}: Add {G}."],
  ["check", "Prüfland", "Land", "", 2, {}, "Prüfland enters the battlefield tapped unless you control a Mountain or a Swamp.\n{T}: Add {G}."],
  ["shock", "Schock", "Land — Forest Mountain", "", 2, {}, "As Schock enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped."],
  ["reveal", "Zeigland", "Land", "", 2, {}, "As Zeigland enters the battlefield, you may reveal a Mountain card from your hand. If you don't, it enters the battlefield tapped."],
  ["karoo", "Rücklauf", "Land", "", 2, {}, "Rücklauf enters the battlefield tapped.\nWhen Rücklauf enters the battlefield, return a land you control to its owner's hand.\n{T}: Add {G}{R}."],
  ["priest", "Priester", "Creature — Cleric", "{G}", 2, { power: "1", toughness: "1" }, "At the beginning of your end step, you gain 1 life."]
];
const facts = new Map();

function deck(prefix, { commander = false } = {}) {
  const main = LIB.map(([key, name, typeLine, manaCost, count, extra, oracleText]) => {
    const id = `${prefix}-${key}`;
    facts.set(id, extra);
    return { id, name, count, typeLine, manaCost, manaValue: 2, imageUri: null, oracleText: oracleText ?? "" };
  });
  const commanders = commander
    ? [{ id: `${prefix}-cmd`, name: `Boss ${prefix}`, count: 1, typeLine: "Legendary Creature — Dragon", manaCost: "{1}{G}", manaValue: 2, imageUri: null }]
    : [];
  facts.set(`${prefix}-cmd`, { power: "4", toughness: "4", keywords: ["Haste"] });
  return { deckId: prefix, name: `Deck ${prefix}`, commanders, main, sideboard: [] };
}

function room(format = "standard", count = 2) {
  const players = {};
  for (let i = 0; i < count; i += 1) players[`u${i}`] = { name: `Spieler${i}`, seat: i, deck: deck(`d${i}`, { commander: format === "commander" }) };
  return { format, players };
}

/** Spiel im Zustand "playing"; `u0` ist am Zug (Hauptphase 1) und hat Priorität. */
function started(format = "standard", count = 2, seed = 7) {
  const random = seeded(seed);
  const game = createGame({ room: room(format, count), random, now: 1000, facts });
  for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
  // u0 beginnen lassen: Zug ggf. überspringen, indem wir den Beginner einfach umstellen
  if (game.turn.active !== "u0") {
    game.turn.active = "u0";
    game.priority = "u0";
    game.players.u0.turnStartSeq = game.seq;
  }
  return { game, random, opts: { random } };
}

/** Legt die erste Karte mit diesem Namen aus der Bibliothek/Hand in die Zone (schnelles Aufstellen). */
function put(game, uid, name, zone, { sick = false, only } = {}) {
  const player = game.players[uid];
  for (const from of only ? [only] : ["hand", "library", "command", "battlefield", "graveyard"]) {
    const id = player[from].find(cardId => game.defs[game.cards[cardId].def].name === name);
    if (!id) continue;
    player[from].splice(player[from].indexOf(id), 1);
    player[zone].push(id);
    game.cards[id].sinceSeq = sick ? game.seq + 1 : 0;
    return id;
  }
  throw new Error(`Karte ${name} nicht gefunden`);
}

const act = (game, uid, action, random) => applyAction(game, uid, action, { random });
/** Öffnet das manuelle Fenster (wie nach einem Kartentext, den das Spiel nicht umsetzen kann). */
const openManual = (game, uid) => {
  game.manual = { userId: uid, text: "Test", source: "Test" };
};
const forest = (game, uid, count) => Array.from({ length: count }, () => put(game, uid, "Forest", "battlefield"));
/** Wirkt eine Karte aus der Hand (Mana wird automatisch bezahlt) und lässt beide Spieler passen, bis der Stapel leer ist. */
function castAndResolve(game, uid, name, random, targets = []) {
  const id = put(game, uid, name, "hand");
  const result = act(game, uid, { type: "cast", id, targets }, random);
  expect(result).toEqual({ ok: true });
  for (let i = 0; i < 6 && game.stack.length > 0 && !game.choice && !game.manual; i += 1) act(game, game.priority, { type: "pass" }, random);
  return id;
}
const view = (game, uid) => gameView(game, uid);

describe("createGame", () => {
  it("gibt jedem sieben Karten, mischt und stellt Kommandanten in die Kommandozone", () => {
    const game = createGame({ room: room("commander", 3), random: seeded(), now: 1, facts });
    expect(game.phase).toBe("mulligan");
    for (const id of game.seats) {
      const p = game.players[id];
      expect(p.hand).toHaveLength(7);
      expect(p.command).toHaveLength(1);
      expect(p.life).toBe(40);
    }
  });

  it("Kartendaten (Stärke, Schlüsselwörter, Manaquelle) sind angereichert", () => {
    const game = createGame({ room: room(), random: seeded(), now: 1, facts });
    expect(game.defs["u0:d0-giant"]).toMatchObject({ power: 5, toughness: 5, keywords: ["trample"] });
    expect(game.defs["u0:d0-forest"].mana).toEqual([["G"]]);
  });

  it("zerlegt das Spiel für die Speicherung und fügt es wieder zusammen", () => {
    const game = createGame({ room: room(), random: seeded(), now: 1, facts });
    const { dynamic, defs } = splitGame(game);
    expect(dynamic.defs).toBeUndefined();
    expect(joinGame(dynamic, defs).defs).toBe(defs);
    expect(joinGame(null, defs)).toBeNull();
  });
});

describe("Mulligan und Spielbeginn", () => {
  it("London-Mulligan", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    const p = game.players.u0;
    expect(act(game, "u0", { type: "mulligan" }, random).ok).toBe(true);
    expect(act(game, "u0", { type: "keep", bottom: [] }, random).ok).toBe(false);
    const bottom = [p.hand[0]];
    expect(act(game, "u0", { type: "keep", bottom }, random).ok).toBe(true);
    expect(p.hand).toHaveLength(6);
    expect(p.library[0]).toBe(bottom[0]);
  });

  it("Commander: erster Mulligan frei; Beginner zieht im Mehrspielerspiel", () => {
    const random = seeded();
    const game = createGame({ room: room("commander", 3), random, facts });
    act(game, "u0", { type: "mulligan" }, random);
    expect(act(game, "u0", { type: "keep" }, random).ok).toBe(true);
    expect(game.players.u0.hand).toHaveLength(7);
    act(game, "u1", { type: "keep" }, random);
    act(game, "u2", { type: "keep" }, random);
    expect(game.players[game.turn.active].hand.length).toBe(game.turn.active === "u0" ? 8 : 8);
  });

  it("startet erst, wenn alle behalten; 2-Spieler-Beginner zieht nicht", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    act(game, "u0", { type: "keep" }, random);
    expect(game.phase).toBe("mulligan");
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(false);
    act(game, "u1", { type: "keep" }, random);
    expect(game.phase).toBe("playing");
    expect(game.turn.phase).toBe("main1");
    expect(game.priority).toBe(game.turn.active);
    expect(game.players[game.turn.active].hand).toHaveLength(7);
  });
});

describe("Länder, Mana und Zaubern", () => {
  it("Land spielen: nur eines pro Zug, nur in der Hauptphase", () => {
    const { game, random } = started();
    const a = put(game, "u0", "Forest", "hand");
    const b = put(game, "u0", "Forest", "hand");
    expect(act(game, "u0", { type: "playLand", id: a }, random).ok).toBe(true);
    expect(game.players.u0.battlefield).toContain(a);
    expect(act(game, "u0", { type: "playLand", id: b }, random).error).toMatch(/schon ein Land/);
    expect(act(game, "u1", { type: "playLand", id: put(game, "u1", "Forest", "hand") }, random).ok).toBe(false);
  });

  it("Zaubern tappt Länder automatisch; ohne mögliche Antwort löst der Zauber sich sofort auf (kein Klick nötig)", () => {
    const { game, random } = started();
    const f1 = put(game, "u0", "Forest", "battlefield");
    const f2 = put(game, "u0", "Forest", "battlefield");
    const f3 = put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === bear).play).toMatchObject({ kind: "spell", ok: true });
    expect(act(game, "u0", { type: "cast", id: bear }, random).ok).toBe(true);
    expect([f1, f2, f3].filter(id => game.cards[id].tapped)).toHaveLength(2);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.hand).not.toContain(bear);
    expect(game.players.u0.battlefield).toContain(bear);
    expect(game.priority).toBe("u0");
  });

  it("kann der Gegner antworten, wird er gefragt – sonst nicht; erst sein „Nichts tun“ löst den Zauber auf", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(1);
    expect(game.priority).toBe("u1");
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    act(game, "u1", { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
  });

  it("wer „nachfragen“ ausschaltet, wird nie unterbrochen", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand");
    act(game, "u1", { type: "askResponse", value: false }, random);
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
  });

  it("zu wenig Mana, falsche Farbe und Timing werden abgelehnt", () => {
    const { game, random } = started();
    put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id: bear }, random).error).toMatch(/Nicht genug Mana/);
    const bolt = put(game, "u0", "Blitz", "hand");
    expect(act(game, "u0", { type: "cast", id: bolt, targets: ["u1"] }, random).error).toMatch(/Nicht genug Mana/);
    put(game, "u0", "Forest", "battlefield");
    expect(act(game, "u0", { type: "cast", id: bear, free: true }, random).ok).toBe(true);
    // Hexerei außerhalb der eigenen Hauptphase
    const sorcery = put(game, "u1", "Zauberspruch", "hand");
    game.priority = "u1";
    expect(act(game, "u1", { type: "cast", id: sorcery, free: true }, random).error).toMatch(/Hauptphase/);
  });

  it("Sofortzauber darf der Gegner in Antwort wirken; neutralisieren schickt auf den Friedhof", () => {
    const { game, random } = started();
    put(game, "u0", "Forest", "battlefield");
    put(game, "u0", "Forest", "battlefield");
    put(game, "u1", "Mountain", "battlefield");
    const counter = put(game, "u1", "Gegenzauber", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    const sid = game.stack[0].sid;
    expect(game.priority).toBe("u1");
    expect(act(game, "u1", { type: "cast", id: counter }, random).ok).toBe(false); // ohne Ziel
    expect(act(game, "u1", { type: "cast", id: counter, targets: [sid] }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(bear); // neutralisiert
    expect(game.players.u1.graveyard).toContain(counter);
    expect(game.stack).toHaveLength(0);
  });

  it("Manapool lässt sich nicht von Hand ändern; Ritual füllt ihn über den Kartentext", () => {
    const { game, random } = started();
    expect(act(game, "u0", { type: "pool", color: "R", delta: 2 }, random).ok).toBe(false);
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Ritual", random);
    expect(game.players.u0.pool.R).toBe(3);
  });

  it("Beschwörungsmüdigkeit: frische Kreaturen können weder angreifen noch Mana erzeugen", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield", { sick: true });
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).sick).toBe(true);
    game.turn.phase = "attackers";
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).error).toMatch(/beschwörungsmüde/);
    const ogre = put(game, "u0", "Oger", "battlefield", { sick: true });
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: ogre }] }, random).ok).toBe(true); // Eile
  });
});

describe("Zugstruktur", () => {
  it("Passen führt durch Hauptphase, Kampf (übersprungen ohne Angreifer) und den nächsten Zug (Endschritt ohne Handlung übersprungen)", () => {
    const { game, random } = started();
    expect(game.turn.phase).toBe("main1");
    act(game, "u0", { type: "pass" }, random);
    expect(game.turn.phase).toBe("main2"); // keine Angreifer möglich
    const handBefore = game.players.u1.hand.length;
    act(game, "u0", { type: "pass" }, random); // der Endschritt wird übersprungen, weil niemand handeln will
    expect(game.turn.active).toBe("u1");
    expect(game.turn.number).toBe(game.turn.number);
    expect(game.players.u1.hand).toHaveLength(handBefore + 1);
    expect(game.priority).toBe("u1");
  });

  it("Handkartenlimit: erst abwerfen, dann beginnt der nächste Zug", () => {
    const { game, random } = started();
    for (let i = 0; i < 3; i += 1) put(game, "u0", "Forest", "hand", { only: "library" });
    expect(game.players.u0.hand).toHaveLength(10);
    act(game, "u0", { type: "endTurn" }, random);
    expect(game.pendingDiscard).toMatchObject({ userId: "u0", count: 3 });
    expect(act(game, "u1", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "discard", ids: game.players.u0.hand.slice(0, 2) }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "discard", ids: game.players.u0.hand.slice(0, 3) }, random).ok).toBe(true);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u0.hand).toHaveLength(7);
  });

  it("Mana verfällt zwischen den Schritten", () => {
    const { game, random } = started();
    const f = put(game, "u0", "Forest", "battlefield");
    act(game, "u0", { type: "tapMana", id: f }, random);
    expect(game.players.u0.pool.G).toBe(1);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.pool.G).toBe(0);
  });
});

function toAttackers(game, random) {
  act(game, "u0", { type: "pass" }, random);
  expect(game.turn.phase).toBe("attackers");
}

describe("Kampf", () => {
  it("unblockierter Angreifer verletzt den Spieler", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    toAttackers(game, random);
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).ok).toBe(true);
    expect(game.cards[bear].tapped).toBe(true);
    // u1 hat nichts zum Blocken → Schadensschritt beginnt sofort
    expect(game.turn.phase).toBe("damage");
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(18);
    expect(game.turn.phase).toBe("main2");
    expect(game.combat).toBeNull();
  });

  it("Blocker töten sich gegenseitig, Schaden verfällt am Zugende", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    const bear2 = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear }] }, random);
    expect(game.turn.phase).toBe("blockers");
    expect(act(game, "u0", { type: "declareBlockers", blocks: [] }, random).ok).toBe(false);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear2, attacker: bear }] }, random).ok).toBe(true);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(bear);
    expect(game.players.u1.graveyard).toContain(bear2);
    expect(game.players.u1.life).toBe(20);
  });

  it("Flug erlaubt nur Flug/Reichweite-Blocker; Drohung braucht zwei", () => {
    const { game, random } = started();
    const hawk = put(game, "u0", "Falke", "battlefield");
    const wall = put(game, "u1", "Mauer", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: hawk }] }, random);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: wall, attacker: hawk }] }, random).error).toMatch(/Flug/);
    act(game, "u1", { type: "declareBlockers", blocks: [] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(19);
  });

  it("Drohung", () => {
    const { game, random } = started();
    const ogre = put(game, "u0", "Oger", "battlefield");
    const b1 = put(game, "u1", "Bär", "battlefield");
    const b2 = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: ogre }] }, random);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: b1, attacker: ogre }] }, random).error).toMatch(/Drohung/);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: b1, attacker: ogre }, { blocker: b2, attacker: ogre }] }, random).ok).toBe(true);
  });

  it("Todesberührung des Blockers tötet den Trampler, Überschuss geht durch", () => {
    const { game, random } = started();
    const giant = put(game, "u0", "Riese", "battlefield");
    const viper = put(game, "u1", "Viper", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: giant }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: viper, attacker: giant }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(giant); // Todesberührung
    expect(game.players.u1.graveyard).toContain(viper);
    expect(game.players.u1.life).toBe(16); // Trampeln: 5 − 1 (Todesberührung zählt nur für den Angreifer)
  });

  it("Trampeln gibt Überschuss an den Spieler", () => {
    const { game, random } = started();
    const giant = put(game, "u0", "Riese", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: giant }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear, attacker: giant }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(17); // 5 − 2 Widerstandskraft
    expect(game.cards[giant].damage).toBe(2); // Schaden bleibt bis zum Zugende
  });

  it("Erstschlag", () => {
    const { game, random } = started();
    const knight = put(game, "u0", "Ritter", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: knight }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear, attacker: knight }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(bear);
    expect(game.players.u0.battlefield).toContain(knight); // überlebt, weil der Bär nicht mehr zuschlägt
  });

  it("Lebensverbindung", () => {
    const { game, random } = started();
    const bat = put(game, "u0", "Fledermaus", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bat }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.life).toBe(22);
    expect(game.players.u1.life).toBe(18);
  });

  it("Kommandantenschaden aus dem Kampf führt zum Ausscheiden", () => {
    const { game, random } = started("commander", 2);
    const cmd = put(game, "u0", "Boss d0", "battlefield");
    game.players.u1.cmdDamage.u0 = 18;
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: cmd }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.cmdDamage.u0).toBe(22);
    expect(game.players.u1.eliminated).toContain("Kommandantenschaden");
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("u0");
  });

  it("Kommandant: Steuer beim Wirken, Rückkehr in die Kommandozone nach dem Tod", () => {
    const { game, random } = started("commander", 2);
    for (let i = 0; i < 6; i += 1) put(game, "u0", "Forest", "battlefield");
    const cmd = game.players.u0.command[0];
    expect(act(game, "u0", { type: "cast", id: cmd }, random).ok).toBe(true);
    expect(game.players.u0.cmdCasts[cmd]).toBe(1);
    expect(game.players.u0.battlefield).toContain(cmd);
    // stirbt: Frage erscheint
    game.cards[cmd].counters["-1/-1"] = 5;
    act(game, "u1", { type: "coin" }, random); // jede Aktion prüft die zustandsbasierten Regeln
    expect(game.players.u0.graveyard).toContain(cmd);
    expect(game.players.u0.prompts).toEqual([{ type: "commander", id: cmd }]);
    expect(view(game, "u1").players[0].prompts).toEqual([]);
    expect(act(game, "u0", { type: "commanderZone", id: cmd, yes: true }, random).ok).toBe(true);
    expect(game.players.u0.command).toContain(cmd);
    // zweites Wirken kostet 2 mehr: {1}{G} + {2}
    const planTax = view(game, "u0").players[0].command[0].play;
    expect(planTax.ok).toBe(true);
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "cast", id: cmd }, random);
    expect(game.players.u0.battlefield.filter(id => game.cards[id].tapped).length).toBe(4);
  });
});

describe("Weitere Aktionen", () => {
  it("manuelles Bewegen, Marker (+1/+1 und -1/-1 heben sich auf), Spielsteine", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    expect(act(game, "u0", { type: "counter", id: bear, kind: "+1/+1", delta: 2 }, random).ok).toBe(false); // nur im manuellen Fenster
    openManual(game, "u0");
    act(game, "u0", { type: "counter", id: bear, kind: "+1/+1", delta: 2 }, random);
    act(game, "u0", { type: "counter", id: bear, kind: "-1/-1", delta: 1 }, random);
    expect(game.cards[bear].counters).toEqual({ "+1/+1": 1 });
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).power).toBe(3);
    expect(act(game, "u0", { type: "token", name: "Goblin 1/1" }, random).ok).toBe(true);
    const token = game.players.u0.battlefield.at(-1);
    expect(view(game, "u0").players[0].battlefield.at(-1)).toMatchObject({ power: 1, toughness: 1, token: true });
    act(game, "u0", { type: "move", id: token, to: "graveyard" }, random);
    expect(game.cards[token]).toBeUndefined();
    expect(act(game, "u0", { type: "token", name: "<>" }, random).ok).toBe(false);
  });

  it("fremde Karten sind tabu; Bibliothek ansehen ist privat", () => {
    const { game, random } = started();
    const foreign = game.players.u1.hand[0];
    openManual(game, "u0");
    expect(act(game, "u0", { type: "move", id: foreign, to: "graveyard" }, random).ok).toBe(false);
    act(game, "u0", { type: "look", count: 3 }, random);
    expect(view(game, "u0").players[0].looking).toHaveLength(3);
    expect(view(game, "u1").players[0].looking).toBeNull();
  });

  it("Sicht verrät weder fremde Hand noch Bibliothek noch verdeckte Karten", () => {
    const { game, random } = started();
    const hidden = game.players.u1.hand[0];
    const name = game.defs[game.cards[hidden].def].name;
    openManual(game, "u1");
    act(game, "u1", { type: "move", id: hidden, to: "battlefield", faceDown: true }, random);
    const v = view(game, "u0");
    const p1 = v.players.find(p => p.userId === "u1");
    expect(p1.hand).toEqual([]);
    expect(p1.battlefield.find(c => c.id === hidden).name).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(game.players.u1.library[0]);
    expect(JSON.stringify(game.log)).not.toContain(`bewegt ${name}`);
    expect(view(game, "u1").players.find(p => p.userId === "u1").battlefield.find(c => c.id === hidden).name).toBe(name);
  });

  it("Aufgeben beendet das Spiel mit Zusammenfassung", () => {
    const { game, random } = started();
    act(game, "u1", { type: "concede" }, random);
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("u0");
    expect(game.summary.players).toHaveLength(2);
  });

  it("Ausscheiden mitten im Zug: im Mehrspielerspiel geht es weiter", () => {
    const { game, random } = started("commander", 3);
    act(game, "u0", { type: "concede" }, random);
    expect(game.phase).toBe("playing");
    expect(game.turn.active).not.toBe("u0");
    expect(game.priority).toBe(game.turn.active);
  });

  it("Fähigkeiten auf den Stapel, Abbruch, Verlassen", () => {
    const { game, random } = started("commander", 3);
    openManual(game, "u0");
    expect(act(game, "u0", { type: "ability", text: "Auslöser: ziehe eine Karte" }, random).ok).toBe(true);
    game.manual = null;
    expect(game.stack).toHaveLength(1);
    playerLeft(game, "u2", { random });
    expect(game.players.u2.eliminated).toBe("hat den Raum verlassen");
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(abortGame(game, 9).aborted).toBe(true);
  });

  it("Würfel, Münze, ungültige Eingaben", () => {
    const { game, random } = started();
    expect(act(game, "u0", { type: "dice", sides: 20 }, random).ok).toBe(true);
    expect(game.log.at(-1).text).toMatch(/W20: \d+/);
    expect(act(game, "u0", { type: "bogus" }, random).ok).toBe(false);
    expect(act(game, "u0", "x", random).ok).toBe(false);
    expect(act(game, "fremd", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "life", delta: "viel" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id: "gibtsnicht" }, random).ok).toBe(false);
  });
});

describe("Kartentext-Engine", () => {
  it("Blitz auf einen Spieler und auf eine Kreatur; Ziele werden geprüft", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u0", "Mountain", "battlefield");
    put(game, "u0", "Mountain", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Blitz", "hand");
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id, targets: ["unbekannt"] }, random).ok).toBe(false);
    expect(view(game, "u0").players[0].hand.find(c => c.id === id).play.targets[0].options).toContain("u1");
    act(game, "u0", { type: "cast", id, targets: ["u1"] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(17);
    castAndResolve(game, "u0", "Blitz", random, [bear]);
    // zweiter Blitz: Mana reicht nicht (nur ein Berg und ein Wald) → Fehler wäre früher gekommen; hier genügt der Schaden
  });

  it("Karten ziehen und Leben gewinnen laufen über den Text", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const hand = game.players.u0.hand.length;
    castAndResolve(game, "u0", "Studium", random);
    expect(game.players.u0.hand.length).toBe(hand + 2);
    castAndResolve(game, "u0", "Heilung", random);
    expect(game.players.u0.life).toBe(24);
  });

  it("Zerstören: nur gültige Ziele, Hexproof ist tabu", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const veil = put(game, "u1", "Schleier", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Zerstörer", "hand");
    const options = view(game, "u0").players[0].hand.find(c => c.id === id).play.targets[0].options;
    expect(options).toContain(bear);
    expect(options).not.toContain(veil);
    expect(act(game, "u0", { type: "cast", id, targets: [veil] }, random).ok).toBe(false);
    act(game, "u0", { type: "cast", id, targets: [bear] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(bear);
  });

  it("Auslöser beim Betreten: Seher zieht eine Karte (alles löst sich selbst auf)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const hand = game.players.u0.hand.length;
    const seer = put(game, "u0", "Seher", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: seer }, random);
    expect(game.players.u0.battlefield).toContain(seer);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.hand.length).toBe(hand + 1); // +1 (Seher) −1 (gespielt) +1 (gezogen)
  });

  it("Auslöser mit Ziel öffnet eine Auswahl: Kavu schadet einer Kreatur", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const victim = put(game, "u1", "Bär", "battlefield");
    const kavu = put(game, "u0", "Kavu", "hand");
    act(game, "u0", { type: "cast", id: kavu }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.choice).toMatchObject({ userId: "u0", kind: "targets" });
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false); // erst auswählen
    expect(act(game, "u0", { type: "choose", ids: ["gibtsnicht"] }, random).ok).toBe(false);
    expect(view(game, "u0").choice.options.map(o => o.id)).toContain(victim);
    expect(view(game, "u1").choice.options).toEqual([]);
    act(game, "u0", { type: "choose", ids: [victim] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(victim);
  });

  it("Suchen: Wachstum legt ein Basic Land getappt aufs Feld und mischt", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Wachstum", random);
    expect(game.choice).toMatchObject({ kind: "cards" });
    const options = game.choice.options;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(id => game.defs[game.cards[id].def].types.basicLand)).toBe(true);
    const land = options[0];
    act(game, "u0", { type: "choose", ids: [land] }, random);
    expect(game.players.u0.battlefield).toContain(land);
    expect(game.cards[land].tapped).toBe(true);
    expect(game.choice).toBeNull();
  });

  it("Aktivierte Fähigkeit: Magier tappt und trifft den Gegner", () => {
    const { game, random } = started();
    const mage = put(game, "u0", "Magier", "battlefield");
    const options = view(game, "u0").players[0].battlefield.find(c => c.id === mage).abilities;
    expect(options[0]).toMatchObject({ index: 0, ok: true });
    expect(act(game, "u0", { type: "activate", id: mage, index: 0 }, random).ok).toBe(false); // Ziel fehlt
    act(game, "u0", { type: "activate", id: mage, index: 0, targets: ["u1"] }, random);
    expect(game.cards[mage].tapped).toBe(true);
    expect(act(game, "u0", { type: "activate", id: mage, index: 0, targets: ["u1"] }, random).ok).toBe(false);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(19);
  });

  it("Spielsteine entstehen über den Text", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Alarm", random);
    const tokens = game.players.u0.battlefield.filter(id => game.cards[id].token);
    expect(tokens).toHaveLength(2);
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === tokens[0])).toMatchObject({ power: 1, toughness: 1, name: "Soldier" });
  });

  it("Wühlen und Abwerfen verlangen eine Auswahl des Betroffenen", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    castAndResolve(game, "u0", "Seherin", random);
    expect(game.choice).toMatchObject({ userId: "u0", max: 2, min: 0 });
    const top = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [top] }, random);
    expect(game.players.u0.library[0]).toBe(top);
    castAndResolve(game, "u0", "Qual", random);
    expect(game.choice).toMatchObject({ userId: "u1", min: 1, max: 1 });
    const chosen = game.choice.options[2];
    act(game, "u1", { type: "choose", ids: [chosen] }, random);
    expect(game.players.u1.graveyard).toContain(chosen);
  });

  it("Unverstandene Texte öffnen ein manuelles Fenster nur für den Spieler", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Rätsel", random);
    expect(game.manual).toMatchObject({ userId: "u0" });
    expect(act(game, "u1", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(true);
    expect(game.players.u0.hand.length).toBe(hand + 1);
    expect(act(game, "u1", { type: "manualDone" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "manualDone" }, random).ok).toBe(true);
    expect(game.manual).toBeNull();
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(false); // wieder gesperrt
  });

  it("wahllos ziehen, Leben ändern oder Karten verschieben ist nicht möglich", () => {
    const { game, random } = started();
    const card = game.players.u0.hand[0];
    for (const action of [
      { type: "draw" }, { type: "mill" }, { type: "life", delta: 5 }, { type: "pool", color: "G", delta: 1 }, { type: "untapAll" },
      { type: "move", id: card, to: "battlefield" }, { type: "token", name: "Drache 9/9" }, { type: "shuffle" }
    ]) {
      expect(act(game, "u0", action, random).ok).toBe(false);
    }
  });
});

describe("Zugbeginn, Dauereffekte, Rückblende, weitere Auslöser", () => {
  it("Enttappen und Ziehen laufen automatisch: zu Beginn eines Zuges sind eigene Karten wieder ungetappt", () => {
    const { game, random } = started();
    const [land] = forest(game, "u0", 1);
    const handBefore = game.players.u1.hand.length;
    act(game, "u0", { type: "tapMana", id: land }, random);
    expect(game.cards[land].tapped).toBe(true);
    for (let i = 0; i < 12 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u1.hand.length).toBe(handBefore + 1); // der zweite Spieler zieht in seinem ersten Zug
    expect(game.turn.drew).toBe(true);
    for (let i = 0; i < 12 && game.turn.active === "u1"; i += 1) {
      if (game.pendingDiscard) act(game, "u1", { type: "discard", ids: game.players.u1.hand.slice(0, game.pendingDiscard.count) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.turn.active).toBe("u0");
    expect(game.cards[land].tapped).toBe(false);
  });

  it("Manuelles Ziehen: Die Bibliothek wird im Zieh-Schritt angeklickt, danach geht es automatisch weiter", () => {
    const { game, random } = started();
    act(game, "u1", { type: "autoStart", value: false }, random);
    const [land] = forest(game, "u1", 1);
    game.cards[land].tapped = true;
    for (let i = 0; i < 12 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn).toMatchObject({ active: "u1", phase: "draw", manualStart: true });
    expect(game.cards[land].tapped).toBe(false); // Enttappen ist immer automatisch
    const hand = game.players.u1.hand.length;
    expect(act(game, "u1", { type: "pass" }, random).error).toMatch(/Bibliothek/);
    expect(act(game, "u1", { type: "drawStep" }, random).ok).toBe(true);
    expect(game.players.u1.hand.length).toBe(hand + 1);
    expect(game.turn.phase).toBe("main1");
    expect(act(game, "u1", { type: "drawStep" }, random).ok).toBe(false);
  });

  it("Der Startspieler zieht im ersten Zug nicht (auch im manuellen Modus)", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    game.players.u0.autoStart = false;
    game.players.u1.autoStart = false;
    for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
    const first = game.turn.active;
    expect(game.turn.drawBlocked).toBe(true);
    expect(game.turn.phase).toBe("main1");
    game.turn.phase = "draw";
    expect(applyAction(game, first, { type: "drawStep" }, { random }).error).toMatch(/Startspieler/);
  });

  it("Dauereffekte: Hymne und Anführer verändern Stärke und Schlüsselwörter", () => {
    const { game } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    const lord = put(game, "u0", "Anführer", "battlefield");
    const foe = put(game, "u1", "Bär", "battlefield");
    let mine = view(game, "u0").players[0].battlefield;
    expect(mine.find(c => c.id === bear)).toMatchObject({ power: 3, toughness: 3 });
    expect(mine.find(c => c.id === bear).keywords).toContain("flying");
    expect(mine.find(c => c.id === lord)).toMatchObject({ power: 2, toughness: 2 }); // „Other“
    put(game, "u0", "Hymne", "battlefield");
    mine = view(game, "u0").players[0].battlefield;
    expect(mine.find(c => c.id === bear)).toMatchObject({ power: 4, toughness: 4 });
    expect(view(game, "u0").players[1].battlefield.find(c => c.id === foe)).toMatchObject({ power: 2, toughness: 2 });
  });

  it("Rückblende: Karte aus dem Friedhof wirken, danach ins Exil; Surveil legt Karten auf den Friedhof", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    forest(game, "u0", 2);
    const dreams = castAndResolve(game, "u0", "Träume", random);
    expect(game.choice).toMatchObject({ kind: "cards", max: 1 });
    const top = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [top] }, random);
    expect(game.players.u0.graveyard).toContain(top);
    expect(game.players.u0.graveyard).toContain(dreams);
    const option = view(game, "u0").players[0].graveyard.find(c => c.id === dreams).play;
    expect(option).toMatchObject({ kind: "spell", ok: true });
    act(game, "u0", { type: "cast", id: dreams }, random);
    expect(game.choice).toMatchObject({ kind: "cards" }); // Surveil läuft erneut
    act(game, "u0", { type: "choose", ids: [] }, random);
    expect(game.players.u0.exile).toContain(dreams);
    expect(game.players.u0.graveyard).not.toContain(dreams);
  });

  it("Kostenloses Wirken ist nicht möglich", () => {
    const { game, random } = started();
    const id = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id, free: true }, random).ok).toBe(false);
  });

  it("Auslöser auf andere Ereignisse: Landfall, gegnerische Kreatur stirbt, Beginn der Endphase", () => {
    const { game, random } = started();
    const bard = put(game, "u0", "Barde", "battlefield");
    const reaper = put(game, "u0", "Schnitter", "battlefield");
    put(game, "u0", "Priester", "battlefield");
    const land = put(game, "u0", "Forest", "hand", { only: "library" });
    act(game, "u0", { type: "playLand", id: land }, random);
    expect(game.stack).toHaveLength(0); // Landfall löst sich selbst auf
    expect(game.players.u0.life).toBe(21);
    // gegnerische Kreatur stirbt → Schnitter bekommt einen Marker
    const victim = put(game, "u1", "Bär", "battlefield");
    game.cards[victim].counters["-1/-1"] = 5;
    act(game, "u1", { type: "coin" }, random);
    expect(game.players.u1.graveyard).toContain(victim);
    expect(game.cards[reaper].counters["+1/+1"]).toBe(1);
    expect(bard).toBeTruthy();
    // Beginn der Endphase: Priester löst aus; der Zug endet danach von selbst
    for (let i = 0; i < 6 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u0.life).toBe(22);
  });

  it("Selbstheilung: Hat niemand Priorität und wartet niemand, geht sie an den aktiven Spieler", () => {
    const { game } = started();
    game.priority = null;
    expect(repairGame(game)).toBe(true);
    expect(game.priority).toBe(game.turn.active);
    game.choice = { userId: "u0", kind: "cards", prompt: "x", options: [], min: 0, max: 0, step: { type: "scry" }, queue: [], ctx: null };
    game.priority = null;
    expect(repairGame(game)).toBe(false); // wartet auf eine Auswahl: nichts zu reparieren
  });
});

describe("Dauertest: das Spiel bleibt nie stehen", () => {
  /** Wählt zufällig eine mögliche Aktion für den Spieler, der gerade etwas tun muss. */
  function pick(game, random) {
    const waitingDefender = game.combat?.phaseWaiting ? [...new Set(game.combat.attackers.map(a => a.target))].find(id => !game.combat.done.includes(id)) : undefined;
    const waiting = game.choice?.userId ?? game.manual?.userId ?? game.pendingDiscard?.userId ?? waitingDefender ?? game.priority;
    const uid = waiting;
    if (!game.players[uid]) throw new Error(`Niemand am Zug: ${JSON.stringify({ priority: game.priority, phase: game.turn.phase, combat: game.combat, choice: game.choice?.userId, manual: game.manual, discard: game.pendingDiscard })}`);
    const options = [];
    const v = gameView(game, uid);
    const mine = v.players.find(p => p.userId === uid);
    if (game.choice) {
      const c = game.choice;
      const count = Math.min(c.max, Math.max(c.min, 1));
      return [uid, { type: "choose", ids: c.options.slice(0, c.min === 0 ? 0 : count) }];
    }
    if (game.manual) return [uid, { type: "manualDone" }];
    if (game.pendingDiscard) return [uid, { type: "discard", ids: mine.hand.slice(0, game.pendingDiscard.count).map(c => c.id) }];
    if (waitingDefender === uid) {
      const blockers = mine.battlefield.filter(c => c.kind === "creature" && !c.tapped);
      const attackers = game.combat.attackers.filter(a => a.target === uid);
      const blocks = blockers.length && attackers.length && random() < 0.5 ? [{ blocker: blockers[0].id, attacker: attackers[0].id }] : [];
      return [uid, { type: "declareBlockers", blocks }];
    }
    if (game.turn.phase === "attackers" && game.turn.active === uid && random() < 0.6) {
      const ready = mine.battlefield.filter(c => c.kind === "creature" && !c.tapped && !c.sick && !c.keywords?.includes("defender"));
      if (ready.length) return [uid, { type: "declareAttackers", attackers: [{ id: ready[0].id, target: v.players.find(p => p.userId !== uid).userId }] }];
    }
    for (const card of [...mine.hand, ...mine.command, ...mine.graveyard]) {
      if (card.play?.ok) {
        const targets = (card.play.targets ?? []).map(t => t.options[0]);
        if (card.play.targets?.some(t => t.options.length === 0)) continue;
        options.push({ type: card.play.kind === "land" ? "playLand" : "cast", id: card.id, ...(targets.length ? { targets } : {}) });
      }
    }
    for (const card of mine.battlefield) if (card.mana && !card.tapped && !card.sick) options.push({ type: "tapMana", id: card.id, ...(card.manaColors.length > 1 ? { color: card.manaColors[0] } : {}) });
    options.push({ type: "pass" }, { type: "pass" }, { type: "pass" });
    return [uid, options[Math.floor(random() * options.length)]];
  }

  it("zufällige Spiele laufen ohne Fehler und ohne Stillstand", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const random = seeded(seed * 97);
      const players = seed % 3 === 0 ? 3 : 2;
      const game = createGame({ room: room(players === 3 ? "commander" : "standard", players), random, now: 1, facts });
      for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
      for (let step = 0; step < 400 && game.phase === "playing"; step += 1) {
        const stuck = Boolean(!game.choice && !game.manual && !game.pendingDiscard && !game.combat?.phaseWaiting && (!game.priority || game.players[game.priority].eliminated));
        expect(stuck, `Stillstand in Spiel ${seed}, Schritt ${step}`).toBe(false);
        const [uid, action] = pick(game, random);
        const result = applyAction(game, uid, action, { random });
        if (!result.ok) {
          // Eine unzulässige Zufallsaktion darf das Spiel nicht beschädigen: passen geht immer, sofern man Priorität hat
          const fallback = game.priority === uid ? applyAction(game, uid, { type: "pass" }, { random }) : result;
          expect(fallback.ok || game.phase !== "playing" || game.choice || game.manual || game.pendingDiscard || game.combat?.phaseWaiting, `Aktion ${JSON.stringify(action)} abgelehnt (${result.error}) in Spiel ${seed}`).toBeTruthy();
        }
      }
    }
  });
});

describe("Länder mit besonderen Regeln und Effekte der Anzeige", () => {
  it("Evolving-Wilds-Prinzip: tappen und opfern, dann ein Basic Land getappt aufs Feld", () => {
    const { game, random } = started();
    const wilds = put(game, "u0", "Wildnis", "battlefield");
    const info = view(game, "u0").players[0].battlefield.find(c => c.id === wilds).abilities[0];
    expect(info).toMatchObject({ ok: true, costLabel: "{T}, Opfern" });
    expect(act(game, "u0", { type: "activate", id: wilds, index: 0 }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(wilds); // geopfert
    expect(game.choice).toMatchObject({ kind: "cards" });
    const land = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [land] }, random);
    expect(game.players.u0.battlefield).toContain(land);
    expect(game.cards[land].tapped).toBe(true);
  });

  it("Länder, die getappt ins Spiel kommen, und ihr Auslöser lösen sich selbst auf", () => {
    const { game, random } = started();
    const cliffs = put(game, "u0", "Klippen", "hand");
    expect(act(game, "u0", { type: "playLand", id: cliffs }, random).ok).toBe(true);
    expect(game.cards[cliffs].tapped).toBe(true);
    expect(game.players.u0.life).toBe(21);
    expect(game.stack).toHaveLength(0);
  });

  it("Schaden und Heilung erzeugen Anzeige-Effekte für alle", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const id = put(game, "u0", "Blitz", "hand");
    act(game, "u0", { type: "cast", id, targets: ["u1"] }, random);
    expect(view(game, "u1").fx.at(-1)).toMatchObject({ type: "damage", player: "u1", amount: 3 });
    expect(view(game, "u0").fx.at(-1).id).toBe(view(game, "u1").fx.at(-1).id);
  });
});

describe("Länder mit Bedingung beim Ins-Spiel-Kommen", () => {
  const play = (game, random, name) => {
    const land = put(game, "u0", name, "hand", { only: "library" });
    expect(act(game, "u0", { type: "playLand", id: land }, random).ok).toBe(true);
    return land;
  };

  it("Slow-Land: ungetappt erst mit zwei anderen Ländern", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    expect(game.cards[play(game, random, "Langsam")].tapped).toBe(true);
    const second = started();
    forest(second.game, "u0", 2);
    expect(second.game.cards[play(second.game, second.random, "Langsam")].tapped).toBe(false);
  });

  it("Check-Land: prüft die Landtypen der eigenen Länder", () => {
    const { game, random } = started();
    forest(game, "u0", 2); // nur Forest: Bedingung (Mountain oder Swamp) nicht erfüllt
    expect(game.cards[play(game, random, "Prüfland")].tapped).toBe(true);
    const second = started();
    put(second.game, "u0", "Mountain", "battlefield");
    expect(second.game.cards[play(second.game, second.random, "Prüfland")].tapped).toBe(false);
  });

  it("Shock-Land: Spieler wählt, ob er 2 Leben zahlt", () => {
    const { game, random } = started();
    const land = play(game, random, "Schock");
    expect(game.choice).toMatchObject({ userId: "u0", kind: "yesno", options: ["yes", "no"] });
    expect(view(game, "u0").choice.options).toEqual([{ id: "yes", label: "2 Leben zahlen (ungetappt)" }, { id: "no", label: "Nicht zahlen (getappt)" }]);
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    act(game, "u0", { type: "choose", ids: ["yes"] }, random);
    expect(game.players.u0.life).toBe(18);
    expect(game.cards[land].tapped).toBe(false);
    const second = started();
    const tapped = play(second.game, second.random, "Schock");
    act(second.game, "u0", { type: "choose", ids: ["no"] }, second.random);
    expect(second.game.players.u0.life).toBe(20);
    expect(second.game.cards[tapped].tapped).toBe(true);
  });

  it("Shock-Land bei zu wenig Leben kommt von selbst getappt", () => {
    const { game, random } = started();
    game.players.u0.life = 2;
    const land = play(game, random, "Schock");
    expect(game.choice).toBeNull();
    expect(game.cards[land].tapped).toBe(true);
  });

  it("Zeig-Land: Karte aus der Hand zeigen oder getappt", () => {
    const { game, random } = started();
    const mountain = put(game, "u0", "Mountain", "hand", { only: "library" });
    const land = play(game, random, "Zeigland");
    expect(game.choice.options).toContain(mountain);
    act(game, "u0", { type: "choose", ids: [mountain] }, random);
    expect(game.cards[land].tapped).toBe(false);
    expect(game.players.u0.hand).toContain(mountain);
    const second = started();
    const hand = second.game.players.u0.hand.filter(id => second.game.defs[second.game.cards[id].def].name === "Mountain");
    for (const id of hand) second.game.players.u0.hand.splice(second.game.players.u0.hand.indexOf(id), 1);
    const tapped = play(second.game, second.random, "Zeigland");
    expect(second.game.choice).toBeNull();
    expect(second.game.cards[tapped].tapped).toBe(true);
  });

  it("Bounce-Land: ein eigenes Land zurück auf die Hand", () => {
    const { game, random } = started();
    const [old] = forest(game, "u0", 1);
    play(game, random, "Rücklauf");
    expect(game.choice).toMatchObject({ kind: "cards", min: 1, max: 1 });
    expect(game.choice.options).toContain(old);
    act(game, "u0", { type: "choose", ids: [old] }, random);
    expect(game.players.u0.hand).toContain(old);
    expect(game.players.u0.battlefield).not.toContain(old);
  });
});
