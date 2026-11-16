// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GamePlayer, GameView } from "../../gameClient";
import GameTable from "./GameTable";

afterEach(cleanup);

const card = (id: string, name: string, extra: Partial<GameCard> = {}): GameCard => ({
  id, owner: "me", tapped: false, counters: {}, token: false, faceDown: false, damage: 0, sick: false, cmd: false, kind: "other",
  attacking: false, blocking: null, name, typeLine: "Creature", manaValue: 2, manaCost: "", imageUri: null, keywords: [], power: null,
  toughness: null, mana: false, manaColors: [], ...extra
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
const handArea = () => screen.getByLabelText("Deine Hand");

describe("GameTable", () => {
  it("Starthand: Behalten und Mulligan", () => {
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    const { send } = setup(view({ phase: "mulligan" }, { hand }));
    fireEvent.click(screen.getByRole("button", { name: "Behalten" }));
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: [] });
    fireEvent.click(screen.getByRole("button", { name: /Mulligan/ }));
    expect(send).toHaveBeenCalledWith({ type: "mulligan" });
  });

  it("Starthand: nach einem Mulligan Karten unten ablegen", () => {
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    const { send } = setup(view({ phase: "mulligan" }, { hand, mulligans: 1 }));
    const keep = screen.getByRole("button", { name: "Behalten" });
    expect(keep).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Karte Zwei" }));
    fireEvent.click(keep);
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: ["h2"] });
  });

  it("Klick auf eine spielbare Handkarte spielt sie, eine nicht spielbare tut nichts", () => {
    const hand = [
      card("l1", "Wald", { kind: "land", play: { kind: "land", ok: true } }),
      card("z1", "Bär", { play: { kind: "spell", ok: true }, manaCost: "{1}{G}" }),
      card("z2", "Flut", { play: { kind: "spell", ok: false } })
    ];
    const { send } = setup(view({}, { hand }));
    fireEvent.click(within(handArea()).getByRole("button", { name: "Wald" }));
    expect(send).toHaveBeenLastCalledWith({ type: "playLand", id: "l1" });
    fireEvent.click(within(handArea()).getByRole("button", { name: "Bär" }));
    expect(send).toHaveBeenLastCalledWith({ type: "cast", id: "z1" });
    send.mockClear();
    fireEvent.click(within(handArea()).getByRole("button", { name: "Flut" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("X-Zauber fragt nach X", () => {
    const hand = [card("z2", "Welle", { play: { kind: "spell", ok: true }, manaCost: "{X}{U}" })];
    const { send } = setup(view({}, { hand }));
    fireEvent.click(within(handArea()).getByRole("button", { name: "Welle" }));
    fireEvent.change(screen.getByLabelText("Wert für X"), { target: { value: "3" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Wirken" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z2", x: 3 });
  });

  it("Ziehen auf den Tisch spielt die Karte", () => {
    const hand = [card("l1", "Wald", { kind: "land", play: { kind: "land", ok: true } })];
    const { send } = setup(view({}, { hand }));
    fireEvent.drop(screen.getByLabelText("Platz von Ich"), { dataTransfer: { getData: () => "l1" } });
    expect(send).toHaveBeenCalledWith({ type: "playLand", id: "l1" });
  });

  it("Bibliothek anklicken zieht eine Karte", () => {
    const { send } = setup(view());
    fireEvent.click(screen.getByRole("button", { name: /Bibliothek: 40 Karten/ }));
    expect(send).toHaveBeenCalledWith({ type: "draw" });
  });

  it("Aktionsleiste zeigt nur das Mögliche: Weiter-Knopf nur mit Priorität", () => {
    const { send, rerender } = setup(view());
    fireEvent.click(screen.getByRole("button", { name: "Weiter zum Kampf" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
    rerender(<GameTable game={view({ priority: "they" })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Weiter zum Kampf" })).toBeNull();
    expect(screen.getByText("Gegner hat Priorität …")).toBeTruthy();
  });

  it("Leben hat keine ständigen Knöpfe; manuelle Korrektur per Klick auf die Zahl", () => {
    const { send } = setup(view());
    expect(screen.queryByRole("button", { name: "Leben plus 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Leben: 20/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Leben manuell anpassen" })).getByRole("button", { name: "−1" }));
    expect(send).toHaveBeenCalledWith({ type: "life", delta: -1 });
  });

  it("Stapel: Zauber sichtbar, Neutralisieren im Menü der Karte", () => {
    const game = view({ stack: [{ sid: "s1", controller: "they", kind: "spell", text: "", card: card("x1", "Blitz", { owner: "they" }) }] });
    const { send } = setup(game);
    const stack = screen.getByLabelText("Stapel");
    expect(screen.getByRole("button", { name: "Passen – Stapel auflösen" })).toBeTruthy();
    fireEvent.contextMenu(within(stack).getByRole("button", { name: "Blitz" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Neutralisieren" }));
    expect(send).toHaveBeenCalledWith({ type: "counterSpell", sid: "s1" });
  });

  it("Mana: Klick auf ein Land tappt es; bei mehreren Farben erscheint eine Auswahl", () => {
    const forest = card("l1", "Wald", { kind: "land", mana: true, manaColors: ["G"] });
    const dual = card("l2", "Doppelland", { kind: "land", mana: true, manaColors: ["R", "G"] });
    const { send } = setup(view({}, { battlefield: [forest, dual] }));
    fireEvent.click(screen.getByRole("button", { name: "Wald" }));
    expect(send).toHaveBeenLastCalledWith({ type: "tapMana", id: "l1" });
    fireEvent.click(screen.getByRole("button", { name: "Doppelland" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rot" }));
    expect(send).toHaveBeenLastCalledWith({ type: "tapMana", id: "l2", color: "R" });
  });

  it("Klick auf eine Kreatur tappt sie; das Menü bietet nur Passendes", () => {
    const wolf = creature("c1", "Wolf", "me", { tapped: true });
    const { send } = setup(view({}, { battlefield: [wolf] }));
    fireEvent.click(screen.getByRole("button", { name: /Wolf/ }));
    expect(send).toHaveBeenLastCalledWith({ type: "tap", id: "c1" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /Wolf/ }));
    expect(screen.getByRole("menuitem", { name: "Enttappen" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Tappen" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Land spielen" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "→ Friedhof" }));
    expect(send).toHaveBeenLastCalledWith({ type: "move", id: "c1", to: "graveyard" });
  });

  it("Angriff: Kreaturen anklicken, bestätigen; beschwörungsmüde sind nicht wählbar", () => {
    const game = view({ turn: { number: 3, active: "me", phase: "attackers", first: "me", landsPlayed: 0 } }, {
      battlefield: [creature("c1", "Wolf"), creature("c2", "Welpe", "me", { sick: true })]
    });
    const { send } = setup(game);
    expect(screen.queryByRole("button", { name: "Angriff bestätigen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Welpe/ }));
    expect(screen.queryByRole("button", { name: "Angriff bestätigen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wolf" }));
    fireEvent.click(screen.getByRole("button", { name: "Angriff bestätigen" }));
    expect(send).toHaveBeenCalledWith({ type: "declareAttackers", attackers: [{ id: "c1", target: "they" }] });
    fireEvent.click(screen.getByRole("button", { name: "Kein Angriff" }));
    expect(send).toHaveBeenLastCalledWith({ type: "pass" });
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
    fireEvent.click(within(handArea()).getByRole("button", { name: "B" }));
    fireEvent.click(discard);
    expect(send).toHaveBeenCalledWith({ type: "discard", ids: ["h2"] });
  });

  it("Kommandanten-Rückkehr wird angeboten; Steuer wird angezeigt", () => {
    const game = view({ format: "commander" }, { prompts: [{ type: "commander", id: "k1" }], graveyard: [card("k1", "Heldin", { cmd: true })], command: [card("k2", "Heldin", { cmd: true })], cmdCasts: { k2: 2 } });
    const { send } = setup(game);
    expect(screen.getByText(/Steuer \+4/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ja, in die Kommandozone/ }));
    expect(send).toHaveBeenCalledWith({ type: "commanderZone", id: "k1", yes: true });
  });

  it("Zusatzmenü bietet Werkzeuge; Aufgeben nur nach Bestätigung", () => {
    const { send } = setup(view());
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Münze werfen" }));
    expect(send).toHaveBeenCalledWith({ type: "coin" });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Aufgeben" }));
    expect(send).not.toHaveBeenCalledWith({ type: "concede" });
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
