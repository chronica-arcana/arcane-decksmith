import type {
  CardFinish,
  CardRecord
} from "./types";
import {
  cardNameKeys,
  decidePrinting,
  normalizeCollectorNumber,
  normalizeSetToken,
  rawCollectorNumber,
  type ImportMatchMode
} from "./printingMatch";

const API = "https://api.scryfall.com";

const cache = new Map<string, CardRecord>();
const searchCache = new Map<string, ScryfallCard[]>();
const printingsCache = new Map<string, ScryfallCard[]>();
const setCardsCache = new Map<string, ScryfallCard[]>();
const rawCardCache = new Map<string, ScryfallCard>();
const collectorCardCache = new Map<string, ScryfallCard>();
let setsCache: ScryfallSet[] | null = null;
let defaultCardsBulkDescriptorCache: ScryfallBulkDataDescriptor | null = null;
const BULK_DESCRIPTOR_STORAGE_KEY = "arcane:scryfall:default-cards-descriptor:v1";

let lastRequest = 0;
let temporarilyUnavailableUntil = 0;

export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  printed_name?: string;
  lang?: string;
  set: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  printed_type_line?: string;
  printed_text?: string;
  foil?: boolean;
  nonfoil?: boolean;
  finishes?: string[];

  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };

  card_faces?: Array<{
    name?: string;
    printed_name?: string;
    mana_cost?: string;
    oracle_text?: string;
    printed_text?: string;
    type_line?: string;
    printed_type_line?: string;
    colors?: string[];
    color_identity?: string[];
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
    power?: string;
    toughness?: string;
    loyalty?: string;
  }>;

  legalities?: Record<string, string>;
  game_changer?: boolean;
  rarity?: string;
  artist?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  released_at?: string;
  set_name?: string;
  prices?: Record<string, string | null>;
  scryfall_uri?: string;
  prints_search_uri?: string;
}

export interface ScryfallSet {
  id: string;
  code: string;
  name: string;
  set_type?: string;
  released_at?: string;
  card_count?: number;
  digital?: boolean;
}

interface SetListResponse {
  data: ScryfallSet[];
}

export interface CollectorNumberLookupResult {
  cards: ScryfallCard[];
  notFound: string[];
  temporaryFailures: string[];
}

interface SearchResponse {
  data: ScryfallCard[];
  has_more: boolean;
  next_page?: string;
  total_cards: number;
}

interface CollectionResponse {
  data: ScryfallCard[];
  not_found?: Array<{
    set?: string;
    collector_number?: string;
    [key: string]: unknown;
  }>;
}

interface ScryfallBulkDataDescriptor {
  type: string;
  updated_at?: string;
  download_uri?: string;
  jsonl_download_uri?: string;
  size?: number;
  compressed_size?: number;
  content_type?: string;
  content_encoding?: string;
}

export interface BulkImportLookupIdentifier {
  index: number;
  name: string;
  set?: string;
  collectorNumber?: string;
  count?: number;
}

export interface BulkImportLookupResult {
  cardsByIndex: Map<number, ScryfallCard>;
  notFoundIndexes: number[];
  /** Zeilen mit mehreren möglichen Druckversionen (nur Sammlungsimport). */
  ambiguousIndexes: number[];
}

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

const SCRYFALL_MAX_ATTEMPTS = 5;

function retryAfterMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000);
  }

  return Math.min(6_000, 350 * (2 ** attempt));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function temporaryScryfallError(message: string): Error {
  const error = new Error(message);
  error.name = "ScryfallTemporaryError";
  return error;
}

function isTemporaryScryfallError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ScryfallTemporaryError" ||
    /zu viele Anfragen|Scryfall-Fehler 5\d\d|Scryfall konnte nach mehreren Versuchen/.test(error.message)
  );
}

async function getJson<T>(url: string): Promise<T> {
  if (Date.now() < temporarilyUnavailableUntil) {
    throw temporaryScryfallError(
      "Scryfall konnte nach mehreren Versuchen nicht erreicht werden."
    );
  }

  let lastNetworkError: unknown = null;

  for (let attempt = 0; attempt < SCRYFALL_MAX_ATTEMPTS; attempt += 1) {
    const wait = Math.max(0, 120 - (Date.now() - lastRequest));
    if (wait) await sleep(wait);
    lastRequest = Date.now();

    let res: Response;

    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json;q=0.9,*/*;q=0.8"
        }
      });
    } catch (cause) {
      lastNetworkError = cause;
      if (attempt < SCRYFALL_MAX_ATTEMPTS - 1) {
        await sleep(Math.min(6_000, 350 * (2 ** attempt)));
        continue;
      }

      console.error("Scryfall request failed after retries", cause);
      temporarilyUnavailableUntil = Date.now() + 8_000;
      throw temporaryScryfallError(
        "Scryfall konnte nach mehreren Versuchen nicht erreicht werden."
      );
    }

    if (res.ok) return res.json() as Promise<T>;

    if (isRetryableStatus(res.status) && attempt < SCRYFALL_MAX_ATTEMPTS - 1) {
      await sleep(retryAfterMs(res, attempt));
      continue;
    }

    if (isRetryableStatus(res.status)) {
      temporarilyUnavailableUntil = Date.now() + 8_000;
      throw temporaryScryfallError(
        res.status === 429
          ? "Scryfall: zu viele Anfragen. Bitte kurz warten."
          : `Scryfall-Fehler ${res.status}.`
      );
    }

    throw new Error(`Scryfall-Fehler ${res.status}.`);
  }

  console.error("Unexpected Scryfall retry exhaustion", lastNetworkError);
  temporarilyUnavailableUntil = Date.now() + 8_000;
  throw temporaryScryfallError("Scryfall konnte nach mehreren Versuchen nicht erreicht werden.");
}

async function postJson<T>(
  url: string,
  body: unknown
): Promise<T> {
  const wait = Math.max(
    0,
    110 -
      (
        Date.now() -
        lastRequest
      )
  );

  if (wait) {
    await sleep(wait);
  }

  lastRequest = Date.now();

  const res = await fetch(
    url,
    {
      method: "POST",
      headers: {
        Accept:
          "application/json;q=0.9,*/*;q=0.8",
        "Content-Type":
          "application/json"
      },
      body:
        JSON.stringify(body)
    }
  );

  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "Scryfall: zu viele Anfragen. Bitte kurz warten."
        : `Scryfall-Fehler ${res.status}.`
    );
  }

  return res.json() as Promise<T>;
}

function removeUndefinedDeep<T>(
  value: T
): T {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        removeUndefinedDeep(item)
      )
      .filter(
        item =>
          item !== undefined
      ) as T;
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    const cleaned:
      Record<string, unknown> = {};

    for (
      const [key, entry]
      of Object.entries(
        value as Record<
          string,
          unknown
        >
      )
    ) {
      if (entry === undefined) {
        continue;
      }

      cleaned[key] =
        removeUndefinedDeep(
          entry
        );
    }

    return cleaned as T;
  }

  return value;
}

function parseEuroPrice(
  value: string | null | undefined
): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : undefined;
}

export function availableFinishes(
  card: ScryfallCard
): CardFinish[] {
  const finishes =
    new Set(
      card.finishes ?? []
    );

  const result:
    CardFinish[] = [];

  if (
    finishes.has("nonfoil") ||
    card.nonfoil === true
  ) {
    result.push("nonfoil");
  }

  if (
    finishes.has("foil") ||
    card.foil === true
  ) {
    result.push("foil");
  }

  // Fallback nur dann, wenn Scryfall keine
  // Finish-Information geliefert hat.
  if (result.length === 0) {
    if (
      card.prices?.eur
    ) {
      result.push(
        "nonfoil"
      );
    }

    if (
      card.prices?.eur_foil
    ) {
      result.push(
        "foil"
      );
    }
  }

  return result;
}

export function euroPriceFor(
  card: ScryfallCard,
  finish: CardFinish
): number | undefined {
  return parseEuroPrice(
    finish === "foil"
      ? card.prices?.eur_foil
      : card.prices?.eur
  );
}

export function imageFor(
  card: ScryfallCard | CardRecord
): string | undefined {
  if ("collector_number" in card) {
    const directImage =
      card.image_uris?.normal ??
      card.image_uris?.large ??
      card.image_uris?.small;

    if (directImage) {
      return directImage;
    }

    for (
      const face
      of card.card_faces ?? []
    ) {
      const faceImage =
        face.image_uris?.normal ??
        face.image_uris?.large ??
        face.image_uris?.small;

      if (faceImage) {
        return faceImage;
      }
    }

    return undefined;
  }

  return (
    card.imageUris?.normal ??
    card.imageUris?.large ??
    card.imageUris?.small ??
    card.imageUri
  );
}

// Kompatibilität mit der aktuellen App.tsx: bewusst nur englische Daten.
export function displayName(card: ScryfallCard): string {
  return card.name;
}

export function displayTypeLine(card: ScryfallCard): string {
  return (
    card.type_line ??
    card.card_faces
      ?.map(face => face.type_line)
      .filter(Boolean)
      .join(" // ") ??
    ""
  );
}

export function displayOracleText(card: ScryfallCard): string {
  return (
    card.oracle_text ??
    card.card_faces
      ?.map(face => face.oracle_text)
      .filter(Boolean)
      .join("\n//\n") ??
    ""
  );
}

export function normalizeCard(
  card: ScryfallCard,
  count = 1,
  isFoil = false
): CardRecord {
  const face =
    card.card_faces?.[0];

  const finishes =
    availableFinishes(card);

  const priceEur =
    euroPriceFor(
      card,
      "nonfoil"
    );

  const priceEurFoil =
    euroPriceFor(
      card,
      "foil"
    );

  const imageUri =
    imageFor(card);

  const imageUris =
    card.image_uris ??
    face?.image_uris;

  const record:
    CardRecord = {
      id: card.id,
      oracleId:
        card.oracle_id,
      name: card.name,
      set: card.set,
      setName:
        card.set_name,
      collectorNumber:
        card.collector_number,
      lang:
        card.lang ??
        "en",
      foil:
        isFoil,
      finishCounts:
        isFoil
          ? {
              nonfoil: 0,
              foil: count
            }
          : {
              nonfoil: count,
              foil: 0
            },
      availableFinishes:
        finishes,
      ...(priceEur !== undefined
        ? {
            priceEur
          }
        : {}),
      ...(priceEurFoil !== undefined
        ? {
            priceEurFoil
          }
        : {}),
      priceUpdatedAt:
        Date.now(),
      count,
      addedAt:
        Date.now(),
      updatedAt:
        Date.now(),
      manaCost:
        card.mana_cost ??
        face?.mana_cost,
      manaValue:
        Number(
          card.cmc ?? 0
        ),
      colors:
        card.colors ??
        face?.colors ??
        [],
      colorIdentity:
        card.color_identity ??
        face?.color_identity ??
        [],
      typeLine:
        card.type_line ??
        card.card_faces
          ?.map(
            item =>
              item.type_line
          )
          .filter(Boolean)
          .join(" // "),
      oracleText:
        card.oracle_text ??
        card.card_faces
          ?.map(
            item =>
              item.oracle_text
          )
          .filter(Boolean)
          .join("\n//\n"),
      ...(imageUri !== undefined
        ? {
            imageUri
          }
        : {}),
      ...(imageUris !== undefined
        ? {
            imageUris
          }
        : {}),
      legalities:
        card.legalities,
      gameChanger:
        card.game_changer ===
        true,
      isBasicLand:
        /^Basic Land\b/i.test(
          card.type_line ??
          face?.type_line ??
          ""
        )
    };

  return removeUndefinedDeep(
    record
  );
}

// Rein englische Scryfall-Suche.
export async function searchCards(
  query: string
): Promise<ScryfallCard[]> {
  const key = query.trim().toLowerCase();

  if (!key) {
    return [];
  }

  const cached = searchCache.get(key);

  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({
    q: key,
    unique: "cards",
    order: "name"
  });

  const result = await getJson<SearchResponse>(
    `${API}/cards/search?${params.toString()}`
  );

  searchCache.set(key, result.data);

  result.data.forEach(card => {
    rawCardCache.set(card.id, card);
    cache.set(card.id, normalizeCard(card));
  });

  return result.data;
}

/** Alle Karten (Druckversionen) eines Sets, nach Sammlernummer sortiert. */
export async function getSetCards(setCode: string): Promise<ScryfallCard[]> {
  const code = setCode.trim().toLowerCase();

  if (!/^[a-z0-9]{2,8}$/.test(code)) {
    throw new Error("Ungültiger Set-Code.");
  }

  const cached = setCardsCache.get(code);

  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({
    q: `e:${code}`,
    unique: "prints",
    order: "set",
    dir: "asc",
    include_extras: "true",
    include_variations: "true"
  });

  const cards: ScryfallCard[] = [];
  let nextUrl: string | undefined = `${API}/cards/search?${params.toString()}`;

  try {
    while (nextUrl) {
      const result: SearchResponse = await getJson<SearchResponse>(nextUrl);

      cards.push(...result.data);

      nextUrl =
        result.has_more && result.next_page
          ? result.next_page
          : undefined;
    }
  } catch (error) {
    // Scryfall antwortet bei einer Suche ohne Treffer mit 404.
    if (error instanceof Error && /Scryfall-Fehler 404/.test(error.message) && cards.length === 0) {
      return [];
    }

    throw error;
  }

  cards.sort((a, b) =>
    a.collector_number.localeCompare(b.collector_number, undefined, { numeric: true })
  );

  setCardsCache.set(code, cards);

  cards.forEach(card => {
    rawCardCache.set(card.id, card);
  });

  return cards;
}

export async function getSets(): Promise<ScryfallSet[]> {
  if (setsCache) {
    return setsCache;
  }

  const result =
    await getJson<SetListResponse>(
      `${API}/sets`
    );

  setsCache =
    result.data
      .filter(
        set =>
          set.digital !== true &&
          (set.card_count ?? 0) > 0
      )
      .sort(
        (a, b) => {
          const releasedCompare =
            (b.released_at ?? "")
              .localeCompare(
                a.released_at ?? ""
              );

          return releasedCompare !== 0
            ? releasedCompare
            : a.name.localeCompare(
                b.name
              );
        }
      );

  return setsCache;
}

function collectorLookupKey(setCode: string, collectorNumber: string): string {
  return `${setCode.trim().toLowerCase()}::${collectorNumber.trim().toLowerCase()}`;
}

function escapeScryfallSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}





async function getDefaultCardsBulkDescriptor(): Promise<ScryfallBulkDataDescriptor> {
  if (defaultCardsBulkDescriptorCache) return defaultCardsBulkDescriptorCache;

  const readStoredDescriptor = (): ScryfallBulkDataDescriptor | null => {
    try {
      if (typeof window === "undefined") return null;
      const raw = window.localStorage.getItem(BULK_DESCRIPTOR_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ScryfallBulkDataDescriptor;
      return parsed.download_uri || parsed.jsonl_download_uri ? parsed : null;
    } catch {
      return null;
    }
  };

  const storeDescriptor = (descriptor: ScryfallBulkDataDescriptor) => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(BULK_DESCRIPTOR_STORAGE_KEY, JSON.stringify(descriptor));
      }
    } catch {
      // localStorage kann z. B. im privaten Modus gesperrt sein. Das ist unkritisch.
    }
  };

  let lastError: unknown = null;

  // Wichtig: Der Bulk-Descriptor läuft bewusst NICHT über getJson().
  // Damit kann ein früherer API-Circuit-Breaker aus normalen Kartenabfragen
  // keinen großen Bulk-Import blockieren. Es ist genau eine kleine API-Abfrage.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API}/bulk-data/default-cards`, {
        headers: { Accept: "application/json;q=0.9,*/*;q=0.8" },
        cache: attempt === 0 ? "default" : "no-store"
      });

      if (response.ok) {
        const descriptor = await response.json() as ScryfallBulkDataDescriptor;
        if (!descriptor.download_uri && !descriptor.jsonl_download_uri) {
          throw new Error("Scryfall Bulk Data stellt aktuell keine Download-URL bereit.");
        }
        defaultCardsBulkDescriptorCache = descriptor;
        storeDescriptor(descriptor);
        return descriptor;
      }

      lastError = new Error(`Scryfall Bulk-Descriptor konnte nicht geladen werden (${response.status}).`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 2) await sleep(600 * (attempt + 1));
  }

  // Falls api.scryfall.com vorübergehend blockiert/gestört ist, darf ein bereits
  // erfolgreich gespeicherter statischer Bulk-Link weiterverwendet werden.
  const stored = readStoredDescriptor();
  if (stored) {
    defaultCardsBulkDescriptorCache = stored;
    return stored;
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`Scryfall Bulk Data konnte nicht vorbereitet werden.${detail}`);
}

function rememberBulkCard(card: ScryfallCard): void {
  rawCardCache.set(card.id, card);
  collectorCardCache.set(collectorLookupKey(card.set, card.collector_number), card);
  cache.set(card.id, normalizeCard(card));
}

type BulkCardConsumer = (card: ScryfallCard) => void;

type BulkScanResult = {
  scannedRecords: number;
};

const BULK_MIN_EXPECTED_RECORDS = 50_000;
const BULK_DOWNLOAD_ATTEMPTS = 3;

async function consumeJsonlBulkResponse(
  response: Response,
  url: string,
  consume: BulkCardConsumer,
  onScanProgress?: (scannedRecords: number) => void
): Promise<BulkScanResult> {
  if (!response.body) {
    throw new Error("Scryfall Bulk Data konnte nicht als Datenstrom gelesen werden.");
  }

  let stream: ReadableStream<Uint8Array> = response.body;
  const contentEncoding = (response.headers.get("Content-Encoding") ?? "").toLowerCase();
  const looksGzipped = /\.gz(?:$|\?)/i.test(url);

  // Browser dekomprimieren Content-Encoding:gzip normalerweise selbst. Nur wenn
  // eine rohe .gz-Datei ohne Content-Encoding ausgeliefert wird, entpacken wir
  // explizit. Der Cast überbrückt nur die DOM-Typdefinition BufferSource/Uint8Array.
  if (looksGzipped && !contentEncoding.includes("gzip")) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("Dieser Browser kann die komprimierten Scryfall Bulk Data nicht lesen.");
    }
    const gzipDecompressor = new DecompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >;
    stream = stream.pipeThrough(gzipDecompressor);
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scannedRecords = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        let card: ScryfallCard;
        try {
          card = JSON.parse(line) as ScryfallCard;
        } catch {
          throw new Error(
            `Scryfall Bulk Data ist unvollständig oder beschädigt (JSONL-Datensatz ${scannedRecords + 1}).`
          );
        }
        consume(card);
        scannedRecords += 1;
        if (scannedRecords % 2_000 === 0) onScanProgress?.(scannedRecords);
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  const finalLine = buffer.trim();
  if (finalLine) {
    let card: ScryfallCard;
    try {
      card = JSON.parse(finalLine) as ScryfallCard;
    } catch {
      throw new Error("Scryfall Bulk Data endete mit einem unvollständigen JSONL-Datensatz.");
    }
    consume(card);
    scannedRecords += 1;
  }

  onScanProgress?.(scannedRecords);
  return { scannedRecords };
}

async function consumeLegacyJsonBulkResponse(
  response: Response,
  consume: BulkCardConsumer,
  onScanProgress?: (scannedRecords: number) => void
): Promise<BulkScanResult> {
  if (!response.body) {
    throw new Error("Scryfall Bulk Data konnte nicht als Datenstrom gelesen werden.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let scannedRecords = 0;
  let startedArray = false;
  let endedArray = false;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let objectBuffer = "";

  const consumeText = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];

      if (objectDepth === 0) {
        if (!startedArray) {
          if (/\s/.test(char)) continue;
          if (char !== "[") {
            throw new Error("Scryfall Bulk Data hat ein unerwartetes Format.");
          }
          startedArray = true;
          continue;
        }

        if (/\s/.test(char) || char === ",") continue;
        if (char === "]") {
          endedArray = true;
          continue;
        }
        if (char !== "{") {
          throw new Error("Scryfall Bulk Data enthält einen ungültigen Datensatz.");
        }

        objectDepth = 1;
        objectBuffer = "{";
        inString = false;
        escaped = false;
        continue;
      }

      objectBuffer += char;

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        objectDepth += 1;
      } else if (char === "}") {
        objectDepth -= 1;
        if (objectDepth === 0) {
          let card: ScryfallCard;
          try {
            card = JSON.parse(objectBuffer) as ScryfallCard;
          } catch {
            throw new Error(
              `Scryfall Bulk Data ist unvollständig oder beschädigt (Datensatz ${scannedRecords + 1}).`
            );
          }
          consume(card);
          scannedRecords += 1;
          objectBuffer = "";
          if (scannedRecords % 2_000 === 0) onScanProgress?.(scannedRecords);
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consumeText(decoder.decode(value, { stream: true }));
  }
  consumeText(decoder.decode());

  if (!startedArray || !endedArray || objectDepth !== 0 || objectBuffer) {
    throw new Error("Scryfall Bulk Data endete unvollständig.");
  }

  onScanProgress?.(scannedRecords);
  return { scannedRecords };
}

function validateBulkScan(scannedRecords: number): void {
  // default_cards enthält weit mehr als 50.000 Druckversionen. Ein deutlich
  // kleinerer Wert bedeutet praktisch immer einen abgebrochenen/gekürzten
  // Download. Solche Teilergebnisse dürfen niemals als Importresultat gelten.
  if (scannedRecords < BULK_MIN_EXPECTED_RECORDS) {
    throw new Error(
      `Scryfall Bulk Data wurde nicht vollständig geladen (${scannedRecords.toLocaleString("de-DE")} Datensätze).`
    );
  }
}

export async function resolveCardsFromDefaultBulkData(
  identifiers: BulkImportLookupIdentifier[],
  onProgress?: (processed: number, total: number, label: string) => void,
  mode: ImportMatchMode = "collection"
): Promise<BulkImportLookupResult> {
  const totalRows = identifiers.length;
  const copyCountByIndex = new Map(
    identifiers.map(identifier => [identifier.index, Math.max(1, Math.trunc(Number(identifier.count) || 1))] as const)
  );
  const totalCopies = identifiers.reduce(
    (sum, identifier) => sum + (copyCountByIndex.get(identifier.index) ?? 1),
    0
  );
  if (totalRows === 0) return { cardsByIndex: new Map(), notFoundIndexes: [], ambiguousIndexes: [] };

  // Die Eingabe wird einmal deterministisch indexiert. Für Bulk-Importe wird
  // bewusst NICHT aus collectorCardCache vorgeladen: Ein alter oder nur
  // teilweise gefüllter Session-Cache darf das Ergebnis nicht beeinflussen.
  // Pro Schlüssel werden während des Laufs ALLE Kandidaten gesammelt; entschieden
  // wird erst nach der vollständigen Validierung (siehe decidePrinting).
  type RowKeys = {
    exactRaw?: string;
    exactNormalized?: string;
    nameCollector: string[];
    setName: string[];
    name: string[];
  };

  const keysByIndex = new Map<number, RowKeys>();
  const wanted = new Map<string, number[]>();
  const want = (key: string, index: number) => {
    const indexes = wanted.get(key) ?? [];
    indexes.push(index);
    wanted.set(key, indexes);
  };

  for (const identifier of identifiers) {
    const setToken = identifier.set ? normalizeSetToken(identifier.set) : "";
    const collector = identifier.collectorNumber?.trim() ?? "";
    const names = cardNameKeys(identifier.name);
    const keys: RowKeys = { nameCollector: [], setName: [], name: [] };

    if (setToken && collector) {
      keys.exactRaw = `x|${setToken}|${rawCollectorNumber(collector)}`;
      keys.exactNormalized = `n|${setToken}|${normalizeCollectorNumber(collector)}`;
      want(keys.exactRaw, identifier.index);
      want(keys.exactNormalized, identifier.index);
    }
    if (collector) {
      keys.nameCollector = names.map(name => `c|${name}|${normalizeCollectorNumber(collector)}`);
    }
    if (setToken) {
      keys.setName = names.map(name => `s|${setToken}|${name}`);
    }
    keys.name = names.map(name => `m|${name}`);

    for (const key of [...keys.nameCollector, ...keys.setName, ...keys.name]) {
      want(key, identifier.index);
    }
    keysByIndex.set(identifier.index, keys);
  }

  const descriptor = await getDefaultCardsBulkDescriptor();
  const canStreamGzip = typeof DecompressionStream !== "undefined";
  const url = canStreamGzip && descriptor.jsonl_download_uri
    ? descriptor.jsonl_download_uri
    : descriptor.download_uri ?? descriptor.jsonl_download_uri;

  if (!url) {
    throw new Error("Scryfall Bulk Data konnte nicht geladen werden.");
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= BULK_DOWNLOAD_ATTEMPTS; attempt += 1) {
    // Jeder Versuch arbeitet ausschließlich in lokalen Maps. Erst wenn der
    // KOMPLETTE Bulk-Datensatz erfolgreich gelesen und validiert wurde, werden
    // Treffer veröffentlicht bzw. in globale Caches übernommen.
    const candidates = new Map<string, Map<string, ScryfallCard>>();
    let matchedCopies = 0;
    const matchedIndexes = new Set<number>();

    const collect = (key: string, card: ScryfallCard) => {
      const targets = wanted.get(key);
      if (!targets) return;
      const bucket = candidates.get(key) ?? new Map<string, ScryfallCard>();
      bucket.set(card.id, card);
      candidates.set(key, bucket);
      for (const index of targets) {
        if (matchedIndexes.has(index)) continue;
        matchedIndexes.add(index);
        matchedCopies += copyCountByIndex.get(index) ?? 1;
      }
    };

    try {
      onProgress?.(
        0,
        totalCopies,
        attempt === 1
          ? "Scryfall Bulk Data wird vollständig geladen…"
          : `Scryfall Bulk Data wird erneut vollständig geladen (${attempt}/${BULK_DOWNLOAD_ATTEMPTS})…`
      );

      const response = await fetch(url, {
        headers: { Accept: "application/json;q=0.9,*/*;q=0.8" },
        cache: attempt === 1 ? "default" : "reload"
      });

      if (!response.ok) {
        throw new Error(`Scryfall Bulk Data konnte nicht geladen werden (${response.status}).`);
      }

      const consume = (card: ScryfallCard) => {
        const setTokens = Array.from(new Set([
          normalizeSetToken(card.set),
          ...(card.set_name ? [normalizeSetToken(card.set_name)] : [])
        ]));
        const raw = rawCollectorNumber(card.collector_number);
        const normalized = normalizeCollectorNumber(card.collector_number);
        const names = cardNameKeys(card.name);

        for (const setToken of setTokens) {
          collect(`x|${setToken}|${raw}`, card);
          collect(`n|${setToken}|${normalized}`, card);
          for (const name of names) collect(`s|${setToken}|${name}`, card);
        }
        for (const name of names) {
          collect(`c|${name}|${normalized}`, card);
          collect(`m|${name}`, card);
        }
      };

      const scanProgress = () => {
        onProgress?.(
          Math.min(totalCopies, matchedCopies),
          totalCopies,
          "Scryfall Bulk Data wird durchsucht…"
        );
      };

      const isJsonl = /\.jsonl(?:\.gz)?(?:$|\?)/i.test(url) ||
        Boolean(descriptor.jsonl_download_uri && url === descriptor.jsonl_download_uri);
      const scan = isJsonl
        ? await consumeJsonlBulkResponse(response, url, consume, scanProgress)
        : await consumeLegacyJsonBulkResponse(response, consume, scanProgress);

      validateBulkScan(scan.scannedRecords);

      // Erst NACH vollständiger Validierung wird das Ergebnis aufgebaut.
      const cardsFor = (keys: string[] | string | undefined): ScryfallCard[] => {
        const list = keys === undefined ? [] : Array.isArray(keys) ? keys : [keys];
        return list.flatMap(key => [...(candidates.get(key)?.values() ?? [])]);
      };

      const cardsByIndex = new Map<number, ScryfallCard>();
      const notFoundIndexes: number[] = [];
      const ambiguousIndexes: number[] = [];

      for (const identifier of identifiers) {
        const keys = keysByIndex.get(identifier.index)!;
        const decision = decidePrinting(
          identifier.name,
          {
            exactRaw: cardsFor(keys.exactRaw),
            exactNormalized: cardsFor(keys.exactNormalized),
            nameCollector: cardsFor(keys.nameCollector),
            setName: cardsFor(keys.setName),
            name: cardsFor(keys.name)
          },
          mode
        );

        if (decision.status === "resolved") cardsByIndex.set(identifier.index, decision.card);
        else if (decision.status === "ambiguous") ambiguousIndexes.push(identifier.index);
        else notFoundIndexes.push(identifier.index);
      }

      // Atomarer Cache-Commit: unvollständige Versuche hinterlassen keinerlei
      // Treffer, die einen späteren Lauf beeinflussen könnten.
      for (const card of new Map(
        [...cardsByIndex.values()].map(card => [card.id, card] as const)
      ).values()) {
        rememberBulkCard(card);
      }

      onProgress?.(
        totalCopies,
        totalCopies,
        "Alle Karten wurden mit Scryfall Bulk Data geprüft."
      );

      return { cardsByIndex, notFoundIndexes, ambiguousIndexes };
    } catch (error) {
      lastError = error;
      if (attempt < BULK_DOWNLOAD_ATTEMPTS) {
        await sleep(750 * attempt);
      }
    }
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(
    `Scryfall Bulk Data konnte nach ${BULK_DOWNLOAD_ATTEMPTS} vollständigen Versuchen nicht verlässlich verarbeitet werden.${detail}`
  );
}

export async function getCardBySetAndCollectorNumber(
  setCode: string,
  collectorNumber: string
): Promise<ScryfallCard | null> {
  const cleanSet = setCode.trim().toLowerCase();
  const cleanNumber = collectorNumber.trim();

  if (!cleanSet || !cleanNumber) return null;

  const key = collectorLookupKey(cleanSet, cleanNumber);
  const exactCached = collectorCardCache.get(key);
  if (exactCached) return exactCached;

  for (const cached of rawCardCache.values()) {
    if (
      cached.set.toLowerCase() === cleanSet &&
      cached.collector_number.toLowerCase() === cleanNumber.toLowerCase()
    ) {
      collectorCardCache.set(key, cached);
      return cached;
    }
  }

  try {
    const card = await getJson<ScryfallCard>(
      `${API}/cards/${encodeURIComponent(cleanSet)}/${encodeURIComponent(cleanNumber)}`
    );

    rawCardCache.set(card.id, card);
    collectorCardCache.set(collectorLookupKey(card.set, card.collector_number), card);
    cache.set(card.id, normalizeCard(card));
    return card;
  } catch (error) {
    if (error instanceof Error && /Scryfall-Fehler 404/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function getCardsBySetAndCollectorNumbers(
  setCode: string,
  collectorNumbers: string[],
  onProgress?: (processed: number, total: number) => void
): Promise<CollectorNumberLookupResult> {
  const cleanSet = setCode.trim().toLowerCase();
  const uniqueNumbers = Array.from(
    new Set(
      collectorNumbers
        .map(number => number.trim())
        .filter(Boolean)
    )
  );

  if (!cleanSet || uniqueNumbers.length === 0) {
    onProgress?.(0, 0);
    return { cards: [], notFound: [], temporaryFailures: [] };
  }

  const cardsByNumber = new Map<string, ScryfallCard>();
  const temporaryFailures = new Set<string>();
  const pending: string[] = [];

  for (const collectorNumber of uniqueNumbers) {
    const key = collectorLookupKey(cleanSet, collectorNumber);
    const cached = collectorCardCache.get(key);
    if (cached) cardsByNumber.set(collectorNumber.toLowerCase(), cached);
    else pending.push(collectorNumber);
  }

  let processed = uniqueNumbers.length - pending.length;
  onProgress?.(processed, uniqueNumbers.length);

  // Große Imports werden über GET-Suchanfragen gebündelt. Damit werden nicht
  // tausende Einzelrequests erzeugt, gleichzeitig bleibt der Browserpfad frei
  // von dem CORS/Preflight-Problem des POST-/cards/collection-Endpunkts.
  const BATCH_SIZE = 25;

  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE);
    const batchSet = new Set(batch.map(number => number.toLowerCase()));
    let batchCards: ScryfallCard[] = [];
    let batchSearchFailed = false;
    let batchTemporaryFailure = false;

    try {
      const collectorQuery = batch
        .map(number => `cn:"${escapeScryfallSearchValue(number)}"`)
        .join(" OR ");
      const params = new URLSearchParams({
        q: `set:${cleanSet} (${collectorQuery})`,
        unique: "prints",
        order: "set",
        include_extras: "true"
      });

      const result = await getJson<SearchResponse>(
        `${API}/cards/search?${params.toString()}`
      );
      batchCards = result.data;
    } catch (error) {
      // Eine leere Scryfall-Suche liefert 404 und darf exakt nachgeprüft werden.
      // Ein echter Netzwerk-/Rate-Limit-/5xx-Ausfall wird dagegen nicht mit bis
      // zu 25 weiteren Einzelrequests verschärft, sondern transparent als
      // temporär ungeprüft zurückgegeben.
      if (isTemporaryScryfallError(error)) {
        batchTemporaryFailure = true;
        console.warn("Scryfall batch lookup temporarily unavailable", error);
      } else {
        batchSearchFailed = true;
        if (!(error instanceof Error && /Scryfall-Fehler 404/.test(error.message))) {
          console.warn("Scryfall batch lookup failed, falling back to exact GETs", error);
        }
      }
    }

    for (const card of batchCards) {
      const number = card.collector_number.trim().toLowerCase();
      if (card.set.toLowerCase() !== cleanSet || !batchSet.has(number)) continue;

      rawCardCache.set(card.id, card);
      collectorCardCache.set(collectorLookupKey(card.set, card.collector_number), card);
      cache.set(card.id, normalizeCard(card));
      cardsByNumber.set(number, card);
    }

    const missing = batch.filter(
      number => !cardsByNumber.has(number.toLowerCase())
    );

    // Bei einer echten Scryfall-Störung werden die fehlenden Karten als
    // technisch ungeprüft markiert. Das vermeidet tausende zusätzliche Requests
    // und verhindert, dass ein Netzwerkfehler wie ein inhaltlicher Fehler wirkt.
    if (batchTemporaryFailure) {
      for (const collectorNumber of missing) {
        temporaryFailures.add(collectorNumber.toLowerCase());
      }
    } else if (batchSearchFailed || missing.length > 0) {
      // Einzelne Sonderdrucke (z. B. Extras/Rebalanced) können von der Suche
      // ausgeschlossen sein. Nur diese fehlenden Nummern werden exakt abgefragt.
      for (const collectorNumber of missing) {
        try {
          const card = await getCardBySetAndCollectorNumber(cleanSet, collectorNumber);
          if (card) cardsByNumber.set(collectorNumber.toLowerCase(), card);
        } catch (error) {
          // Ein einzelner nach mehreren Retries fehlgeschlagener Request darf
          // einen großen Import nicht komplett verwerfen. Wir kennzeichnen die
          // Druckversion als temporär ungeprüft und lassen den Dialog einen
          // erneuten Prüflauf anbieten.
          console.warn(
            `Scryfall exact lookup failed for ${cleanSet} #${collectorNumber}`,
            error
          );
          temporaryFailures.add(collectorNumber.toLowerCase());
        }
      }
    }

    processed += batch.length;
    onProgress?.(Math.min(processed, uniqueNumbers.length), uniqueNumbers.length);
  }

  const cards: ScryfallCard[] = [];
  const notFound: string[] = [];
  const failed: string[] = [];

  for (const collectorNumber of uniqueNumbers) {
    const normalizedNumber = collectorNumber.toLowerCase();
    const card = cardsByNumber.get(normalizedNumber);
    if (card) cards.push(card);
    else if (temporaryFailures.has(normalizedNumber)) failed.push(collectorNumber);
    else notFound.push(collectorNumber);
  }

  return { cards, notFound, temporaryFailures: failed };
}

export async function getPrintings(
  card: ScryfallCard
): Promise<ScryfallCard[]> {
  const cacheKey = card.oracle_id ?? card.name.toLowerCase();
  const cached = printingsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  if (!card.prints_search_uri) {
    return [card];
  }

  const cards: ScryfallCard[] = [];
  let nextUrl: string | undefined = card.prints_search_uri;

  while (nextUrl) {
    const result: SearchResponse =
      await getJson<SearchResponse>(
        nextUrl
      );

    cards.push(...result.data);

    nextUrl =
      result.has_more && result.next_page
        ? result.next_page
        : undefined;
  }

  const sorted = cards.sort((a, b) => {
    const setCompare = (a.set_name ?? a.set).localeCompare(
      b.set_name ?? b.set
    );

    if (setCompare !== 0) {
      return setCompare;
    }

    return a.collector_number.localeCompare(
      b.collector_number,
      undefined,
      { numeric: true }
    );
  });

  printingsCache.set(cacheKey, sorted);

  sorted.forEach(card => {
    rawCardCache.set(card.id, card);
    cache.set(card.id, normalizeCard(card));
  });

  return sorted;
}

// Originales englisches Scryfall-Autocomplete.
export async function autocomplete(
  query: string
): Promise<string[]> {
  if (!query.trim()) {
    return [];
  }

  const result = await getJson<{ data: string[] }>(
    `${API}/cards/autocomplete?q=${encodeURIComponent(query.trim())}`
  );

  return result.data.slice(0, 8);
}

// Bleibt nur als Kompatibilitäts-Export für die aktuelle App.tsx bestehen.
export async function getCardByFuzzyName(
  name: string
): Promise<ScryfallCard | null> {
  const clean = name.trim();
  if (!clean) return null;

  const params = new URLSearchParams({ fuzzy: clean });

  try {
    const card = await getJson<ScryfallCard>(
      `${API}/cards/named?${params.toString()}`
    );
    rawCardCache.set(card.id, card);
    cache.set(card.id, normalizeCard(card));
    return card;
  } catch (error) {
    if (error instanceof Error && /Scryfall-Fehler 404/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

export async function canonicalEnglishCard(
  card: ScryfallCard
): Promise<ScryfallCard> {
  return card;
}

export async function getScryfallCard(
  id: string
): Promise<ScryfallCard> {
  const rawHit = rawCardCache.get(id);

  if (rawHit) {
    return rawHit;
  }

  const card = await getJson<ScryfallCard>(
    `${API}/cards/${encodeURIComponent(id)}`
  );

  rawCardCache.set(card.id, card);
  cache.set(card.id, normalizeCard(card));

  return card;
}

export async function getCards(
  ids: string[]
): Promise<CardRecord[]> {
  const uniqueIds =
    Array.from(
      new Set(
        ids.filter(Boolean)
      )
    );

  if (uniqueIds.length === 0) {
    return [];
  }

  const result:
    CardRecord[] = [];

  for (
    let index = 0;
    index < uniqueIds.length;
    index += 75
  ) {
    const batch =
      uniqueIds.slice(
        index,
        index + 75
      );

    const response =
      await postJson<CollectionResponse>(
        `${API}/cards/collection`,
        {
          identifiers:
            batch.map(
              id => ({
                id
              })
            )
        }
      );

    for (
      const card
      of response.data
    ) {
      const normalized =
        normalizeCard(card);

      cache.set(
        card.id,
        normalized
      );

      result.push(
        normalized
      );
    }
  }

  return result;
}

export async function getCard(
  id: string
): Promise<CardRecord> {
  const hit = cache.get(id);

  if (hit) {
    return hit;
  }

  const card = await getScryfallCard(id);
  const normalized = normalizeCard(card);
  cache.set(id, normalized);

  return normalized;
}

export function scryfallUrl(id: string) {
  return `https://scryfall.com/card/${id}`;
}

/**
 * Lädt exakte Druckversionen über ihre Scryfall-IDs (Collection-Endpoint, 75 pro Anfrage).
 * Nicht gefundene IDs werden zurückgemeldet und niemals durch Namenssuche ersetzt.
 */
export async function getScryfallCardsByIds(
  ids: string[],
  onProgress?: (processed: number, total: number) => void
): Promise<{ cards: ScryfallCard[]; notFound: string[] }> {
  const uniqueIds = Array.from(new Set(ids.map(id => id.trim().toLowerCase()).filter(Boolean)));
  const cards: ScryfallCard[] = [];
  const found = new Set<string>();

  onProgress?.(0, uniqueIds.length);

  for (let index = 0; index < uniqueIds.length; index += 75) {
    const batch = uniqueIds.slice(index, index + 75);
    const response = await postJson<CollectionResponse>(
      `${API}/cards/collection`,
      { identifiers: batch.map(id => ({ id })) }
    );

    for (const card of response.data) {
      cards.push(card);
      found.add(card.id.toLowerCase());
      cache.set(card.id, normalizeCard(card));
    }

    onProgress?.(Math.min(uniqueIds.length, index + batch.length), uniqueIds.length);
  }

  return {
    cards,
    notFound: uniqueIds.filter(id => !found.has(id))
  };
}
