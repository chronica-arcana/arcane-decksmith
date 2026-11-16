/**
 * Strenge Deck-Prüfung für Spielräume (läuft auf dem Server, nie im Browser).
 *
 * Die Formatregeln stammen direkt aus der Deck-Logik der App (`src/deckBuilder.ts`): Kopienlimit,
 * Format-Legalität, Farbidentität und Commander-Paare sind damit **exakt dieselben** wie im Deckbau.
 *
 * Eigene Karten: Für jede Karte darf die Anzahl im Deck die Anzahl in der Sammlung nicht übersteigen
 * (verglichen über die Oracle-ID bzw. den Namen, damit eine andere Druckversion zählt).
 * Basic Lands sind gemäß offiziellen Regeln von der Besitzprüfung ausgenommen.
 *
 * Name, Typ und Bild des Schnappschusses stammen aus den **Sammlungsdaten** (Datenbank), nicht aus den
 * vom Client beschreibbaren Deck-Einträgen.
 */
import {
  cardLegalForDeck,
  commanderCandidates,
  commanderColorIdentity,
  commanderPairAllowed,
  deckCopyLimit
} from "../../../src/deckBuilder.ts";

export const MAX_ERRORS = 40;
const ALL_COLORS = ["W", "U", "B", "R", "G"];
const FORMAT_LABELS = { standard: "Standard", commander: "Commander" };

const label = format => FORMAT_LABELS[format] ?? String(format);
const isBasicLand = card => card.isBasicLand === true || /\bBasic\b[^—-]*\bLand\b/i.test(card.typeLine ?? "");
const keyOf = card => card.oracleId || String(card.name ?? "").toLowerCase();
const countOf = value => Math.max(0, Math.floor(Number(value) || 0));

function imageOf(card) {
  return card.imageUris?.normal ?? card.imageUri ?? card.imageUris?.small ?? card.imageUris?.large ?? null;
}

function snapshotCard(record, count) {
  return {
    id: record.id,
    oracleId: record.oracleId ?? null,
    name: record.name,
    count,
    typeLine: record.typeLine ?? "",
    manaValue: record.manaValue ?? 0,
    manaCost: String(record.manaCost ?? "").slice(0, 60),
    oracleText: String(record.oracleText ?? "").slice(0, 700),
    imageUri: imageOf(record)
  };
}

/** Fasst gleiche Karten-IDs zusammen (Summe der Anzahlen). */
function mergeById(entries) {
  const merged = new Map();
  for (const { record, count } of entries) {
    const current = merged.get(record.id);
    if (current) current.count += count;
    else merged.set(record.id, snapshotCard(record, count));
  }
  return [...merged.values()];
}

/**
 * Prüft ein Deck für einen Raum.
 * @param {{ deck: object, collection: object[], format: "standard"|"commander" }} input
 * @returns {{ ok: boolean, errors: Array<{code:string,message:string}>, summary: object, snapshot?: object }}
 */
export function validateDeckForRoom({ deck, collection, format }) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });
  const emptySummary = { format, mainCount: 0, sideboardCount: 0, commanderCount: 0, totalCards: 0 };

  if (!deck || typeof deck !== "object") {
    add("deck_missing", "Das Deck wurde nicht gefunden.");
    return { ok: false, errors, summary: emptySummary };
  }
  if (format !== "standard" && format !== "commander") {
    add("format_unknown", "Unbekanntes Format.");
    return { ok: false, errors, summary: emptySummary };
  }

  if (deck.format !== format) {
    add("format_mismatch", `Das Deck ist ein ${label(deck.format)}-Deck, der Raum ist ein ${label(format)}-Raum.`);
  }

  const owned = new Map(); // key → Anzahl in der Sammlung
  const byId = new Map();
  for (const card of collection) {
    byId.set(card.id, card);
    owned.set(keyOf(card), (owned.get(keyOf(card)) ?? 0) + countOf(card.count));
  }

  // Deck-Einträge auflösen: Hauptdeck, Sideboard (nur Standard) und Commander (nur Commander).
  const resolve = (cards, zone) => {
    const entries = [];
    for (const card of Array.isArray(cards) ? cards : []) {
      const count = countOf(card?.count);
      if (typeof card?.id !== "string" || count === 0) {
        add("invalid_entry", `Ungültiger Deckeintrag${card?.name ? ` („${card.name}“)` : ""}.`);
        continue;
      }
      const record = byId.get(card.id);
      if (!record) {
        add("not_in_collection", `„${card.name ?? card.id}“ ist nicht in deiner Sammlung.`);
        continue;
      }
      entries.push({ zone, record, count });
    }
    return entries;
  };

  const main = resolve(deck.cards, "main");
  const sideboard = format === "standard" ? resolve(deck.sideboard, "sideboard") : [];
  const commanderIds = format === "commander" && Array.isArray(deck.commanderIds) ? deck.commanderIds : [];
  const commanders = [];
  for (const id of commanderIds) {
    const record = byId.get(id);
    if (!record) add("not_in_collection", "Ein Commander ist nicht in deiner Sammlung.");
    else commanders.push({ zone: "commander", record, count: 1 });
  }

  const sum = entries => entries.reduce((total, entry) => total + entry.count, 0);
  const mainCount = sum(main);
  const sideboardCount = sum(sideboard);
  const commanderCount = commanderIds.length;
  const totalCards = mainCount + commanderCount;
  const summary = { format, mainCount, sideboardCount, commanderCount, totalCards };

  // Größe
  if (format === "commander") {
    if (commanderCount < 1 || commanderCount > 2) {
      add("commander_count", "Ein Commander-Deck braucht einen Commander (oder ein erlaubtes Paar).");
    }
    if (totalCards !== 100) {
      add("deck_size", `Ein Commander-Deck braucht genau 100 Karten inklusive Commander (aktuell ${totalCards}).`);
    }
  } else {
    if (mainCount < 60) add("deck_size", `Ein Standard-Deck braucht mindestens 60 Karten im Hauptdeck (aktuell ${mainCount}).`);
    if (sideboardCount > 15) add("sideboard_size", `Das Sideboard darf höchstens 15 Karten haben (aktuell ${sideboardCount}).`);
  }

  // Commander gültig?
  if (format === "commander" && commanders.length === commanderCount && commanderCount >= 1) {
    const [first, second] = commanders.map(entry => entry.record);
    if (commanderCandidates([first]).length === 0) {
      add("invalid_commander", `„${first.name}“ kann nicht als Commander dienen.`);
    } else if (second && !commanderPairAllowed(first, second) && !commanderPairAllowed(second, first)) {
      add("invalid_partner", `„${first.name}“ und „${second.name}“ sind kein erlaubtes Commander-Paar.`);
    }
  }

  // Je Karte (Oracle-ID/Name) die Gesamtmenge über alle Zonen.
  const all = [...main, ...sideboard, ...commanders];
  const needByKey = new Map();
  const recordByKey = new Map();
  for (const { record, count } of all) {
    needByKey.set(keyOf(record), (needByKey.get(keyOf(record)) ?? 0) + count);
    if (!recordByKey.has(keyOf(record))) recordByKey.set(keyOf(record), record);
  }

  const colors = format === "commander" ? commanderColorIdentity(commanders.map(entry => entry.record)) : [];

  for (const [key, need] of needByKey) {
    const record = recordByKey.get(key);
    const basic = isBasicLand(record);

    if (!basic) {
      const have = owned.get(key) ?? 0;
      if (need > have) add("not_owned", `„${record.name}“: ${need}× im Deck, ${have}× in der Sammlung.`);

      const limit = deckCopyLimit(record, format);
      if (need > limit) add("copy_limit", `„${record.name}“: ${need}× im Deck, erlaubt ${limit === 1 ? "ist nur 1" : `sind ${limit}`}.`);
    }

    if (!record.legalities) {
      if (!basic) add("legality_unknown", `Für „${record.name}“ liegen keine Legalitätsdaten vor.`);
    } else if (!cardLegalForDeck(record, format, ALL_COLORS)) {
      add("not_legal", `„${record.name}“ ist in ${label(format)} nicht erlaubt.`);
    }

    if (format === "commander" && commanders.length > 0 && !(record.colorIdentity ?? []).every(color => colors.includes(color))) {
      add("color_identity", `„${record.name}“ passt nicht zur Farbidentität des Commanders.`);
    }
  }

  if (errors.length > MAX_ERRORS) {
    const extra = errors.length - MAX_ERRORS;
    errors.length = MAX_ERRORS;
    add("more", `… und ${extra} weitere Probleme.`);
  }

  if (errors.length > 0) return { ok: false, errors, summary };

  return {
    ok: true,
    errors: [],
    summary,
    snapshot: {
      deckId: deck.id,
      name: String(deck.name || "Deck").slice(0, 80),
      format,
      commanders: commanders.map(entry => snapshotCard(entry.record, 1)),
      main: mergeById(main),
      sideboard: mergeById(sideboard),
      mainCount,
      sideboardCount,
      totalCards
    }
  };
}
