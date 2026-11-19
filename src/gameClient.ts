/**
 * Client für den Spiel-Worker (Machbarkeitstest): WebSocket-Verbindung, Anmeldung mit dem
 * Supabase-Token als erste Nachricht (das Token steht nie in der Adresse) und Nachrichten-Parsing.
 */

export type RoomFormat = "standard" | "commander";

export type DeckIssue = { code: string; message: string };

export type DeckCheck = {
  ok: boolean;
  errors: DeckIssue[];
  summary: { format: RoomFormat; mainCount: number; sideboardCount: number; commanderCount: number; totalCards: number };
};

/** Öffentliche Rauminfo (für den Beitritt per Code). */
export type RoomInfo = {
  code: string;
  format: RoomFormat;
  status: "open" | "playing";
  maxPlayers: number;
  playerCount: number;
  hostName: string;
  expiresAt: number;
  isHost?: boolean;
};

export type RoomPlayer = {
  userId: string;
  name: string;
  seat: number;
  ready: boolean;
  online: boolean;
  isHost: boolean;
  bot?: boolean;
  deck: { id: string; name: string; cardCount: number };
};

export type RoomView = {
  code: string;
  format: RoomFormat;
  status: "open" | "playing";
  maxPlayers: number;
  expiresAt: number;
  hostId: string;
  you: string;
  players: RoomPlayer[];
};

export type GameZone = "library" | "hand" | "battlefield" | "graveyard" | "exile" | "command";
export type PlayerCounterKind = "poison" | "energy" | "experience";

/** Gültige Ziele für eine Zielangabe eines Zaubers oder einer Fähigkeit (Karten-, Spieler- oder Stapel-IDs). */
export type TargetOption = { kind: string; options: string[] };

export type PayRequirement = { kind: "sacrifice" | "discard" | "life" | "tap" | "removeCounter" | "energy" | "removeAnyCounter"; what?: string; n: number | "X"; options: string[] };
export type CardAbility = { index: number; text: string; costLabel?: string; ok: boolean; pays?: PayRequirement[]; targets: TargetOption[]; manual: boolean };

export type GameCard = {
  id: string;
  owner: string;
  tapped: boolean;
  counters: Record<string, number>;
  token: boolean;
  faceDown: boolean;
  damage: number;
  /** Beschwörungsmüde: kann noch nicht angreifen oder {T}-Fähigkeiten nutzen. */
  sick: boolean;
  cmd: boolean;
  kind: "land" | "creature" | "other";
  attacking: boolean;
  chosenType?: string | null;
  goaded?: boolean;
  goadedBy?: string[];
  foretell?: { ok: boolean; cost: string } | null;
  evoke?: { ok: boolean; cost: string } | null;
  mutate?: { ok: boolean; cost: string; targets: { id: string; name: string }[] } | null;
  mutated?: number;
  attachedTo?: string | null;
  attachedName?: string | null;
  attachments?: string[];
  /** ID des angegriffenen Angreifers, den diese Karte blockt. */
  blocking: string | null;
  /** Fehlen bei verdeckten Karten anderer Spieler. */
  name?: string;
  typeLine?: string;
  manaValue?: number;
  manaCost?: string;
  imageUri?: string | null;
  keywords?: string[];
  power?: number | null;
  toughness?: number | null;
  mana?: boolean;
  /** Farben, die diese Manaquelle erzeugen kann. */
  manaColors?: string[];
  /** Nur für eigene Karten: Was ist jetzt möglich? */
  play?: { kind: "land" | "spell"; ok: boolean; timingOk?: boolean; pays?: PayRequirement[]; targets?: TargetOption[]; modes?: { label: string; summary?: string; targets: TargetOption[]; manual: boolean }[]; modeCount?: { min: number; max: number }; manual?: boolean } | null;
  /** Cycling aus der Hand (falls die Karte es hat). */
  cycle?: { ok: boolean; cost: string; search: string | null } | null;
  /** Nur eigene Karten auf dem Schlachtfeld: aktivierbare Fähigkeiten laut Kartentext. */
  abilities?: CardAbility[];
  /** Textteile, die das Spiel nicht automatisch behandelt (z. B. Dauereffekte). */
  rulesNotes?: string[];
};

export type ManaPool = Record<"W" | "U" | "B" | "R" | "G" | "C", number>;

export type GamePlayer = {
  userId: string;
  name: string;
  deckName?: string;
  life: number;
  poison: number;
  energy: number;
  experience: number;
  eliminated: string | null;
  mulligans: number;
  kept: boolean;
  pool: ManaPool;
  /** Nachfragen, wenn ich auf einen Zauber des Gegners antworten kann. */
  askResponse?: boolean;
  /** Karte zu Zugbeginn automatisch ziehen. */
  autoStart?: boolean;
  prompts: { type: "commander"; id: string }[];
  counts: Record<GameZone, number>;
  /** Eigene Hand komplett, bei anderen nur gezeigte Karten. */
  hand: GameCard[];
  battlefield: GameCard[];
  graveyard: GameCard[];
  exile: GameCard[];
  command: GameCard[];
  /** Nur für den Besitzer: gerade angesehene Bibliothekskarten (oberste zuerst). */
  looking: GameCard[] | null;
  cmdDamage: Record<string, number>;
  cmdCasts: Record<string, number>;
};

export type GameLogLine = { n: number; text: string };

export type StackItem = { sid: string; controller: string; kind: "spell" | "ability"; text: string; sourceName?: string; card: GameCard | null };

export type GameStep = "draw" | "main1" | "attackers" | "blockers" | "damage" | "main2" | "end";

export type GameView = {
  format: RoomFormat;
  phase: "mulligan" | "playing" | "ended";
  you: string;
  turn: {
    number: number;
    active: string | null;
    phase: GameStep;
    first: string | null;
    landsPlayed: number;
    /** Der aktive Spieler zieht seine Karte selbst (Bibliothek anklicken). */
    manualStart?: boolean;
    drawn?: boolean;
    /** Zeitpunkt des Spielbeginns (für den Münzwurf). */
    beganAt?: number;
    drawBlocked?: boolean;
    /** Zu Beginn des Zuges wurde automatisch eine Karte gezogen. */
    drew?: boolean;
  };
  priority: string | null;
  stack: StackItem[];
  combat: { attackers: { id: string; target: string }[]; blocks: { blocker: string; attacker: string }[]; awaiting: string[] } | null;
  pendingDiscard: { userId: string; count: number } | null;
  /** Kurzlebige Anzeige-Effekte (Schaden, Heilung); `id` steigt fortlaufend. */
  fx: { id: number; type: "damage" | "heal"; amount: number; card?: string; player?: string }[];
  /** Offene Auswahl (Ziel, Karten abwerfen/suchen/wühlen). Die Optionen sieht nur, wer wählt. */
  choice: {
    userId: string;
    kind: "targets" | "cards" | "yesno";
    prompt: string;
    min: number;
    max: number;
    options: { id: string; card?: GameCard | null; player?: { userId: string; name: string }; spell?: boolean; label?: string }[];
  } | null;
  /** Ein Kartentext, den das Spiel nicht umsetzen kann: Nur dieser Spieler darf jetzt von Hand eingreifen. */
  manual: { userId: string; text: string; source: string; hints?: { label: string; action?: GameAction; repeat?: number }[]; cardId?: string | null; imageUri?: string | null } | null;
  monarch?: string | null;
  winner: string | null;
  startedAt: number;
  endedAt: number | null;
  players: GamePlayer[];
  log: GameLogLine[];
};

export type GameAction =
  | { type: "keep"; bottom?: string[] }
  | { type: "mulligan" }
  | { type: "draw"; count?: number }
  | { type: "mill"; count?: number }
  | { type: "shuffle" }
  | { type: "look"; count: number | "all" }
  | { type: "closeLook" }
  | { type: "move"; id: string; to: GameZone; position?: "top" | "bottom"; faceDown?: boolean }
  | { type: "tap"; id: string; tapped?: boolean }
  | { type: "untapAll" }
  | { type: "flip"; id: string }
  | { type: "reveal"; id: string }
  | { type: "counter"; id: string; kind: string; delta: number }
  | { type: "token"; name: string }
  | { type: "life"; delta?: number; set?: number }
  | { type: "pcounter"; kind: PlayerCounterKind; delta: number }
  | { type: "cmddmg"; from: string; delta: number }
  | { type: "dice"; sides: number }
  | { type: "coin" }
  | { type: "askResponse"; value: boolean }
  | { type: "autoStart"; value: boolean }
  | { type: "drawStep" }
  | { type: "tapMana"; id: string; color?: string }
  | { type: "pool"; color: "W" | "U" | "B" | "R" | "G" | "C"; delta: number }
  | { type: "playLand"; id: string }
  | { type: "cast"; id: string; x?: number; free?: boolean; targets?: string[]; mode?: number; tap?: string[]; pay?: string[]; evoke?: boolean; mutate?: string; over?: boolean; modes?: number[] }
  | { type: "cycle"; id: string; tap?: string[] }
  | { type: "foretell"; id: string; tap?: string[] }
  | { type: "damage"; id: string; delta: number }
  | { type: "moveOther"; id: string; to: "graveyard" | "exile" | "hand" }
  | { type: "activate"; id: string; index: number; targets?: string[]; tap?: string[]; pay?: string[] }
  | { type: "choose"; ids: string[] }
  | { type: "manualDone" }
  | { type: "ability"; text: string }
  | { type: "pass" }
  | { type: "counterSpell"; sid: string }
  | { type: "declareAttackers"; attackers: { id: string; target?: string }[] }
  | { type: "declareBlockers"; blocks: { blocker: string; attacker: string }[] }
  | { type: "endTurn" }
  | { type: "discard"; ids: string[] }
  | { type: "commanderZone"; id: string; yes: boolean }
  | { type: "concede" };

export type HistoryEntry = {
  id: string;
  code: string;
  format: RoomFormat;
  aborted: boolean;
  winner: string | null;
  won: boolean;
  turns: number;
  startedAt: number;
  endedAt: number;
  players: { userId: string; name: string; deckName: string; eliminated: string | null; life: number }[];
};

export type ServerMessage =
  | { type: "game"; game: GameView }
  | { type: "welcome"; userId: string; code: string }
  | { type: "room"; room: RoomView; instance?: string }
  | { type: "chat"; from: string; userId: string; text: string }
  | { type: "system"; text: string }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "rematch" }
  | { type: "sync" }
  | { type: "game"; action: GameAction };

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "open" }
  | { state: "closed"; code: number; detail: string };

export const DEFAULT_GAME_WORKER_URL = "https://arcane-decksmith-game.arcane-decksmith-api.workers.dev";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEEPALIVE_MS = 12_000;
/** Kommt so lange gar nichts mehr vom Server (auch kein „pong“), gilt die Verbindung als tot (z. B. Handy im Standby) und wird neu aufgebaut. */
const DEAD_AFTER_MS = 40_000;

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
      return typeof message.userId === "string" && typeof message.code === "string"
        ? { type: "welcome", userId: message.userId, code: message.code }
        : null;
    case "room": {
      const room = message.room as Partial<RoomView> | undefined;
      return room && typeof room.code === "string" && Array.isArray(room.players)
        ? {
            type: "room",
            room: room as RoomView,
            ...(typeof message.instance === "string" ? { instance: message.instance } : {})
          }
        : null;
    }
    case "game": {
      const game = message.game as Partial<GameView> | undefined;
      return game && Array.isArray(game.players) && typeof game.phase === "string" ? { type: "game", game: game as GameView } : null;
    }
    case "chat":
      return typeof message.from === "string" && typeof message.text === "string"
        ? { type: "chat", from: message.from, userId: String(message.userId ?? ""), text: message.text }
        : null;
    case "system":
      return typeof message.text === "string" ? { type: "system", text: message.text } : null;
    case "closed":
      return typeof message.reason === "string" ? { type: "closed", reason: message.reason } : null;
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
  4003: "Ungültige Nachricht.",
  4004: "Du bist kein Mitglied dieses Raums.",
  4005: "Du bist nicht mehr im Raum.",
  4006: "Der Raum wurde geschlossen."
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
  let lastHeard = Date.now();

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
    lastHeard = Date.now();
    keepalive = setInterval(() => {
      if (Date.now() - lastHeard > DEAD_AFTER_MS) {
        finish({ state: "closed", code: 1006, detail: "Die Verbindung zum Spiel-Server ist abgebrochen." });
        try {
          socket.close(1000, "Zeitüberschreitung");
        } catch {
          // bereits geschlossen
        }
        return;
      }
      if (socket.readyState === 1) socket.send("ping");
    }, KEEPALIVE_MS);
  }) as never);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    lastHeard = Date.now();
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

// ---------------------------------------------------------------------------
// HTTP-Schnittstelle des Spiel-Workers
// ---------------------------------------------------------------------------

/** Fehler der Schnittstelle; `errors` enthält bei ungültigen Decks die einzelnen Hinweise. */
export class GameApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors: DeckIssue[] = [],
    public code?: string
  ) {
    super(message);
    this.name = "GameApiError";
  }
}

export type GameApi = ReturnType<typeof createGameApi>;

export function createGameApi(options: {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  const base = options.baseUrl.trim().replace(/\/+$/, "").replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = await options.getToken();
    if (!token) throw new GameApiError("Du bist nicht angemeldet.", 401);

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new GameApiError("Der Spiel-Server ist nicht erreichbar.", 0);
    }

    const data = (await response.json().catch(() => null)) as
      | (T & { error?: string; errors?: DeckIssue[]; code?: string })
      | null;
    if (!response.ok) {
      throw new GameApiError(data?.error ?? `Anfrage fehlgeschlagen (${response.status}).`, response.status, data?.errors ?? [], data?.code);
    }
    return data as T;
  }

  return {
    checkDeck: (deckId: string, format: RoomFormat) => call<DeckCheck>("POST", "/api/decks/check", { deckId, format }),
    getMyRoom: async () => (await call<{ room: RoomInfo | null }>("GET", "/api/rooms/mine")).room,
    getRoomInfo: async (code: string) => (await call<{ room: RoomInfo }>("GET", `/api/rooms/${encodeURIComponent(code)}`)).room,
    createRoom: (input: { format: RoomFormat; deckId: string; maxPlayers?: number; botDeckId?: string }) =>
      call<{ code: string; expiresAt: number }>("POST", "/api/rooms", input),
    joinRoom: (input: { code: string; deckId: string }) => call<{ code: string }>("POST", "/api/rooms/join", input),
    leaveRoom: () => call<{ ok: true }>("POST", "/api/rooms/leave", {}),
    /** Beim Schließen von Tab oder Fenster: Der Token muss schon vorliegen, die Anfrage überlebt das Entladen der Seite (keepalive). */
    leaveRoomOnUnload: (token: string) => {
      try {
        void doFetch(`${base}/api/rooms/leave`, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).catch(() => undefined);
      } catch {
        // Beim Schließen gibt es nichts mehr zu melden.
      }
    },
    getHistory: async () => (await call<{ entries: HistoryEntry[] }>("GET", "/api/history")).entries,
    kickPlayer: (userId: string) => call<{ ok: true }>("POST", "/api/rooms/kick", { userId })
  };
}
