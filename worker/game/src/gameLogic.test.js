import { describe, expect, it } from "vitest";
import { abortGame, applyAction, createGame, gameView, playerLeft } from "./gameLogic.js";

const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function deck(prefix, size = 40, commander = false) {
  return {
    deckId: prefix,
    name: `Deck ${prefix}`,
    commanders: commander ? [{ id: `${prefix}-cmd`, name: `Boss ${prefix}`, count: 1, typeLine: "Legendary Creature", manaValue: 4, imageUri: "x" }] : [],
    main: [
      { id: `${prefix}-land`, name: "Forest", count: size - 10, typeLine: "Basic Land — Forest", manaValue: 0, imageUri: "f" },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `${prefix}-c${i}`, name: `Karte ${prefix}${i}`, count: 1, typeLine: "Creature", manaValue: 2, imageUri: "u" }))
    ],
    sideboard: []
  };
}

function room(format = "standard", count = 2) {
  const players = {};
  for (let i = 0; i < count; i += 1) {
    players[`u${i}`] = { name: `Spieler${i}`, seat: i, deck: deck(`d${i}`, format === "commander" ? 99 : 60, format === "commander") };
  }
  return { format, players };
}

function started(format = "standard", count = 2, seed = 7) {
  const random = seeded(seed);
  const game = createGame({ room: room(format, count), random, now: 1000 });
  for (const id of game.seats) expect(applyAction(game, id, { type: "keep" }, { random })).toEqual({ ok: true });
  return { game, random };
}

describe("createGame", () => {
  it("gibt jedem sieben Karten, mischt und stellt Kommandanten in die Kommandozone", () => {
    const game = createGame({ room: room("commander", 3), random: seeded(), now: 1 });
    expect(game.phase).toBe("mulligan");
    for (const id of game.seats) {
      const p = game.players[id];
      expect(p.hand).toHaveLength(7);
      expect(p.library).toHaveLength(99 - 7);
      expect(p.command).toHaveLength(1);
      expect(p.life).toBe(40);
    }
  });

  it("mischt zufällig unterschiedlich", () => {
    const a = createGame({ room: room(), random: seeded(1) });
    const b = createGame({ room: room(), random: seeded(2) });
    expect(a.players.u0.library).not.toEqual(b.players.u0.library);
  });
});

describe("Mulligan und Spielbeginn", () => {
  it("London-Mulligan: neue sieben, dann Karten unten ablegen", () => {
    const random = seeded();
    const game = createGame({ room: room(), random });
    const p = game.players.u0;
    expect(applyAction(game, "u0", { type: "mulligan" }, { random }).ok).toBe(true);
    expect(p.hand).toHaveLength(7);
    expect(applyAction(game, "u0", { type: "keep", bottom: [] }, { random }).ok).toBe(false);
    const bottom = [p.hand[0]];
    expect(applyAction(game, "u0", { type: "keep", bottom }, { random }).ok).toBe(true);
    expect(p.hand).toHaveLength(6);
    expect(p.library[0]).toBe(bottom[0]);
    expect(p.library).toHaveLength(54);
  });

  it("Commander: erster Mulligan ist frei", () => {
    const random = seeded();
    const game = createGame({ room: room("commander", 2), random });
    applyAction(game, "u0", { type: "mulligan" }, { random });
    expect(applyAction(game, "u0", { type: "keep" }, { random }).ok).toBe(true);
    expect(game.players.u0.hand).toHaveLength(7);
  });

  it("startet erst, wenn alle behalten; der Beginnende zieht im 2-Spieler-Spiel nicht", () => {
    const random = seeded();
    const game = createGame({ room: room(), random });
    applyAction(game, "u0", { type: "keep" }, { random });
    expect(game.phase).toBe("mulligan");
    expect(applyAction(game, "u0", { type: "draw" }, { random }).ok).toBe(false);
    applyAction(game, "u1", { type: "keep" }, { random });
    expect(game.phase).toBe("playing");
    expect(game.turn.number).toBe(1);
    expect(game.players[game.turn.active].hand).toHaveLength(7);
  });

  it("im Mehrspielerspiel zieht auch der Beginnende", () => {
    const { game } = started("commander", 3);
    expect(game.players[game.turn.active].hand).toHaveLength(8);
  });
});

describe("Aktionen", () => {
  it("ziehen, Karten bewegen, tappen, Marker", () => {
    const { game, random } = started();
    const id = game.seats[0];
    const p = game.players[id];
    expect(applyAction(game, id, { type: "draw", count: 2 }, { random }).ok).toBe(true);
    const card = p.hand[0];
    expect(applyAction(game, id, { type: "move", id: card, to: "battlefield" }, { random }).ok).toBe(true);
    expect(p.battlefield).toEqual([card]);
    applyAction(game, id, { type: "tap", id: card }, { random });
    expect(game.cards[card].tapped).toBe(true);
    applyAction(game, id, { type: "counter", id: card, kind: "+1/+1", delta: 2 }, { random });
    expect(game.cards[card].counters).toEqual({ "+1/+1": 2 });
    applyAction(game, id, { type: "counter", id: card, kind: "+1/+1", delta: -5 }, { random });
    expect(game.cards[card].counters).toEqual({});
    applyAction(game, id, { type: "move", id: card, to: "graveyard" }, { random });
    expect(game.cards[card].tapped).toBe(false);
    expect(p.graveyard).toEqual([card]);
  });

  it("fremde Karten und Bibliothekskarten ohne Ansehen sind tabu", () => {
    const { game, random } = started();
    const [a, b] = game.seats;
    const foreign = game.players[b].hand[0];
    expect(applyAction(game, a, { type: "move", id: foreign, to: "graveyard" }, { random }).ok).toBe(false);
    expect(applyAction(game, a, { type: "tap", id: foreign }, { random }).ok).toBe(false);
    const top = game.players[a].library.at(-1);
    expect(applyAction(game, a, { type: "move", id: top, to: "hand" }, { random }).ok).toBe(false);
  });

  it("Bibliothek ansehen: nur eigene Sicht, Karten nach unten legen", () => {
    const { game, random } = started();
    const [a, b] = game.seats;
    applyAction(game, a, { type: "look", count: 3 }, { random });
    const view = gameView(game, a).players.find(p => p.userId === a);
    expect(view.looking).toHaveLength(3);
    expect(gameView(game, b).players.find(p => p.userId === a).looking).toBeNull();
    const first = view.looking[0].id;
    expect(first).toBe(game.players[a].library.at(-1));
    applyAction(game, a, { type: "move", id: first, to: "library", position: "bottom" }, { random });
    expect(game.players[a].library[0]).toBe(first);
    applyAction(game, a, { type: "shuffle" }, { random });
    expect(game.players[a].looking).toBeNull();
  });

  it("Spielsteine entstehen auf dem Schlachtfeld und verschwinden beim Verlassen", () => {
    const { game, random } = started();
    const id = game.seats[0];
    expect(applyAction(game, id, { type: "token", name: "Goblin 1/1" }, { random }).ok).toBe(true);
    const token = game.players[id].battlefield[0];
    expect(game.cards[token].token).toBe(true);
    applyAction(game, id, { type: "move", id: token, to: "graveyard" }, { random });
    expect(game.cards[token]).toBeUndefined();
    expect(game.players[id].graveyard).toHaveLength(0);
    expect(applyAction(game, id, { type: "token", name: "<>" }, { random }).ok).toBe(false);
  });

  it("Kommandant: Zählung der Wirkungen und Schaden führt zum Ausscheiden", () => {
    const { game, random } = started("commander", 2);
    const [a, b] = game.seats;
    const cmd = game.players[a].command[0];
    applyAction(game, a, { type: "move", id: cmd, to: "battlefield" }, { random });
    applyAction(game, a, { type: "move", id: cmd, to: "command" }, { random });
    applyAction(game, a, { type: "move", id: cmd, to: "battlefield" }, { random });
    expect(game.players[a].cmdCasts[cmd]).toBe(2);
    expect(applyAction(game, b, { type: "cmddmg", from: a, delta: 10 }, { random }).ok).toBe(true);
    applyAction(game, b, { type: "cmddmg", from: a, delta: 11 }, { random });
    expect(game.players[b].eliminated).toContain("Kommandantenschaden");
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe(a);
  });

  it("Leben, Gift, Aufgeben beenden das Spiel mit Zusammenfassung", () => {
    const { game, random } = started("standard", 2);
    const [a, b] = game.seats;
    applyAction(game, a, { type: "life", delta: -19 }, { random });
    expect(game.players[a].life).toBe(1);
    applyAction(game, b, { type: "pcounter", kind: "poison", delta: 9 }, { random });
    expect(game.phase).toBe("playing");
    applyAction(game, a, { type: "concede" }, { random, now: 5000 });
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe(b);
    expect(game.summary.players).toHaveLength(2);
    expect(applyAction(game, b, { type: "draw" }, { random }).ok).toBe(false);
  });

  it("Zugwechsel: nur der aktive Spieler, enttappt und zieht", () => {
    const { game, random } = started("commander", 3);
    const active = game.turn.active;
    const other = game.seats.find(id => id !== active);
    expect(applyAction(game, other, { type: "endTurn" }, { random }).ok).toBe(false);
    const card = game.players[active].hand[0];
    applyAction(game, active, { type: "move", id: card, to: "battlefield" }, { random });
    applyAction(game, active, { type: "tap", id: card }, { random });
    applyAction(game, active, { type: "nextPhase" }, { random });
    expect(game.turn.phase).toBe("main1");
    applyAction(game, active, { type: "endTurn" }, { random });
    expect(game.turn.active).not.toBe(active);
    expect(game.turn.number).toBe(2);
    const handBefore = game.players[game.turn.active].hand.length;
    expect(handBefore).toBe(8);
    // Der erste Spieler wird wieder enttappt, wenn er dran ist
    applyAction(game, game.turn.active, { type: "endTurn" }, { random });
    applyAction(game, game.turn.active, { type: "endTurn" }, { random });
    expect(game.turn.active).toBe(active);
    expect(game.cards[card].tapped).toBe(false);
  });

  it("ausgeschiedene Spieler werden übersprungen, der Zug geht weiter", () => {
    const { game, random } = started("commander", 3);
    const active = game.turn.active;
    applyAction(game, active, { type: "concede" }, { random });
    expect(game.phase).toBe("playing");
    expect(game.turn.active).not.toBe(active);
    expect(game.players[game.turn.active].eliminated).toBeNull();
  });

  it("Würfel, Münze, ungültige Eingaben", () => {
    const { game, random } = started();
    const id = game.seats[0];
    expect(applyAction(game, id, { type: "dice", sides: 20 }, { random }).ok).toBe(true);
    expect(game.log.at(-1).text).toMatch(/W20: \d+/);
    expect(applyAction(game, id, { type: "bogus" }, { random }).ok).toBe(false);
    expect(applyAction(game, id, "x", { random }).ok).toBe(false);
    expect(applyAction(game, "fremd", { type: "draw" }, { random }).ok).toBe(false);
    expect(applyAction(game, id, { type: "life", delta: "viel" }, { random }).ok).toBe(false);
    expect(applyAction(game, id, { type: "move", id: "c1", to: "nirgends" }, { random }).ok).toBe(false);
  });
});

describe("Sicht und Verlauf", () => {
  it("verrät weder fremde Hand noch Bibliothek noch verdeckte Karten", () => {
    const { game, random } = started();
    const [a, b] = game.seats;
    const hidden = game.players[b].hand[0];
    const secretName = game.defs[game.cards[hidden].def].name;
    applyAction(game, b, { type: "move", id: hidden, to: "battlefield", faceDown: true }, { random });
    const view = JSON.stringify(gameView(game, a));
    expect(view).not.toContain(game.players[b].library[0]);
    const bView = gameView(game, a).players.find(p => p.userId === b);
    expect(bView.hand).toEqual([]);
    expect(bView.counts.hand).toBe(6);
    const faceDown = bView.battlefield.find(c => c.id === hidden);
    expect(faceDown.name).toBeUndefined();
    expect(JSON.stringify(game.log.map(l => l.text))).not.toContain(secretName === "Forest" ? "§§" : secretName);
    // Der Besitzer sieht seine Karte
    expect(gameView(game, b).players.find(p => p.userId === b).battlefield[0].name).toBe(secretName);
  });

  it("gezeigte Handkarten sind für alle sichtbar", () => {
    const { game, random } = started();
    const [a, b] = game.seats;
    const card = game.players[b].hand[0];
    applyAction(game, b, { type: "reveal", id: card }, { random });
    expect(gameView(game, a).players.find(p => p.userId === b).hand.map(c => c.id)).toEqual([card]);
  });

  it("Verlauf nennt Karten nur, wenn sie öffentlich werden", () => {
    const { game, random } = started();
    const id = game.seats[0];
    const card = game.players[id].hand[0];
    const name = game.defs[game.cards[card].def].name;
    applyAction(game, id, { type: "move", id: card, to: "library" }, { random });
    expect(game.log.at(-1).text).toContain("eine Karte");
    expect(game.log.at(-1).text).not.toContain(name);
    applyAction(game, id, { type: "look", count: 1 }, { random });
    applyAction(game, id, { type: "move", id: card, to: "hand" }, { random });
    expect(game.log.at(-1).text).toContain("eine Karte"); // Bibliothek → Hand bleibt geheim
    applyAction(game, id, { type: "move", id: card, to: "graveyard" }, { random });
    expect(game.log.at(-1).text).toContain(name); // Friedhof ist öffentlich
  });

  it("Abbruch und Verlassen", () => {
    const { game, random } = started("commander", 3);
    playerLeft(game, game.seats[2], { random });
    expect(game.players[game.seats[2]].eliminated).toBe("hat den Raum verlassen");
    const summary = abortGame(game, 9);
    expect(summary.aborted).toBe(true);
    expect(game.phase).toBe("ended");
  });

  it("Verlassen während des Mulligans lässt das Spiel beginnen, wenn die anderen bereit sind", () => {
    const random = seeded();
    const game = createGame({ room: room("commander", 3), random });
    applyAction(game, "u0", { type: "keep" }, { random });
    applyAction(game, "u1", { type: "keep" }, { random });
    expect(game.phase).toBe("mulligan");
    playerLeft(game, "u2", { random });
    expect(game.phase).toBe("playing");
  });
});
