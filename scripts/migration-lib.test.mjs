import { describe, expect, it } from "vitest";
import { cardRow, chunk, deckRow, listingRow, normalizeEmail, profileRow, toPlainJson } from "./migration-lib.mjs";

describe("migration-lib", () => {
  it("teilt in Blöcke", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it("normalisiert E-Mails", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(normalizeEmail(undefined)).toBe("");
  });

  it("wandelt Firestore-Zeitstempel und undefined in reines JSON um", () => {
    const json = toPlainJson({ a: undefined, b: 1, c: { toMillis: () => 42 }, d: [undefined] });
    expect(json).toEqual({ b: 1, c: 42, d: [null] });
  });

  it("baut Zeilen für Karten, Decks und Profile", () => {
    expect(cardRow("u", "c1", { id: "c1" })).toEqual({ user_id: "u", card_id: "c1", data: { id: "c1" } });
    expect(deckRow("u", "d1", { id: "d1" })).toEqual({ user_id: "u", deck_id: "d1", data: { id: "d1" } });
    expect(profileRow("u", { email: "A@B.de", displayName: " ", updatedAt: 5 })).toEqual({
      user_id: "u", email: "a@b.de", display_name: null, updated_at: 5
    });
    expect(profileRow("u", { email: "a@b.de", displayName: "Alice" }).display_name).toBe("Alice");
  });

  it("ersetzt die Firebase-UID in Angeboten und überspringt unbekannte Besitzer", () => {
    const map = new Map([["fb-1", "sb-1"]]);
    const row = listingRow("fb-1_c1", { id: "fb-1_c1", ownerId: "fb-1", cardId: "c1", name: "Sol Ring" }, map);
    expect(row).toEqual({
      id: "sb-1_c1",
      owner_id: "sb-1",
      legacyId: "fb-1_c1",
      data: { ownerId: "sb-1", cardId: "c1", name: "Sol Ring" }
    });
    expect(listingRow("x", { ownerId: "unbekannt", cardId: "c" }, map)).toBeNull();
    expect(listingRow("x", { ownerId: "fb-1" }, map)).toBeNull();
  });
});
