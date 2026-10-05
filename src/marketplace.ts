import { finishCountsFor } from "./collectionState";
import type { CardFinishCounts, CardRecord } from "./types";

/**
 * Ein Tauschangebot: Karte aus der eigenen Sammlung mit Anzahl je Finish.
 * Die Dokument-ID ist `${ownerId}_${cardId}`, pro Spieler und Druckversion gibt es
 * also genau ein Angebot. Das Dokument enthält nur öffentliche Angaben
 * (Anzeigename statt E-Mail).
 */
export interface MarketListing {
  id: string;
  ownerId: string;
  ownerName: string;
  cardId: string;
  name: string;
  nameLower: string;
  set: string;
  setName?: string;
  collectorNumber: string;
  lang: string;
  offered: CardFinishCounts;
  priceEur?: number;
  priceEurFoil?: number;
  imageUri?: string;
  typeLine?: string;
  createdAt: number;
  updatedAt: number;
}

export interface OfferInput {
  card: CardRecord;
  nonfoil: number;
  foil: number;
}

export const MIN_DISPLAY_NAME = 2;
export const MAX_DISPLAY_NAME = 30;
export const MAX_OFFER_PER_FINISH = 1000;

/** Nur Scryfall-Bilder werden angezeigt (auch per Datenbank-Constraint erzwungen). */
const SCRYFALL_IMAGE_PREFIX = "https://cards.scryfall.io/";

export function marketListingId(ownerId: string, cardId: string): string {
  return `${ownerId}_${cardId}`;
}

export function listingTotal(offered: CardFinishCounts): number {
  return offered.nonfoil + offered.foil;
}

export type DisplayNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Der Anzeigename ist für alle angemeldeten Spieler sichtbar. Damit nicht
 * versehentlich eine E-Mail-Adresse oder ein Link veröffentlicht wird, sind
 * "@" und Web-Adressen nicht erlaubt.
 */
export function validateDisplayName(raw: string): DisplayNameCheck {
  const name = raw.replace(/\s+/g, " ").trim();

  if (name.length < MIN_DISPLAY_NAME || name.length > MAX_DISPLAY_NAME) {
    return {
      ok: false,
      error: `Der Anzeigename braucht ${MIN_DISPLAY_NAME} bis ${MAX_DISPLAY_NAME} Zeichen.`
    };
  }
  if (name.includes("@")) {
    return { ok: false, error: "Bitte keine E-Mail-Adresse als Anzeigenamen verwenden." };
  }
  if (/https?:|www\.|\.[a-z]{2,}\//i.test(name)) {
    return { ok: false, error: "Bitte keine Web-Adresse als Anzeigenamen verwenden." };
  }
  return { ok: true, name };
}

function wholeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Begrenzt ein Angebot auf den Bestand der Sammlung (je Finish). */
export function clampOffer(
  card: CardRecord,
  nonfoil: number,
  foil: number
): CardFinishCounts {
  const owned = finishCountsFor(card);
  return {
    nonfoil: Math.min(wholeNumber(nonfoil), owned.nonfoil, MAX_OFFER_PER_FINISH),
    foil: Math.min(wholeNumber(foil), owned.foil, MAX_OFFER_PER_FINISH)
  };
}

function imageFor(card: CardRecord): string | undefined {
  const candidate =
    card.imageUris?.normal ?? card.imageUri ?? card.imageUris?.small ?? card.imageUris?.large;
  return candidate?.startsWith(SCRYFALL_IMAGE_PREFIX) ? candidate : undefined;
}

export function listingFromCard(
  card: CardRecord,
  offered: CardFinishCounts,
  ownerId: string,
  ownerName: string,
  existing?: MarketListing,
  now = Date.now()
): MarketListing {
  const image = imageFor(card);
  return {
    id: marketListingId(ownerId, card.id),
    ownerId,
    ownerName,
    cardId: card.id,
    name: card.name,
    nameLower: card.name.toLowerCase(),
    set: card.set,
    ...(card.setName ? { setName: card.setName } : {}),
    collectorNumber: card.collectorNumber,
    lang: card.lang || "en",
    offered,
    ...(card.priceEur !== undefined ? { priceEur: card.priceEur } : {}),
    ...(card.priceEurFoil !== undefined ? { priceEurFoil: card.priceEurFoil } : {}),
    ...(image ? { imageUri: image } : {}),
    ...(card.typeLine ? { typeLine: card.typeLine } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

export interface OfferPlan {
  toSave: MarketListing[];
  toRemove: string[];
}

/**
 * Berechnet, welche Angebote geschrieben und gelöscht werden müssen.
 * - Anzahl 0/0 entfernt ein vorhandenes Angebot (und legt keines an).
 * - Ändert sich der Anzeigename, werden alle eigenen Angebote aktualisiert.
 */
export function planOfferSave(
  existing: MarketListing[],
  offers: OfferInput[],
  ownerId: string,
  ownerName: string,
  now = Date.now()
): OfferPlan {
  const byCard = new Map(existing.map(listing => [listing.cardId, listing] as const));
  const handled = new Set<string>();
  const toSave: MarketListing[] = [];
  const toRemove: string[] = [];

  for (const offer of offers) {
    const current = byCard.get(offer.card.id);
    const offered = clampOffer(offer.card, offer.nonfoil, offer.foil);
    handled.add(offer.card.id);

    if (listingTotal(offered) === 0) {
      if (current) toRemove.push(current.id);
      continue;
    }

    toSave.push(listingFromCard(offer.card, offered, ownerId, ownerName, current, now));
  }

  for (const listing of existing) {
    if (handled.has(listing.cardId) || listing.ownerName === ownerName) continue;
    toSave.push({ ...listing, ownerName, updatedAt: now });
  }

  return { toSave, toRemove };
}

export type ListingSync =
  | { action: "keep" }
  | { action: "remove" }
  | { action: "update"; listing: MarketListing };

/**
 * Hält ein Angebot konsistent mit der Sammlung: Wird die Karte gelöscht oder
 * sinkt ihr Bestand, wird das Angebot entsprechend verkleinert oder entfernt.
 */
export function syncListingWithCard(
  listing: MarketListing,
  card: CardRecord | undefined,
  now = Date.now()
): ListingSync {
  if (!card) return { action: "remove" };

  const offered = clampOffer(card, listing.offered.nonfoil, listing.offered.foil);
  if (listingTotal(offered) === 0) return { action: "remove" };

  if (offered.nonfoil === listing.offered.nonfoil && offered.foil === listing.offered.foil) {
    return { action: "keep" };
  }

  return { action: "update", listing: { ...listing, offered, updatedAt: now } };
}
