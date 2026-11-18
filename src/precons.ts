import {
  getCardsBySetAndCollectorNumbers,
  getScryfallCardsByIds,
  normalizeCard,
  type ScryfallCard
} from "./scryfall";
import { roleOf } from "./deckBuilder";
import type { CardRecord, DeckCard, DeckRecord } from "./types";

/**
 * Vorkonstruierte Decks (Precons) stammen aus MTGJSON. Jede Karte trägt dort
 * die exakte Scryfall-ID bzw. Set + Collector Number der Druckversion, die im
 * Produkt enthalten ist. Printings werden deshalb nie über den Namen geraten.
 */
const MTGJSON_API = "https://mtgjson.com/api/v5";
const LIST_CACHE_KEY = "arcane-decksmith:precon-list:v1";
const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PreconDeckSummary {
  fileName: string;
  name: string;
  code: string;
  type: string;
  releaseDate: string;
}

export type PreconSection = "commander" | "main" | "sideboard";

export interface PreconCardRow {
  name: string;
  count: number;
  foil: boolean;
  section: PreconSection;
  scryfallId?: string;
  setCode?: string;
  collectorNumber?: string;
}

export interface PreconDeck extends PreconDeckSummary {
  rows: PreconCardRow[];
}

export interface ResolvedPreconRow {
  row: PreconCardRow;
  card: ScryfallCard;
}

export interface PreconResolution {
  resolved: ResolvedPreconRow[];
  unresolved: PreconCardRow[];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Liest `DeckList.json` von MTGJSON. Unbekannte Einträge werden übersprungen. */
export function parsePreconDeckList(payload: unknown): PreconDeckSummary[] {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) {
    throw new Error("Die Precon-Liste hat ein unerwartetes Format.");
  }

  const decks: PreconDeckSummary[] = [];
  for (const entry of data) {
    const item = asRecord(entry);
    const fileName = text(item?.fileName);
    const name = text(item?.name);
    // Dateinamen dürfen Buchstaben (auch mit Akzenten), Ziffern sowie _ . ' - enthalten; Pfadtricks ("..", "/") bleiben ausgeschlossen.
    if (!fileName || !name || fileName.includes("..") || !/^[\p{L}\p{N}_.'-]+$/u.test(fileName)) continue;
    decks.push({
      fileName,
      name,
      code: text(item?.code).toUpperCase(),
      type: text(item?.type) || "Deck",
      releaseDate: text(item?.releaseDate)
    });
  }

  return decks.sort((a, b) =>
    b.releaseDate.localeCompare(a.releaseDate) || a.name.localeCompare(b.name, "de")
  );
}

function rowFromMtgjsonCard(entry: unknown, section: PreconSection): PreconCardRow | null {
  const card = asRecord(entry);
  if (!card) return null;

  const name = text(card.name);
  const count = Number(card.count ?? 1);
  if (!name || !Number.isFinite(count) || count <= 0) return null;

  const identifiers = asRecord(card.identifiers);
  const scryfallId = text(identifiers?.scryfallId);
  const setCode = text(card.setCode).toLowerCase();
  const collectorNumber = text(card.number);
  const finish = text(card.finish).toLowerCase();

  return {
    name,
    count: Math.floor(count),
    foil: card.isFoil === true || card.isEtched === true || finish === "foil" || finish === "etched",
    section,
    ...(scryfallId ? { scryfallId } : {}),
    ...(setCode ? { setCode } : {}),
    ...(collectorNumber ? { collectorNumber } : {})
  };
}

/** Liest eine MTGJSON-Deckdatei (`decks/<fileName>.json`). */
export function parsePreconDeck(payload: unknown, summary: PreconDeckSummary): PreconDeck {
  const data = asRecord(asRecord(payload)?.data);
  if (!data) {
    throw new Error("Die Deckdatei hat ein unerwartetes Format.");
  }

  const boards: Array<[string, PreconSection]> = [
    ["commander", "commander"],
    ["mainBoard", "main"],
    ["sideBoard", "sideboard"]
  ];

  const rows: PreconCardRow[] = [];
  for (const [key, section] of boards) {
    const board = data[key];
    if (!Array.isArray(board)) continue;
    for (const entry of board) {
      const row = rowFromMtgjsonCard(entry, section);
      if (row) rows.push(row);
    }
  }

  if (rows.length === 0) {
    throw new Error("Die Deckdatei enthält keine Karten.");
  }

  return {
    ...summary,
    name: text(data.name) || summary.name,
    code: text(data.code).toUpperCase() || summary.code,
    rows
  };
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(
      "MTGJSON ist gerade nicht erreichbar. Bitte später erneut versuchen oder die Deckliste per Import (CSV/TXT) übernehmen."
    );
  }
  if (!response.ok) {
    throw new Error(`MTGJSON antwortete mit HTTP ${response.status}.`);
  }
  return response.json();
}

let listCache: PreconDeckSummary[] | null = null;

export async function loadPreconDeckList(): Promise<PreconDeckSummary[]> {
  if (listCache) return listCache;

  try {
    const cached = JSON.parse(sessionStorage.getItem(LIST_CACHE_KEY) ?? "null") as
      { savedAt: number; decks: PreconDeckSummary[] } | null;
    if (cached && Date.now() - cached.savedAt < LIST_CACHE_TTL_MS && Array.isArray(cached.decks)) {
      listCache = cached.decks;
      return listCache;
    }
  } catch {
    // Cache ist optional.
  }

  const decks = parsePreconDeckList(await fetchJson(`${MTGJSON_API}/DeckList.json`));
  listCache = decks;

  try {
    sessionStorage.setItem(LIST_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), decks }));
  } catch {
    // Speicher voll oder deaktiviert: Liste wird beim nächsten Mal neu geladen.
  }

  return decks;
}

export async function loadPreconDeck(summary: PreconDeckSummary): Promise<PreconDeck> {
  return parsePreconDeck(
    await fetchJson(`${MTGJSON_API}/decks/${encodeURIComponent(summary.fileName)}.json`),
    summary
  );
}

/**
 * Löst alle Zeilen exakt auf: zuerst über die Scryfall-ID, sonst über
 * Set + Collector Number. Was so nicht eindeutig gefunden wird, bleibt offen.
 */
export async function resolvePreconDeck(
  deck: PreconDeck,
  onProgress?: (processed: number, total: number) => void
): Promise<PreconResolution> {
  const total = deck.rows.length;
  const byId = new Map<string, ScryfallCard>();
  const byPrinting = new Map<string, ScryfallCard>();
  const printingKey = (set: string, number: string) =>
    `${set.toLowerCase()}::${number.toLowerCase()}`;

  const ids = deck.rows.map(row => row.scryfallId).filter((id): id is string => Boolean(id));
  if (ids.length > 0) {
    const result = await getScryfallCardsByIds(ids, processed =>
      onProgress?.(Math.min(total, processed), total)
    );
    for (const card of result.cards) byId.set(card.id.toLowerCase(), card);
  }

  // Zeilen ohne (gefundene) Scryfall-ID über Set + Collector Number auflösen.
  const bySet = new Map<string, string[]>();
  for (const row of deck.rows) {
    if (row.scryfallId && byId.has(row.scryfallId.toLowerCase())) continue;
    if (!row.setCode || !row.collectorNumber) continue;
    const numbers = bySet.get(row.setCode) ?? [];
    numbers.push(row.collectorNumber);
    bySet.set(row.setCode, numbers);
  }

  for (const [set, numbers] of bySet) {
    const result = await getCardsBySetAndCollectorNumbers(set, numbers);
    if (result.temporaryFailures.length > 0) {
      throw new Error("Scryfall ist gerade nicht vollständig erreichbar. Bitte erneut versuchen.");
    }
    for (const card of result.cards) {
      byPrinting.set(printingKey(card.set, card.collector_number), card);
    }
  }

  const resolved: ResolvedPreconRow[] = [];
  const unresolved: PreconCardRow[] = [];

  for (const row of deck.rows) {
    const card =
      (row.scryfallId ? byId.get(row.scryfallId.toLowerCase()) : undefined) ??
      (row.setCode && row.collectorNumber
        ? byPrinting.get(printingKey(row.setCode, row.collectorNumber))
        : undefined);

    if (card) resolved.push({ row, card });
    else unresolved.push(row);
  }

  onProgress?.(total, total);
  return { resolved, unresolved };
}

/** Fasst aufgelöste Zeilen zu Sammlungsdatensätzen (je Druckversion, mit Foil-Aufteilung) zusammen. */
export function preconCollectionCards(
  rows: ResolvedPreconRow[],
  now = Date.now()
): CardRecord[] {
  const byId = new Map<string, CardRecord>();

  for (const { row, card } of rows) {
    const existing = byId.get(card.id);
    const nonfoil = (existing?.finishCounts?.nonfoil ?? 0) + (row.foil ? 0 : row.count);
    const foil = (existing?.finishCounts?.foil ?? 0) + (row.foil ? row.count : 0);
    const base = existing ?? normalizeCard(card, row.count, row.foil);

    byId.set(card.id, {
      ...base,
      count: nonfoil + foil,
      finishCounts: { nonfoil, foil },
      foil: foil > 0 && nonfoil === 0,
      updatedAt: now
    });
  }

  return [...byId.values()];
}

/**
 * Erzeugt aus einem aufgelösten Precon ein Deck für die Deckliste.
 * Commander stehen in `commanderIds`, Zusatzkarten im Sideboard. `owned` ist der
 * Bestand der Sammlung (vor dem Import), damit "verfügbar" korrekt angezeigt wird.
 */
export function preconDeckRecord(
  deck: PreconDeck,
  rows: ResolvedPreconRow[],
  owned: CardRecord[] = [],
  addedToCollection = false,
  now = Date.now()
): DeckRecord {
  const sourceCards = preconCollectionCards(rows, now);
  const sourceById = new Map(sourceCards.map(card => [card.id, card] as const));
  const ownedById = new Map(owned.map(card => [card.id, card] as const));

  const commanderIds: string[] = [];
  const sideboardIds = new Set<string>();
  const byId = new Map<string, DeckCard>();

  for (const { row, card } of rows) {
    const source = sourceById.get(card.id)!;
    const current = byId.get(card.id);
    const nonfoil = (current?.finishCounts?.nonfoil ?? 0) + (row.foil ? 0 : row.count);
    const foil = (current?.finishCounts?.foil ?? 0) + (row.foil ? row.count : 0);

    byId.set(card.id, {
      id: card.id,
      name: card.name,
      count: nonfoil + foil,
      manaValue: source.manaValue,
      typeLine: source.typeLine,
      role: roleOf(source),
      reason: `Importiert aus Precon ${deck.name}`,
      available: (ownedById.get(card.id)?.count ?? 0) + (addedToCollection ? source.count : 0),
      set: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      foil: foil > 0 && nonfoil === 0,
      finishCounts: { nonfoil, foil }
    });

    if (row.section === "commander") {
      if (!commanderIds.includes(card.id)) commanderIds.push(card.id);
    } else if (row.section === "sideboard") {
      sideboardIds.add(card.id);
    }
  }

  const commanders = commanderIds.slice(0, 2);
  const commanderSet = new Set(commanders);
  const all = [...byId.values()];
  const format = commanders.length > 0 ? "commander" : "standard";

  const colorSource = commanders.length > 0
    ? sourceCards.filter(card => commanderSet.has(card.id))
    : sourceCards;

  return {
    id: crypto.randomUUID(),
    name: deck.name.trim() || "Precon-Deck",
    format,
    commanderIds: commanders,
    cards: all.filter(card => !sideboardIds.has(card.id) && !commanderSet.has(card.id)),
    sideboard: all.filter(card => sideboardIds.has(card.id) && !commanderSet.has(card.id)),
    colors: Array.from(new Set(colorSource.flatMap(card => card.colorIdentity ?? []))),
    createdAt: now,
    updatedAt: now,
    notes: `Importiert aus dem Precon-Deck „${deck.name}“ (${deck.code}, ${deck.releaseDate}).`,
    sourceCards,
    importSource: `Precon ${deck.code}`
  };
}
