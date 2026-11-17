/**
 * Arcane Decksmith – Spiel-Worker (Meilenstein 1: Räume, Einladungscode, strenge Deck-Prüfung).
 *
 * Bausteine:
 *  - HTTP-Schnittstelle `/api/...`: Deck prüfen, Raum erstellen, beitreten, verlassen, Spieler entfernen.
 *  - `GameRoom` (Durable Object je Raum): hält den Raumzustand, WebSocket-Verbindungen (mit Hibernation),
 *    Chat, „bereit“, Start, Ablauf nach 24 Stunden.
 *  - `Lobby` (ein Durable Object): merkt sich, in welchem Raum ein Konto ist (höchstens einer zugleich).
 *
 * Die Deck-Prüfung läuft hier auf dem Server, mit dem Token des Nutzers gegen die Datenbank (RLS):
 * der Browser kann weder Deckliste noch Besitz fälschen.
 *
 * Variablen: SUPABASE_URL, SUPABASE_ANON_KEY (öffentlich), ALLOWED_ORIGINS, optional SUPABASE_JWT_SECRET
 *            (Secret, nur bei Legacy-HS256), ALLOW_NO_ORIGIN=true und ROOM_TTL_SECONDS (beide nur für lokale Tests).
 */
import { DurableObject } from "cloudflare:workers";
import { AuthError, authenticate, verifySupabaseJwt } from "../../supabase-auth.js";
import { validateDeckForRoom } from "./deckValidation.js";
import { fetchScryfallFacts } from "./cardFacts.js";
import { GAME_VERSION, abortGame, applyAction, createGame, gameView, joinGame, playerLeft, splitGame } from "./gameLogic.js";
import {
  RateLimiter,
  allowedOrigins,
  displayName,
  normalizeRoomCode,
  parseClientMessage
} from "./protocol.js";
import {
  ROOM_VERSION,
  addPlayer,
  createRoom,
  generateRoomCode,
  isExpired,
  isMember,
  isValidFormat,
  removePlayer,
  roomInfo,
  roomView,
  setReady,
  startGame
} from "./roomLogic.js";
import { DataError, fetchProfileName, fetchUserCollection, fetchUserDeck } from "./supabaseData.js";

const AUTH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2048;
/** Verbindungen pro Raum inklusive noch nicht angemeldeter. */
const MAX_SOCKETS = 8;

const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
  });
}

// ---------------------------------------------------------------------------
// Lobby: höchstens ein Raum je Konto
// ---------------------------------------------------------------------------
export class Lobby extends DurableObject {
  async get(userId) {
    return (await this.ctx.storage.get(`u:${userId}`)) ?? null;
  }

  /** Ordnet das Konto dem Raum zu. Ist es schon in einem anderen Raum, kommt dessen Code zurück. */
  async claim(userId, code) {
    const current = await this.get(userId);
    if (current && current !== code) return { ok: false, code: current };
    await this.ctx.storage.put(`u:${userId}`, code);
    return { ok: true };
  }

  async release(userId, code) {
    if ((await this.get(userId)) === code) await this.ctx.storage.delete(`u:${userId}`);
    return { ok: true };
  }
}

const lobbyOf = env => env.LOBBY.get(env.LOBBY.idFromName("lobby"));
const roomOf = (env, code) => env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));

// ---------------------------------------------------------------------------
// Verlauf: beendete Spiele je Konto (ein Durable Object je Konto, höchstens 50 Einträge)
// ---------------------------------------------------------------------------
const HISTORY_LIMIT = 50;

export class History extends DurableObject {
  async add(entry) {
    const list = (await this.ctx.storage.get("entries")) ?? [];
    if (list.some(existing => existing.id === entry.id)) return { ok: true };
    list.unshift(entry);
    list.length = Math.min(list.length, HISTORY_LIMIT);
    await this.ctx.storage.put("entries", list);
    return { ok: true };
  }

  async list() {
    return (await this.ctx.storage.get("entries")) ?? [];
  }
}

const historyOf = (env, userId) => env.HISTORY.get(env.HISTORY.idFromName(userId));

// ---------------------------------------------------------------------------
// Raum
// ---------------------------------------------------------------------------
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.game = null;
    /** Ändert sich, wenn das Objekt nach einer Hibernation neu im Speicher entsteht (Diagnose). */
    this.instanceId = crypto.randomUUID().slice(0, 8);
    /** Ratenbegrenzer je Verbindung (nur im Arbeitsspeicher; nach dem Aufwachen neu). */
    this.limiters = new Map();

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get("room");
      this.room = stored?.version === ROOM_VERSION ? stored : null;
      const dynamic = this.room ? await this.ctx.storage.get("game") : null;
      const defs = dynamic ? await this.ctx.storage.get("defs") : null;
      this.game = dynamic?.version === GAME_VERSION ? joinGame(dynamic, defs) : null;
    });

    // Keepalive: "ping" wird beantwortet, ohne das Objekt aufzuwecken.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // --- Aufrufe vom Worker (RPC) --------------------------------------------------------------

  async init({ code, hostId, hostName, format, maxPlayers, deck }) {
    if (this.room && !isExpired(this.room, Date.now())) return { ok: false, error: "exists" };
    if (this.room) await this.closeRoom("Der Raum ist abgelaufen.");
    // ROOM_TTL_SECONDS ist nur für Tests gedacht (Standard: 24 Stunden).
    const ttlSeconds = Number(this.env.ROOM_TTL_SECONDS);
    const ttlMs = ttlSeconds > 0 ? ttlSeconds * 1000 : undefined;
    this.room = createRoom({ code, hostId, hostName, format, maxPlayers, deck, now: Date.now(), ttlMs });
    await this.persist();
    await this.scheduleAlarm();
    return { ok: true, expiresAt: this.room.expiresAt };
  }

  /** Öffentliche Rauminfo; mit `forUserId` zusätzlich, ob dieses Konto der Gastgeber ist. */
  async info(forUserId) {
    const info = this.room ? roomInfo(this.room, Date.now()) : null;
    return info && forUserId ? { ...info, isHost: forUserId === this.room.hostId } : info;
  }

  async membership(userId) {
    const live = this.room && !isExpired(this.room, Date.now());
    return { member: Boolean(live && isMember(this.room, userId)) };
  }

  async join({ userId, name, deck }) {
    if (!this.room) return { ok: false, reason: "missing", error: "Der Raum existiert nicht." };
    const result = addPlayer(this.room, { userId, name, deck }, Date.now());
    if (!result.ok) return result;
    await this.persist();
    this.broadcastRoom();
    return { ok: true, seat: result.seat };
  }

  async leave(userId) {
    if (!this.room) return { ok: true, removed: false, closed: false };
    const result = removePlayer(this.room, userId);
    if (!result.removed) return { ok: true, removed: false, closed: false };
    if (this.game && !result.closed) {
      playerLeft(this.game, userId);
      await this.afterGameChange();
    }
    if (result.closed) {
      await this.closeRoom("Der Gastgeber hat den Raum verlassen.");
      return { ok: true, removed: true, closed: true };
    }
    await this.afterRemoval(userId, "Du hast den Raum verlassen.");
    return { ok: true, removed: true, closed: false };
  }

  async kick(hostId, targetId) {
    if (!this.room) return { ok: false, error: "Der Raum existiert nicht." };
    if (hostId !== this.room.hostId) return { ok: false, error: "Nur der Gastgeber kann Spieler entfernen." };
    if (targetId === hostId) return { ok: false, error: "Der Gastgeber kann sich nicht selbst entfernen." };
    if (this.room.status !== "open") return { ok: false, error: "Das Spiel hat bereits begonnen." };
    const result = removePlayer(this.room, targetId);
    if (!result.removed) return { ok: false, error: "Dieser Spieler ist nicht im Raum." };
    await this.afterRemoval(targetId, "Du wurdest vom Gastgeber entfernt.");
    return { ok: true };
  }

  async afterRemoval(userId, reason) {
    await this.persist();
    await lobbyOf(this.env).release(userId, this.room.code).catch(() => undefined);
    for (const socket of this.sockets()) {
      if (socket.deserializeAttachment()?.userId === userId) {
        this.send(socket, { type: "closed", reason });
        socket.close(4005, reason);
      }
    }
    this.broadcastRoom();
  }

  /** Schließt den Raum: Verbindungen beenden, Konten freigeben, Daten löschen. */
  async closeRoom(reason) {
    const room = this.room;
    if (!room) return;
    if (this.game && this.game.phase !== "ended") {
      abortGame(this.game);
      await this.recordHistory();
    }
    this.game = null;
    for (const socket of this.sockets()) {
      this.send(socket, { type: "closed", reason });
      try {
        socket.close(4006, "Raum geschlossen");
      } catch {
        // bereits geschlossen
      }
    }
    const lobby = lobbyOf(this.env);
    await Promise.allSettled(Object.keys(room.players).map(userId => lobby.release(userId, room.code)));
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  // --- Spiel ----------------------------------------------------------------------------------

  /** Speichert das Spiel, trägt ein beendetes Spiel in den Verlauf ein und schickt allen ihre Sicht. */
  async afterGameChange() {
    if (!this.game) return;
    await this.ctx.storage.put("game", splitGame(this.game).dynamic);
    if (this.game.phase === "ended") await this.recordHistory();
    this.broadcastGame();
  }

  /** Neues Spiel aus dem Raum: Kartenwerte (Stärke, Schlüsselwörter) best effort von Scryfall, dann mischen und ziehen. */
  async newGame() {
    const ids = [];
    for (const player of Object.values(this.room.players)) {
      for (const card of [...(player.deck.commanders ?? []), ...player.deck.main]) ids.push(card.id);
    }
    const facts = await fetchScryfallFacts(ids, { base: this.env.SCRYFALL_BASE || undefined });
    this.game = createGame({ room: this.room, random: randomUnit, facts });
    await this.ctx.storage.put("defs", splitGame(this.game).defs);
  }

  async recordHistory() {
    const game = this.game;
    if (!game?.summary || !this.room) return;
    const id = `${this.room.code}-${game.startedAt}`;
    await Promise.allSettled(
      game.seats.map(userId =>
        historyOf(this.env, userId).add({ ...game.summary, id, code: this.room.code, won: game.summary.winner === userId })
      )
    );
  }

  sendGame(socket, userId) {
    if (this.game?.players[userId]) this.send(socket, { type: "game", game: gameView(this.game, userId) });
  }

  broadcastGame(except) {
    if (!this.game) return;
    for (const socket of this.authedSockets(except)) {
      const { userId } = socket.deserializeAttachment();
      if (this.game.players[userId]) this.send(socket, { type: "game", game: gameView(this.game, userId) });
    }
  }

  // --- WebSocket ------------------------------------------------------------------------------

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet.", { status: 426 });
    }
    if (!this.room || isExpired(this.room, Date.now())) {
      return json({ error: "Der Raum existiert nicht oder ist abgelaufen." }, 404);
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return json({ error: "Zu viele Verbindungen." }, 429);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, at: Date.now() });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Nächster nötiger Alarm: Ablauf des Raums oder Anmelde-Timeout einer Verbindung. */
  async scheduleAlarm() {
    const times = [];
    if (this.room) times.push(this.room.expiresAt);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = socket.deserializeAttachment();
      if (!attachment?.authed) times.push((attachment?.at ?? Date.now()) + AUTH_TIMEOUT_MS);
    }
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    if (this.room && isExpired(this.room, Date.now())) {
      await this.closeRoom("Der Raum ist abgelaufen.");
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      const attachment = socket.deserializeAttachment();
      if (!attachment?.authed && Date.now() - (attachment?.at ?? 0) >= AUTH_TIMEOUT_MS) {
        this.send(socket, { type: "error", message: "Anmeldung erforderlich." });
        socket.close(4001, "Anmeldung erforderlich.");
      }
    }
    await this.scheduleAlarm();
  }

  async webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment() ?? {};

    let limiter = this.limiters.get(socket);
    if (!limiter) {
      limiter = new RateLimiter();
      this.limiters.set(socket, limiter);
    }
    if (!limiter.allow()) {
      this.send(socket, { type: "error", message: "Zu viele Nachrichten." });
      return;
    }

    const parsed = parseClientMessage(message);
    if (!parsed.ok) {
      this.send(socket, { type: "error", message: parsed.error });
      if (!attachment.authed) socket.close(4003, "Ungültige Nachricht.");
      return;
    }

    if (!attachment.authed) {
      if (parsed.message.type !== "auth") {
        socket.close(4001, "Anmeldung erforderlich.");
        return;
      }
      await this.authenticateSocket(socket, parsed.message.token);
      return;
    }

    if (!this.room) {
      socket.close(4006, "Raum geschlossen");
      return;
    }

    switch (parsed.message.type) {
      case "chat":
        this.broadcast({ type: "chat", from: attachment.name, userId: attachment.userId, text: parsed.message.text });
        break;
      case "ready": {
        const result = setReady(this.room, attachment.userId, parsed.message.ready);
        if (!result.ok) {
          this.send(socket, { type: "error", message: result.error });
          break;
        }
        await this.persist();
        this.broadcastRoom();
        break;
      }
      case "start": {
        const result = startGame(this.room, attachment.userId);
        if (!result.ok) {
          this.send(socket, { type: "error", message: result.error });
          break;
        }
        await this.newGame();
        await this.persist();
        this.broadcast({ type: "system", text: "Das Spiel wurde gestartet." });
        this.broadcastRoom();
        await this.afterGameChange();
        break;
      }
      case "game": {
        if (!this.game) {
          this.send(socket, { type: "error", message: "Das Spiel hat noch nicht begonnen." });
          break;
        }
        // Wirft die Regel-Engine einen Fehler, wird der Zustand vor der Aktion wiederhergestellt und allen neu gesendet,
        // damit keine Seite mit einem veralteten oder halb geänderten Spiel zurückbleibt.
        const backup = structuredClone(this.game);
        let result;
        try {
          result = applyAction(this.game, attachment.userId, parsed.message.action, { random: randomUnit });
        } catch (error) {
          console.error("Fehler in der Spielregel-Engine:", error);
          this.game = backup;
          this.send(socket, { type: "error", message: "Interner Fehler: Die Aktion wurde zurückgenommen." });
          this.broadcastGame();
          break;
        }
        if (!result.ok) {
          this.game = backup;
          this.send(socket, { type: "error", message: result.error });
          this.sendGame(socket, attachment.userId);
          break;
        }
        await this.afterGameChange();
        break;
      }
      case "sync":
        this.broadcastRoom();
        this.sendGame(socket, attachment.userId);
        break;
      case "rematch": {
        if (attachment.userId !== this.room.hostId) {
          this.send(socket, { type: "error", message: "Nur der Gastgeber kann eine Revanche starten." });
          break;
        }
        if (!this.game || this.game.phase !== "ended") {
          this.send(socket, { type: "error", message: "Das laufende Spiel ist noch nicht beendet." });
          break;
        }
        const remaining = Object.keys(this.room.players);
        if (remaining.length < 2) {
          this.send(socket, { type: "error", message: "Für eine Revanche braucht es mindestens 2 Spieler." });
          break;
        }
        await this.newGame();
        this.broadcast({ type: "system", text: "Revanche: ein neues Spiel beginnt." });
        await this.afterGameChange();
        break;
      }
      default:
        this.send(socket, { type: "error", message: "Nicht erlaubt." });
    }
  }

  async authenticateSocket(socket, token) {
    let claims;
    try {
      claims = await verifySupabaseJwt(token, this.env);
    } catch {
      this.send(socket, { type: "error", message: "Anmeldung fehlgeschlagen." });
      socket.close(4001, "Anmeldung fehlgeschlagen.");
      return;
    }

    const userId = claims.sub;
    if (!this.room || isExpired(this.room, Date.now())) {
      socket.close(4006, "Raum geschlossen");
      return;
    }
    if (!isMember(this.room, userId)) {
      this.send(socket, { type: "error", message: "Du bist kein Mitglied dieses Raums." });
      socket.close(4004, "Kein Mitglied.");
      return;
    }

    // Neue Verbindung desselben Nutzers ersetzt die alte (z. B. nach Netzwechsel).
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket && other.deserializeAttachment()?.userId === userId) {
        other.close(4000, "Neue Verbindung.");
      }
    }

    socket.serializeAttachment({ authed: true, userId, name: this.room.players[userId].name, at: Date.now() });
    this.send(socket, { type: "welcome", userId, code: this.room.code });
    if (this.game?.players[userId]) this.send(socket, { type: "game", game: gameView(this.game, userId) });
    await this.scheduleAlarm();
    this.broadcastRoom();
  }

  webSocketClose(socket, code) {
    this.limiters.delete(socket);
    try {
      socket.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "Tschüss");
    } catch {
      // bereits geschlossen
    }
    this.broadcastRoom(socket);
  }

  webSocketError(socket) {
    this.limiters.delete(socket);
    this.broadcastRoom(socket);
  }

  // --- Hilfen ---------------------------------------------------------------------------------

  async persist() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  send(socket, data) {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      // Verbindung bereits weg
    }
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter(socket => socket !== except && socket.readyState === 1);
  }

  authedSockets(except) {
    return this.sockets(except).filter(socket => socket.deserializeAttachment()?.authed);
  }

  broadcast(data, except) {
    for (const socket of this.authedSockets(except)) this.send(socket, data);
  }

  /** Sendet jedem angemeldeten Mitglied seine Sicht auf den Raum. */
  broadcastRoom(except) {
    if (!this.room) return;
    const sockets = this.authedSockets(except);
    const onlineIds = sockets.map(socket => socket.deserializeAttachment().userId);
    for (const socket of sockets) {
      const { userId } = socket.deserializeAttachment();
      this.send(socket, {
        type: "room",
        instance: this.instanceId,
        room: roomView(this.room, userId, onlineIds)
      });
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP-Schnittstelle
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function corsHeaders(origin, allowed) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin"
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

async function readBody(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ApiError(413, "Anfrage zu groß.");
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // fällt unten durch
  }
  throw new ApiError(400, "Ungültige Anfrage.");
}

/** Prüft ein Deck des Nutzers für ein Format (Datenbankzugriff mit dessen Token). */
async function checkDeck(env, auth, deckId, format) {
  if (typeof deckId !== "string" || deckId.length === 0 || deckId.length > 200) {
    throw new ApiError(400, "Deck fehlt.");
  }
  if (!isValidFormat(format)) throw new ApiError(400, "Unbekanntes Format.");
  const [deck, collection] = await Promise.all([
    fetchUserDeck(env, auth.token, auth.userId, deckId),
    fetchUserCollection(env, auth.token, auth.userId)
  ]);
  if (!deck) {
    return {
      ok: false,
      errors: [{ code: "deck_missing", message: "Das Deck wurde nicht gefunden." }],
      summary: { format, mainCount: 0, sideboardCount: 0, commanderCount: 0, totalCards: 0 }
    };
  }
  return validateDeckForRoom({ deck, collection, format });
}

/** Raumcode des Kontos, falls es (noch) in einem Raum ist; veraltete Einträge werden bereinigt. */
async function currentRoomCode(env, userId) {
  const lobby = lobbyOf(env);
  const code = await lobby.get(userId);
  if (!code) return null;
  const { member } = await roomOf(env, code).membership(userId);
  if (member) return code;
  await lobby.release(userId, code);
  return null;
}

const invalidDeck = result =>
  new ApiError(422, "Das Deck ist für diesen Raum nicht gültig.", { errors: result.errors, summary: result.summary });

async function createRoomApi(env, auth, body) {
  const { format, deckId } = body;
  if (!isValidFormat(format)) throw new ApiError(400, "Unbekanntes Format.");

  const existing = await currentRoomCode(env, auth.userId);
  if (existing) {
    throw new ApiError(409, `Du bist bereits in Raum ${existing}. Verlasse ihn zuerst.`, { code: existing });
  }

  const result = await checkDeck(env, auth, deckId, format);
  if (!result.ok) throw invalidDeck(result);

  const name = displayName(await fetchProfileName(env, auth.token, auth.userId), auth.claims);
  const lobby = lobbyOf(env);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateRoomCode(randomUnit);
    const claim = await lobby.claim(auth.userId, code);
    if (!claim.ok) throw new ApiError(409, `Du bist bereits in Raum ${claim.code}. Verlasse ihn zuerst.`, { code: claim.code });

    const init = await roomOf(env, code).init({
      code,
      hostId: auth.userId,
      hostName: name,
      format,
      maxPlayers: Number.isInteger(body.maxPlayers) ? body.maxPlayers : undefined,
      deck: result.snapshot
    });
    if (init.ok) return { status: 201, data: { code, expiresAt: init.expiresAt } };
    await lobby.release(auth.userId, code); // Code schon vergeben → nächster Versuch
  }
  throw new ApiError(503, "Es konnte kein freier Raumcode vergeben werden. Bitte erneut versuchen.");
}

async function joinRoomApi(env, auth, body) {
  const code = normalizeRoomCode(body.code);
  if (!code) throw new ApiError(400, "Ungültiger Raumcode.");

  const info = await roomOf(env, code).info();
  if (!info) throw new ApiError(404, "Dieser Raum existiert nicht oder ist abgelaufen.");

  const existing = await currentRoomCode(env, auth.userId);
  if (existing === code) return { status: 200, data: { code } }; // schon Mitglied (z. B. nach Neuladen)
  if (existing) throw new ApiError(409, `Du bist bereits in Raum ${existing}. Verlasse ihn zuerst.`, { code: existing });

  if (info.status !== "open") throw new ApiError(409, "Das Spiel hat bereits begonnen.");
  if (info.playerCount >= info.maxPlayers) throw new ApiError(409, "Der Raum ist voll.");

  const result = await checkDeck(env, auth, body.deckId, info.format);
  if (!result.ok) throw invalidDeck(result);

  const name = displayName(await fetchProfileName(env, auth.token, auth.userId), auth.claims);
  const lobby = lobbyOf(env);
  const claim = await lobby.claim(auth.userId, code);
  if (!claim.ok) throw new ApiError(409, `Du bist bereits in Raum ${claim.code}. Verlasse ihn zuerst.`, { code: claim.code });

  const joined = await roomOf(env, code).join({ userId: auth.userId, name, deck: result.snapshot });
  if (!joined.ok) {
    await lobby.release(auth.userId, code);
    throw new ApiError(joined.reason === "expired" || joined.reason === "missing" ? 404 : 409, joined.error);
  }
  return { status: 200, data: { code } };
}

async function handleApi(request, env, url) {
  const allowed = allowedOrigins(env);
  if (allowed.length === 0) return json({ error: "Der Worker ist nicht konfiguriert (ALLOWED_ORIGINS fehlt)." }, 500);

  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, allowed);
  const reply = (data, status = 200) => json(data, status, cors);

  if (request.method === "OPTIONS") {
    return origin && allowed.includes(origin) ? new Response(null, { status: 204, headers: cors }) : reply({ error: "Origin nicht erlaubt." }, 403);
  }
  if (origin ? !allowed.includes(origin) : env.ALLOW_NO_ORIGIN !== "true") {
    return reply({ error: "Origin nicht erlaubt." }, 403);
  }

  try {
    let auth;
    try {
      const result = await authenticate(request, env);
      auth = { ...result, token: request.headers.get("Authorization").replace(/^Bearer\s+/i, "").trim() };
    } catch (error) {
      if (error instanceof AuthError) throw new ApiError(error.status >= 500 ? error.status : 401, error.message);
      throw error;
    }

    const path = url.pathname.replace(/\/+$/, "");
    const method = request.method;

    if (method === "POST" && path === "/api/decks/check") {
      const body = await readBody(request);
      return reply(await checkDeck(env, auth, body.deckId, body.format));
    }

    if (method === "GET" && path === "/api/rooms/mine") {
      const code = await currentRoomCode(env, auth.userId);
      const info = code ? await roomOf(env, code).info(auth.userId) : null;
      return reply({ room: info ?? null });
    }

    if (method === "GET" && path === "/api/history") {
      return reply({ entries: await historyOf(env, auth.userId).list() });
    }

    const infoMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/);
    if (method === "GET" && infoMatch && infoMatch[1] !== "mine") {
      const code = normalizeRoomCode(infoMatch[1]);
      const info = code ? await roomOf(env, code).info() : null;
      if (!info) throw new ApiError(404, "Dieser Raum existiert nicht oder ist abgelaufen.");
      return reply({ room: info });
    }

    if (method === "POST" && path === "/api/rooms") {
      const { status, data } = await createRoomApi(env, auth, await readBody(request));
      return reply(data, status);
    }
    if (method === "POST" && path === "/api/rooms/join") {
      const { status, data } = await joinRoomApi(env, auth, await readBody(request));
      return reply(data, status);
    }
    if (method === "POST" && path === "/api/rooms/leave") {
      const code = await currentRoomCode(env, auth.userId);
      if (code) await roomOf(env, code).leave(auth.userId);
      await lobbyOf(env).release(auth.userId, code ?? "");
      return reply({ ok: true });
    }
    if (method === "POST" && path === "/api/rooms/kick") {
      const body = await readBody(request);
      const code = await currentRoomCode(env, auth.userId);
      if (!code) throw new ApiError(404, "Du bist in keinem Raum.");
      if (typeof body.userId !== "string") throw new ApiError(400, "Spieler fehlt.");
      const result = await roomOf(env, code).kick(auth.userId, body.userId);
      if (!result.ok) throw new ApiError(403, result.error);
      return reply({ ok: true });
    }

    return reply({ error: "Nicht gefunden." }, 404);
  } catch (error) {
    if (error instanceof ApiError) return reply({ error: error.message, ...error.extra }, error.status);
    if (error instanceof DataError) return reply({ error: error.message }, error.status === 413 ? 413 : 502);
    console.error("API-Fehler:", error);
    return reply({ error: "Interner Fehler." }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, service: "arcane-decksmith-game" });
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!match) return json({ error: "Nicht gefunden." }, 404);

    const allowed = allowedOrigins(env);
    if (allowed.length === 0) return json({ error: "Der Worker ist nicht konfiguriert (ALLOWED_ORIGINS fehlt)." }, 500);

    // Browser senden immer einen Origin-Header. Ohne Origin nur, wenn lokal ausdrücklich erlaubt.
    const origin = request.headers.get("Origin");
    if (origin ? !allowed.includes(origin) : env.ALLOW_NO_ORIGIN !== "true") {
      return json({ error: "Origin nicht erlaubt." }, 403);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket erwartet." }, 426);
    }

    const code = normalizeRoomCode(match[1]);
    if (!code) return json({ error: "Ungültiger Raumcode." }, 400);
    return roomOf(env, code).fetch(request);
  }
};
