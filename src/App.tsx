import { Suspense, lazy, useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { subscribeAuth, login, logout, authMessage, type AppUser } from "./auth";
import { supabaseConfigured } from "./supabase";
import {
  loadCollection,
  loadDecks,
  removeCard,
  removeDeck,
  saveCard,
  saveCardsBatch,
  saveDeck,
  cleanRecord,
  PartialSaveError
} from "./db";
import {
  PRICE_REFRESH_INTERVAL_MS,
  cardMetadataChanged,
  compactSourceCards,
  finishCountsFor,
  legacyFoilFlag,
  mergeIntoCollection,
  refreshedCardRecord,
  upsertCards,
  upsertDecks
} from "./collectionState";
import {
  loadDisplayName,
  loadMyListings,
  marketplaceSupported,
  removeListings,
  saveDisplayName,
  saveListings
} from "./marketDb";
import {
  planOfferSave,
  syncListingWithCard,
  type MarketListing,
  type OfferInput
} from "./marketplace";
import MarketplacePage from "./pages/MarketplacePage";
import { showToast } from "./toast";
import ToastHost from "./components/ToastHost";
import {
  autocomplete,
  availableFinishes,
  canonicalEnglishCard,
  displayName,
  displayOracleText,
  displayTypeLine,
  euroPriceFor,
  getCards,
  getCardsBySetAndCollectorNumbers,
  getPrintings,
  getSets,
  imageFor,
  searchCards,
  scryfallUrl,
  normalizeCard,
  type ScryfallCard,
  type ScryfallSet
} from "./scryfall";
import {
  buildDeck,
  cardLegalForDeck,
  commanderCandidates,
  commanderColorIdentity,
  commanderPairCandidates,
  deckCopyLimit,
  deckProfileFor,
  deckStats,
  roleOf,
  type DeckStrategy,
  type DeckTuning,
  type LockedDeckCard
} from "./deckBuilder";
import {
  deckText,
  download
} from "./importExport";
import {
  generateAiDeckExplanation,
  generateDeckExplanation,
  type PurchaseSuggestionBudget
} from "./ai";
import {
  getBuildDeckEvidence
} from "./deckIntelligence";
import type {
  CardFinish,
  CardRecord,
  DeckCard,
  DeckRecord,
  Format
} from "./types";
import "./styles.css";
import AppHeader from "./components/AppHeader";
import AppFooter from "./components/AppFooter";
import HomePage from "./pages/HomePage";
import CollectionPage from "./pages/CollectionPage";
import DeckLibrary from "./components/DeckLibrary";
import DeckBoard from "./components/DeckBoard";
import CardDetailsModal from "./components/CardDetailsModal";
// Selten genutzte, große Teile erst bei Bedarf laden (Code-Splitting).
const CardScanner = lazy(() => import("./components/CardScanner"));
const ExternalImportDialog = lazy(() => import("./components/ExternalImportDialog"));
const PreconImportDialog = lazy(() => import("./components/PreconImportDialog"));
const Markdown = lazy(() => import("./components/Markdown"));
import { useAppNavigation } from "./navigation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COLORS = ["W", "U", "B", "R", "G"];

const COLOR_NAMES: Record<string, string> = {
  W: "Weiß",
  U: "Blau",
  B: "Schwarz",
  R: "Rot",
  G: "Grün"
};


const EUR_FORMATTER =
  new Intl.NumberFormat(
    "de-DE",
    {
      style: "currency",
      currency: "EUR"
    }
  );

const OFFICIAL_COLOR_COMBINATION_NAMES: Record<string, string> = {
  C: "Farblos",
  W: "Mono-Weiß",
  U: "Mono-Blau",
  B: "Mono-Schwarz",
  R: "Mono-Rot",
  G: "Mono-Grün",
  WU: "Azorius",
  UB: "Dimir",
  BR: "Rakdos",
  RG: "Gruul",
  GW: "Selesnya",
  WB: "Orzhov",
  UR: "Izzet",
  BG: "Golgari",
  RW: "Boros",
  GU: "Simic",
  WUB: "Esper",
  UBR: "Grixis",
  BRG: "Jund",
  RGW: "Naya",
  GWU: "Bant",
  WBG: "Abzan",
  URW: "Jeskai",
  BGU: "Sultai",
  RWB: "Mardu",
  GUR: "Temur"
};

function officialColorCombinationName(colors: string[]): string | undefined {
  if (colors.length === 0) return undefined;
  const order = ["W", "U", "B", "R", "G"];
  const normalized = colors.length === 1 && colors[0] === "C"
    ? "C"
    : order.filter(color => colors.includes(color)).join("");
  return OFFICIAL_COLOR_COMBINATION_NAMES[normalized];
}

function poolForDeck(deck: DeckRecord, pool: CardRecord[]): CardRecord[] {
  if (!deck.sourceCards?.length) return pool;

  const merged = new Map<string, CardRecord>();
  for (const card of deck.sourceCards) merged.set(card.id, card);
  for (const card of pool) merged.set(card.id, card);
  return [...merged.values()];
}


function formatEuro(
  value:
    | number
    | undefined
    | null
): string {
  return value === undefined ||
    value === null ||
    !Number.isFinite(value)
    ? "kein EUR-Preis"
    : EUR_FORMATTER.format(value);
}

function finishLabel(
  finish: CardFinish
): string {
  return finish === "foil"
    ? "Foil"
    : "Non-Foil";
}

function collectionValueForCard(
  card: CardRecord
): {
  value: number;
  unpricedCopies: number;
} {
  const counts =
    finishCountsFor(card);

  let value = 0;
  let unpricedCopies = 0;

  if (counts.nonfoil > 0) {
    if (
      card.priceEur !== undefined
    ) {
      value +=
        counts.nonfoil *
        card.priceEur;
    } else {
      unpricedCopies +=
        counts.nonfoil;
    }
  }

  if (counts.foil > 0) {
    if (
      card.priceEurFoil !==
      undefined
    ) {
      value +=
        counts.foil *
        card.priceEurFoil;
    } else {
      unpricedCopies +=
        counts.foil;
    }
  }

  return {
    value,
    unpricedCopies
  };
}


type CommanderBracketEstimate = {
  bracket: 2 | 3 | 4 | 5;
  label: string;
  gameChangers: number;
  extraTurnCards: number;
  massLandDenialCards: number;
  tutorCards: number;
  reasons: string[];
};

function looksLikeExtraTurnCard(
  card: CardRecord
): boolean {
  return /take an extra turn/i.test(
    card.oracleText ?? ""
  );
}

function looksLikeMassLandDenial(
  card: CardRecord
): boolean {
  const text =
    card.oracleText ?? "";

  return (
    /destroy all lands/i.test(text) ||
    /destroy all nonbasic lands/i.test(text) ||
    /return all lands to their owners'? hands/i.test(text) ||
    /lands don'?t untap/i.test(text) ||
    /nonbasic lands are mountains/i.test(text) ||
    /each player sacrifices .*lands?/i.test(text)
  );
}

function looksLikeTutor(
  card: CardRecord
): boolean {
  const text =
    card.oracleText ?? "";

  return (
    /search your library for (?:a|an) (?!basic land|land)/i.test(text) ||
    /search your library for up to (?:one|two|three|four|\d+) (?!basic land|land)/i.test(text)
  );
}

function commanderBracketEstimate(
  deck: DeckRecord,
  pool: CardRecord[]
): CommanderBracketEstimate | null {
  if (deck.format !== "commander") {
    return null;
  }

  const entries: Array<{
    card: CardRecord;
    count: number;
  }> = [];

  for (const deckCard of deck.cards) {
    const source = pool.find(
      card => card.id === deckCard.id
    );

    if (source) {
      entries.push({
        card: source,
        count: deckCard.count
      });
    }
  }

  for (const commanderId of deck.commanderIds) {
    const commander = pool.find(
      card => card.id === commanderId
    );

    if (commander) {
      entries.push({
        card: commander,
        count: 1
      });
    }
  }

  const countMatching = (
    predicate: (card: CardRecord) => boolean
  ) =>
    entries.reduce(
      (sum, entry) =>
        sum +
        (predicate(entry.card)
          ? entry.count
          : 0),
      0
    );

  const gameChangers =
    countMatching(
      card => card.gameChanger === true
    );

  const extraTurnCards =
    countMatching(
      looksLikeExtraTurnCard
    );

  const massLandDenialCards =
    countMatching(
      looksLikeMassLandDenial
    );

  const tutorCards =
    countMatching(
      looksLikeTutor
    );

  if (deck.cedh) {
    return {
      bracket: 5,
      label: "Bracket 5 – cEDH",
      gameChangers,
      extraTurnCards,
      massLandDenialCards,
      tutorCards,
      reasons: [
        "Im Deck-Editor ausdrücklich als cEDH-Deck markiert."
      ]
    };
  }

  const reasons: string[] = [];

  let bracket: 2 | 3 | 4 = 2;

  if (
    gameChangers > 3 ||
    massLandDenialCards > 0 ||
    extraTurnCards >= 3 ||
    tutorCards >= 6
  ) {
    bracket = 4;
  } else if (
    gameChangers > 0 ||
    extraTurnCards > 0 ||
    tutorCards >= 3
  ) {
    bracket = 3;
  }

  if (gameChangers > 0) {
    reasons.push(
      `${gameChangers} Game Changer${gameChangers === 1 ? "" : "s"} erkannt.`
    );
  } else {
    reasons.push(
      "Keine Game Changer in den geladenen Scryfall-Daten erkannt."
    );
  }

  if (extraTurnCards > 0) {
    reasons.push(
      `${extraTurnCards} Extra-Turn-Karte${extraTurnCards === 1 ? "" : "n"} erkannt.`
    );
  }

  if (massLandDenialCards > 0) {
    reasons.push(
      `${massLandDenialCards} Karte${massLandDenialCards === 1 ? "" : "n"} mit möglicher massenhafter Landverwehrung erkannt.`
    );
  }

  if (tutorCards >= 3) {
    reasons.push(
      `${tutorCards} Nichtland-Tutoren erkannt.`
    );
  }

  if (bracket === 2) {
    reasons.push(
      "Keine automatisch erkannten Merkmale erzwingen Bracket 3 oder 4."
    );
  }

  const label =
    bracket === 4
      ? "Bracket 4 – Optimized"
      : bracket === 3
        ? "Bracket 3 – Upgraded"
        : "Bracket 2 – Core";

  return {
    bracket,
    label,
    gameChangers,
    extraTurnCards,
    massLandDenialCards,
    tutorCards,
    reasons
  };
}



function deckForAiAnalysis(
  deck: DeckRecord,
  pool: CardRecord[]
): DeckRecord {
  const commanderCards =
    deck.format === "commander"
      ? deck.commanderIds
          .map(id =>
            pool.find(card =>
              card.id === id
            )
          )
          .filter(
            (card): card is CardRecord =>
              Boolean(card)
          )
      : [];

  const detectedColors =
    deck.format === "commander"
      ? commanderCards.length > 0
        ? commanderColorIdentity(
            commanderCards
          )
        : deck.colors
      : Array.from(
          new Set(
            deck.cards.flatMap(
              deckCard =>
                pool.find(
                  card =>
                    card.id ===
                    deckCard.id
                )?.colorIdentity ??
                []
            )
          )
        );

  return {
    ...deck,
    cards: deck.cards.map(
      deckCard => {
        const source =
          pool.find(
            card =>
              card.id ===
              deckCard.id
          );

        if (!source) {
          return deckCard;
        }

        const detectedRole =
          roleOf(source);

        return {
          ...deckCard,
          role: detectedRole,
          reason:
            `Für die KI-Analyse automatisch als „${detectedRole}“ erkannt.`
        };
      }
    ),
    colors: detectedColors,
    updatedAt: Date.now()
  };
}

function parseCollectorNumbers(
  input: string
): string[] {
  return input
    .split(/[\s,;]+/)
    .map(value =>
      value.trim()
    )
    .filter(Boolean);
}

function collectorNumberCounts(
  numbers: string[]
): Map<string, number> {
  const counts =
    new Map<string, number>();

  for (
    const number
    of numbers
  ) {
    const key =
      number.toLowerCase();

    counts.set(
      key,
      (counts.get(key) ?? 0) + 1
    );
  }

  return counts;
}

function App() {
  const [auth, setAuth] = useState<{
    user: AppUser | null;
    loading: boolean;
  }>({
    user: null,
    loading: true
  });

  useEffect(
    () => subscribeAuth(setAuth),
    []
  );

  if (auth.loading) {
    return (
      <div className="splash">
        Arcane Decksmith wird geladen…
      </div>
    );
  }

  if (!auth.user) {
    return <Auth />;
  }

  return (
    <Main
      user={auth.user}
      uid={auth.user.uid}
    />
  );
}

function Auth() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const canSubmit =
    !busy &&
    supabaseConfigured &&
    Boolean(email) &&
    Boolean(pw);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setMsg("");

    try {
      await login(email, pw);
    } catch (e: unknown) {
      setMsg(authMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit} noValidate>
        <img
          className="brand-logo"
          src="./ad_logo_192.png"
          alt="Arcane Decksmith Logo"
          width={96}
          height={96}
        />

        <h1>Arcane Decksmith</h1>

        <p className="muted">
          Deine Sammlung. Deine Karten. Dein Deck.
        </p>

        {!supabaseConfigured && (
          <div className="error" role="alert">
            Die Anmeldung ist nicht eingerichtet (Supabase-Zugangsdaten fehlen).
          </div>
        )}

        <h2 className="auth-title">Anmelden</h2>

        <label>
          E-Mail
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            required
          />
        </label>

        <label>
          Passwort
          <input
            value={pw}
            onChange={e => setPw(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
          />
        </label>

        {msg && (
          <div className="error" role="alert">
            {msg}
          </div>
        )}

        <button
          type="submit"
          className="primary full"
          disabled={!canSubmit}
        >
          {busy ? "…" : "Anmelden"}
        </button>
      </form>
    </div>
  );
}

function Main({
  user,
  uid
}: {
  user: AppUser;
  uid: string;
}) {
  const [collection, setCollection] =
    useState<CardRecord[]>([]);

  const [decks, setDecks] =
    useState<DeckRecord[]>([]);

  const {
    page,
    deckId,
    navigate,
    openDeck
  } = useAppNavigation();

  const [busy, setBusy] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Marketplace: eigene Angebote und Anzeigename. Werden getrennt vom Kern geladen,
  // damit ein Fehler dort (z. B. Regeln noch nicht veröffentlicht) die App nicht blockiert.
  const [myListings, setMyListings] = useState<MarketListing[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [marketError, setMarketError] = useState("");
  const [marketReloadKey, setMarketReloadKey] = useState(0);
  const myListingsRef = useRef<MarketListing[]>([]);
  const [saveProgress, setSaveProgress] =
    useState<{ saved: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setBusy(true);
      setLoadError("");

      try {
        const [loadedCollection, loadedDecks] =
          await Promise.all([
            loadCollection(uid),
            loadDecks(uid)
          ]);

        if (cancelled) return;

        setCollection(loadedCollection);
        setDecks(loadedDecks);

        void refreshStalePrices(loadedCollection);
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            `Daten konnten nicht geladen werden: ${errorMessage(error)}`
          );
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    // Preise/Setnamen/Finishes höchstens einmal pro Tag aktualisieren und nur
    // tatsächlich geänderte Karten gesammelt zurückschreiben.
    async function refreshStalePrices(loadedCollection: CardRecord[]) {
      const now = Date.now();
      const stale = loadedCollection.filter(
        card =>
          !card.priceUpdatedAt ||
          now - card.priceUpdatedAt > PRICE_REFRESH_INTERVAL_MS
      );

      if (stale.length === 0) return;

      try {
        const freshCards =
          await getCards(stale.map(card => card.id));

        if (cancelled) return;

        const freshById =
          new Map(freshCards.map(card => [card.id, card] as const));

        const changed: CardRecord[] = [];

        for (const card of stale) {
          const fresh = freshById.get(card.id);
          if (!fresh) continue;

          const refreshed = refreshedCardRecord(card, fresh);
          if (cardMetadataChanged(card, refreshed)) {
            changed.push(refreshed);
          }
        }

        if (changed.length === 0) return;

        const saved = await saveCardsBatch(uid, changed);
        if (!cancelled) {
          setCollection(current => upsertCards(current, saved));
        }
      } catch (error) {
        // Die gespeicherten Daten bleiben nutzbar, falls Scryfall/Supabase gerade nicht erreichbar ist.
        console.warn("Preisaktualisierung fehlgeschlagen:", error);
        if (!cancelled) {
          showToast(
            "Preise konnten nicht aktualisiert werden. Es werden die zuletzt gespeicherten Werte angezeigt.",
            "info"
          );
        }
      }
    }

    return () => {
      cancelled = true;
    };
  }, [uid]);

  useEffect(() => {
    if (!marketplaceSupported) return;
    let cancelled = false;

    Promise.all([loadMyListings(uid), loadDisplayName(uid)])
      .then(([listings, name]) => {
        if (cancelled) return;
        myListingsRef.current = listings;
        setMyListings(listings);
        setDisplayName(name);
        setMarketError("");
      })
      .catch(error => {
        console.warn("Marketplace-Daten konnten nicht geladen werden:", error);
        if (!cancelled) setMarketError(errorMessage(error));
      });

    return () => {
      cancelled = true;
    };
  }, [uid, marketReloadKey]);

  const applyMyListings = (next: MarketListing[]) => {
    const sorted = [...next].sort((a, b) => a.name.localeCompare(b.name, "de"));
    myListingsRef.current = sorted;
    setMyListings(sorted);
  };

  /** Hält ein Tausch-Angebot konsistent mit dem Bestand der Sammlung. */
  const syncListing = async (
    cardId: string,
    card: CardRecord | undefined
  ) => {
    const listing = myListingsRef.current.find(item => item.cardId === cardId);
    if (!listing) return;

    const result = syncListingWithCard(listing, card);
    if (result.action === "keep") return;

    try {
      if (result.action === "remove") {
        await removeListings([listing.id]);
        applyMyListings(myListingsRef.current.filter(item => item.id !== listing.id));
        showToast(
          `Das Tausch-Angebot für „${listing.name}“ wurde entfernt, weil kein Exemplar mehr in der Sammlung ist.`,
          "info"
        );
      } else {
        await saveListings([result.listing]);
        applyMyListings(
          myListingsRef.current.map(item => item.id === listing.id ? result.listing : item)
        );
        showToast(
          `Das Tausch-Angebot für „${listing.name}“ wurde an deinen Bestand angepasst.`,
          "info"
        );
      }
    } catch (error) {
      showToast(
        `Das Marketplace-Angebot für „${listing.name}“ konnte nicht angepasst werden: ${errorMessage(error)}`,
        "error"
      );
    }
  };

  const saveOffers = async (
    offers: OfferInput[],
    name: string
  ) => {
    const plan = planOfferSave(myListingsRef.current, offers, uid, name);

    if (name !== displayName) {
      await saveDisplayName(uid, name);
      setDisplayName(name);
    }

    await saveListings(plan.toSave);
    await removeListings(plan.toRemove);

    const removed = new Set(plan.toRemove);
    const byId = new Map(
      myListingsRef.current
        .filter(item => !removed.has(item.id))
        .map(item => [item.id, item] as const)
    );
    for (const listing of plan.toSave) byId.set(listing.id, listing);
    applyMyListings([...byId.values()]);

    if (offers.length > 0) {
      const offeredCards = offers.filter(offer =>
        plan.toSave.some(listing => listing.cardId === offer.card.id)
      ).length;
      showToast(
        offeredCards > 0
          ? `${offeredCards} Karte(n) im Marketplace angeboten.`
          : "Angebot(e) entfernt.",
        "success"
      );
    }
  };

  const removeMyListing = async (listing: MarketListing) => {
    await removeListings([listing.id]);
    applyMyListings(myListingsRef.current.filter(item => item.id !== listing.id));
    showToast(`Angebot für „${listing.name}“ entfernt.`, "success");
  };

  const persistCard =
    async (c: CardRecord) => {
      const cleanCard =
        cleanRecord(c);

      await saveCard(
        uid,
        cleanCard
      );

      setCollection(
        current => upsertCards(current, [cleanCard])
      );

      void syncListing(cleanCard.id, cleanCard);
    };

  /**
   * Speichert viele Karten gesammelt (Upsert-Batches) und aktualisiert den
   * State lokal. Bei Teilfehlern werden die bereits gespeicherten Karten
   * übernommen und der Fehler weitergereicht.
   */
  const persistCards =
    async (cards: CardRecord[]) => {
      const cleanCards =
        cards.map(card => cleanRecord(card));

      setSaveProgress({ saved: 0, total: cleanCards.length });

      try {
        const saved =
          await saveCardsBatch(
            uid,
            cleanCards,
            (done, total) => setSaveProgress({ saved: done, total })
          );

        setCollection(
          current => upsertCards(current, saved)
        );
      } catch (error) {
        if (error instanceof PartialSaveError) {
          setCollection(
            current => upsertCards(current, error.saved)
          );
        }
        throw error;
      } finally {
        setSaveProgress(null);
      }
    };

  /** Addiert neue Karten (inkl. Foil-Aufteilung) auf den vorhandenen Bestand. */
  const addCardsToCollection =
    async (incomingCards: CardRecord[]) => {
      const merged =
        mergeIntoCollection(collection, incomingCards);

      await persistCards(merged);
    };

  const persistDeck =
    async (d: DeckRecord) => {
      try {
        // Automatisch erzeugte Decks können optionale Felder mit `undefined`
        // enthalten. JSON kennt keine solchen Werte in verschachtelten
        // Objekten. Durch die JSON-Rundreise werden nur serialisierbare Werte
        // gespeichert, ohne die Deckstruktur zu verändern.
        const cleanDeck =
          cleanRecord({
            ...d,
            sourceCards: compactSourceCards(d.sourceCards),
            updatedAt: Date.now()
          });

        await saveDeck(
          uid,
          cleanDeck
        );

        setDecks(
          current => upsertDecks(current, cleanDeck)
        );

        navigate("decks");
        showToast("Deck gespeichert.", "success");
      } catch (error) {
        console.error(
          "Deck konnte nicht gespeichert werden:",
          error
        );

        showToast(
          `Deck konnte nicht gespeichert werden: ${errorMessage(error)}`,
          "error"
        );

        throw error;
      }
    };

  const delCard =
    async (id: string) => {
      await removeCard(uid, id);

      setCollection(
        current => current.filter(card => card.id !== id)
      );

      void syncListing(id, undefined);
    };

  const delDeck =
    async (id: string) => {
      await removeDeck(uid, id);

      setDecks(
        current => current.filter(deck => deck.id !== id)
      );
    };

  return (
    <div className="app">
      <AppHeader
        page={page}
        accountLabel={
          user.email ?? "Angemeldet"
        }
        onSignOut={logout}
      />

      <ToastHost />

      {saveProgress && (
        <div className="save-progress" role="status" aria-live="polite">
          Speichere {saveProgress.saved}/{saveProgress.total} Karten…
        </div>
      )}

      <main>
        {busy
          ? (
            <div className="loading">
              Daten werden geladen…
            </div>
          )
          : loadError
            ? (
              <div className="panel" role="alert">
                <p>{loadError}</p>
                <button type="button" onClick={() => window.location.reload()}>
                  Erneut versuchen
                </button>
              </div>
            )
          : page === "home"
            ? (
              <HomePage
                cards={collection}
                decks={decks}
                collectionValue={
                  collection.reduce(
                    (sum, card) =>
                      sum + collectionValueForCard(card).value,
                    0
                  )
                }
                onNavigate={navigate}
              />
            )
            : page === "collection"
              ? (
              <CollectionPage
                cards={collection}
                onChange={persistCard}
                onDelete={delCard}
                onImportCards={async importedCards => {
                  await addCardsToCollection(importedCards);
                  showToast(
                    `${importedCards.reduce((sum, card) => sum + card.count, 0)} Karte(n) importiert.`,
                    "success"
                  );
                }}
              />
            )
            : page === "search"
              ? (
<Search
  cards={collection}
  onBulkApply={async next => {
    await persistCards(next);
    showToast(`${next.length} Druckversion(en) gespeichert.`, "success");
  }}
  onAddCards={async incoming => {
    await addCardsToCollection(incoming);
  }}
  onSaveDeck={persistDeck}
  onAdd={async (
    c,
    finish
  ) => {
    try {
      const canonical =
        await canonicalEnglishCard(c);

    const existing =
      collection.find(
        x =>
          x.id === canonical.id ||
          (
            x.oracleId ===
              canonical.oracle_id &&
            x.set.toLowerCase() ===
              canonical.set.toLowerCase() &&
            x.collectorNumber.toLowerCase() ===
              canonical.collector_number.toLowerCase()
          )
      );

    if (existing) {
      const counts =
        finishCountsFor(
          existing
        );

      const nextCounts = {
        ...counts,
        [finish]:
          counts[finish] + 1
      };

      const fresh =
        normalizeCard(
          canonical,
          1,
          finish === "foil"
        );

      await persistCard({
        ...existing,
        count:
          existing.count + 1,
        finishCounts:
          nextCounts,
        availableFinishes:
          fresh.availableFinishes,
        ...(fresh.priceEur !== undefined
          ? {
              priceEur:
                fresh.priceEur
            }
          : {}),
        ...(fresh.priceEurFoil !== undefined
          ? {
              priceEurFoil:
                fresh.priceEurFoil
            }
          : {}),
        priceUpdatedAt:
          fresh.priceUpdatedAt,
        gameChanger:
          fresh.gameChanger ??
          existing.gameChanger,
        foil:
          legacyFoilFlag(
            nextCounts
          ),
        updatedAt:
          Date.now()
      });

      showToast(
        `${canonical.name}: ${finishLabel(finish)} hinzugefügt · Anzahl ${existing.count + 1}.`,
        "success"
      );
    } else {
      const fresh =
        normalizeCard(
          canonical,
          1,
          finish === "foil"
        );

      await persistCard(
        fresh
      );

      showToast(
        `${canonical.name} (${finishLabel(finish)}) wurde zur Sammlung hinzugefügt.`,
        "success"
      );
    }
    } catch (error) {
      console.error(
        "Karte konnte nicht zur Sammlung hinzugefügt werden:",
        error
      );

      showToast(
        `Karte konnte nicht hinzugefügt werden: ${errorMessage(error)}`,
        "error"
      );
    }
  }}
/>
              )
              : page === "builder"
                ? (
                  <BuildHub
                    pool={collection}
                    onSave={persistDeck}
                  />
                )
                : page === "marketplace"
                  ? (
                    <MarketplacePage
                      uid={uid}
                      collection={collection}
                      myListings={myListings}
                      displayName={displayName}
                      loadError={marketError}
                      onRetryLoad={() => setMarketReloadKey(key => key + 1)}
                      onSaveOffers={saveOffers}
                      onRemoveListing={removeMyListing}
                    />
                  )
                : (
                  <Decks
                    decks={decks}
                    pool={collection}
                    selectedDeckId={deckId}
                    onOpenDeck={openDeck}
                    onCloseDeck={() => navigate("decks")}
                    onDelete={delDeck}
                    onSave={persistDeck}
                  />
                )}
      </main>

      <AppFooter />
    </div>
  );
}


function Search({
  cards,
  onAdd,
  onAddCards,
  onSaveDeck,
  onBulkApply
}: {
  cards: CardRecord[];
  onAdd: (
    c: ScryfallCard,
    finish: CardFinish
  ) => Promise<void>;
  onAddCards: (
    c: CardRecord[]
  ) => Promise<void>;
  onSaveDeck: (
    deck: DeckRecord
  ) => Promise<void>;
  onBulkApply: (
    c: CardRecord[]
  ) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] =
    useState<ScryfallCard[]>([]);
  const [suggestions, setSuggestions] =
    useState<string[]>([]);
  const [busy, setBusy] =
    useState(false);
    const [searchFocused, setSearchFocused] =
  useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.length >= 2) {
        void autocomplete(q)
          .then(setSuggestions)
          .catch(() =>
            setSuggestions([])
          );
      } else {
        setSuggestions([]);
      }
    }, 300);

    return () =>
      clearTimeout(t);
  }, [q]);

  const go = async () => {
    setSuggestions([]);
    setBusy(true);

    try {
      setResults(
        await searchCards(q)
      );
    } catch (e: unknown) {
      showToast(`Suche fehlgeschlagen: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

 return (
  <section>
    <style>{`
      .search-sticky-head{
        position:sticky;
        top:72px;
        z-index:20;
        margin:0 -4px 16px;
        padding:8px 4px 12px;
        background:linear-gradient(
          180deg,
          rgba(5,9,18,.98) 0%,
          rgba(5,9,18,.94) 82%,
          rgba(5,9,18,0) 100%
        );
        backdrop-filter:blur(14px);
      }

      .search-sticky-head .pagehead{
        margin-bottom:10px;
      }

      .search-tool-actions{
        display:flex;
        flex-wrap:wrap;
        gap:8px;
        margin-top:8px;
      }

      @media (max-width:850px){
        .search-sticky-head{
          top:112px;
        }
      }
    `}</style>

    <div className="search-sticky-head">
      <div className="pagehead">
        <div>
          <h2>Kartensuche</h2>

          <p className="muted">
            Scryfall-Suche, Bulk-Hinzufügen und mobiler Kartenscanner.
          </p>
        </div>
      </div>

      <div className="searchbar">
        <input
  value={q}
  onChange={e =>
    setQ(e.target.value)
  }
  onFocus={() =>
    setSearchFocused(true)
  }
  onBlur={() => {
    setTimeout(
      () =>
        setSearchFocused(false),
      120
    );
  }}
  onKeyDown={e =>
    e.key === "Enter" &&
    void go()
  }
  placeholder="z. B. Lightning Bolt"
/>
        <button
          className="primary"
          onClick={go}
        >
          Suchen
        </button>
      </div>
    </div>

   {searchFocused &&
  suggestions.length > 0 && (
      <div className="suggestions">
        {suggestions.map(s => (
          <button
            key={s}
            onClick={async () => {
              setQ(s);
              setSuggestions([]);
              setBusy(true);

              try {
                setResults(
                  await searchCards(s)
                );
              } catch (e: unknown) {
                showToast(`Suche fehlgeschlagen: ${errorMessage(e)}`, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            {s}
          </button>
        ))}
      </div>
    )}

    <SearchCollectionTools
      cards={cards}
      onBulkApply={onBulkApply}
      onAdd={onAdd}
      onAddCards={onAddCards}
      onSaveDeck={onSaveDeck}
    />

    {busy
      ? (
        <div className="loading">
          Scryfall fragt Karten ab…
        </div>
      )
      : (
        <div className="card-grid">
          {results.map(c => (
            <SearchCard
              key={c.id}
              card={c}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}
  </section>
);
}
function isSmartphoneOrTablet(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent ?? "";
  const isMobileUserAgent =
    /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(userAgent);
  const isIPadDesktopMode =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const isCoarseTouchDevice =
    navigator.maxTouchPoints > 0 &&
    window.matchMedia("(pointer: coarse)").matches &&
    window.matchMedia("(hover: none)").matches;
  const shorterScreenSide = Math.min(window.screen.width, window.screen.height);
  const hasPhoneOrTabletScreen = shorterScreenSide <= 1024;

  return (
    isMobileUserAgent ||
    isIPadDesktopMode ||
    (isCoarseTouchDevice && hasPhoneOrTabletScreen)
  );
}

function SearchCollectionTools({
  cards,
  onBulkApply,
  onAdd,
  onAddCards,
  onSaveDeck
}: {
  cards: CardRecord[];
  onBulkApply: (
    c: CardRecord[]
  ) => Promise<void>;
  onAdd: (
    c: ScryfallCard,
    finish: CardFinish
  ) => Promise<void>;
  onAddCards: (
    c: CardRecord[]
  ) => Promise<void>;
  onSaveDeck: (
    deck: DeckRecord
  ) => Promise<void>;
}) {
  const [preconOpen, setPreconOpen] =
    useState(false);
  const [scannerOpen, setScannerOpen] =
    useState(false);
  const [scannerAvailable] =
    useState(() => isSmartphoneOrTablet());

  const [showBulkAdd, setShowBulkAdd] =
    useState(false);
  const [bulkSetCode, setBulkSetCode] =
    useState("");
  const [bulkNumbers, setBulkNumbers] =
    useState("");
  const [bulkSets, setBulkSets] =
    useState<ScryfallSet[]>([]);
  const [bulkSetsBusy, setBulkSetsBusy] =
    useState(false);
  const [bulkBusy, setBulkBusy] =
    useState(false);
  const [bulkPreview, setBulkPreview] =
    useState<{
      cards: CardRecord[];
      rows: Array<{
        collectorNumber: string;
        count: number;
        name?: string;
        finish?: CardFinish;
        found: boolean;
      }>;
      requestedCopies: number;
      resolvedCopies: number;
      issues: string[];
    } | null>(null);

  const resetBulkAdd = () => {
    setBulkNumbers("");
    setBulkPreview(null);
  };

  const closeBulkAdd = () => {
    resetBulkAdd();
    setShowBulkAdd(false);
  };

  const ensureBulkSets = async () => {
    if (
      bulkSets.length > 0 ||
      bulkSetsBusy
    ) {
      return;
    }

    setBulkSetsBusy(true);

    try {
      setBulkSets(
        await getSets()
      );
    } catch (error) {
      console.error(
        "Scryfall-Sets konnten nicht geladen werden:",
        error
      );
      showToast(
        "Die Set-Liste konnte nicht von Scryfall geladen werden.",
        "error"
      );
    } finally {
      setBulkSetsBusy(false);
    }
  };

  const toggleBulkAdd = () => {
    const next = !showBulkAdd;

    if (next) {
      void ensureBulkSets();
    }

    setShowBulkAdd(next);
  };

  const previewBulkAdd = async () => {
    const numbers =
      parseCollectorNumbers(
        bulkNumbers
      );

    if (
      !bulkSetCode ||
      numbers.length === 0
    ) {
      return;
    }

    setBulkBusy(true);
    setBulkPreview(null);

    try {
      const counts =
        collectorNumberCounts(
          numbers
        );

      const lookup =
        await getCardsBySetAndCollectorNumbers(
          bulkSetCode,
          Array.from(
            counts.keys()
          )
        );

      const byCollectorNumber =
        new Map(
          lookup.cards.map(
            card => [
              card.collector_number
                .toLowerCase(),
              card
            ] as const
          )
        );

      const next =
        cards.map(
          card => ({
            ...card,
            ...(card.finishCounts
              ? {
                  finishCounts: {
                    ...card.finishCounts
                  }
                }
              : {})
          })
        );

      const rows:
        Array<{
          collectorNumber: string;
          count: number;
          name?: string;
          finish?: CardFinish;
          found: boolean;
        }> = [];
      const issues: string[] = [];
      let resolvedCopies = 0;

      for (
        const [
          collectorNumber,
          count
        ] of counts
      ) {
        const scryfallCard =
          byCollectorNumber.get(
            collectorNumber
          );

        if (!scryfallCard) {
          rows.push({
            collectorNumber,
            count,
            found: false
          });
          issues.push(
            `#${collectorNumber}: in diesem Set nicht gefunden.`
          );
          continue;
        }

        const finishes =
          availableFinishes(
            scryfallCard
          );

        const finish:
          CardFinish | undefined =
            finishes.includes(
              "nonfoil"
            )
              ? "nonfoil"
              : finishes.includes(
                  "foil"
                )
                ? "foil"
                : undefined;

        if (!finish) {
          rows.push({
            collectorNumber,
            count,
            name: scryfallCard.name,
            found: false
          });
          issues.push(
            `#${collectorNumber} ${scryfallCard.name}: Scryfall meldet kein unterstütztes Finish.`
          );
          continue;
        }

        const normalized =
          normalizeCard(
            scryfallCard,
            count,
            finish === "foil"
          );

        const existing =
          next.find(
            card =>
              card.id ===
                normalized.id ||
              (
                card.oracleId ===
                  normalized.oracleId &&
                card.set.toLowerCase() ===
                  normalized.set.toLowerCase() &&
                card.collectorNumber.toLowerCase() ===
                  normalized.collectorNumber.toLowerCase()
              )
          );

        if (existing) {
          const currentCounts =
            finishCountsFor(
              existing
            );
          const nextCounts = {
            ...currentCounts,
            [finish]:
              currentCounts[finish] +
              count
          };

          existing.count += count;
          existing.finishCounts =
            nextCounts;
          existing.availableFinishes =
            normalized.availableFinishes;
          existing.priceEur =
            normalized.priceEur ??
            existing.priceEur;
          existing.priceEurFoil =
            normalized.priceEurFoil ??
            existing.priceEurFoil;
          existing.priceUpdatedAt =
            normalized.priceUpdatedAt;
          existing.gameChanger =
            normalized.gameChanger ??
            existing.gameChanger;
          existing.foil =
            legacyFoilFlag(
              nextCounts
            );
          existing.updatedAt =
            Date.now();
        } else {
          next.push(
            normalized
          );
        }

        rows.push({
          collectorNumber:
            scryfallCard.collector_number,
          count,
          name:
            scryfallCard.name,
          finish,
          found: true
        });

        resolvedCopies += count;
      }

      setBulkPreview({
        cards: next,
        rows,
        requestedCopies:
          numbers.length,
        resolvedCopies,
        issues
      });
    } catch (error) {
      console.error(
        "Bulk-Hinzufügen fehlgeschlagen:",
        error
      );
      showToast(
        "Die Collector Numbers konnten nicht vollständig bei Scryfall geprüft werden.",
        "error"
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const applyBulkAdd = async () => {
    if (
      !bulkPreview ||
      bulkPreview.resolvedCopies === 0
    ) {
      return;
    }

    setBulkBusy(true);

    try {
      await onBulkApply(
        bulkPreview.cards
      );
      closeBulkAdd();
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <>
      <div className="search-tool-actions">
        <button
          className="secondary"
          onClick={toggleBulkAdd}
        >
          Bulk hinzufügen
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => setPreconOpen(true)}
        >
          Precon-Deck hinzufügen
        </button>
        {scannerAvailable && (
          <button
            className="secondary"
            type="button"
            onClick={() => setScannerOpen(true)}
          >
            Karte scannen
          </button>
        )}
      </div>

      {showBulkAdd && (
        <div className="panel">
          <h3>Bulk hinzufügen</h3>
          <p className="muted">
            Wähle ein Set und gib die Collector Numbers durch Kommas getrennt ein. Wiederholte Nummern erhöhen automatisch die Anzahl. Gibt es Non-Foil und Foil, wird beim Bulk standardmäßig Non-Foil verwendet.
          </p>

          <div className="two">
            <label>
              Set
              <select
                value={bulkSetCode}
                onChange={e => {
                  setBulkSetCode(
                    e.target.value
                  );
                  setBulkPreview(null);
                }}
                disabled={bulkSetsBusy}
              >
                <option value="">
                  {bulkSetsBusy
                    ? "Sets werden geladen…"
                    : "— Set auswählen —"}
                </option>
{[...bulkSets]
  .sort((a, b) =>
    a.name.localeCompare(
      b.name,
      "de",
      { sensitivity: "base" }
    )
  )
  .map(set => (
    <option
      key={set.id}
      value={set.code}
    >
      {set.name} ({set.code.toUpperCase()})
    </option>
  ))}
              </select>
            </label>

            <label>
              Collector Numbers
              <textarea
                value={bulkNumbers}
                onChange={e => {
                  setBulkNumbers(
                    e.target.value
                  );
                  setBulkPreview(null);
                }}
                rows={4}
                placeholder="z. B. 12, 18, 18, 34, 105"
              />
            </label>
          </div>

          <div className="row">
            <button
              className="primary"
              onClick={() =>
                void previewBulkAdd()
              }
              disabled={
                bulkBusy ||
                !bulkSetCode ||
                parseCollectorNumbers(
                  bulkNumbers
                ).length === 0
              }
            >
              {bulkBusy
                ? "Bulk wird geprüft…"
                : "Bulk prüfen"}
            </button>
            <button
              className="secondary"
              onClick={closeBulkAdd}
              disabled={bulkBusy}
            >
              Abbrechen
            </button>
          </div>

          {bulkPreview && (
            <div className="ai-box">
              <h3>Bulk-Vorschau</h3>
              <p>
                Eingaben: <strong>{bulkPreview.requestedCopies}</strong> Karten
                <br />
                Gefunden: <strong>{bulkPreview.resolvedCopies}</strong> Karten
              </p>

              <div className="deck-list">
                {bulkPreview.rows.map(row => (
                  <div key={row.collectorNumber}>
                    <span>
                      #{row.collectorNumber}
                      {row.name
                        ? ` · ${row.name}`
                        : " · nicht gefunden"}
                    </span>
                    <strong>
                      {row.count}×
                      {row.finish
                        ? ` · ${finishLabel(row.finish)}`
                        : ""}
                    </strong>
                  </div>
                ))}
              </div>

              {bulkPreview.issues.length > 0 && (
                <div className="notice">
                  <strong>Hinweise:</strong>
                  <div className="deck-list">
                    {bulkPreview.issues.map(
                      (issue, index) => (
                        <div key={`${issue}-${index}`}>
                          <span>{issue}</span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    void applyBulkAdd()
                  }
                  disabled={
                    bulkBusy ||
                    bulkPreview.resolvedCopies === 0
                  }
                >
                  Bulk übernehmen
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    setBulkPreview(null)
                  }
                  disabled={bulkBusy}
                >
                  Eingabe bearbeiten
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {scannerAvailable && scannerOpen && (
        <Suspense fallback={<div className="loading">Scanner wird geladen…</div>}>
          <CardScanner
            open={scannerOpen}
            onClose={() => setScannerOpen(false)}
            onAdd={onAdd}
          />
        </Suspense>
      )}

      {preconOpen && (
        <Suspense fallback={<div className="loading">Precon-Auswahl wird geladen…</div>}>
          <PreconImportDialog
            collection={cards}
            onClose={() => setPreconOpen(false)}
            onSaveDeck={onSaveDeck}
            onAddCards={async incoming => {
              await onAddCards(incoming);
              showToast(
                `${incoming.reduce((sum, card) => sum + card.count, 0)} Karte(n) aus dem Precon-Deck hinzugefügt.`,
                "success"
              );
            }}
          />
        </Suspense>
      )}
    </>
  );
}

function SearchCard({
  card,
  onAdd
}: {
  card: ScryfallCard;
  onAdd: (
    card: ScryfallCard,
    finish: CardFinish
  ) => void | Promise<void>;
}) {
  const [
    selectedCard,
    setSelectedCard
  ] =
    useState<ScryfallCard>(card);

  const [
    selectedFinish,
    setSelectedFinish
  ] =
    useState<CardFinish>(
      availableFinishes(card)[0] ??
      "nonfoil"
    );

  const [
    printings,
    setPrintings
  ] =
    useState<ScryfallCard[]>([]);

  const [
    showPrintings,
    setShowPrintings
  ] =
    useState(false);

  const [
    loadingPrintings,
    setLoadingPrintings
  ] =
    useState(false);

  const [
    printingError,
    setPrintingError
  ] =
    useState("");

  useEffect(() => {
    setSelectedCard(card);
    setSelectedFinish(
      availableFinishes(card)[0] ??
      "nonfoil"
    );
    setPrintings([]);
    setShowPrintings(false);
    setPrintingError("");
    // Bewusst nur bei Wechsel der Karten-ID zurücksetzen, nicht bei jeder neuen Objektreferenz.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  useEffect(() => {
    const finishes =
      availableFinishes(
        selectedCard
      );

    setSelectedFinish(
      current =>
        finishes.includes(current)
          ? current
          : finishes[0] ??
            "nonfoil"
    );
    // Nur bei Wechsel des Printings neu abgleichen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCard.id]);

  const selectedFinishes =
    availableFinishes(
      selectedCard
    );

  const loadPrintings = async () => {
    if (showPrintings) {
      setShowPrintings(false);
      return;
    }

    setShowPrintings(true);

    if (printings.length > 0) {
      return;
    }

    setLoadingPrintings(true);
    setPrintingError("");

    try {
      const variants =
        await getPrintings(card);

      setPrintings(variants);
    } catch {
      setPrintingError(
        "Die Varianten konnten nicht von Scryfall geladen werden."
      );
    } finally {
      setLoadingPrintings(false);
    }
  };

  return (
    <article className="card-tile">
      <img
        alt={displayName(selectedCard)}
        src={imageFor(selectedCard)}
        loading="lazy"
      />

      <div className="card-body">
        <h3>
          {displayName(selectedCard)}
        </h3>

        <div className="meta">
          {selectedCard.mana_cost ??
            selectedCard.card_faces?.[0]
              ?.mana_cost ??
            "—"} ·
          {" "}MV {selectedCard.cmc ?? 0} ·{" "}
          {selectedCard.set.toUpperCase()}
          {" "}#
          {selectedCard.collector_number}
        </div>

        {selectedCard.set_name && (
          <div className="meta">
            {selectedCard.set_name}
          </div>
        )}

        <p>
          {displayTypeLine(
            selectedCard
          )}
        </p>

        <p className="oracle">
          {displayOracleText(
            selectedCard
          )}
        </p>

        <div className="variant-box">
          <div className="variant-info-title">
            Finish & Scryfall-Preis
          </div>

          {selectedFinishes.length > 0
            ? (
              <div className="row">
                {selectedFinishes.map(
                  finish => (
                    <button
                      key={finish}
                      className={
                        selectedFinish ===
                        finish
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() =>
                        setSelectedFinish(
                          finish
                        )
                      }
                    >
                      {finishLabel(
                        finish
                      )}
                      {" · "}
                      {formatEuro(
                        euroPriceFor(
                          selectedCard,
                          finish
                        )
                      )}
                    </button>
                  )
                )}
              </div>
            )
            : (
              <div className="muted">
                Für diese Ausgabe meldet Scryfall kein unterstütztes
                Non-Foil- oder Foil-Finish.
              </div>
            )}
        </div>

        <div className="variant-actions">
          <button
            className="secondary"
            onClick={loadPrintings}
            disabled={
              loadingPrintings
            }
          >
            {loadingPrintings
              ? "Varianten werden geladen…"
              : showPrintings
                ? "Varianten schließen"
                : "Varianten / Drucke"}
          </button>
        </div>

        {showPrintings && (
          <div className="variant-box">
            {printingError && (
              <div className="error">
                {printingError}
              </div>
            )}

            {!printingError &&
              loadingPrintings && (
                <div className="muted">
                  Scryfall lädt verfügbare
                  Drucke…
                </div>
              )}

            {!loadingPrintings &&
              printings.length > 0 && (
                <>
                  <div className="variant-field">
                    <label
                      htmlFor={
                        `variant-${card.id}`
                      }
                    >
                      Ausgabe auswählen
                    </label>

                    <select
                      id={
                        `variant-${card.id}`
                      }
                      className="variant-select"
                      value={
                        selectedCard.id
                      }
                      onChange={e => {
                        const chosen =
                          printings.find(
                            p =>
                              p.id ===
                              e.target.value
                          );

                        if (chosen) {
                          setSelectedCard(
                            chosen
                          );
                        }
                      }}
                    >
                      {printings.map(p => (
                        <option
                          key={p.id}
                          value={p.id}
                        >
                          {(
                            p.set_name ??
                            p.set
                          )}
                          {" · #"}
                          {
                            p.collector_number
                          }
                          {p.lang &&
                          p.lang !== "en"
                            ? ` · ${p.lang.toUpperCase()}`
                            : ""}
                          {" · "}
                          {availableFinishes(
                            p
                          )
                            .map(
                              finish =>
                                `${finishLabel(finish)} ${formatEuro(
                                  euroPriceFor(
                                    p,
                                    finish
                                  )
                                )}`
                            )
                            .join(" / ")}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="variant-info">
                    <div className="variant-info-title">
                      Gewählte Ausgabe
                    </div>

                    <div className="variant-info-row">
                      <span>
                        Set
                      </span>

                      <strong>
                        {selectedCard.set_name ??
                          selectedCard.set.toUpperCase()}
                      </strong>
                    </div>

                    <div className="variant-info-row">
                      <span>
                        Collector-Nr.
                      </span>

                      <strong>
                        {
                          selectedCard.collector_number
                        }
                      </strong>
                    </div>

                    {selectedCard.lang && (
                      <div className="variant-info-row">
                        <span>
                          Sprache
                        </span>

                        <strong>
                          {selectedCard.lang.toUpperCase()}
                        </strong>
                      </div>
                    )}

                    {selectedCard.rarity && (
                      <div className="variant-info-row">
                        <span>
                          Seltenheit
                        </span>

                        <strong>
                          {
                            selectedCard.rarity
                          }
                        </strong>
                      </div>
                    )}
                  </div>
                </>
              )}
          </div>
        )}

        <div className="row search-card-actions">
          <button
            className="primary"
            disabled={
              selectedFinishes.length ===
              0
            }
            onClick={() =>
              onAdd(
                selectedCard,
                selectedFinish
              )
            }
          >
            + Sammlung
          </button>

          <a
            href={
              scryfallUrl(
                selectedCard.id
              )
            }
            target="_blank"
            rel="noreferrer"
          >
            Scryfall ↗
          </a>
        </div>
      </div>
    </article>
  );
}

type TuningSliderProps = {
  label: string;
  value: number;
  onChange: (
    value: number
  ) => void;
  help: string;
  lowLabel?: string;
  highLabel?: string;
};

function TuningSlider({
  label,
  value,
  onChange,
  help,
  lowLabel = "Weniger",
  highLabel = "Mehr"
}: TuningSliderProps) {
  const valueText =
    value === 0
      ? "Standard"
      : value < 0
        ? value === -2
          ? `Deutlich ${lowLabel.toLowerCase()}`
          : lowLabel
        : value === 2
          ? `Deutlich ${highLabel.toLowerCase()}`
          : highLabel;

  return (
    <div className="tuning-control">
      <div className="tuning-control-head">
        <span>
          {label}
        </span>
      </div>

      <input
        type="range"
        min="-2"
        max="2"
        step="1"
        value={value}
        onChange={event =>
          onChange(
            Number(
              event.target.value
            )
          )
        }
        aria-label={label}
        aria-valuetext={valueText}
      />

      <div className="tuning-scale">
        <span>
          {lowLabel}
        </span>

        <span>
          Standard
        </span>

        <span>
          {highLabel}
        </span>
      </div>

      <p className="tuning-help">
        {help}
      </p>
    </div>
  );
}

function optionalEuroLimit(
  value: string
): number | undefined {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(
    value.replace(",", ".")
  );

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function PurchaseBudgetControls({
  maxCardPrice,
  maxDeckPrice,
  onMaxCardPriceChange,
  onMaxDeckPriceChange
}: {
  maxCardPrice: string;
  maxDeckPrice: string;
  onMaxCardPriceChange: (value: string) => void;
  onMaxDeckPriceChange: (value: string) => void;
}) {
  return (
    <div className="purchase-budget-controls">
      <div className="purchase-budget-copy">
        <strong>Budget für Kaufvorschläge</strong>
        <small>
          Leer lassen = kein Limit. Bei aktivem Limit werden nur Vorschläge mit verifiziertem Scryfall-EUR-Preis berücksichtigt.
        </small>
      </div>

      <label>
        Max. pro Karte (€)
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          placeholder="Unbegrenzt"
          value={maxCardPrice}
          onChange={event => onMaxCardPriceChange(event.target.value)}
        />
      </label>

      <label>
        Max. gesamt pro Deck (€)
        <input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          placeholder="Unbegrenzt"
          value={maxDeckPrice}
          onChange={event => onMaxDeckPriceChange(event.target.value)}
        />
      </label>
    </div>
  );
}


type BuilderStepId =
  | "name"
  | "format"
  | "commander"
  | "strategy"
  | "mana"
  | "tuning";

type StrategyOption = {
  id: DeckStrategy;
  label: string;
  description: string;
};

const STANDARD_STRATEGIES: StrategyOption[] = [
  {
    id: "balanced",
    label: "Ausgewogen",
    description: "Verteilt Bedrohungen, Antworten, Kartenvorteil und Synergien möglichst gleichmäßig."
  },
  {
    id: "aggressive",
    label: "Aggressiv",
    description: "Priorisiert günstige Bedrohungen und frühen Druck, um das Spiel schnell zu entscheiden."
  },
  {
    id: "control",
    label: "Kontrolle",
    description: "Spielt reaktiver, priorisiert Antworten und Kartenvorteil und gewinnt eher im späteren Spiel."
  },
  {
    id: "value",
    label: "Value",
    description: "Priorisiert wiederholbaren Kartenvorteil, Recursion und Karten mit langfristigem Mehrwert."
  },
  {
    id: "synergy",
    label: "Synergie",
    description: "Bevorzugt Karten, die besonders gut miteinander funktionieren, auch wenn sie einzeln weniger effizient sind."
  },
  {
    id: "creatures",
    label: "Creature-Fokus",
    description: "Gewichtet Kreaturen deutlich höher und baut stärker über Boardpräsenz und Combat auf."
  },
  {
    id: "spells",
    label: "Spell-Fokus",
    description: "Bevorzugt Instants und Sorceries sowie Karten, die diese unterstützen."
  }
];

const COMMANDER_STRATEGIES: StrategyOption[] = [
  {
    id: "aggressive",
    label: "Aggro",
    description: "Erzeugt früh Druck mit günstigen Bedrohungen und versucht das Spiel schnell zu schließen."
  },
  {
    id: "midrange",
    label: "Midrange",
    description: "Verbindet effiziente Bedrohungen, Value und Interaktion und bleibt in mehreren Spielphasen flexibel."
  },
  {
    id: "control",
    label: "Control",
    description: "Hält gegnerische Pläne mit Interaktion und Boardwipes klein und gewinnt über langfristigen Kartenvorteil."
  },
  {
    id: "combo",
    label: "Combo",
    description: "Priorisiert zusammengehörige Engines, Tutoren und geschützte Linien, die das Spiel direkt oder nahezu direkt entscheiden können."
  },
  {
    id: "tokens",
    label: "Tokens",
    description: "Erzeugt viele Spielsteine und nutzt Karten, die Token vervielfachen, verstärken oder in Ressourcen umwandeln."
  },
  {
    id: "aristocrats",
    label: "Aristocrats",
    description: "Nutzt Opfer-, Sterbe- und Wiederholungs-Effekte, um aus eigenen Permanents wiederholt Value zu erzeugen."
  },
  {
    id: "voltron",
    label: "Voltron",
    description: "Konzentriert Ressourcen auf den Commander oder eine zentrale Kreatur, meist über Equipment, Auren und Schutz."
  },
  {
    id: "spellslinger",
    label: "Spellslinger",
    description: "Baut um viele Instants und Sorceries sowie Effekte, die vom Wirken oder Kopieren von Zaubern profitieren."
  },
  {
    id: "reanimator",
    label: "Reanimator",
    description: "Nutzt den Friedhof als Ressource und bringt wichtige Karten gezielt zurück ins Spiel."
  },
  {
    id: "lands",
    label: "Lands",
    description: "Nutzt Länder, zusätzliche Landdrops und Landfall-ähnliche Effekte als zentrale Engine."
  },
  {
    id: "stax",
    label: "Stax",
    description: "Bremst gegnerische Ressourcen und Aktionen mit Einschränkungen und asymmetrischen Regeln."
  },
  {
    id: "typal",
    label: "Typal / Kindred",
    description: "Baut gezielt um einen Kreaturentyp und maximiert gemeinsame Typ-Synergien und Lords."
  },
  {
    id: "artifacts",
    label: "Artifacts",
    description: "Nutzt Artefakte als zentrale Ressource für Ramp, Synergien, Engines und Win Conditions."
  },
  {
    id: "enchantress",
    label: "Enchantress",
    description: "Baut um Verzauberungen, Auren und Trigger, die aus dem Ausspielen von Enchantments Kartenvorteil erzeugen."
  }
];

function strategyOptionsFor(format: Format): StrategyOption[] {
  return format === "commander" ? COMMANDER_STRATEGIES : STANDARD_STRATEGIES;
}

function strategyOptionFor(format: Format, strategy: DeckStrategy): StrategyOption {
  return (
    strategyOptionsFor(format).find(option => option.id === strategy) ??
    strategyOptionsFor(format)[0]
  );
}

function recommendStrategy(
  format: Format,
  tuning: DeckTuning,
  current: DeckStrategy
): DeckStrategy {
  const aggression = tuning.aggression ?? 0;
  const interaction = tuning.interaction ?? 0;
  const boardwipes = tuning.boardwipes ?? 0;
  const draw = tuning.draw ?? 0;
  const recursion = tuning.recursion ?? 0;
  const synergy = tuning.synergy ?? 0;
  const commanderSynergy = tuning.commanderSynergy ?? 0;
  const protection = tuning.protection ?? 0;
  const ramp = tuning.ramp ?? 0;

  if (format === "standard") {
    if (aggression >= 2) return "aggressive";
    if (interaction >= 2 || boardwipes >= 2) return "control";
    if (draw >= 2 || recursion >= 2) return "value";
    if (synergy >= 2) return "synergy";
    return current;
  }

  if (aggression >= 2) return "aggressive";
  if (commanderSynergy >= 2 && protection >= 1) return "voltron";
  if (recursion >= 2 && synergy >= 1) return "reanimator";
  if (interaction >= 2 && boardwipes >= 1) return "control";
  if (synergy >= 2 && draw >= 1) return "combo";
  if (ramp >= 2 && draw >= 1) return "midrange";

  return current;
}


function Builder({
  pool,
  onSave,
  onChangeBuildMode
}: {
  pool: CardRecord[];
  onSave: (d: DeckRecord) => Promise<void>;
  onChangeBuildMode: () => void;
}) {
  const [format, setFormat] = useState<Format>("commander");
  const [colors, setColors] = useState<string[]>([...COLORS]);
  const [commanderId, setCommanderId] = useState("");
  const [secondCommanderId, setSecondCommanderId] = useState("");
  const [target, setTarget] = useState(3);
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(15);
  const [name, setName] = useState("Neues Deck");
  const [result, setResult] = useState<DeckRecord | null>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [strategy, setStrategy] = useState<DeckStrategy>("midrange");
  const [wizardIndex, setWizardIndex] = useState(0);
  const [showResultTuning, setShowResultTuning] = useState(false);
  const [selectedCard, setSelectedCard] = useState<CardRecord | null>(null);

  const [landsTune, setLandsTune] = useState(0);
  const [rampTune, setRampTune] = useState(0);
  const [drawTune, setDrawTune] = useState(0);
  const [interactionTune, setInteractionTune] = useState(0);
  const [boardwipeTune, setBoardwipeTune] = useState(0);
  const [protectionTune, setProtectionTune] = useState(0);
  const [recursionTune, setRecursionTune] = useState(0);
  const [synergyTune, setSynergyTune] = useState(0);
  const [curveTune, setCurveTune] = useState(0);
  const [commanderSynergyTune, setCommanderSynergyTune] = useState(0);
  const [aggressionTune, setAggressionTune] = useState(0);
  const [lockedCards, setLockedCards] = useState<LockedDeckCard[]>([]);
  const [excludedCardIds, setExcludedCardIds] = useState<string[]>([]);

  const commanders = useMemo(() => commanderCandidates(pool), [pool]);

  const primaryCommander = useMemo(
    () => commanders.find(card => card.id === commanderId),
    [commanders, commanderId]
  );

  const secondCommanderOptions = useMemo(
    () => (primaryCommander ? commanderPairCandidates(pool, primaryCommander) : []),
    [pool, primaryCommander]
  );

  const secondCommander = useMemo(
    () => secondCommanderOptions.find(card => card.id === secondCommanderId),
    [secondCommanderOptions, secondCommanderId]
  );

  const selectedCommanders = useMemo(
    () =>
      [primaryCommander, secondCommander].filter(
        (card): card is CardRecord => Boolean(card)
      ),
    [primaryCommander, secondCommander]
  );

  const activeColors =
    format === "commander" ? commanderColorIdentity(selectedCommanders) : colors;

  const tuning = useMemo<DeckTuning>(
    () => ({
      strategy,
      lands: landsTune,
      ramp: rampTune,
      draw: drawTune,
      interaction: interactionTune,
      boardwipes: boardwipeTune,
      protection: protectionTune,
      recursion: recursionTune,
      synergy: synergyTune,
      curve: curveTune,
      commanderSynergy: commanderSynergyTune,
      aggression: aggressionTune
    }),
    [
      strategy,
      landsTune,
      rampTune,
      drawTune,
      interactionTune,
      boardwipeTune,
      protectionTune,
      recursionTune,
      synergyTune,
      curveTune,
      commanderSynergyTune,
      aggressionTune
    ]
  );

  const profile = useMemo(
    () => deckProfileFor(format, target, tuning),
    [format, target, tuning]
  );

  const lockedIds = useMemo(
    () => new Set(lockedCards.map(card => card.id)),
    [lockedCards]
  );

  const excludedIds = useMemo(
    () => new Set(excludedCardIds),
    [excludedCardIds]
  );

  const wizardSteps = useMemo<Array<{ id: BuilderStepId; label: string; hint: string }>>(
    () => [
      {
        id: "name",
        label: "Name",
        hint: "Gib deinem Deck einen Namen. Er kann später jederzeit geändert werden."
      },
      {
        id: "format",
        label: "Format",
        hint: "Wähle das Format. Bei Standard legst du hier zusätzlich die gewünschten Deckfarben fest."
      },
      ...(format === "commander"
        ? [
            {
              id: "commander" as BuilderStepId,
              label: "Commander",
              hint: "Der Commander bestimmt Farbidentität und einen wichtigen Teil der Synergie-Bewertung."
            }
          ]
        : []),
      {
        id: "strategy",
        label: "Strategie",
        hint: "Die Strategie legt fest, welche Karten und Rollen der Builder stärker priorisiert."
      },
      {
        id: "mana",
        label: "Mana Value",
        hint: "Lege Zielbereich und Schwerpunkt der Mana-Kurve fest. Minimum und Maximum sind harte Grenzen für Nichtland-Karten."
      },
      {
        id: "tuning",
        label: "Feinabstimmung",
        hint: "Passe Rollen und Spielstil an. Diese Werte kannst du nach dem ersten Build erneut verändern."
      }
    ],
    [format]
  );

  const currentStep = wizardSteps[Math.min(wizardIndex, wizardSteps.length - 1)];
  const strategyOptions = strategyOptionsFor(format);
  const selectedStrategy = strategyOptionFor(format, strategy);
  const suggestedStrategy = useMemo(
    () => recommendStrategy(format, tuning, strategy),
    [format, tuning, strategy]
  );
  const suggestedStrategyOption = strategyOptionFor(format, suggestedStrategy);

  useEffect(() => {
    if (
      secondCommanderId &&
      !secondCommanderOptions.some(card => card.id === secondCommanderId)
    ) {
      setSecondCommanderId("");
    }
  }, [secondCommanderId, secondCommanderOptions]);

  useEffect(() => {
    if (!strategyOptions.some(option => option.id === strategy)) {
      setStrategy(format === "commander" ? "midrange" : "balanced");
    }
  }, [format, strategy, strategyOptions]);

  const resetDeckSelection = () => {
    setResult(null);
    setLockedCards([]);
    setExcludedCardIds([]);
    setShowResultTuning(false);
  };

  const changeFormat = (next: Format) => {
    setFormat(next);
    resetDeckSelection();

    if (next === "standard") {
      setCommanderId("");
      setSecondCommanderId("");
      setStrategy("balanced");
    } else {
      setStrategy("midrange");
    }
  };

  const chooseCommander = (id: string) => {
    setCommanderId(id);
    setSecondCommanderId("");
    resetDeckSelection();
  };

  const chooseSecondCommander = (id: string) => {
    setSecondCommanderId(id);
    resetDeckSelection();
  };

  const toggleStandardColor = (color: string) => {
    setColors(current =>
      current.includes(color)
        ? current.filter(value => value !== color)
        : [...current, color]
    );
    resetDeckSelection();
  };

  const build = async (strategyOverride?: DeckStrategy) => {
    if (buildBusy) return;

    setBuildBusy(true);

    const effectiveTuning: DeckTuning = {
      ...tuning,
      strategy: strategyOverride ?? strategy
    };

    const baseOptions = {
      name: name.trim() || "Neues Deck",
      format,
      colors: activeColors,
      commanders: format === "commander" ? selectedCommanders : undefined,
      targetManaValue: target,
      minManaValue: min,
      maxManaValue: max,
      tuning: effectiveTuning,
      lockedCards,
      excludedCardIds
    };

    try {
      const preliminaryDeck = buildDeck(pool, baseOptions);

      const evidence = await getBuildDeckEvidence({
        format,
        commanders: format === "commander" ? selectedCommanders : [],
        preliminaryDeck,
        pool
      });

      const optimizedDeck = buildDeck(pool, {
        ...baseOptions,
        intelligence: evidence.buildSignals
      });

      setResult(optimizedDeck);
      setShowResultTuning(false);
    } finally {
      setBuildBusy(false);
    }
  };

  const toggleLocked = (card: DeckRecord["cards"][number]) => {
    setExcludedCardIds(current => current.filter(id => id !== card.id));
    setLockedCards(current =>
      current.some(item => item.id === card.id)
        ? current.filter(item => item.id !== card.id)
        : [...current, { id: card.id, count: card.count }]
    );
  };

  const toggleExcluded = (card: DeckRecord["cards"][number]) => {
    setLockedCards(current => current.filter(item => item.id !== card.id));
    setExcludedCardIds(current =>
      current.includes(card.id)
        ? current.filter(id => id !== card.id)
        : [...current, card.id]
    );
  };

  const resultHasCards =
    (result?.cards.reduce((sum, card) => sum + card.count, 0) ?? 0) > 0;

  const builderDisabled =
    buildBusy ||
    pool.length === 0 ||
    (format === "commander"
      ? selectedCommanders.length === 0
      : colors.length === 0) ||
    min > max;

  const canContinue = (() => {
    if (!currentStep) return false;
    if (currentStep.id === "name") return name.trim().length > 0;
    if (currentStep.id === "format") {
      return format === "commander" || colors.length > 0;
    }
    if (currentStep.id === "commander") return selectedCommanders.length > 0;
    if (currentStep.id === "mana") return min <= max;
    return true;
  })();

  const nextStep = () => {
    setWizardIndex(index => Math.min(index + 1, wizardSteps.length - 1));
  };

  const previousStep = () => {
    setWizardIndex(index => Math.max(0, index - 1));
  };

  const renderTuningPanel = () => (
    <div className="tuning-section builder-tuning-panel">
      <div className="tuning-heading">
        <h3>Deck feinabstimmen</h3>
        <p className="muted">
          Jeder Regler verändert die Zielgewichte des Builders. Die Erklärung unter dem Regler beschreibt die praktische Auswirkung.
        </p>
      </div>

      <TuningSlider
        label="Länder"
        value={landsTune}
        onChange={setLandsTune}
        help="Mehr Länder erhöhen die Chance auf konstante Landdrops. Weniger Länder schaffen Platz für Nichtländer, erhöhen aber das Risiko von Mana-Problemen."
      />
      <TuningSlider
        label="Ramp"
        value={rampTune}
        onChange={setRampTune}
        help="Mehr Ramp priorisiert Mana-Beschleunigung. Das hilft besonders bei höheren Mana-Kurven und teuren Commandern."
      />
      <TuningSlider
        label="Card Draw"
        value={drawTune}
        onChange={setDrawTune}
        help="Mehr Card Draw erhöht die Zielmenge an Kartennachschub und langfristigem Kartenvorteil."
      />
      <TuningSlider
        label="Interaktion"
        value={interactionTune}
        onChange={setInteractionTune}
        help="Mehr Interaktion erhöht die Zielmenge direkter Antworten wie Removal, Counter oder anderer gegnerischer Unterbrechung."
      />
      <TuningSlider
        label="Boardwipes"
        value={boardwipeTune}
        onChange={setBoardwipeTune}
        help="Mehr Boardwipes priorisiert breite Antworten auf mehrere Permanents oder Kreaturen."
      />
      <TuningSlider
        label="Schutz"
        value={protectionTune}
        onChange={setProtectionTune}
        help="Mehr Schutz priorisiert Karten, die Commander, Engines oder andere wichtige Permanents absichern."
      />
      <TuningSlider
        label="Recursion"
        value={recursionTune}
        onChange={setRecursionTune}
        help="Mehr Recursion priorisiert Karten, die Ressourcen aus dem Friedhof erneut nutzbar machen."
      />
      <TuningSlider
        label="Synergie"
        value={synergyTune}
        onChange={setSynergyTune}
        help="Mehr Synergie bevorzugt Karten, die eng mit Commander, Strategie und anderen Karten zusammenarbeiten."
      />
      <TuningSlider
        label="Mana-Kurve"
        value={curveTune}
        onChange={setCurveTune}
        help="Niedriger verschiebt die Auswahl in günstigere Mana Values, höher erlaubt mehr teure Karten rund um dein Ziel."
        lowLabel="Niedriger"
        highLabel="Höher"
      />

      {format === "commander" && (
        <TuningSlider
          label="Commander-Synergie"
          value={commanderSynergyTune}
          onChange={setCommanderSynergyTune}
          help="Mehr Commander-Synergie gewichtet Karten stärker, deren erkannte Themen direkt zum Oracle-Text des Commanders passen."
          lowLabel="Locker"
          highLabel="Stärker"
        />
      )}

      <TuningSlider
        label="Spielstil"
        value={aggressionTune}
        onChange={setAggressionTune}
        help="Verschiebt die Auswahl zwischen defensiv-reaktiv und aggressiv. Sehr starke Änderungen können dazu führen, dass eine andere Grundstrategie besser passt."
        lowLabel="Defensiver"
        highLabel="Aggressiver"
      />

      <div className="profile-preview">
        <strong>Aktuelle Zielwerte</strong>
        <span>Länder {profile.lands}</span>
        <span>Ramp {profile.ramp}</span>
        <span>Draw {profile.draw}</span>
        <span>Interaktion {profile.interaction}</span>
        <span>Boardwipes {profile.boardwipes}</span>
        <span>Schutz {profile.protection}</span>
        <span>Recursion {profile.recursion}</span>
        <span>Synergie {profile.synergy}</span>
        <span>Ziel-MV {profile.targetManaValue.toFixed(1)}</span>
      </div>
    </div>
  );

  const renderBuilderToolbar = (showWizardNavigation: boolean) => (
    <div className="build-mode-toolbar automatic-builder-toolbar">
      <button className="secondary" type="button" onClick={onChangeBuildMode}>
        ← Bauart wechseln
      </button>

      <div className="automatic-builder-toolbar-copy">
        <strong>Automatischer Deckbau</strong>
        <span>Der Optimierer stellt ein Deck aus deiner Sammlung zusammen.</span>
      </div>

      {showWizardNavigation && (
        <div className="builder-wizard-nav builder-wizard-nav-top">
          <button
            className="secondary"
            type="button"
            onClick={previousStep}
            disabled={wizardIndex === 0 || buildBusy}
          >
            ← Zurück
          </button>

          {wizardIndex < wizardSteps.length - 1 ? (
            <button
              className="primary"
              type="button"
              onClick={nextStep}
              disabled={!canContinue || buildBusy}
            >
              Weiter →
            </button>
          ) : (
            <button
              className="primary"
              type="button"
              onClick={() => void build()}
              disabled={builderDisabled || !canContinue}
            >
              {buildBusy ? "Deck wird datenbasiert erstellt…" : "Deck erstellen"}
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (result) {
    const stats = deckStats(result);
    const strategyChanged = suggestedStrategy !== strategy;

    return (
      <section className="automatic-builder-result">
        <div className="pagehead">
          <div>
            <h2>{result.name}</h2>
            <p className="muted">
              Das Deck wurde mit deinen Vorgaben, deiner Sammlung und den verfügbaren Intelligence-Signalen erstellt.
            </p>
          </div>
        </div>

        <div className="builder-result-toolbar panel">
          <div className="builder-result-summary">
            <span><strong>{stats.total}</strong> Karten</span>
            <span><strong>{stats.lands}</strong> Länder</span>
            <span><strong>{stats.averageManaValue}</strong> Ø MV</span>
            <span><strong>{selectedStrategy.label}</strong> Strategie</span>
            <span><strong>{lockedCards.length}</strong> fixiert</span>
            <span><strong>{excludedCardIds.length}</strong> ausgeschlossen</span>
          </div>

          <div className="builder-result-actions">
            <button
              className="primary"
              type="button"
              onClick={() => void build()}
              disabled={builderDisabled}
            >
              {buildBusy ? "Deck wird neu erzeugt…" : "Mit gleichen Vorgaben neu erzeugen"}
            </button>

            <button
              className="secondary"
              type="button"
              onClick={() => setShowResultTuning(value => !value)}
            >
              {showResultTuning ? "Feinabstimmung schließen" : "Feinabstimmung anpassen"}
            </button>

            <button
              className="ghost"
              type="button"
              onClick={() => {
                setResult(null);
                setWizardIndex(0);
                setShowResultTuning(false);
              }}
            >
              Alle Vorgaben ändern
            </button>
          </div>
        </div>

        {showResultTuning && (
          <div className="panel result-tuning-panel">
            {renderTuningPanel()}

            <div className={`strategy-fit ${strategyChanged ? "strategy-fit-warning" : "strategy-fit-ok"}`}>
              {strategyChanged ? (
                <>
                  <strong>Strategie prüfen</strong>
                  <p>
                    Mit der aktuellen Feinabstimmung wirkt das Profil inzwischen eher wie
                    {" "}<b>{suggestedStrategyOption.label}</b> als wie {selectedStrategy.label}.
                    Das ist eine Empfehlung, keine automatische Änderung.
                  </p>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => {
                      setStrategy(suggestedStrategy);
                      void build(suggestedStrategy);
                    }}
                    disabled={buildBusy}
                  >
                    {suggestedStrategyOption.label} übernehmen und neu erzeugen
                  </button>
                </>
              ) : (
                <>
                  <strong>Strategie passt weiterhin</strong>
                  <p>
                    Die aktuelle Feinabstimmung ist weiterhin mit {selectedStrategy.label} vereinbar.
                  </p>
                </>
              )}
            </div>

            <button
              className="primary"
              type="button"
              onClick={() => void build()}
              disabled={builderDisabled}
            >
              {buildBusy ? "Optimierung läuft…" : "Mit Feinabstimmung neu erzeugen"}
            </button>
          </div>
        )}

        <div className="panel builder-board-panel">
          <div className="builder-board-intro">
            <div>
              <h3>Deckliste</h3>
              <p className="muted">
                Karten sind nach Typ gruppiert. Ein Klick auf die Karte öffnet die Detailansicht.
                „Behalten“ fixiert sie für den nächsten Build, „Ausschließen“ verbietet sie beim nächsten Build.
              </p>
            </div>
          </div>

          <DeckBoard
            deck={result}
            pool={pool}
            onCardClick={setSelectedCard}
            lockedIds={lockedIds}
            excludedIds={excludedIds}
            onToggleLocked={toggleLocked}
            onToggleExcluded={toggleExcluded}
          />

          {!resultHasCards && (
            <div className="notice">
              Es wurden keine passenden Karten für das Hauptdeck gefunden. Speichern und Export sind deaktiviert.
            </div>
          )}

          <div className="row builder-final-actions">
            <button
              className="primary"
              onClick={() => onSave(result)}
              disabled={!resultHasCards}
            >
              Deck speichern
            </button>

            <button
              className="secondary"
              onClick={() =>
                download(`${result.name}.txt`, deckText(result, pool))
              }
              disabled={!resultHasCards}
            >
              Export
            </button>
          </div>
        </div>

        {selectedCard && (
          <CardDetailsModal
            card={selectedCard}
            onClose={() => setSelectedCard(null)}
          />
        )}
      </section>
    );
  }

  return (
    <section className="automatic-builder-wizard">
      {renderBuilderToolbar(true)}
      <div className="pagehead">
        <div>
          <h2>Deck automatisch bauen</h2>
          <p className="muted">
            Der Builder führt dich Schritt für Schritt durch die wichtigsten Entscheidungen und erstellt das Deck erst am Ende.
          </p>
        </div>
      </div>

      <ol className="builder-wizard-progress" aria-label="Schritte des automatischen Deckbaus">
        {wizardSteps.map((step, index) => (
          <li
            key={step.id}
            className={
              index === wizardIndex
                ? "active"
                : index < wizardIndex
                  ? "done"
                  : ""
            }
          >
            <span>{index + 1}</span>
            <strong>{step.label}</strong>
          </li>
        ))}
      </ol>

      <div className="panel builder-wizard-card">
        <header className="builder-step-head">
          <div>
            <span className="eyebrow">
              Schritt {wizardIndex + 1} von {wizardSteps.length}
            </span>
            <h3>{currentStep?.label}</h3>
            <p>{currentStep?.hint}</p>
          </div>
        </header>

        {currentStep?.id === "name" && (
          <div className="builder-step-content">
            <label>
              Deckname
              <input
                autoFocus
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="z. B. Cloud Equipment"
              />
            </label>
            <p className="builder-choice-explanation">
              Der Name beeinflusst die Kartenauswahl nicht. Er dient nur zur Wiedererkennung in deiner Deckbibliothek.
            </p>
          </div>
        )}

        {currentStep?.id === "format" && (
          <div className="builder-step-content">
            <div className="strategy-choice-grid format-choice-grid">
              <button
                type="button"
                className={format === "commander" ? "strategy-choice active" : "strategy-choice"}
                onClick={() => changeFormat("commander")}
              >
                <strong>Commander</strong>
                <span>100 Karten inklusive Commander, Singleton-Regeln und Farbidentität.</span>
              </button>
              <button
                type="button"
                className={format === "standard" ? "strategy-choice active" : "strategy-choice"}
                onClick={() => changeFormat("standard")}
              >
                <strong>Standard</strong>
                <span>60-Karten-Constructed-Deck mit Standard-Legalität und normalen Copy-Limits.</span>
              </button>
            </div>

            {format === "standard" && (
              <div className="builder-substep">
                <h4>Deckfarben</h4>
                <p className="muted">
                  Die Farbauswahl ist ein Builder-Filter. Sie ersetzt keine Format-Legalitätsprüfung.
                </p>
                <div className="color-pills">
                  {COLORS.map(color => (
                    <button
                      key={color}
                      type="button"
                      className={colors.includes(color) ? "color active" : "color"}
                      onClick={() => toggleStandardColor(color)}
                    >
                      {color}
                      <span>{COLOR_NAMES[color]}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {currentStep?.id === "commander" && (
          <div className="builder-step-content">
            <label>
              Commander
              <select
                value={commanderId}
                onChange={event => chooseCommander(event.target.value)}
              >
                <option value="">— Commander wählen —</option>
                {commanders.map(card => (
                  <option key={card.id} value={card.id}>
                    {card.name}
                  </option>
                ))}
              </select>
            </label>

            {primaryCommander && secondCommanderOptions.length > 0 && (
              <label>
                Zweiter Commander (optional)
                <select
                  value={secondCommanderId}
                  onChange={event => chooseSecondCommander(event.target.value)}
                >
                  <option value="">— kein zweiter Commander —</option>
                  {secondCommanderOptions.map(card => (
                    <option key={card.id} value={card.id}>
                      {card.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {primaryCommander && (
              <div className="builder-choice-explanation">
                <strong>Farbidentität:</strong>{" "}
                {activeColors.length
                  ? activeColors.map(color => COLOR_NAMES[color] ?? color).join(", ")
                  : "Farblos"}
                <br />
                Der automatische Builder verwendet ausschließlich Karten, die zur Commander-Farbidentität und den Commander-Regeln passen.
              </div>
            )}

            {commanders.length === 0 && (
              <div className="notice">
                In deiner Sammlung wurde aktuell kein Commander-Kandidat gefunden.
              </div>
            )}
          </div>
        )}

        {currentStep?.id === "strategy" && (
          <div className="builder-step-content">
            <div className="strategy-choice-grid">
              {strategyOptions.map(option => (
                <button
                  type="button"
                  key={option.id}
                  className={strategy === option.id ? "strategy-choice active" : "strategy-choice"}
                  onClick={() => setStrategy(option.id)}
                >
                  <strong>{option.label}</strong>
                </button>
              ))}
            </div>

            <div className="builder-choice-explanation strategy-description">
              <strong>{selectedStrategy.label}</strong>
              <p>{selectedStrategy.description}</p>
            </div>
          </div>
        )}

        {currentStep?.id === "mana" && (
          <div className="builder-step-content mana-step-grid">
            <label>
              Ziel-Mana Value: <strong>{target.toFixed(1)}</strong>
              <input
                type="range"
                min="0"
                max="15"
                step="0.1"
                value={target}
                onChange={event => setTarget(Number(event.target.value))}
              />
              <small>
                Schwerpunkt der Nichtland-Karten. Das ist kein hartes Maximum.
              </small>
            </label>

            <label>
              Minimum Mana Value: <strong>{min.toFixed(1)}</strong>
              <input
                type="range"
                min="0"
                max="15"
                step="0.5"
                value={min}
                onChange={event => setMin(Number(event.target.value))}
              />
              <small>
                Harte Untergrenze für Nichtland-Karten.
              </small>
            </label>

            <label>
              Maximum Mana Value: <strong>{max.toFixed(1)}</strong>
              <input
                type="range"
                min="0"
                max="15"
                step="0.5"
                value={max}
                onChange={event => setMax(Number(event.target.value))}
              />
              <small>
                Harte Obergrenze für Nichtland-Karten.
              </small>
            </label>

            {min > max && (
              <div className="error">
                Minimum Mana Value darf nicht größer als Maximum Mana Value sein.
              </div>
            )}
          </div>
        )}

        {currentStep?.id === "tuning" && (
          <div className="builder-step-content">
            {renderTuningPanel()}
          </div>
        )}

        {pool.length === 0 && (
          <div className="notice">
            Deine Sammlung ist leer. Füge zuerst Karten über die Kartensuche hinzu.
          </div>
        )}
      </div>
    </section>
  );
}


function BuildHub({
  pool,
  onSave
}: {
  pool: CardRecord[];
  onSave: (deck: DeckRecord) => Promise<void>;
}) {
  const [mode, setMode] = useState<"automatic" | "manual" | null>(null);
  const [manualDeck, setManualDeck] = useState<DeckRecord | null>(null);

  const startManual = () => {
    const now = Date.now();
    setManualDeck({
      id: crypto.randomUUID(),
      name: "Neues manuelles Deck",
      format: "standard",
      commanderIds: [],
      cards: [],
      sideboard: [],
      colors: [],
      createdAt: now,
      updatedAt: now,
      notes: "Manuell zusammengestelltes Deck."
    });
    setMode("manual");
  };

  if (mode === "automatic") {
    return (
      <Builder
        pool={pool}
        onSave={onSave}
        onChangeBuildMode={() => setMode(null)}
      />
    );
  }

  if (mode === "manual" && manualDeck) {
    return (
      <DeckEditor
        deck={manualDeck}
        pool={pool}
        onBack={() => {
          setManualDeck(null);
          setMode(null);
        }}
        onSave={async deck => {
          await onSave(deck);
          setManualDeck(null);
          setMode(null);
        }}
      />
    );
  }

  return (
    <section className="build-mode-page">
      <div className="pagehead">
        <div>
          <h2>Deck bauen</h2>
          <p className="muted">
            Wähle zuerst, ob Arcane Decksmith das Deck automatisch optimieren soll oder ob du jede Karte selbst auswählst.
          </p>
        </div>
      </div>

      <div className="build-mode-grid">
        <button
          type="button"
          className="build-mode-card"
          onClick={() => setMode("automatic")}
        >
          <span className="build-mode-icon">✦</span>
          <div>
            <h3>Automatisch bauen</h3>
            <p>
              Nutzt Strategie, Rollen, Mana-Kurve, Commander-Synergien und die angebundenen Deck-Intelligence-Daten, um ein Deck aus deiner Sammlung zu erstellen.
            </p>
          </div>
          <strong>Automatischen Builder öffnen →</strong>
        </button>

        <button
          type="button"
          className="build-mode-card"
          onClick={startManual}
        >
          <span className="build-mode-icon">＋</span>
          <div>
            <h3>Manuell bauen</h3>
            <p>
              Wähle Commander, Format und Karten selbst. Commander-Farbidentität, Legalität, Bestandsmenge und Copy-Limits werden beim Hinzufügen direkt berücksichtigt.
            </p>
          </div>
          <strong>Manuellen Editor öffnen →</strong>
        </button>
      </div>
    </section>
  );
}

function Decks({
  decks,
  pool,
  selectedDeckId,
  onOpenDeck,
  onCloseDeck,
  onDelete,
  onSave
}: {
  decks: DeckRecord[];
  pool: CardRecord[];
  selectedDeckId: string | null;
  onOpenDeck: (id: string) => void;
  onCloseDeck: () => void;
  onDelete: (id: string) => Promise<void>;
  onSave: (d: DeckRecord) => Promise<void>;
}) {
  const [editing, setEditing] = useState<DeckRecord | null>(null);
  const [analysisByDeckId, setAnalysisByDeckId] = useState<Record<string, string>>({});
  const [aiBusyDeckId, setAiBusyDeckId] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<CardRecord | null>(null);
  const [maxSuggestionCardPrice, setMaxSuggestionCardPrice] = useState("");
  const [maxSuggestionDeckPrice, setMaxSuggestionDeckPrice] = useState("");
  const [importDeckOpen, setImportDeckOpen] = useState(false);

  const purchaseBudget: PurchaseSuggestionBudget = {
    maxPricePerCardEur: optionalEuroLimit(maxSuggestionCardPrice),
    maxPricePerDeckEur: optionalEuroLimit(maxSuggestionDeckPrice)
  };

  const selectedDeck = selectedDeckId
    ? decks.find(deck => deck.id === selectedDeckId) ?? null
    : null;

  const analyzeSavedDeck = async (deck: DeckRecord) => {
    if (deck.cards.length === 0 || aiBusyDeckId) {
      return;
    }

    setAiBusyDeckId(deck.id);
    setAnalysisByDeckId(current => ({ ...current, [deck.id]: "" }));

    const deckForAnalysis = deckForAiAnalysis(deck, poolForDeck(deck, pool));

    try {
      const text = await generateAiDeckExplanation(
        deckForAnalysis,
        purchaseBudget
      );
      setAnalysisByDeckId(current => ({ ...current, [deck.id]: text }));
    } catch (error) {
      console.error("KI-Analyse fehlgeschlagen:", error);

      const fallback = generateDeckExplanation(deckForAnalysis);
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unbekannter Fehler bei der KI-Analyse.";

      setAnalysisByDeckId(current => ({
        ...current,
        [deck.id]:
          fallback +
          "\n\n---\n\n" +
          "### ⚠️ Generative KI nicht verfügbar\n\n" +
          errorMessage +
          "\n\nDie lokale Deckanalyse wird deshalb als Fallback angezeigt."
      }));
    } finally {
      setAiBusyDeckId(null);
    }
  };

  if (editing) {
    return (
      <DeckEditor
        deck={editing}
        pool={poolForDeck(editing, pool)}
        onBack={() => setEditing(null)}
        onSave={async deck => {
          await onSave(deck);
          setEditing(null);
        }}
      />
    );
  }

  if (!selectedDeckId) {
    return (
      <>
        <DeckLibrary
          decks={decks}
          pool={pool}
          onOpenDeck={onOpenDeck}
          onImportDeck={() => setImportDeckOpen(true)}
        />
        {importDeckOpen && (
          <Suspense fallback={<div className="loading">Import wird geladen…</div>}>
            <ExternalImportDialog
              mode="deck"
              pool={pool}
              onClose={() => setImportDeckOpen(false)}
              onImportDeck={onSave}
            />
          </Suspense>
        )}
      </>
    );
  }

  if (!selectedDeck) {
    return (
      <section>
        <div className="pagehead">
          <button type="button" className="secondary" onClick={onCloseDeck}>
            ← Zurück zu Decks
          </button>
        </div>
        <div className="panel empty-state">
          <h2>Deck nicht gefunden</h2>
          <p className="muted">
            Das angeforderte Deck existiert nicht mehr oder konnte nicht geladen werden.
          </p>
        </div>
      </section>
    );
  }

  const selectedDeckPool = poolForDeck(selectedDeck, pool);
  const stats = deckStats(selectedDeck);
  const totalMain = selectedDeck.cards.reduce((sum, card) => sum + card.count, 0);
  const totalCards =
    totalMain +
    (selectedDeck.format === "commander" ? selectedDeck.commanderIds.length : 0);
  const commanders = selectedDeck.commanderIds
    .map(id => selectedDeckPool.find(card => card.id === id))
    .filter((card): card is CardRecord => Boolean(card));
  const bracketEstimate = commanderBracketEstimate(selectedDeck, selectedDeckPool);
  const analysis = analysisByDeckId[selectedDeck.id];
  const colorCombinationName = officialColorCombinationName(selectedDeck.colors);

  return (
    <section className="deck-detail-page">
      <div className="pagehead deck-detail-pagehead">
        <button type="button" className="secondary" onClick={onCloseDeck}>
          ← Zurück zu Decks
        </button>

        <div className="deck-detail-title">
          <h2>{selectedDeck.name}</h2>
          <p className="muted">
            {selectedDeck.format === "commander" ? "Commander" : "Standard"}
            {colorCombinationName ? ` · ${colorCombinationName}` : ""}
            {commanders.length > 0 ? ` · ${commanders.map(card => card.name).join(" + ")}` : ""}
          </p>
        </div>

        <div className="row deck-detail-actions">
          <button
            className="secondary"
            type="button"
            onClick={() => void analyzeSavedDeck(selectedDeck)}
            disabled={Boolean(aiBusyDeckId) || selectedDeck.cards.length === 0}
            title={
              selectedDeck.cards.length === 0
                ? "Für ein leeres Deck ist keine Analyse sinnvoll."
                : undefined
            }
          >
            {aiBusyDeckId === selectedDeck.id ? "KI analysiert…" : "KI analysieren"}
          </button>

          <button className="primary" type="button" onClick={() => setEditing(selectedDeck)}>
            Bearbeiten
          </button>

          <button
            className="secondary"
            type="button"
            onClick={() => {
              const now = Date.now();
              void onSave({
                ...selectedDeck,
                id: crypto.randomUUID(),
                name: `${selectedDeck.name} – Kopie`,
                createdAt: now,
                updatedAt: now
              });
            }}
          >
            Duplizieren
          </button>

          <button
            className="secondary"
            type="button"
            onClick={() => download(`${selectedDeck.name}.txt`, deckText(selectedDeck, selectedDeckPool))}
          >
            Export
          </button>

          <button
            className="danger ghost"
            type="button"
            onClick={() => {
              if (window.confirm(`Deck „${selectedDeck.name}“ wirklich löschen?`)) {
                void onDelete(selectedDeck.id).then(onCloseDeck);
              }
            }}
          >
            Löschen
          </button>
        </div>
      </div>

      <div className="deck-detail-summary panel">
        <div className="stats deck-detail-stats">
          <div>
            <strong>{totalCards}</strong>
            <span>Karten gesamt</span>
          </div>
          <div>
            <strong>{stats.lands}</strong>
            <span>Länder</span>
          </div>
          <div>
            <strong>{stats.nonland}</strong>
            <span>Nichtländer</span>
          </div>
          <div>
            <strong>{stats.averageManaValue}</strong>
            <span>Ø Mana Value</span>
          </div>
          {typeof selectedDeck.score === "number" && (
            <div>
              <strong>{selectedDeck.score}/100</strong>
              <span>Deck-Score</span>
            </div>
          )}
          {bracketEstimate && (
            <div>
              <strong>{bracketEstimate.bracket}</strong>
              <span>Commander-Bracket</span>
            </div>
          )}
          <div className="budget-stat">
            <label>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Unbegrenzt"
                value={maxSuggestionCardPrice}
                onChange={event => setMaxSuggestionCardPrice(event.target.value)}
                aria-label="Maximalpreis pro Karte"
              />
              <span>Max. pro Karte (€)</span>
            </label>
          </div>
          <div className="budget-stat">
            <label>
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder="Unbegrenzt"
                value={maxSuggestionDeckPrice}
                onChange={event => setMaxSuggestionDeckPrice(event.target.value)}
                aria-label="Maximalpreis gesamt pro Deck"
              />
              <span>Max. gesamt pro Deck (€)</span>
            </label>
          </div>
        </div>

        {typeof selectedDeck.score === "number" && (
          <div className="deck-score-explanation muted" style={{ fontSize: "0.78rem", lineHeight: 1.45 }}>
            <strong>Deck-Score:</strong> 0–100 Punkte. Bewertet, wie gut das Deck das
            gewählte Zielprofil erfüllt: Vollständigkeit 35 %, Länderabdeckung 20 %,
            Rollenabdeckung 30 % und Nähe zur Ziel-Manakurve 15 %. 100 bedeutet,
            dass das Zielprofil vollständig erfüllt ist – nicht eine garantierte
            Gewinnchance.
          </div>
        )}
      </div>

      <DeckBoard deck={selectedDeck} pool={selectedDeckPool} onCardClick={setSelectedCard} />

      {analysis && (
        <div className="ai-box analysis-box markdown-content deck-detail-analysis">
          <Suspense fallback={<p className="muted">Analyse wird dargestellt…</p>}>
            <Markdown>{analysis}</Markdown>
          </Suspense>
        </div>
      )}

      {selectedCard && (
        <CardDetailsModal card={selectedCard} onClose={() => setSelectedCard(null)} />
      )}
    </section>
  );
}

function DeckEditor({
  deck,
  pool,
  onBack,
  onSave
}: {
  deck: DeckRecord;
  pool: CardRecord[];
  onBack: () => void;
  onSave: (
    d: DeckRecord
  ) => Promise<void>;
}) {
  const [
    d,
    setD
  ] =
    useState(deck);

  const [
    analysisText,
    setAnalysisText
  ] =
    useState("");

  const [
    aiBusy,
    setAiBusy
  ] =
    useState(false);

  const [
    previewCardId,
    setPreviewCardId
  ] =
    useState<string | null>(
      null
    );

  const [manualSearch, setManualSearch] = useState("");
  const [manualColors, setManualColors] = useState<string[]>([]);
  const [manualTypes, setManualTypes] = useState<string[]>([]);
  const [manualSet, setManualSet] = useState("");
  const [maxSuggestionCardPrice, setMaxSuggestionCardPrice] = useState("");
  const [maxSuggestionDeckPrice, setMaxSuggestionDeckPrice] = useState("");

  const purchaseBudget: PurchaseSuggestionBudget = {
    maxPricePerCardEur: optionalEuroLimit(maxSuggestionCardPrice),
    maxPricePerDeckEur: optionalEuroLimit(maxSuggestionDeckPrice)
  };

  const previewCard =
    previewCardId
      ? pool.find(
          card =>
            card.id ===
            previewCardId
        ) ?? null
      : null;

  const all = [
    ...d.cards
  ];

  const availableCommanders =
    useMemo(
      () =>
        commanderCandidates(
          pool
        ),
      [pool]
    );

  const selectedCommanders =
    useMemo(
      () =>
        d.format ===
        "commander"
          ? d.commanderIds
              .map(
                id =>
                  pool.find(
                    card =>
                      card.id ===
                      id
                  )
              )
              .filter(
                (
                  card
                ): card is CardRecord =>
                  Boolean(card)
              )
              .slice(
                0,
                2
              )
          : [],
      [
        d.commanderIds,
        d.format,
        pool
      ]
    );

  const primaryCommander =
    selectedCommanders[0];

  const secondCommander =
    selectedCommanders[1];

  const secondCommanderOptions =
    useMemo(
      () =>
        primaryCommander
          ? commanderPairCandidates(
              pool,
              primaryCommander
            )
          : [],
      [
        pool,
        primaryCommander
      ]
    );

  const commanderColors =
    commanderColorIdentity(
      selectedCommanders
    );

  const mainDeckCount =
    all.reduce(
      (
        sum,
        card
      ) =>
        sum +
        card.count,
      0
    );

  const commanderCount =
    d.format ===
    "commander"
      ? selectedCommanders.length
      : 0;

  const totalCards =
    mainDeckCount +
    commanderCount;

  const bracketEstimate =
    commanderBracketEstimate(
      d,
      pool
    );

  const commanderMainTarget =
    100 -
    Math.max(
      1,
      commanderCount
    );

  const isSourceLegal =
    (
      card:
        CardRecord
    ) => {
      if (
        d.format ===
        "standard"
      ) {
        return cardLegalForDeck(
          card,
          "standard"
        );
      }

      if (
        selectedCommanders.length ===
        0
      ) {
        return false;
      }

      return (
        !d.commanderIds.includes(
          card.id
        ) &&
        cardLegalForDeck(
          card,
          "commander",
          commanderColors
        )
      );
    };

  const legalPool =
    pool.filter(
      isSourceLegal
    );

  const manualSetOptions = useMemo(
    () =>
      Array.from(
        new Map(
          legalPool.map(card => [
            card.set.toLowerCase(),
            card.setName ? `${card.setName} (${card.set.toUpperCase()})` : card.set.toUpperCase()
          ])
        ).entries()
      ).sort((a, b) => a[1].localeCompare(b[1], "de")),
    [legalPool]
  );

  const manualFilteredPool = useMemo(() => {
    const search = manualSearch.trim().toLowerCase();

    const typeMatches = (card: CardRecord) => {
      if (manualTypes.length === 0) return true;
      const typeLine = card.typeLine ?? "";
      return manualTypes.some(type => new RegExp(`\\b${type}\\b`, "i").test(typeLine));
    };

    const colorMatches = (card: CardRecord) => {
      if (manualColors.length === 0) return true;
      const identity = card.colorIdentity ?? card.colors ?? [];
      return manualColors.some(color =>
        color === "C" ? identity.length === 0 : identity.includes(color)
      );
    };

    return legalPool.filter(card =>
      (!search || card.name.toLowerCase().includes(search)) &&
      typeMatches(card) &&
      colorMatches(card) &&
      (!manualSet || card.set.toLowerCase() === manualSet)
    );
  }, [legalPool, manualColors, manualSearch, manualSet, manualTypes]);

  const toggleManualFilter = (
    value: string,
    setValues: Dispatch<SetStateAction<string[]>>
  ) => {
    setValues(current =>
      current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value]
    );
  };

  const illegalCards =
    all.filter(
      deckCard => {
        const source =
          pool.find(
            card =>
              card.id ===
              deckCard.id
          );

        return source
          ? !isSourceLegal(
              source
            )
          : true;
      }
    );

  const deckCountByName =
    all.reduce<
      Record<
        string,
        number
      >
    >(
      (
        counts,
        card
      ) => {
        const key =
          card.name.toLowerCase();

        counts[key] =
          (
            counts[key] ??
            0
          ) +
          card.count;

        return counts;
      },
      {}
    );

  const copyViolationNames =
    Array.from(
      new Set(
        all
          .filter(
            deckCard => {
              const source =
                pool.find(
                  card =>
                    card.id ===
                    deckCard.id
                );

              if (!source) {
                return false;
              }

              const ruleLimit =
                deckCopyLimit(
                  source,
                  d.format
                );

              const totalByName =
                deckCountByName[
                  deckCard.name.toLowerCase()
                ] ??
                0;

              return (
                totalByName >
                  ruleLimit ||
                deckCard.count >
                  source.count
              );
            }
          )
          .map(
            card =>
              card.name
          )
      )
    );

  const pairInvalid =
    d.format ===
      "commander" &&
    Boolean(
      secondCommander
    ) &&
    !secondCommanderOptions.some(
      card =>
        card.id ===
        secondCommander?.id
    );

  const commanderTooLarge =
    d.format ===
      "commander" &&
    totalCards >
      100;

  const hasBlockingError =
    illegalCards.length >
      0 ||
    copyViolationNames.length >
      0 ||
    Boolean(
      pairInvalid
    ) ||
    commanderTooLarge;

  const canAnalyze =
    d.cards.length >
      0;

  const analyzeManualDeck =
    async () => {
      if (!canAnalyze) {
        return;
      }

      setAiBusy(true);
      setAnalysisText("");

      const deckForAnalysis =
        deckForAiAnalysis(
          d,
          pool
        );

      try {
        const text =
          await generateAiDeckExplanation(
            deckForAnalysis,
            purchaseBudget
          );

        setAnalysisText(
          text
        );
      } catch (error) {
        console.error(
          "KI-Analyse fehlgeschlagen:",
          error
        );

        const fallback =
          generateDeckExplanation(
            deckForAnalysis
          );

        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unbekannter Fehler bei der KI-Analyse.";

        setAnalysisText(
          fallback +
          "\n\n---\n\n" +
          "### ⚠️ Generative KI nicht verfügbar\n\n" +
          errorMessage +
          "\n\nDie lokale Deckanalyse wird deshalb als Fallback angezeigt."
        );
      } finally {
        setAiBusy(false);
      }
    };

  const add =
    (
      card:
        CardRecord
    ) => {
      if (
        !isSourceLegal(
          card
        )
      ) {
        return;
      }

      setD(current => {
        const existing =
          current.cards.find(
            item =>
              item.id ===
              card.id
          );

        const currentCount =
          existing?.count ??
          0;

        const currentByName =
          current.cards
            .filter(
              item =>
                item.name.toLowerCase() ===
                card.name.toLowerCase()
            )
            .reduce(
              (
                sum,
                item
              ) =>
                sum +
                item.count,
              0
            );

        const ruleLimit =
          deckCopyLimit(
            card,
            current.format
          );

        if (
          currentCount >=
            card.count ||
          currentByName >=
            ruleLimit
        ) {
          return current;
        }

        const currentCommanderCount =
          current.format ===
          "commander"
            ? current.commanderIds.length
            : 0;

        const currentMainCount =
          current.cards.reduce(
            (
              sum,
              item
            ) =>
              sum +
              item.count,
            0
          );

        const maxMain =
          current.format ===
          "commander"
            ? 100 -
              Math.max(
                1,
                currentCommanderCount
              )
            : Infinity;

        if (
          currentMainCount >=
          maxMain
        ) {
          return current;
        }

        if (existing) {
          return {
            ...current,
            cards:
              current.cards.map(
                item =>
                  item.id ===
                  card.id
                    ? {
                        ...item,
                        count:
                          item.count +
                          1,
                        available:
                          card.count
                      }
                    : item
              )
          };
        }

        return {
          ...current,
          cards: [
            ...current.cards,
            {
              id:
                card.id,
              name:
                card.name,
              count:
                1,
              manaValue:
                card.manaValue,
              typeLine:
                card.typeLine,
              role:
                "Manuell",
              reason:
                "Manuell hinzugefügt",
              available:
                card.count
            }
          ]
        };
      });
    };

  const choosePrimaryCommander =
    (
      id:
        string
    ) => {
      if (!id) {
        setD(current => ({
          ...current,
          commanderIds: [],
          colors: []
        }));

        return;
      }

      const commander =
        pool.find(
          card =>
            card.id ===
            id
        );

      if (!commander) {
        return;
      }

      setD(current => ({
        ...current,
        commanderIds: [
          commander.id
        ],
        colors:
          commander.colorIdentity ??
          []
      }));
    };

  const chooseSecondCommander =
    (
      id:
        string
    ) => {
      if (
        !primaryCommander
      ) {
        return;
      }

      if (!id) {
        setD(current => ({
          ...current,
          commanderIds: [
            primaryCommander.id
          ],
          colors:
            primaryCommander.colorIdentity ??
            []
        }));

        return;
      }

      const second =
        secondCommanderOptions.find(
          card =>
            card.id ===
            id
        );

      if (!second) {
        return;
      }

      const commanders = [
        primaryCommander,
        second
      ];

      setD(current => ({
        ...current,
        commanderIds:
          commanders.map(
            card =>
              card.id
          ),
        colors:
          commanderColorIdentity(
            commanders
          )
      }));
    };

  const changeFormat =
    (
      format:
        Format
    ) => {
      setD(current => ({
        ...current,
        format,
        commanderIds:
          format ===
          "commander"
            ? current.commanderIds.slice(
                0,
                2
              )
            : [],
        colors:
          format ===
          "commander"
            ? current.colors
            : [],
        cedh:
          format ===
          "commander"
            ? current.cedh
            : false
      }));

      setAnalysisText("");
    };

  return (
    <section>
      <div className="pagehead">
        <button
          className="secondary"
          onClick={onBack}
        >
          ← Zurück
        </button>

        <div>
          <h2>
            {d.name}
          </h2>

          <p className="muted">
            Manueller Deck-Editor · {totalCards} Karten
          </p>
        </div>

        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              void analyzeManualDeck()
            }
            disabled={
              aiBusy ||
              !canAnalyze
            }
            title={
              d.cards.length ===
                0
                ? "Für ein leeres Deck ist keine Analyse sinnvoll."
                : undefined
            }
          >
            {aiBusy
              ? "KI analysiert…"
              : "Deck analysieren"}
          </button>

          <button
            className="primary"
            disabled={
              hasBlockingError
            }
            title={
              hasBlockingError
                ? "Behebe zuerst die Regelverstöße im Deck."
                : undefined
            }
            onClick={() =>
              onSave({
                ...d,
                colors:
                  d.format ===
                  "commander"
                    ? commanderColors
                    : d.colors,
                updatedAt:
                  Date.now()
              })
            }
          >
            Speichern
          </button>
        </div>
      </div>

      <div className="panel deck-analysis-budget-panel">
        <PurchaseBudgetControls
          maxCardPrice={maxSuggestionCardPrice}
          maxDeckPrice={maxSuggestionDeckPrice}
          onMaxCardPriceChange={setMaxSuggestionCardPrice}
          onMaxDeckPriceChange={setMaxSuggestionDeckPrice}
        />
      </div>

      <details className="panel manual-settings-panel">
        <summary className="manual-settings-summary">
          <span>
            <strong>Deck-Einstellungen</strong>
            <small>Name, Format, Commander und Regelchecks</small>
          </span>
          <span className="manual-settings-toggle">Ein-/ausklappen</span>
        </summary>

        <div className="manual-settings-content">

        <div className="two">
          <label>
            Deckname

            <input
              value={d.name}
              onChange={e => {
                setD(current => ({
                  ...current,
                  name:
                    e.target.value
                }));

                setAnalysisText("");
              }}
              placeholder="Name des Decks"
            />
          </label>

          <label>
            Format

            <select
              value={d.format}
              onChange={e =>
                changeFormat(
                  e.target
                    .value as Format
                )
              }
            >
              <option value="standard">
                Standard
              </option>

              <option value="commander">
                Commander
              </option>
            </select>
          </label>
        </div>

        {d.format ===
          "commander" && (
          <label>
            Commander

            <select
              value={
                primaryCommander?.id ??
                ""
              }
              onChange={e => {
                choosePrimaryCommander(
                  e.target.value
                );

                setAnalysisText("");
              }}
            >
              <option value="">
                — Commander wählen —
              </option>

              {availableCommanders.map(
                card => (
                  <option
                    key={
                      card.id
                    }
                    value={
                      card.id
                    }
                  >
                    {
                      card.name
                    }
                  </option>
                )
              )}
            </select>
          </label>
        )}

        {d.format ===
          "commander" &&
          primaryCommander &&
          secondCommanderOptions.length >
            0 && (
            <label>
              Zweiter Commander (optional)

              <select
                value={
                  secondCommander?.id ??
                  ""
                }
                onChange={e => {
                  chooseSecondCommander(
                    e.target.value
                  );

                  setAnalysisText(
                    ""
                  );
                }}
              >
                <option value="">
                  — kein zweiter Commander —
                </option>

                {secondCommanderOptions.map(
                  card => (
                    <option
                      key={
                        card.id
                      }
                      value={
                        card.id
                      }
                    >
                      {
                        card.name
                      }
                    </option>
                  )
                )}
              </select>
            </label>
          )}

        {d.format ===
          "commander" &&
          availableCommanders.length ===
            0 && (
            <div className="notice">
              In deiner Sammlung wurde aktuell keine Karte gefunden, die als Commander verwendet werden kann.
            </div>
          )}

        {d.format ===
          "commander" && (
          <label className="row">
            <input
              type="checkbox"
              checked={Boolean(d.cedh)}
              onChange={e => {
                setD(current => ({
                  ...current,
                  cedh:
                    e.target.checked
                }));
                setAnalysisText("");
              }}
            />
            Dieses Deck ist gezielt für cEDH gebaut (Bracket 5)
          </label>
        )}

        {d.format === "standard" ? (
          <div className="stats">
            <div>
              <strong>{totalCards}</strong>
              <span>Karten aktuell</span>
            </div>
            <div>
              <strong>60+</strong>
              <span>Mindestgröße</span>
            </div>
          </div>
        ) : (
          selectedCommanders.length > 0 && (
            <div className="commander-summary">
              <div className="commander-summary-grid">
                <div>
                  <strong>{totalCards}/100</strong>
                  <span>Deckgröße</span>
                </div>
                <div>
                  <strong>{mainDeckCount}/{commanderMainTarget}</strong>
                  <span>Deck ohne Commander</span>
                </div>
                <div>
                  <strong>
                    {commanderColors.length > 0
                      ? commanderColors
                          .map(color => COLOR_NAMES[color] ?? color)
                          .join(", ")
                      : "Farblos"}
                  </strong>
                  <span>Farbidentität</span>
                </div>
                {bracketEstimate && (
                  <div>
                    <strong>{bracketEstimate.label}</strong>
                    <span>Bracket-Schätzung</span>
                  </div>
                )}
                <div>
                  <strong>{illegalCards.length}</strong>
                  <span>Format-/Farbverstöße</span>
                </div>
                <div>
                  <strong>{copyViolationNames.length}</strong>
                  <span>Kopier-/Bestandsverstöße</span>
                </div>
              </div>

              {bracketEstimate && (
                <details className="commander-check-details">
                  <summary>Commander-Check & Bracket-Details</summary>
                  <div className="commander-check-details-content">
                    <p className="muted">
                      Die Bracket-Schätzung ist eine automatische Orientierung. Spielabsicht
                      und nicht eindeutig erkennbare Kombos können nicht vollständig aus der
                      Deckliste bestimmt werden.
                    </p>

                    <div className="commander-check-metrics">
                      <span><strong>{bracketEstimate.gameChangers}</strong> Game Changer</span>
                      <span><strong>{bracketEstimate.tutorCards}</strong> Tutoren</span>
                      <span><strong>{bracketEstimate.extraTurnCards}</strong> Extra Turns</span>
                      <span><strong>{bracketEstimate.massLandDenialCards}</strong> Landverwehrung</span>
                    </div>

                    {bracketEstimate.reasons.length > 0 && (
                      <div className="deck-list">
                        {bracketEstimate.reasons.map(reason => (
                          <div key={reason}>
                            <span>{reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          )
        )}

        {d.format ===
          "standard" &&
          totalCards < 60 && (
            <div className="notice">
              Für ein Standard-Deck fehlen aktuell noch{" "}
              {60 - totalCards} Karten bis zur Mindestgröße.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length ===
            0 && (
            <div className="notice">
              Wähle zuerst einen Commander. Danach werden nur Commander-legale Karten seiner Farbidentität angezeigt.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length >
            0 &&
          totalCards < 100 && (
            <div className="notice">
              Für das Commander-Deck fehlen aktuell noch{" "}
              {100 - totalCards} Karten.
            </div>
          )}

        {d.format ===
          "standard" &&
          totalCards >= 60 && (
            <div className="ai-box">
              Die Standard-Mindestgröße von 60 Karten ist erreicht.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length >
            0 &&
          totalCards === 100 && (
            <div className="ai-box">
              Die Commander-Deckgröße von 100 Karten ist erreicht.
            </div>
          )}

        {commanderTooLarge && (
          <div className="error">
            Das Deck enthält {totalCards} Karten. Ein Commander-Deck darf insgesamt nur 100 Karten enthalten.
          </div>
        )}

        {pairInvalid && (
          <div className="error">
            Die beiden ausgewählten Commander dürfen nach den unterstützten Partner-Regeln nicht gemeinsam als Commander verwendet werden.
          </div>
        )}

        {illegalCards.length >
          0 && (
          <div className="error">
            <strong>
              {illegalCards.length} Karten sind im gewählten Format bzw. mit der Commander-Farbidentität nicht erlaubt:
            </strong>

            <div>
              {illegalCards
                .map(
                  card =>
                    card.name
                )
                .join(", ")}
            </div>
          </div>
        )}

        {copyViolationNames.length >
          0 && (
          <div className="error">
            <strong>
              Bei diesen Karten ist die erlaubte bzw. vorhandene Anzahl überschritten:
            </strong>

            <div>
              {copyViolationNames.join(
                ", "
              )}
            </div>
          </div>
        )}
        </div>
      </details>

      <section className="panel manual-builder-workspace">
        <div className="manual-panel-heading manual-builder-workspace-heading">
          <div>
            <h3>Manueller Deckbau</h3>
            <p className="muted">
              Wähle Karten aus deiner Sammlung. Die Filter kannst du bei Bedarf einblenden; dein aktuelles Deck wird darunter nach Kartentyp gruppiert und gestapelt angezeigt.
            </p>
          </div>
          <span className="muted">
            {d.format === "commander"
              ? `${mainDeckCount}/${commanderMainTarget} Hauptdeckkarten`
              : `${totalCards} Karten`}
          </span>
        </div>

        {d.format === "commander" && selectedCommanders.length === 0 ? (
          <p className="muted">Wähle zuerst oben in den Deck-Einstellungen einen Commander.</p>
        ) : (
          <>
            <details className="manual-filter-details">
              <summary className="manual-filter-summary">
                <span>
                  <strong>Filter</strong>
                  <small>
                    {manualFilteredPool.length} von {legalPool.length} legalen Karten
                    {(manualSearch || manualColors.length > 0 || manualTypes.length > 0 || manualSet)
                      ? " · Filter aktiv"
                      : ""}
                  </small>
                </span>
                <span className="manual-filter-summary-toggle">Ein-/ausklappen</span>
              </summary>

              <div className="manual-filter-panel manual-filter-panel-full">
                <label className="manual-filter-search">
                  <span>Suche</span>
                  <input
                    value={manualSearch}
                    placeholder="Kartenname…"
                    onChange={e => setManualSearch(e.target.value)}
                  />
                </label>

                <fieldset className="manual-filter-group">
                  <legend>Farbe</legend>
                  <div className="manual-filter-checks">
                    {[
                      ["W", "Weiß"],
                      ["U", "Blau"],
                      ["B", "Schwarz"],
                      ["R", "Rot"],
                      ["G", "Grün"],
                      ["C", "Farblos"]
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="checkbox"
                          checked={manualColors.includes(value)}
                          onChange={() => toggleManualFilter(value, setManualColors)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="manual-filter-group manual-filter-type-group">
                  <legend>Kartentyp</legend>
                  <div className="manual-filter-checks manual-filter-types">
                    {[
                      ["Creature", "Kreatur"],
                      ["Artifact", "Artefakt"],
                      ["Enchantment", "Verzauberung"],
                      ["Instant", "Spontanzauber"],
                      ["Sorcery", "Hexerei"],
                      ["Planeswalker", "Planeswalker"],
                      ["Land", "Land"],
                      ["Battle", "Schlacht"]
                    ].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="checkbox"
                          checked={manualTypes.includes(value)}
                          onChange={() => toggleManualFilter(value, setManualTypes)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="manual-filter-set">
                  <span>Set</span>
                  <select value={manualSet} onChange={e => setManualSet(e.target.value)}>
                    <option value="">Alle Sets</option>
                    {manualSetOptions.map(([code, label]) => (
                      <option value={code} key={code}>{label}</option>
                    ))}
                  </select>
                </label>

                <div className="manual-filter-footer">
                  <span className="muted">
                    {manualFilteredPool.length} von {legalPool.length} legalen Karten
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setManualSearch("");
                      setManualColors([]);
                      setManualTypes([]);
                      setManualSet("");
                    }}
                    disabled={
                      !manualSearch &&
                      manualColors.length === 0 &&
                      manualTypes.length === 0 &&
                      !manualSet
                    }
                  >
                    Filter zurücksetzen
                  </button>
                </div>
              </div>
            </details>

            <div className="manual-builder-columns">
              <section className="manual-collection-pane" aria-label="Karten aus der Sammlung auswählen">
                <div className="manual-subpanel-heading">
                  <div>
                    <h4>Sammlung</h4>
                    <p className="muted">Alle legalen Karten deiner Sammlung als Liste. Karte anklicken für Details, mit +1 zum Deck hinzufügen.</p>
                  </div>
                  <span>{manualFilteredPool.length} Treffer</span>
                </div>

                {manualFilteredPool.length > 0 ? (
                  <div className="add-list manual-collection-list">
                    {manualFilteredPool.map(card => {
                      const current = all.find(item => item.id === card.id)?.count ?? 0;
                      const currentByName = deckCountByName[card.name.toLowerCase()] ?? 0;
                      const ruleLimit = deckCopyLimit(card, d.format);
                      const ruleLimitLabel = Number.isFinite(ruleLimit) ? String(ruleLimit) : "beliebig";
                      const commanderFull = d.format === "commander" && mainDeckCount >= commanderMainTarget;

                      return (
                        <div className="manual-add-row" key={card.id}>
                          <button
                            type="button"
                            className="manual-card-preview-trigger"
                            onClick={() => setPreviewCardId(card.id)}
                            title="Karte anzeigen"
                          >
                            <span>
                              <strong>{card.name}</strong>
                              <small className="muted">
                                {card.set ? ` ${card.set.toUpperCase()} ·` : ""} MV {card.manaValue ?? 0} · im Deck {currentByName}/{ruleLimitLabel}
                              </small>
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={
                              current >= card.count ||
                              currentByName >= ruleLimit ||
                              commanderFull
                            }
                            onClick={() => {
                              add(card);
                              setAnalysisText("");
                            }}
                          >
                            +1
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="notice">
                    Für die aktuellen Filter sind keine legalen Karten aus deiner Sammlung verfügbar.
                  </div>
                )}
              </section>

              <section className="manual-deck-board-pane" aria-label="Aktuelles Deck">
                <div className="manual-subpanel-heading">
                  <div>
                    <h4>Aktuelles Deck</h4>
                    <p className="muted">Nach Kartentyp gruppiert und gestapelt wie in deinen gespeicherten Decks.</p>
                  </div>
                  <span>
                    {d.format === "commander"
                      ? `${mainDeckCount}/${commanderMainTarget}`
                      : totalCards}
                  </span>
                </div>

                {d.cards.length === 0 && d.commanderIds.length === 0 ? (
                  <div className="notice">Das Deck ist noch leer.</div>
                ) : (
                  <DeckBoard
                    deck={d}
                    pool={pool}
                    onCardClick={card => setPreviewCardId(card.id)}
                    onIncrement={(deckCard: DeckCard) => {
                      const source = pool.find(card => card.id === deckCard.id);
                      if (source) {
                        add(source);
                        setAnalysisText("");
                      }
                    }}
                    onDecrement={(deckCard: DeckCard) => {
                      setD(current => ({
                        ...current,
                        cards: current.cards
                          .map(item =>
                            item.id === deckCard.id
                              ? { ...item, count: Math.max(0, item.count - 1) }
                              : item
                          )
                          .filter(item => item.count > 0)
                      }));
                      setAnalysisText("");
                    }}
                    canIncrement={(deckCard: DeckCard) => {
                      const source = pool.find(card => card.id === deckCard.id);
                      if (!source) return false;
                      const currentByName = deckCountByName[deckCard.name.toLowerCase()] ?? 0;
                      const ruleLimit = deckCopyLimit(source, d.format);
                      const commanderFull = d.format === "commander" && mainDeckCount >= commanderMainTarget;
                      return deckCard.count < source.count && currentByName < ruleLimit && !commanderFull;
                    }}
                    noteForCard={(deckCard: DeckCard) => {
                      if (illegalCards.some(item => item.id === deckCard.id)) return "Nicht erlaubt";
                      if (copyViolationNames.includes(deckCard.name)) return "Mengenlimit überschritten";
                      return undefined;
                    }}
                  />
                )}
              </section>
            </div>
          </>
        )}
      </section>

      {previewCard && (
        <CardDetailsModal
          card={previewCard}
          onClose={() => setPreviewCardId(null)}
        />
      )}

      {analysisText && (
        <div className="ai-box analysis-box markdown-content">
          <Suspense fallback={<p className="muted">Analyse wird dargestellt…</p>}>
            <Markdown>{analysisText}</Markdown>
          </Suspense>
        </div>
      )}
    </section>
  );
}

export default App;
