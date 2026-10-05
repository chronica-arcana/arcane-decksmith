import { supabase } from "./supabase";
import type { CardRecord, DeckRecord } from "./types";

const key = (uid: string, suffix: string) => `arcane-decksmith:${uid}:${suffix}`;

/** Datensätze pro Schreibanfrage (Upsert); hält die Request-Größe für PostgREST moderat. */
export const BATCH_SIZE = 200;
/** Zeilen pro Leseanfrage: PostgREST liefert standardmäßig höchstens 1000 Zeilen. */
const PAGE_SIZE = 1000;
const BATCH_RETRIES = 3;

function localGet<T>(k: string): T[] {
  try { return JSON.parse(localStorage.getItem(k) ?? "[]") as T[]; } catch { return []; }
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

function localSet<T>(k: string, value: T[]) {
  try {
    localStorage.setItem(k, JSON.stringify(value));
  } catch (error) {
    if (isQuotaError(error)) {
      throw new Error(
        "Der lokale Browserspeicher ist voll. Im Demo-Modus können keine weiteren Daten gespeichert werden – " +
        "bitte einzelne Karten/Decks löschen oder mit einem Konto anmelden."
      );
    }
    throw new Error(
      `Lokaler Speicher nicht verfügbar: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Entfernt `undefined`-Werte, damit nur gültiges JSON in die jsonb-Spalten geschrieben wird. */
export function cleanRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Wandelt einen Supabase-Fehler in einen normalen Error (Supabase wirft nicht selbst). */
export function throwIfError(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

/** Liest alle Zeilen seitenweise (PostgREST begrenzt eine Antwort auf 1000 Zeilen). */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1);
    throwIfError(error);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Sortierung nach Name (Codepoint-Vergleich), unabhängig von der Datenbank-Collation. */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function loadCollection(uid: string): Promise<CardRecord[]> {
  if (!supabase) return localGet<CardRecord>(key(uid, "collection")).sort(compareByName);
  const client = supabase;
  const rows = await fetchAllRows<{ data: CardRecord }>((from, to) =>
    client.from("collection_cards").select("data").eq("user_id", uid).order("card_id").range(from, to)
  );
  return rows.map((row) => row.data).sort(compareByName);
}

export async function saveCard(uid: string, card: CardRecord) {
  if (!supabase) {
    const all = localGet<CardRecord>(key(uid, "collection"));
    const i = all.findIndex((c) => c.id === card.id);
    if (i >= 0) all[i] = card; else all.push(card);
    localSet(key(uid, "collection"), all);
    return;
  }
  // Vollständiges Überschreiben der jsonb-Spalte: entfernte optionale Felder (z. B. Kommentar)
  // dürfen nicht erhalten bleiben, sonst weicht der lokale State vom Server ab.
  const { error } = await supabase
    .from("collection_cards")
    .upsert({ user_id: uid, card_id: card.id, data: cleanRecord(card) }, { onConflict: "user_id,card_id" });
  throwIfError(error);
}

export type BatchProgress = (saved: number, total: number) => void;

export async function withRetry<T>(run: () => Promise<T>, retries = BATCH_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Speichert viele Karten in Upsert-Batches (je `BATCH_SIZE` Karten, atomar) mit Retry pro Batch.
 * Bei einem endgültig fehlgeschlagenen Batch wird abgebrochen und ein Fehler mit der
 * Anzahl der bereits gespeicherten Karten geworfen. Liefert die gespeicherten Karten.
 */
export async function saveCardsBatch(
  uid: string,
  cards: CardRecord[],
  onProgress?: BatchProgress
): Promise<CardRecord[]> {
  if (cards.length === 0) return [];

  if (!supabase) {
    const all = localGet<CardRecord>(key(uid, "collection"));
    const index = new Map(all.map((card, i) => [card.id, i] as const));
    for (const card of cards) {
      const i = index.get(card.id);
      if (i !== undefined) all[i] = card;
      else {
        index.set(card.id, all.length);
        all.push(card);
      }
    }
    localSet(key(uid, "collection"), all);
    onProgress?.(cards.length, cards.length);
    return cards;
  }

  const client = supabase;
  let saved = 0;
  onProgress?.(0, cards.length);

  for (let start = 0; start < cards.length; start += BATCH_SIZE) {
    const chunk = cards.slice(start, start + BATCH_SIZE);
    try {
      await withRetry(async () => {
        const rows = chunk.map((card) => ({ user_id: uid, card_id: card.id, data: cleanRecord(card) }));
        const { error } = await client.from("collection_cards").upsert(rows, { onConflict: "user_id,card_id" });
        throwIfError(error);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PartialSaveError(
        `Nur ${saved} von ${cards.length} Karten gespeichert. Die übrigen ${cards.length - saved} ` +
        `konnten nicht gespeichert werden: ${reason}`,
        cards.slice(0, saved)
      );
    }
    saved += chunk.length;
    onProgress?.(saved, cards.length);
  }

  return cards;
}

/** Fehler bei teilweise gespeicherten Batches; `saved` enthält die erfolgreich geschriebenen Karten. */
export class PartialSaveError extends Error {
  readonly saved: CardRecord[];
  constructor(message: string, saved: CardRecord[]) {
    super(message);
    this.name = "PartialSaveError";
    this.saved = saved;
  }
}

export async function removeCard(uid: string, id: string) {
  if (!supabase) {
    localSet(key(uid, "collection"), localGet<CardRecord>(key(uid, "collection")).filter((c) => c.id !== id));
    return;
  }
  const { error } = await supabase.from("collection_cards").delete().eq("user_id", uid).eq("card_id", id);
  throwIfError(error);
}

export async function loadDecks(uid: string): Promise<DeckRecord[]> {
  if (!supabase) return localGet<DeckRecord>(key(uid, "decks"));
  const client = supabase;
  const rows = await fetchAllRows<{ data: DeckRecord }>((from, to) =>
    client.from("decks").select("data").eq("user_id", uid).order("deck_id").range(from, to)
  );
  return rows.map((row) => row.data).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Ein Deck darf höchstens 1 MiB groß sein (auch als Datenbank-Constraint); mit Puffer prüfen. */
const MAX_DECK_DOCUMENT_BYTES = 900 * 1024;

export function deckDocumentBytes(deck: DeckRecord): number {
  return new TextEncoder().encode(JSON.stringify(deck)).length;
}

export async function saveDeck(uid: string, deck: DeckRecord) {
  const size = deckDocumentBytes(deck);
  if (size > MAX_DECK_DOCUMENT_BYTES) {
    throw new Error(
      `Das Deck ist mit ${Math.round(size / 1024)} KB zu groß zum Speichern ` +
      `(Grenze ca. ${Math.round(MAX_DECK_DOCUMENT_BYTES / 1024)} KB).`
    );
  }
  if (!supabase) {
    const all = localGet<DeckRecord>(key(uid, "decks"));
    const i = all.findIndex((d) => d.id === deck.id);
    if (i >= 0) all[i] = deck; else all.unshift(deck);
    localSet(key(uid, "decks"), all);
    return;
  }
  const { error } = await supabase
    .from("decks")
    .upsert({ user_id: uid, deck_id: deck.id, data: cleanRecord(deck) }, { onConflict: "user_id,deck_id" });
  throwIfError(error);
}

export async function removeDeck(uid: string, id: string) {
  if (!supabase) {
    localSet(key(uid, "decks"), localGet<DeckRecord>(key(uid, "decks")).filter((d) => d.id !== id));
    return;
  }
  const { error } = await supabase.from("decks").delete().eq("user_id", uid).eq("deck_id", id);
  throwIfError(error);
}

/** cyrb53-artiger 2×32-Bit-Hash, stabil und unicode-sicher. */
function hashString(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function legacyDemoUid(email: string): string | undefined {
  try {
    return `demo-${btoa(email).replace(/[^a-z0-9]/gi, "").slice(0, 32)}`;
  } catch {
    // btoa wirft bei Zeichen außerhalb von Latin-1.
    return undefined;
  }
}

function hasLocalData(uid: string): boolean {
  try {
    return localStorage.getItem(key(uid, "collection")) !== null ||
      localStorage.getItem(key(uid, "decks")) !== null;
  } catch {
    return false;
  }
}

export function uidFromEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const uid = `demo-${hashString(normalized)}`;
  // Bestehende Demo-Daten aus der alten (btoa-basierten) Kennung weiterverwenden.
  const legacy = legacyDemoUid(email.toLowerCase());
  if (legacy && !hasLocalData(uid) && hasLocalData(legacy)) return legacy;
  return uid;
}

export async function ensureProfile(uid: string, email?: string) {
  if (!supabase) return;
  // Nur die übergebenen Spalten werden aktualisiert; display_name bleibt erhalten.
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: uid, email: email ?? "", updated_at: Date.now() }, { onConflict: "user_id" });
  throwIfError(error);
}
