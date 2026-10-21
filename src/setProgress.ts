import type { ScryfallCard } from "./scryfall";
import type { CardRecord } from "./types";

export type SetCardRow = {
  card: ScryfallCard;
  /** Anzahl Exemplare in der Sammlung (0 = nicht im Besitz). */
  owned: number;
};

export type SetCardFilter = "all" | "owned" | "missing";

export type SetProgressStats = {
  owned: number;
  total: number;
  percent: number;
  /** Anzahl Sammlungseinträge dieses Sets, die zu keiner Karte der Liste passen. */
  unmatched: number;
};

/** Gleicher Schlüssel wie beim Set-Fortschritt: Sammlernummer, klein geschrieben. */
export const collectorKey = (value: string): string => value.trim().toLowerCase();

/**
 * Ordnet die Karten des Sets den Exemplaren der Sammlung zu (über die Sammlernummer;
 * mehrere Einträge mit gleicher Nummer, z. B. Foil und Non-Foil, werden addiert).
 */
export function buildSetCardRows(setCards: ScryfallCard[], ownedCards: CardRecord[]): SetCardRow[] {
  const ownedByNumber = new Map<string, number>();

  for (const card of ownedCards) {
    const key = collectorKey(card.collectorNumber);
    ownedByNumber.set(key, (ownedByNumber.get(key) ?? 0) + Math.max(0, card.count));
  }

  return setCards.map(card => ({
    card,
    owned: ownedByNumber.get(collectorKey(card.collector_number)) ?? 0
  }));
}

export function setProgressStats(rows: SetCardRow[], ownedCards: CardRecord[]): SetProgressStats {
  const total = rows.length;
  const owned = rows.filter(row => row.owned > 0).length;
  const known = new Set(rows.map(row => collectorKey(row.card.collector_number)));
  const unmatched = new Set(
    ownedCards.map(card => collectorKey(card.collectorNumber)).filter(key => !known.has(key))
  ).size;

  return {
    owned,
    total,
    percent: total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : 0,
    unmatched
  };
}

export function filterSetCardRows(rows: SetCardRow[], filter: SetCardFilter): SetCardRow[] {
  if (filter === "owned") return rows.filter(row => row.owned > 0);
  if (filter === "missing") return rows.filter(row => row.owned === 0);
  return rows;
}
