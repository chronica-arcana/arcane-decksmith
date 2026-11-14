import { useCallback, useEffect, useState } from "react";

export type AppPage =
  | "home"
  | "collection"
  | "search"
  | "builder"
  | "decks"
  | "marketplace"
  | "gametest";

export const APP_PAGE_HASHES: Record<AppPage, string> = {
  home: "#/",
  collection: "#/collection",
  search: "#/search",
  builder: "#/build",
  decks: "#/decks",
  marketplace: "#/marketplace",
  // Versteckt: nicht im Menü, nur über die Adresse erreichbar (Machbarkeitstest Online-Spiel).
  gametest: "#/spieltest"
};

export const APP_NAV_ITEMS: Array<{
  page: AppPage;
  label: string;
}> = [
  { page: "home", label: "Start" },
  { page: "collection", label: "Sammlung" },
  { page: "search", label: "Kartensuche" },
  { page: "builder", label: "Deck bauen" },
  { page: "decks", label: "Decks" },
  { page: "marketplace", label: "Marketplace" }
];

const PAGE_TITLES: Record<AppPage, string> = {
  home: "Arcane Decksmith",
  collection: "Sammlung · Arcane Decksmith",
  search: "Kartensuche · Arcane Decksmith",
  builder: "Deck bauen · Arcane Decksmith",
  decks: "Decks · Arcane Decksmith",
  marketplace: "Marketplace · Arcane Decksmith",
  gametest: "Spieltest · Arcane Decksmith"
};

export type AppLocation = {
  page: AppPage;
  deckId: string | null;
};

export function appPageHref(page: AppPage): string {
  return APP_PAGE_HASHES[page];
}

export function deckHref(deckId: string): string {
  return `#/decks/${encodeURIComponent(deckId)}`;
}

export function appLocationFromHash(hash: string): AppLocation | null {
  const raw = hash.trim();
  const normalized = raw.toLowerCase();

  if (
    normalized === "" ||
    normalized === "#" ||
    normalized === "#/" ||
    normalized === "#/home"
  ) {
    return { page: "home", deckId: null };
  }

  const deckMatch = raw.match(/^#\/decks\/([^/?#]+)\/?$/i);
  if (deckMatch) {
    try {
      return {
        page: "decks",
        deckId: decodeURIComponent(deckMatch[1])
      };
    } catch {
      return null;
    }
  }

  const entry = Object.entries(APP_PAGE_HASHES).find(
    ([, value]) => value.toLowerCase() === normalized
  );

  return entry
    ? { page: entry[0] as AppPage, deckId: null }
    : null;
}

export function appPageFromHash(hash: string): AppPage | null {
  return appLocationFromHash(hash)?.page ?? null;
}

function currentLocation(): AppLocation {
  if (typeof window === "undefined") {
    return { page: "home", deckId: null };
  }

  return appLocationFromHash(window.location.hash) ?? {
    page: "home",
    deckId: null
  };
}

export function useAppNavigation(): {
  page: AppPage;
  deckId: string | null;
  navigate: (page: AppPage) => void;
  openDeck: (deckId: string) => void;
} {
  const [location, setLocation] = useState<AppLocation>(currentLocation);

  useEffect(() => {
    const syncFromLocation = () => {
      const rawHash = window.location.hash.trim();
      const parsed = appLocationFromHash(rawHash);

      if (!parsed) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${APP_PAGE_HASHES.home}`
        );
        setLocation({ page: "home", deckId: null });
        return;
      }

      if (
        parsed.page === "home" &&
        parsed.deckId === null &&
        rawHash.toLowerCase() !== APP_PAGE_HASHES.home
      ) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}${APP_PAGE_HASHES.home}`
        );
      }

      setLocation(parsed);
      window.scrollTo({ top: 0, left: 0 });
    };

    syncFromLocation();
    window.addEventListener("hashchange", syncFromLocation);

    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, []);

  useEffect(() => {
    document.title = location.deckId
      ? `Deck · Arcane Decksmith`
      : PAGE_TITLES[location.page];
  }, [location]);

  const navigate = useCallback((nextPage: AppPage) => {
    const nextHash = APP_PAGE_HASHES[nextPage];

    if (window.location.hash === nextHash) {
      setLocation({ page: nextPage, deckId: null });
      return;
    }

    window.location.hash = nextHash;
  }, []);

  const openDeck = useCallback((nextDeckId: string) => {
    const nextHash = deckHref(nextDeckId);
    if (window.location.hash === nextHash) {
      setLocation({ page: "decks", deckId: nextDeckId });
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return {
    page: location.page,
    deckId: location.deckId,
    navigate,
    openDeck
  };
}
