/**
 * Reine Raumlogik (ohne Cloudflare-Abhängigkeiten, daher in Node testbar):
 * Räume anlegen, Spieler aufnehmen und entfernen, „bereit“, Start, Ablauf, Sicht pro Spieler.
 *
 * Festlegungen: Standard = 2 Spieler, Commander = 2 bis 4 Spieler. Ein Raum läuft nach 24 Stunden ab.
 * Verlässt der Gastgeber den Raum, wird der Raum geschlossen.
 */

export const ROOM_VERSION = 2;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PLAYERS = 2;
export const FORMAT_LIMITS = {
  standard: { min: 2, max: 2 },
  commander: { min: 2, max: 4 }
};
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export function isValidFormat(format) {
  return format === "standard" || format === "commander";
}

/** Erzeugt einen Raumcode; `random` liefert Zahlen in [0, 1). */
export function generateRoomCode(random = Math.random) {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join("");
}

/** Anzahl der Plätze: Standard immer 2, Commander 2 bis 4 (Standard 4). */
export function resolveMaxPlayers(format, requested) {
  const limits = FORMAT_LIMITS[format];
  const value = Number.isInteger(requested) ? requested : limits.max;
  return Math.min(limits.max, Math.max(limits.min, value));
}

/** Öffentliche Kurzfassung eines Decks (ohne Kartenliste). */
export function deckSummary(snapshot) {
  return { id: snapshot.deckId, name: snapshot.name, cardCount: snapshot.totalCards };
}

export function createRoom({ code, hostId, hostName, format, maxPlayers, deck, now, ttlMs = ROOM_TTL_MS }) {
  return {
    version: ROOM_VERSION,
    code,
    hostId,
    format,
    maxPlayers: resolveMaxPlayers(format, maxPlayers),
    status: "open", // open | playing
    createdAt: now,
    expiresAt: now + ttlMs,
    players: { [hostId]: { name: hostName, seat: 0, ready: false, deck, joinedAt: now } }
  };
}

export function isExpired(room, now) {
  return now >= room.expiresAt;
}

export function playerCount(room) {
  return Object.keys(room.players).length;
}

export function isMember(room, userId) {
  return Boolean(room.players[userId]);
}

/** Nimmt einen Spieler auf. Rückgabe: `{ ok: true, seat }` oder `{ ok: false, reason, error }`. */
export function addPlayer(room, { userId, name, deck }, now) {
  if (isExpired(room, now)) return { ok: false, reason: "expired", error: "Der Raum ist abgelaufen." };
  const existing = room.players[userId];
  if (existing) {
    existing.name = name;
    return { ok: true, seat: existing.seat, already: true };
  }
  if (room.status !== "open") return { ok: false, reason: "started", error: "Das Spiel hat bereits begonnen." };
  if (playerCount(room) >= room.maxPlayers) return { ok: false, reason: "full", error: "Der Raum ist voll." };

  const taken = new Set(Object.values(room.players).map(player => player.seat));
  let seat = 0;
  while (taken.has(seat)) seat += 1;
  room.players[userId] = { name, seat, ready: false, deck, joinedAt: now };
  return { ok: true, seat, already: false };
}

/**
 * Entfernt einen Spieler. Verlässt der Gastgeber den Raum, wird der Raum geschlossen.
 * Rückgabe: `{ removed, closed, releasedIds }` (releasedIds = Spieler, die keinem Raum mehr angehören).
 */
export function removePlayer(room, userId) {
  if (!room.players[userId]) return { removed: false, closed: false, releasedIds: [] };
  if (userId === room.hostId) {
    return { removed: true, closed: true, releasedIds: Object.keys(room.players) };
  }
  delete room.players[userId];
  // Bereit-Markierungen zurücksetzen, damit niemand in eine geänderte Runde „hineingestartet“ wird.
  for (const player of Object.values(room.players)) player.ready = false;
  return { removed: true, closed: false, releasedIds: [userId] };
}

export function setReady(room, userId, ready) {
  const player = room.players[userId];
  if (!player) return { ok: false, error: "Du bist nicht im Raum." };
  if (room.status !== "open") return { ok: false, error: "Das Spiel hat bereits begonnen." };
  player.ready = Boolean(ready);
  return { ok: true };
}

export function canStart(room, userId) {
  if (userId !== room.hostId) return { ok: false, error: "Nur der Gastgeber kann das Spiel starten." };
  if (room.status !== "open") return { ok: false, error: "Das Spiel hat bereits begonnen." };
  const players = Object.values(room.players);
  if (players.length < MIN_PLAYERS) return { ok: false, error: `Es braucht mindestens ${MIN_PLAYERS} Spieler.` };
  if (!players.every(player => player.ready)) return { ok: false, error: "Nicht alle Spieler sind bereit." };
  return { ok: true };
}

export function startGame(room, userId) {
  const check = canStart(room, userId);
  if (!check.ok) return check;
  room.status = "playing";
  return { ok: true };
}

/** Öffentliche Rauminfo für Beitrittsanfragen (ohne Spielerliste, ohne Decks). */
export function roomInfo(room, now) {
  if (!room || isExpired(room, now)) return null;
  return {
    code: room.code,
    format: room.format,
    status: room.status,
    maxPlayers: room.maxPlayers,
    playerCount: playerCount(room),
    hostName: room.players[room.hostId]?.name ?? "",
    expiresAt: room.expiresAt
  };
}

/** Sicht eines Mitglieds: von anderen Spielern nur öffentliche Werte (Name, bereit, Deckname und Kartenzahl). */
export function roomView(room, viewerId, onlineIds) {
  const online = new Set(onlineIds);
  const players = Object.entries(room.players)
    .sort((a, b) => a[1].seat - b[1].seat)
    .map(([userId, player]) => ({
      userId,
      name: player.name,
      seat: player.seat,
      ready: player.ready,
      online: online.has(userId),
      isHost: userId === room.hostId,
      deck: deckSummary(player.deck)
    }));
  return {
    code: room.code,
    format: room.format,
    status: room.status,
    maxPlayers: room.maxPlayers,
    expiresAt: room.expiresAt,
    hostId: room.hostId,
    you: viewerId,
    players
  };
}
