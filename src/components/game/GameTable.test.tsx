// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GamePlayer, GameView } from "../../gameClient";
import GameTable from "./GameTable";

afterEach(cleanup);

const card = (id: string, name: string, extra: Partial<GameCard> = {}): GameCard => ({
  id, owner: "me", tapped: false, counters: {}, token: false, faceDown: false, damage: 0, sick: false, cmd: false, kind: "other",
  attacking: false, blocking: null, name, typeLine: "Creature", manaValue: 2, manaCost: "", imageUri: null, keywords: [], power: null,
  toughness: null, mana: false, ...extra
});
const creature = (id: string, name: string, owner = "me", extra: Partial<GameCard> = {}) =>
  card(id, name, { owner, kind: "creature", power: 2, toughness: 2, ...extra });

function player(userId: string, name: string, extra: Partial<GamePlayer> = {}): GamePlayer {
  return {
    userId, name, deckName: `Deck ${name}`, life: 20, poison: 0, energy: 0, experience: 0, eliminated: null, mulligans: 0, kept: false,
    pool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, autoPass: true, prompts: [],
    counts: { library: 40, hand: 0, battlefield: 0, graveyard: 0, exile: 0, command: 0 },
    hand: [], battlefield: [], graveyard: [], exile: [], command: [], looking: null, cmdDamage: {}, cmdCasts: {}, ...extra
  };
}

function view(extra: Partial<GameView> = {}, mine: Partial<GamePlayer> = {}, other: Partial<GamePlayer> = {}): GameView {
  return {
    format: "standard", phase: "playing", you: "me", winner: null, startedAt: 0, endedAt: null, log: [{ n: 1, text: "Los geht's" }],
    turn: { number: 3, active: "me", phase: "main1", first: "me", landsPlayed: 0 },
    priority: "me", stack: [], combat: null, pendingDiscard: null,
    players: [player("me", "Ich", mine), player("they", "Gegner", other)], ...extra
  };
}

const setup = (game: GameView, hostId = "me") => {
  const send = vi.fn();
  const utils = render(<GameTable game={game} hostId={hostId} send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
  return { send, ...utils };
};

describe("GameTable", () => {
  it("Mulligan: Behalten und Mulligan", () => {
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    const { send } = setup(view({ phase: "mulligan" }, { hand }));
    fireEvent.click(screen.getByRole("button", { name: "Behalten" }));
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: [] });
    fireEvent.click(screen.getByRole("button", { name: /Mulligan/ }));
    expect(send).toHaveBeenCalledWith({ type: "mulligan" });
  });

  it("Mulligan: nach einem Mulligan Karten unten ablegen", () => {
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    const { send } = setup(view({ phase: "mulligan" }, { hand, mulligans: 1 }));
    const keep = screen.getByRole("button", { name: "Behalten" });
    expect(keep).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Karte Zwei" }));
    fireEvent.click(keep);
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: ["h2"] });
  });

  it("Hand: Land spielen und Zauber wirken über die Aktionsleiste", () => {
    const hand = [card("l1", "Wald", { kind: "land", play: { kind: "land", ok: true } }), card("z1", "Bär", { play: { kind: "spell", ok: true }, manaCost: "{1}{G}" })];
    const { send } = setup(view({}, { hand }));
    const handArea = screen.getByLabelText("Deine Hand");
    fireEvent.click(within(handArea).getByRole("button", { name: "Wald" }));
    fireEvent.click(screen.getByRole("button", { name: "Land spielen" }));
    expect(send).toHaveBeenCalledWith({ type: "playLand", id: "l1" });
    fireEvent.click(within(handArea).getByRole("button", { name: "Bär" }));
    fireEvent.click(screen.getByRole("button", { name: "Wirken" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z1" });
    fireEvent.click(screen.getByRole("button", { name: "Ohne Kosten wirken" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z1", free: true });
  });

  it("nicht spielbare Karten haben deaktivierte Aktion; X-Zauber fragt nach X", () => {
    const hand = [card("z1", "Flut", { play: { kind: "spell", ok: false } }), card("z2", "Welle", { play: { kind: "spell", ok: true }, manaCost: "{X}{U}" })];
    const { send } = setup(view({}, { hand }));
    const handArea = screen.getByLabelText("Deine Hand");
    fireEvent.click(within(handArea).getByRole("button", { name: "Flut" }));
    expect(screen.getByRole("button", { name: "Wirken" })).toHaveProperty("disabled", true);
    fireEvent.click(within(handArea).getByRole("button", { name: "Welle" }));
    fireEvent.click(screen.getByRole("button", { name: "Wirken" }));
    fireEvent.change(screen.getByLabelText("Wert für X"), { target: { value: "3" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Wirken" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z2", x: 3 });
  });

  it("Priorität: Weiter-Knopf passt; ohne Priorität gesperrt", () => {
    const { send, rerender } = setup(view());
    fireEvent.click(screen.getByRole("button", { name: "Weiter zum Kampf" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
    rerender(<GameTable game={view({ priority: "they" })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Warte auf Gegner" })).toHaveProperty("disabled", true);
  });

  it("Stapel: zeigt Zauber, Passen und Neutralisieren", () => {
    const game = view({ stack: [{ sid: "s1", controller: "they", kind: "spell", text: "", card: card("x1", "Blitz", { owner: "they" }) }] });
    const { send } = setup(game);
    expect(screen.getByLabelText("Stapel")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Passen – Stapel auflösen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Neutralisieren" }));
    expect(send).toHaveBeenCalledWith({ type: "counterSpell", sid: "s1" });
  });

  it("Auto-Passen lässt sich umschalten", () => {
    const { send } = setup(view());
    fireEvent.click(screen.getByLabelText(/automatisch passen/));
    expect(send).toHaveBeenCalledWith({ type: "autoPass", value: false });
  });

  it("Angriff: Kreaturen wählen und bestätigen; beschwörungsmüde sind nicht wählbar", () => {
    const game = view({ turn: { number: 3, active: "me", phase: "attackers", first: "me", landsPlayed: 0 } }, {
      battlefield: [creature("c1", "Wolf"), creature("c2", "Welpe", "me", { sick: true })]
    });
    const { send } = setup(game);
    expect(screen.getByRole("button", { name: "Angriff bestätigen" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /^Welpe/ }));
    expect(screen.getByRole("button", { name: "Angriff bestätigen" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Wolf" }));
    fireEvent.click(screen.getByRole("button", { name: "Angriff bestätigen" }));
    expect(send).toHaveBeenCalledWith({ type: "declareAttackers", attackers: [{ id: "c1", target: "they" }] });
  });

  it("Blocken: Blocker wählen, Angreifer zuweisen, bestätigen", () => {
    const game = view(
      {
        turn: { number: 3, active: "they", phase: "blockers", first: "me", landsPlayed: 0 },
        priority: null,
        combat: { attackers: [{ id: "a1", target: "me" }], blocks: [], awaiting: ["me"] }
      },
      { battlefield: [creature("b1", "Wächter")] },
      { battlefield: [creature("a1", "Räuber", "they", { attacking: true })] }
    );
    const { send } = setup(game);
    fireEvent.click(screen.getByRole("button", { name: "Nicht blocken" }));
    expect(send).toHaveBeenCalledWith({ type: "declareBlockers", blocks: [] });
    fireEvent.click(screen.getByRole("button", { name: "Wächter" }));
    fireEvent.click(screen.getByRole("button", { name: /^Räuber/ }));
    fireEvent.click(screen.getByRole("button", { name: "Blocken bestätigen" }));
    expect(send).toHaveBeenLastCalledWith({ type: "declareBlockers", blocks: [{ blocker: "b1", attacker: "a1" }] });
  });

  it("Handkartenlimit: Karten wählen und abwerfen", () => {
    const hand = [card("h1", "A"), card("h2", "B")];
    const { send } = setup(view({ pendingDiscard: { userId: "me", count: 1 }, priority: null }, { hand }));
    const discard = screen.getByRole("button", { name: "Abwerfen" });
    expect(discard).toHaveProperty("disabled", true);
    fireEvent.click(within(screen.getByLabelText("Deine Hand")).getByRole("button", { name: "B" }));
    fireEvent.click(discard);
    expect(send).toHaveBeenCalledWith({ type: "discard", ids: ["h2"] });
  });

  it("Kommandanten-Rückkehr wird angeboten", () => {
    const game = view({ format: "commander" }, { prompts: [{ type: "commander", id: "k1" }], graveyard: [card("k1", "Heldin", { cmd: true })] });
    const { send } = setup(game);
    fireEvent.click(screen.getByRole("button", { name: /Ja, in die Kommandozone/ }));
    expect(send).toHaveBeenCalledWith({ type: "commanderZone", id: "k1", yes: true });
  });

  it("Mana: Quelle tappen mit Farbwahl; Pool wird angezeigt", () => {
    const land = card("l1", "Berg", { kind: "land", mana: true });
    const { send } = setup(view({}, { battlefield: [land], pool: { W: 0, U: 0, B: 0, R: 2, G: 0, C: 0 } }));
    expect(screen.getByLabelText("Manapool")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Berg" }));
    fireEvent.click(screen.getByRole("button", { name: "Mana R" }));
    expect(send).toHaveBeenCalledWith({ type: "tapMana", id: "l1", color: "R" });
  });

  it("Leben und Commander-Anzeige", () => {
    const game = view({ format: "commander" }, { life: 40, cmdDamage: { they: 5 }, command: [card("k1", "Heldin", { cmd: true })], cmdCasts: { k1: 2 } });
    const { send } = setup(game);
    expect(screen.getByText(/Steuer \+4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Leben minus 1" }));
    expect(send).toHaveBeenCalledWith({ type: "life", delta: -1 });
    fireEvent.click(screen.getByRole("button", { name: "Kommandantenschaden von Gegner plus" }));
    expect(send).toHaveBeenCalledWith({ type: "cmddmg", from: "they", delta: 1 });
  });

  it("Spielende: Sieger, Revanche nur für den Gastgeber", () => {
    const ended = view({ phase: "ended", winner: "they" });
    const onRematch = vi.fn();
    const { rerender } = render(<GameTable game={ended} hostId="they" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    expect(screen.getByText(/Gegner gewinnt/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revanche" })).toBeNull();
    rerender(<GameTable game={ended} hostId="me" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revanche" }));
    expect(onRematch).toHaveBeenCalled();
  });
});
