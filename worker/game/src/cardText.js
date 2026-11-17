/**
 * Kartentext → Spielregeln. Liest den englischen Oracle-Text einer Karte und übersetzt die häufigen Effekte in
 * ausführbare Bausteine (Karten ziehen, Schaden, Leben, Zerstören, Exil, Zurück auf die Hand, Marker, Spielsteine,
 * Neutralisieren, Wühlen, Suchen, Abwerfen, Mana …), samt Zielen, Auslösern („When ~ enters“, „dies“, „attacks“) und
 * aktivierten Fähigkeiten (Kosten {T} und Mana, Loyalitätsfähigkeiten).
 *
 * Alles, was nicht eindeutig verstanden wird (Bedingungen, „für jedes“, X, Modi, Dauereffekte …), landet in `unparsed`
 * bzw. `notes`. Der Spielkern öffnet dafür ein manuelles Fenster, statt etwas Falsches zu automatisieren.
 */
import { KEYWORDS, parseManaCost, typesOf } from "./cardFacts.js";

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const N = "(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)";
const num = text => (/^\d+$/.test(text) ? Number(text) : (WORDS[String(text).toLowerCase()] ?? null));

const WHO = "(you|target player|target opponent|each opponent|each player)";

/** Entfernt Erinnerungstext und ersetzt den Kartennamen durch „~“. */
export function normalizeText(oracleText, name) {
  let text = String(oracleText ?? "").split("//")[0].replace(/\([^)]*\)/g, "");
  const names = [...new Set([name, String(name ?? "").split(",")[0]])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const item of names) text = text.split(item).join("~");
  text = text.replace(/\bthis (creature|permanent|artifact|enchantment|land|planeswalker|spell)\b/gi, "~");
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

const isKeywordLine = line => {
  const parts = line.split(/[,;]/).map(part => part.trim().toLowerCase().replace(/ \{.*$/, "").replace(/ \d+$/, ""));
  return parts.length > 0 && parts.every(part => KEYWORDS.includes(part) || part === "ward" || part === "equip" || part === "kicker");
};

// ---------------------------------------------------------------------------
// Ziele
// ---------------------------------------------------------------------------
const TARGET_KINDS = [
  [/^target creature or planeswalker$/, "creatureOrPlaneswalker"],
  [/^target artifact or enchantment$/, "artifactOrEnchantment"],
  [/^target nonland permanent$/, "nonland"],
  [/^target creature$/, "creature"],
  [/^target artifact$/, "artifact"],
  [/^target enchantment$/, "enchantment"],
  [/^target planeswalker$/, "planeswalker"],
  [/^target land$/, "land"],
  [/^target permanent$/, "permanent"],
  [/^(any target|target creature or player|target creature, planeswalker, or player)$/, "any"],
  [/^target player$/, "player"],
  [/^target opponent$/, "opponent"],
  [/^target spell$/, "spell"],
  [/^target creature spell$/, "creatureSpell"],
  [/^target noncreature spell$/, "noncreatureSpell"],
  [/^target instant or sorcery spell$/, "instantOrSorcerySpell"]
];

/** Ziel-Angabe → Ziel-Art (oder `null`, wenn nicht unterstützt). */
function targetKind(phrase) {
  const text = phrase.trim().toLowerCase();
  for (const [pattern, kind] of TARGET_KINDS) if (pattern.test(text)) return kind;
  return null;
}

/** Nimmt ein Ziel in die Liste auf und gibt dessen Index zurück. */
function addTarget(specs, phrase) {
  const kind = targetKind(phrase);
  if (!kind) return null;
  specs.push({ kind });
  return specs.length - 1;
}

function parseWho(text, specs) {
  const lower = String(text ?? "you").toLowerCase();
  if (lower === "you") return { k: "you" };
  if (lower === "each opponent") return { k: "eachOpp" };
  if (lower === "each player") return { k: "each" };
  if (lower === "target player" || lower === "target opponent") {
    const t = addTarget(specs, lower);
    return t === null ? null : { k: "target", t };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sätze → Effekte
// ---------------------------------------------------------------------------
const TYPE_WORDS = "(creature|land|artifact|enchantment|planeswalker|instant|sorcery|basic land|card)";

/** Ein einzelner Satz (ohne Schlusspunkt, kleingeschrieben außer Symbolen). Gibt Effekte zurück oder `null`. */
function parseSentence(raw, specs) {
  const s = raw.trim().replace(/\.$/, "");
  const lower = s.toLowerCase().replace(/^it deals/, "~ deals");
  let m;

  if ((m = lower.match(new RegExp(`^(?:${WHO} )?draws? ${N} cards?$`)))) {
    const who = parseWho(m[1] ?? "you", specs);
    return who && num(m[2]) !== null ? [{ type: "draw", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^(?:${WHO} )?gains? ${N} life$`)))) {
    const who = parseWho(m[1] ?? "you", specs);
    return who && num(m[2]) !== null ? [{ type: "life", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^(?:${WHO} )?loses? ${N} life$`)))) {
    const who = parseWho(m[1] ?? "you", specs);
    return who && num(m[2]) !== null ? [{ type: "life", who, n: -num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^(?:${WHO} )?mills? ${N} cards?$`)))) {
    const who = parseWho(m[1] ?? "you", specs);
    return who && num(m[2]) !== null ? [{ type: "mill", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^${WHO} discards? ${N} cards?$`)))) {
    const who = parseWho(m[1], specs);
    return who && num(m[2]) !== null ? [{ type: "discard", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^scry ${N}$`)))) return num(m[1]) !== null ? [{ type: "scry", n: num(m[1]) }] : null;
  if ((m = lower.match(new RegExp(`^surveil ${N}$`)))) return num(m[1]) !== null ? [{ type: "surveil", n: num(m[1]) }] : null;

  if ((m = lower.match(new RegExp(`^~ deals ${N} damage to (.+)$`)))) {
    const n = num(m[1]);
    const to = m[2];
    if (n === null) return null;
    if (to === "each opponent") return [{ type: "damage", n, to: { k: "eachOpp" } }];
    if (to === "each player") return [{ type: "damage", n, to: { k: "each" } }];
    if (to === "each creature") return [{ type: "damage", n, to: { k: "eachCreature" } }];
    if (to === "each creature you don't control") return [{ type: "damage", n, to: { k: "eachOppCreature" } }];
    const t = addTarget(specs, to);
    return t === null ? null : [{ type: "damage", n, to: { k: "target", t } }];
  }

  if ((m = lower.match(/^destroy all (creatures|lands|artifacts|enchantments)$/))) {
    return [{ type: "destroyAll", what: { creatures: "creature", lands: "land", artifacts: "artifact", enchantments: "enchantment" }[m[1]] }];
  }
  if ((m = lower.match(/^destroy (target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "destroy", t }];
  }
  if ((m = lower.match(/^exile (target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "exile", t }];
  }
  if ((m = lower.match(/^return (target .+) to its owner's hand$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "bounce", t }];
  }
  if ((m = lower.match(/^(tap|untap) (target .+)$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: m[1], t }];
  }
  if ((m = lower.match(/^counter (target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null || !/spell$/.test(m[1]) ? null : [{ type: "counterSpell", t }];
  }

  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on (~|target creature)$`)))) {
    const n = num(m[1]);
    if (n === null) return null;
    if (m[3] === "~") return [{ type: "counters", n, kind: m[2], self: true }];
    const t = addTarget(specs, m[3]);
    return t === null ? null : [{ type: "counters", n, kind: m[2], t }];
  }
  if ((m = lower.match(/^(~|target creature) gets ([+-]\d+)\/([+-]\d+) until end of turn$/))) {
    if (m[1] === "~") return [{ type: "pump", p: Number(m[2]), th: Number(m[3]), self: true }];
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "pump", p: Number(m[2]), th: Number(m[3]), t }];
  }
  if ((m = lower.match(/^(creatures you control|creatures your opponents control|all creatures) get ([+-]\d+)\/([+-]\d+) until end of turn$/))) {
    const scope = m[1] === "creatures you control" ? "you" : m[1] === "all creatures" ? "all" : "opp";
    return [{ type: "pumpAll", scope, p: Number(m[2]), th: Number(m[3]) }];
  }

  if ((m = s.match(new RegExp(`^[Cc]reate ${N} (\\d+)/(\\d+) ([A-Za-z ,]+?) creature tokens?$`)))) {
    const n = num(m[1]);
    if (n === null) return null;
    const colors = new Set(["white", "blue", "black", "red", "green", "colorless", "and", ","]);
    const name = m[4]
      .split(/[ ,]+/)
      .filter(word => word && !colors.has(word.toLowerCase()))
      .join(" ");
    return [{ type: "token", n, p: Number(m[2]), th: Number(m[3]), name: name || "Token" }];
  }

  if ((m = lower.match(new RegExp(`^search your library for (?:a|an|up to one) ((?:basic land|land|creature|artifact|enchantment|planeswalker|instant|sorcery) )?card(?:,| and)? (?:reveal (?:it|that card),? )?(?:and )?put (?:it|that card) (into your hand|onto the battlefield( tapped)?)(?:,)? ?(?:then shuffle)?$`)))) {
    return [{ type: "search", what: (m[1] ?? "card").trim(), to: m[2].startsWith("onto") ? "battlefield" : "hand", tapped: Boolean(m[3]) }];
  }
  if ((m = lower.match(new RegExp(`^return target ${TYPE_WORDS} card from your graveyard to (your hand|the battlefield)$`)))) {
    return [{ type: "gyReturn", what: m[1], to: m[2] === "your hand" ? "hand" : "battlefield" }];
  }
  if ((m = s.match(/^[Aa]dd ((?:\{[WUBRGC]\})+)$/))) {
    return [{ type: "mana", symbols: [...m[1].matchAll(/\{([WUBRGC])\}/g)].map(x => x[1]) }];
  }
  return null;
}

const WHO_DE = { you: "Du", eachOpp: "Jeder Gegner", each: "Jeder Spieler", target: "Der Zielspieler" };
const plural = (n, one, many) => (n === 1 ? one : many);

/** Verständliche deutsche Beschreibung eines Effekts (für die Anzeige auf dem Stapel). */
export function describeEffect(effect) {
  const who = effect.who ? WHO_DE[effect.who.k] ?? "Spieler" : "Du";
  const signed = value => `${value >= 0 ? "+" : ""}${value}`;
  switch (effect.type) {
    case "draw": return `${who} ${effect.who?.k === "you" ? "ziehst" : "zieht"} ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "life": return effect.n >= 0 ? `${who} ${effect.who?.k === "you" ? "erhältst" : "erhält"} ${effect.n} Leben.` : `${who} ${effect.who?.k === "you" ? "verlierst" : "verliert"} ${-effect.n} Leben.`;
    case "mill": return `${who} mahlt ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "discard": return `${who} wirft ${effect.n} ${plural(effect.n, "Karte", "Karten")} ab.`;
    case "scry": return `Wühlen ${effect.n}.`;
    case "surveil": return `Überwachen ${effect.n}.`;
    case "damage": return `${effect.n} Schaden an ${{ target: "das Ziel", eachOpp: "jeden Gegner", each: "jeden Spieler", eachCreature: "jede Kreatur", eachOppCreature: "jede gegnerische Kreatur" }[effect.to.k]}.`;
    case "destroy": return "Zerstört das Ziel.";
    case "destroyAll": return `Zerstört alle ${{ creature: "Kreaturen", land: "Länder", artifact: "Artefakte", enchantment: "Verzauberungen" }[effect.what] ?? "Permanents"}.`;
    case "exile": return "Schickt das Ziel ins Exil.";
    case "bounce": return "Das Ziel geht zurück auf die Hand seines Besitzers.";
    case "tap": return "Tappt das Ziel.";
    case "untap": return "Enttappt das Ziel.";
    case "counterSpell": return "Neutralisiert den Zielzauber.";
    case "counters": return `${effect.n}× ${effect.kind}-Marker ${effect.self ? "auf diese Karte" : "auf das Ziel"}.`;
    case "pump": return `${effect.self ? "Diese Kreatur" : "Das Ziel"} erhält ${signed(effect.p)}/${signed(effect.th)} bis zum Zugende.`;
    case "pumpAll": return `${{ you: "Deine Kreaturen", opp: "Kreaturen deiner Gegner", all: "Alle Kreaturen" }[effect.scope ?? "you"]} erhalten ${signed(effect.p)}/${signed(effect.th)} bis zum Zugende.`;
    case "token": return `Erzeugt ${effect.n}× ${effect.name} ${effect.p}/${effect.th}.`;
    case "search": return `Durchsucht die Bibliothek nach ${effect.what === "card" ? "einer Karte" : `einer Karte (${effect.what})`} und legt sie ${effect.to === "hand" ? "auf die Hand" : `aufs Schlachtfeld${effect.tapped ? " (getappt)" : ""}`}.`;
    case "gyReturn": return `Holt eine Karte (${effect.what}) aus dem Friedhof ${effect.to === "hand" ? "auf die Hand" : "aufs Schlachtfeld"}.`;
    case "mana": return `Erzeugt ${effect.symbols.map(symbol => `{${symbol}}`).join("")}.`;
    default: return "";
  }
}

/** Fasst die Effekte zusammen; nicht verstandene Sätze bleiben im englischen Original stehen. */
export function summarize({ effects, unparsed }) {
  return [...effects.map(describeEffect).filter(Boolean), ...unparsed.map(sentence => `${sentence}.`)].join(" ");
}

/** Mehrere Sätze eines Effekt-Textes. */
function parseEffectText(text) {
  const specs = [];
  const effects = [];
  const unparsed = [];
  const sentences = text
    .split(/\.\s+|\.$/)
    .map(part => part.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const tryParts = parts => {
      const mark = specs.length;
      const out = [];
      for (const part of parts) {
        const parsed = parseSentence(part, specs);
        if (!parsed) {
          specs.length = mark;
          return null;
        }
        out.push(...parsed);
      }
      return out;
    };
    const whole = tryParts([sentence]);
    if (whole) {
      effects.push(...whole);
      continue;
    }
    const pieces = sentence.split(/,? then | and /).map(piece => piece.trim());
    const split = pieces.length > 1 ? tryParts(pieces) : null;
    if (split) effects.push(...split);
    else unparsed.push(sentence);
  }
  return { effects, specs, unparsed, summary: summarize({ effects, unparsed }) };
}

/** Bedingung eines Auslösers → Ereignis (`null`, wenn nicht unterstützt). */
function triggerEvent(word, condition) {
  if (/^~ enters( the battlefield)?$/.test(condition)) return { event: "etb" };
  if (/^~ dies$/.test(condition)) return { event: "dies" };
  if (/^~ attacks$/.test(condition)) return { event: "attacks" };
  let m;
  if ((m = condition.match(/^(another|a) creature (you control|an opponent controls) dies$/))) {
    return { event: "creatureDies", scope: { owner: m[2] === "you control" ? "you" : "opp", another: m[1] === "another" } };
  }
  if ((m = condition.match(/^(another|a) creature dies$/))) return { event: "creatureDies", scope: { owner: "any", another: m[1] === "another" } };
  if ((m = condition.match(/^(another|a) creature enters( the battlefield)? under your control$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: m[1] === "another" } };
  }
  if (/^a land enters( the battlefield)? under your control$/.test(condition)) return { event: "landEnters", scope: { owner: "you", another: false } };
  if (word === "At" && condition === "the beginning of your upkeep") return { event: "upkeep", scope: { owner: "you", another: false } };
  if (word === "At" && condition === "the beginning of your end step") return { event: "endStep", scope: { owner: "you", another: false } };
  return null;
}

const stripPrefix = line => line.replace(/^[•*]\s*/, "");

/**
 * Zerlegt den Text einer Karte in Zauber-Effekt, Auslöser, aktivierte Fähigkeiten und nicht automatisch behandelbare Hinweise.
 * @returns {{ spell: object|null, triggers: object[], activated: object[], notes: string[] }}
 */
export function parseCardText({ name, typeLine, oracleText }) {
  const types = typesOf(typeLine);
  const lines = normalizeText(oracleText, name).map(stripPrefix);
  const result = { spell: null, triggers: [], activated: [], notes: [], statics: [], flashback: null, entersTapped: false };

  if (types.instant || types.sorcery) {
    const body = [];
    for (const line of lines) {
      if (isKeywordLine(line)) continue;
      const flash = line.match(/^flashback (\{[^}]+\}(?:\{[^}]+\})*)$/i);
      if (flash) result.flashback = flash[1];
      if (/^(kicker|flashback|buyback|cycling|entwine|escape|replicate|overload|convoke|affinity|storm|cascade)\b/i.test(line)) result.notes.push(line);
      else body.push(line);
    }
    if (body.some(line => /^choose (one|two|up to)/i.test(line) || /\bchoose (one|two)\b/i.test(line))) {
      result.spell = { effects: [], specs: [], unparsed: [body.join(" ")] };
    } else {
      result.spell = parseEffectText(body.join(" "));
    }
    return result;
  }

  for (const line of lines) {
    if (isKeywordLine(line)) continue;

    // Loyalitätsfähigkeit
    const loyalty = types.planeswalker ? line.match(/^([+−-]?\d+): (.+)$/) : null;
    if (loyalty) {
      const cost = { loyalty: Number(loyalty[1].replace("−", "-")) };
      const parsed = parseEffectText(loyalty[2]);
      result.activated.push({ index: result.activated.length, text: line, cost, sorcery: true, ...parsed });
      continue;
    }

    // Aktivierte Fähigkeit: Kosten: Wirkung
    const activated = line.match(/^((?:\{[^}]+\}|Sacrifice ~|, )+): (.+)$/);
    if (activated) {
      const costText = activated[1];
      if (/^add\b/i.test(activated[2])) continue; // einfaches Mana: wird als Manaquelle behandelt
      const cost = { tap: /\{T\}/.test(costText), sacrifice: /Sacrifice ~/.test(costText), mana: costText.replace(/\{T\}|Sacrifice ~|, /g, "") };
      const onlySupported = costText.replace(/\{T\}|Sacrifice ~|\{[^}]+\}|, /g, "") === "";
      if (!onlySupported) {
        result.notes.push(line);
        continue;
      }
      const parsed = parseEffectText(activated[2]);
      result.activated.push({ index: result.activated.length, text: line, cost, sorcery: /activate (this ability )?only as a sorcery/i.test(line), ...parsed });
      continue;
    }
    if (/^[^:]*(?:sacrifice|discard|pay|exile|remove|tap|untap)[^:]*: /i.test(line)) {
      result.notes.push(line);
      continue;
    }

    // Ersatzeffekt: kommt getappt ins Spiel
    if (/^~ enters( the battlefield)? tapped\.?$/i.test(line)) {
      result.entersTapped = true;
      continue;
    }

    // Dauereffekte: Boni für Kreaturen
    const anthem = line.match(/^(other )?creatures you control get ([+-]\d+)\/([+-]\d+)(?: and have ([a-z, ]+))?\.?$/i);
    const oppAnthem = line.match(/^creatures your opponents control get ([+-]\d+)\/([+-]\d+)\.?$/i);
    if (anthem) {
      const grants = (anthem[4] ?? "").split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word));
      result.statics.push({ scope: anthem[1] ? "youOther" : "you", p: Number(anthem[2]), th: Number(anthem[3]), grants });
      continue;
    }
    if (oppAnthem) {
      result.statics.push({ scope: "opp", p: Number(oppAnthem[1]), th: Number(oppAnthem[2]), grants: [] });
      continue;
    }

    // Auslöser
    const trigger = line.match(/^(When|Whenever|At) (.+?), (.+)$/);
    if (trigger) {
      const event = triggerEvent(trigger[1], trigger[2].toLowerCase());
      if (event) {
        const parsed = parseEffectText(trigger[3]);
        if (parsed.specs.length <= 1) {
          result.triggers.push({ ...event, text: line, ...parsed });
          continue;
        }
      }
    }
    result.notes.push(line);
  }
  return result;
}

export { parseManaCost };
