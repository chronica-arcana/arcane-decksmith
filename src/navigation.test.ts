import { describe, expect, it } from "vitest";
import {
  APP_NAV_ITEMS,
  APP_PAGE_HASHES,
  appLocationFromHash,
  appPageFromHash,
  appPageHref,
  deckHref
} from "./navigation";

describe("navigation", () => {
  it("maps every app page to its hash", () => {
    for (const [page, hash] of Object.entries(APP_PAGE_HASHES)) {
      expect(appPageHref(page as keyof typeof APP_PAGE_HASHES)).toBe(hash);
      expect(appPageFromHash(hash)).toBe(page);
    }
  });

  it("lists the game page in the navigation", () => {
    expect(APP_NAV_ITEMS).toContainEqual({ page: "game", label: "Spielen" });
  });

  it("recognizes home aliases", () => {
    expect(appPageFromHash("")).toBe("home");
    expect(appPageFromHash("#")).toBe("home");
    expect(appPageFromHash("#/home")).toBe("home");
  });

  it("recognizes deck detail routes", () => {
    const id = "deck id/with symbols";
    const hash = deckHref(id);
    expect(hash).toBe("#/decks/deck%20id%2Fwith%20symbols");
    expect(appLocationFromHash(hash)).toEqual({
      page: "decks",
      deckId: id
    });
    expect(appPageFromHash(hash)).toBe("decks");
  });

  it("rejects unknown routes", () => {
    expect(appLocationFromHash("#/unknown")).toBeNull();
  });
});
