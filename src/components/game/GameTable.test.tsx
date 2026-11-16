// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GamePlayer, GameView } from "../../gameClient";
import GameTable from "./GameTable";

afterEach(cleanup);

const card = (id: string, name: string, extra: Partial<GameCard> = {}): GameCard => ({
  id, owner: "me", tapped: false, counters: {}, token: false, faceDown: false, name, typeLine: "Creature", manaValue: 2, imageUri: null, ...extra
});

function player(userId: string, name: string, extra: Partial<GamePlayer> = {}): GamePlayer {
  return {
    userId, name, deckName: `Deck ${name}`, life: 20, poison: 0, energy: 0, experience: 0, eliminated: null, mulligans: 0, kept: false,
    counts: { library: 40, hand: 0, battlefield: 0, graveyard: 0, exile: 0, command: 0 },
    hand: [], battlefield: [], graveyard: [], exile: [], command: [], looking: null, cmdDamage: {}, cmdCasts: {}, ...extra
  };
}

function view(extra: Partial<GameView> = {}, mine: Partial<GamePlayer> = {}, other: Partial<GamePlayer> = {}): GameView {
  return {
    format: "standard", phase: "playing", you: "me", winner: null, startedAt: 0, endedAt: null, log: [{ n: 1, text: "Los geht's" }],
    turn: { number: 3, active: "me", phase: "main1", first: "me" },
    players: [player("me", "Ich", mine), player("they", "Gegner", other)], ...extra
  };
}

describe("GameTable", () => {
  it("Mulligan: Behalten und Mulligan senden die Aktionen", () => {
    const send = vi.fn();
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    render(<GameTable game={view({ phase: "mulligan" }, { hand })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Behalten" }));
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: [] });
    fireEvent.click(screen.getByRole("button", { name: /Mulligan/ }));
    expect(send).toHaveBeenCalledWith({ type: "mulligan" });
  });

  it("Mulligan: nach einem Mulligan müssen Karten unten abgelegt werden", () => {
    const send = vi.fn();
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    render(<GameTable game={view({ phase: "mulligan" }, { hand, mulligans: 1 })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    const keep = screen.getByRole("button", { name: "Behalten" });
    expect(keep).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Karte Zwei" }));
    expect(keep).toHaveProperty("disabled", false);
    fireEvent.click(keep);
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: ["h2"] });
  });

  it("zeigt Hand, Gegnerzahlen und sendet Karten-Aktionen", () => {
    const send = vi.fn();
    const hand = [card("h1", "Wolf")];
    const game = view({}, { hand, counts: { library: 30, hand: 1, battlefield: 0, graveyard: 0, exile: 0, command: 0 } }, {
      counts: { library: 30, hand: 5, battlefield: 1, graveyard: 0, exile: 0, command: 0 },
      battlefield: [card("b1", "Gegnerkarte", { owner: "they" }), card("b2", "", { owner: "they", faceDown: true, name: undefined })]
    });
    render(<GameTable game={game} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);

    expect(screen.getByText("Hand: 5")).toBeTruthy();
    expect(screen.getByText("Verdeckt")).toBeTruthy();

    fireEvent.click(within(screen.getByLabelText("Deine Hand")).getByRole("button", { name: "Wolf" }));
    fireEvent.click(screen.getByRole("button", { name: "→ Schlachtfeld" }));
    expect(send).toHaveBeenCalledWith({ type: "move", id: "h1", to: "battlefield" });

    fireEvent.click(screen.getByRole("button", { name: "Karte ziehen" }));
    expect(send).toHaveBeenCalledWith({ type: "draw" });
    fireEvent.click(screen.getByRole("button", { name: "Leben plus 1" }));
    expect(send).toHaveBeenCalledWith({ type: "life", delta: 1 });
  });

  it("fremde Karten bieten keine Aktionen an", () => {
    const send = vi.fn();
    const game = view({}, {}, { battlefield: [card("b1", "Gegnerkarte", { owner: "they" })] });
    render(<GameTable game={game} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Gegnerkarte" }));
    expect(screen.getByText("Das ist die Karte eines anderen Spielers.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "→ Friedhof" })).toBeNull();
  });

  it("Zug beenden nur für den aktiven Spieler", () => {
    const send = vi.fn();
    const { rerender } = render(<GameTable game={view()} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Zug beenden" }));
    expect(send).toHaveBeenCalledWith({ type: "endTurn" });
    rerender(<GameTable game={view({ turn: { number: 3, active: "they", phase: "main1", first: "me" } })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Zug beenden" })).toHaveProperty("disabled", true);
  });

  it("Spielende: Sieger, Revanche nur für den Gastgeber", () => {
    const onRematch = vi.fn();
    const ended = view({ phase: "ended", winner: "they" });
    const { rerender } = render(<GameTable game={ended} hostId="they" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    expect(screen.getByText(/Gegner gewinnt/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revanche" })).toBeNull();
    rerender(<GameTable game={ended} hostId="me" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revanche" }));
    expect(onRematch).toHaveBeenCalled();
  });

  it("Commander: Kommandantenschaden und Steuer", () => {
    const send = vi.fn();
    const game = view({ format: "commander" }, { command: [card("k1", "Heldin")], cmdCasts: { k1: 2 } });
    render(<GameTable game={game} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.getByText(/Heldin: \+4/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "+1" })[0]);
    expect(send).toHaveBeenCalledWith({ type: "cmddmg", from: "they", delta: 1 });
  });
});
