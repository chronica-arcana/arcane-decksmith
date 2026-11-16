import { describe, expect, it } from "vitest";
import { MAX_ERRORS, validateDeckForRoom } from "./deckValidation.js";

const LEGAL = { standard: "legal", commander: "legal" };

/** Sammlungskarte (CardRecord) mit sinnvollen Standardwerten. */
function card(id, name, extra = {}) {
  return {
    id, oracleId: `o-${name}`, name, set: "tst", collectorNumber: id, lang: "en", foil: false, count: 1,
    addedAt: 0, updatedAt: 0, manaValue: 2, colors: [], colorIdentity: [], typeLine: "Artifact",
    legalities: LEGAL, imageUris: { normal: `https://cards.scryfall.io/${id}.jpg` }, ...extra
  };
}
const basic = (id, name, count = 40, extra = {}) =>
  card(id, name, { typeLine: `Basic Land — ${name}`, isBasicLand: true, count, ...extra });
const entry = (record, count = 1) => ({ id: record.id, name: record.name, count });

/** Standard: 60 Karten (15 verschiedene Karten à 4 Exemplare). */
function standardSetup() {
  const records = Array.from({ length: 15 }, (_, i) => card(`s${i}`, `Karte ${i}`, { count: 4 }));
  const deck = { id: "d1", name: "Standard-Deck", format: "standard", commanderIds: [], cards: records.map(r => entry(r, 4)), sideboard: [] };
  return { records, deck };
}

/** Commander: Commander + 99 Karten (98 verschiedene Karten + 1 Basic mit Rest). */
function commanderSetup() {
  const commander = card("c0", "Heldin", {
    typeLine: "Legendary Creature — Human", colorIdentity: ["G"], colors: ["G"]
  });
  const spells = Array.from({ length: 60 }, (_, i) => card(`k${i}`, `Zauber ${i}`, { colorIdentity: ["G"] }));
  const forest = basic("b1", "Forest", 80, { colorIdentity: ["G"] });
  const records = [commander, ...spells, forest];
  const deck = {
    id: "d2", name: "Heldin-Deck", format: "commander", commanderIds: ["c0"],
    cards: [...spells.map(r => entry(r)), entry(forest, 39)], sideboard: []
  };
  return { records, deck, commander, spells, forest };
}

const codes = result => result.errors.map(error => error.code);

describe("Standard", () => {
  it("akzeptiert ein gültiges Deck und liefert einen Schnappschuss aus den Sammlungsdaten", () => {
    const { records, deck } = standardSetup();
    deck.cards[0].name = "Gefälschter Name"; // Client-Daten dürfen den Schnappschuss nicht bestimmen
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ format: "standard", mainCount: 60, sideboardCount: 0, commanderCount: 0, totalCards: 60 });
    expect(result.snapshot.main).toHaveLength(15);
    expect(result.snapshot.main[0]).toMatchObject({ id: "s0", name: "Karte 0", count: 4, imageUri: "https://cards.scryfall.io/s0.jpg" });
  });

  it("verlangt mindestens 60 Karten und höchstens 15 im Sideboard", () => {
    const { records, deck } = standardSetup();
    deck.cards.pop();
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "standard" }))).toContain("deck_size");

    const full = standardSetup();
    const extra = Array.from({ length: 4 }, (_, i) => card(`x${i}`, `Extra ${i}`, { count: 4 }));
    full.deck.sideboard = extra.map(r => entry(r, 4)); // 16 Karten
    const result = validateDeckForRoom({ deck: full.deck, collection: [...full.records, ...extra], format: "standard" });
    expect(codes(result)).toEqual(["sideboard_size"]);
  });

  it("begrenzt Kopien auf 4 (Hauptdeck und Sideboard zusammen), Basic Lands ausgenommen", () => {
    const { records, deck } = standardSetup();
    records[0].count = 6;
    deck.sideboard = [entry(records[0], 1)]; // 4 im Hauptdeck + 1 im Sideboard = 5
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(codes(result)).toEqual(["copy_limit"]);
    expect(result.errors[0].message).toContain("5× im Deck");

    const withBasics = standardSetup();
    const plains = basic("p1", "Plains", 100);
    withBasics.deck.cards = [...withBasics.deck.cards.slice(0, 10).map(c => ({ ...c })), entry(plains, 20)];
    expect(validateDeckForRoom({ deck: withBasics.deck, collection: [...withBasics.records, plains], format: "standard" }).ok).toBe(true);
  });

  it("lehnt falsches Format und nicht legale Karten ab", () => {
    const { records, deck } = standardSetup();
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "commander" }))).toContain("format_mismatch");
    records[3].legalities = { standard: "not_legal", commander: "legal" };
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(codes(result)).toEqual(["not_legal"]);
    expect(result.errors[0].message).toContain("Karte 3");
  });

  it("meldet fehlende Legalitätsdaten, nicht aber bei Basic Lands", () => {
    const { records, deck } = standardSetup();
    delete records[1].legalities;
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "standard" }))).toEqual(["legality_unknown"]);

    const withBasic = standardSetup();
    const swamp = basic("sw", "Swamp", 50);
    delete swamp.legalities;
    withBasic.deck.cards = [...withBasic.deck.cards.slice(0, 10), entry(swamp, 20)];
    expect(validateDeckForRoom({ deck: withBasic.deck, collection: [...withBasic.records, swamp], format: "standard" }).ok).toBe(true);
  });
});

describe("Besitzprüfung (streng)", () => {
  it("lehnt Karten ab, die nicht oder zu selten in der Sammlung sind", () => {
    const { records, deck } = standardSetup();
    records[2].count = 3; // 4 im Deck, 3 besessen
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(codes(result)).toEqual(["not_owned"]);
    expect(result.errors[0].message).toBe("„Karte 2“: 4× im Deck, 3× in der Sammlung.");

    const missing = standardSetup();
    const without = missing.records.filter(r => r.id !== "s4");
    const missingResult = validateDeckForRoom({ deck: missing.deck, collection: without, format: "standard" });
    expect(codes(missingResult)).toContain("not_in_collection");
    expect(missingResult.errors[0].message).toBe("„Karte 4“ ist nicht in deiner Sammlung.");
  });

  it("zählt andere Druckversionen derselben Karte (gleiche Oracle-ID) zusammen", () => {
    const { records, deck } = standardSetup();
    records[5].count = 2;
    const otherPrinting = card("s5b", "Karte 5", { count: 2, oracleId: records[5].oracleId });
    expect(validateDeckForRoom({ deck, collection: [...records, otherPrinting], format: "standard" }).ok).toBe(true);
  });

  it("nimmt Basic Lands von der Besitzprüfung aus (offizielle Regeln)", () => {
    const { records, deck } = standardSetup();
    const island = basic("i1", "Island", 1); // nur 1 besessen, 20 im Deck
    deck.cards = [...deck.cards.slice(0, 10), entry(island, 20)];
    expect(validateDeckForRoom({ deck, collection: [...records, island], format: "standard" }).ok).toBe(true);
  });

  it("prüft die Besitzmenge über Hauptdeck und Sideboard zusammen", () => {
    const { records, deck } = standardSetup();
    records[0].count = 4;
    deck.cards[0].count = 3;
    deck.sideboard = [entry(records[0], 2)]; // 5 benötigt, 4 besessen (und über dem Limit von 4)
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(codes(result)).toContain("not_owned");
    expect(result.errors.find(error => error.code === "not_owned").message).toBe("„Karte 0“: 5× im Deck, 4× in der Sammlung.");
  });
});

describe("Commander", () => {
  it("akzeptiert ein gültiges 100-Karten-Deck", () => {
    const { records, deck } = commanderSetup();
    const result = validateDeckForRoom({ deck, collection: records, format: "commander" });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ mainCount: 99, commanderCount: 1, totalCards: 100 });
    expect(result.snapshot.commanders[0].name).toBe("Heldin");
  });

  it("verlangt genau 100 Karten inklusive Commander und mindestens einen Commander", () => {
    const { records, deck } = commanderSetup();
    deck.cards.find(c => c.id === "b1").count = 38; // 98 + 1
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "commander" }))).toEqual(["deck_size"]);

    const noCommander = commanderSetup();
    noCommander.deck.commanderIds = [];
    noCommander.deck.cards.find(c => c.id === "b1").count = 40;
    expect(codes(validateDeckForRoom({ deck: noCommander.deck, collection: noCommander.records, format: "commander" }))).toContain("commander_count");
  });

  it("erzwingt Singleton, Basic Lands ausgenommen", () => {
    const { records, deck, spells } = commanderSetup();
    spells[0].count = 2;
    deck.cards[0].count = 2;
    deck.cards.find(c => c.id === "b1").count = 38;
    const result = validateDeckForRoom({ deck, collection: records, format: "commander" });
    expect(codes(result)).toEqual(["copy_limit"]);
    expect(result.errors[0].message).toContain("erlaubt ist nur 1");
  });

  it("prüft die Farbidentität gegen den Commander", () => {
    const { records, deck, spells } = commanderSetup();
    spells[7].colorIdentity = ["R"];
    const result = validateDeckForRoom({ deck, collection: records, format: "commander" });
    expect(codes(result)).toEqual(["color_identity"]);
    expect(result.errors[0].message).toContain("Zauber 7");
  });

  it("lehnt Karten ab, die im Commander nicht legal sind", () => {
    const { records, deck, spells } = commanderSetup();
    spells[1].legalities = { standard: "legal", commander: "banned" };
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "commander" }))).toEqual(["not_legal"]);
  });

  it("lehnt einen Commander ab, der keiner sein kann", () => {
    const { records, deck, commander } = commanderSetup();
    commander.typeLine = "Creature — Human"; // nicht legendär
    expect(codes(validateDeckForRoom({ deck, collection: records, format: "commander" }))).toEqual(["invalid_commander"]);
  });

  it("erlaubt ein Partner-Paar und lehnt unpassende Paare ab", () => {
    const base = commanderSetup();
    const partner = card("c1", "Gefährte", { typeLine: "Legendary Creature — Elf", colorIdentity: ["G"], oracleText: "Partner" });
    base.commander.oracleText = "Partner";
    base.deck.commanderIds = ["c0", "c1"];
    base.deck.cards.find(c => c.id === "b1").count = 38; // 98 + 2 = 100
    expect(validateDeckForRoom({ deck: base.deck, collection: [...base.records, partner], format: "commander" }).ok).toBe(true);

    base.commander.oracleText = "";
    expect(codes(validateDeckForRoom({ deck: base.deck, collection: [...base.records, partner], format: "commander" }))).toEqual(["invalid_partner"]);
  });

  it("ignoriert das Sideboard (im Commander nicht Teil des Spiels)", () => {
    const { records, deck } = commanderSetup();
    deck.sideboard = [{ id: "gibt-es-nicht", name: "Unbekannt", count: 5 }];
    expect(validateDeckForRoom({ deck, collection: records, format: "commander" }).ok).toBe(true);
  });
});

describe("Robustheit", () => {
  it("meldet fehlende oder fehlerhafte Eingaben ohne Absturz", () => {
    expect(codes(validateDeckForRoom({ deck: null, collection: [], format: "standard" }))).toEqual(["deck_missing"]);
    expect(codes(validateDeckForRoom({ deck: {}, collection: [], format: "modern" }))).toEqual(["format_unknown"]);
    const result = validateDeckForRoom({
      deck: { format: "standard", cards: [{ id: 5, count: 4 }, { id: "x", count: 0 }, null], sideboard: "kaputt" },
      collection: [], format: "standard"
    });
    expect(codes(result)).toContain("invalid_entry");
    expect(result.ok).toBe(false);
  });

  it("begrenzt die Anzahl der Fehlermeldungen", () => {
    const records = Array.from({ length: 60 }, (_, i) => card(`m${i}`, `Karte ${i}`, { count: 0 }));
    const deck = { id: "d", name: "x", format: "standard", commanderIds: [], cards: records.map(r => entry(r, 1)), sideboard: [] };
    const result = validateDeckForRoom({ deck, collection: records, format: "standard" });
    expect(result.errors.length).toBe(MAX_ERRORS + 1);
    expect(result.errors.at(-1).code).toBe("more");
  });
});
