import { getSession } from "./auth";
import { notifyOnce } from "./toast";
import type {
  CardRecord,
  DeckRecord,
  Format
} from "./types";
import type {
  DeckBuildIntelligence
} from "./deckBuilder";

// Konfigurierbar über VITE_DECK_INTELLIGENCE_URL (Standard: bestehender Cloudflare Worker).
const INTELLIGENCE_WORKER_URL =
  import.meta.env.VITE_DECK_INTELLIGENCE_URL?.trim() ||
  "https://arcane-decksmith-ai.arcane-decksmith-api.workers.dev/deck-intelligence";

function evidenceUnavailable(detail: string): DeckEvidence {
  notifyOnce(
    "deck-intelligence",
    `Zusatzdaten (Turnier-, Combo- und Community-Daten) sind gerade nicht verfügbar – ${detail}. Ergebnisse basieren nur auf deiner Sammlung.`
  );
  return emptyEvidence();
}

const REQUEST_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface TournamentCardEvidence {
  name: string;
  winRate?: number;
  baselineWinRate?: number;
  sampleDecks?: number;
  sampleGames?: number;
  performance?: number;
  commanderPerformance?: number;
}

export interface ComboEvidence {
  id: string;
  cards: string[];
  missingCards: string[];
  results: string[];
  popularity?: number;
  bracketTag?: string;
  score?: number;
}

export interface EdhrecCardEvidence {
  name: string;
  synergy?: number;
  inclusionRate?: number;
  numDecks?: number;
  potentialDecks?: number;
  score?: number;
  category?: string;
}

export interface ArchidektCardEvidence {
  name: string;
  inclusionRate?: number;
  sampleDecks?: number;
  score?: number;
}

export interface DeckEvidence {
  topDeck: {
    available: boolean;
    format?: string;
    baselineWinRate?: number;
    sampleDecks?: number;
    sampleGames?: number;
    cards: TournamentCardEvidence[];
  };
  spellbook: {
    available: boolean;
    bracketTag?: string;
    includedCombos: ComboEvidence[];
    almostCombos: ComboEvidence[];
  };
  edhrec: {
    available: boolean;
    commander?: string;
    sampleDecks?: number;
    cards: EdhrecCardEvidence[];
  };
  archidekt: {
    available: boolean;
    format?: string;
    sampleDecks?: number;
    averageLands?: number;
    averageManaValue?: number;
    cards: ArchidektCardEvidence[];
  };
  buildSignals: DeckBuildIntelligence;
}

interface WorkerResponse {
  topDeck?: DeckEvidence["topDeck"];
  spellbook?: DeckEvidence["spellbook"];
  edhrec?: DeckEvidence["edhrec"];
  archidekt?: DeckEvidence["archidekt"];
  cardSignals?: Record<
    string,
    {
      performance?: number;
      commanderPerformance?: number;
      combo?: number;
      edhrec?: number;
      archidekt?: number;
      sampleDecks?: number;
      sampleGames?: number;
    }
  >;
  structure?: DeckBuildIntelligence["structure"];
}

interface CacheEntry {
  expiresAt: number;
  value: DeckEvidence;
}

const cache =
  new Map<string, CacheEntry>();

function normalizeName(
  value: string
): string {
  return value
    .trim()
    .toLowerCase();
}

function uniqueCardNames(
  cards: CardRecord[]
): string[] {
  const names =
    new Map<string, string>();

  for (const card of cards) {
    const key =
      normalizeName(card.name);

    if (
      key &&
      !names.has(key)
    ) {
      names.set(
        key,
        card.name
      );
    }
  }

  return [
    ...names.values()
  ];
}

function deckCardNames(
  deck: DeckRecord
): string[] {
  return deck.cards.flatMap(
    card =>
      Array.from(
        {
          length:
            Math.max(
              1,
              card.count
            )
        },
        () => card.name
      )
  );
}

function commanderNames(
  deck: DeckRecord,
  collection: CardRecord[]
): string[] {
  if (
    deck.format !==
    "commander"
  ) {
    return [];
  }

  return deck.commanderIds
    .map(
      id =>
        collection.find(
          card =>
            card.id === id
        )?.name
    )
    .filter(
      (
        name
      ): name is string =>
        Boolean(name)
    );
}

function emptyEvidence(): DeckEvidence {
  return {
    topDeck: {
      available: false,
      cards: []
    },
    spellbook: {
      available: false,
      includedCombos: [],
      almostCombos: []
    },
    edhrec: {
      available: false,
      cards: []
    },
    archidekt: {
      available: false,
      cards: []
    },
    buildSignals: {
      cards: {},
      topDeckAvailable: false,
      spellbookAvailable: false,
      edhrecAvailable: false,
      archidektAvailable: false
    }
  };
}

function normalizeWorkerResponse(
  response: WorkerResponse
): DeckEvidence {
  const topDeck = {
    available:
      Boolean(
        response.topDeck?.available
      ),
    format:
      response.topDeck?.format,
    baselineWinRate:
      response.topDeck
        ?.baselineWinRate,
    sampleDecks:
      response.topDeck
        ?.sampleDecks,
    sampleGames:
      response.topDeck
        ?.sampleGames,
    cards:
      Array.isArray(
        response.topDeck?.cards
      )
        ? response.topDeck!.cards
        : []
  };

  const spellbook = {
    available:
      Boolean(
        response.spellbook?.available
      ),
    bracketTag:
      response.spellbook
        ?.bracketTag,
    includedCombos:
      Array.isArray(
        response.spellbook
          ?.includedCombos
      )
        ? response.spellbook!
            .includedCombos
        : [],
    almostCombos:
      Array.isArray(
        response.spellbook
          ?.almostCombos
      )
        ? response.spellbook!
            .almostCombos
        : []
  };

  const edhrec = {
    available:
      Boolean(
        response.edhrec?.available
      ),
    commander:
      response.edhrec?.commander,
    sampleDecks:
      response.edhrec?.sampleDecks,
    cards:
      Array.isArray(
        response.edhrec?.cards
      )
        ? response.edhrec!.cards
        : []
  };

  const archidekt = {
    available:
      Boolean(
        response.archidekt?.available
      ),
    format:
      response.archidekt?.format,
    sampleDecks:
      response.archidekt?.sampleDecks,
    averageLands:
      response.archidekt?.averageLands,
    averageManaValue:
      response.archidekt?.averageManaValue,
    cards:
      Array.isArray(
        response.archidekt?.cards
      )
        ? response.archidekt!.cards
        : []
  };

  return {
    topDeck,
    spellbook,
    edhrec,
    archidekt,
    buildSignals: {
      cards:
        response.cardSignals ??
        {},
      topDeckAvailable:
        topDeck.available,
      spellbookAvailable:
        spellbook.available,
      edhrecAvailable:
        edhrec.available,
      archidektAvailable:
        archidekt.available,
      structure:
        response.structure
    }
  };
}

function requestKey(
  action: "build" | "analyze",
  format: Format,
  commanders: string[],
  deckCards: string[],
  candidateCards: string[]
): string {
  const stable = [
    action,
    format,
    ...commanders
      .map(normalizeName)
      .sort(),
    "|deck|",
    ...deckCards
      .map(normalizeName)
      .sort(),
    "|pool|",
    ...candidateCards
      .map(normalizeName)
      .sort()
  ].join("\n");

  let hash = 2166136261;

  for (
    let index = 0;
    index < stable.length;
    index += 1
  ) {
    hash ^= stable.charCodeAt(
      index
    );
    hash = Math.imul(
      hash,
      16777619
    );
  }

  return `${action}:${format}:${hash >>> 0}`;
}

async function fetchEvidence(
  action: "build" | "analyze",
  format: Format,
  commanders: string[],
  deckCards: string[],
  candidateCards: string[]
): Promise<DeckEvidence> {
  const key = requestKey(
    action,
    format,
    commanders,
    deckCards,
    candidateCards
  );

  const cached =
    cache.get(key);

  if (
    cached &&
    cached.expiresAt >
      Date.now()
  ) {
    return cached.value;
  }

  let idToken: string;

  try {
    const session =
      await getSession();

    if (!session) {
      return emptyEvidence();
    }

    idToken =
      session.accessToken;
  } catch {
    return evidenceUnavailable("Anmeldung konnte nicht bestätigt werden");
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      REQUEST_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        INTELLIGENCE_WORKER_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${idToken}`
          },
          body:
            JSON.stringify({
              action,
              format,
              commanders,
              deckCards,
              candidateCards
            }),
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      return evidenceUnavailable(`Dienst antwortete mit HTTP ${response.status}`);
    }

    const data =
      (
        await response.json()
      ) as WorkerResponse;

    const value =
      normalizeWorkerResponse(
        data
      );

    cache.set(
      key,
      {
        expiresAt:
          Date.now() +
          CACHE_TTL_MS,
        value
      }
    );

    return value;
  } catch (error) {
    return evidenceUnavailable(
      error instanceof DOMException && error.name === "AbortError"
        ? "Zeitüberschreitung"
        : "Dienst nicht erreichbar"
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBuildDeckEvidence({
  format,
  commanders,
  preliminaryDeck,
  pool
}: {
  format: Format;
  commanders: CardRecord[];
  preliminaryDeck: DeckRecord;
  pool: CardRecord[];
}): Promise<DeckEvidence> {
  return fetchEvidence(
    "build",
    format,
    commanders.map(
      card => card.name
    ),
    deckCardNames(
      preliminaryDeck
    ),
    uniqueCardNames(pool)
  );
}

export async function getDeckAnalysisEvidence(
  deck: DeckRecord,
  collection: CardRecord[]
): Promise<DeckEvidence> {
  return fetchEvidence(
    "analyze",
    deck.format,
    commanderNames(
      deck,
      collection
    ),
    deckCardNames(deck),
    uniqueCardNames(
      collection
    )
  );
}

export function formatDeckEvidenceForAi(
  evidence: DeckEvidence
): string {
  const lines: string[] = [
    "VERIFIZIERTE EXTERNE DECK-EVIDENZ"
  ];

  if (evidence.topDeck.available) {
    lines.push(
      "TopDeck.gg: echte Turnierdaten; Korrelation ist kein Kausalitätsbeweis."
    );

    if (
      typeof evidence.topDeck
        .baselineWinRate ===
      "number"
    ) {
      lines.push(
        `Format-Basis-Winrate: ${(evidence.topDeck.baselineWinRate * 100).toFixed(1)}% bei ${evidence.topDeck.sampleGames ?? 0} ausgewerteten Matches aus ${evidence.topDeck.sampleDecks ?? 0} Decks.`
      );
    }

    const ranked =
      [...evidence.topDeck.cards]
        .filter(
          card =>
            typeof card.performance ===
              "number" ||
            typeof card.commanderPerformance ===
              "number"
        )
        .sort(
          (a, b) => {
            const aSignal =
              a.commanderPerformance ??
              a.performance ??
              0;
            const bSignal =
              b.commanderPerformance ??
              b.performance ??
              0;

            return bSignal - aSignal;
          }
        );

    const strongest =
      ranked.slice(0, 7);
    const weakest =
      ranked
        .slice(-7)
        .reverse()
        .filter(
          card =>
            !strongest.some(
              strong =>
                normalizeName(
                  strong.name
                ) ===
                normalizeName(
                  card.name
                )
            )
        );

    for (const card of [
      ...strongest,
      ...weakest
    ]) {
      const stats = [
        typeof card.winRate ===
        "number"
          ? `Winrate ${(card.winRate * 100).toFixed(1)}%`
          : null,
        typeof card.sampleDecks ===
        "number"
          ? `${card.sampleDecks} Decks`
          : null,
        typeof card.sampleGames ===
        "number"
          ? `${card.sampleGames} Matches`
          : null,
        typeof card.commanderPerformance ===
        "number"
          ? `Commander-Signal ${card.commanderPerformance.toFixed(2)}`
          : null,
        typeof card.performance ===
        "number"
          ? `Format-Signal ${card.performance.toFixed(2)}`
          : null
      ].filter(Boolean);

      lines.push(
        `- ${card.name}: ${stats.join(", ")}`
      );
    }
  } else {
    lines.push(
      "TopDeck.gg: für diese Anfrage keine belastbaren Daten verfügbar."
    );
  }

  if (evidence.edhrec.available) {
    lines.push(
      `EDHREC: aggregierte Commander-Daten${evidence.edhrec.commander ? ` für ${evidence.edhrec.commander}` : ""}; Synergy und Inclusion beschreiben Community-Nutzung, nicht Winrate.`
    );

    if (
      typeof evidence.edhrec.sampleDecks ===
      "number"
    ) {
      lines.push(
        `EDHREC-Stichprobe: ${evidence.edhrec.sampleDecks} Commander-Decks.`
      );
    }

    for (
      const card
      of [...evidence.edhrec.cards]
        .sort(
          (a, b) =>
            (b.score ?? 0) -
            (a.score ?? 0)
        )
        .slice(0, 12)
    ) {
      const stats = [
        typeof card.synergy ===
        "number"
          ? `Synergy ${(card.synergy * 100).toFixed(0)}%`
          : null,
        typeof card.inclusionRate ===
        "number"
          ? `Inclusion ${(card.inclusionRate * 100).toFixed(0)}%`
          : null,
        typeof card.numDecks ===
        "number"
          ? `${card.numDecks} Decks`
          : null,
        card.category
          ? `Kategorie ${card.category}`
          : null
      ].filter(Boolean);

      lines.push(
        `- ${card.name}: ${stats.join(", ")}`
      );
    }
  } else {
    lines.push(
      "EDHREC: keine verwertbaren Commander-Aggregate verfügbar."
    );
  }

  if (evidence.archidekt.available) {
    lines.push(
      `Archidekt: Stichprobe öffentlicher ${evidence.archidekt.format ?? "vergleichbarer"} Decklisten; Nutzungshäufigkeit ist kein Erfolgsnachweis.`
    );

    const structure = [
      typeof evidence.archidekt.sampleDecks ===
      "number"
        ? `${evidence.archidekt.sampleDecks} vollständige Decks`
        : null,
      typeof evidence.archidekt.averageLands ===
      "number"
        ? `Ø ${evidence.archidekt.averageLands.toFixed(1)} Länder`
        : null,
      typeof evidence.archidekt.averageManaValue ===
      "number"
        ? `Ø MV ${evidence.archidekt.averageManaValue.toFixed(2)}`
        : null
    ].filter(Boolean);

    if (structure.length > 0) {
      lines.push(
        `Archidekt-Struktur: ${structure.join(", ")}.`
      );
    }

    for (
      const card
      of [...evidence.archidekt.cards]
        .sort(
          (a, b) =>
            (b.score ?? 0) -
            (a.score ?? 0)
        )
        .slice(0, 10)
    ) {
      lines.push(
        `- ${card.name}: ${typeof card.inclusionRate === "number" ? `${(card.inclusionRate * 100).toFixed(0)}%` : "häufig"} in ${card.sampleDecks ?? evidence.archidekt.sampleDecks ?? 0} Stichproben-Decks.`
      );
    }
  } else {
    lines.push(
      "Archidekt: keine ausreichend belastbare öffentliche Deckstichprobe verfügbar."
    );
  }

  if (evidence.spellbook.available) {
    lines.push(
      "Commander Spellbook: kuratierte Combo-Daten."
    );

    if (
      evidence.spellbook
        .bracketTag
    ) {
      lines.push(
        `Spellbook-Bracket-Tag des Decks: ${evidence.spellbook.bracketTag}.`
      );
    }

    for (
      const combo
      of evidence.spellbook
        .includedCombos.slice(
          0,
          8
        )
    ) {
      lines.push(
        `- Enthaltene Combo ${combo.id}: ${combo.cards.join(" + ")} → ${combo.results.join(", ") || "Synergie"}${typeof combo.popularity === "number" ? `; EDHREC-Popularität ${combo.popularity}` : ""}.`
      );
    }

    for (
      const combo
      of evidence.spellbook
        .almostCombos.slice(
          0,
          6
        )
    ) {
      lines.push(
        `- Nahe Combo ${combo.id}: vorhanden ${combo.cards.filter(card => !combo.missingCards.includes(card)).join(" + ") || "Teile im Deck"}; fehlt ${combo.missingCards.join(" + ")}; Ergebnis ${combo.results.join(", ") || "Synergie"}.`
      );
    }
  } else if (
    evidence.buildSignals
      .spellbookAvailable !==
    undefined
  ) {
    lines.push(
      "Commander Spellbook: nicht verfügbar oder für dieses Format nicht angewendet."
    );
  }

  return lines.join("\n");
}

export function evidenceCardNames(
  evidence: DeckEvidence
): string[] {
  const names =
    new Map<string, string>();

  const add = (
    name: string
  ) => {
    const key =
      normalizeName(name);

    if (
      key &&
      !names.has(key)
    ) {
      names.set(key, name);
    }
  };

  for (
    const card
    of evidence.topDeck.cards
  ) {
    add(card.name);
  }

  for (
    const card
    of evidence.edhrec.cards
  ) {
    add(card.name);
  }

  for (
    const card
    of evidence.archidekt.cards
  ) {
    add(card.name);
  }

  for (
    const combo
    of [
      ...evidence.spellbook
        .includedCombos,
      ...evidence.spellbook
        .almostCombos
    ]
  ) {
    for (const card of combo.cards) {
      add(card);
    }

    for (
      const card
      of combo.missingCards
    ) {
      add(card);
    }
  }

  return [
    ...names.values()
  ];
}
