/**
 * Client für den Spiel-Worker (Machbarkeitstest): WebSocket-Verbindung, Anmeldung mit dem
 * Supabase-Token als erste Nachricht (das Token steht nie in der Adresse) und Nachrichten-Parsing.
 */

export type GamePlayerView = {
  userId: string;
  name: string;
  seat: number;
  online: boolean;
  handCount: number;
  libraryCount: number;
  /** Nur bei der eigenen Sicht vorhanden. */
  hand?: string[];
};

export type GameView = {
  roomCode: string;
  you: string;
  events: number;
  players: GamePlayerView[];
};

export type ServerMessage =
  | { type: "welcome"; userId: string; roomCode: string }
  | { type: "view"; view: GameView; instance?: string }
  | { type: "chat"; from: string; userId: string; text: string }
  | { type: "error"; message: string };

export type ClientMessage = { type: "chat"; text: string } | { type: "draw" };

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "closed"; code: number; detail: string };

export const DEFAULT_GAME_WORKER_URL = "https://arcane-decksmith-game.arcane-decksmith-api.workers.dev";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEEPALIVE_MS = 25_000;

export function randomRoomCode(random: () => number = Math.random): string {
  return Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]).join("");
}

export function normalizeRoomCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

/** Baut die WebSocket-Adresse aus der Worker-Adresse (https → wss, http → ws). */
export function gameSocketUrl(baseUrl: string, roomCode: string): string | null {
  const code = normalizeRoomCode(roomCode);
  if (!code) return null;
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol === "https:" || url.protocol === "wss:") url.protocol = "wss:";
    else if (url.protocol === "http:" || url.protocol === "ws:") url.protocol = "ws:";
    else return null;
    url.pathname = `/room/${code}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Prüft eine Server-Nachricht und liefert `null` bei allem Unbekannten. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;

  switch (message.type) {
    case "welcome":
      return typeof message.userId === "string" && typeof message.roomCode === "string"
        ? { type: "welcome", userId: message.userId, roomCode: message.roomCode }
        : null;
    case "view": {
      const view = message.view as Partial<GameView> | undefined;
      return view && typeof view.roomCode === "string" && Array.isArray(view.players)
        ? {
            type: "view",
            view: view as GameView,
            ...(typeof message.instance === "string" ? { instance: message.instance } : {})
          }
        : null;
    }
    case "chat":
      return typeof message.from === "string" && typeof message.text === "string"
        ? { type: "chat", from: message.from, userId: String(message.userId ?? ""), text: message.text }
        : null;
    case "error":
      return typeof message.message === "string" ? { type: "error", message: message.message } : null;
    default:
      return null;
  }
}

const CLOSE_TEXTS: Record<number, string> = {
  1000: "Verbindung beendet.",
  4000: "Du hast dich an anderer Stelle neu verbunden.",
  4001: "Anmeldung abgelehnt oder zu spät.",
  4002: "Der Raum ist voll.",
  4003: "Ungültige Nachricht."
};

export function describeClose(code: number, reason: string): string {
  return CLOSE_TEXTS[code] ?? (reason || `Verbindung getrennt (Code ${code}).`);
}

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
};
export type SocketFactory = new (url: string) => SocketLike;

export type GameConnection = {
  send(message: ClientMessage): void;
  close(): void;
};

export function connectGame(options: {
  url: string;
  getToken: () => Promise<string | null>;
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  WebSocketImpl?: SocketFactory;
}): GameConnection {
  const Impl = options.WebSocketImpl ?? (WebSocket as unknown as SocketFactory);
  const socket = new Impl(options.url);
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  const finish = (status: ConnectionStatus) => {
    if (finished) return;
    finished = true;
    if (keepalive) clearInterval(keepalive);
    options.onStatus(status);
  };

  options.onStatus({ state: "connecting" });

  socket.addEventListener("open", (async () => {
    const token = await options.getToken().catch(() => null);
    if (!token) {
      finish({ state: "closed", code: 4001, detail: "Du bist nicht angemeldet." });
      socket.close(1000, "Nicht angemeldet");
      return;
    }
    socket.send(JSON.stringify({ type: "auth", token }));
    options.onStatus({ state: "open" });
    // "ping" wird vom Server beantwortet, ohne das Spielobjekt aufzuwecken.
    keepalive = setInterval(() => {
      if (socket.readyState === 1) socket.send("ping");
    }, KEEPALIVE_MS);
  }) as never);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    const message = parseServerMessage(event.data);
    if (message) options.onMessage(message);
  }) as never);

  socket.addEventListener("close", ((event: { code: number; reason: string }) => {
    finish({ state: "closed", code: event.code, detail: describeClose(event.code, event.reason) });
  }) as never);

  socket.addEventListener("error", (() => {
    finish({ state: "closed", code: 1006, detail: "Der Spiel-Server ist nicht erreichbar." });
  }) as never);

  return {
    send(message) {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    },
    close() {
      if (!finished) socket.close(1000, "Beendet");
    }
  };
}
