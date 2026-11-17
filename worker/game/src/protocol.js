/**
 * Reine Hilfsfunktionen des Spiel-Workers (ohne Cloudflare-Abhängigkeiten, daher in Node testbar):
 * WebSocket-Nachrichten prüfen, Ratenbegrenzung, Namen und Codes normalisieren.
 */

export const MAX_MESSAGE_BYTES = 4096;
export const MAX_CHAT_LENGTH = 300;
export const MAX_NAME_LENGTH = 30;

/** Prüft eine Roh-Nachricht des Clients. Liefert `{ ok: true, message }` oder `{ ok: false, error }`. */
export function parseClientMessage(raw) {
  if (typeof raw !== "string") return { ok: false, error: "Nur Text-Nachrichten sind erlaubt." };
  if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "Nachricht zu groß." };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Ungültiges JSON." };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "Ungültige Nachricht." };
  }

  switch (data.type) {
    case "auth":
      if (typeof data.token !== "string" || data.token.length === 0 || data.token.length > 4000) {
        return { ok: false, error: "Token fehlt." };
      }
      return { ok: true, message: { type: "auth", token: data.token } };
    case "chat": {
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) return { ok: false, error: "Leere Chat-Nachricht." };
      return { ok: true, message: { type: "chat", text: text.slice(0, MAX_CHAT_LENGTH) } };
    }
    case "ready":
      if (typeof data.ready !== "boolean") return { ok: false, error: "Ungültige Bereit-Angabe." };
      return { ok: true, message: { type: "ready", ready: data.ready } };
    case "start":
      return { ok: true, message: { type: "start" } };
    case "sync":
      return { ok: true, message: { type: "sync" } };
    case "rematch":
      return { ok: true, message: { type: "rematch" } };
    case "game":
      if (!data.action || typeof data.action !== "object" || Array.isArray(data.action) || typeof data.action.type !== "string") {
        return { ok: false, error: "Ungültige Spielaktion." };
      }
      return { ok: true, message: { type: "game", action: data.action } };
    default:
      return { ok: false, error: "Unbekannter Nachrichtentyp." };
  }
}

/** Bereinigt einen Anzeigenamen (Buchstaben, Ziffern, Leerzeichen und . _ -). */
export function cleanName(value) {
  const text = typeof value === "string" ? value : "";
  return text.replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, MAX_NAME_LENGTH);
}

/** Anzeigename: Profilname, sonst der Vorderteil der E-Mail (nie die volle Adresse an andere senden). */
export function displayName(profileName, claims) {
  const fromProfile = cleanName(profileName);
  if (fromProfile.length >= 2) return fromProfile;
  const email = typeof claims?.email === "string" ? claims.email : "";
  return cleanName(email.split("@")[0]) || "Spieler";
}

/** Einfacher Token-Bucket: `capacity` Nachrichten, danach `refillPerSecond` pro Sekunde. */
export class RateLimiter {
  constructor(capacity = 20, refillPerSecond = 10, now = () => Date.now()) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  allow() {
    const current = this.now();
    const elapsed = Math.max(0, current - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
    this.updatedAt = current;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Raumcode: 4 bis 12 Großbuchstaben/Ziffern. Liefert den normalisierten Code oder `null`. */
export function normalizeRoomCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}
