import { describe, expect, it } from "vitest";
import {
  DEMO_DECK,
  MAX_CHAT_LENGTH,
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

/** Deterministische „Zufallszahlen“ für reproduzierbare Tests. */
function seeded(seed = 1) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

describe("parseClientMessage", () => {
  it("akzeptiert gültige Nachrichten und kürzt Chattexte", () => {
    expect(parseClientMessage('{"type":"auth","token":"abc"}')).toEqual({ ok: true, message: { type: "auth", token: "abc" } });
    expect(parseClientMessage('{"type":"draw"}')).toEqual({ ok: true, message: { type: "draw" } });
    const long = parseClientMessage(JSON.stringify({ type: "chat", text: `  ${"x".repeat(1000)}  ` }));
    expect(long.ok).toBe(true);
    expect(long.message.text).toHaveLength(MAX_CHAT_LENGTH);
  });

  it("lehnt ungültige Eingaben ab", () => {
    for (const raw of [
      "kein json", "[]", "null", '"text"', '{"type":"x"}', '{"type":"chat","text":"   "}',
      '{"type":"auth"}', '{"type":"auth","token":""}', JSON.stringify({ type: "chat", text: "a".repeat(5000) })
    ]) {
      expect(parseClientMessage(raw).ok, raw.slice(0, 40)).toBe(false);
    }
    expect(parseClientMessage(new ArrayBuffer(4)).ok).toBe(false);
  });
});

describe("joinPlayer", () => {
  it("vergibt Plätze, erkennt Rückkehrer und begrenzt auf 4 Spieler", () => {
    const state = createRoomState("ABCD");
    expect(joinPlayer(state, "a", "Alice")).toEqual({ ok: true, seat: 0, changed: true });
    expect(joinPlayer(state, "b", "Bob").seat).toBe(1);
    expect(joinPlayer(state, "a", "Alice")).toEqual({ ok: true, seat: 0, changed: false });
    expect(joinPlayer(state, "a", "Alicia").changed).toBe(true);
    joinPlayer(state, "c", "Carol");
    joinPlayer(state, "d", "Dave");
    expect(Object.keys(state.players)).toHaveLength(MAX_PLAYERS);
    expect(joinPlayer(state, "e", "Eve")).toEqual({ ok: false, error: "Der Raum ist voll." });
  });
});

describe("drawCard / buildView (versteckte Informationen)", () => {
  it("zieht ohne Duplikate bis die Bibliothek leer ist", () => {
    const state = createRoomState("ABCD");
    joinPlayer(state, "a", "Alice");
    const random = seeded(7);
    const drawn = [];
    for (let i = 0; i < DEMO_DECK.length; i += 1) drawn.push(drawCard(state, "a", random).card);
    expect(new Set(drawn).size).toBe(DEMO_DECK.length);
    expect(drawCard(state, "a", random)).toEqual({ ok: false, error: "Die Bibliothek ist leer." });
    expect(state.events).toBe(DEMO_DECK.length);
  });

  it("mischt reproduzierbar mit demselben Zufall und verschieden mit anderem", () => {
    const run = (seed) => {
      const state = createRoomState("ABCD");
      joinPlayer(state, "a", "Alice");
      return [drawCard(state, "a", seeded(seed)).card, ...Array.from({ length: 4 }, () => drawCard(state, "a", seeded(seed)).card)];
    };
    expect(run(3)).toEqual(run(3));
  });

  it("verweigert Ziehen ohne Raumplatz", () => {
    expect(drawCard(createRoomState("ABCD"), "x", seeded()).ok).toBe(false);
  });

  it("zeigt jedem nur die eigene Hand und nie die Bibliothek", () => {
    const state = createRoomState("ABCD");
    joinPlayer(state, "a", "Alice");
    joinPlayer(state, "b", "Bob");
    drawCard(state, "a", seeded(1));
    drawCard(state, "a", seeded(2));
    drawCard(state, "b", seeded(3));

    const forA = buildView(state, "a", ["a", "b"]);
    const forB = buildView(state, "b", ["b"]);

    expect(forA.players[0].hand).toHaveLength(2);
    expect(forA.players[1].hand).toBeUndefined();
    expect(forA.players[1].handCount).toBe(1);
    expect(forB.players[0].hand).toBeUndefined();
    expect(forB.players[0].handCount).toBe(2);
    expect(forB.players[0].online).toBe(false);
    expect(forB.players[1].online).toBe(true);

    // Beide Spieler nutzen im Demo denselben Stapel; geprüft wird daher Alices Eintrag in Bobs Sicht.
    expect(JSON.stringify([forA, forB])).not.toContain('"library"');
    const aliceInBobsView = JSON.stringify(forB.players[0]);
    for (const card of [...state.players.a.library, ...state.players.a.hand]) {
      expect(aliceInBobsView).not.toContain(`"${card}"`);
    }
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

describe("Hilfsfunktionen", () => {
  it("bildet Anzeigenamen nur aus dem Vorderteil der E-Mail", () => {
    expect(displayNameFromClaims({ email: "player1@arcane-decksmith.com" })).toBe("player1");
    expect(displayNameFromClaims({ email: "<b>x</b>@a.de" })).toBe("bxb");
    expect(displayNameFromClaims({})).toBe("Spieler");
    expect(displayNameFromClaims({ email: "a".repeat(80) + "@x.de" })).toHaveLength(30);
  });

  it("liest Origins und Raumcodes", () => {
    expect(allowedOrigins({ ALLOWED_ORIGINS: " https://a.de/ , http://localhost:5173 ,," })).toEqual(["https://a.de", "http://localhost:5173"]);
    expect(allowedOrigins({})).toEqual([]);
    expect(normalizeRoomCode(" ab12cd ")).toBe("AB12CD");
    for (const bad of ["abc", "ab cd", "a".repeat(13), "ab/cd", "", null]) expect(normalizeRoomCode(bad)).toBeNull();
  });
});
