/**
 * Kartenwissen für den Spielkern: Typen, Schlüsselwörter, Manakosten, Manaquellen.
 * Reine Funktionen (Node-testbar). Zusätzliche Werte wie Stärke/Widerstandskraft kommen best-effort von Scryfall.
 */

export const MANA_COLORS = ["W", "U", "B", "R", "G", "C"];
const COLOR_LETTERS = new Set(MANA_COLORS);

export const KEYWORDS = [
  "flying", "reach", "first strike", "double strike", "deathtouch", "lifelink", "trample", "vigilance",
  "haste", "menace", "defender", "indestructible", "flash"
];

const BASIC_LAND_COLORS = { plains: "W", island: "U", swamp: "B", mountain: "R", forest: "G", wastes: "C" };

/** Typen aus der Typzeile (bei zweiseitigen Karten zählt die Vorderseite). */
export function typesOf(typeLine) {
  const front = String(typeLine ?? "").split("//")[0];
  const has = word => new RegExp(`\\b${word}\\b`, "i").test(front);
  return {
    creature: has("Creature"),
    land: has("Land"),
    instant: has("Instant"),
    sorcery: has("Sorcery"),
    artifact: has("Artifact"),
    enchantment: has("Enchantment"),
    planeswalker: has("Planeswalker"),
    battle: has("Battle"),
    legendary: has("Legendary"),
    basicLand: /\bBasic\b/i.test(front) && has("Land")
  };
}

/** Schlüsselwörter aus Scryfall-Liste und Regeltext (Zeilen, die mit einem Schlüsselwort beginnen). */
export function keywordsOf({ keywords, oracleText } = {}) {
  const found = new Set();
  for (const keyword of keywords ?? []) {
    const lower = String(keyword).toLowerCase();
    if (KEYWORDS.includes(lower)) found.add(lower);
  }
  const front = String(oracleText ?? "").split("//")[0];
  for (const line of front.split("\n")) {
    const head = line.replace(/\(.*?\)/g, "").trim();
    if (!head || head.length > 80) continue;
    const parts = head.split(/[,;]/).map(part => part.trim().toLowerCase());
    if (parts.length > 0 && parts.every(part => KEYWORDS.includes(part))) for (const part of parts) found.add(part);
  }
  return [...found].sort();
}

/**
 * Manakosten wie "{2}{W}{U/B}{X}" zerlegen.
 * @returns {{ reqs: Array<{opts: string[], kind: "color"|"hybrid"|"twobrid"|"phyrexian"}>, generic: number, x: number }}
 */
export function parseManaCost(cost) {
  const result = { reqs: [], generic: 0, x: 0 };
  for (const match of String(cost ?? "").matchAll(/\{([^}]+)\}/g)) {
    const symbol = match[1].toUpperCase();
    if (/^\d+$/.test(symbol)) result.generic += Number(symbol);
    else if (symbol === "X" || symbol === "Y" || symbol === "Z") result.x += 1;
    else if (symbol === "S") result.generic += 1;
    else if (COLOR_LETTERS.has(symbol)) result.reqs.push({ opts: [symbol], kind: "color" });
    else {
      const parts = symbol.split("/");
      if (parts.length === 2 && parts[0] === "2" && COLOR_LETTERS.has(parts[1])) result.reqs.push({ opts: [parts[1]], kind: "twobrid" });
      else if (parts.at(-1) === "P") result.reqs.push({ opts: parts.slice(0, -1).filter(p => COLOR_LETTERS.has(p)), kind: "phyrexian" });
      else {
        const opts = parts.filter(p => COLOR_LETTERS.has(p));
        if (opts.length > 0) result.reqs.push({ opts, kind: "hybrid" });
      }
    }
  }
  return result;
}

/**
 * Manaquelle einer Karte: Liste von „Einheiten“; jede Einheit ist die Menge der Farben, die sie erzeugen kann.
 * Beispiele: Wald → [{G}], Zweifarbenland → [{R,G}], Sol Ring → [{C},{C}], „beliebige Farbe“ → [{W,U,B,R,G}].
 * Gibt `null` zurück, wenn die Karte kein einfaches Mana mit {T} erzeugt.
 */
export function manaSourceOf({ typeLine, oracleText, produced } = {}) {
  const types = typesOf(typeLine);
  if (types.basicLand) {
    const colors = [...String(typeLine).matchAll(/\b(Plains|Island|Swamp|Mountain|Forest|Wastes)\b/gi)].map(m => BASIC_LAND_COLORS[m[1].toLowerCase()]);
    if (colors.length > 0) return [new Set([colors[0]])];
  }
  const match = String(oracleText ?? "").split("//")[0].match(/(?:^|\n)\{T\}: Add ([^.\n]+)/);
  if (match) {
    const clause = match[1];
    if (/any color|any type/i.test(clause)) return [new Set(["W", "U", "B", "R", "G"])];
    const symbols = [...clause.matchAll(/\{([WUBRGC])\}/g)].map(m => m[1]);
    if (symbols.length > 0) {
      if (/\bor\b/i.test(clause) || symbols.length === 1) return [new Set(symbols)];
      return symbols.map(symbol => new Set([symbol]));
    }
  }
  if (types.land && Array.isArray(produced) && produced.length > 0) {
    return [new Set(produced.filter(color => COLOR_LETTERS.has(color)))];
  }
  return null;
}

const numeric = value => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** Baut die unveränderlichen Kartendaten (Definition) aus Schnappschuss und optionalen Scryfall-Fakten. */
export function buildDef(card, facts = {}) {
  const typeLine = card.typeLine ?? facts.typeLine ?? "";
  const oracleText = card.oracleText ?? facts.oracleText ?? "";
  const types = typesOf(typeLine);
  return {
    name: card.name,
    typeLine,
    manaValue: card.manaValue ?? 0,
    imageUri: card.imageUri ?? null,
    manaCost: card.manaCost ?? facts.manaCost ?? "",
    types,
    power: numeric(facts.power),
    toughness: numeric(facts.toughness),
    powerText: facts.power ?? null,
    toughnessText: facts.toughness ?? null,
    loyalty: numeric(facts.loyalty),
    keywords: keywordsOf({ keywords: facts.keywords, oracleText }),
    mana: manaSourceOf({ typeLine, oracleText, produced: facts.produced_mana })?.map(unit => [...unit]) ?? null
  };
}

/** Holt Stärke/Widerstandskraft/Loyalität/Schlüsselwörter bei Scryfall (best effort; Fehler → leere Karte). */
export async function fetchScryfallFacts(ids, { fetchImpl = fetch, base = "https://api.scryfall.com", timeoutMs = 5000 } = {}) {
  const facts = new Map();
  const unique = [...new Set(ids)].filter(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
  for (let i = 0; i < unique.length; i += 75) {
    const chunk = unique.slice(i, i + 75);
    try {
      const response = await fetchImpl(`${base}/cards/collection`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "ArcaneDecksmith/1.0" },
        body: JSON.stringify({ identifiers: chunk.map(id => ({ id })) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) continue;
      const data = await response.json();
      for (const card of data.data ?? []) {
        const face = card.card_faces?.[0];
        facts.set(card.id, {
          power: card.power ?? face?.power,
          toughness: card.toughness ?? face?.toughness,
          loyalty: card.loyalty ?? face?.loyalty,
          keywords: card.keywords ?? [],
          produced_mana: card.produced_mana ?? [],
          manaCost: card.mana_cost ?? face?.mana_cost,
          oracleText: card.oracle_text ?? face?.oracle_text
        });
      }
    } catch {
      // Scryfall nicht erreichbar: das Spiel läuft ohne diese Zusatzwerte weiter
    }
  }
  return facts;
}
