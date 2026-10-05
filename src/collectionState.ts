import { compareByName } from "./db";
import type { CardFinish, CardRecord, DeckRecord } from "./types";

/** Preise/Metadaten werden höchstens einmal pro Tag bei Scryfall aufgefrischt. */
export const PRICE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function finishCountsFor(
  card: CardRecord
): Record<CardFinish, number> {
  const stored = card.finishCounts;

  if (stored) {
    const nonfoil = Math.max(0, Math.floor(Number(stored.nonfoil ?? 0)));
    const foil = Math.max(0, Math.floor(Number(stored.foil ?? 0)));

    if (nonfoil + foil > 0) {
      return { nonfoil, foil };
    }
  }

  return card.foil
    ? { nonfoil: 0, foil: card.count }
    : { nonfoil: card.count, foil: 0 };
}

export function legacyFoilFlag(
  counts: Record<CardFinish, number>
): boolean {
  return counts.foil > 0 && counts.nonfoil === 0;
}

/** Ersetzt/ergänzt Karten im State und hält die Sortierung nach Name (wie in der Datenbank-Abfrage). */
export function upsertCards(
  current: CardRecord[],
  updates: CardRecord[]
): CardRecord[] {
  if (updates.length === 0) return current;
  const byId = new Map(current.map(card => [card.id, card] as const));
  for (const card of updates) byId.set(card.id, card);
  return [...byId.values()].sort(compareByName);
}

/** Ersetzt/ergänzt ein Deck; Sortierung nach `updatedAt` absteigend (wie in der Datenbank-Abfrage). */
export function upsertDecks(
  current: DeckRecord[],
  deck: DeckRecord
): DeckRecord[] {
  return [deck, ...current.filter(item => item.id !== deck.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Addiert neue Karten auf den Bestand. Liefert nur die geänderten/neuen
 * Datensätze (zum Speichern), inklusive korrekt summierter Foil-Aufteilung.
 */
export function mergeIntoCollection(
  collection: CardRecord[],
  incomingCards: CardRecord[],
  now = Date.now()
): CardRecord[] {
  const byId = new Map(collection.map(card => [card.id, card] as const));
  const changed = new Map<string, CardRecord>();

  for (const incoming of incomingCards) {
    const existing = changed.get(incoming.id) ?? byId.get(incoming.id);

    if (!existing) {
      changed.set(incoming.id, incoming);
      continue;
    }

    const current = finishCountsFor(existing);
    const added = finishCountsFor(incoming);
    const nextCounts = {
      nonfoil: current.nonfoil + added.nonfoil,
      foil: current.foil + added.foil
    };

    changed.set(incoming.id, {
      ...existing,
      ...incoming,
      // Persönliche Angaben am Bestand bleiben erhalten.
      comment: existing.comment ?? incoming.comment,
      tags: existing.tags ?? incoming.tags,
      condition: existing.condition ?? incoming.condition,
      location: existing.location ?? incoming.location,
      count: nextCounts.nonfoil + nextCounts.foil,
      addedAt: existing.addedAt,
      updatedAt: now,
      finishCounts: nextCounts,
      foil: legacyFoilFlag(nextCounts)
    });
  }

  return [...changed.values()];
}

/** Übernimmt frische Scryfall-Metadaten in einen gespeicherten Datensatz. */
export function refreshedCardRecord(
  card: CardRecord,
  fresh: CardRecord,
  now = Date.now()
): CardRecord {
  const counts = finishCountsFor(card);

  return {
    ...card,
    setName: fresh.setName ?? card.setName,
    finishCounts: counts,
    availableFinishes:
      fresh.availableFinishes && fresh.availableFinishes.length > 0
        ? fresh.availableFinishes
        : card.availableFinishes,
    ...(fresh.priceEur !== undefined ? { priceEur: fresh.priceEur } : {}),
    ...(fresh.priceEurFoil !== undefined ? { priceEurFoil: fresh.priceEurFoil } : {}),
    priceUpdatedAt: fresh.priceUpdatedAt ?? now,
    gameChanger: fresh.gameChanger ?? card.gameChanger,
    foil: legacyFoilFlag(counts)
  };
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** True, wenn sich Preis, Setname, Finishes oder Game-Changer-Status geändert haben. */
export function cardMetadataChanged(before: CardRecord, after: CardRecord): boolean {
  const countsBefore = finishCountsFor(before);
  return (
    before.priceEur !== after.priceEur ||
    before.priceEurFoil !== after.priceEurFoil ||
    before.setName !== after.setName ||
    before.gameChanger !== after.gameChanger ||
    !sameList(before.availableFinishes, after.availableFinishes) ||
    // Altdaten ohne finishCounts einmalig migrieren.
    before.finishCounts?.nonfoil !== countsBefore.nonfoil ||
    before.finishCounts?.foil !== countsBefore.foil
  );
}

/**
 * Reduziert `DeckRecord.sourceCards` auf die Felder, die Anzeige und Analyse
 * brauchen. Decks sind auf 1 MiB begrenzt; vollständige
 * Legalitäten, Bild-Varianten und persönliche Notizen werden nicht kopiert.
 */
export function compactSourceCards(
  cards: CardRecord[] | undefined
): CardRecord[] | undefined {
  if (!cards?.length) return cards;

  return cards.map(card => ({
    id: card.id,
    oracleId: card.oracleId,
    name: card.name,
    set: card.set,
    setName: card.setName,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    foil: card.foil,
    finishCounts: card.finishCounts,
    availableFinishes: card.availableFinishes,
    priceEur: card.priceEur,
    priceEurFoil: card.priceEurFoil,
    count: card.count,
    addedAt: card.addedAt,
    updatedAt: card.updatedAt,
    manaCost: card.manaCost,
    manaValue: card.manaValue,
    colors: card.colors,
    colorIdentity: card.colorIdentity,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    imageUri: card.imageUri ?? card.imageUris?.normal,
    imageUris: card.imageUris?.normal ? { normal: card.imageUris.normal } : undefined,
    legalities: card.legalities
      ? Object.fromEntries(
          Object.entries(card.legalities)
            .filter(([format]) => format === "commander" || format === "standard")
        )
      : undefined,
    gameChanger: card.gameChanger,
    isBasicLand: card.isBasicLand
  }));
}
