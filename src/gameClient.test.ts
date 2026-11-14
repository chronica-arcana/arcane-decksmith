import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectGame,
  describeClose,
  gameSocketUrl,
  normalizeRoomCode,
  parseServerMessage,
  randomRoomCode,
  type ConnectionStatus,
  type ServerMessage,
  type SocketFactory
} from "./gameClient";

class FakeSocket {
  static last: FakeSocket;
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as (event: unknown) => void]);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const Impl = FakeSocket as unknown as SocketFactory;

describe("Hilfsfunktionen", () => {
  it("baut WebSocket-Adressen", () => {
    expect(gameSocketUrl("https://spiel.example.workers.dev", "ab12cd")).toBe("wss://spiel.example.workers.dev/room/AB12CD");
    expect(gameSocketUrl("http://localhost:8788/", "abcd")).toBe("ws://localhost:8788/room/ABCD");
    expect(gameSocketUrl("wss://x.de/irgendein/pfad?token=1", "ABCD")).toBe("wss://x.de/room/ABCD");
    expect(gameSocketUrl("ftp://x.de", "ABCD")).toBeNull();
    expect(gameSocketUrl("kein url", "ABCD")).toBeNull();
    expect(gameSocketUrl("https://x.de", "ab")).toBeNull();
  });

  it("erzeugt und prüft Raumcodes", () => {
    const code = randomRoomCode();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(normalizeRoomCode(code)).toBe(code);
    expect(normalizeRoomCode("a b")).toBeNull();
  });

  it("beschreibt Schließcodes verständlich", () => {
    expect(describeClose(4002, "")).toBe("Der Raum ist voll.");
    expect(describeClose(4999, "Grund")).toBe("Grund");
    expect(describeClose(4999, "")).toContain("4999");
  });
});

describe("parseServerMessage", () => {
  it("liest bekannte Nachrichten und ignoriert Unbekanntes", () => {
    const view = { roomCode: "ABCD", you: "a", events: 1, players: [] };
    expect(parseServerMessage(JSON.stringify({ type: "welcome", userId: "a", roomCode: "ABCD" }))).toEqual({ type: "welcome", userId: "a", roomCode: "ABCD" });
    expect(parseServerMessage(JSON.stringify({ type: "view", view, instance: "x1" }))).toEqual({ type: "view", view, instance: "x1" });
    expect(parseServerMessage(JSON.stringify({ type: "chat", from: "bob", userId: "b", text: "hi" }))).toMatchObject({ type: "chat", text: "hi" });
    expect(parseServerMessage(JSON.stringify({ type: "error", message: "nein" }))).toEqual({ type: "error", message: "nein" });
    for (const bad of ["pong", "{", "null", '{"type":"view"}', '{"type":"welcome"}', '{"type":"x"}', 5, undefined]) {
      expect(parseServerMessage(bad)).toBeNull();
    }
  });
});

describe("connectGame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(token: string | null = "tok") {
    const statuses: ConnectionStatus[] = [];
    const messages: ServerMessage[] = [];
    const connection = connectGame({
      url: "wss://x/room/ABCD",
      getToken: async () => token,
      onStatus: status => statuses.push(status),
      onMessage: message => messages.push(message),
      WebSocketImpl: Impl
    });
    return { statuses, messages, connection, socket: FakeSocket.last };
  }

  it("meldet nach dem Öffnen mit dem Token an und hält die Verbindung am Leben", async () => {
    const { statuses, socket } = start();
    expect(statuses).toEqual([{ state: "connecting" }]);

    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toEqual([JSON.stringify({ type: "auth", token: "tok" })]);
    expect(statuses.at(-1)).toEqual({ state: "open" });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.sent.at(-1)).toBe("ping");
  });

  it("gibt Nachrichten weiter, ignoriert 'pong' und sendet nur bei offener Verbindung", async () => {
    const { messages, connection, socket } = start();
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    socket.emit("message", { data: "pong" });
    socket.emit("message", { data: JSON.stringify({ type: "error", message: "nein" }) });
    expect(messages).toEqual([{ type: "error", message: "nein" }]);

    connection.send({ type: "draw" });
    expect(socket.sent.at(-1)).toBe('{"type":"draw"}');

    socket.readyState = 3;
    const before = socket.sent.length;
    connection.send({ type: "draw" });
    expect(socket.sent).toHaveLength(before);
  });

  it("schließt ohne Token und meldet es", async () => {
    const { statuses, socket } = start(null);
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({ state: "closed", code: 4001, detail: "Du bist nicht angemeldet." });
    expect(socket.closedWith?.code).toBe(1000);
    expect(socket.sent).toHaveLength(0);
  });

  it("meldet Schließen und Fehler genau einmal und stoppt den Keepalive", async () => {
    const { statuses, socket } = start();
    socket.readyState = 1;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(0);

    socket.emit("close", { code: 4002, reason: "Der Raum ist voll." });
    socket.emit("error");
    const closed = statuses.filter(status => status.state === "closed");
    expect(closed).toEqual([{ state: "closed", code: 4002, detail: "Der Raum ist voll." }]);

    const sentBefore = socket.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sent).toHaveLength(sentBefore);
  });

  it("meldet einen nicht erreichbaren Server", () => {
    const { statuses, socket } = start();
    socket.emit("error");
    expect(statuses.at(-1)).toEqual({ state: "closed", code: 1006, detail: "Der Spiel-Server ist nicht erreichbar." });
  });
});
