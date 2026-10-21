import { describe, expect, it } from "vitest";
import { buildSetCardRows, collectorKey, filterSetCardRows, setProgressStats } from "./setProgress";
import type { ScryfallCard } from "./scryfall";
import type { CardRecord } from "./types";

const setCard = (id: string, cn: string) => ({ id, name: `Karte ${cn}`, set: "neo", collector_number: cn }) as ScryfallCard;
const owned = (id: string, cn: string, count: number) => ({ id, set: "neo", collectorNumber: cn, count }) as CardRecord;

const setCards = [setCard("a", "1"), setCard("b", "2"), setCard("c", "10"), setCard("d", "A-3")];

describe("buildSetCardRows", () => {
  it("ordnet Exemplare über die Sammlernummer zu und addiert gleiche Nummern", () => {
    const rows = buildSetCardRows(setCards, [
      owned("x1", "1", 2),
      owned("x2", "1", 1), // z. B. Foil-Eintrag derselben Nummer
      owned("x3", " a-3 ", 4)
    ]);
    expect(rows.map(r => [r.card.id, r.owned])).toEqual([["a", 3], ["b", 0], ["c", 0], ["d", 4]]);
  });

  it("liefert 0 Exemplare ohne Sammlung", () => {
    expect(buildSetCardRows(setCards, []).every(r => r.owned === 0)).toBe(true);
    expect(collectorKey(" A-3 ")).toBe("a-3");
  });
});

describe("setProgressStats / filterSetCardRows", () => {
  const ownedCards = [owned("x1", "1", 1), owned("x2", "999", 1), owned("x3", "999", 2)];
  const rows = buildSetCardRows(setCards, ownedCards);

  it("zählt vorhandene Karten, Prozent und nicht zuordenbare Einträge", () => {
    expect(setProgressStats(rows, ownedCards)).toEqual({ owned: 1, total: 4, percent: 25, unmatched: 1 });
    expect(setProgressStats([], [])).toEqual({ owned: 0, total: 0, percent: 0, unmatched: 0 });
  });

  it("filtert nach vorhanden und fehlend", () => {
    expect(filterSetCardRows(rows, "all")).toHaveLength(4);
    expect(filterSetCardRows(rows, "owned").map(r => r.card.id)).toEqual(["a"]);
    expect(filterSetCardRows(rows, "missing").map(r => r.card.id)).toEqual(["b", "c", "d"]);
  });
});
