import { BATCH_SIZE, cleanRecord, fetchAllRows, throwIfError, withRetry } from "./db";
import { supabase } from "./supabase";
import type { CardRecord, DeckRecord } from "./types";

/**
 * Einmalige Komplett-Übernahme aller Firebase-Daten (Firestore) nach Supabase.
 *
 * Läuft im Browser des Admins:
 *  - Firebase: Zugriff über den Dienstkonto-Schlüssel (JSON) per REST-API. Der Schlüssel
 *    bleibt im Arbeitsspeicher, wird nirgends gespeichert und nur an Google gesendet.
 *  - Supabase: Schreiben mit dem normalen Admin-Login. Das Recht dazu gibt
 *    supabase/migration-tools/01-migration-freigeben.sql vorübergehend frei.
 * Nutzer werden über die E-Mail-Adresse zugeordnet.
 */

export type ServiceAccount = { project_id: string; client_email: string; private_key: string };

export type FirebaseUserData = {
  firebaseUid: string;
  email: string;
  displayName: string;
  cards: CardRecord[];
  decks: DeckRecord[];
  supabaseId?: string;
};

export type FirebaseSnapshot = {
  projectId: string;
  users: FirebaseUserData[];
  listings: Array<{ id: string; data: Record<string, unknown> }>;
  /** true, wenn die E-Mail-Adressen aus der Firebase-Nutzerverwaltung gelesen werden konnten. */
  authListLoaded: boolean;
};

export type FailedItem = { id: string; name: string; reason: string };
/** `found`/`written` zählen Einträge; `copies`/`copiesWritten` die Summe der Exemplare (Feld `count`). */
export type SectionReport = {
  found: number;
  written: number;
  skipped: number;
  failed: FailedItem[];
  copies: number;
  copiesWritten: number;
};
export type UserReport = {
  email: string;
  status: "ok" | "no-account";
  cards: SectionReport;
  decks: SectionReport;
  profileWritten: boolean;
};
export type MigrationReport = { users: UserReport[]; listings: SectionReport };
export type MigrationProgress = { label: string; done: number; total: number };

type Fetch = typeof fetch;

// ---------------------------------------------------------------------------
// Firebase: Dienstkonto, Token, REST
// ---------------------------------------------------------------------------

export function parseServiceAccount(text: string): ServiceAccount {
  let data: Partial<ServiceAccount> & { type?: string };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error("Die Datei ist kein gültiges JSON. Bitte die komplette Schlüssel-Datei (.json) einfügen.");
  }
  if (data.type !== "service_account" || !data.project_id || !data.client_email || !data.private_key) {
    throw new Error(
      "Das ist keine Dienstkonto-Schlüsseldatei (es fehlen project_id, client_email oder private_key)."
    );
  }
  return { project_id: data.project_id, client_email: data.client_email, private_key: data.private_key };
}

function base64Url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Holt ein kurzlebiges Zugriffs-Token (JWT-Bearer-Verfahren von Google). */
export async function getAccessToken(account: ServiceAccount, fetchImpl: Fetch = fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`)
  );

  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${base64Url(signature)}`
    })
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
  if (!response.ok || !body?.access_token) {
    throw new Error(`Google hat die Anmeldung mit dem Schlüssel abgelehnt (${body?.error_description ?? response.status}).`);
  }
  return body.access_token;
}

type FirestoreValue = Record<string, unknown>;

/** Wandelt einen Firestore-REST-Wert in ein normales JavaScript-Objekt um. */
export function decodeValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue === true;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("stringValue" in value) return String(value.stringValue);
  if ("timestampValue" in value) return Date.parse(String(value.timestampValue));
  if ("referenceValue" in value) return String(value.referenceValue);
  if ("bytesValue" in value) return String(value.bytesValue);
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) {
    const values = (value.arrayValue as { values?: FirestoreValue[] }).values ?? [];
    return values.map(decodeValue);
  }
  if ("mapValue" in value) return decodeFields((value.mapValue as { fields?: Record<string, FirestoreValue> }).fields);
  return null;
}

export function decodeFields(fields: Record<string, FirestoreValue> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) result[key] = decodeValue(value);
  return result;
}

type FirestoreDocument = { name: string; fields?: Record<string, FirestoreValue> };

const docId = (document: FirestoreDocument) => decodeURIComponent(document.name.split("/").pop() ?? "");

async function getJson<T>(url: string, token: string, fetchImpl: Fetch): Promise<T> {
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(`Google-API ${response.status}: ${detail?.error?.message ?? response.statusText}`);
  }
  return (await response.json()) as T;
}

async function listDocuments(path: string, token: string, fetchImpl: Fetch, extra = ""): Promise<FirestoreDocument[]> {
  const documents: FirestoreDocument[] = [];
  let pageToken = "";
  do {
    const url = `${path}?pageSize=300${extra}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await getJson<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(url, token, fetchImpl);
    documents.push(...(page.documents ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return documents;
}

async function loadAuthEmails(projectId: string, token: string, fetchImpl: Fetch): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  let pageToken = "";
  do {
    const url =
      `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:batchGet` +
      `?maxResults=1000${pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await getJson<{ users?: Array<{ localId: string; email?: string }>; nextPageToken?: string }>(
      url, token, fetchImpl
    );
    for (const user of page.users ?? []) if (user.email) emails.set(user.localId, user.email);
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return emails;
}

/** Summe der Exemplare: addiert das Feld `count` aller Einträge (fehlend/ungültig = 1 Exemplar). */
export function sumCopies(items: ReadonlyArray<{ count?: unknown }>): number {
  let total = 0;
  for (const item of items) {
    const count = Number(item.count);
    total += Number.isFinite(count) && count >= 0 ? count : 1;
  }
  return total;
}

/** Karten insgesamt in Decks (Hauptdeck + Sideboard, jeweils nach `count`). */
export function sumDeckCards(decks: ReadonlyArray<Partial<DeckRecord>>): number {
  return decks.reduce(
    (total, deck) => total + sumCopies(deck.cards ?? []) + sumCopies(deck.sideboard ?? []),
    0
  );
}

export const normalizeEmail = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** Liest Nutzer, Sammlungen, Decks und Marketplace-Angebote komplett aus Firebase. */
export async function readFirebase(
  account: ServiceAccount,
  onStatus: (message: string) => void = () => undefined,
  fetchImpl: Fetch = fetch
): Promise<FirebaseSnapshot> {
  const projectId = account.project_id;
  onStatus("Anmeldung bei Google …");
  const token = await getAccessToken(account, fetchImpl);

  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;

  onStatus("Lese Nutzerverwaltung …");
  let authEmails = new Map<string, string>();
  let authListLoaded = false;
  try {
    authEmails = await loadAuthEmails(projectId, token, fetchImpl);
    authListLoaded = true;
  } catch {
    // Ersatz: E-Mail-Adressen aus den Profil-Dokumenten.
  }

  onStatus("Lese Nutzer …");
  const userDocs = await listDocuments(`${base}/users`, token, fetchImpl, "&showMissing=true");

  const users: FirebaseUserData[] = [];
  for (const [index, userDoc] of userDocs.entries()) {
    const uid = docId(userDoc);
    const profile = decodeFields(userDoc.fields);
    onStatus(`Lese Daten von Nutzer ${index + 1}/${userDocs.length} …`);
    const [cardDocs, deckDocs] = await Promise.all([
      listDocuments(`${base}/users/${encodeURIComponent(uid)}/collection`, token, fetchImpl),
      listDocuments(`${base}/users/${encodeURIComponent(uid)}/decks`, token, fetchImpl)
    ]);
    users.push({
      firebaseUid: uid,
      email: normalizeEmail(authEmails.get(uid)) || normalizeEmail(profile.email),
      displayName: typeof profile.displayName === "string" ? profile.displayName : "",
      cards: cardDocs.map((d) => ({ ...(decodeFields(d.fields) as unknown as CardRecord), id: docId(d) })),
      decks: deckDocs.map((d) => ({ ...(decodeFields(d.fields) as unknown as DeckRecord), id: docId(d) }))
    });
  }

  onStatus("Lese Marketplace …");
  const listingDocs = await listDocuments(`${base}/marketListings`, token, fetchImpl);
  const listings = listingDocs.map((d) => ({ id: docId(d), data: decodeFields(d.fields) }));

  return { projectId, users, listings, authListLoaded };
}

// ---------------------------------------------------------------------------
// Supabase: Zuordnung und Schreiben
// ---------------------------------------------------------------------------

function requireClient() {
  if (!supabase) throw new Error("Supabase ist nicht konfiguriert.");
  return supabase;
}

/** Ist der angemeldete Nutzer der Migrations-Admin? (false, solange 01-…-freigeben.sql nicht lief) */
export async function isMigrationAdmin(): Promise<boolean> {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.rpc("migration_is_admin");
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Ordnet Firebase-Nutzer über die E-Mail den Supabase-Konten zu. */
export async function resolveSupabaseUsers(snapshot: FirebaseSnapshot): Promise<FirebaseSnapshot> {
  const client = requireClient();
  const emails = [...new Set(snapshot.users.map((u) => u.email).filter(Boolean))];
  const ids = new Map<string, string>();
  for (let start = 0; start < emails.length; start += 100) {
    const { data, error } = await client.rpc("migration_user_ids", { emails: emails.slice(start, start + 100) });
    throwIfError(error);
    for (const row of (data ?? []) as Array<{ email: string; id: string }>) ids.set(normalizeEmail(row.email), row.id);
  }
  return { ...snapshot, users: snapshot.users.map((u) => ({ ...u, supabaseId: ids.get(u.email) })) };
}

export function planMigration<T extends { id?: unknown }>(
  incoming: T[],
  existingIds: ReadonlySet<string>,
  overwrite: boolean
): { toWrite: Array<T & { id: string }>; skipped: number } {
  const toWrite: Array<T & { id: string }> = [];
  let skipped = 0;
  for (const item of incoming) {
    if (typeof item.id !== "string" || !item.id || (!overwrite && existingIds.has(item.id))) {
      skipped += 1;
      continue;
    }
    toWrite.push(item as T & { id: string });
  }
  return { toWrite, skipped };
}

/** Setzt ein altes Tauschangebot auf die Supabase-Nutzer-ID um (`null`, wenn der Besitzer fehlt). */
export function buildListingRow(
  docKey: string,
  data: Record<string, unknown>,
  uidMap: ReadonlyMap<string, string>
): { id: string; owner_id: string; data: Record<string, unknown> } | null {
  const owner = typeof data.ownerId === "string" ? uidMap.get(data.ownerId) : undefined;
  if (!owner || typeof data.cardId !== "string" || !data.cardId) return null;
  const { id: _legacyId, ...rest } = data;
  void _legacyId;
  void docKey;
  return { id: `${owner}_${data.cardId}`, owner_id: owner, data: { ...rest, ownerId: owner } };
}

type Table = "collection_cards" | "decks" | "market_listings";
type WriteItem = { id: string; name: string; row: Record<string, unknown>; weight: number };

/** Schreibt Zeilen blockweise; schlägt ein Block fehl, werden die Zeilen einzeln versucht. */
async function writeRows(
  table: Table,
  conflict: string,
  items: WriteItem[]
): Promise<{ written: number; writtenWeight: number; failed: FailedItem[] }> {
  const client = requireClient();
  const failed: FailedItem[] = [];
  let written = 0;
  let writtenWeight = 0;
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);
    try {
      await withRetry(async () => {
        const { error } = await client.from(table).upsert(chunk.map((i) => i.row), { onConflict: conflict });
        throwIfError(error);
      });
      written += chunk.length;
      writtenWeight += chunk.reduce((sum, item) => sum + item.weight, 0);
    } catch {
      for (const item of chunk) {
        const { error } = await client.from(table).upsert(item.row, { onConflict: conflict });
        if (error) {
          failed.push({ id: item.id, name: item.name, reason: error.message });
        } else {
          written += 1;
          writtenWeight += item.weight;
        }
      }
    }
  }
  return { written, writtenWeight, failed };
}

async function existingCardIds(userId: string): Promise<Set<string>> {
  const client = requireClient();
  const rows = await fetchAllRows<{ card_id: string }>((from, to) =>
    client.from("collection_cards").select("card_id").eq("user_id", userId).order("card_id").range(from, to)
  );
  return new Set(rows.map((r) => r.card_id));
}

async function existingDeckIds(userId: string): Promise<Set<string>> {
  const client = requireClient();
  const rows = await fetchAllRows<{ deck_id: string }>((from, to) =>
    client.from("decks").select("deck_id").eq("user_id", userId).order("deck_id").range(from, to)
  );
  return new Set(rows.map((r) => r.deck_id));
}

const emptySection = (found = 0, copies = 0): SectionReport => ({
  found, written: 0, skipped: 0, failed: [], copies, copiesWritten: 0
});

export async function migrateAll(options: {
  snapshot: FirebaseSnapshot;
  overwrite: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrationReport> {
  const { snapshot, overwrite, onProgress } = options;
  const client = requireClient();
  const reports: UserReport[] = [];
  const uidMap = new Map<string, string>();

  for (const [index, user] of snapshot.users.entries()) {
    onProgress?.({ label: user.email || user.firebaseUid, done: index, total: snapshot.users.length });

    if (!user.supabaseId) {
      reports.push({
        email: user.email || `(ohne E-Mail, UID ${user.firebaseUid})`,
        status: "no-account",
        cards: emptySection(user.cards.length, sumCopies(user.cards)),
        decks: emptySection(user.decks.length, sumDeckCards(user.decks)),
        profileWritten: false
      });
      continue;
    }
    const userId = user.supabaseId;
    uidMap.set(user.firebaseUid, userId);

    const [cardIds, deckIds] = overwrite
      ? [new Set<string>(), new Set<string>()]
      : await Promise.all([existingCardIds(userId), existingDeckIds(userId)]);
    const cardPlan = planMigration(user.cards, cardIds, overwrite);
    const deckPlan = planMigration(user.decks, deckIds, overwrite);

    const cardResult = await writeRows(
      "collection_cards",
      "user_id,card_id",
      cardPlan.toWrite.map((card) => ({
        id: card.id,
        name: card.name ?? card.id,
        row: { user_id: userId, card_id: card.id, data: cleanRecord(card) },
        weight: sumCopies([card])
      }))
    );
    const deckResult = await writeRows(
      "decks",
      "user_id,deck_id",
      deckPlan.toWrite.map((deck) => ({
        id: deck.id,
        name: deck.name ?? deck.id,
        row: { user_id: userId, deck_id: deck.id, data: cleanRecord(deck) },
        weight: sumDeckCards([deck])
      }))
    );

    // Profil: E-Mail immer; Anzeigename nur, wenn im neuen Konto noch keiner gesetzt ist (oder „überschreiben“).
    let profileWritten = false;
    try {
      const { data: existing } = await client.from("profiles").select("display_name").eq("user_id", userId).maybeSingle();
      const hasName = typeof existing?.display_name === "string" && existing.display_name.trim() !== "";
      const profile: Record<string, unknown> = { user_id: userId, email: user.email, updated_at: Date.now() };
      if (user.displayName.trim() && (overwrite || !hasName)) profile.display_name = user.displayName.trim();
      const { error } = await client.from("profiles").upsert(profile, { onConflict: "user_id" });
      profileWritten = !error;
    } catch {
      profileWritten = false;
    }

    reports.push({
      email: user.email,
      status: "ok",
      cards: {
        found: user.cards.length,
        written: cardResult.written,
        skipped: cardPlan.skipped,
        failed: cardResult.failed,
        copies: sumCopies(user.cards),
        copiesWritten: cardResult.writtenWeight
      },
      decks: {
        found: user.decks.length,
        written: deckResult.written,
        skipped: deckPlan.skipped,
        failed: deckResult.failed,
        copies: sumDeckCards(user.decks),
        copiesWritten: deckResult.writtenWeight
      },
      profileWritten
    });
  }

  // Marketplace erst nach den Nutzern, damit alle Besitzer zugeordnet sind.
  onProgress?.({ label: "Marketplace", done: snapshot.users.length, total: snapshot.users.length });
  const listingItems: WriteItem[] = [];
  let listingSkipped = 0;
  for (const listing of snapshot.listings) {
    const row = buildListingRow(listing.id, listing.data, uidMap);
    if (!row) {
      listingSkipped += 1;
      continue;
    }
    listingItems.push({ id: row.id, name: String(row.data.name ?? row.id), row, weight: 0 });
  }
  const listingResult = await writeRows("market_listings", "id", listingItems);

  return {
    users: reports,
    listings: {
      found: snapshot.listings.length,
      written: listingResult.written,
      skipped: listingSkipped,
      failed: listingResult.failed,
      copies: 0,
      copiesWritten: 0
    }
  };
}
