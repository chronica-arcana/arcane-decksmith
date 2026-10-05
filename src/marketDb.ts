import { BATCH_SIZE, cleanRecord, fetchAllRows, throwIfError, withRetry } from "./db";
import { supabase } from "./supabase";
import type { MarketListing } from "./marketplace";

export const MARKET_PAGE_SIZE = 48;

/** Löschen filtert per URL (`id=in.(…)`); kleine Blöcke halten die URL kurz. */
const DELETE_CHUNK = 40;

/** Der Marketplace braucht die Datenbank. Im lokalen Demo-Modus gibt es ihn nicht. */
export const marketplaceSupported = Boolean(supabase);

/** Undurchsichtige Position für „Mehr laden“ (Offset in der sortierten Ergebnisliste). */
export type MarketCursor = { offset: number };

export interface MarketPage {
  listings: MarketListing[];
  cursor: MarketCursor | null;
  hasMore: boolean;
}

type ListingRow = { id: string; data: Omit<MarketListing, "id"> };

function requireClient() {
  if (!supabase) {
    throw new Error("Der Marketplace benötigt ein Konto. Im lokalen Demo-Modus ist er nicht verfügbar.");
  }
  return supabase;
}

function asListing(row: ListingRow): MarketListing {
  return { ...row.data, id: row.id };
}

/** Alle eigenen Angebote. */
export async function loadMyListings(uid: string): Promise<MarketListing[]> {
  const client = requireClient();
  const rows = await fetchAllRows<ListingRow>((from, to) =>
    client.from("market_listings").select("id,data").eq("owner_id", uid).order("id").range(from, to)
  );
  return rows.map(asListing).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

/** Escaped `%`, `_` und `\` für LIKE-Muster. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Lädt eine Seite Angebote. Ohne Suche: neueste zuerst. Mit Suche: Namensanfang
 * ("sol" findet "Sol Ring", nicht "Mana Sol").
 */
export async function loadMarketPage(options: {
  search?: string;
  cursor?: MarketCursor | null;
  pageSize?: number;
} = {}): Promise<MarketPage> {
  const client = requireClient();
  const pageSize = options.pageSize ?? MARKET_PAGE_SIZE;
  const search = (options.search ?? "").trim().toLowerCase();
  const offset = options.cursor?.offset ?? 0;

  let request = client.from("market_listings").select("id,data");
  request = search
    ? request.like("name_lower", `${escapeLike(search)}%`).order("name_lower").order("id")
    : request.order("updated_at_ms", { ascending: false }).order("id");

  // Eine Zeile mehr laden, um zu wissen, ob es weitere Seiten gibt.
  const { data, error } = await request.range(offset, offset + pageSize);
  throwIfError(error);

  const rows = ((data ?? []) as ListingRow[]).slice(0, pageSize);
  return {
    listings: rows.map(asListing),
    cursor: rows.length > 0 ? { offset: offset + rows.length } : null,
    hasMore: (data ?? []).length > pageSize
  };
}

/** Schreibt Angebote gebündelt (Upsert-Batches mit Retry). */
export async function saveListings(listings: MarketListing[]): Promise<void> {
  if (listings.length === 0) return;
  const client = requireClient();

  for (let start = 0; start < listings.length; start += BATCH_SIZE) {
    const chunk = listings.slice(start, start + BATCH_SIZE);
    await withRetry(async () => {
      const rows = chunk.map((listing) => {
        const { id, ...data } = cleanRecord(listing);
        return { id, owner_id: listing.ownerId, data };
      });
      const { error } = await client.from("market_listings").upsert(rows, { onConflict: "id" });
      throwIfError(error);
    });
  }
}

export async function removeListings(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const client = requireClient();

  for (let start = 0; start < ids.length; start += DELETE_CHUNK) {
    const chunk = ids.slice(start, start + DELETE_CHUNK);
    await withRetry(async () => {
      const { error } = await client.from("market_listings").delete().in("id", chunk);
      throwIfError(error);
    });
  }
}

export async function removeListing(id: string): Promise<void> {
  const { error } = await requireClient().from("market_listings").delete().eq("id", id);
  throwIfError(error);
}

/** Anzeigename aus dem eigenen Profil (nur für den Besitzer lesbar). */
export async function loadDisplayName(uid: string): Promise<string> {
  const { data, error } = await requireClient()
    .from("profiles")
    .select("display_name")
    .eq("user_id", uid)
    .maybeSingle();
  throwIfError(error);
  return typeof data?.display_name === "string" ? data.display_name : "";
}

export async function saveDisplayName(uid: string, displayName: string): Promise<void> {
  const { error } = await requireClient()
    .from("profiles")
    .upsert({ user_id: uid, display_name: displayName, updated_at: Date.now() }, { onConflict: "user_id" });
  throwIfError(error);
}
