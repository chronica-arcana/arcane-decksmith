import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_LENGTH,
  RateLimiter,
  allowedOrigins,
  cleanName,
  displayName,
  normalizeRoomCode,
  parseClientMessage
} from "./protocol.js";

describe("parseClientMessage", () => {
  it("akzeptiert gültige Nachrichten und kürzt Chattexte", () => {
    expect(parseClientMessage('{"type":"auth","token":"abc"}')).toEqual({ ok: true, message: { type: "auth", token: "abc" } });
    expect(parseClientMessage('{"type":"ready","ready":true}')).toEqual({ ok: true, message: { type: "ready", ready: true } });
    expect(parseClientMessage('{"type":"ready","ready":false}').message.ready).toBe(false);
    expect(parseClientMessage('{"type":"start"}')).toEqual({ ok: true, message: { type: "start" } });
    expect(parseClientMessage('{"type":"rematch"}')).toEqual({ ok: true, message: { type: "rematch" } });
    expect(parseClientMessage('{"type":"game","action":{"type":"draw","count":2}}')).toEqual({
      ok: true,
      message: { type: "game", action: { type: "draw", count: 2 } }
    });
    for (const bad of ['{"type":"game"}', '{"type":"game","action":[]}', '{"type":"game","action":{"count":1}}']) {
      expect(parseClientMessage(bad).ok).toBe(false);
    }
    const long = parseClientMessage(JSON.stringify({ type: "chat", text: `  ${"x".repeat(1000)}  ` }));
    expect(long.ok).toBe(true);
    expect(long.message.text).toHaveLength(MAX_CHAT_LENGTH);
  });

  it("lehnt ungültige Eingaben ab", () => {
    for (const raw of [
      "kein json", "[]", "null", '"text"', '{"type":"x"}', '{"type":"chat","text":"   "}', '{"type":"draw"}',
      '{"type":"auth"}', '{"type":"auth","token":""}', '{"type":"ready"}', '{"type":"ready","ready":"ja"}',
      JSON.stringify({ type: "chat", text: "a".repeat(5000) })
    ]) {
      expect(parseClientMessage(raw).ok, raw.slice(0, 40)).toBe(false);
    }
    expect(parseClientMessage(new ArrayBuffer(4)).ok).toBe(false);
  });
});

describe("Namen", () => {
  it("bereinigt Namen und nutzt Profilnamen vor dem E-Mail-Vorderteil", () => {
    expect(cleanName("  <b>Ali</b> ce  ")).toBe("bAlib ce");
    expect(cleanName(42)).toBe("");
    expect(displayName("Alice", { email: "x@y.de" })).toBe("Alice");
    expect(displayName("", { email: "player1@arcane-decksmith.com" })).toBe("player1");
    expect(displayName("A", { email: "player1@arcane-decksmith.com" })).toBe("player1"); // zu kurz
    expect(displayName(null, {})).toBe("Spieler");
    expect(displayName(null, { email: "a".repeat(80) + "@x.de" })).toHaveLength(30);
  });
});

describe("RateLimiter", () => {
  it("lässt einen Schwall zu, bremst danach und füllt sich über die Zeit wieder", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 2, () => now);
    expect(Array.from({ length: 5 }, () => limiter.allow())).toEqual([true, true, true, true, true]);
    expect(limiter.allow()).toBe(false);
    now += 1000;
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now += 60_000;
    expect(Array.from({ length: 5 }, () => limiter.allow()).every(Boolean)).toBe(true);
    expect(limiter.allow()).toBe(false);
  });
});

describe("Origins und Raumcodes", () => {
  it("liest Origins und Raumcodes", () => {
    expect(allowedOrigins({ ALLOWED_ORIGINS: " https://a.de/ , http://localhost:5173 ,," })).toEqual(["https://a.de", "http://localhost:5173"]);
    expect(allowedOrigins({})).toEqual([]);
    expect(normalizeRoomCode(" ab12cd ")).toBe("AB12CD");
    for (const bad of ["abc", "ab cd", "a".repeat(13), "ab/cd", "", null]) expect(normalizeRoomCode(bad)).toBeNull();
  });
});
