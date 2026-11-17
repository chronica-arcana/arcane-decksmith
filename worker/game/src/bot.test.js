import { describe, expect, it } from "vitest";
import { applyAction, createGame } from "./gameLogic.js";
import { isBotId, nextBotAction, waitingPlayer } from "./bot.js";

const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const LIB = [
  ["forest", "Forest", "Basic Land — Forest", "", 16, {}],
  ["mountain", "Mountain", "Basic Land — Mountain", "", 8, {}],
  ["bear", "Bär", "Creature — Bear", "{1}{G}", 4, { power: "2", toughness: "2" }],
  ["giant", "Riese", "Creature — Giant", "{3}{G}{G}", 2, { power: "5", toughness: "5", keywords: ["Trample"] }],
  ["hawk", "Falke", "Creature — Bird", "{G}", 2, { power: "1", toughness: "1", keywords: ["Flying"] }],
  ["ogre", "Oger", "Creature — Ogre", "{G}", 2, { power: "3", toughness: "3", keywords: ["Menace", "Haste"] }],
  ["bolt", "Blitz", "Instant", "{R}", 3, {}, "Blitz deals 3 damage to any target."],
  ["heal", "Heilung", "Instant", "{G}", 2, {}, "You gain 4 life."],
  ["study", "Studium", "Sorcery", "{G}", 2, {}, "Draw two cards."],
  ["kill", "Zerstörer", "Instant", "{R}", 2, {}, "Destroy target creature."],
  ["counter", "Gegenzauber", "Instant", "{R}", 2, {}, "Counter target spell."],
  ["growth", "Wachstum", "Sorcery", "{G}", 2, {}, "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle."],
  ["mage", "Magier", "Creature — Wizard", "{G}", 2, { power: "1", toughness: "1" }, "{T}: Magier deals 1 damage to any target."],
  ["alarm", "Alarm", "Instant", "{G}", 2, {}, "Create two 1/1 white Soldier creature tokens."],
  ["scrier", "Seherin", "Sorcery", "{G}", 2, {}, "Scry 2."],
  ["pain", "Qual", "Sorcery", "{G}", 2, {}, "Each opponent discards a card."],
  ["anthem", "Hymne", "Enchantment", "{G}", 2, {}, "Creatures you control get +1/+1."],
  ["shock", "Schock", "Land — Forest Mountain", "", 2, {}, "As Schock enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped."],
  ["modal", "Wahlzauber", "Instant", "{G}", 2, {}, "Choose one —\n• Wahlzauber deals 2 damage to any target.\n• You gain 5 life."],
  ["cycler", "Wechsler", "Creature — Elf", "{3}{G}{G}", 2, { power: "2", toughness: "2" }, "Cycling {1}"]
];

function setup(format, count, seed) {
  const facts = new Map();
  const players = {};
  for (let i = 0; i < count; i += 1) {
    const prefix = `d${i}`;
    const main = LIB.map(([key, name, typeLine, manaCost, n, extra, oracleText]) => {
      facts.set(`${prefix}-${key}`, extra);
      return { id: `${prefix}-${key}`, name, count: n, typeLine, manaCost, manaValue: 2, imageUri: null, oracleText: oracleText ?? "" };
    });
    const commanders = format === "commander" ? [{ id: `${prefix}-cmd`, name: `Boss ${prefix}`, count: 1, typeLine: "Legendary Creature — Dragon", manaCost: "{1}{G}", manaValue: 2, imageUri: null }] : [];
    facts.set(`${prefix}-cmd`, { power: "4", toughness: "4" });
    players[`bot-${i}`] = { name: `Bot${i}`, seat: i, deck: { deckId: prefix, name: prefix, commanders, main, sideboard: [] } };
  }
  const random = seeded(seed);
  return { game: createGame({ room: { format, players }, random, now: 1, facts }), random };
}

/** Lässt Bots gegeneinander spielen, bis das Spiel endet. Liefert Fehler und die Zahl der Schritte. */
function simulate(format, count, seed, maxSteps = 6000) {
  const { game, random } = setup(format, count, seed);
  const errors = [];
  let steps = 0;
  while (game.phase !== "ended" && steps < maxSteps) {
    steps += 1;
    const who = waitingPlayer(game);
    if (!who) {
      errors.push(`niemand am Zug in Phase ${game.phase}/${game.turn.phase}`);
      break;
    }
    const action = nextBotAction(game, who);
    if (!action) {
      errors.push(`${who} hat keine Aktion (Phase ${game.phase}/${game.turn.phase})`);
      break;
    }
    const result = applyAction(game, who, action, { random, now: 2 });
    if (!result.ok) {
      errors.push(`${action.type}: ${result.error}`);
      break;
    }
  }
  return { game, errors, steps };
}

describe("Bot", () => {
  it("erkennt Bot-Kennungen", () => {
    expect(isBotId("bot-abc")).toBe(true);
    expect(isBotId("user-1")).toBe(false);
  });

  it("spielt Standard-Partien ohne Fehler und ohne festzuhängen", () => {
    let ended = 0;
    for (let seed = 1; seed <= 25; seed += 1) {
      const { game, errors, steps } = simulate("standard", 2, seed);
      expect(errors, `Seed ${seed}`).toEqual([]);
      if (game.phase === "ended") ended += 1;
      else expect(steps, `Seed ${seed} sollte nicht an Schritten scheitern`).toBeLessThan(6000);
    }
    expect(ended).toBeGreaterThan(15);
  });

  it("spielt Commander zu dritt ohne Fehler", () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const { errors } = simulate("commander", 3, seed, 9000);
      expect(errors, `Seed ${seed}`).toEqual([]);
    }
  });

  it("legt ein Land und wirkt Zauber, wenn er am Zug ist", () => {
    const { game, random } = setup("standard", 2, 3);
    for (let i = 0; i < 200 && game.turn.number < 6 && game.phase !== "ended"; i += 1) {
      const who = waitingPlayer(game);
      applyAction(game, who, nextBotAction(game, who), { random, now: 2 });
    }
    const played = game.seats.reduce((sum, id) => sum + game.players[id].battlefield.length, 0);
    expect(played).toBeGreaterThan(4);
  });

  it("antwortet nicht, wenn er nicht dran ist", () => {
    const { game } = setup("standard", 2, 5);
    const waiting = waitingPlayer(game);
    const other = game.seats.find(id => id !== waiting);
    expect(nextBotAction(game, other)).toBeNull();
  });
});

describe("Bot im Raum", () => {
  it("beim Mulligan handelt der Bot, auch wenn der Mensch noch überlegt", async () => {
    const { game } = setup("standard", 2, 9);
    game.seats[0] = "human";
    game.players.human = game.players["bot-0"];
    delete game.players["bot-0"];
    const { botToAct } = await import("./bot.js");
    expect(botToAct(game)).toBe("bot-1");
  });
});
