import { supabase } from "./supabase";
import type { CardRecord, DeckRecord } from "./types";

/** Datensätze pro Schreibanfrage (Upsert); hält die Request-Größe für PostgREST moderat. */
export const BATCH_SIZE = 200;
/** Zeilen pro Leseanfrage: PostgREST liefert standardmäßig höchstens 1000 Zeilen. */
const PAGE_SIZE = 1000;
const BATCH_RETRIES = 3;

function requireClient() {
  if (!supabase) throw new Error("Supabase ist nicht konfiguriert.");
  return supabase;
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
  const client = requireClient();
  const rows = await fetchAllRows<{ data: CardRecord }>((from, to) =>
    client.from("collection_cards").select("data").eq("user_id", uid).order("card_id").range(from, to)
  );
  return rows.map((row) => row.data).sort(compareByName);
}

export async function saveCard(uid: string, card: CardRecord) {
  // Vollständiges Überschreiben der jsonb-Spalte: entfernte optionale Felder (z. B. Kommentar)
  // dürfen nicht erhalten bleiben, sonst weicht der lokale State vom Server ab.
  const { error } = await requireClient()
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

  const client = requireClient();
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
  const { error } = await requireClient().from("collection_cards").delete().eq("user_id", uid).eq("card_id", id);
  throwIfError(error);
}

export async function loadDecks(uid: string): Promise<DeckRecord[]> {
  const client = requireClient();
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
  const { error } = await requireClient()
    .from("decks")
    .upsert({ user_id: uid, deck_id: deck.id, data: cleanRecord(deck) }, { onConflict: "user_id,deck_id" });
  throwIfError(error);
}

export async function removeDeck(uid: string, id: string) {
  const { error } = await requireClient().from("decks").delete().eq("user_id", uid).eq("deck_id", id);
  throwIfError(error);
}

export async function ensureProfile(uid: string, email?: string) {
  if (!supabase) return;
  // Nur die übergebenen Spalten werden aktualisiert; display_name bleibt erhalten.
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: uid, email: email ?? "", updated_at: Date.now() }, { onConflict: "user_id" });
  throwIfError(error);
}
