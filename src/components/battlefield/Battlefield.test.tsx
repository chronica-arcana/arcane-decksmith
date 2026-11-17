// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GamePlayer, GameView } from "../../gameClient";
import Battlefield from "./Battlefield";

afterEach(cleanup);

const card = (id: string, name: string, extra: Partial<GameCard> = {}): GameCard => ({
  id, owner: "me", tapped: false, counters: {}, token: false, faceDown: false, damage: 0, sick: false, cmd: false, kind: "other",
  attacking: false, blocking: null, name, typeLine: "Creature", manaValue: 2, manaCost: "", imageUri: null, keywords: [], power: null,
  toughness: null, mana: false, manaColors: [], abilities: [], rulesNotes: [], ...extra
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
    priority: "me", stack: [], combat: null, pendingDiscard: null, choice: null, manual: null,
    players: [player("me", "Ich", mine), player("they", "Gegner", other)], ...extra
  };
}

const setup = (game: GameView, props: Partial<Parameters<typeof Battlefield>[0]> = {}) => {
  const send = vi.fn();
  const onLeave = vi.fn();
  const utils = render(<Battlefield game={game} hostId="me" send={send} onRematch={vi.fn()} onLeave={onLeave} {...props} />);
  return { send, onLeave, ...utils };
};
const handArea = () => screen.getByLabelText("Deine Hand");

describe("Spielraum", () => {
  it("ist ein Vollbild-Raum mit Knopf zum Verlassen, Chat und Verlauf nur auf Wunsch in der Seitenleiste", () => {
    const onSend = vi.fn();
    const { onLeave } = setup(view(), { chat: { lines: [{ id: 1, text: "Ana: hi" }], onSend, connected: true } });
    expect(screen.getByRole("region", { name: "Spieltisch" })).toBeTruthy();
    expect(screen.queryByLabelText("Seitenleiste")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    const drawer = screen.getByLabelText("Seitenleiste");
    expect(within(drawer).getByText("Ana: hi")).toBeTruthy();
    fireEvent.change(within(drawer).getByLabelText("Chat-Nachricht"), { target: { value: "Hallo" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Senden" }));
    expect(onSend).toHaveBeenCalledWith("Hallo");
    fireEvent.click(screen.getByRole("button", { name: "Verlauf" }));
    expect(within(screen.getByLabelText("Seitenleiste")).getByLabelText("Spielverlauf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Raum verlassen" }));
    expect(onLeave).toHaveBeenCalled();
  });

  it("zeigt keine Priorität, sondern blendet kurz ein, wer am Zug ist; die Phasen stehen unter der eigenen Hand", () => {
    setup(view());
    expect(screen.getByText("Du bist am Zug")).toBeTruthy();
    expect(screen.queryByText(/Priorität/)).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Phasen" });
    const mine = screen.getByLabelText("Platz von Ich");
    expect(mine.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const label of ["Enttappen", "Versorgung", "Ziehen", "Hauptphase 1", "Kampf", "Hauptphase 2", "Zugende"]) expect(within(nav).getByText(label)).toBeTruthy();
    expect(within(nav).getByText("Hauptphase 1").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  it("Starthand: Behalten, Mulligan und Karten unten ablegen", () => {
    const hand = [card("h1", "Karte Eins"), card("h2", "Karte Zwei")];
    const { send } = setup(view({ phase: "mulligan" }, { hand }));
    fireEvent.click(screen.getByRole("button", { name: "Behalten" }));
    expect(send).toHaveBeenCalledWith({ type: "keep", bottom: [] });
    fireEvent.click(screen.getByRole("button", { name: /Mulligan/ }));
    expect(send).toHaveBeenCalledWith({ type: "mulligan" });
    cleanup();
    const second = setup(view({ phase: "mulligan" }, { hand, mulligans: 1 }));
    const keep = screen.getByRole("button", { name: "Behalten" });
    expect(keep).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Karte Zwei" }));
    fireEvent.click(keep);
    expect(second.send).toHaveBeenCalledWith({ type: "keep", bottom: ["h2"] });
  });

  it("Klick auf eine spielbare Handkarte spielt sie, eine nicht spielbare tut nichts", () => {
    const hand = [
      card("l1", "Wald", { kind: "land", play: { kind: "land", ok: true } }),
      card("z1", "Bär", { play: { kind: "spell", ok: true, targets: [] }, manaCost: "{1}{G}" }),
      card("z2", "Flut", { play: { kind: "spell", ok: false, targets: [] } })
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

  it("Zauber mit Ziel: Ziel leuchtet, Klick auf den Spieler wirkt mit Ziel, Abbrechen geht", () => {
    const bolt = card("z1", "Blitz", { play: { kind: "spell", ok: true, targets: [{ kind: "any", options: ["they", "e1"] }] } });
    const { send } = setup(view({}, { hand: [bolt] }, { battlefield: [creature("e1", "Ork", "they")] }));
    fireEvent.click(within(handArea()).getByRole("button", { name: "Blitz" }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/Blitz: Wähle ein beliebiges Ziel/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Gegner als Ziel wählen" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z1", targets: ["they"] });
    send.mockClear();
    fireEvent.click(within(handArea()).getByRole("button", { name: "Blitz" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText(/Wähle ein beliebiges Ziel/)).toBeNull();
    fireEvent.click(within(handArea()).getByRole("button", { name: "Blitz" }));
    fireEvent.click(screen.getByRole("button", { name: /Ork/ }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z1", targets: ["e1"] });
  });

  it("X-Zauber fragt nach X", () => {
    const hand = [card("z2", "Welle", { play: { kind: "spell", ok: true, targets: [] }, manaCost: "{X}{U}" })];
    const { send } = setup(view({}, { hand }));
    fireEvent.click(within(handArea()).getByRole("button", { name: "Welle" }));
    fireEvent.change(screen.getByLabelText("Wert für X"), { target: { value: "3" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Wirken" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "z2", x: 3 });
  });

  it("Ziehen auf den Tisch spielt nur, was die Regeln erlauben", () => {
    const hand = [card("l1", "Wald", { kind: "land", play: { kind: "land", ok: true } }), card("l2", "Zweitland", { kind: "land", play: { kind: "land", ok: false } })];
    const { send } = setup(view({}, { hand }));
    fireEvent.drop(screen.getByLabelText("Platz von Ich"), { dataTransfer: { getData: () => "l1" } });
    expect(send).toHaveBeenCalledWith({ type: "playLand", id: "l1" });
    send.mockClear();
    fireEvent.drop(screen.getByLabelText("Platz von Ich"), { dataTransfer: { getData: () => "l2" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("Karten ziehen, Leben ändern oder Manapool anpassen geht nicht von Hand", () => {
    const { send } = setup(view());
    const library = screen.getByLabelText(/Bibliothek: 40 Karten/);
    fireEvent.click(library);
    fireEvent.contextMenu(library);
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Leben: 20/ })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.queryByRole("menuitem", { name: "Karte ziehen" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Spielstein erzeugen …" })).toBeNull();
  });

  it("nur im manuellen Fenster: Bibliothek zieht, Menüs bieten Handarbeit, „Fertig“ schließt es", () => {
    const wolf = creature("c1", "Wolf");
    const game = view({ manual: { userId: "me", text: "Each player sacrifices a creature", source: "Rätsel" } }, { battlefield: [wolf] });
    const { send } = setup(game);
    expect(screen.getByText(/lässt sich nicht automatisch umsetzen/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Bibliothek: 40 Karten/));
    expect(send).toHaveBeenLastCalledWith({ type: "draw" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Wolf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "→ Friedhof" }));
    expect(send).toHaveBeenLastCalledWith({ type: "move", id: "c1", to: "graveyard" });
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    expect(send).toHaveBeenLastCalledWith({ type: "manualDone" });
  });

  it("andere sehen nur, dass jemand einen Kartentext umsetzt", () => {
    setup(view({ priority: null, manual: { userId: "they", text: "x", source: "y" } }));
    expect(screen.getByText("Gegner setzt einen Kartentext um …")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fertig" })).toBeNull();
  });

  it("Weiter-Knopf nur, wenn du handeln darfst", () => {
    const { send, rerender } = setup(view());
    fireEvent.click(screen.getByRole("button", { name: "Weiter zum Kampf" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
    rerender(<Battlefield game={view({ priority: "they" })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Weiter zum Kampf" })).toBeNull();
    expect(screen.getByText("Gegner überlegt …")).toBeTruthy();
  });

  it("Stapel: Zauber sichtbar, Menü bietet nur das Ansehen", () => {
    const game = view({ stack: [{ sid: "s1", controller: "they", kind: "spell", text: "", card: card("x1", "Blitz", { owner: "they" }) }] });
    setup(game);
    const stack = screen.getByLabelText("Stapel");
    expect(screen.getByRole("button", { name: "Passen – Stapel auflösen" })).toBeTruthy();
    fireEvent.contextMenu(within(stack).getByRole("button", { name: "Blitz" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Groß ansehen"]);
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

  it("Aktivierte Fähigkeit: Klick auf die Karte, Ziel wählen, aktivieren", () => {
    const mage = creature("c1", "Magier", "me", {
      abilities: [{ index: 0, text: "{T}: Magier deals 1 damage to any target.", ok: true, manual: false, targets: [{ kind: "any", options: ["they", "me"] }] }]
    });
    const { send } = setup(view({}, { battlefield: [mage] }));
    fireEvent.click(screen.getByRole("button", { name: "Magier" }));
    fireEvent.click(screen.getByRole("button", { name: "Gegner als Ziel wählen" }));
    expect(send).toHaveBeenCalledWith({ type: "activate", id: "c1", index: 0, targets: ["they"] });
  });

  it("Kartenmenü: nur mögliche Einträge, gesperrte Fähigkeiten sind ausgegraut, keine freien Verschiebungen", () => {
    const mage = creature("c1", "Magier", "me", {
      tapped: true,
      abilities: [{ index: 0, text: "{T}: Ping.", ok: false, manual: false, targets: [] }]
    });
    setup(view({}, { battlefield: [mage] }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /Magier/ }));
    const items = screen.getAllByRole("menuitem").map(item => item.textContent);
    expect(items).toEqual(["Groß ansehen", "Fähigkeit: {T}: Ping."]);
    expect(screen.getByRole("menuitem", { name: /Fähigkeit/ })).toHaveProperty("disabled", true);
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

  it("Kampfbahnen: Angreifer und Blocker liegen in der Mitte, nicht mehr auf dem Feld", () => {
    const game = view(
      {
        turn: { number: 3, active: "they", phase: "damage", first: "me", landsPlayed: 0 },
        combat: { attackers: [{ id: "a1", target: "me" }], blocks: [{ blocker: "b1", attacker: "a1" }], awaiting: [] }
      },
      { battlefield: [creature("b1", "Wächter", "me", { blocking: "a1" }), creature("b2", "Reserve")] },
      { battlefield: [creature("a1", "Räuber", "they", { attacking: true })] }
    );
    setup(game);
    const combat = screen.getByLabelText("Kampf");
    expect(within(combat).getByRole("button", { name: /Räuber/ })).toBeTruthy();
    expect(within(combat).getByRole("button", { name: /Wächter/ })).toBeTruthy();
    const mine = screen.getByLabelText("Kreaturen von Ich");
    expect(within(mine).queryByRole("button", { name: /Wächter/ })).toBeNull();
    expect(within(mine).getByRole("button", { name: /Reserve/ })).toBeTruthy();
  });

  it("Auswahl durch einen Kartentext: Karten wählen und bestätigen; andere warten", () => {
    const options = [{ id: "k1", card: card("k1", "Alpha") }, { id: "k2", card: card("k2", "Beta") }];
    const game = view({ priority: null, choice: { userId: "me", kind: "cards", prompt: "Wirf 1 Karte ab (Qual).", min: 1, max: 1, options } });
    const { send } = setup(game);
    const dialog = screen.getByRole("dialog", { name: "Auswahl" });
    expect(within(dialog).getByText("Wirf 1 Karte ab (Qual).")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Bestätigen" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Beta" }));
    fireEvent.click(confirm);
    expect(send).toHaveBeenCalledWith({ type: "choose", ids: ["k2"] });
    cleanup();
    setup(view({ priority: null, choice: { userId: "they", kind: "cards", prompt: "x", min: 1, max: 1, options: [] } }));
    expect(screen.queryByRole("dialog", { name: "Auswahl" })).toBeNull();
    expect(screen.getByText("Gegner trifft eine Auswahl …")).toBeTruthy();
  });

  it("Handkartenlimit und Kommandanten-Frage", () => {
    const hand = [card("h1", "A"), card("h2", "B")];
    const first = setup(view({ pendingDiscard: { userId: "me", count: 1 }, priority: null }, { hand }));
    const discard = screen.getByRole("button", { name: "Abwerfen" });
    expect(discard).toHaveProperty("disabled", true);
    fireEvent.click(within(handArea()).getByRole("button", { name: "B" }));
    fireEvent.click(discard);
    expect(first.send).toHaveBeenCalledWith({ type: "discard", ids: ["h2"] });
    cleanup();
    const game = view({ format: "commander" }, { prompts: [{ type: "commander", id: "k1" }], graveyard: [card("k1", "Heldin", { cmd: true })], command: [card("k2", "Heldin", { cmd: true })], cmdCasts: { k2: 2 } });
    const second = setup(game);
    expect(screen.getByText(/2× gewirkt/)).toBeTruthy();
    expect(screen.getByAltText("4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ja, in die Kommandozone/ }));
    expect(second.send).toHaveBeenCalledWith({ type: "commanderZone", id: "k1", yes: true });
  });

  it("Vorschau erscheint beim Darüberfahren verzögert und stabil, mit großem Scryfall-Bild und Hinweisen", async () => {
    const wolf = creature("c1", "Wolf", "me", {
      manaCost: "{1}{G}", imageUri: "https://cards.scryfall.io/normal/front/a/b/x.jpg", rulesNotes: ["Creatures you control get +1/+1."]
    });
    setup(view({}, { battlefield: [wolf] }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Wolf" }));
    const preview = await screen.findByLabelText("Kartenvorschau");
    expect(within(preview).getByAltText("Wolf").getAttribute("src")).toBe("https://cards.scryfall.io/large/front/a/b/x.jpg");
    expect(within(preview).getByAltText("Grün")).toBeTruthy();
    expect(within(preview).getByText(/Wird nicht automatisch berücksichtigt/)).toBeTruthy();
  });

  it("Spielende: Sieger, Revanche nur für den Gastgeber", () => {
    const ended = view({ phase: "ended", winner: "they", priority: null });
    const onRematch = vi.fn();
    const { rerender } = render(<Battlefield game={ended} hostId="they" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    expect(screen.getByText(/Gegner gewinnt/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revanche" })).toBeNull();
    rerender(<Battlefield game={ended} hostId="me" send={vi.fn()} onRematch={onRematch} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revanche" }));
    expect(onRematch).toHaveBeenCalled();
  });
});
