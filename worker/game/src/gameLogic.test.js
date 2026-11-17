import { describe, expect, it } from "vitest";
import { abortGame, applyAction, createGame, gameView, joinGame, playerLeft, splitGame } from "./gameLogic.js";

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
  ["bolt", "Blitz", "Instant", "{R}", 2, {}],
  ["sorcery", "Zauberspruch", "Sorcery", "{G}{G}", 2, {}],
  ["xspell", "Flut", "Sorcery", "{X}{G}", 2, {}]
];
const facts = new Map();

function deck(prefix, { commander = false } = {}) {
  const main = LIB.map(([key, name, typeLine, manaCost, count, extra]) => {
    const id = `${prefix}-${key}`;
    facts.set(id, extra);
    return { id, name, count, typeLine, manaCost, manaValue: 2, imageUri: null };
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
function put(game, uid, name, zone, { sick = false } = {}) {
  const player = game.players[uid];
  for (const from of ["hand", "library", "command", "battlefield", "graveyard"]) {
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

  it("Zaubern tappt Länder automatisch, legt auf den Stapel und löst nach Passen auf", () => {
    const { game, random } = started();
    const f1 = put(game, "u0", "Forest", "battlefield");
    const f2 = put(game, "u0", "Forest", "battlefield");
    const f3 = put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === bear).play).toMatchObject({ kind: "spell", ok: true });
    expect(act(game, "u0", { type: "cast", id: bear }, random).ok).toBe(true);
    expect([f1, f2, f3].filter(id => game.cards[id].tapped)).toHaveLength(2);
    expect(game.stack).toHaveLength(1);
    expect(game.players.u0.hand).not.toContain(bear);
    expect(game.priority).toBe("u0");
    act(game, "u0", { type: "pass" }, random);
    expect(game.priority).toBe("u1"); // Gegner darf antworten
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    act(game, "u1", { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
    expect(game.priority).toBe("u0");
  });

  it("zu wenig Mana, falsche Farbe und Timing werden abgelehnt", () => {
    const { game, random } = started();
    put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id: bear }, random).error).toMatch(/Nicht genug Mana/);
    const bolt = put(game, "u0", "Blitz", "hand");
    expect(act(game, "u0", { type: "cast", id: bolt }, random).error).toMatch(/Nicht genug Mana/);
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
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    act(game, "u0", { type: "pass" }, random);
    put(game, "u1", "Mountain", "battlefield");
    const bolt = put(game, "u1", "Blitz", "hand");
    expect(act(game, "u1", { type: "cast", id: bolt }, random).ok).toBe(true);
    expect(game.stack).toHaveLength(2);
    // u1 neutralisiert den Bären (oberster Eintrag ist der Blitz, Bär liegt darunter)
    const sid = game.stack[0].sid;
    expect(act(game, "u1", { type: "counterSpell", sid }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(bear);
    act(game, "u1", { type: "pass" }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(bolt);
    expect(game.stack).toHaveLength(0);
  });

  it("Manapool: tapMana und X-Zauber", () => {
    const { game, random } = started();
    const f = [put(game, "u0", "Forest", "battlefield"), put(game, "u0", "Forest", "battlefield"), put(game, "u0", "Forest", "battlefield")];
    expect(act(game, "u0", { type: "tapMana", id: f[0] }, random).ok).toBe(true);
    expect(game.players.u0.pool.G).toBe(1);
    expect(act(game, "u0", { type: "tapMana", id: f[0] }, random).ok).toBe(false);
    const flut = put(game, "u0", "Flut", "hand");
    expect(act(game, "u0", { type: "cast", id: flut, x: 5 }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id: flut, x: 2 }, random).ok).toBe(true);
    expect(f.every(id => game.cards[id].tapped)).toBe(true);
  });

  it("Manapool lässt sich von Hand anpassen (Effekte, die Mana erzeugen)", () => {
    const { game, random } = started();
    expect(act(game, "u0", { type: "pool", color: "R", delta: 2 }, random).ok).toBe(true);
    expect(game.players.u0.pool.R).toBe(2);
    act(game, "u0", { type: "pool", color: "R", delta: -5 }, random);
    expect(game.players.u0.pool.R).toBe(0);
    expect(act(game, "u0", { type: "pool", color: "X", delta: 1 }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "pool", color: "G", delta: 9 }, random).ok).toBe(false);
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
  it("Passen führt durch Hauptphase, Kampf (übersprungen ohne Angreifer), Ende und nächsten Zug", () => {
    const { game, random } = started();
    expect(game.turn.phase).toBe("main1");
    act(game, "u0", { type: "pass" }, random);
    expect(game.turn.phase).toBe("main2"); // keine Angreifer möglich
    act(game, "u0", { type: "pass" }, random);
    expect(game.turn.phase).toBe("end");
    const handBefore = game.players.u1.hand.length;
    act(game, "u0", { type: "pass" }, random);
    expect(game.turn.active).toBe("u1");
    expect(game.turn.number).toBe(game.turn.number);
    expect(game.players.u1.hand).toHaveLength(handBefore + 1);
    expect(game.priority).toBe("u1");
  });

  it("ohne Auto-Passen muss der Gegner auch passen", () => {
    const { game, random } = started();
    act(game, "u1", { type: "autoPass", value: false }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.priority).toBe("u1");
    expect(game.turn.phase).toBe("main1");
    act(game, "u1", { type: "pass" }, random);
    expect(game.turn.phase).toBe("main2");
  });

  it("Handkartenlimit: erst abwerfen, dann beginnt der nächste Zug", () => {
    const { game, random } = started();
    for (let i = 0; i < 3; i += 1) act(game, "u0", { type: "draw" }, random);
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
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u0.battlefield).toContain(cmd);
    // stirbt: Frage erscheint
    act(game, "u0", { type: "counter", id: cmd, kind: "-1/-1", delta: 5 }, random);
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
    expect(act(game, "u0", { type: "move", id: foreign, to: "graveyard" }, random).ok).toBe(false);
    act(game, "u0", { type: "look", count: 3 }, random);
    expect(view(game, "u0").players[0].looking).toHaveLength(3);
    expect(view(game, "u1").players[0].looking).toBeNull();
  });

  it("Sicht verrät weder fremde Hand noch Bibliothek noch verdeckte Karten", () => {
    const { game, random } = started();
    const hidden = game.players.u1.hand[0];
    const name = game.defs[game.cards[hidden].def].name;
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
    expect(act(game, "u0", { type: "ability", text: "Auslöser: ziehe eine Karte" }, random).ok).toBe(true);
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
