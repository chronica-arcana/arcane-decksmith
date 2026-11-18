import { describe, expect, it } from "vitest";
import { parsePreconDeck, parsePreconDeckList, preconCollectionCards, preconDeckRecord } from "./precons";
import type { ScryfallCard } from "./scryfall";

const summary = { fileName: "Test_C21", name: "Test", code: "C21", type: "Commander Deck", releaseDate: "2021-04-23" };

describe("precons", () => {
  it("liest die Deckliste und sortiert neueste zuerst", () => {
    const decks = parsePreconDeckList({
      data: [
        { fileName: "Old_C13", name: "Old", code: "c13", type: "Commander Deck", releaseDate: "2013-11-01" },
        { fileName: "../evil", name: "Evil", code: "x", type: "Deck", releaseDate: "2030-01-01" },
        { fileName: "Éldrazi_Unleashed_C99", name: "Eldrazi", code: "c99", type: "Commander Deck", releaseDate: "2015-01-01" },
        summary
      ]
    });
    expect(decks.map(deck => deck.fileName)).toEqual(["Test_C21", "Éldrazi_Unleashed_C99", "Old_C13"]);
    expect(decks[2].code).toBe("C13");
  });

  it("übernimmt Commander, Hauptdeck und Zusatzkarten mit exakten Printings", () => {
    const deck = parsePreconDeck({
      data: {
        name: "Lorehold Legacies",
        commander: [{ name: "Osgir", count: 1, isFoil: true, setCode: "C21", number: "4", identifiers: { scryfallId: "id-1" } }],
        mainBoard: [
          { name: "Sol Ring", count: 1, setCode: "C21", number: "263", identifiers: { scryfallId: "id-2" } },
          { name: "Mountain", count: 0, setCode: "C21", number: "300" }
        ],
        sideBoard: [{ name: "Extra", count: 2, setCode: "C21", number: "5" }]
      }
    }, summary);

    expect(deck.name).toBe("Lorehold Legacies");
    expect(deck.rows).toEqual([
      { name: "Osgir", count: 1, foil: true, section: "commander", scryfallId: "id-1", setCode: "c21", collectorNumber: "4" },
      { name: "Sol Ring", count: 1, foil: false, section: "main", scryfallId: "id-2", setCode: "c21", collectorNumber: "263" },
      { name: "Extra", count: 2, foil: false, section: "sideboard", setCode: "c21", collectorNumber: "5" }
    ]);
  });

  it("fasst gleiche Druckversionen mit Foil-Aufteilung zusammen", () => {
    const scry = { id: "x", oracle_id: "o", name: "Sol Ring", set: "c21", set_name: "C21", collector_number: "263", lang: "en", cmc: 1, colors: [], color_identity: [], type_line: "Artifact", finishes: ["nonfoil", "foil"], prices: {} } as unknown as ScryfallCard;
    const cards = preconCollectionCards([
      { row: { name: "Sol Ring", count: 1, foil: false, section: "main" }, card: scry },
      { row: { name: "Sol Ring", count: 1, foil: true, section: "main" }, card: scry }
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].finishCounts).toEqual({ nonfoil: 1, foil: 1 });
    expect(cards[0].count).toBe(2);
  });

  it("legt aus einem Commander-Precon ein Deck für die Deckliste an", () => {
    const scry = (id: string, name: string, type: string, ci: string[] = []) => ({
      id, oracle_id: id, name, set: "c21", set_name: "Commander 2021", collector_number: id, lang: "en",
      cmc: 2, colors: ci, color_identity: ci, type_line: type, finishes: ["nonfoil", "foil"], prices: {}
    }) as unknown as ScryfallCard;
    const commander = scry("1", "Osgir", "Legendary Creature — Giant", ["R", "W"]);
    const ring = scry("2", "Sol Ring", "Artifact");
    const extra = scry("3", "Extra", "Instant", ["R"]);

    const rows = [
      { row: { name: "Osgir", count: 1, foil: true, section: "commander" as const }, card: commander },
      { row: { name: "Sol Ring", count: 1, foil: false, section: "main" as const }, card: ring },
      { row: { name: "Sol Ring", count: 1, foil: true, section: "main" as const }, card: ring },
      { row: { name: "Extra", count: 2, foil: false, section: "sideboard" as const }, card: extra }
    ];
    const deck = { ...summary, name: "Lorehold Legacies", rows: [] };
    const owned = [{ ...preconCollectionCards([rows[1]])[0], count: 3 }];

    const record = preconDeckRecord(deck, rows, owned, true, 42);

    expect(record.format).toBe("commander");
    expect(record.name).toBe("Lorehold Legacies");
    expect(record.commanderIds).toEqual(["1"]);
    expect(record.cards.map(card => card.name)).toEqual(["Sol Ring"]);
    expect(record.cards[0].count).toBe(2);
    expect(record.cards[0].finishCounts).toEqual({ nonfoil: 1, foil: 1 });
    expect(record.cards[0].available).toBe(5);
    expect(record.sideboard.map(card => card.name)).toEqual(["Extra"]);
    expect(record.colors.sort()).toEqual(["R", "W"]);
    expect(record.sourceCards).toHaveLength(3);
    expect(record.createdAt).toBe(42);
    expect(record.importSource).toBe("Precon C21");

    const withoutCollection = preconDeckRecord(deck, rows, [], false);
    expect(withoutCollection.cards[0].available).toBe(0);
  });
});
