/**
 * Arcane Decksmith – Spiel-Worker (Machbarkeitstest, Meilenstein 0).
 *
 * Pro Raum gibt es ein Durable Object (`GameRoom`), das den Spielstand hält. Clients verbinden sich
 * per WebSocket, melden sich mit ihrem Supabase-Token an und senden nur Absichten ("ziehe eine Karte").
 * Jeder Client erhält ausschließlich seine eigene Sicht (siehe protocol.js → buildView).
 *
 * Wichtig für den Gratis-Tarif: WebSocket-Hibernation (`ctx.acceptWebSocket`), damit ruhende Räume
 * keine Rechenzeit verbrauchen.
 *
 * Variablen: SUPABASE_URL, ALLOWED_ORIGINS, optional SUPABASE_JWT_SECRET (Secret, nur bei Legacy-HS256),
 *            ALLOW_NO_ORIGIN=true (nur lokal zum Testen ohne Browser).
 */
import { DurableObject } from "cloudflare:workers";
import { verifySupabaseJwt } from "../../supabase-auth.js";
import {
  MAX_PLAYERS,
  RateLimiter,
  allowedOrigins,
  buildView,
  createRoomState,
  displayNameFromClaims,
  drawCard,
  joinPlayer,
  normalizeRoomCode,
  parseClientMessage
} from "./protocol.js";

const AUTH_TIMEOUT_MS = 10_000;
/** Verbindungen pro Raum inklusive noch nicht angemeldeter. */
const MAX_SOCKETS = MAX_PLAYERS + 2;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    /** Ändert sich, wenn das Objekt nach einer Hibernation neu im Speicher entsteht (Diagnose). */
    this.instanceId = crypto.randomUUID().slice(0, 8);
    /** Ratenbegrenzer je Verbindung (nur im Arbeitsspeicher; nach einem Hibernation-Aufwachen neu). */
    this.limiters = new Map();

    // Zustand nach dem Aufwachen aus der Hibernation wieder laden.
    this.ctx.blockConcurrencyWhile(async () => {
      this.room = (await this.ctx.storage.get("room")) ?? null;
    });

    // Keepalive: "ping" wird beantwortet, ohne das Objekt aufzuwecken.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket erwartet.", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return json({ error: "Der Raum ist voll." }, 429);
    }

    if (!this.room) {
      const code = normalizeRoomCode(new URL(request.url).pathname.split("/").pop());
      this.room = createRoomState(code ?? "UNBEKANNT");
      await this.ctx.storage.put("room", this.room);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, at: Date.now() });
    await this.scheduleAuthCheck();

    return new Response(null, { status: 101, webSocket: client });
  }

  async scheduleAuthCheck() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + AUTH_TIMEOUT_MS);
    }
  }

  /** Schließt Verbindungen, die sich nicht rechtzeitig angemeldet haben. */
  async alarm() {
    let pending = false;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.authed) continue;
      if (Date.now() - (attachment?.at ?? 0) >= AUTH_TIMEOUT_MS) {
        socket.close(4001, "Anmeldung erforderlich.");
      } else {
        pending = true;
      }
    }
    if (pending) await this.ctx.storage.setAlarm(Date.now() + 2_000);
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
      await this.authenticate(socket, parsed.message.token);
      return;
    }

    switch (parsed.message.type) {
      case "chat":
        this.broadcast({
          type: "chat",
          from: attachment.name,
          userId: attachment.userId,
          text: parsed.message.text
        });
        break;
      case "draw": {
        const result = drawCard(this.room, attachment.userId, randomUnit);
        if (!result.ok) {
          this.send(socket, { type: "error", message: result.error });
          break;
        }
        await this.ctx.storage.put("room", this.room);
        this.broadcastViews();
        break;
      }
      default:
        this.send(socket, { type: "error", message: "Nicht erlaubt." });
    }
  }

  async authenticate(socket, token) {
    let claims;
    try {
      claims = await verifySupabaseJwt(token, this.env);
    } catch {
      this.send(socket, { type: "error", message: "Anmeldung fehlgeschlagen." });
      socket.close(4001, "Anmeldung fehlgeschlagen.");
      return;
    }

    const userId = claims.sub;
    const joined = joinPlayer(this.room, userId, displayNameFromClaims(claims));
    if (!joined.ok) {
      this.send(socket, { type: "error", message: joined.error });
      socket.close(4002, joined.error);
      return;
    }

    // Neue Verbindung desselben Nutzers ersetzt die alte (z. B. nach Netzwechsel).
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket && other.deserializeAttachment()?.userId === userId) {
        other.close(4000, "Neue Verbindung.");
      }
    }

    socket.serializeAttachment({
      authed: true,
      userId,
      name: this.room.players[userId].name,
      at: Date.now()
    });
    if (joined.changed) await this.ctx.storage.put("room", this.room);

    this.send(socket, { type: "welcome", userId, roomCode: this.room.roomCode });
    this.broadcastViews();
  }

  webSocketClose(socket, code) {
    this.limiters.delete(socket);
    try {
      socket.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "Tschüss");
    } catch {
      // bereits geschlossen
    }
    this.broadcastViews(socket);
  }

  webSocketError(socket) {
    this.limiters.delete(socket);
    this.broadcastViews(socket);
  }

  send(socket, data) {
    try {
      socket.send(JSON.stringify(data));
    } catch {
      // Verbindung bereits weg
    }
  }

  authedSockets(except) {
    return this.ctx
      .getWebSockets()
      .filter(socket => socket !== except && socket.deserializeAttachment()?.authed);
  }

  broadcast(data, except) {
    for (const socket of this.authedSockets(except)) this.send(socket, data);
  }

  /** Sendet jedem angemeldeten Spieler seine eigene Sicht. */
  broadcastViews(except) {
    const sockets = this.authedSockets(except);
    const onlineIds = sockets.map(socket => socket.deserializeAttachment().userId);
    for (const socket of sockets) {
      const { userId } = socket.deserializeAttachment();
      this.send(socket, {
        type: "view",
        instance: this.instanceId,
        view: buildView(this.room, userId, onlineIds)
      });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "arcane-decksmith-game" });
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9]+)$/);
    if (!match) return json({ error: "Nicht gefunden." }, 404);

    const allowed = allowedOrigins(env);
    if (allowed.length === 0) {
      return json({ error: "Der Worker ist nicht konfiguriert (ALLOWED_ORIGINS fehlt)." }, 500);
    }

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

    return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code)).fetch(request);
  }
};
