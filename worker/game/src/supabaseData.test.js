import { describe, expect, it, vi } from "vitest";
import { DataError, fetchProfileName, fetchUserCollection, fetchUserDeck } from "./supabaseData.js";

const env = { SUPABASE_URL: "https://abcd.supabase.co/", SUPABASE_ANON_KEY: "anon-key" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe("fetchUserDeck", () => {
  it("fragt mit Nutzer-Token und anon-Schlüssel ab und maskiert Parameter", async () => {
    const fetchImpl = vi.fn(async () => reply([{ data: { id: "d1" } }]));
    const deck = await fetchUserDeck(env, "TOKEN", "user-1", "deck/mit sonderzeichen", fetchImpl);
    expect(deck).toEqual({ id: "d1" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://abcd.supabase.co/rest/v1/decks?select=data&user_id=eq.user-1&deck_id=eq.deck%2Fmit%20sonderzeichen&limit=1");
    expect(init.headers).toMatchObject({ apikey: "anon-key", Authorization: "Bearer TOKEN" });
  });

  it("liefert null, wenn es das Deck nicht gibt", async () => {
    expect(await fetchUserDeck(env, "T", "u", "d", async () => reply([]))).toBeNull();
  });

  it("meldet Konfigurations- und Datenbankfehler", async () => {
    await expect(fetchUserDeck({ SUPABASE_URL: "https://x" }, "T", "u", "d", async () => reply([]))).rejects.toMatchObject({ name: "DataError", status: 500 });
    await expect(fetchUserDeck(env, "T", "u", "d", async () => reply({}, 401))).rejects.toBeInstanceOf(DataError);
    await expect(fetchUserDeck(env, "T", "u", "d", async () => reply({ kein: "array" }))).rejects.toThrow("Unerwartete Antwort");
    await expect(fetchUserDeck(env, "T", "u", "d", async () => { throw new Error("offline"); })).rejects.toThrow("nicht erreichbar");
  });
});

describe("fetchUserCollection", () => {
  it("liest die Sammlung seitenweise bis eine Seite nicht mehr voll ist", async () => {
    const pages = [
      Array.from({ length: 1000 }, (_, i) => ({ data: { id: `a${i}` } })),
      Array.from({ length: 1000 }, (_, i) => ({ data: { id: `b${i}` } })),
      [{ data: { id: "c0" } }, { data: null }]
    ];
    const ranges = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      ranges.push(init.headers.Range);
      return reply(pages.shift());
    });
    const cards = await fetchUserCollection(env, "T", "u", fetchImpl);
    expect(cards).toHaveLength(2001);
    expect(ranges).toEqual(["0-999", "1000-1999", "2000-2999"]);
  });

  it("bricht bei unrealistisch großen Sammlungen ab", async () => {
    const full = Array.from({ length: 1000 }, () => ({ data: { id: "x" } }));
    await expect(fetchUserCollection(env, "T", "u", async () => reply(full))).rejects.toMatchObject({ status: 413 });
  });
});

describe("fetchProfileName", () => {
  it("liefert den Anzeigenamen oder null (auch bei Fehlern)", async () => {
    expect(await fetchProfileName(env, "T", "u", async () => reply([{ display_name: "Alice" }]))).toBe("Alice");
    expect(await fetchProfileName(env, "T", "u", async () => reply([]))).toBeNull();
    expect(await fetchProfileName(env, "T", "u", async () => reply([{ display_name: null }]))).toBeNull();
    expect(await fetchProfileName(env, "T", "u", async () => reply({}, 500))).toBeNull();
  });
});
