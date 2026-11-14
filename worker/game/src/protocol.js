/**
 * Reine Logik des Machbarkeitstests (ohne Cloudflare-Abhängigkeiten, daher in Node testbar):
 * Nachrichten prüfen, Spielstand ändern, Sicht pro Spieler erzeugen, Ratenbegrenzung.
 *
 * Kernidee für den späteren Spieltisch: Der **volle Zustand** liegt nur auf dem Server.
 * Jeder Client bekommt über `buildView` ausschließlich seine eigene Sicht – vom Gegner
 * erfährt er nur öffentliche Werte (z. B. die Anzahl der Handkarten).
 */

export const MAX_PLAYERS = 4;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_CHAT_LENGTH = 300;
export const MAX_NAME_LENGTH = 30;

/** Demo-Stapel: 20 Karten, Kartennamen nur zur Anschauung. */
export const DEMO_DECK = Array.from({ length: 20 }, (_, i) => `Karte ${i + 1}`);

export function createRoomState(roomCode) {
  return { roomCode, players: {}, events: 0 };
}

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
    case "draw":
      return { ok: true, message: { type: "draw" } };
    default:
      return { ok: false, error: "Unbekannter Nachrichtentyp." };
  }
}

/** Anzeigename aus dem Token (nur E-Mail-Vorderteil, nie die volle Adresse an andere senden). */
export function displayNameFromClaims(claims) {
  const email = typeof claims?.email === "string" ? claims.email : "";
  const base = email.split("@")[0] || "Spieler";
  return base.replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, MAX_NAME_LENGTH) || "Spieler";
}

/**
 * Nimmt einen Spieler auf (oder erkennt ihn wieder). Liefert `{ ok, seat }` bzw. `{ ok: false, error }`.
 * Der Mutations-Hinweis `changed` zeigt, ob der Zustand gespeichert werden muss.
 */
export function joinPlayer(state, userId, name) {
  const existing = state.players[userId];
  if (existing) {
    const changed = existing.name !== name;
    existing.name = name;
    return { ok: true, seat: existing.seat, changed };
  }

  const taken = new Set(Object.values(state.players).map(player => player.seat));
  let seat = 0;
  while (taken.has(seat)) seat += 1;
  if (seat >= MAX_PLAYERS) return { ok: false, error: "Der Raum ist voll." };

  state.players[userId] = { name, seat, hand: [], library: [] };
  return { ok: true, seat, changed: true };
}

/** Mischt den Demo-Stapel des Spielers mit Fisher-Yates; `random` liefert Zahlen in [0, 1). */
export function shuffleInto(state, userId, random) {
  const player = state.players[userId];
  const cards = [...DEMO_DECK];
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  player.library = cards;
  player.hand = [];
}

/** Zieht die oberste Karte der Bibliothek in die Hand. Mischt beim ersten Mal. */
export function drawCard(state, userId, random) {
  const player = state.players[userId];
  if (!player) return { ok: false, error: "Du bist nicht im Raum." };
  if (player.library.length === 0 && player.hand.length === 0) shuffleInto(state, userId, random);
  const card = player.library.shift();
  if (card === undefined) return { ok: false, error: "Die Bibliothek ist leer." };
  player.hand.push(card);
  state.events += 1;
  return { ok: true, card };
}

/**
 * Sicht eines Spielers: eigene Hand sichtbar, bei allen anderen nur die Anzahl.
 * Die Bibliothek (Reihenfolge!) wird **nie** übertragen, auch nicht dem Besitzer.
 */
export function buildView(state, viewerId, onlineIds) {
  const online = new Set(onlineIds);
  const players = Object.entries(state.players)
    .sort((a, b) => a[1].seat - b[1].seat)
    .map(([userId, player]) => ({
      userId,
      name: player.name,
      seat: player.seat,
      online: online.has(userId),
      handCount: player.hand.length,
      libraryCount: player.library.length,
      ...(userId === viewerId ? { hand: [...player.hand] } : {})
    }));
  return { roomCode: state.roomCode, you: viewerId, events: state.events, players };
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
