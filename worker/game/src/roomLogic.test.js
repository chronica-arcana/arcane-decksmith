import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  ROOM_TTL_MS,
  addPlayer,
  canStart,
  createRoom,
  generateRoomCode,
  isExpired,
  removePlayer,
  resolveMaxPlayers,
  roomInfo,
  roomView,
  setReady,
  startGame
} from "./roomLogic.js";

const deck = (name = "Deck", cardCount = 100) => ({ deckId: `d-${name}`, name, totalCards: cardCount, main: [{ id: "geheim" }] });
const NOW = 1_000_000;

function room(format = "commander", maxPlayers) {
  return createRoom({ code: "ABC234", hostId: "h", hostName: "Hanna", format, maxPlayers, deck: deck("HostDeck"), now: NOW });
}

describe("Codes und Plätze", () => {
  it("erzeugt Codes aus dem erlaubten Alphabet in fester Länge", () => {
    const code = generateRoomCode(() => 0.5);
    expect(code).toHaveLength(CODE_LENGTH);
    expect([...code].every(char => CODE_ALPHABET.includes(char))).toBe(true);
    expect(generateRoomCode(() => 0)).toBe("A".repeat(CODE_LENGTH));
    expect(generateRoomCode(() => 0.999999)).toBe("9".repeat(CODE_LENGTH));
    expect(CODE_ALPHABET).not.toMatch(/[01OI]/);
  });

  it("begrenzt Plätze je Format", () => {
    expect(resolveMaxPlayers("standard", 4)).toBe(2);
    expect(resolveMaxPlayers("standard")).toBe(2);
    expect(resolveMaxPlayers("commander")).toBe(4);
    expect(resolveMaxPlayers("commander", 3)).toBe(3);
    expect(resolveMaxPlayers("commander", 9)).toBe(4);
    expect(resolveMaxPlayers("commander", 1)).toBe(2);
    expect(resolveMaxPlayers("commander", "x")).toBe(4);
  });
});

describe("Raum anlegen und Ablauf", () => {
  it("kann die Lebensdauer für Tests verkürzen", () => {
    const r = createRoom({ code: "ABC234", hostId: "h", hostName: "H", format: "standard", deck: deck(), now: NOW, ttlMs: 5000 });
    expect(r.expiresAt).toBe(NOW + 5000);
  });

  it("legt den Gastgeber auf Platz 1 und setzt den Ablauf auf 24 Stunden", () => {
    const r = room();
    expect(r.players.h).toMatchObject({ name: "Hanna", seat: 0, ready: false });
    expect(r.status).toBe("open");
    expect(r.expiresAt - r.createdAt).toBe(ROOM_TTL_MS);
    expect(ROOM_TTL_MS).toBe(24 * 3600 * 1000);
    expect(isExpired(r, NOW + ROOM_TTL_MS - 1)).toBe(false);
    expect(isExpired(r, NOW + ROOM_TTL_MS)).toBe(true);
  });
});

describe("addPlayer", () => {
  it("nimmt Spieler auf, erkennt Rückkehrer und erkennt volle Räume (Standard: 2)", () => {
    const r = room("standard");
    expect(addPlayer(r, { userId: "a", name: "Alice", deck: deck() }, NOW)).toMatchObject({ ok: true, seat: 1, already: false });
    expect(addPlayer(r, { userId: "a", name: "Alicia", deck: deck() }, NOW)).toMatchObject({ ok: true, seat: 1, already: true });
    expect(r.players.a.name).toBe("Alicia");
    expect(addPlayer(r, { userId: "b", name: "Bob", deck: deck() }, NOW)).toMatchObject({ ok: false, reason: "full" });
  });

  it("erlaubt im Commander bis zu 4 Spieler und füllt freie Plätze wieder auf", () => {
    const r = room("commander");
    for (const id of ["a", "b", "c"]) expect(addPlayer(r, { userId: id, name: id, deck: deck() }, NOW).ok).toBe(true);
    expect(addPlayer(r, { userId: "d", name: "d", deck: deck() }, NOW).reason).toBe("full");
    removePlayer(r, "b");
    expect(addPlayer(r, { userId: "d", name: "d", deck: deck() }, NOW).seat).toBe(2); // freier Platz von "b"
  });

  it("lehnt abgelaufene und bereits gestartete Räume ab", () => {
    const r = room();
    expect(addPlayer(r, { userId: "a", name: "A", deck: deck() }, NOW + ROOM_TTL_MS)).toMatchObject({ ok: false, reason: "expired" });
    addPlayer(r, { userId: "a", name: "A", deck: deck() }, NOW);
    setReady(r, "h", true);
    setReady(r, "a", true);
    startGame(r, "h");
    expect(addPlayer(r, { userId: "b", name: "B", deck: deck() }, NOW)).toMatchObject({ ok: false, reason: "started" });
    // Ein bereits aufgenommener Spieler darf zurückkehren.
    expect(addPlayer(r, { userId: "a", name: "A", deck: deck() }, NOW).ok).toBe(true);
  });
});

describe("removePlayer", () => {
  it("entfernt Spieler, setzt Bereit zurück und schließt den Raum, wenn der Gastgeber geht", () => {
    const r = room();
    addPlayer(r, { userId: "a", name: "A", deck: deck() }, NOW);
    addPlayer(r, { userId: "b", name: "B", deck: deck() }, NOW);
    setReady(r, "h", true);
    setReady(r, "a", true);

    expect(removePlayer(r, "b")).toEqual({ removed: true, closed: false, releasedIds: ["b"] });
    expect(Object.values(r.players).every(player => !player.ready)).toBe(true);
    expect(removePlayer(r, "unbekannt")).toEqual({ removed: false, closed: false, releasedIds: [] });

    const closing = removePlayer(r, "h");
    expect(closing.closed).toBe(true);
    expect(closing.releasedIds.sort()).toEqual(["a", "h"]);
  });
});

describe("Bereit und Start", () => {
  it("startet nur, wenn der Gastgeber startet, mindestens 2 Spieler da und alle bereit sind", () => {
    const r = room();
    expect(canStart(r, "h")).toMatchObject({ ok: false, error: expect.stringContaining("mindestens 2") });
    addPlayer(r, { userId: "a", name: "A", deck: deck() }, NOW);
    expect(canStart(r, "a")).toMatchObject({ ok: false, error: expect.stringContaining("Gastgeber") });
    expect(canStart(r, "h")).toMatchObject({ ok: false, error: expect.stringContaining("bereit") });
    setReady(r, "h", true);
    setReady(r, "a", true);
    expect(canStart(r, "h").ok).toBe(true);
    expect(startGame(r, "h").ok).toBe(true);
    expect(r.status).toBe("playing");
    expect(startGame(r, "h").ok).toBe(false);
    expect(setReady(r, "a", false)).toMatchObject({ ok: false });
    expect(setReady(room(), "fremd", true)).toMatchObject({ ok: false });
  });
});

describe("Sichten", () => {
  it("zeigt in der Rauminfo nur öffentliche Werte und nach Ablauf nichts", () => {
    const r = room();
    expect(roomInfo(r, NOW)).toEqual({
      code: "ABC234", format: "commander", status: "open", maxPlayers: 4, playerCount: 1, hostName: "Hanna", expiresAt: NOW + ROOM_TTL_MS
    });
    expect(roomInfo(r, NOW + ROOM_TTL_MS)).toBeNull();
    expect(roomInfo(null, NOW)).toBeNull();
  });

  it("zeigt den Raum ohne Kartenlisten der Decks und mit Online-Status", () => {
    const r = room();
    addPlayer(r, { userId: "a", name: "Alice", deck: deck("AliceDeck", 99) }, NOW);
    const view = roomView(r, "a", ["a"]);
    expect(view.you).toBe("a");
    expect(view.players.map(p => [p.name, p.isHost, p.online, p.deck])).toEqual([
      ["Hanna", true, false, { id: "d-HostDeck", name: "HostDeck", cardCount: 100 }],
      ["Alice", false, true, { id: "d-AliceDeck", name: "AliceDeck", cardCount: 99 }]
    ]);
    expect(JSON.stringify(view)).not.toContain("geheim");
    expect(JSON.stringify(view)).not.toContain("main");
  });
});

describe("Bot-Gegner", () => {
  it("besetzt den zweiten Platz, ist bereit und zählt als online", () => {
    const room = createRoom({ code: "ABC234", hostId: "u1", hostName: "Ich", format: "commander", maxPlayers: 4, deck: { deckId: "a", name: "A", totalCards: 100 }, botDeck: { deckId: "b", name: "B", totalCards: 100 }, now: 0 });
    expect(room.maxPlayers).toBe(2);
    const view = roomView(room, "u1", ["u1"]);
    const bot = view.players.find(player => player.bot);
    expect(bot).toMatchObject({ ready: true, online: true, seat: 1 });
    room.players.u1.ready = true;
    expect(canStart(room, "u1")).toEqual({ ok: true });
  });
});
