// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
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
    pool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 }, askResponse: true, prompts: [],
    counts: { library: 40, hand: 0, battlefield: 0, graveyard: 0, exile: 0, command: 0 },
    hand: [], battlefield: [], graveyard: [], exile: [], command: [], looking: null, cmdDamage: {}, cmdCasts: {}, ...extra
  };
}

function view(extra: Partial<GameView> = {}, mine: Partial<GamePlayer> = {}, other: Partial<GamePlayer> = {}): GameView {
  return {
    format: "standard", phase: "playing", you: "me", winner: null, startedAt: 0, endedAt: null, log: [{ n: 1, text: "Los geht's" }],
    turn: { number: 3, active: "me", phase: "main1", first: "me", landsPlayed: 0 },
    priority: "me", stack: [], combat: null, pendingDiscard: null, fx: [], choice: null, manual: null,
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
    const game = view({ manual: { userId: "me", text: "Draw a card, then return a creature to the battlefield.", source: "Rätsel" } }, { battlefield: [wolf] });
    const { send } = setup(game);
    expect(screen.getByRole("alert", { name: "Manuell umsetzen" })).toBeTruthy();
    expect(screen.getByText("Draw a card, then return a creature to the battlefield.")).toBeTruthy(); // ohne Bild: Text aufgeklappt
    fireEvent.click(screen.getByLabelText(/Bibliothek: 40 Karten/));
    expect(send).toHaveBeenLastCalledWith({ type: "draw" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Wolf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "→ Friedhof" }));
    expect(send).toHaveBeenLastCalledWith({ type: "move", id: "c1", to: "graveyard" });
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    expect(send).toHaveBeenLastCalledWith({ type: "manualDone" });
  });

  it("manuelles Fenster zeigt Vorschläge: Knöpfe führen die Aktion aus, Tipps erklären den Klick", () => {
    const game = view({ manual: { userId: "me", text: "Create two 1/1 Borg tokens. Destroy target creature.", source: "Borg", hints: [{ label: "2× Spielstein Borg 1/1 erzeugen", action: { type: "token", name: "Borg 1/1" }, repeat: 2 }, { label: "Zerstören: Karte rechtsklicken" }] } });
    const { send } = setup(game);
    fireEvent.click(screen.getByRole("button", { name: "2× Spielstein Borg 1/1 erzeugen" }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ type: "token", name: "Borg 1/1" });
    expect(screen.getByText("Zerstören: Karte rechtsklicken")).toBeTruthy();
  });

  it("manuelles Fenster zeigt die Karte selbst (mit Vorschau beim Darüberfahren), der Text ist eingeklappt", () => {
    const game = view({ manual: { userId: "me", text: "Choose one at random.", source: "Magus Sisters", hints: [], cardId: "m1", imageUri: "https://cards.scryfall.io/normal/front/x/y.jpg" } });
    setup(game);
    const img = screen.getByRole("img", { name: "Magus Sisters" });
    expect(img.getAttribute("src")).toContain("/normal/");
    expect(screen.getByText("Nicht automatisch umgesetzt").closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("andere sehen nur, dass jemand einen Kartentext umsetzt", () => {
    setup(view({ priority: null, manual: { userId: "they", text: "x", source: "y" } }));
    expect(screen.getByText("Gegner setzt einen Kartentext um …")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fertig" })).toBeNull();
  });

  it("Weiter-Knopf nur, wenn du handeln darfst", () => {
    const { send, rerender } = setup(view({}, { battlefield: [creature("c1", "Wolf")] }));
    fireEvent.click(screen.getByRole("button", { name: "Weiter zum Kampf" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
    rerender(<Battlefield game={view({ priority: "they" })} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Weiter zum Kampf" })).toBeNull();
    expect(screen.getByText("Warten auf Reaktion von Gegner …")).toBeTruthy();
  });

  it("Stapel (nur wenn jemand antworten kann): erklärt, was gespielt wurde, und fragt nach", () => {
    const game = view({ stack: [{ sid: "s1", controller: "they", kind: "spell", text: "", card: card("x1", "Blitz", { owner: "they" }) }] });
    const { send } = setup(game);
    const stack = screen.getByLabelText("Stapel");
    expect(screen.getByText(/Reaktion ausspielen\? Gegner spielt Blitz\./)).toBeTruthy();
    expect(screen.getByText(/leuchtenden Karten/)).toBeTruthy();
    fireEvent.contextMenu(within(stack).getByRole("button", { name: "Blitz" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Groß ansehen"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Groß ansehen" }));
    fireEvent.click(screen.getByRole("button", { name: "Nein" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
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
    // Lehnt der Server ab, bleibt die Auswahl stehen (der Spieler muss nicht neu anfangen)
    expect(screen.getByRole("button", { name: "Blocken bestätigen" })).toBeTruthy();
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

  it("Vorschau zeigt beim Darüberfahren die ganze Karte als großes Scryfall-Bild, ohne Zusatzkasten", async () => {
    const wolf = creature("c1", "Wolf", "me", {
      manaCost: "{1}{G}", imageUri: "https://cards.scryfall.io/normal/front/a/b/x.jpg", rulesNotes: ["Creatures you control get +1/+1."]
    });
    setup(view({}, { battlefield: [wolf] }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Wolf" }));
    const preview = await screen.findByLabelText("Kartenvorschau");
    expect(within(preview).getByAltText("Wolf").getAttribute("src")).toBe("https://cards.scryfall.io/large/front/a/b/x.jpg");
    expect(within(preview).queryByText(/automatisch/)).toBeNull();
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

describe("Zugablauf und Anzeige", () => {
  it("ohne mögliche Angreifer führt der Knopf direkt zur Hauptphase 2 (kein Kampf angeboten)", () => {
    setup(view({}, { battlefield: [card("l1", "Wald", { kind: "land", mana: true, manaColors: ["G"] })] }));
    expect(screen.getByRole("button", { name: "Weiter zur Hauptphase 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Weiter zum Kampf" })).toBeNull();
  });

  it("Der Weiter-Knopf sitzt in der Phasenleiste: die nächste Phase pulsiert und lässt sich anklicken", () => {
    const { send } = setup(view({}, { battlefield: [card("l1", "Wald", { kind: "land", mana: true, manaColors: ["G"] })] }));
    const nav = screen.getByRole("navigation", { name: "Phasen" });
    const next = within(nav).getByRole("button", { name: "Weiter zur Hauptphase 2" });
    expect(next.className).toContain("phase-next");
    expect(document.querySelector(".action-bar")).toBeNull(); // kein zweiter Knopf in der Aktionsleiste
    fireEvent.click(next);
    expect(send).toHaveBeenCalledWith({ type: "pass" });
  });

  it("Rückfragen zu Reaktionen erscheinen als kompaktes Pop-up (Klasse „side“), der Kommandant-Tag ist vollständig", () => {
    const stack = [{ sid: "s1", kind: "spell" as const, controller: "they", card: card("c1", "Blitz"), targets: [] }];
    setup(view({ priority: "me", stack: stack as never, turn: { number: 3, active: "they", phase: "main1", first: "me", landsPlayed: 0 } }, { battlefield: [card("k1", "Boss", { kind: "creature", cmd: true })] }));
    expect(document.querySelector(".action-bar.side")).not.toBeNull();
    expect(screen.getByText(/♛ Kommandant/).textContent).toBe("♛ Kommandant");
  });

  it("Zug beenden statt Endschritt, wenn die Gegner automatisch passen", () => {
    const game = view({ turn: { number: 3, active: "me", phase: "main2", first: "me", landsPlayed: 0 } });
    setup(game);
    expect(screen.getByRole("button", { name: "Zug beenden" })).toBeTruthy();
  });

  it("Zieh-Schritt: kein Knopf, die Bibliothek wird angeklickt; danach geht es automatisch weiter", () => {
    const base = { manualStart: true, drawn: false, drawBlocked: false };
    const { send } = setup(view({ turn: { number: 2, active: "me", phase: "draw", first: "they", landsPlayed: 0, ...base } }));
    expect(screen.queryByRole("button", { name: "Karte ziehen" })).toBeNull();
    expect(screen.getByText(/Klicke auf deine Bibliothek/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Bibliothek: 40 Karten. Anklicken zum Ziehen/));
    expect(send).toHaveBeenLastCalledWith({ type: "drawStep" });
    cleanup();
    setup(view({ turn: { number: 1, active: "me", phase: "main1", first: "me", landsPlayed: 0, manualStart: false, drawBlocked: true } }));
    expect(screen.getByText(/Im ersten Zug zieht der Startspieler nicht/)).toBeTruthy();
  });

  it("Einstellungen mit An/Aus-Schaltern statt Menüpunkten", () => {
    const { send } = setup(view({}, { autoStart: true, askResponse: true }));
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    expect(screen.queryByRole("menuitem", { name: /Spielverlauf/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Würfel|Münze/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Einstellungen …" }));
    const dialog = screen.getByRole("dialog", { name: "Einstellungen" });
    const draw = within(dialog).getByRole("switch", { name: "Karte automatisch ziehen" });
    expect(draw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(draw);
    expect(send).toHaveBeenLastCalledWith({ type: "autoStart", value: false });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Nachfragen, wenn ich antworten kann" }));
    expect(send).toHaveBeenLastCalledWith({ type: "askResponse", value: false });
  });

  it("Zugwechsel nennt, was automatisch passiert ist", () => {
    setup(view({ turn: { number: 4, active: "me", phase: "main1", first: "they", landsPlayed: 0, manualStart: false, drew: true } }));
    expect(screen.getByText(/Alles enttappt, Karte gezogen/)).toBeTruthy();
    cleanup();
    setup(view({ turn: { number: 4, active: "me", phase: "draw", first: "they", landsPlayed: 0, manualStart: true } }));
    expect(screen.queryByText(/manuell/)).toBeNull();
  });

  it("der Raum liegt über der ganzen App (am Dokument verankert), die Vorschau verschwindet beim Verlassen der Karte und bei Berührung daneben", async () => {
    const wolf = creature("c1", "Wolf", "me", { imageUri: "https://cards.scryfall.io/normal/front/a/b/x.jpg" });
    setup(view({}, { battlefield: [wolf] }));
    expect(screen.getByRole("region", { name: "Spieltisch" }).parentElement).toBe(document.body);
    const tile = screen.getByRole("button", { name: "Wolf" });
    fireEvent.mouseEnter(tile);
    expect(await screen.findByLabelText("Kartenvorschau")).toBeTruthy();
    fireEvent.mouseLeave(tile);
    await vi.waitFor(() => expect(screen.queryByLabelText("Kartenvorschau")).toBeNull());
    fireEvent.mouseEnter(tile);
    await screen.findByLabelText("Kartenvorschau");
    fireEvent.pointerDown(screen.getByLabelText("Mitte: Stapel und Kampf"));
    await vi.waitFor(() => expect(screen.queryByLabelText("Kartenvorschau")).toBeNull());
  });
});

describe("Manuelles Fenster nur laut Kartentext, Münzwurf, Effekte", () => {
  it("bietet nur an, was der Kartentext verlangt: Marker nur auf Kreaturen, kein Ziehen ohne „draw“", () => {
    const land = card("l1", "Wald", { kind: "land", typeLine: "Basic Land — Forest" });
    const wolf = creature("c1", "Wolf");
    setup(view({ manual: { userId: "me", text: "Put a +1/+1 counter on target creature.", source: "X" } }, { battlefield: [wolf, land] }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Wolf" }));
    expect(screen.getByRole("menuitem", { name: "+1/+1 Marker" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "→ Friedhof" })).toBeNull(); // keine Verschiebung verlangt
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Wald" }));
    expect(screen.queryByRole("menuitem", { name: "+1/+1 Marker" })).toBeNull(); // nicht auf Länder
    fireEvent.click(screen.getByLabelText(/Bibliothek: 40 Karten/));
  });

  it("Münzwurf zu Spielbeginn nennt den Startspieler und verschwindet danach", () => {
    const began = Date.now();
    const game = view({ turn: { number: 1, active: "they", phase: "main1", first: "they", landsPlayed: 0, beganAt: began + 1000 } });
    setup(game);
    expect(screen.getByRole("dialog", { name: "Münzwurf: Wer beginnt?" })).toBeTruthy();
    expect(screen.getByText("Gegner beginnt!")).toBeTruthy();
    const overlay = screen.getByRole("dialog", { name: "Münzwurf: Wer beginnt?" });
    const end = createEvent.animationEnd(overlay);
    Object.defineProperty(end, "animationName", { value: "coin-out" });
    fireEvent(overlay, end);
    expect(screen.queryByRole("dialog", { name: "Münzwurf: Wer beginnt?" })).toBeNull();
  });

  it("kein Münzwurf mehr, wenn man mitten im ersten Zug neu lädt", () => {
    const game = view({ turn: { number: 1, active: "they", phase: "main1", first: "they", landsPlayed: 0, beganAt: Date.now() - 600000 } });
    setup(game);
    expect(screen.queryByRole("dialog", { name: "Münzwurf: Wer beginnt?" })).toBeNull();
  });

  it("Schaden zeigt eine schwebende Zahl am Ziel (nur für neue Effekte)", () => {
    const game = view({ fx: [{ id: 1, type: "damage", amount: 2, player: "they" }] });
    const { rerender, send } = setup(game);
    expect(document.querySelector(".fx-float")).toBeNull(); // alte Effekte beim Öffnen nicht abspielen
    rerender(<Battlefield game={{ ...game, fx: [...game.fx, { id: 2, type: "damage", amount: 3, player: "they" }] }} hostId="me" send={send} onRematch={vi.fn()} onLeave={vi.fn()} />);
    expect(document.querySelector(".fx-float.damage")?.textContent).toBe("−3");
  });
});

describe("Auswahl: Ja/Nein (Shock-Land)", () => {
  it("zeigt die Frage mit zwei Antworten und sendet die Wahl sofort", () => {
    const choice = {
      userId: "me", kind: "yesno" as const, prompt: "Schock: 2 Leben zahlen, damit es ungetappt ins Spiel kommt?", min: 1, max: 1,
      options: [{ id: "yes", label: "2 Leben zahlen (ungetappt)" }, { id: "no", label: "Nicht zahlen (getappt)" }]
    };
    const { send } = setup(view({ priority: null, choice }));
    const dialog = screen.getByRole("dialog", { name: "Auswahl" });
    expect(within(dialog).getByText(/2 Leben zahlen, damit es ungetappt/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Nicht zahlen (getappt)" }));
    expect(send).toHaveBeenCalledWith({ type: "choose", ids: ["no"] });
  });
});

describe("Modale Zauber und Cycling", () => {
  it("Modus wählen, dann Ziel wählen, dann wirken", () => {
    const modal = card("m1", "Wahlzauber", {
      play: {
        kind: "spell", ok: true, targets: [],
        modes: [{ label: "2 Schaden an das Ziel.", targets: [{ kind: "any", options: ["they"] }], manual: false }, { label: "Du erhältst 5 Leben.", targets: [], manual: false }]
      }
    });
    const { send } = setup(view({}, { hand: [modal] }));
    fireEvent.click(within(handArea()).getByRole("button", { name: "Wahlzauber" }));
    const dialog = screen.getByRole("dialog", { name: "Modus wählen" });
    fireEvent.click(within(dialog).getByRole("button", { name: "2 Schaden an das Ziel." }));
    fireEvent.click(screen.getByRole("button", { name: "Gegner als Ziel wählen" }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "m1", mode: 0, targets: ["they"] });
    send.mockClear();
    fireEvent.click(within(handArea()).getByRole("button", { name: "Wahlzauber" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Modus wählen" })).getByRole("button", { name: "Du erhältst 5 Leben." }));
    expect(send).toHaveBeenCalledWith({ type: "cast", id: "m1", mode: 1 });
  });

  it("Cycling im Kartenmenü der Hand", () => {
    const cycler = card("c1", "Wechsler", { cycle: { ok: true, cost: "{1}", search: null }, play: { kind: "spell", ok: false, targets: [] } });
    const { send } = setup(view({}, { hand: [cycler] }));
    fireEvent.contextMenu(within(handArea()).getByRole("button", { name: "Wechsler" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Cycling \{1\}/ }));
    expect(send).toHaveBeenCalledWith({ type: "cycle", id: "c1" });
  });
});

describe("Antwortfenster", () => {
  it("wer reagieren darf, wird gefragt; der Spieler am Zug sieht „Warten auf Reaktion“", () => {
    const damage = { number: 3, active: "they", phase: "damage" as const, first: "me", landsPlayed: 0 };
    const { send } = setup(view({ priority: "me", turn: damage }));
    expect(screen.getByText("Reaktion ausspielen?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nein" }));
    expect(send).toHaveBeenCalledWith({ type: "pass" });
    cleanup();
    setup(view({ priority: "they", turn: { ...damage, active: "me" } }));
    expect(screen.getByText("Warten auf Reaktion von Gegner …")).toBeTruthy();
  });
});

describe("Wartehinweise", () => {
  it("„… überlegt …“ erscheint nur kurz und verschwindet von selbst", () => {
    vi.useFakeTimers();
    try {
      setup(view({ priority: "they", turn: { number: 3, active: "they", phase: "main1", first: "me", landsPlayed: 0 } }));
      expect(screen.getByText(/überlegt/)).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(3500);
      });
      expect(screen.queryByText(/überlegt/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

