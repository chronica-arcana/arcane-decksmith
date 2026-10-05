// Reine Umrechnungslogik für die Datenübernahme Firestore → Supabase (ohne Netzwerkzugriff, testbar).

export const CHUNK_SIZE = 200;

export function chunk(items, size = CHUNK_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Entfernt undefined/Firestore-Sonderwerte und liefert reines JSON. */
export function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v?.toMillis === "function" ? v.toMillis() : v)));
}

export function cardRow(userId, docId, data) {
  const json = toPlainJson(data);
  return { user_id: userId, card_id: docId, data: json };
}

export function deckRow(userId, docId, data) {
  const json = toPlainJson(data);
  return { user_id: userId, deck_id: docId, data: json };
}

export function profileRow(userId, profile) {
  const displayName = typeof profile.displayName === "string" && profile.displayName.trim() ? profile.displayName : null;
  return {
    user_id: userId,
    email: normalizeEmail(profile.email) || "",
    display_name: displayName,
    updated_at: typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now()
  };
}

/**
 * Setzt ein altes Tauschangebot auf die Supabase-Nutzer-ID um.
 * ID und `ownerId` enthalten die Firebase-UID und müssen ersetzt werden.
 * Liefert `null`, wenn der Besitzer nicht übernommen wurde.
 */
export function listingRow(docId, data, uidMap) {
  const newOwner = uidMap.get(data?.ownerId);
  if (!newOwner || typeof data?.cardId !== "string") return null;
  const json = toPlainJson(data);
  delete json.id;
  json.ownerId = newOwner;
  return { id: `${newOwner}_${json.cardId}`, owner_id: newOwner, data: json, legacyId: docId };
}
