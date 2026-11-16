/**
 * Liest Deck, Sammlung und Profilnamen eines Nutzers aus Supabase – mit dem **Token des Nutzers**
 * und dem öffentlichen anon-Schlüssel. Es gelten die Zugriffsregeln (RLS): ein Nutzer kann nur seine
 * eigenen Daten lesen, ein geheimer Schlüssel wird im Worker nicht gebraucht.
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 30;

export class DataError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "DataError";
    this.status = status;
  }
}

async function restGet(env, token, path, { range, fetchImpl = fetch } = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new DataError("Der Worker ist nicht für Datenzugriffe konfiguriert (SUPABASE_ANON_KEY fehlt).", 500);
  }
  const headers = {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };
  if (range) {
    headers["Range-Unit"] = "items";
    headers.Range = `${range[0]}-${range[1]}`;
  }

  let response;
  try {
    response = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/+$/, "")}/rest/v1/${path}`, { headers });
  } catch {
    throw new DataError("Die Datenbank ist nicht erreichbar.");
  }
  if (!response.ok) throw new DataError(`Datenbankfehler (${response.status}).`);
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) throw new DataError("Unerwartete Antwort der Datenbank.");
  return data;
}

/** Liefert das Deck (`data`-Spalte) oder `null`, wenn es nicht existiert. */
export async function fetchUserDeck(env, token, userId, deckId, fetchImpl) {
  const rows = await restGet(
    env,
    token,
    `decks?select=data&user_id=eq.${encodeURIComponent(userId)}&deck_id=eq.${encodeURIComponent(deckId)}&limit=1`,
    { fetchImpl }
  );
  return rows[0]?.data ?? null;
}

/** Liest die gesamte Sammlung seitenweise (PostgREST liefert höchstens 1000 Zeilen je Anfrage). */
export async function fetchUserCollection(env, token, userId, fetchImpl) {
  const cards = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await restGet(
      env,
      token,
      `collection_cards?select=data&user_id=eq.${encodeURIComponent(userId)}&order=card_id`,
      { range: [page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1], fetchImpl }
    );
    for (const row of rows) if (row?.data) cards.push(row.data);
    if (rows.length < PAGE_SIZE) return cards;
  }
  throw new DataError("Die Sammlung ist zu groß für die Prüfung.", 413);
}

/** Anzeigename aus dem Profil (optional; Fehler führen zu `null`). */
export async function fetchProfileName(env, token, userId, fetchImpl) {
  try {
    const rows = await restGet(
      env,
      token,
      `profiles?select=display_name&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
      { fetchImpl }
    );
    return typeof rows[0]?.display_name === "string" ? rows[0].display_name : null;
  } catch {
    return null;
  }
}
