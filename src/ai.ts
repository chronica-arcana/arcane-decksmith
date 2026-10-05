import { getSession } from "./auth";
import { notifyOnce } from "./toast";
import { loadCollection } from "./db";
import type {
  CardRecord,
  DeckRecord
} from "./types";
import {
  evidenceCardNames,
  formatDeckEvidenceForAi,
  getDeckAnalysisEvidence
} from "./deckIntelligence";

// Konfigurierbar über VITE_AI_WORKER_URL (Standard: bestehender Cloudflare Worker).
const AI_WORKER_URL =
  import.meta.env.VITE_AI_WORKER_URL?.trim() ||
  "https://arcane-decksmith-ai.arcane-decksmith-api.workers.dev";

function scryfallUnavailable(): [] {
  notifyOnce(
    "ai-scryfall",
    "Scryfall ist gerade nicht erreichbar – Kaufvorschläge und Kartenzusatzdaten fehlen in dieser Analyse."
  );
  return [];
}

const MAX_ANALYSIS_LENGTH = 10500;
const EMPTY_RESPONSE_RETRIES = 1;
const RETRY_DELAY_MS = 700;

const SCRYFALL_REQUEST_DELAY_MS = 120;

const SCRYFALL_SEARCH_URL =
  "https://api.scryfall.com/cards/search";

const PURCHASE_CONTEXT_LIMIT = 2600;
const EXTERNAL_EVIDENCE_CONTEXT_LIMIT = 2600;

interface ScryfallCandidateCard {
  id: string;
  name: string;
  game_changer?: boolean;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  color_identity?: string[];
  legalities?: Record<string, string>;
  prices?: Record<string, string | null>;
}

interface ScryfallSearchResponse {
  data?: ScryfallCandidateCard[];
}

export interface PurchaseCandidate {
  id: string;
  name: string;
  gameChanger: boolean;
  category: string;
  roleName: string;
  manaValue: number;
  typeLine: string;
  oracleText: string;
  currentRoleCount: number;
  targetRoleCount: number;
  deficit: number;
  priceEur?: number;
}

export interface PurchaseSuggestionBudget {
  /** Hard maximum price for one suggested card. Undefined means no limit. */
  maxPricePerCardEur?: number;
  /** Hard maximum total price for all suggested cards. Undefined means no limit. */
  maxPricePerDeckEur?: number;
}

type CardTokenKind =
  | "commander"
  | "deck"
  | "purchase"
  | "evidence";

interface CardTokenEntry {
  token: string;
  name: string;
  kind: CardTokenKind;
}

interface AiRequestContext {
  analysis: string;
  cardMap: Record<string, string>;
  purchaseByToken: Record<
    string,
    PurchaseCandidate
  >;
  purchaseBudget: PurchaseSuggestionBudget;
  commanderBracketSection: string | null;
}

interface WorkerResponse {
  explanation?: string;
  selectedPurchaseTokens?: string[];
  error?: string;
}

let lastScryfallRequestAt = 0;

function wait(
  ms: number
): Promise<void> {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function searchScryfallCandidates(
  query: string,
  order: "edhrec" | "cmc"
): Promise<ScryfallCandidateCard[]> {
  const elapsed =
    Date.now() -
    lastScryfallRequestAt;

  const delay =
    Math.max(
      0,
      SCRYFALL_REQUEST_DELAY_MS -
        elapsed
    );

  if (delay > 0) {
    await wait(delay);
  }

  lastScryfallRequestAt =
    Date.now();

  const params =
    new URLSearchParams({
      q: query,
      unique: "cards",
      order
    });

  let response: Response;

  try {
    response =
      await fetch(
        `${SCRYFALL_SEARCH_URL}?${params.toString()}`,
        {
          headers: {
            Accept:
              "application/json;q=0.9,*/*;q=0.8"
          }
        }
      );
  } catch {
    return scryfallUnavailable();
  }

  // 404 bedeutet bei Scryfall "keine Treffer" und ist kein Fehler.
  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    return scryfallUnavailable();
  }

  try {
    const data =
      (
        await response.json()
      ) as ScryfallSearchResponse;

    return Array.isArray(
      data.data
    )
      ? data.data
      : [];
  } catch {
    return scryfallUnavailable();
  }
}

function countMainDeckCards(
  deck: DeckRecord
): number {
  return deck.cards.reduce(
    (total, card) =>
      total +
      card.count,
    0
  );
}

function commanderCount(
  deck: DeckRecord
): number {
  return deck.format ===
    "commander"
    ? deck.commanderIds.length
    : 0;
}

function isLand(
  typeLine:
    | string
    | undefined
): boolean {
  return /\bLand\b/i.test(
    typeLine ?? ""
  );
}

function averageManaValue(
  deck: DeckRecord
): number {
  let totalManaValue = 0;
  let cardCount = 0;

  for (
    const card
    of deck.cards
  ) {
    if (
      isLand(
        card.typeLine
      )
    ) {
      continue;
    }

    totalManaValue +=
      (
        card.manaValue ??
        0
      ) *
      card.count;

    cardCount +=
      card.count;
  }

  return cardCount === 0
    ? 0
    : totalManaValue /
        cardCount;
}

function manaCurve(
  deck: DeckRecord
): number[] {
  const curve =
    Array<number>(8).fill(
      0
    );

  for (
    const card
    of deck.cards
  ) {
    if (
      isLand(
        card.typeLine
      )
    ) {
      continue;
    }

    const manaValue =
      Math.floor(
        card.manaValue ??
          0
      );

    const index =
      Math.min(
        Math.max(
          manaValue,
          0
        ),
        7
      );

    curve[index] +=
      card.count;
  }

  return curve;
}

function manaCurveText(
  deck: DeckRecord
): string {
  return manaCurve(deck)
    .map(
      (
        count,
        index
      ) =>
        index === 7
          ? `MV 7+: ${count}`
          : `MV ${index}: ${count}`
    )
    .join(" | ");
}

function roleCounts(
  deck: DeckRecord
): Record<
  string,
  number
> {
  const result:
    Record<
      string,
      number
    > = {};

  for (
    const card
    of deck.cards
  ) {
    const role =
      card.role ||
      "Unbekannt";

    result[role] =
      (
        result[role] ??
        0
      ) +
      card.count;
  }

  return result;
}

function rolesText(
  deck: DeckRecord
): string {
  const entries =
    Object.entries(
      roleCounts(deck)
    ).sort(
      (a, b) =>
        b[1] -
          a[1] ||
        a[0].localeCompare(
          b[0]
        )
    );

  return entries.length >
    0
    ? entries
        .map(
          (
            [
              role,
              count
            ]
          ) =>
            `${role}: ${count}`
        )
        .join(" | ")
    : "Keine Rollen vorhanden.";
}

function typeCounts(
  deck: DeckRecord
) {
  const result = {
    lands: 0,
    creatures: 0,
    artifacts: 0,
    enchantments: 0,
    instants: 0,
    sorceries: 0,
    planeswalkers: 0
  };

  for (
    const card
    of deck.cards
  ) {
    const line =
      card.typeLine ??
      "";

    if (
      /\bLand\b/i.test(
        line
      )
    ) {
      result.lands +=
        card.count;
    }

    if (
      /\bCreature\b/i.test(
        line
      )
    ) {
      result.creatures +=
        card.count;
    }

    if (
      /\bArtifact\b/i.test(
        line
      )
    ) {
      result.artifacts +=
        card.count;
    }

    if (
      /\bEnchantment\b/i.test(
        line
      )
    ) {
      result.enchantments +=
        card.count;
    }

    if (
      /\bInstant\b/i.test(
        line
      )
    ) {
      result.instants +=
        card.count;
    }

    if (
      /\bSorcery\b/i.test(
        line
      )
    ) {
      result.sorceries +=
        card.count;
    }

    if (
      /\bPlaneswalker\b/i.test(
        line
      )
    ) {
      result.planeswalkers +=
        card.count;
    }
  }

  return result;
}

function manaValueAssessment(
  deck: DeckRecord
): string {
  const average =
    averageManaValue(
      deck
    );

  if (
    typeof deck.targetManaValue !==
      "number"
  ) {
    return (
      "Kein Ziel-Mana-Value angegeben; " +
      "keine quantitative Abweichungsbewertung möglich."
    );
  }

  const target =
    deck.targetManaValue;

  const delta =
    average -
    target;

  const absoluteDelta =
    Math.abs(delta);

  if (
    absoluteDelta <=
    0.15
  ) {
    return (
      `Der durchschnittliche Mana Value liegt mit ${average.toFixed(2)} ` +
      `praktisch am Zielwert ${target.toFixed(1)}. ` +
      `Die Abweichung von ${absoluteDelta.toFixed(2)} ist gering und soll nicht als eigenständige Schwäche dargestellt werden.`
    );
  }

  if (
    absoluteDelta <=
    0.5
  ) {
    return delta > 0
      ? (
          `Der durchschnittliche Mana Value liegt mit ${average.toFixed(2)} leicht über dem Zielwert ${target.toFixed(1)}. ` +
          `Die Abweichung beträgt ${absoluteDelta.toFixed(2)}.`
        )
      : (
          `Der durchschnittliche Mana Value liegt mit ${average.toFixed(2)} leicht unter dem Zielwert ${target.toFixed(1)}. ` +
          `Die Abweichung beträgt ${absoluteDelta.toFixed(2)}.`
        );
  }

  return delta > 0
    ? (
        `Der durchschnittliche Mana Value liegt mit ${average.toFixed(2)} deutlich über dem Zielwert ${target.toFixed(1)}. ` +
        `Die Abweichung beträgt ${absoluteDelta.toFixed(2)}.`
      )
    : (
        `Der durchschnittliche Mana Value liegt mit ${average.toFixed(2)} deutlich unter dem Zielwert ${target.toFixed(1)}. ` +
        `Die Abweichung beträgt ${absoluteDelta.toFixed(2)}.`
      );
}

export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const mainDeck =
    countMainDeckCards(
      deck
    );

  const commanders =
    commanderCount(
      deck
    );

  const total =
    mainDeck +
    commanders;

  const types =
    typeCounts(
      deck
    );

  const nonlands =
    mainDeck -
    types.lands;

  const averageMv =
    averageManaValue(
      deck
    );

  const targetManaValue =
    typeof deck.targetManaValue ===
      "number"
      ? deck.targetManaValue.toFixed(
          1
        )
      : "Nicht angegeben";

  return [
    `Deck: ${deck.name}`,
    `Format: ${deck.format}`,
    `Karten gesamt inklusive Commander: ${total}`,
    `Hauptdeck: ${mainDeck}`,
    `Commander: ${commanders}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${nonlands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${averageMv.toFixed(2)}`,
    `Ziel-Mana-Value: ${targetManaValue}`,
    `Deck-Score: ${deck.score ?? "Nicht angegeben"}`,
    "",
    "Mana-Kurve:",
    manaCurveText(
      deck
    ),
    "",
    "Kartenrollen:",
    rolesText(
      deck
    )
  ].join("\n");
}

function colorIdentityText(
  colors: string[]
): string {
  const names:
    Record<
      string,
      string
    > = {
      W: "Weiß",
      U: "Blau",
      B: "Schwarz",
      R: "Rot",
      G: "Grün"
    };

  if (
    colors.length ===
    0
  ) {
    return "Farblos";
  }

  return colors
    .map(
      color =>
        names[color] ??
        color
    )
    .join(", ");
}

function technicalDeckData(
  deck: DeckRecord
): string {
  const mainDeck =
    countMainDeckCards(
      deck
    );

  const commanders =
    commanderCount(
      deck
    );

  const types =
    typeCounts(
      deck
    );

  const targetManaValue =
    typeof deck.targetManaValue ===
      "number"
      ? deck.targetManaValue.toFixed(
          1
        )
      : "Nicht angegeben";

  return [
    `Format: ${deck.format}`,
    `Farbidentität des Decks: ${colorIdentityText(deck.colors)}`,
    `Karten gesamt inklusive Commander: ${mainDeck + commanders}`,
    `Hauptdeck: ${mainDeck}`,
    `Commander-Anzahl: ${commanders}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${mainDeck - types.lands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${averageManaValue(deck).toFixed(2)}`,
    `Ziel-Mana-Value: ${targetManaValue}`,
    `Deterministische Kurvenbewertung: ${manaValueAssessment(deck)}`,
    `Deck-Score: ${deck.score ?? "Nicht angegeben"}`,
    `Mana-Kurve: ${manaCurveText(deck)}`,
    `Kartenrollen: ${rolesText(deck)}`
  ].join("\n");
}

function shorten(
  value: string,
  maxLength: number
): string {
  const clean =
    value
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    clean.length <=
    maxLength
  ) {
    return clean;
  }

  return (
    clean
      .slice(
        0,
        Math.max(
          0,
          maxLength - 1
        )
      )
      .trimEnd() +
    "…"
  );
}

function normalizeName(
  value: string
): string {
  return value
    .trim()
    .toLocaleLowerCase(
      "en-US"
    );
}

function findCollectionCard(
  id: string,
  name: string,
  collection: CardRecord[]
): CardRecord | undefined {
  return (
    collection.find(
      card =>
        card.id ===
        id
    ) ??
    collection.find(
      card =>
        normalizeName(
          card.name
        ) ===
        normalizeName(
          name
        )
    )
  );
}

function tokenFor(
  prefix:
    | "C"
    | "D"
    | "P"
    | "E",
  index: number
): string {
  return `[[${prefix}${String(index + 1).padStart(3, "0")}]]`;
}

function commanderTokenEntries(
  deck: DeckRecord,
  collection: CardRecord[]
): CardTokenEntry[] {
  if (
    deck.format !==
    "commander"
  ) {
    return [];
  }

  return deck.commanderIds.map(
    (
      commanderId,
      index
    ) => {
      const card =
        collection.find(
          item =>
            item.id ===
            commanderId
        );

      return {
        token:
          tokenFor(
            "C",
            index
          ),

        name:
          card?.name ??
          `Commander ${index + 1}`,

        kind:
          "commander"
      };
    }
  );
}

function deckTokenEntries(
  deck: DeckRecord
): CardTokenEntry[] {
  return deck.cards.map(
    (
      card,
      index
    ) => ({
      token:
        tokenFor(
          "D",
          index
        ),

      name:
        card.name,

      kind:
        "deck"
    })
  );
}

function purchaseTokenEntries(
  candidates: PurchaseCandidate[]
): CardTokenEntry[] {
  return candidates.map(
    (
      candidate,
      index
    ) => ({
      token:
        tokenFor(
          "P",
          index
        ),

      name:
        candidate.name,

      kind:
        "purchase"
    })
  );
}

function evidenceTokenEntries(
  names: string[],
  existingEntries: CardTokenEntry[]
): CardTokenEntry[] {
  const existingNames =
    new Set(
      existingEntries.map(
        entry =>
          normalizeName(
            entry.name
          )
      )
    );

  const seen =
    new Set<string>();

  const result:
    CardTokenEntry[] = [];

  for (const name of names) {
    const normalized =
      normalizeName(name);

    if (
      !normalized ||
      existingNames.has(
        normalized
      ) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);

  result.push({
  token: tokenFor(
    "E",
    result.length
  ),
      name,
      kind: "evidence"
    });
  }

  return result;
}

function tokenizeKnownNames(
  value: string,
  entries: CardTokenEntry[]
): string {
  let result =
    value;

  const sorted =
    [...entries].sort(
      (a, b) =>
        b.name.length -
        a.name.length
    );

  for (
    const entry
    of sorted
  ) {
    const name =
      entry.name.trim();

    if (!name) {
      continue;
    }

    result =
      result
        .split(name)
        .join(
          entry.token
        );
  }

  return result;
}

function commanderContext(
  deck: DeckRecord,
  collection: CardRecord[],
  commanderEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[]
): string {
  if (
    deck.format !==
    "commander"
  ) {
    return (
      "Kein Commander-Format."
    );
  }

  if (
    deck.commanderIds.length ===
    0
  ) {
    return (
      "Keine Commander-Daten vorhanden."
    );
  }

  return deck.commanderIds
    .map(
      (
        commanderId,
        index
      ) => {
        const token =
          commanderEntries[
            index
          ]?.token ??
          tokenFor(
            "C",
            index
          );

        const card =
          collection.find(
            item =>
              item.id ===
              commanderId
          );

        if (!card) {
          return (
            `${token} | ` +
            "Weitere Kartendaten nicht verfügbar."
          );
        }

        const parts = [
          token,
          `Typ ${card.typeLine || "unbekannt"}`,
          `MV ${card.manaValue}`,
          `Farbidentität ${
            (
              card.colorIdentity ??
              []
            ).join("") ||
            "C"
          }`
        ];

        if (
          card.oracleText?.trim()
        ) {
          parts.push(
            `Oracle ${shorten(
              tokenizeKnownNames(
                card.oracleText,
                allEntries
              ),
              430
            )}`
          );
        }

        return parts.join(
          " | "
        );
      }
    )
    .join("\n");
}

function deckCardTokenLine(
  deckCard:
    DeckRecord["cards"][number],
  token: string,
  collection: CardRecord[],
  allEntries: CardTokenEntry[],
  oracleLength: number
): string {
  const card =
    findCollectionCard(
      deckCard.id,
      deckCard.name,
      collection
    );

  const parts = [
    token,
    `Anzahl ${deckCard.count}`,
    `MV ${deckCard.manaValue}`,
    `Rolle ${deckCard.role || "Unbekannt"}`,
    `Typ ${
      deckCard.typeLine ||
      card?.typeLine ||
      "unbekannt"
    }`
  ];

  const oracle =
    card?.oracleText?.trim();

  if (
    oracle &&
    oracleLength >
      0
  ) {
    parts.push(
      `Oracle ${shorten(
        tokenizeKnownNames(
          oracle,
          allEntries
        ),
        oracleLength
      )}`
    );
  }

  if (
    deckCard.reason?.trim()
  ) {
    parts.push(
      `Builder-Grund ${shorten(
        tokenizeKnownNames(
          deckCard.reason,
          allEntries
        ),
        120
      )}`
    );
  }

  return parts.join(
    " | "
  );
}

function fullDeckOverview(
  deck: DeckRecord,
  deckEntries: CardTokenEntry[]
): string {
  const lines =
    deck.cards.map(
      (
        card,
        index
      ) =>
        [
          deckEntries[
            index
          ].token,
          `x${card.count}`,
          `MV${card.manaValue}`,
          `Rolle:${card.role || "Unbekannt"}`
        ].join(
          " | "
        )
    );

  return [
    "VOLLSTÄNDIGE DECKÜBERSICHT",
    "Jede tatsächliche Hauptdeckkarte ist hier genau einmal als D-Kennung aufgeführt. Diese Liste wird niemals gekürzt.",
    ...lines
  ].join("\n");
}

function detailPriority(
  role: string
): number {
  const priorities:
    Record<
      string,
      number
    > = {
      Synergie: 100,
      "Card Advantage": 95,
      Interaction: 90,
      Ramp: 85,
      Protection: 80,
      Recursion: 75,
      Boardwipe: 70,
      Finisher: 65,
      Tutor: 60,
      Value: 50,
      Creature: 40,
      Land: 0
    };

  return (
    priorities[role] ??
    30
  );
}

function prioritizedDeckDetails(
  deck: DeckRecord,
  collection: CardRecord[],
  deckEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[],
  maxLength: number
): string {
  const header = [
    "PRIORISIERTE KARTENDETAILS",
    "Nur Karten mit hier vorhandenem Oracle-Text dürfen mit einem konkreten Karteneffekt beschrieben werden.",
    "Nicht aufgeführte D-Kennungen bleiben trotzdem über die vollständige Deckübersicht als Deckkarten bestätigt.",
    ""
  ].join("\n");

  const ordered =
    deck.cards
      .map(
        (
          card,
          index
        ) => ({
          card,
          index,

          priority:
            detailPriority(
              card.role ||
              "Unbekannt"
            )
        })
      )
      .filter(
        item =>
          !isLand(
            item.card.typeLine
          )
      )
      .sort(
        (a, b) =>
          b.priority -
            a.priority ||
          a.card.manaValue -
            b.card.manaValue ||
          a.index -
            b.index
      );

  const oracleLevels = [
    180,
    130,
    90
  ];

  for (
    const oracleLength
    of oracleLevels
  ) {
    const lines:
      string[] = [];

    let length =
      header.length;

    for (
      const item
      of ordered
    ) {
      const line =
        deckCardTokenLine(
          item.card,
          deckEntries[
            item.index
          ].token,
          collection,
          allEntries,
          oracleLength
        );

      if (
        length +
          line.length +
          1 >
        maxLength
      ) {
        break;
      }

      lines.push(
        line
      );

      length +=
        line.length +
        1;
    }

    if (
      lines.length >
      0
    ) {
      return [
        header,
        ...lines
      ].join("\n");
    }
  }

  return (
    header +
    "Keine zusätzlichen Kartendetails passen in das sichere Größenlimit."
  );
}

interface PurchaseRoleTarget {
  category: string;
  roleName: string;
  target: number;
  query: string;
}

function purchaseRoleTargets(
  deck: DeckRecord
): PurchaseRoleTarget[] {
  const commander =
    deck.format ===
    "commander";

  return [
    {
      category:
        "Ramp",

      roleName:
        "Ramp",

      target:
        commander
          ? 10
          : 3,

      query:
        '(o:"add one mana" OR o:"search your library for a basic land")'
    },

    {
      category:
        "Card Draw",

      roleName:
        "Card Advantage",

      target:
        commander
          ? 10
          : 6,

      query:
        '(o:"draw a card" OR o:"draw two cards" OR o:"draw three cards")'
    },

    {
      category:
        "Interaktion",

      roleName:
        "Interaction",

      target:
        commander
          ? 8
          : 7,

      query:
        '(o:"destroy target" OR o:"exile target" OR o:"counter target")'
    },

    {
      category:
        "Boardwipe",

      roleName:
        "Boardwipe",

      target:
        commander
          ? 3
          : 2,

      query:
        '(o:"destroy all" OR o:"exile all")'
    },

    {
      category:
        "Schutz",

      roleName:
        "Protection",

      target:
        commander
          ? 3
          : 2,

      query:
        '(o:"indestructible" OR o:"hexproof" OR o:"phase out")'
    },

    {
      category:
        "Recursion",

      roleName:
        "Recursion",

      target:
        commander
          ? 3
          : 1,

      query:
        'o:"from your graveyard"'
    }
  ];
}

function deckRoleCount(
  deck: DeckRecord,
  role: string
): number {
  return deck.cards
    .filter(
      card =>
        card.role ===
        role
    )
    .reduce(
      (
        sum,
        card
      ) =>
        sum +
        card.count,
      0
    );
}

function candidateIdentityAllowed(
  candidate: ScryfallCandidateCard,
  deck: DeckRecord
): boolean {
  if (
    deck.format !==
    "commander"
  ) {
    return true;
  }

  const deckColors =
    new Set(
      deck.colors
    );

  return (
    candidate.color_identity ??
    []
  ).every(
    color =>
      deckColors.has(
        color
      )
  );
}

function candidateLegal(
  candidate: ScryfallCandidateCard,
  deck: DeckRecord
): boolean {
  return deck.format ===
    "commander"
    ? candidate.legalities
        ?.commander ===
        "legal"
    : candidate.legalities
        ?.standard ===
        "legal";
}

function normalizedBudgetValue(
  value: number | undefined
): number | undefined {
  return Number.isFinite(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

export function normalizedPurchaseBudget(
  budget: PurchaseSuggestionBudget = {}
): PurchaseSuggestionBudget {
  return {
    maxPricePerCardEur: normalizedBudgetValue(
      budget.maxPricePerCardEur
    ),
    maxPricePerDeckEur: normalizedBudgetValue(
      budget.maxPricePerDeckEur
    )
  };
}

function parseCandidateEuroPrice(
  candidate: ScryfallCandidateCard
): number | undefined {
  const raw = candidate.prices?.eur;

  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

export function candidateWithinPerCardBudget(
  priceEur: number | undefined,
  budget: PurchaseSuggestionBudget
): boolean {
  const max = budget.maxPricePerCardEur;

  if (max === undefined) {
    return true;
  }

  return priceEur !== undefined && priceEur <= max;
}

export function takeWithinDeckBudget(
  candidates: PurchaseCandidate[],
  budget: PurchaseSuggestionBudget,
  limit = 3
): PurchaseCandidate[] {
  const selected: PurchaseCandidate[] = [];
  let totalPriceEur = 0;
  const maxTotal = budget.maxPricePerDeckEur;

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }

    if (maxTotal !== undefined) {
      if (candidate.priceEur === undefined) {
        continue;
      }

      if (totalPriceEur + candidate.priceEur > maxTotal) {
        continue;
      }
    }

    selected.push(candidate);
    totalPriceEur += candidate.priceEur ?? 0;
  }

  return selected;
}

async function verifiedPurchaseCandidates(
  deck: DeckRecord,
  collection: CardRecord[],
  budget: PurchaseSuggestionBudget = {}
): Promise<
  PurchaseCandidate[]
> {
  const normalizedBudget = normalizedPurchaseBudget(budget);
  const ownedNames =
    new Set(
      collection.map(
        card =>
          normalizeName(
            card.name
          )
      )
    );

  const deckNames =
    new Set(
      deck.cards.map(
        card =>
          normalizeName(
            card.name
          )
      )
    );

  for (
    const commanderId
    of deck.commanderIds
  ) {
    const commander =
      collection.find(
        card =>
          card.id ===
          commanderId
      );

    if (commander) {
      deckNames.add(
        normalizeName(
          commander.name
        )
      );
    }
  }

  const colors =
    deck.colors.length >
    0
      ? deck.colors.join(
          ""
        )
      : "C";

  const formatQuery =
    deck.format ===
    "commander"
      ? "f:commander"
      : "f:standard";

  const identityQuery =
    deck.colors.length >
    0
      ? `id<=${colors}`
      : "id=c";

  const roleTargets =
    purchaseRoleTargets(
      deck
    )
      .map(
        item => {
          const current =
            deckRoleCount(
              deck,
              item.roleName
            );

          return {
            ...item,

            current,

            deficit:
              Math.max(
                0,
                item.target -
                  current
              )
          };
        }
      )
      .sort(
        (a, b) =>
          b.deficit -
            a.deficit ||
          a.category.localeCompare(
            b.category
          )
      );

  const result:
    PurchaseCandidate[] =
      [];

  const seenNames =
    new Set<string>();

  for (
    const role
    of roleTargets
  ) {
    const query = [
      formatQuery,
      identityQuery,
      "game:paper",
      "-t:land",
      role.query
    ].join(" ");

    const cards =
      await searchScryfallCandidates(
        query,
        deck.format ===
          "commander"
          ? "edhrec"
          : "cmc"
      );

    let addedForRole =
      0;

    for (
      const card
      of cards
    ) {
      if (
        addedForRole >=
        1
      ) {
        break;
      }

      const nameKey =
        normalizeName(
          card.name
        );

      if (
        !nameKey ||
        ownedNames.has(
          nameKey
        ) ||
        deckNames.has(
          nameKey
        ) ||
        seenNames.has(
          nameKey
        ) ||
        !candidateLegal(
          card,
          deck
        ) ||
        !candidateIdentityAllowed(
          card,
          deck
        )
      ) {
        continue;
      }

      const oracleText =
        card.oracle_text?.trim();

      if (
        !oracleText
      ) {
        continue;
      }

      const priceEur =
        parseCandidateEuroPrice(
          card
        );

      if (
        !candidateWithinPerCardBudget(
          priceEur,
          normalizedBudget
        )
      ) {
        continue;
      }

      result.push({
        id:
          card.id,

        name:
          card.name,

        gameChanger:
          card.game_changer === true,

        category:
          role.category,

        roleName:
          role.roleName,

        manaValue:
          Number(
            card.cmc ??
            0
          ),

        typeLine:
          card.type_line ??
          "Typ unbekannt",

        oracleText,

        currentRoleCount:
          role.current,

        targetRoleCount:
          role.target,

        deficit:
          role.deficit,

        ...(priceEur !== undefined
          ? { priceEur }
          : {})
      });

      seenNames.add(
        nameKey
      );

      addedForRole +=
        1;
    }
  }

  return result;
}

function purchaseCandidateContext(
  candidates: PurchaseCandidate[],
  purchaseEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[],
  maxLength: number,
  budget: PurchaseSuggestionBudget
): string {
  const budgetDescription = [
    budget.maxPricePerCardEur !== undefined
      ? `Maximalpreis pro Karte: ${budget.maxPricePerCardEur.toFixed(2)} EUR.`
      : "Kein Maximalpreis pro Karte.",
    budget.maxPricePerDeckEur !== undefined
      ? `Maximalpreis aller ausgewählten Vorschläge zusammen: ${budget.maxPricePerDeckEur.toFixed(2)} EUR.`
      : "Kein Gesamtbudget für die Vorschläge."
  ].join(" ");

  const header = [
    "SCRYFALL-VERIFIZIERTE OPTIONALE ANSCHAFFUNGSKANDIDATEN",
    "P-Kennungen sind keine Deckkarten.",
    "Sie wurden vorab über Scryfall auf Existenz, Formatlegalität, Farbidentität bei Commander, Nichtbesitz und konfigurierte Preisgrenzen geprüft.",
    budgetDescription,
    "Die KI darf aus diesen Kandidaten höchstens drei P-Kennungen auswählen.",
    "Sie darf die Effekte oder Kaufbegründungen nicht selbst formulieren; die sichtbare Darstellung wird nach der Auswahl deterministisch erzeugt.",
    ""
  ].join("\n");

  if (
    candidates.length ===
    0
  ) {
    return (
      header +
      "Keine verifizierten Anschaffungskandidaten verfügbar."
    );
  }

  const lines:
    string[] = [];

  let length =
    header.length;

  for (
    let index = 0;
    index <
    candidates.length;
    index += 1
  ) {
    const candidate =
      candidates[
        index
      ];

    const token =
      purchaseEntries[
        index
      ].token;

    const line = [
      token,
      `Kategorie ${candidate.category}`,
      `Aktueller Rollenwert ${candidate.currentRoleCount}`,
      `Zielwert ${candidate.targetRoleCount}`,
      `Defizit ${candidate.deficit}`,
      `Preis ${candidate.priceEur !== undefined ? `${candidate.priceEur.toFixed(2)} EUR` : "unbekannt"}`,
      `MV ${candidate.manaValue}`,
      `Typ ${candidate.typeLine}`,
      `Oracle ${shorten(
        tokenizeKnownNames(
          candidate.oracleText,
          allEntries
        ),
        220
      )}`
    ].join(" | ");

    if (
      length +
        line.length +
        1 >
      maxLength
    ) {
      break;
    }

    lines.push(
      line
    );

    length +=
      line.length +
      1;
  }

  return [
    header,
    ...lines
  ].join("\n");
}

function analysisRules(): string {
  return [
    "DATENREGELN FÜR DIE ANALYSE",
    "C-Kennungen = Commander.",
    "D-Kennungen = tatsächliche Karten des fertigen Decks.",
    "P-Kennungen = ausschließlich verifizierte optionale Anschaffungskandidaten.",
    "E-Kennungen = Karten, die ausschließlich in externer TopDeck-/EDHREC-/Archidekt-/Commander-Spellbook-Evidenz vorkommen; sie sind nicht automatisch Deckkarten oder Anschaffungsempfehlungen.",
    "Die vollständige D-Kennungsliste ist autoritativ für die Deckzugehörigkeit und wird niemals gekürzt.",
    "Konkrete Karteneffekte dürfen ausschließlich aus ausdrücklich geliefertem Oracle-Text abgeleitet werden.",
    "P-Kennungen gehören niemals zum fertigen Deck.",
    "Die KI darf P-Kennungen lediglich auswählen. Die sichtbare Beschreibung der optionalen Anschaffungen wird deterministisch von Arcane Decksmith erzeugt.",
    "TopDeck-Winrates sind beobachtete Turnierkorrelationen und dürfen nicht als kausaler Effekt einer einzelnen Karte formuliert werden.",
    "EDHREC-Synergy/Inclusion sind aggregierte Community-Nutzungsdaten für Commander und dürfen nicht als Siegquote oder Qualitätsbeweis formuliert werden.",
    "Archidekt-Häufigkeiten und Strukturwerte stammen aus einer Stichprobe öffentlicher Decklisten und dürfen nicht als Winrate oder repräsentativer Gesamtmarkt behauptet werden.",
    "Commander-Spellbook-Combos und deren Ergebnisse dürfen nur so beschrieben werden, wie sie in der gelieferten Evidenz stehen.",
    "Die deterministische Kurvenbewertung in den technischen Deckdaten ist autoritativ und darf nicht widersprochen werden."
  ].join("\n");
}

function authoritativeTokenList(
  commanderEntries: CardTokenEntry[],
  deckEntries: CardTokenEntry[],
  purchaseEntries: CardTokenEntry[],
  evidenceEntries: CardTokenEntry[]
): string {
  return [
    "AUTORITATIVE KENNUNGSLISTEN",

    `Commander: ${
      commanderEntries.length >
      0
        ? commanderEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,

    `Deckkarten: ${
      deckEntries.length >
      0
        ? deckEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,

    `Anschaffungskandidaten: ${
      purchaseEntries.length >
      0
        ? purchaseEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,

    `Externe Evidenzkarten: ${
      evidenceEntries.length >
      0
        ? evidenceEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,

    "Diese Listen sind vollständig und dürfen nicht durch Modellwissen ergänzt werden."
  ].join("\n");
}

function cardMapFromEntries(
  entries: CardTokenEntry[]
): Record<
  string,
  string
> {
  return Object.fromEntries(
    entries.map(
      entry => [
        entry.token,
        entry.name
      ]
    )
  );
}

function purchaseMapFromEntries(
  candidates: PurchaseCandidate[],
  entries: CardTokenEntry[]
): Record<
  string,
  PurchaseCandidate
> {
  const result:
    Record<
      string,
      PurchaseCandidate
    > = {};

  for (
    let index = 0;
    index <
    candidates.length;
    index += 1
  ) {
    const token =
      entries[
        index
      ]?.token;

    if (!token) {
      continue;
    }

    result[token] =
      candidates[
        index
      ];
  }

  return result;
}

async function createAiRequestContext(
  deck: DeckRecord,
  collection: CardRecord[],
  purchaseBudget: PurchaseSuggestionBudget = {}
): Promise<AiRequestContext> {
  const normalizedBudget = normalizedPurchaseBudget(
    purchaseBudget
  );
  const [
    purchaseCandidates,
    deckEvidence
  ] =
    await Promise.all([
      verifiedPurchaseCandidates(
        deck,
        collection,
        normalizedBudget
      ),
      getDeckAnalysisEvidence(
        deck,
        collection
      )
    ]);

  const commanderEntries =
    commanderTokenEntries(
      deck,
      collection
    );

  const deckEntries =
    deckTokenEntries(
      deck
    );

  const purchaseEntries =
    purchaseTokenEntries(
      purchaseCandidates
    );

  const evidenceEntries =
    evidenceTokenEntries(
      evidenceCardNames(
        deckEvidence
      ),
      [
        ...commanderEntries,
        ...deckEntries,
        ...purchaseEntries
      ]
    );

  const allEntries = [
    ...commanderEntries,
    ...deckEntries,
    ...purchaseEntries,
    ...evidenceEntries
  ];

  const overview =
    fullDeckOverview(
      deck,
      deckEntries
    );

  // Die vollständige Deckübersicht und die technischen Daten haben Vorrang.
  // Externe Evidenz bekommt nur den Platz, der nach den autoritativen
  // Deckdaten noch sicher verfügbar ist.
  const baseCoreSections = [
    analysisRules(),
    "",
    authoritativeTokenList(
      commanderEntries,
      deckEntries,
      purchaseEntries,
      evidenceEntries
    ),
    "",
    "TECHNISCHE DECKDATEN",
    technicalDeckData(
      deck
    ),
    "",
    "COMMANDER-INFORMATION",
    commanderContext(
      deck,
      collection,
      commanderEntries,
      allEntries
    )
  ].join("\n");

  const minimumDetailReserve =
    320;

  const evidenceBudget =
    Math.max(
      0,
      Math.min(
        EXTERNAL_EVIDENCE_CONTEXT_LIMIT,
        MAX_ANALYSIS_LENGTH -
          baseCoreSections.length -
          overview.length -
          minimumDetailReserve -
          450
      )
    );

  const externalEvidence =
    evidenceBudget >= 220
      ? shorten(
          tokenizeKnownNames(
            formatDeckEvidenceForAi(
              deckEvidence
            ),
            allEntries
          ),
          evidenceBudget
        )
      : [
          "VERIFIZIERTE EXTERNE DECK-EVIDENZ",
          "Externe Details wurden wegen des Größenlimits gekürzt."
        ].join("\n");

  const coreSections = [
    baseCoreSections,
    "",
    externalEvidence
  ].join("\n");

  const purchaseContextBudget =
    Math.max(
      0,
      Math.min(
        PURCHASE_CONTEXT_LIMIT,
        MAX_ANALYSIS_LENGTH -
          coreSections.length -
          overview.length -
          minimumDetailReserve -
          8
      )
    );

  const purchaseContext =
    purchaseContextBudget >=
    450
      ? purchaseCandidateContext(
          purchaseCandidates,
          purchaseEntries,
          allEntries,
          purchaseContextBudget,
          normalizedBudget
        )
      : [
          "SCRYFALL-VERIFIZIERTE OPTIONALE ANSCHAFFUNGSKANDIDATEN",
          "Für diese Analyse wurden die optionalen Kandidatendetails aus Platzgründen gekürzt."
        ].join("\n");

  const fixedSections = [
    coreSections,
    "",
    purchaseContext,
    ""
  ].join("\n");

  const detailBudget =
    Math.max(
      0,
      MAX_ANALYSIS_LENGTH -
        fixedSections.length -
        overview.length -
        4
    );

  const details =
    detailBudget >=
    220
      ? prioritizedDeckDetails(
          deck,
          collection,
          deckEntries,
          allEntries,
          detailBudget
        )
      : [
          "PRIORISIERTE KARTENDETAILS",
          "Zusätzliche Oracle-Details wurden aus Platzgründen weggelassen. Die vollständige Deckübersicht bleibt autoritativ."
        ].join("\n");

  let analysis = [
    fixedSections,
    overview,
    "",
    details
  ].join("\n");

  // Letzte Sicherheitsstufe: Sollte die variable Detailsektion durch
  // besonders lange Daten doch über das Limit wachsen, wird ausschließlich
  // diese optionale Sektion entfernt. Die vollständige Deckliste bleibt
  // erhalten und die KI-Anfrage kann weiterhin ausgeführt werden.
  if (
    analysis.length >
    MAX_ANALYSIS_LENGTH
  ) {
    analysis = [
      fixedSections,
      overview,
      "",
      "PRIORISIERTE KARTENDETAILS",
      "Zusätzliche Kartendetails wurden wegen des Größenlimits weggelassen."
    ].join("\n");
  }

  if (
    analysis.length >
    MAX_ANALYSIS_LENGTH
  ) {
    throw new Error(
      "Die technischen Kerndaten des Decks überschreiten das sichere KI-Größenlimit."
    );
  }

  return {
    analysis,

    cardMap:
      cardMapFromEntries(
        allEntries
      ),

    purchaseByToken:
      purchaseMapFromEntries(
        purchaseCandidates,
        purchaseEntries
      ),

    purchaseBudget: normalizedBudget,

    commanderBracketSection:
      commanderBracketProgressionSection(
        deck,
        collection,
        purchaseCandidates,
        normalizedBudget
      )
  };
}

async function readWorkerResponse(
  response: Response
): Promise<WorkerResponse> {
  try {
    return (
      await response.json()
    ) as WorkerResponse;
  } catch {
    throw new Error(
      "Der KI-Dienst hat eine ungültige Antwort geliefert."
    );
  }
}

function workerError(
  response: Response,
  data: WorkerResponse
): Error {
  if (
    response.status ===
    429
  ) {
    return new Error(
      data.error ||
        "Das KI-Limit wurde gerade erreicht. Bitte versuche es später erneut."
    );
  }

  if (
    response.status ===
      401 ||
    response.status ===
      403
  ) {
    return new Error(
      data.error ||
        "Die Anmeldung für den KI-Dienst konnte nicht bestätigt werden."
    );
  }

  if (
    response.status >=
    500
  ) {
    return new Error(
      data.error ||
        "Der KI-Dienst ist momentan nicht verfügbar."
    );
  }

  return new Error(
    data.error ||
      `Die KI-Anfrage ist fehlgeschlagen (${response.status}).`
  );
}

async function requestAiExplanation(
  idToken: string,
  context: AiRequestContext
): Promise<WorkerResponse> {
  let response: Response;

  try {
    response =
      await fetch(
        AI_WORKER_URL,
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${idToken}`
          },

          body:
            JSON.stringify({
              analysis:
                context.analysis,

              cardMap:
                context.cardMap
            })
        }
      );
  } catch {
    throw new Error(
      "Der KI-Dienst konnte nicht erreicht werden. " +
        "Bitte prüfe deine Internetverbindung und versuche es erneut."
    );
  }

  const data =
    await readWorkerResponse(
      response
    );

  if (
    !response.ok
  ) {
    throw workerError(
      response,
      data
    );
  }

  return data;
}

function stripOptionalPurchaseSection(
  explanation: string
): string {
  const heading =
    "### Optionale Anschaffungen";

  const start =
    explanation.indexOf(
      heading
    );

  if (
    start < 0
  ) {
    return explanation;
  }

  const nextHeading =
    explanation.indexOf(
      "\n### ",
      start +
        heading.length
    );

  if (
    nextHeading <
    0
  ) {
    return explanation
      .slice(
        0,
        start
      )
      .trimEnd();
  }

  return (
    explanation
      .slice(
        0,
        start
      )
      .trimEnd() +
    "\n\n" +
    explanation
      .slice(
        nextHeading +
          1
      )
      .trimStart()
  );
}

function selectedPurchaseCandidates(
  tokens:
    | string[]
    | undefined,
  context: AiRequestContext
): PurchaseCandidate[] {
  if (
    !Array.isArray(
      tokens
    )
  ) {
    return [];
  }

  const candidates: PurchaseCandidate[] = [];

  const seen =
    new Set<string>();

  for (
    const token
    of tokens
  ) {
    if (candidates.length >= 3) {
      break;
    }

    if (
      typeof token !==
        "string" ||
      seen.has(
        token
      )
    ) {
      continue;
    }

    const candidate =
      context.purchaseByToken[
        token
      ];

    if (!candidate) {
      continue;
    }

    seen.add(
      token
    );

    candidates.push(
      candidate
    );
  }

  return takeWithinDeckBudget(
    candidates,
    context.purchaseBudget
  );
}


type CommanderBracketSnapshot = {
  bracket: 2 | 3 | 4 | 5;
  label: string;
  gameChangers: number;
  extraTurnCards: number;
  massLandDenialCards: number;
  tutorCards: number;
};

function bracketLooksLikeExtraTurn(
  oracleText: string
): boolean {
  return /take an extra turn/i.test(
    oracleText
  );
}

function bracketLooksLikeMassLandDenial(
  oracleText: string
): boolean {
  return (
    /destroy all lands/i.test(oracleText) ||
    /destroy all nonbasic lands/i.test(oracleText) ||
    /return all lands to their owners'? hands/i.test(oracleText) ||
    /lands don'?t untap/i.test(oracleText) ||
    /nonbasic lands are mountains/i.test(oracleText) ||
    /each player sacrifices .*lands?/i.test(oracleText)
  );
}

function bracketLooksLikeTutor(
  oracleText: string
): boolean {
  return (
    /search your library for (?:a|an) (?!basic land|land)/i.test(oracleText) ||
    /search your library for up to (?:one|two|three|four|\d+) (?!basic land|land)/i.test(oracleText)
  );
}

function commanderBracketSnapshot(
  deck: DeckRecord,
  collection: CardRecord[]
): CommanderBracketSnapshot | null {
  if (
    deck.format !==
    "commander"
  ) {
    return null;
  }

  const entries:
    Array<{
      card: CardRecord;
      count: number;
    }> = [];

  for (
    const deckCard
    of deck.cards
  ) {
    const source =
      collection.find(
        card =>
          card.id ===
          deckCard.id
      );

    if (source) {
      entries.push({
        card: source,
        count:
          deckCard.count
      });
    }
  }

  for (
    const commanderId
    of deck.commanderIds
  ) {
    const commander =
      collection.find(
        card =>
          card.id ===
          commanderId
      );

    if (commander) {
      entries.push({
        card: commander,
        count: 1
      });
    }
  }

  const countMatching = (
    predicate:
      (card: CardRecord) =>
        boolean
  ) =>
    entries.reduce(
      (
        sum,
        entry
      ) =>
        sum +
        (
          predicate(
            entry.card
          )
            ? entry.count
            : 0
        ),
      0
    );

  const gameChangers =
    countMatching(
      card =>
        card.gameChanger ===
        true
    );

  const extraTurnCards =
    countMatching(
      card =>
        bracketLooksLikeExtraTurn(
          card.oracleText ??
          ""
        )
    );

  const massLandDenialCards =
    countMatching(
      card =>
        bracketLooksLikeMassLandDenial(
          card.oracleText ??
          ""
        )
    );

  const tutorCards =
    countMatching(
      card =>
        bracketLooksLikeTutor(
          card.oracleText ??
          ""
        )
    );

  if (deck.cedh) {
    return {
      bracket: 5,
      label:
        "Bracket 5 – cEDH",
      gameChangers,
      extraTurnCards,
      massLandDenialCards,
      tutorCards
    };
  }

  let bracket:
    2 | 3 | 4 =
      2;

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

  return {
    bracket,
    label:
      bracket === 4
        ? "Bracket 4 – Optimized"
        : bracket === 3
          ? "Bracket 3 – Upgraded"
          : "Bracket 2 – Core",
    gameChangers,
    extraTurnCards,
    massLandDenialCards,
    tutorCards
  };
}

function bracketCandidateTrait(
  candidate: PurchaseCandidate,
  targetBracket:
    3 | 4
): string | null {
  const traits:
    string[] = [];

  if (
    candidate.gameChanger
  ) {
    traits.push(
      "Game Changer"
    );
  }

  if (
    bracketLooksLikeExtraTurn(
      candidate.oracleText
    )
  ) {
    traits.push(
      "Extra Turn"
    );
  }

  if (
    bracketLooksLikeTutor(
      candidate.oracleText
    )
  ) {
    traits.push(
      "Tutor"
    );
  }

  if (
    targetBracket ===
      4 &&
    bracketLooksLikeMassLandDenial(
      candidate.oracleText
    )
  ) {
    traits.push(
      "mögliche Landverwehrung"
    );
  }

  return traits.length >
    0
      ? traits.join(", ")
      : null;
}

function commanderBracketProgressionSection(
  deck: DeckRecord,
  collection: CardRecord[],
  candidates: PurchaseCandidate[],
  purchaseBudget: PurchaseSuggestionBudget = {}
): string | null {
  const snapshot =
    commanderBracketSnapshot(
      deck,
      collection
    );

  if (!snapshot) {
    return null;
  }

  const heading =
    "### Nächstes Commander-Bracket";

  if (
    snapshot.bracket ===
    5
  ) {
    return [
      heading,
      "",
      `**Aktuelle automatische Einordnung:** ${snapshot.label}`,
      "",
      "Bracket 5 ist die höchste Stufe. Es gibt daher kein nächsthöheres Commander-Bracket."
    ].join("\n");
  }

  if (
    snapshot.bracket ===
    4
  ) {
    return [
      heading,
      "",
      `**Aktuelle automatische Einordnung:** ${snapshot.label}`,
      "**Nächste Stufe:** Bracket 5 – cEDH",
      "",
      "Bracket 5 wird hier nicht durch das bloße Hinzufügen einer bestimmten Anzahl einzelner Karten abgeleitet. Für cEDH zählen vor allem kompetitive Spielabsicht, maximale Effizienz, sehr hohe Konsistenz, Interaktion und ein entsprechend optimierter Gameplan.",
      "",
      "Die App kann deshalb für den Sprung von Bracket 4 auf 5 keine einzelne Karte seriös als ausreichende Änderung ausweisen. Im Deck-Editor muss cEDH bewusst als Ziel gesetzt werden."
    ].join("\n");
  }

  const targetBracket:
    3 | 4 =
      snapshot.bracket ===
        2
        ? 3
        : 4;

  const criteria =
    targetBracket ===
      3
      ? [
          `mindestens **1 Game Changer** (aktuell ${snapshot.gameChangers})`,
          `oder mindestens **1 Extra-Turn-Karte** (aktuell ${snapshot.extraTurnCards})`,
          `oder mindestens **3 Nichtland-Tutoren** (aktuell ${snapshot.tutorCards})`
        ]
      : [
          `mindestens **4 Game Changer** (aktuell ${snapshot.gameChangers})`,
          `oder mindestens **1 Karte mit möglicher massenhafter Landverwehrung** (aktuell ${snapshot.massLandDenialCards})`,
          `oder mindestens **3 Extra-Turn-Karten** (aktuell ${snapshot.extraTurnCards})`,
          `oder mindestens **6 Nichtland-Tutoren** (aktuell ${snapshot.tutorCards})`
        ];

  const bracketCandidates =
    candidates
      .map(
        candidate => ({
          candidate,
          trait:
            bracketCandidateTrait(
              candidate,
              targetBracket
            )
        })
      )
      .filter(
        (
          item
        ): item is {
          candidate:
            PurchaseCandidate;
          trait: string;
        } =>
          Boolean(
            item.trait
          )
      );

  const budgetedCandidates = takeWithinDeckBudget(
    bracketCandidates.map(item => item.candidate),
    purchaseBudget
  );

  const budgetedCandidateIds = new Set(
    budgetedCandidates.map(candidate => candidate.id)
  );

  const suggestions = bracketCandidates.filter(item =>
    budgetedCandidateIds.has(item.candidate.id)
  );

  const lines = [
    heading,
    "",
    `**Aktuelle automatische Einordnung:** ${snapshot.label}`,
    `**Nächste Stufe:** Bracket ${targetBracket} – ${targetBracket === 3 ? "Upgraded" : "Optimized"}`,
    "",
    "Nach der aktuell in Arcane Decksmith verwendeten automatischen Heuristik würde bereits **eines** der folgenden Merkmale die nächsthöhere Stufe auslösen:",
    "",
    ...criteria.map(
      item =>
        `- ${item}`
    )
  ];

  if (
    suggestions.length >
    0
  ) {
    lines.push(
      "",
      "**Mögliche verifizierte Karten aus den Anschaffungskandidaten:**"
    );

    for (
      const {
        candidate,
        trait
      }
      of suggestions
    ) {
      lines.push(
        `- **${candidate.name}** – ${trait}; Scryfall-verifiziert, formatlegal und mit der Commander-Farbidentität vereinbar.`
      );
    }
  } else {
    lines.push(
      "",
      "Unter den aktuell ermittelten Scryfall-verifizierten Anschaffungskandidaten wurde keine Karte gefunden, die eines dieser Bracket-Merkmale eindeutig erfüllt."
    );
  }

  lines.push(
    "",
    "*Hinweis: Das ist eine technische Schätzung anhand automatisch erkennbarer Merkmale. Die tatsächliche Einordnung eines Commander-Decks hängt auch von Spielabsicht, Kombos, Effizienz und dem gesamten Gameplan ab.*"
  );

  return lines.join(
    "\n"
  );
}

function stripCommanderBracketSection(
  explanation: string
): string {
  const heading =
    "### Nächstes Commander-Bracket";

  const start =
    explanation.indexOf(
      heading
    );

  if (
    start <
    0
  ) {
    return explanation;
  }

  const nextHeading =
    explanation.indexOf(
      "\n### ",
      start +
        heading.length
    );

  if (
    nextHeading <
    0
  ) {
    return explanation
      .slice(
        0,
        start
      )
      .trimEnd();
  }

  return (
    explanation
      .slice(
        0,
        start
      )
      .trimEnd() +
    "\n\n" +
    explanation
      .slice(
        nextHeading +
          1
      )
      .trimStart()
  );
}

function insertCommanderBracketSection(
  explanation: string,
  bracketSection: string
): string {
  const cleaned =
    stripCommanderBracketSection(
      explanation
    );

  const finalHeading =
    "### Fazit";

  const finalStart =
    cleaned.indexOf(
      finalHeading
    );

  if (
    finalStart <
    0
  ) {
    return [
      cleaned.trimEnd(),
      "",
      bracketSection
    ].join("\n");
  }

  const before =
    cleaned
      .slice(
        0,
        finalStart
      )
      .trimEnd();

  const after =
    cleaned
      .slice(
        finalStart
      )
      .trimStart();

  return [
    before,
    "",
    bracketSection,
    "",
    after
  ].join("\n");
}

function fallbackPurchaseCandidates(
  context: AiRequestContext
): PurchaseCandidate[] {
  const candidates =
    Object.values(
      context.purchaseByToken
    );

  if (
    candidates.length ===
    0
  ) {
    return [];
  }

  /*
   * Wenn Groq keine P-Kennung auswählt, soll der Abschnitt nicht leer
   * bleiben, obwohl bereits Scryfall-verifizierte, legale und nicht
   * vorhandene Kandidaten ermittelt wurden.
   *
   * Positive Rollendefizite haben Vorrang. Danach folgen weitere
   * verifizierte Alternativen. Die ursprüngliche Kandidatenreihenfolge
   * bleibt innerhalb gleicher Defizite stabil.
   */
  const ranked = candidates
    .map(
      (
        candidate,
        index
      ) => ({
        candidate,
        index
      })
    )
    .sort(
      (a, b) =>
        Number(
          b.candidate.deficit >
          0
        ) -
          Number(
            a.candidate.deficit >
            0
          ) ||
        b.candidate.deficit -
          a.candidate.deficit ||
        a.index -
          b.index
    )
    .map(
      item =>
        item.candidate
    );

  return takeWithinDeckBudget(
    ranked,
    context.purchaseBudget
  );
}

function deterministicPurchaseReason(
  candidate: PurchaseCandidate
): string {
  if (
    candidate.deficit >
    0
  ) {
    return (
      `Das aktuelle Deck enthält ${candidate.currentRoleCount} Karte(n) in der Rolle ` +
      `„${candidate.roleName}“, während der hinterlegte Zielwert bei ${candidate.targetRoleCount} liegt. ` +
      `Die Karte wurde deshalb als verifizierte Option für die Kategorie „${candidate.category}“ vorausgewählt.`
    );
  }

  return (
    `Der Zielwert der Rolle „${candidate.roleName}“ ist bereits erreicht. ` +
    `Die Karte bleibt dennoch als optionale, über Scryfall verifizierte Alternative für die Kategorie „${candidate.category}“ verfügbar.`
  );
}

function deterministicPurchaseSection(
  candidates: PurchaseCandidate[]
): string {
  const heading =
    "### Optionale Anschaffungen";

  if (
    candidates.length ===
    0
  ) {
    return [
      heading,
      "",
      "Für dieses Deck konnten aktuell keine passenden, Scryfall-verifizierten und regelkonformen Karten außerhalb deiner Sammlung ermittelt werden."
    ].join("\n");
  }

  const blocks =
    candidates.map(
      candidate =>
        [
          `**${candidate.name} — Nicht in deiner Sammlung**`,
          "",
          `- **Kategorie:** ${candidate.category}`,
          `- **Mana Value:** ${candidate.manaValue}`,
          `- **Kartentyp:** ${candidate.typeLine}`,
          `- **Scryfall-Preis:** ${candidate.priceEur !== undefined ? `${candidate.priceEur.toFixed(2).replace(".", ",")} €` : "kein EUR-Preis verfügbar"}`,
          `- **Oracle-Text:** ${candidate.oracleText}`,
          `- **Einordnung:** ${deterministicPurchaseReason(candidate)}`
        ].join("\n")
    );

  return [
    heading,
    "",
    ...blocks.flatMap(
      (
        block,
        index
      ) =>
        index === 0
          ? [block]
          : ["", block]
    )
  ].join("\n");
}

function insertPurchaseSection(
  explanation: string,
  purchaseSection: string
): string {
  const cleaned =
    stripOptionalPurchaseSection(
      explanation
    );

  const finalHeading =
    "### Fazit";

  const finalStart =
    cleaned.indexOf(
      finalHeading
    );

  if (
    finalStart <
    0
  ) {
    return [
      cleaned.trimEnd(),
      "",
      purchaseSection
    ].join("\n");
  }

  const before =
    cleaned
      .slice(
        0,
        finalStart
      )
      .trimEnd();

  const after =
    cleaned
      .slice(
        finalStart
      )
      .trimStart();

  return [
    before,
    "",
    purchaseSection,
    "",
    after
  ].join("\n");
}

function finalClientExplanation(
  data: WorkerResponse,
  context: AiRequestContext
): string | null {
  if (
    typeof data.explanation !==
      "string" ||
    !data.explanation.trim()
  ) {
    return null;
  }

  const selected =
    selectedPurchaseCandidates(
      data.selectedPurchaseTokens,
      context
    );

  const effectivePurchaseCandidates =
    selected.length >
    0
      ? selected
      : fallbackPurchaseCandidates(
          context
        );

  const purchaseSection =
    deterministicPurchaseSection(
      effectivePurchaseCandidates
    );

  const explanationWithBracket =
    context.commanderBracketSection
      ? insertCommanderBracketSection(
          data.explanation.trim(),
          context.commanderBracketSection
        )
      : data.explanation.trim();

  return insertPurchaseSection(
    explanationWithBracket,
    purchaseSection
  );
}

export async function generateAiDeckExplanation(
  deck: DeckRecord,
  purchaseBudget: PurchaseSuggestionBudget = {}
): Promise<string> {
  const session =
    await getSession();

  if (!session) {
    throw new Error(
      "Du musst angemeldet sein, um die KI-Analyse zu verwenden."
    );
  }

  const idToken =
    session.accessToken;

  const collection =
    await loadCollection(
      session.user.uid
    );

  const context =
    await createAiRequestContext(
      deck,
      collection,
      purchaseBudget
    );

  for (
    let attempt = 0;
    attempt <=
      EMPTY_RESPONSE_RETRIES;
    attempt += 1
  ) {
    const data =
      await requestAiExplanation(
        idToken,
        context
      );

    const explanation =
      finalClientExplanation(
        data,
        context
      );

    if (
      explanation
    ) {
      return explanation;
    }

    if (
      attempt <
      EMPTY_RESPONSE_RETRIES
    ) {
      await wait(
        RETRY_DELAY_MS
      );
    }
  }

  throw new Error(
    "Die generative KI hat auch nach einem automatischen zweiten Versuch keine Deckanalyse zurückgegeben."
  );
}
