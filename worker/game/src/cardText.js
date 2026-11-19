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
import { attachQuantity, parseForEach, parseQuantity, rewriteEqualTo, usesX } from "./quantity.js";

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const N = "(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d+|x)";
const num = text => (/^\d+$/.test(text) ? Number(text) : String(text).toLowerCase() === "x" ? "X" : (WORDS[String(text).toLowerCase()] ?? null));

const WHO = "(you|target player|target opponent|each opponent|each player|they|that player)";

/** Entfernt Erinnerungstext und ersetzt den Kartennamen durch „~“. */
export function normalizeText(oracleText, name) {
  let text = String(oracleText ?? "").split("//")[0].replace(/\([^)]*\)/g, "").replace(/[\u2018\u2019]/g, "'");
  const names = [...new Set([name, String(name ?? "").split(",")[0]])].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const item of names) text = text.split(item).join("~");
  text = text.replace(/(choose a creature type\.)[ \t]+/gi, "$1\n");
  text = text.replace(/\bAs it enters\b/g, "As ~ enters").replace(/\. (?=As ~ enters)/g, ".\n");
  text = text.replace(/\bthis (creature|permanent|artifact|enchantment|land|planeswalker|spell|equipment|aura|vehicle|spacecraft|saga|planet|card)\b/gi, "~");
  text = text.replace(/ +([.,;])/g, "$1");
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
  [/^target creature you control$/, "myCreature"],
  [/^target card (?:from|in) your graveyard$/, "gyAny"],
  [/^target card (?:from|in) a graveyard$/, "gyAnyPlayer"],
  [/^target creature card (?:from|in) a graveyard$/, "gyCreatureAny"],
  [/^target land card (?:from|in) a graveyard$/, "gyLandAny"],
  [/^target instant or sorcery card (?:from|in) a graveyard$/, "gyInstSorcAny"],
  [/^target creature card (?:from|in) your graveyard$/, "gyCreature"],
  [/^target artifact card (?:from|in) your graveyard$/, "gyArtifact"],
  [/^target enchantment card (?:from|in) your graveyard$/, "gyEnchantment"],
  [/^target land card (?:from|in) your graveyard$/, "gyLand"],
  [/^target permanent card (?:from|in) your graveyard$/, "gyPermanent"],
  [/^target creature$/, "creature"],
  [/^target artifact$/, "artifact"],
  [/^target enchantment$/, "enchantment"],
  [/^target planeswalker$/, "planeswalker"],
  [/^target land$/, "land"],
  [/^target permanent$/, "permanent"],
  [/^(any target|target creature or player|target creature, planeswalker, or player)$/, "any"],
  [/^target player or planeswalker$/, "playerOrPlaneswalker"],
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

const BASE_NOUNS = {
  creature: "creature", permanent: "permanent", artifact: "artifact", enchantment: "enchantment", land: "land", planeswalker: "planeswalker",
  "creature or planeswalker": "creatureOrPlaneswalker", "artifact or enchantment": "artifactOrEnchantment"
};
const COLOR_LETTERS = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const FILTER_KEYWORDS = "flying|reach|trample|haste|deathtouch|lifelink|vigilance|menace|first strike|defender";

/** Zielangaben mit Bedingungen: „another target nonland permanent an opponent controls“, „target tapped creature“ … */
function parseTargetSpec(phrase) {
  const m = phrase.trim().toLowerCase().match(/^(another )?target (.+)$/);
  if (!m) return null;
  let rest = m[2];
  const spec = {};
  if (m[1]) spec.another = true;
  let c;
  if ((c = rest.match(/^(.+) (an opponent controls|you don't control|you control)$/))) {
    rest = c[1];
    spec.ctrl = c[2] === "you control" ? "you" : "opp";
  }
  if ((c = rest.match(/^(.+) with (power|toughness) (\d+) or (greater|less)$/))) {
    rest = c[1];
    spec.stat = { of: c[2], op: c[4] === "greater" ? "gte" : "lte", n: Number(c[3]) };
  }
  if ((c = rest.match(new RegExp(`^(.+) with (${FILTER_KEYWORDS})$`)))) {
    rest = c[1];
    spec.keyword = c[2];
  }
  rest = rest.replace(/,\s+(?=non[a-z]+)/g, " ");
  const union = rest.match(/^(?:((?:non[a-z]+ )+))?((?:artifact|creature|enchantment|land|planeswalker)(?:, (?:artifact|creature|enchantment|land|planeswalker))*,? or (?:artifact|creature|enchantment|land|planeswalker))$/);
  if (union) {
    const anyTypes = union[2].split(/,? or |, /).map(word => word.trim());
    const out = { kind: "permanent", anyTypes, ...spec };
    for (const word of (union[1] ?? "").trim().split(" ").filter(Boolean)) {
      const c2 = word.match(/^non(white|blue|black|red|green)$/);
      if (c2) out.nonColors = [...(out.nonColors ?? []), COLOR_LETTERS[c2[1]]];
      else out.nonTypes = [...(out.nonTypes ?? []), word.slice(3)];
    }
    return out;
  }
  const words = rest.split(" ");
  // Untertypen als Ziel: „target Equipment you control“, „target Rebel you control“, „target Skeleton, Spirit, or Zombie“
  const last = words[words.length - 1];
  const subtypeList = rest.match(/^([a-z]+)(?:, ([a-z]+))*,? (?:or|and\/or) ([a-z]+)$/);
  if (!BASE_NOUNS[words.join(" ")] && !BASE_NOUNS[last] && /^[a-z]+$/.test(last) && !["card", "spell", "player", "opponent", "token", "ability"].includes(last)) {
    const names = subtypeList ? rest.split(/,? (?:or|and\/or) |, /).map(word => word.trim()) : [last];
    const kindOf = word => (["equipment", "vehicle"].includes(word) ? "artifact" : ["aura"].includes(word) ? "enchantment" : "creature");
    if (subtypeList || words.length === 1) {
      const kinds = [...new Set(names.map(kindOf))];
      return { kind: kinds.length === 1 ? kinds[0] : "permanent", subtypes: names.map(word => word.replace(/s$/, "")), ...spec };
    }
  }
  while (!BASE_NOUNS[words.join(" ")]) {
    const word = words.shift();
    if (!word || words.length === 0) return null;
    if (word === "tapped") spec.tapped = true;
    else if (word === "untapped") spec.tapped = false;
    else if (word === "attacking") spec.attacking = true;
    else if (word === "blocking") spec.blocking = true;
    else if (word === "legendary") spec.legendary = true;
    else if (word === "nonlegendary") spec.legendary = false;
    else if (COLOR_LETTERS[word]) spec.colors = [...(spec.colors ?? []), COLOR_LETTERS[word]];
    else if ((c = word.match(/^non(white|blue|black|red|green)$/))) spec.nonColors = [...(spec.nonColors ?? []), COLOR_LETTERS[c[1]]];
    else if ((c = word.match(/^non(artifact|land|creature|enchantment|planeswalker)$/))) spec.nonTypes = [...(spec.nonTypes ?? []), c[1]];
    else if (["artifact", "enchantment", "land"].includes(word)) spec.types = [...(spec.types ?? []), word];
    else return null;
  }
  return { kind: BASE_NOUNS[words.join(" ")], ...spec };
}

/** Nimmt ein Ziel in die Liste auf und gibt dessen Index zurück. */
function addTarget(specs, phrase) {
  const upTo = String(phrase).match(/^up to one (other |another )?(target .+)$/i);
  if (upTo) {
    const t = addTarget(specs, `${upTo[1] ? "another " : ""}${upTo[2]}`);
    if (t !== null) specs[t] = { ...specs[t], optional: true };
    return t;
  }
  const kind = targetKind(phrase);
  const spec = kind ? { kind } : parseTargetSpec(phrase);
  if (!spec) return null;
  specs.push(spec);
  return specs.length - 1;
}

function parseWho(text, specs) {
  const lower = String(text ?? "you").toLowerCase();
  if (lower === "you") return { k: "you" };
  if (lower === "each opponent") return { k: "eachOpp" };
  if (lower === "they" || lower === "that player") return { k: "subject" };
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

  // Mengenangaben: „…, where X is …“ und „… equal to …“ werden in die X-Form gebracht und berechenbar gemacht.
  if ((m = s.match(/^(.+?),? where x is (.+)$/i)) && !/where x is .*where x is/i.test(s)) {
    const quantity = parseQuantity(m[2], phrase => parseTargetSpec(phrase));
    const mark = specs.length;
    const inner = quantity ? parseSentence(m[1], specs) : null;
    if (inner && usesX(inner)) return attachQuantity(inner, quantity);
    specs.length = mark; // sonst: die bestehenden Satzregeln versuchen es weiter
  }
  if (/equal to /i.test(s) && !/\bx\b/i.test(s)) {
    const rewritten = rewriteEqualTo(s);
    const quantity = rewritten ? parseQuantity(rewritten.quantity, phrase => parseTargetSpec(phrase)) : null;
    if (quantity) {
      const mark = specs.length;
      const inner = parseSentence(rewritten.text, specs);
      if (inner && usesX(inner)) return attachQuantity(inner, quantity);
      specs.length = mark;
    }
  }

  if ((m = lower.match(/^return an? (permanent|creature|artifact|enchantment) you control to its owner's hand$/))) return [{ type: "bounceOwn", what: m[1] }];
  if ((m = lower.match(/^(tap or untap) (target permanent|target creature|target artifact|target land)$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: "tapOrUntap", t }];
  }
  if ((m = lower.match(/^exile (target (?:creature|permanent|nonland permanent) you control), then return (?:it|that card) to the battlefield under (its owner's|your) control$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "flicker", t, control: m[2] === "your" ? "you" : "owner" }];
  }
  if ((m = lower.match(/^creatures you control with counters on them gain ([a-z ,]+?) until end of turn$/))) {
    const kws = m[1].split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return kws.length > 0 ? [{ type: "grantAll", what: "creature", kws, withCounter: "any" }] : null;
  }
  if ((m = lower.match(/^move (a|one|all|any number of) (?:[+-]1\/[+-]1 )?counters? from (target [a-z ]+?) onto (?:a )?(?:second )?(target [a-z ]+)$/))) {
    const from = addTarget(specs, m[2]);
    const to = addTarget(specs, m[3]);
    return from === null || to === null ? null : [{ type: "moveCounter", from, to, all: m[1] === "all" || m[1] === "any number of" }];
  }
  if ((m = lower.match(/^(permanents|creatures) you control gain ([a-z ,]+?) until end of turn$/))) {
    const kws = m[2].split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return kws.length > 0 ? [{ type: "grantAll", what: m[1] === "permanents" ? "permanent" : "creature", kws }] : null;
  }
  if ((m = lower.match(/^you may (.+?) unless that player pays (\{[^}]+\}(?:\{[^}]+\})*)$/))) {
    const inner = parseSentence(s.slice(8, 8 + m[1].length), specs);
    return inner ? [{ type: "payGate", cost: m[2], payer: { k: "subject" }, effects: [{ type: "may", effects: inner }] }] : null;
  }
  if ((m = lower.match(/^you may pay (\{[^}]+\}(?:\{[^}]+\})*)$/))) return [{ type: "mayPay", cost: m[1] }];

  if ((m = lower.match(/^regenerate (~|target creature)$/))) {
    if (m[1] === "~") return [{ type: "regenerate", self: true }];
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "regenerate", t }];
  }
  if ((m = lower.match(/^prevent the next (\d+) damage that would be dealt to (any target|target creature|target player) this turn$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: "prevent", n: Number(m[1]), t }];
  }
  if ((m = lower.match(/^prevent all combat damage that would be dealt to and dealt by (that creature|target creature) this turn$/))) {
    const t = m[1] === "target creature" ? addTarget(specs, m[1]) : 0;
    return t === null ? null : [{ type: "noCombat", t }];
  }
  if (lower === "put it on top of its owner's library instead of into its owner's graveyard") return [{ type: "counterTo", to: "top" }];
  if (lower === "if that spell is countered this way, put it into its owner's hand instead of into its owner's graveyard") return [{ type: "counterTo", to: "hand" }];
  if ((m = lower.match(/^return (target permanent card with mana value (\d+) or less from your graveyard) to the battlefield$/))) {
    specs.push({ kind: "gyPermanent", mvMax: Number(m[2]) });
    return [{ type: "reanimate", t: specs.length - 1, to: "battlefield", counters: 0 }];
  }
  if ((m = lower.match(/^draw x cards, where x is the greatest power among creatures you controlled as you cast ~$/))) {
    return [{ type: "draw", who: { k: "you" }, n: 0, xFrom: { cast: "greatestPower" } }];
  }
  if ((m = lower.match(/^if ~ was cast from exile, you gain (twice )?x life$/))) {
    return [{ type: "life", who: { k: "you" }, n: 0, onlyFromExile: true, nFrom: { cast: "greatestPower", mult: m[1] ? 2 : 1 } }];
  }
  if ((m = lower.match(/^destroy up to one target (artifact|creature|enchantment|land|permanent) that player controls$/))) {
    specs.push({ kind: m[1], ctrl: "subject", optional: true });
    return [{ type: "destroy", t: specs.length - 1 }];
  }
  if ((m = lower.match(/^if a counter was put on ~ this turn, (.+)$/))) {
    const inner = parseSentence(s.slice(s.toLowerCase().indexOf("this turn, ") + 11), specs);
    return inner ? [{ type: "ifCounterThisTurn", effects: inner }] : null;
  }
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on each (other )?creature you control$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "countersAll", n, kind: m[2], other: Boolean(m[3]) }];
  }
  if (lower === "reveal cards from the top of your library until you reveal a creature card") return [{ type: "digUntil", what: "creature" }];
  if (lower === "put that card into your hand and the rest on the bottom of your library in a random order") return [{ type: "digRest" }];
  if ((m = lower.match(/^when you reveal a creature card this way, put x ([+-]1\/[+-]1) counters on (target creature you control), where x is the mana value of that card$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: "counters", n: 0, kind: m[1], t, xFrom: { digMv: true } }];
  }
  if ((m = lower.match(/^~ becomes an? (\d+)\/(\d+) (?:[a-z ,-]+? )?creature(?: with ([a-z ,]+?))? until end of turn(?:\. it's still a land)?$/))) {
    const kws = (m[3] ?? "").split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return [{ type: "animate", p: Number(m[1]), th: Number(m[2]), kws }];
  }
  if (lower === "it's still a land" || lower === "it's still a vehicle") return [{ type: "noop" }];
  if (lower === "exile ~") return [{ type: "exileSelf" }];
  if (lower === "untap ~") return [{ type: "untapSelf" }];
  if (lower === "sacrifice ~") return [{ type: "sacrificeSelf" }];
  if ((m = lower.match(/^you get ((?:\{e\})+)$/))) return [{ type: "energy", n: m[1].length / 3 }];
  if ((m = lower.match(/^monstrosity (\d+)$/))) return [{ type: "monstrosity", n: Number(m[1]) }];
  if (lower === "proliferate") return [{ type: "proliferate" }];
  if (lower === "you become the monarch") return [{ type: "monarch" }];
  if ((m = lower.match(/^look at the top (one|two|three|four|five|six|seven|\d+) cards? of your library$/))) {
    return [{ type: "lookTop", n: num(m[1]) }];
  }
  if ((m = lower.match(/^you may reveal (an?|up to one|up to two) ([a-z ,-]+?) cards? from among them and put (?:it|them) into your hand$/))) {
    return [{ type: "lookTake", what: m[2].replace(/ or /g, "|").trim(), count: m[1] === "up to two" ? 2 : 1, optional: true }];
  }
  if ((m = lower.match(/^put (one|two) of them into your hand and the rest on the bottom of your library in (?:a random|any) order$/))) return [{ type: "lookTake", what: "card", count: num(m[1]), optional: false }, { type: "lookRest", to: "bottom" }];
  if ((m = lower.match(/^put (one|two) of them into your hand$/))) return [{ type: "lookTake", what: "card", count: num(m[1]), optional: false }];
  if (lower === "put the rest on the bottom of your library in a random order" || lower === "put the rest on the bottom of your library in any order") return [{ type: "lookRest", to: "bottom" }];
  if (lower === "put the rest into your graveyard" || lower === "put one of them into your hand and the rest into your graveyard") {
    return lower.startsWith("put one") ? [{ type: "lookTake", what: "card", count: 1, optional: false }, { type: "lookRest", to: "graveyard" }] : [{ type: "lookRest", to: "graveyard" }];
  }
  if ((m = lower.match(/^return (target (?:permanent|creature|artifact|enchantment|land) card (?:from|in) your graveyard) to your hand$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "reanimate", t, to: "hand", counters: 0 }];
  }
  if (lower === "target creature can't be blocked this turn") {
    const t = addTarget(specs, "target creature");
    return t === null ? null : [{ type: "grantKw", kws: ["unblockable"], t }];
  }
  if (lower === "you may play an additional land this turn") return [{ type: "extraLandTurn" }];
  if ((m = lower.match(/^sacrifice (?:it|~) unless you pay (\{[^}]+\}(?:\{[^}]+\})*)$/))) {
    return [{ type: "payGate", cost: m[1], payer: { k: "you" }, effects: [{ type: "sacrificeSelf" }] }];
  }
  if ((m = lower.match(/^the owner of (target permanent) shuffles it into their library, then reveals the top card of their library$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "chaosWarp", t }];
  }
  if (lower === "if it's a permanent card, they put it onto the battlefield") return [{ type: "noop" }];
  if ((m = lower.match(/^you lose life equal to (?:its|that card's|that permanent's|that creature's) mana value$/)) && specs.length > 0) {
    return [{ type: "life", who: { k: "you" }, n: 0, nFrom: { stat: "mv", t: 0, negate: true } }];
  }
  if ((m = lower.match(/^search your library for an? (plains|island|swamp|mountain|forest) card and an? (plains|island|swamp|mountain|forest) card, put them onto the battlefield tapped(?:, then shuffle)?$/))) {
    return [{ type: "search", what: m[1], to: "battlefield", tapped: true, count: 1, upTo: false }, { type: "search", what: m[2], to: "battlefield", tapped: true, count: 1, upTo: false }];
  }
  if ((m = lower.match(/^search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped(?:, then shuffle)?$/))) {
    return [{ type: "search", what: "basic land", to: "battlefield", tapped: true, count: 2, upTo: true, sameType: true }];
  }
  if ((m = lower.match(/^then if you control (four|five|three|\d+) or more lands, untap that land$/))) return [{ type: "searchUntapIf", n: num(m[1]) }];
  if ((m = lower.match(/^add (\{[wubrgc]\}(?:\{[wubrgc]\})*)(?:, (\{[wubrgc]\}(?:\{[wubrgc]\})*))*,? or (\{[wubrgc]\}(?:\{[wubrgc]\})*)$/))) {
    const options = [...lower.slice(4).matchAll(/((?:\{[wubrgc]\})+)/g)].map(item => [...item[1].matchAll(/\{([wubrgc])\}/g)].map(sym => sym[1].toUpperCase()));
    return [{ type: "manaChoice", options }];
  }
  if (lower === "add one mana of any color in your commander's color identity") return [{ type: "manaAny", n: 1 }];
  if ((m = lower.match(/^if x is (\d+) or more, destroy all other creatures$/))) {
    return [{ type: "ifXAtLeast", n: Number(m[1]), effects: [{ type: "destroyAll", what: "creature", mode: "destroy", exceptMade: true }] }];
  }
  if ((m = lower.match(/^look at the top (two|three|four|five|\d+) cards of your library, then put them back in any order$/))) return [{ type: "rearrange", n: num(m[1]) }];
  if (lower === "you may shuffle") return [{ type: "may", effects: [{ type: "shuffleLib" }] }];
  if (lower === "shuffle" || lower === "shuffle your library") return [{ type: "shuffleLib" }];
  if ((m = lower.match(/^(target creature(?: you control)?) gets ([+-]\d+)\/([+-]\d+) and gains ([a-z ,]+?) until end of turn$/))) {
    const kws = m[4].split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    const t = addTarget(specs, m[1]);
    return t === null || kws.length === 0 ? null : [{ type: "pump", p: Number(m[2]), th: Number(m[3]), t }, { type: "grantKw", kws, t }];
  }
  if (/^activate (?:only )?(?:as a sorcery|during your turn|only once each turn)$/.test(lower)) return [{ type: "noop" }];
  if ((m = lower.match(/^adapt (\d+)$/))) return [{ type: "adapt", n: Number(m[1]) }];
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on each other ([a-z]+) you control$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "countersAll", n, kind: m[2], other: true, subtype: m[3] }];
  }
  if ((m = lower.match(/^put that many ([+-]1\/[+-]1) counters on ~$/))) return [{ type: "counters", n: 0, kind: m[1], self: true, nFrom: { damage: true } }];
  if (lower === "draw that many cards") return [{ type: "draw", who: { k: "you" }, n: 0, nFrom: { damage: true } }];
  if ((m = lower.match(/^target creature you control can't be blocked this turn$/))) {
    const t = addTarget(specs, "target creature you control");
    return t === null ? null : [{ type: "grantKw", kws: ["unblockable"], t }];
  }
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1|stun|shield) counters? on each of up to (two|three) (other )?target creatures( you control)?$`)))) {
    const n = num(m[1]);
    if (n === null || n === "X") return null;
    const effects = [];
    for (let i = 0; i < { two: 2, three: 3 }[m[3]]; i += 1) {
      const spec = parseTargetSpec(m[5] ? "target creature you control" : "target creature");
      if (!spec) return null;
      specs.push({ ...spec, optional: true, ...(m[4] ? { another: true } : {}) });
      effects.push({ type: "counters", n, kind: m[2], t: specs.length - 1 });
    }
    return effects;
  }
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on each attacking creature you control$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "countersAll", n, kind: m[2], attacking: true }];
  }
  if ((m = lower.match(/^return all (land|creature|artifact|enchantment) cards from your graveyard to the battlefield( tapped)?$/))) return [{ type: "gyReturnAll", what: m[1], tapped: Boolean(m[2]) }];
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on each ([a-z]+) (you control|your opponents control)$`))) && m[3] !== "other") {
    const n = num(m[1]);
    if (n === null || n === "X") return null;
    return [{ type: "countersAll", n, kind: m[2], ...(m[3] === "creature" ? {} : { subtype: m[3] }), ...(m[4] === "your opponents control" ? { opp: true } : {}) }];
  }
  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1) counters? on that creature$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "counters", n, kind: m[2], subjectCard: true }];
  }
  if ((m = lower.match(new RegExp(`^put ${N} ([a-z]+) counters? on ~$`))) && !/[+-]1/.test(m[2])) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "counters", n, kind: m[2], self: true }];
  }
  // Generisches „… for each <Filter>“ (alles, was der Mengen-Baustein zählen kann)
  if ((m = s.match(/^(.+?) for each (.+)$/i)) && !/^(creature you control|land you control|artifact you control|creature your opponents control|attacking creature|creature|land|artifact|card in your hand|opponent)$/i.test(m[2])) {
    const quantity = parseForEach(m[2], phrase => parseTargetSpec(phrase));
    if (quantity) {
      const mark = specs.length;
      const inner = parseSentence(m[1], specs);
      if (inner && inner.length > 0 && inner.every(effect => typeof effect.n === "number" && effect.n > 0)) return inner.map(effect => ({ ...effect, perQ: quantity }));
      specs.length = mark;
    }
  }
  // „… for each …“: der Effekt wird mit der Anzahl multipliziert.
  if ((m = lower.match(/^(.+?) for each (creature you control|land you control|artifact you control|creature your opponents control|attacking creature|creature|land|artifact|card in your hand|opponent)$/))) {
    const head = parseSentence(s.slice(0, m[1].length), specs);
    if (head && head.length === 1 && typeof head[0].n === "number" && head[0].n === 1) return [{ ...head[0], per: m[2] }];
    return null;
  }

  if ((m = lower.match(/^(?:then )?(?:if (.+?), )?you may play the exiled card without paying its mana cost(?: if (.+))?$/))) {
    const text = m[1] ?? m[2];
    let cond = null;
    if (text) {
      let c;
      if ((c = text.match(/^creatures you control have total power (\d+) or greater$/))) cond = { kind: "totalPower", n: Number(c[1]) };
      else if ((c = text.match(/^you control a creature with power (\d+) or greater$/))) cond = { kind: "creaturePower", n: Number(c[1]) };
      else if ((c = text.match(/^an opponent was dealt (\d+) or more damage this turn$/))) cond = { kind: "oppDamage", n: Number(c[1]) };
      else if ((c = text.match(/^you attacked with (two|three|four|five|\d+) or more creatures this turn$/))) cond = { kind: "attacked", n: /^\d+$/.test(c[1]) ? Number(c[1]) : { two: 2, three: 3, four: 4, five: 5 }[c[1]] };
      else return null;
    }
    return [{ type: "playHidden", cond }];
  }
  // Impulse: „Exile the top card of your library. You may play that card this turn.“
  if ((m = lower.match(new RegExp(`^exile the top (card|${N} cards) of your library$`)))) {
    const n = m[1] === "card" ? 1 : num(m[2]);
    return n === null || n === "X" ? null : [{ type: "exileTop", n }];
  }
  if (/^(?:until end of turn, )?you may play (?:that card|it|those cards|them|the exiled cards?)(?: this turn)?$/.test(lower)) return [{ type: "playExiled", next: false }];
  if (/^until (?:the )?end of your next turn, you may play (?:that card|it|those cards|them)$/.test(lower)) return [{ type: "playExiled", next: true }];
  if (/^(?:you may play lands from your graveyard)$/.test(lower)) return [{ type: "noop" }];
  // Verzögerte Effekte auf zuletzt erzeugte/übernommene Karten
  if (/^(?:it|they|that creature|those creatures|that token|those tokens) gains? haste(?: until end of turn)?$/.test(lower)) return [{ type: "grantLast", kws: ["haste"] }];
  if ((m = lower.match(/^(?:it|they|that creature|those creatures) gains? (indestructible|lifelink|trample|flying|vigilance|menace|first strike|deathtouch) until end of turn$/))) return [{ type: "grantLast", kws: [m[1]] }];
  if (/^sacrifice (?:it|them|that creature|those creatures|that token|those tokens) at the beginning of the next end step$/.test(lower)) return [{ type: "delayedLast", what: "sacrifice" }];
  if (/^exile (?:it|them|that creature|those creatures|that token|those tokens) at (?:the beginning of the next end step|end of combat)$/.test(lower)) return [{ type: "delayedLast", what: "exile" }];
  if (/^return ~ to its owner's hand at the beginning of the next end step$/.test(lower)) return [{ type: "delayedSelf", what: "hand" }];
  if (/^(?:~|it) can't be blocked this turn$/.test(lower)) return [{ type: "selfGrant", kws: ["unblockable"] }];
  if ((m = lower.match(/^~ gains (indestructible|haste|flying|trample|lifelink|vigilance|first strike|deathtouch|hexproof|menace) until end of turn$/))) return [{ type: "selfGrant", kws: [m[1]] }];
  if (/^do this only once each turn$/.test(lower) || /^this ability triggers only once each turn$/.test(lower)) return [{ type: "onceTurn" }];
  if (/^if you search your library this way, shuffle$/.test(lower)) return [{ type: "noop" }];
  if ((m = lower.match(/^untap (another target permanent|another target creature|target permanent|target creature|target land|target artifact)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "untap", t }];
  }
  if ((m = lower.match(/^tap up to one target (creature|permanent|artifact) and put a stun counter on (?:it|~)$/))) {
    const spec = parseTargetSpec(`target ${m[1]}`);
    if (!spec) return null;
    specs.push({ ...spec, optional: true });
    const t = specs.length - 1;
    return [{ type: "tap", t }, { type: "counters", n: 1, kind: "stun", t }];
  }
  if ((m = lower.match(/^return up to (two|three) target (creature|permanent|artifact|land) cards from your graveyard to your hand$/))) {
    const effects = [];
    for (let i = 0; i < { two: 2, three: 3 }[m[1]]; i += 1) {
      const t = addTarget(specs, `target ${m[2]} card from your graveyard`);
      if (t === null) return null;
      specs[t] = { ...specs[t], optional: true };
      effects.push({ type: "reanimate", t, to: "hand", counters: 0 });
    }
    return effects;
  }
  if ((m = lower.match(/^(?:then )?if you control (an? [a-z ]+?|a creature with power \d+ or greater|three or more [a-z]+s?), (.+)$/))) {
    let cond = null;
    let c;
    if ((c = m[1].match(/^a creature with power (\d+) or greater$/))) cond = { kind: "creaturePower", n: Number(c[1]) };
    else if ((c = m[1].match(/^three or more ([a-z]+?)s?$/))) cond = { kind: "controlsCount", what: c[1], n: 3 };
    else if (m[1] === "a commander") cond = { kind: "commander" };
    else if ((c = m[1].match(/^an? ([a-z]+)$/))) cond = { kind: "controlsCount", what: c[1], n: 1 };
    const inner = cond ? parseSentence(m[2], specs) : null;
    return inner ? [{ type: "ifCond", cond, effects: inner }] : null;
  }
  if (/^return (?:that card|it|the exiled card) to the battlefield under (?:its owner's|your) control at the beginning of the next end step$/.test(lower)) return [{ type: "returnExiledEnd" }];
  if ((m = lower.match(/^(artifacts|permanents|creatures) you control gain ([a-z ,]+?) until end of turn$/))) {
    const kws = m[2].split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return kws.length > 0 ? [{ type: "grantAll", what: m[1] === "artifacts" ? "artifact" : m[1] === "permanents" ? "permanent" : "creature", kws }] : null;
  }
  if ((m = lower.match(new RegExp(`^create ${N} tapped (treasure|food|clue|gold) tokens?$`)))) return [{ type: "namedToken", n: num(m[1]), name: m[2][0].toUpperCase() + m[2].slice(1), tapped: true }];
  if (lower === "destroy all creatures with no counters on them") return [{ type: "destroyAll", what: "creature", mode: "destroy", noCounters: true }];
  if ((m = lower.match(/^destroy all nonland permanents with mana value (\d+) or less$/))) return [{ type: "destroyAll", what: "permanent", nonTypes: ["land"], mode: "destroy", filter: { of: "mv", op: "lte", n: Number(m[1]) } }];
  if (lower === "destroy all nonland permanents your opponents control") return [{ type: "destroyAll", what: "permanent", nonTypes: ["land"], mode: "destroy", oppOnly: true }];
  if ((m = lower.match(/^double the number of each kind of counter on (target artifact or creature you control|target creature you control|target artifact you control)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "doubleCounters", t }];
  }
  if (lower === "that player draws an additional card") return [{ type: "draw", who: { k: "subject" }, n: 1 }];
  if (lower === "draw a card for each creature you control with a +1/+1 counter on it") return [{ type: "draw", who: { k: "you" }, n: 1, per: "creature you control with a +1/+1 counter" }];
  if (lower === "each player shuffles their hand and graveyard into their library, then draws seven cards") return [{ type: "wheel", n: 7 }];
  if (lower === "each opponent sacrifices a creature with the greatest power among creatures that player controls") return [{ type: "sacrifice", who: { k: "eachOpp" }, what: "creature", greatest: true }];
  if (lower === "put all creature cards from all graveyards onto the battlefield under your control") return [{ type: "gyReturnAll", what: "creature", allGraveyards: true }];
  if ((m = lower.match(/^put (target (?:artifact|creature|land|permanent) card from your graveyard) on top of your library$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "reanimate", t, to: "top", counters: 0 }];
  }
  if (lower === "put your commander into your hand from the command zone") return [{ type: "commanderToHand" }];
  if ((m = lower.match(/^untap up to (two|three|four|five) lands$/))) return [{ type: "untapLands", n: num(m[1]) }];
  if (lower === "you may attach ~ to it" || lower === "you may attach ~ to that creature") return [{ type: "may", effects: [{ type: "attachSubject" }] }];
  if ((m = lower.match(/^you gain (\d+) life, draw (two|three|a|\d+) cards?, then discard (two|three|a|\d+) cards?$/))) {
    return [{ type: "life", who: { k: "you" }, n: Number(m[1]) }, { type: "draw", who: { k: "you" }, n: num(m[2]) }, { type: "discard", who: { k: "you" }, n: num(m[3]) }];
  }
  if ((m = lower.match(/^if ~ is untapped, (.+)$/))) {
    const inner = parseSentence(m[1], specs);
    return inner ? [{ type: "ifCond", cond: { kind: "selfUntapped" }, effects: inner }] : null;
  }
  if (/^put (?:it|~) on the bottom of its owner's library$/.test(lower)) return [{ type: "tuckSelf" }];
  if ((m = lower.match(new RegExp(`^its controller creates ${N} (treasure|food|clue|gold) tokens?$`))) && specs.length > 0) return [{ type: "namedToken", n: num(m[1]), name: m[2][0].toUpperCase() + m[2].slice(1), forTargetController: specs.length - 1 }];
  if ((m = lower.match(/^destroy target artifact, target creature, target enchantment, and target land$/))) {
    return ["target artifact", "target creature", "target enchantment", "target land"].map(phrase => ({ type: "destroy", t: addTarget(specs, phrase) }));
  }
  if ((m = lower.match(/^(?:one or two|up to two) target creatures each get ([+-]\d+)\/([+-]\d+)(?: and gain ([a-z ,]+?))? until end of turn$/))) {
    const kws = (m[3] ?? "").split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    const first = addTarget(specs, "target creature");
    const second = addTarget(specs, "target creature");
    if (first === null || second === null) return null;
    specs[second] = { ...specs[second], optional: true };
    return [first, second].flatMap(t => [{ type: "pump", p: Number(m[1]), th: Number(m[2]), t }, ...(kws.length ? [{ type: "grantKw", kws, t }] : [])]);
  }
  if ((m = lower.match(/^return target (creature|artifact|enchantment|land|permanent) card(?: with (mana value|power) (\d+) or less)? from your graveyard to the battlefield( tapped)?(?: under your control)?$/))) {
    const t = addTarget(specs, `target ${m[1]} card from your graveyard`);
    if (t === null) return null;
    if (m[2] === "mana value") specs[t] = { ...specs[t], mvMax: Number(m[3]) };
    if (m[2] === "power") specs[t] = { ...specs[t], powerMax: Number(m[3]) };
    return [{ type: "reanimate", t, to: "battlefield", counters: 0, ...(m[4] ? { tapped: true } : {}) }];
  }
  if (lower === "untap all creatures you control") return [{ type: "untapAllMine", what: "creature" }];
  if (lower === "each player reveals the top card of their library, then draws a card") return [{ type: "draw", who: { k: "each" }, n: 1 }];
  if (lower === "look at the top card of your library") return [{ type: "noop" }];
  if ((m = lower.match(/^if it's a land card, you may put it onto the battlefield( tapped)?$/))) return [{ type: "topLandMay", tapped: Boolean(m[1]) }];
  if (lower === "you may discard your hand") return [{ type: "may", effects: [{ type: "discardHand", who: { k: "you" } }] }];
  if (lower === "if you do, draw a card for each card discarded this way") return [{ type: "ifDid", effects: [{ type: "draw", who: { k: "you" }, n: 0, nFrom: { discarded: true } }] }];
  if ((m = lower.match(/^attach (up to one )?(target equipment you control) to (target [a-z]+ you control)$/))) {
    const gear = addTarget(specs, m[2]);
    const holder = addTarget(specs, m[3]);
    if (gear === null || holder === null) return null;
    if (m[1]) specs[gear] = { ...specs[gear], optional: true };
    return [{ type: "attachTargetTo", t: gear, to: holder }];
  }
  if ((m = lower.match(/^attach (?:up to one )?(target equipment you control) to (?:it|~)$/))) {
    const t = addTarget(specs, m[1]);
    if (t === null) return null;
    if (/up to one/.test(lower)) specs[t] = { ...specs[t], optional: true };
    return [{ type: "attachToSelf", t }];
  }
  if ((m = lower.match(/^if you put a counter on a creature this turn, (.+)$/))) {
    const inner = parseSentence(m[1], specs);
    return inner ? [{ type: "ifCond", cond: { kind: "counterPutThisTurn" }, effects: inner }] : null;
  }
  if ((m = lower.match(/^(exile|destroy) up to two target (creatures|artifacts|enchantments|artifacts and\/or enchantments|nonland permanents)$/))) {
    const noun = { creatures: "target creature", artifacts: "target artifact", enchantments: "target enchantment", "artifacts and/or enchantments": "target artifact or enchantment", "nonland permanents": "target nonland permanent" }[m[2]];
    const effects = [];
    for (let i = 0; i < 2; i += 1) {
      const t = addTarget(specs, noun);
      if (t === null) return null;
      specs[t] = { ...specs[t], optional: true };
      effects.push({ type: m[1], t });
    }
    return effects;
  }
  if ((m = lower.match(/^support (\d+)$/))) {
    const n = Number(m[1]);
    const effects = [];
    for (let i = 0; i < n; i += 1) {
      const t = addTarget(specs, "another target creature");
      if (t === null) return null;
      specs[t] = { ...specs[t], optional: true };
      effects.push({ type: "counters", n: 1, kind: "+1/+1", t });
    }
    return effects;
  }
  if (lower === "each opponent draws a card, then you draw a card for each opponent who drew a card this way") return [{ type: "draw", who: { k: "eachOpp" }, n: 1 }, { type: "draw", who: { k: "you" }, n: 1, per: "opponent" }];
  if ((m = lower.match(new RegExp(`^it deals ${N} damage to (target .+)$`)))) {
    const n = num(m[1]);
    const t = n === null ? null : addTarget(specs, m[2]);
    return t === null ? null : [{ type: "damage", n, to: { k: "target", t } }];
  }
  if ((m = lower.match(/^destroy all (non-)?([a-z]+) creatures$/)) && !["tapped", "attacking", "other"].includes(m[2])) return [{ type: "destroyAll", what: "creature", mode: "destroy", ...(m[1] ? { nonSubtype: m[2] } : { subtype: m[2] }) }];
  if (lower === "each other player discards a card" || lower === "each opponent discards a card") return [{ type: "discard", who: { k: "eachOpp" }, n: 1 }];
  if (lower === "you draw a card for each card discarded this way" || lower === "draw a card for each card discarded this way") return [{ type: "draw", who: { k: "you" }, n: 0, nFrom: { discarded: true } }];
  if ((m = lower.match(/^reveal the top (two|three|four|five|six|seven|\d+) cards of your library$/))) return [{ type: "lookTop", n: num(m[1]) }];
  if ((m = lower.match(/^you may put an? ([a-z]+) card from among them into your hand$/))) return [{ type: "lookTake", what: m[1], count: 1, optional: true }];
  if ((m = lower.match(/^return ~ from your graveyard to (your hand|the battlefield)( tapped)?$/))) return [{ type: "returnSelfFromGy", to: m[1] === "your hand" ? "hand" : "battlefield", tapped: Boolean(m[2]) }];
  if ((m = lower.match(/^(you may )?sacrifice (a|an|another) (creature|artifact|enchantment|land|permanent|nonland permanent|token|[a-z]+)$/)) && !["it", "them"].includes(m[3])) {
    const what = m[3] === "nonland permanent" ? "nonland" : m[3];
    const effect = { type: "sacrificeOwn", what, other: m[2] === "another" };
    return m[1] ? [{ type: "may", effects: [effect] }] : [effect];
  }
  if (/^you may choose new targets for (the|that|target) (cop(y|ies)|spell or ability)$/.test(lower)) return [{ type: "noop" }];
  if ((m = lower.match(new RegExp(`^you may have (?:it|~) deal ${N} damage to each creature$`)))) {
    const n = num(m[1]);
    return n === null ? null : [{ type: "may", effects: [{ type: "damage", n, to: { k: "eachCreature" } }] }];
  }
  if ((m = lower.match(/^you may put an? (land) card from your hand onto the battlefield( tapped)?$/))) return [{ type: "may", effects: [{ type: "handToField", what: m[1], tapped: Boolean(m[2]) }] }];
  // „You may …“: der Spieler entscheidet (Ja/Nein); „If you do, …“ folgt nur nach „Ja“.
  if ((m = lower.match(/^you may (.+)$/))) {
    const inner = parseSentence(s.slice(8), specs);
    return inner ? [{ type: "may", effects: inner }] : null;
  }
  if ((m = lower.match(/^(?:if|when) you do, (.+)$/)) && !/^that creature gains/.test(m[1])) {
    const inner = parseSentence(s.slice(s.indexOf(",") + 2), specs);
    return inner ? [{ type: "ifDid", effects: inner }] : null;
  }

  if ((m = lower.match(/^gain control of (target (?:creature|permanent|artifact|land|enchantment)(?: an opponent controls)?)( until end of turn)?$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "control", t, untilEot: Boolean(m[2]) }];
  }
  if ((m = lower.match(/^double the number of each kind of counter on (target (?:permanent|creature|artifact|planeswalker))$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "doubleCounters", t }];
  }
  if ((m = lower.match(/^(target creature you control) explores$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "explore", t }];
  }
  if ((m = lower.match(/^(~|it|that creature) explores$/))) return [{ type: "explore", who: m[1] === "~" ? "self" : "subject" }];
  if (/^(?:that creature|it|those creatures) doesn't untap during (?:its|their) controller's next untap step$/.test(lower)) return [{ type: "freeze", t: specs.length > 0 ? 0 : null }];
  if (lower === "untap that creature" || lower === "untap it") return [{ type: "untapLast" }];
  if (/^(?:it|that creature) gains haste until end of turn$/.test(lower)) return [{ type: "hasteLast" }];
  if (lower === "prevent all combat damage that would be dealt this turn") return [{ type: "fog" }];
  if (lower === "take an extra turn after this one") return [{ type: "extraTurn" }];
  if ((m = lower.match(/^(target creature(?: you control)?|~) gains? ([a-z ,]+?) until end of turn$/))) {
    const kws = m[2].split(/,| and /).map(word => word.trim()).filter(Boolean);
    if (kws.length === 0 || !kws.every(word => KEYWORDS.includes(word))) return null;
    if (m[1] === "~") return [{ type: "grantKw", kws, self: true }];
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "grantKw", kws, t }];
  }
  if ((m = lower.match(new RegExp(`^${WHO} sacrifices? (?:a|an|one) (creature|artifact|enchantment|land|permanent|nonland permanent)(?: of (?:their|that player's) choice)?$`)))) {
    const who = parseWho(m[1], specs);
    return who ? [{ type: "sacrifice", who, what: m[2] === "nonland permanent" ? "nonland" : m[2] }] : null;
  }

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
    if (!who || num(m[2]) === null) return null;
    return [num(m[2]) === "X" ? { type: "life", who, n: "X", negate: true } : { type: "life", who, n: -num(m[2]) }];
  }
  if ((m = lower.match(new RegExp(`^(?:${WHO} )?mills? ${N} cards?$`)))) {
    const who = parseWho(m[1] ?? "you", specs);
    return who && num(m[2]) !== null ? [{ type: "mill", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^${WHO} discards? ${N} cards?$`)))) {
    const who = parseWho(m[1], specs);
    return who && num(m[2]) !== null ? [{ type: "discard", who, n: num(m[2]) }] : null;
  }
  if ((m = lower.match(new RegExp(`^(?:you )?scry ${N}$`)))) return num(m[1]) !== null ? [{ type: "scry", n: num(m[1]) }] : null;
  if ((m = lower.match(new RegExp(`^surveil ${N}$`)))) return num(m[1]) !== null ? [{ type: "surveil", n: num(m[1]) }] : null;

  if ((m = lower.match(/^~ deals ([0-9]+) damage to each creature with flying and each player$/))) return [{ type: "damage", n: Number(m[1]), to: { k: "flyingAndPlayers" } }];
  if (lower === "~ deals x damage to each creature, where x is the number of creatures on the battlefield") return [{ type: "damage", n: 1, per: "creature", to: { k: "eachCreature" } }];
  if ((m = lower.match(/^~ deals ([0-9]+) damage to each creature and each player$/))) return [{ type: "damage", n: Number(m[1]), to: { k: "everything" } }];
  if ((m = lower.match(new RegExp(`^~ deals ${N} damage to (.+)$`)))) {
    const n = num(m[1]);
    const to = m[2];
    if (n === null) return null;
    if (to === "each opponent") return [{ type: "damage", n, to: { k: "eachOpp" } }];
    if (to === "you") return [{ type: "damage", n, to: { k: "you" } }];
    if (to === "each player") return [{ type: "damage", n, to: { k: "each" } }];
    if (to === "each creature") return [{ type: "damage", n, to: { k: "eachCreature" } }];
    if (to === "each creature you don't control") return [{ type: "damage", n, to: { k: "eachOppCreature" } }];
    const t = addTarget(specs, to);
    return t === null ? null : [{ type: "damage", n, to: { k: "target", t } }];
  }

  if ((m = lower.match(/^attach (?:~|it) to (target creature you control|target creature)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "attach", t }];
  }
  if ((m = lower.match(new RegExp(`^(?:then )?if ~ was cast from (?:a|your) graveyard, put ${N} \\+1/\\+1 counters? on (?:that|it|the) token$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "flashbackTokenCounters", n }];
  }
  if ((m = lower.match(/^if you do, that creature gains ([a-z ]+?) until end of turn(?: and must be blocked this turn if able)?$/))) {
    const kws = m[1].split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return kws.length > 0 ? [{ type: "grantTemp", kws }] : null;
  }
  if ((m = lower.match(new RegExp(`^return (target (?:creature|artifact|enchantment|land|permanent) card (?:from|in) your graveyard) to (the battlefield|your hand)(?: with ${N} additional (\\+1/\\+1) counters? on it)$`)))) {
    const t = addTarget(specs, m[1]);
    const n = num(m[3]);
    if (t === null || n === null || n === "X") return null;
    return [{ type: "reanimate", t, to: m[2] === "your hand" ? "hand" : "battlefield", counters: n }];
  }
  if ((m = lower.match(new RegExp(`^(?:it|that creature) enters with ${N} additional \\+1/\\+1 counters? on it$`)))) {
    const n = num(m[1]);
    return n === null || n === "X" ? null : [{ type: "reanimateCounters", n }];
  }
  if (/^(?:it|that creature)(?:'s| is) an? [a-z ]+ in addition to its other (?:colors and )?types?$|^it'?s a [a-z ]+ in addition to its other colors and types$/.test(lower)) return [{ type: "noop" }];
  if ((m = lower.match(/^destroy all creatures with (power|toughness|mana value) (\d+) or (greater|less)$/))) {
    return [{ type: "destroyAll", what: "creature", filter: { of: m[1] === "mana value" ? "mv" : m[1], op: m[3] === "greater" ? "gte" : "lte", n: Number(m[2]) } }];
  }
  if (lower === "destroy all tapped creatures") return [{ type: "destroyAll", what: "creature", mode: "destroy", onlyTapped: true }];
  if ((m = lower.match(/^destroy each nonland permanent with mana value x or less$/))) return [{ type: "destroyAll", what: "permanent", mode: "destroy", nonTypes: ["land"], filter: { of: "mv", op: "lte", n: "X" } }];
  if ((m = lower.match(/^(destroy|exile) all ((?:non[a-z]+,? )*)(creatures|artifacts|enchantments|lands|planeswalkers|permanents)((?:,? (?:and )?(?:creatures|artifacts|enchantments|lands|planeswalkers))*)$/))) {
    const single = { creatures: "creature", artifacts: "artifact", enchantments: "enchantment", lands: "land", planeswalkers: "planeswalker", permanents: "permanent" };
    const what = [single[m[3]], ...[...m[4].matchAll(/(creatures|artifacts|enchantments|lands|planeswalkers)/g)].map(item => single[item[1]])];
    const nonTypes = [...m[2].matchAll(/non([a-z]+)/g)].map(item => item[1]).filter(word => word !== "token");
    return [{ type: "destroyAll", what: what.length === 1 ? what[0] : what, mode: m[1], ...(nonTypes.length ? { nonTypes } : {}), ...(/nontoken/.test(m[2]) ? { nontoken: true } : {}) }];
  }
  // --- Biss und Kampf, Friedhof, Wirkungen mit Bezug auf das Ziel
  if ((m = lower.match(/^(target creature you control) deals damage equal to its power to (target creature(?: or planeswalker)? you don't control|target creature)$/))) {
    const from = addTarget(specs, m[1]);
    const to = addTarget(specs, m[2]);
    return from === null || to === null ? null : [{ type: "bite", from, to }];
  }
  if ((m = lower.match(/^(target creature you control) fights (target creature you don't control|target creature)$/))) {
    const a = addTarget(specs, m[1]);
    const b = addTarget(specs, m[2]);
    return a === null || b === null ? null : [{ type: "fight", a, b }];
  }
  if (/^if the creature you control has trample, excess damage is dealt to that creature's controller instead$/.test(lower)) return [{ type: "biteTrample" }];
  if ((m = lower.match(/^exile (?:all cards from )?(target player's|target opponent's) graveyard$/))) {
    const t = addTarget(specs, m[1] === "target player's" ? "target player" : "target opponent");
    return t === null ? null : [{ type: "exileGraveyard", t }];
  }
  if ((m = lower.match(/^put x ([+-]1\/[+-]1) counters? on (target creature), where x is (?:that creature's|its) power$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: "counters", n: 0, kind: m[1], t, xFrom: { stat: "power", t } }];
  }
  if ((m = lower.match(/^counter (target .+?) unless its controller pays (\{[^}]+\}(?:\{[^}]+\})*)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null || !/spell$/.test(m[1]) ? null : [{ type: "counterSpell", t, unlessPay: m[2] }];
  }
  if (/^(?:it|they|that creature|those creatures) can't be regenerated$/.test(lower)) return [{ type: "noop" }];
  if ((m = lower.match(/^its controller gains life equal to its (power|toughness)$/))) {
    return specs.length > 0 ? [{ type: "life", who: { k: "controllerOf", t: 0 }, n: 0, nFrom: { stat: m[1], t: 0 } }] : null;
  }
  if ((m = lower.match(new RegExp(`^(?:its controller|that player) gains ${N} life$`)))) {
    return specs.length > 0 && typeof num(m[1]) === "number" ? [{ type: "life", who: { k: "controllerOf", t: 0 }, n: num(m[1]) }] : null;
  }
  if ((m = lower.match(/^its controller may (.+)$/)) && specs.length > 0) {
    const inner = parseSentence(s.slice(s.toLowerCase().indexOf("may ") + 4).replace(/\btheir library\b/i, "your library"), specs);
    return inner ? [{ type: "may", who: { k: "controllerOf", t: 0 }, effects: inner.map(effect => ({ ...effect, forWho: { k: "controllerOf", t: 0 } })) }] : null;
  }
  if ((m = lower.match(/^(?:you|that player) (?:takes?|take) an extra turn after this one$/)) || lower === "target player takes an extra turn after this one") {
    return [{ type: "extraTurn" }];
  }
  if ((m = lower.match(/^add one mana of any color$/))) return [{ type: "manaAny", n: 1 }];
  if ((m = lower.match(new RegExp(`^discards? ${N} cards?$`)))) return num(m[1]) !== null ? [{ type: "discard", who: { k: "you" }, n: num(m[1]) }] : null;
  if ((m = lower.match(/^put (one|two|three) cards? from your hand on top of your library(?: in any order)?$/))) {
    return [{ type: "putBack", n: num(m[1]) }];
  }
  if ((m = lower.match(/^(target player|target opponent) reveals their hand$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "revealHand", t }];
  }
  if ((m = lower.match(/^you choose an? ((?:non[a-z]+(?:, )?)+|[a-z]+) card from it$/))) {
    const excluded = [...m[1].matchAll(/non([a-z]+)/g)].map(item => item[1]);
    return [{ type: "chooseFromRevealed", exclude: excluded }];
  }
  if (lower === "that player discards that card") return [{ type: "discardChosen" }];
  if ((m = lower.match(/^(?:you |)(?:create|creates) (a|an|one|two|three) (treasure|food|clue|blood|lander|map|gold|powerstone) tokens?$/i))) {
    return [{ type: "namedToken", n: num(m[1]), name: m[2][0].toUpperCase() + m[2].slice(1) }];
  }
  if (lower === "investigate") return [{ type: "namedToken", n: 1, name: "Clue" }];
  if ((m = lower.match(/^return (target card (?:from|in) your graveyard) to your hand$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "reanimate", t, to: "hand", counters: 0 }];
  }
  if ((m = lower.match(/^put (target creature card from a graveyard) onto the battlefield under your control$/))) {
    specs.push({ kind: "gyCreatureAny" });
    return [{ type: "reanimate", t: specs.length - 1, to: "battlefield", counters: 0, anyGraveyard: true }];
  }
  if ((m = lower.match(/^you lose life equal to its mana value$/)) && specs.length > 0) return [{ type: "life", who: { k: "you" }, n: 0, nFrom: { stat: "mv", t: 0, negate: true } }];
  if ((m = lower.match(/^put (target .+) on the (bottom|top) of its owner's library$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "tuck", t, pos: m[2] }];
  }
  if ((m = lower.match(/^untap (two|three) target (lands|creatures)$/))) {
    const count = num(m[1]);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const t = addTarget(specs, m[2] === "lands" ? "target land" : "target creature");
      if (t === null) return null;
      out.push({ type: "untap", t });
    }
    return out;
  }
  if ((m = lower.match(/^([a-z]+s) and ([a-z]+s) you control get ([+-]\d+)\/([+-]\d+)(?: and gain ([a-z, ]+))? until end of turn$/))) {
    const kws = (m[5] ?? "").split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    return [{ type: "pumpAll", scope: "you", p: Number(m[3]), th: Number(m[4]), kws, anyOf: [m[1].replace(/s$/, ""), m[2].replace(/s$/, "")] }];
  }
  if ((m = lower.match(/^(creatures you control|creatures your opponents control|all creatures) (?:get ([+-]\d+)\/([+-]\d+) and gain ([a-z, ]+)|gain ([a-z ,]+?) and get ([+-]x|[+-]\d+)\/([+-]x|[+-]\d+)) until end of turn(?:, where x is the number of creatures you control)?$/))) {
    const scope = m[1] === "creatures you control" ? "you" : m[1] === "all creatures" ? "all" : "opp";
    const kws = (m[4] ?? m[5]).split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    const parse = value => (/x$/.test(value) ? "X" : Number(value));
    return [{ type: "pumpAll", scope, p: m[2] !== undefined ? Number(m[2]) : parse(m[6]), th: m[3] !== undefined ? Number(m[3]) : parse(m[7]), kws, ...(m[6] && /x/.test(m[6]) ? { xPer: "creature you control" } : {}) }];
  }
  if (lower === "exile all graveyards") return [{ type: "exileAllGraveyards" }];
  if ((m = lower.match(new RegExp(`^you and (target opponent) each draw ${N} cards?$`)))) {
    const t = addTarget(specs, m[1]);
    const n = num(m[2]);
    return t === null || n === null || n === "X" ? null : [{ type: "draw", who: { k: "you" }, n }, { type: "draw", who: { k: "target", t }, n }];
  }
  if ((m = lower.match(new RegExp(`^each player discards their hand, then draws ${N} cards$`)))) {
    return num(m[1]) === null ? null : [{ type: "discardHand", who: { k: "each" } }, { type: "draw", who: { k: "each" }, n: num(m[1]) }];
  }
  if (lower === "each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way") return [{ type: "discardHand", who: { k: "each" }, drawGreatest: true }];
  if (lower === "reveal the top card of your library") return [{ type: "revealTop" }];
  if ((m = lower.match(/^if it's a (land|creature|artifact|enchantment) card, put it onto the battlefield$/))) return [{ type: "revealIf", what: m[1], to: "battlefield" }];
  if ((m = lower.match(/^otherwise, put it into your hand$/))) return [{ type: "revealElse", to: "hand" }];
  if ((m = lower.match(/^return ~ to its owner's hand$/))) return [{ type: "returnSelf" }];
  if ((m = lower.match(/^destroy (another target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "destroy", t }];
  }
  if ((m = lower.match(/^exile (target (?:creature |land |instant or sorcery )?card (?:from|in) a graveyard)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "exile", t }];
  }
  if ((m = lower.match(/^exile ((?:another )?target .+?)( until ~ leaves the battlefield)?$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "exile", t, ...(m[2] ? { until: true } : {}) }];
  }
  if ((m = lower.match(/^destroy (target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "destroy", t }];
  }
  if ((m = lower.match(/^return (target .+) to its owner's hand$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "bounce", t }];
  }
  if (lower === "return a land you control to its owner's hand") return [{ type: "bounceOwnLand" }];
  if ((m = lower.match(/^(tap|untap) (target .+)$/))) {
    const t = addTarget(specs, m[2]);
    return t === null ? null : [{ type: m[1], t }];
  }
  if ((m = lower.match(/^copy (target instant or sorcery spell)(?: you control| an opponent controls)?( twice)?$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "copySpell", t, n: m[2] ? 2 : 1 }];
  }
  if (lower === "copy that spell" || lower === "copy it") return [{ type: "copySpell", subject: true, n: 1 }];
  if ((m = lower.match(/^counter (target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null || !/spell$/.test(m[1]) ? null : [{ type: "counterSpell", t }];
  }

  if ((m = lower.match(new RegExp(`^put ${N} ([+-]1/[+-]1|first strike|double strike|[a-z]+) counters? on (~|target [a-z ,'-]+)$`)))) {
    const n = num(m[1]);
    if (n === null) return null;
    if (m[3] === "~") return [{ type: "counters", n, kind: m[2], self: true }];
    const t = addTarget(specs, m[3]);
    return t === null ? null : [{ type: "counters", n, kind: m[2], t }];
  }
  if ((m = lower.match(/^(~|target creature(?: you control| an opponent controls)?|another target creature(?: you control)?) gets ([+-]\d+|[+-]x)\/([+-]\d+|[+-]x) until end of turn$/))) {
    const value = v => (/x$/.test(v) ? (v.startsWith("-") ? "-X" : "X") : Number(v));
    if (m[1] === "~") return [{ type: "pump", p: value(m[2]), th: value(m[3]), self: true }];
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "pump", p: value(m[2]), th: value(m[3]), t }];
  }
  if ((m = lower.match(/^(creatures you control|creatures your opponents control|all creatures) get ([+-]\d+)\/([+-]\d+) until end of turn$/))) {
    const scope = m[1] === "creatures you control" ? "you" : m[1] === "all creatures" ? "all" : "opp";
    return [{ type: "pumpAll", scope, p: Number(m[2]), th: Number(m[3]) }];
  }

  if ((m = s.match(new RegExp(`^(?:Its controller |That player |You )?[Cc]reates? ${N} (\\d+)/(\\d+) ([A-Za-z ,]+?) creature tokens?(?: with ([a-z ,]+?))?$`, "i")))) {
    const tokenKws = (m[5] ?? "").split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    const forWho = /^Its controller /i.test(s) && specs.length > 0 ? { k: "controllerOf", t: 0 } : null;
    const n = num(m[1]);
    if (n === null) return null;
    const colors = new Set(["white", "blue", "black", "red", "green", "colorless", "and", ",", "artifact", "enchantment", "legendary", "snow"]);
    const artifact = /\bartifact\b/i.test(m[4]);
    const name = m[4]
      .split(/[ ,]+/)
      .filter(word => word && !colors.has(word.toLowerCase()))
      .join(" ");
    return [{ type: "token", n, p: Number(m[2]), th: Number(m[3]), name: name || "Token", ...(artifact ? { artifact: true } : {}), ...(forWho ? { forWho } : {}), ...(tokenKws.length ? { keywords: tokenKws } : {}) }];
  }

  // Tutor: beliebige Karte (oder Kartentyp) auf die Hand oder oben auf die Bibliothek
  if ((m = lower.match(/^search your library for an? ((?:creature|artifact|enchantment|planeswalker|instant|sorcery|land) )?card(?:, reveal (?:it|that card))?(?:,| and)? ?(?:then )?(?:put (?:it|that card) into your hand(?:,? then shuffle)?|shuffle and put (?:it|that card) on top(?: of your library)?)$/))) {
    return [{ type: "search", what: (m[1] ?? "card").trim(), to: /on top/.test(lower) ? "top" : "hand", tapped: false, count: 1, upTo: false }];
  }
  // Suchen: eine oder mehrere Karten (Typ, Grundland-Typen), auf die Hand oder aufs Schlachtfeld
  if ((m = lower.match(/^search your library for (a|an|up to one|up to two|up to three|two|three) ((?:basic land|land|creature|artifact|enchantment|planeswalker|instant|sorcery|(?:basic )?(?:plains|island|swamp|mountain|forest))(?:, (?:basic )?(?:plains|island|swamp|mountain|forest))*(?:,? or (?:basic )?(?:plains|island|swamp|mountain|forest))?) cards?(?:, reveal (?:it|that card|those cards))?(?:,| and)? ?(?:then )?put (?:it|that card|them|those cards) (into your hand|onto the battlefield( tapped)?)(?:,)? ?(?:then shuffle)?$/))) {
    const count = { a: 1, an: 1, "up to one": 1, "up to two": 2, "up to three": 3, two: 2, three: 3 }[m[1]];
    const what = m[2].replace(/basic (?=plains|island|swamp|mountain|forest)/g, "").replace(/,? or /g, "|").replace(/, /g, "|");
    return [{ type: "search", what: what.trim(), to: m[3].startsWith("onto") ? "battlefield" : "hand", tapped: Boolean(m[4]), count, upTo: m[1].startsWith("up to") }];
  }
  if ((m = lower.match(/^search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand(?:, then shuffle)?$/))) {
    return [{ type: "search", what: "basic land", to: "split", tapped: true, count: 2, upTo: true }];
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

/** „gets +2/+1 and has trample and lifelink and loses flying“ → Bonus, gewährte und entzogene Schlüsselwörter (`null`, wenn etwas nicht verstanden wird). */
function parseAttachClauses(text) {
  const out = { p: 0, th: 0, grants: [], revokes: [] };
  let mode = null;
  for (const raw of text.split(/,\s*(?:and )?|\s+and\s+/)) {
    let part = raw.trim().toLowerCase();
    if (!part) continue;
    let m;
    if ((m = part.match(/^gets ([+-]\d+)\/([+-]\d+)$/))) {
      out.p += Number(m[1]);
      out.th += Number(m[2]);
      mode = null;
      continue;
    }
    if (/^is an? [a-z ]+ in addition to its other (?:creature )?types$/.test(part)) continue;
    if (part === "is goaded") {
      out.grants.push("must-attack");
      mode = null;
      continue;
    }
    if ((m = part.match(/^(has|loses) (.+)$/))) {
      mode = m[1] === "has" ? "grants" : "revokes";
      part = m[2];
    } else if (mode === null) return null;
    if (!KEYWORDS.includes(part) && part !== "protection") return null;
    out[mode].push(part);
  }
  return out;
}

const COUNT_WORD = { a: 1, an: 1, one: 1, two: 2, three: 3 };

/** Kosten einer aktivierten Fähigkeit; `null`, wenn etwas nicht unterstützt wird. */
function parseAbilityCost(text) {
  const parts = text.split(/,\s*(?![^{]*\})/).map(part => part.trim()).filter(Boolean);
  const cost = { tap: false, sacrifice: false, mana: "" };
  let m;
  for (const part of parts) {
    if (part === "{T}") cost.tap = true;
    else if (/^(\{[^}]+\})+$/.test(part)) cost.mana += part;
    else if (part === "Sacrifice ~") cost.sacrifice = true;
    else if (part === "Exile ~") cost.exileSelf = true;
    else if (part === "Discard ~") cost.discardSelf = true;
    else if ((m = part.match(/^Remove a counter from an? (nonland )?permanent you control$/i))) cost.extra = [...(cost.extra ?? []), { kind: "removeAnyCounter", n: 1, nonland: Boolean(m[1]) }];
    else if ((m = part.match(/^Sacrifice (a|an|another) (artifact creature|nontoken creature|nonland permanent)$/i))) cost.extra = [...(cost.extra ?? []), { kind: "sacrifice", what: m[2].toLowerCase() === "nonland permanent" ? "nonland" : m[2].toLowerCase().replace("nontoken ", ""), n: 1, other: m[1].toLowerCase() === "another", ...(/artifact creature/i.test(m[2]) ? { artifactCreature: true } : {}), ...(/nontoken/i.test(m[2]) ? { nontoken: true } : {}) }];
    else if (/^Remove a counter from ~$/i.test(part)) {
      cost.extra = [...(cost.extra ?? []), { kind: "removeCounter", counter: "any", n: 1 }];
    } else if ((m = part.match(/^Remove an? ([a-z0-9+/-]+) counter from ~$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "removeCounter", counter: m[1].toLowerCase(), n: 1 }];
    } else if ((m = part.match(/^Tap (an|one|two|three) untapped (creature|artifact|land|permanent)s? you control$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "tap", what: m[2].toLowerCase(), n: COUNT_WORD[m[1].toLowerCase()] ?? 1 }];
    } else if ((m = part.match(/^Sacrifice (a|an|another|one|two|three) (creature|artifact|land|enchantment|permanent|nonland permanent|[A-Za-z]+)s?$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "sacrifice", what: m[2].toLowerCase() === "nonland permanent" ? "nonland" : m[2].toLowerCase(), n: COUNT_WORD[m[1].toLowerCase()] ?? 1, other: m[1].toLowerCase() === "another" }];
    } else if ((m = part.match(/^Discard (a|one|two|three) cards?$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "discard", n: COUNT_WORD[m[1].toLowerCase()] ?? 1 }];
    } else if ((m = part.match(/^Pay ((?:\{E\})+)$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "energy", n: m[1].length / 3 }];
    } else if ((m = part.match(/^Pay (\d+) life$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "life", n: Number(m[1]) }];
    } else return null;
  }
  return cost;
}

/** Verständliche deutsche Beschreibung eines Effekts (für die Anzeige auf dem Stapel). */
const PER_DE = {
  "creature you control": "deiner Kreaturen", "land you control": "deiner Länder", "artifact you control": "deiner Artefakte",
  "creature your opponents control": "gegnerischer Kreaturen", creature: "Kreaturen", land: "Länder", artifact: "Artefakte",
  "card in your hand": "Karten auf deiner Hand", opponent: "Gegner"
};
export function describeEffect(effect) {
  const text = describeBase(effect);
  return effect.per && text ? `${text} (mal Anzahl ${PER_DE[effect.per] ?? effect.per})` : text;
}

function describeBase(effect) {
  const who = effect.who ? WHO_DE[effect.who.k] ?? "Spieler" : "Du";
  const signed = value => `${value >= 0 ? "+" : ""}${value}`;
  switch (effect.type) {
    case "draw":
      if (effect.xFrom?.cast) return `${who} ${effect.who?.k === "you" ? "ziehst" : "zieht"} X Karten (X = größte Stärke deiner Kreaturen beim Wirken).`;
      return `${who} ${effect.who?.k === "you" ? "ziehst" : "zieht"} ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "life": {
      const loss = effect.negate || (typeof effect.n === "number" && effect.n < 0);
      if (effect.nFrom?.cast) return `Wurde der Zauber aus dem Exil gewirkt: ${effect.nFrom.mult === 2 ? "doppelt so viel" : "so viel"} Leben wie X.`;
      const amount = typeof effect.n === "number" ? Math.abs(effect.n) : effect.n;
      return loss ? `${who} ${effect.who?.k === "you" ? "verlierst" : "verliert"} ${amount} Leben.` : `${who} ${effect.who?.k === "you" ? "erhältst" : "erhält"} ${amount} Leben.`;
    }
    case "mill": return `${who} mahlt ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "discard": return `${who} wirft ${effect.n} ${plural(effect.n, "Karte", "Karten")} ab.`;
    case "scry": return `Wühlen ${effect.n}.`;
    case "surveil": return `Überwachen ${effect.n}.`;
    case "damage": return `${effect.n} Schaden an ${{ target: "das Ziel", eachOpp: "jeden Gegner", each: "jeden Spieler", eachCreature: "jede Kreatur", eachOppCreature: "jede gegnerische Kreatur" }[effect.to.k]}.`;
    case "destroy": return "Zerstört das Ziel.";
    case "tuckSelf": return "Kommt unter die Bibliothek ihres Besitzers.";
    case "untapAllMine": return "Enttappt alle deine Kreaturen.";
    case "topLandMay": return "Ist die oberste Karte ein Land, darf es aufs Schlachtfeld.";
    case "attachToSelf": return "Hängt die Ziel-Ausrüstung an diese Kreatur.";
    case "returnSelfFromGy": return effect.to === "hand" ? "Kommt aus dem Friedhof auf die Hand." : "Kommt aus dem Friedhof aufs Schlachtfeld.";
    case "sacrificeOwn": return "Opfert ein eigenes Permanent.";
    case "wheel": return `Jeder mischt Hand und Friedhof in die Bibliothek und zieht ${effect.n}.`;
    case "commanderToHand": return "Nimmt deinen Kommandanten aus der Kommandozone auf die Hand.";
    case "untapLands": return `Enttappt bis zu ${effect.n} Länder.`;
    case "attachSubject": return "Hängt diese Karte an die Kreatur.";
    case "unearth": return "Kehrt mit Eile zurück; am Zugende ins Exil.";
    case "ifCond": return `Falls die Bedingung erfüllt ist: ${effect.effects.map(describeEffect).filter(Boolean).join(" ")}`;
    case "returnExiledEnd": return "Kehrt zu Beginn des nächsten Endsegments zurück.";
    case "exileTop": return `Legt die obersten ${effect.n} Karte(n) der Bibliothek ins Exil.`;
    case "playExiled": return effect.next ? "Diese Karten darfst du bis zum Ende deines nächsten Zuges spielen." : "Diese Karten darfst du in diesem Zug spielen.";
    case "grantLast": return `Die Karte erhält ${effect.kws.join(", ")} bis zum Zugende.`;
    case "delayedLast": return effect.what === "sacrifice" ? "Wird zu Beginn des nächsten Endsegments geopfert." : "Wird später ins Exil geschickt.";
    case "delayedSelf": return "Kehrt zu Beginn des nächsten Endsegments auf die Hand zurück.";
    case "selfGrant": return `Erhält ${effect.kws.join(", ")} bis zum Zugende.`;
    case "onceTurn": return "";
    case "jobSelect": return "Erzeugt einen 1/1-Hero-Spielstein und hängt die Ausrüstung daran.";
    case "hideaway": return `Hideaway ${effect.n}: eine der obersten ${effect.n} Karten verdeckt ins Exil.`;
    case "playHidden": return "Spielt die versteckte Karte kostenlos (falls die Bedingung erfüllt ist).";
    case "gyReturnAll": return "Legt alle passenden Karten aus dem Friedhof aufs Schlachtfeld.";
    case "handToField": return "Lege eine Landkarte aus der Hand aufs Schlachtfeld.";
    case "destroyAll": return `Zerstört alle ${{ creature: "Kreaturen", land: "Länder", artifact: "Artefakte", enchantment: "Verzauberungen" }[effect.what] ?? "Permanents"}.`;
    case "exile": return "Schickt das Ziel ins Exil.";
    case "bounce": return "Das Ziel geht zurück auf die Hand seines Besitzers.";
    case "bounceOwnLand": return "Du legst ein eigenes Land zurück auf die Hand.";
    case "tap": return "Tappt das Ziel.";
    case "counterSpell": return "Neutralisiert den Zielzauber.";
    case "copySpell": return effect.n > 1 ? "Kopiert den Zauber zweimal (Ziele bleiben gleich)." : "Kopiert den Zauber (Ziele bleiben gleich).";
    case "control": return `Übernimmt die Kontrolle über das Ziel${effect.untilEot ? " bis zum Zugende" : ""}.`;
    case "untapLast": return "Enttappt diese Kreatur.";
    case "hasteLast": return "Sie erhält Eile bis zum Zugende.";
    case "fog": return "Verhindert allen Kampfschaden in diesem Zug.";
    case "extraTurn": return "Du erhältst nach diesem Zug einen zusätzlichen Zug.";
    case "grantKw": return `${effect.self ? "Diese Karte" : "Das Ziel"} erhält ${effect.kws.join(", ")} bis zum Zugende.`;
    case "sacrifice": return `${who} opfert ${{ creature: "eine Kreatur", artifact: "ein Artefakt", enchantment: "eine Verzauberung", land: "ein Land", permanent: "ein Permanent", nonland: "ein Nichtland-Permanent" }[effect.what] ?? "ein Permanent"}.`;
    case "may": return `Optional: ${effect.effects.map(describeEffect).filter(Boolean).join(" ")}`;
    case "ifDid": return `Wenn ja: ${effect.effects.map(describeEffect).filter(Boolean).join(" ")}`;
    case "discardHand": return `${who} wirft die ganze Hand ab${effect.drawGreatest ? " und zieht so viele Karten, wie der Spieler mit den meisten abgeworfen hat" : ""}.`;
    case "regenerate": return "Regeneriert: die nächste Zerstörung in diesem Zug wird ersetzt (tappen, Schaden entfernen).";
    case "prevent": return `Verhindert die nächsten ${effect.n} Schaden in diesem Zug.`;
    case "noCombat": return "Verhindert allen Kampfschaden an und von dieser Kreatur in diesem Zug.";
    case "counterTo": return "";
    case "ifCounterThisTurn": return `Wenn in diesem Zug ein Marker auf diese Karte kam: ${effect.effects.map(describeEffect).join(" ")}`;
    case "countersAll": return `${effect.n}× ${effect.kind}-Marker auf jede ${effect.other ? "andere " : ""}eigene Kreatur.`;
    case "digUntil": return "Deckt Karten auf, bis eine Kreatur erscheint; sie kommt auf die Hand, der Rest unter die Bibliothek.";
    case "digRest": return "";
    case "chaosWarp": return "Der Besitzer mischt das Ziel in seine Bibliothek, deckt die oberste Karte auf und legt sie aufs Schlachtfeld, wenn sie ein Permanent ist.";
    case "manaChoice": return `Erzeugt ${effect.options.map(option => option.map(symbol => `{${symbol}}`).join("")).join(" oder ")}.`;
    case "extraLandTurn": return "Du darfst in diesem Zug ein zusätzliches Land spielen.";
    case "rearrange": return `Sieh dir die obersten ${effect.n} Karten an und lege sie in beliebiger Reihenfolge zurück.`;
    case "shuffleLib": return "Mischt die Bibliothek.";
    case "searchUntapIf": return "";
    case "ifXAtLeast": return `Wenn X mindestens ${effect.n} ist: ${effect.effects.map(describeEffect).join(" ")}`;
    case "animate": return "Wird bis zum Zugende zur Kreatur.";
    case "exileSelf": return "Exiliert diese Karte.";
    case "untapSelf": return "Enttappt diese Karte.";
    case "sacrificeSelf": return "Opfert diese Karte.";
    case "energy": return `Du erhältst ${effect.n} Energie.`;
    case "monstrosity": return `Monstrosity ${effect.n}: ${effect.n} +1/+1-Marker, falls noch nicht monströs.`;
    case "proliferate": return "Verbreitet: ein weiterer Marker auf jedem Permanent/Spieler mit Markern.";
    case "monarch": return "Du wirst zum Monarchen.";
    case "lookTop": return `Sieh dir die obersten ${effect.n} Karten an.`;
    case "lookTake": return "Nimm eine passende Karte davon auf die Hand.";
    case "lookRest": return effect.to === "graveyard" ? "Der Rest kommt auf den Friedhof." : "Der Rest kommt in zufälliger Reihenfolge unter die Bibliothek.";
    case "livingWeapon": return "Erzeugt einen 0/0-Germ-Spielstein und hängt sich daran.";
    case "undying": return `Kam die Karte ohne ${effect.kind}-Marker ins Grab, kehrt sie mit einem ${effect.kind}-Marker zurück.`;
    case "melee": return "+1/+1 für jeden Gegner, den du in diesem Kampf angegriffen hast.";
    case "adapt": return `Adapt ${effect.n}: ${effect.n} +1/+1-Marker, falls die Karte keine hat.`;
    case "bounceOwn": return "Du legst ein eigenes Permanent zurück auf die Hand.";
    case "tapOrUntap": return "Tappt oder enttappt das Ziel.";
    case "flicker": return "Das Ziel wird exiliert und kommt sofort zurück.";
    case "moveCounter": return effect.all ? "Verschiebt alle Marker vom ersten auf das zweite Ziel." : "Verschiebt einen Marker vom ersten auf das zweite Ziel.";
    case "grantAll": return `Deine ${effect.what === "permanent" ? "Permanents" : "Kreaturen"} erhalten ${effect.kws.join(", ")} bis zum Zugende.`;
    case "payGate": return `Der Spieler zahlt ${effect.cost}, sonst: ${effect.effects.map(describeEffect).join(" ")}`;
    case "mayPay": return `Du darfst ${effect.cost} zahlen.`;
    case "bite": return "Die eigene Kreatur fügt der Ziel-Kreatur Schaden in Höhe ihrer Stärke zu.";
    case "biteTrample": return "";
    case "fight": return "Beide Kreaturen fügen sich gegenseitig Schaden in Höhe ihrer Stärke zu.";
    case "exileAllGraveyards": return "Schickt alle Friedhöfe ins Exil.";
    case "exileGraveyard": return "Schickt den ganzen Friedhof des Ziel-Spielers ins Exil.";
    case "manaAny": return "Erzeugt ein Mana einer beliebigen Farbe.";
    case "putBack": return `Legt ${effect.n} Karten von der Hand oben auf die Bibliothek.`;
    case "revealHand": return "Der Ziel-Spieler zeigt seine Hand.";
    case "chooseFromRevealed": return "Du wählst eine passende Karte daraus.";
    case "discardChosen": return "Der Spieler wirft diese Karte ab.";
    case "namedToken": return `Erzeugt ${effect.n}× ${effect.name}-Spielstein.`;
    case "attach": return "Hängt diese Karte an die Ziel-Kreatur.";
    case "grantTemp": return `Die Kreatur erhält ${effect.kws.join(", ")} bis zum Zugende.`;
    case "reanimate": return `Holt die Ziel-Karte aus dem Friedhof ${effect.to === "hand" ? "auf die Hand" : "aufs Schlachtfeld"}${effect.counters ? ` (mit ${effect.counters} zusätzlichen +1/+1-Markern)` : ""}.`;
    case "flashbackTokenCounters": return `Kam der Zauber aus dem Friedhof: ${effect.n} zusätzliche +1/+1-Marker auf den Spielstein.`;
    case "reanimateCounters":
    case "noop": return "";
    case "counters":
      if (effect.xFrom?.digMv) return `X ${effect.kind}-Marker auf das Ziel (X = Manawert der aufgedeckten Kreatur).`;
      if (effect.xFrom?.stat) return `X ${effect.kind}-Marker auf das Ziel (X = ${effect.xFrom.stat === "power" ? "Stärke" : "Widerstandskraft"} des Ziels).`;
      return `${effect.n}× ${effect.kind}-Marker ${effect.self ? "auf diese Karte" : "auf das Ziel"}.`;
    case "pump": return `${effect.self ? "Diese Kreatur" : "Das Ziel"} erhält ${signed(effect.p)}/${signed(effect.th)} bis zum Zugende.`;
    case "pumpAll": return `${{ you: "Deine Kreaturen", opp: "Kreaturen deiner Gegner", all: "Alle Kreaturen" }[effect.scope ?? "you"]} erhalten ${signed(effect.p)}/${signed(effect.th)} bis zum Zugende.`;
    case "token": return `Erzeugt ${effect.n}× ${effect.name} ${effect.p}/${effect.th}.`;
    case "search": return `Durchsucht die Bibliothek nach ${effect.what === "card" ? "einer Karte" : `einer Karte (${effect.what})`} und legt sie ${effect.to === "hand" ? "auf die Hand" : `aufs Schlachtfeld${effect.tapped ? " (getappt)" : ""}`}.`;
    case "gyReturn": return `Holt eine Karte (${effect.what}) aus dem Friedhof ${effect.to === "hand" ? "auf die Hand" : "aufs Schlachtfeld"}.`;
    case "mana": return `Erzeugt ${effect.symbols.map(symbol => `{${symbol}}`).join("")}.`;
    default: return "";
  }
}

const KIND_DE = {
  creature: "Kreatur", permanent: "Permanent", artifact: "Artefakt", enchantment: "Verzauberung", land: "Land", planeswalker: "Planeswalker",
  creatureOrPlaneswalker: "Kreatur oder Planeswalker", artifactOrEnchantment: "Artefakt oder Verzauberung", player: "Spieler", opponent: "Gegner",
  any: "beliebiges Ziel (Spieler, Kreatur oder Planeswalker)", myCreature: "eigene Kreatur", playerOrPlaneswalker: "Spieler oder Planeswalker",
  spell: "Zauber", creatureSpell: "Kreaturenzauber", noncreatureSpell: "Nichtkreaturenzauber", instantOrSorcerySpell: "Spontan- oder Hexereizauber",
  gyAny: "Karte aus deinem Friedhof", gyCreature: "Kreaturenkarte aus deinem Friedhof", gyCreatureAny: "Kreaturenkarte aus einem Friedhof",
  gyArtifact: "Artefaktkarte aus deinem Friedhof", gyEnchantment: "Verzauberungskarte aus deinem Friedhof", gyLand: "Landkarte aus deinem Friedhof", gyPermanent: "Permanent-Karte aus deinem Friedhof"
};
const COLOR_DE = { W: "weiß", U: "blau", B: "schwarz", R: "rot", G: "grün" };
const TYPE_DE = { artifact: "Artefakt", land: "Land", creature: "Kreatur", enchantment: "Verzauberung", planeswalker: "Planeswalker" };

/** Zielangabe auf Deutsch: „Kreatur mit Widerstandskraft 4 oder mehr“, „nicht-schwarze Kreatur“, „Permanent eines Gegners“ … */
export function describeSpec(spec) {
  let noun = spec.anyTypes ? spec.anyTypes.map(type => TYPE_DE[type] ?? type).join(", ").replace(/, ([^,]+)$/, " oder $1") : KIND_DE[spec.kind] ?? "Ziel";
  const adjectives = [];
  if (spec.tapped === true) adjectives.push("getappte");
  if (spec.tapped === false) adjectives.push("ungetappte");
  if (spec.attacking) adjectives.push("angreifende");
  if (spec.blocking) adjectives.push("blockende");
  if (spec.legendary === true) adjectives.push("legendäre");
  if (spec.legendary === false) adjectives.push("nicht legendäre");
  for (const color of spec.colors ?? []) adjectives.push(`${COLOR_DE[color]}e`);
  for (const color of spec.nonColors ?? []) adjectives.push(`nicht-${COLOR_DE[color]}e`);
  for (const type of spec.nonTypes ?? []) adjectives.push(`nicht-${(TYPE_DE[type] ?? type).toLowerCase()}`);
  for (const type of spec.types ?? []) adjectives.push(`${(TYPE_DE[type] ?? type).toLowerCase()}-`);
  noun = `${adjectives.join(" ")}${adjectives.length ? " " : ""}${noun}`.replace("- ", "-");
  const tail = [];
  if (spec.stat) tail.push(`mit ${spec.stat.of === "power" ? "Stärke" : "Widerstandskraft"} ${spec.stat.n} oder ${spec.stat.op === "gte" ? "mehr" : "weniger"}`);
  if (spec.keyword) tail.push(`mit ${spec.keyword}`);
  if (spec.ctrl === "opp") tail.push("eines Gegners");
  if (spec.ctrl === "you") tail.push("von dir");
  if (spec.optional) tail.push("(optional)");
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}${tail.length ? ` ${tail.join(" ")}` : ""}`;
}

/** Fasst die Effekte zusammen; nicht verstandene Sätze bleiben im englischen Original stehen. */
export function summarize({ effects, unparsed, specs = [] }) {
  const targets = specs.length > 0 ? [`Ziel${specs.length > 1 ? "e" : ""}: ${specs.map(describeSpec).join("; ")}.`] : [];
  return [...effects.map(describeEffect).filter(Boolean), ...targets, ...unparsed.map(sentence => `${sentence}.`)].join(" ");
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
        // „up to one target …“ / „up to one other target …“: wie „target …“, das Ziel ist aber optional
        const before = specs.length;
        let parsed = parseSentence(part, specs);
        if (!parsed && /\bup to one (?:other )?target\b/i.test(part)) {
          specs.length = before;
          parsed = parseSentence(part.replace(/\bup to one other target\b/i, "another target").replace(/\bup to one target\b/i, "target"), specs);
          if (parsed) for (let i = before; i < specs.length; i += 1) specs[i] = { ...specs[i], optional: true };
          else specs.length = before;
        }
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
    const pieces = sentence.split(/,? then | and /).map(piece => piece.trim()).map((piece, index) => (index > 0 && /^\d+ damage to /i.test(piece) ? `~ deals ${piece}` : piece));
    const split = pieces.length > 1 ? tryParts(pieces) : null;
    if (split) effects.push(...split);
    else unparsed.push(sentence);
  }
  return { effects, specs, unparsed, summary: summarize({ effects, unparsed, specs }) };
}

const BASIC_TYPES = ["plains", "island", "swamp", "mountain", "forest"];
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** „a Forest or an Island“ → ["forest", "island"] (nur Standard-Landtypen, sonst `null`). */
function basicTypes(text) {
  const words = text
    .toLowerCase()
    .split(/,| or /)
    .map(part => part.replace(/^\s*(an?|the)\s+/, "").trim())
    .filter(Boolean);
  return words.length > 0 && words.every(word => BASIC_TYPES.includes(word)) ? words : null;
}

/** Bedingung von „enters tapped unless …“ (`null`, wenn nicht unterstützt). */
function parseEntryCondition(text) {
  const lower = text.toLowerCase().trim();
  let m;
  if ((m = lower.match(/^you control (one|two|three|four|five|\d+) or (more|fewer) (other lands|basic lands)$/))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]];
    return { kind: "lands", n, op: m[2] === "more" ? "gte" : "lte", basic: m[3] === "basic lands" };
  }
  if ((m = lower.match(/^a player has (\d+) or less life$/))) return { kind: "lowLife", n: Number(m[1]) };
  if ((m = lower.match(/^you have (\d+|one|two|three|four) or more opponents$/))) return { kind: "oppCount", n: /^\d+$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]] };
  if ((m = lower.match(/^your opponents control (\d+|one|two|three|four|five|six|seven|eight|nine|ten) or more lands$/))) return { kind: "oppLands", n: /^\d+$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]] ?? 7 };
  if ((m = lower.match(/^it's your ((?:first|second|third|fourth|fifth)(?:,? (?:or )?(?:first|second|third|fourth|fifth))*) turn(?: of the game)?$/))) {
    const ordinals = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
    const found = [...m[1].matchAll(/first|second|third|fourth|fifth/g)].map(item => ordinals[item[0]]);
    return { kind: "turn", n: Math.max(...found) };
  }
  if ((m = lower.match(/^you control (.+)$/))) {
    const types = basicTypes(m[1]);
    if (types) return { kind: "types", types };
    const other = m[1].match(/^an? (legendary )?([a-z]+)$/);
    if (other) return { kind: "controls", legendary: Boolean(other[1]), type: other[2] };
  }
  return null;
}

/** Bedingung eines Auslösers → Ereignis (`null`, wenn nicht unterstützt). */
function triggerEvent(word, condition) {
  let m;
  if (/^~ enters( the battlefield)?$/.test(condition)) return { event: "etb" };
  if (/^(equipped|enchanted) creature attacks$/.test(condition)) return { event: "attachedAttacks" };
  if (condition === "you cycle a card" || condition === "you cycle another card") return { event: "youCycle", scope: { owner: "you", another: false } };
  if (/^you (?:cycle or discard|discard or cycle|discard) (?:a|another) card$/.test(condition)) return { event: "youDiscard", scope: { owner: "you", another: false } };
  if (condition === "you cycle ~" || condition === "you cycle this card") return { event: "cycled" };
  if (/^~ is dealt damage$/.test(condition)) return { event: "dealtDamage" };
  if (condition === "you attack" || condition === "you attack a player") return { event: "youAttack", scope: { owner: "you", another: false } };
  if ((m = condition.match(/^you attack with (two|three|four|five|six|seven|eight|\d+) or more creatures$/))) {
    return { event: "youAttack", minAttackers: /^\d+$/.test(m[1]) ? Number(m[1]) : { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 }[m[1]], scope: { owner: "you", another: false } };
  }
  if (/^you put one or more counters on a creature$/.test(condition)) return { event: "countersPut", scope: { owner: "you", another: false } };
  if (/^you put one or more counters on a creature you don't control$/.test(condition)) return { event: "countersPut", scope: { owner: "opp", another: false } };
  if ((m = condition.match(/^you put one or more ([+-]1\/[+-]1) counters on a creature$/))) return { event: "countersPut", counterKind: m[1], scope: { owner: "you", another: false } };
  if (/^(?:a|one or more) \+1\/\+1 counters? (?:is|are) put on ~$/.test(condition)) return { event: "selfCounter" };
  if ((m = condition.match(/^(?:a|an) creature you control with an? ([+-]1\/[+-]1) counter on it deals combat damage to a player$/))) return { event: "creatureDealsCombatDamage", scope: { owner: "you", another: false, counter: m[1] } };
  if ((m = condition.match(/^one or more (artifact creatures|[a-z]+) you control deal (?:combat )?damage to (?:a player|one or more players|your opponents|one or more of your opponents)$/)) && m[1] !== "creatures") {
    return { event: "creaturesDealDamage", scope: { owner: "you", another: false, creatureType: m[1] === "artifact creatures" ? "artifact" : m[1].replace(/s$/, "") } };
  }
  if (/^one or more creatures you control with counters on them deal combat damage to a player$/.test(condition)) return { event: "creaturesDealDamage", scope: { owner: "you", another: false, counter: "any" } };
  if ((m = condition.match(/^one or more creatures you control with power (\d+) or greater deal combat damage to a player$/))) return { event: "creaturesDealDamage", scope: { owner: "you", another: false, minPower: Number(m[1]) } };
  if (word === "At" && condition === "the beginning of each player's draw step") return { event: "drawStep", scope: { owner: "any", another: false } };
  if ((m = condition.match(/^an? (equipment|aura|artifact|enchantment|nontoken artifact|vehicle) you control enters( the battlefield)?$/))) {
    return { event: "permanentEnters", scope: { owner: "you", another: false, permType: m[1].replace("nontoken ", ""), ...(/nontoken/.test(m[1]) ? { nontoken: true } : {}) } };
  }
  if ((m = condition.match(/^(another|a) ([a-z]+) or ([a-z]+) you control enters( the battlefield)?$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: m[1] === "another", anyOf: [m[2], m[3]] } };
  }
  if ((m = condition.match(/^~ or another ([a-z]+) or ([a-z]+) you control enters( the battlefield)?$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: false, anyOf: [m[1], m[2]] } };
  }
  if (word === "At" && condition === "the beginning of each end step") return { event: "endStep", scope: { owner: "any", another: false } };
  if (/^a creature you control attacks$/.test(condition)) return { event: "creatureAttacks", scope: { owner: "you", another: false } };
  if (/^(?:another )?creature you control attacks$/.test(condition)) return { event: "creatureAttacks", scope: { owner: "you", another: true } };
  if (/^your commander attacks$/.test(condition)) return { event: "creatureAttacks", scope: { owner: "you", another: false, commander: true } };
  if (/^one or more other creatures die$/.test(condition)) return { event: "creatureDies", scope: { owner: "any", another: true } };
  if (/^an opponent casts a creature spell$/.test(condition)) return { event: "castCreature", scope: { owner: "opp", another: false } };
  if (/^~ deals combat damage to a player or planeswalker$/.test(condition)) return { event: "dealsCombatDamage" };
  if (/^a legendary creature you control enters( the battlefield)?$/.test(condition)) return { event: "creatureEnters", scope: { owner: "you", another: false, legendary: true } };
  if (/^~ mutates$/.test(condition)) return { event: "mutates" };
  if (/^~ dies$/.test(condition) || /^~ is put into a graveyard from the battlefield$/.test(condition)) return { event: "dies" };
  if ((m = condition.match(/^~ or another (nontoken )?creature you control dies$/))) return { event: "creatureDies", scope: { owner: "you", another: false, ...(m[1] ? { nontoken: true } : {}) } };
  if (/^~ or another creature dies$/.test(condition)) return { event: "creatureDies", scope: { owner: "any", another: false } };
  if (/^equipped creature dies$/.test(condition)) return { event: "equippedDies" };
  if (/^~ deals combat damage to a player$/.test(condition)) return { event: "dealsCombatDamage" };
  if (/^equipped creature deals combat damage to a player$/.test(condition)) return { event: "equippedDealsCombatDamage" };
  if (word === "At" && /^the beginning of combat on your turn$/.test(condition)) return { event: "beginCombat", scope: { owner: "you", another: false } };
  if (/^you gain life$/.test(condition)) return { event: "youGainLife", scope: { owner: "you", another: false } };
  if (/^you draw a card$/.test(condition)) return { event: "youDraw", scope: { owner: "you", another: false } };
  if (/^an opponent draws a card$/.test(condition)) return { event: "oppDraw", scope: { owner: "opp", another: false } };
  if ((m = condition.match(/^(another|a) creature you control with power (\d+) or greater enters( the battlefield)?$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: m[1] === "another", minPower: Number(m[2]) } };
  }
  if ((m = condition.match(/^another creature with power (\d+) or less enters( the battlefield)? under your control$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: true, maxPower: Number(m[1]) } };
  }
  if ((m = condition.match(/^(another|a) ([a-z]+) you control dies$/)) && !["creature", "nontoken"].includes(m[2])) {
    return { event: "creatureDies", scope: { owner: "you", another: m[1] === "another", subtype: m[2] } };
  }
  if ((m = condition.match(/^another ([a-z]+) you control enters( the battlefield)?$/)) && !["creature", "nontoken"].includes(m[1])) {
    return { event: "creatureEnters", scope: { owner: "you", another: true, subtype: m[1] } };
  }
  if (/^a creature you control deals combat damage to a player$/.test(condition)) return { event: "creatureDealsCombatDamage", scope: { owner: "you", another: false } };
  if (/^another creature enters( the battlefield)?$/.test(condition)) return { event: "creatureEnters", scope: { owner: "any", another: true } };
  if (/^~ attacks$/.test(condition)) return { event: "attacks" };
  if (/^~ blocks$/.test(condition)) return { event: "blocks" };
  if ((m = condition.match(/^(another|a) creature (you control|an opponent controls) dies$/))) {
    return { event: "creatureDies", scope: { owner: m[2] === "you control" ? "you" : "opp", another: m[1] === "another" } };
  }
  if ((m = condition.match(/^(another|a) creature dies$/))) return { event: "creatureDies", scope: { owner: "any", another: m[1] === "another" } };
  if ((m = condition.match(/^(another|a) creature enters( the battlefield)? under your control$/))) {
    return { event: "creatureEnters", scope: { owner: "you", another: m[1] === "another" } };
  }
  if (/^a land (enters( the battlefield)? under your control|you control enters( the battlefield)?)$/.test(condition)) return { event: "landEnters", scope: { owner: "you", another: false } };
  if (/^a land (an opponent controls enters( the battlefield)?|enters( the battlefield)? under an opponent's control)$/.test(condition)) return { event: "landEnters", scope: { owner: "opp", another: false } };
  if ((m = condition.match(/^(another|a) (nontoken )?creature (you control|an opponent controls) (enters|dies)( the battlefield)?$/))) {
    return { event: m[4] === "dies" ? "creatureDies" : "creatureEnters", scope: { owner: m[3] === "you control" ? "you" : "opp", another: m[1] === "another", ...(m[2] ? { nontoken: true } : {}) } };
  }
  if (/^one or more creatures you control deal combat damage to a player$/.test(condition)) return { event: "creaturesDealDamage", scope: { owner: "you", another: false } };
  if (/^you cast your second spell each turn$/.test(condition)) return { event: "castSecond", scope: { owner: "you", another: false } };
  if (/^you draw your second card each turn$/.test(condition)) return { event: "youDrawSecond", scope: { owner: "you", another: false } };
  if (condition === "you cast or copy an instant or sorcery spell") return { event: "castKind", kinds: ["instant", "sorcery"], scope: { owner: "you", another: false } };
  if ((m = condition.match(/^(you cast|an opponent casts) an? (instant or sorcery|artifact|enchantment|instant|sorcery|planeswalker|historic|legendary|multicolored|nonland) spell$/))) {
    const kinds = { "instant or sorcery": ["instant", "sorcery"], historic: ["artifact", "legendary"], nonland: ["creature", "artifact", "enchantment", "instant", "sorcery", "planeswalker"] }[m[2]] ?? [m[2]];
    if (m[2] !== "multicolored") return { event: "castKind", kinds, scope: { owner: m[1] === "you cast" ? "you" : "opp", another: false } };
  }
  if (/^you cast a creature spell of the chosen type$/.test(condition)) return { event: "castCreature", chosenType: true, scope: { owner: "you", another: false } };
  if (/^you cast a creature spell$/.test(condition)) return { event: "castCreature", scope: { owner: "you", another: false } };
  if (/^you cast a spell$/.test(condition)) return { event: "castSpell", scope: { owner: "you", another: false } };
  if (/^an opponent casts a spell$/.test(condition)) return { event: "castSpell", scope: { owner: "opp", another: false } };
  if (/^an opponent casts a noncreature spell$/.test(condition)) return { event: "castNoncreature", scope: { owner: "opp", another: false } };
  if (/^you cast a noncreature spell$/.test(condition)) return { event: "castNoncreature", scope: { owner: "you", another: false } };
  if (word === "At" && /^the beginning of each upkeep$/.test(condition)) return { event: "upkeep", scope: { owner: "any", another: false } };
  if (word === "At" && condition === "the beginning of your upkeep") return { event: "upkeep", scope: { owner: "you", another: false } };
  if (word === "At" && condition === "the beginning of your end step") return { event: "endStep", scope: { owner: "you", another: false } };
  return null;
}

const stripPrefix = line => line.replace(/^[•*]\s*/, "").replace(/^[A-Z][^—.:]{0,60}[!.]?\s*[—-]\s*(?=(?:When|Whenever|At|Equip)\b)/, "");

/**
 * Zerlegt den Text einer Karte in Zauber-Effekt, Auslöser, aktivierte Fähigkeiten und nicht automatisch behandelbare Hinweise.
 * @returns {{ spell: object|null, triggers: object[], activated: object[], notes: string[] }}
 */
export function parseCardText({ name, typeLine, oracleText }) {
  const types = typesOf(typeLine);
  let rawLines = normalizeText(oracleText, name);
  // Raumschiffe: Zeilen „N+ | …“ gehören zu Ladungsstufen; sie werden getrennt ausgewertet und mit Schwelle versehen.
  const tiers = [];
  let stationAt = null;
  if (rawLines.some(line => /^station$/i.test(line))) {
    const keep = [];
    let current = null;
    for (const line of rawLines) {
      const tier = line.match(/^(\d+)\+ \| (.*)$/);
      if (tier) {
        current = { n: Number(tier[1]), lines: [tier[2]] };
        tiers.push(current);
      } else if (current) current.lines.push(line);
      else keep.push(line);
    }
    rawLines = keep;
    stationAt = Number(/artifact creature at (\d+)\+/i.exec(String(oracleText))?.[1]) || (tiers.length > 0 ? tiers[tiers.length - 1].n : null);
  }
  // Modale Auslöser: „When ~ enters, choose one —“ mit Aufzählung (• …); ohne Aufzählung bleibt die Zeile unverändert.
  const modalTriggers = [];
  if (!/Instant|Sorcery/.test(typeLine ?? "")) {
    const keep = [];
    for (let i = 0; i < rawLines.length; i += 1) {
      // Aktivierte Fähigkeit mit Modi („{T}: Choose one — • A • B“): je Modus eine eigene Fähigkeit mit denselben Kosten
      const costHeader = rawLines[i].match(/^([^:]+): choose one\s*[\u2014-]\s*$/i);
      if (costHeader && !/^(when|whenever|at) /i.test(rawLines[i])) {
        const modeLines = [];
        while (i + 1 < rawLines.length && /^[•*]\s*/.test(rawLines[i + 1])) modeLines.push(rawLines[(i += 1)].replace(/^[•*]\s*/, ""));
        if (modeLines.length >= 2) {
          for (const mode of modeLines) keep.push(`${costHeader[1]}: ${mode}`);
          continue;
        }
        i -= modeLines.length;
      }
      const header = rawLines[i].match(/^(When|Whenever|At) (.+), choose one\s*[\u2014-]\s*$/i);
      if (header) {
        const modes = [];
        while (i + 1 < rawLines.length && /^[•*]\s*/.test(rawLines[i + 1])) modes.push(rawLines[(i += 1)].replace(/^[•*]\s*/, ""));
        if (modes.length >= 2) {
          modalTriggers.push({ word: header[1], condition: header[2].toLowerCase(), modes, line: rawLines[i - modes.length] });
          continue;
        }
        i -= modes.length;
      }
      keep.push(rawLines[i]);
    }
    rawLines = keep;
  }
  const result = { spell: null, triggers: [], activated: [], notes: [], statics: [], flashback: null, cycling: null, entersTapped: false, entersTappedUnless: null, shock: null, reveal: null };

  // Cycling (Abwerfen aus der Hand gegen Mana: eine Karte ziehen oder nach Land suchen)
  for (const line of rawLines) {
    const cycling = line.match(/^(basic land|land|plains|island|swamp|mountain|forest)?cycling (\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (cycling) result.cycling = { cost: cycling[2], search: cycling[1] ? cycling[1].toLowerCase() : null };
  }
  const lines = rawLines.filter(line => !/^(basic land|land|plains|island|swamp|mountain|forest)?cycling \{/i.test(line)).map(stripPrefix);

  if (types.instant || types.sorcery) {
    // Modale Zauber: „Choose one —“ mit Aufzählung; der Spieler wählt beim Wirken einen Modus.
    const modeLines = rawLines.filter(line => /^[•*]\s*/.test(line)).map(line => line.replace(/^[•*]\s*/, ""));
    if (rawLines.some(line => /^choose one(?:\s*[—-]|\.)/i.test(line)) && modeLines.length >= 2) {
      const modes = modeLines.map(text => ({ label: text, ...parseEffectText(text) }));
      result.spell = { effects: [], specs: [], unparsed: [], modes };
      return result;
    }
    const body = [];
    for (const line of lines) {
      if (isKeywordLine(line)) continue;
      const reduce = line.match(/^~ costs \{(\d+)\} less to cast for each (creature|land|artifact) on the battlefield\.?$/i);
      if (reduce) {
        result.costReduction = { amount: Number(reduce[1]), per: reduce[2].toLowerCase() };
        continue;
      }
      if (/^convoke$/i.test(line)) {
        result.convoke = true;
        continue;
      }
      if (/^~ can't be countered\.?$/i.test(line)) {
        result.uncounterable = true;
        continue;
      }
      const spellMadness = line.match(/^madness\s*[\u2014-]?\s*(\{[^}]+\}(?:\{[^}]+\})*)\.?$/i);
      if (spellMadness) {
        result.madness = { cost: spellMadness[1].replace(/\{X\}/gi, ""), life: 0, hasX: /\{X\}/i.test(spellMadness[1]) };
        continue;
      }
      if (/^storm$/i.test(line)) {
        result.storm = true;
        continue;
      }
      if (/^if you control a commander, you may cast ~ without paying its mana cost\.?$/i.test(line)) {
        result.freeWithCommander = true;
        continue;
      }
      if (/^delve$/i.test(line)) {
        result.delve = true;
        continue;
      }
      const affinity = line.match(/^affinity for ([a-z]+)$/i);
      if (affinity) {
        result.costReduction = { amount: 1, per: affinity[1].toLowerCase().replace(/s$/, ""), mine: true };
        continue;
      }
      const foretell = line.match(/^foretell (\{[^}]+\}(?:\{[^}]+\})*)$/i);
      if (foretell) {
        result.foretell = foretell[1];
        continue;
      }
      const additional = line.match(/^as an additional cost to cast ~, (sacrifice|discard) (a|an|one|two|three) (creature|artifact|land|enchantment|nonland permanent|permanent|card)s?\.?$/i);
      if (additional) {
        const kind = additional[1].toLowerCase();
        const what = additional[3].toLowerCase() === "nonland permanent" ? "nonland" : additional[3].toLowerCase();
        result.additionalCost = [{ kind, n: COUNT_WORD[additional[2].toLowerCase()] ?? 1, ...(kind === "sacrifice" ? { what } : {}) }];
        continue;
      }
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
    // Schutz („Protection from red and from white“) – nur Farben werden automatisch beachtet.
    const protection = line.match(/^protection from ([a-z, ]+)$/i);
    if (protection) {
      const names = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
      const words = protection[1].toLowerCase().split(/,| and from | and |from /).map(word => word.trim()).filter(Boolean);
      const colors = words.map(word => names[word]).filter(Boolean);
      if (colors.length > 0 && colors.length === words.length) result.protection = [...new Set([...(result.protection ?? []), ...colors])];
      else result.notes.push(line);
      continue;
    }
    // Ward: zusätzliche Mana-Kosten, wenn ein Gegner die Karte als Ziel wählt.
    const ward = line.match(/^ward (\{[^}]+\}(?:\{[^}]+\})*|\d+)$/i);
    if (ward) {
      result.ward = /^\d+$/.test(ward[1]) ? `{${ward[1]}}` : ward[1];
      continue;
    }
    const chooseColor = line.match(/^as ~ enters( the battlefield)?, choose a color(?: other than ([a-z]+))?\.?$/i);
    if (chooseColor) {
      result.chooseColor = { except: chooseColor[2] ? COLOR_LETTERS[chooseColor[2].toLowerCase()] ?? null : null };
      continue;
    }
    // Gefärbte Boni („White creatures get +1/+1“), Typ-Boni („Other artifact creatures you control get +1/+1“), Angriffssteuer, dynamische Werte
    const coloredAnthem = line.match(/^(white|blue|black|red|green) creatures (you control )?get ([+-]\d+)\/([+-]\d+)\.?$/i);
    if (coloredAnthem) {
      result.statics.push({ scope: coloredAnthem[2] ? "you" : "all", colors: [COLOR_LETTERS[coloredAnthem[1].toLowerCase()]], p: Number(coloredAnthem[3]), th: Number(coloredAnthem[4]), grants: [] });
      continue;
    }
    const tax = line.match(/^creatures can't attack you unless their controller pays \{(\d+)\} for each creature they control that's attacking you\.?$/i);
    if (tax) {
      result.attackTax = Number(tax[1]);
      continue;
    }
    const dynamic = line.match(/^~'s power and toughness are each equal to (twice )?the number of (other )?(artifacts|creatures|lands|creature cards|cards) (you control|in your graveyard|in your hand)\.?$/i);
    if (dynamic) {
      const kind = dynamic[3].toLowerCase().replace(/s$/, "");
      const where = dynamic[4].toLowerCase();
      result.dynamicPT = { per: `${dynamic[2] ? "other " : ""}${kind} ${where}`.replace(/^other (card|creature card) in/, "$1 in"), mult: dynamic[1] ? 2 : 1 };
      continue;
    }
    if (/^if you control a commander, you may cast ~ without paying its mana cost\.?$/i.test(line)) {
      result.freeWithCommander = true;
      continue;
    }
    const unblockable = line.match(/^equipped creature can't be blocked(?: and has ([a-z, ]+))?\.?$/i);
    if (unblockable) {
      const grants = ["unblockable", ...(unblockable[1] ?? "").split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word))];
      result.attach = { p: result.attach?.p ?? 0, th: result.attach?.th ?? 0, grants: [...(result.attach?.grants ?? []), ...grants] };
      continue;
    }
    const typedKw = line.match(/^(other )?(artifact|historic|legendary|[a-z]+s and [a-z]+s|[a-z]+) creatures you control have ([a-z, ]+?)(?:,? and ward \{\d+\})?\.?$/i) ?? line.match(/^(other )?([A-Za-z]+s and [A-Za-z]+s|[A-Z][a-z]+s) you control have ([a-z, ]+?)\.?$/);
    if (typedKw && !/^creatures?$/i.test(typedKw[2])) {
      const grants = typedKw[3].split(/,| and /).map(word => word.trim().toLowerCase()).filter(Boolean);
      if (grants.length > 0 && grants.every(word => KEYWORDS.includes(word))) {
        const word = typedKw[2].toLowerCase();
        const anyOf = word === "historic" ? ["artifact", "legendary"] : word.includes(" and ") ? word.split(" and ").map(item => item.replace(/s$/, "")) : [word.replace(/s$/, "")];
        result.statics.push({ scope: typedKw[1] ? "youOther" : "you", anyOf, p: 0, th: 0, grants });
        continue;
      }
    }
    const grantedTrigger = line.match(/^(artifact creatures|creatures|[a-z]+s) you control have "(.+)"\.?$/i);
    if (grantedTrigger) {
      const sub = parseCardText({ name: "~", typeLine: "Creature", oracleText: grantedTrigger[2].replace(/\bthis creature\b/gi, "~") });
      if (sub.triggers.length > 0 && sub.notes.length === 0 && sub.triggers.every(trigger => trigger.unparsed.length === 0)) {
        const word = grantedTrigger[1].toLowerCase();
        result.grantedTriggers = [...(result.grantedTriggers ?? []), ...sub.triggers.map(trigger => ({ what: word === "artifact creatures" ? "artifact" : word === "creatures" ? "creature" : word.replace(/s$/, ""), trigger }))];
        continue;
      }
    }
    const haveKw = line.match(/^(other )?creatures you control have ([a-z, ]+)\.?$/i);
    if (haveKw) {
      const grants = haveKw[2].split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word));
      if (grants.length > 0) {
        result.statics.push({ scope: haveKw[1] ? "youOther" : "you", p: 0, th: 0, grants });
        continue;
      }
    }
    const costModPair = line.match(/^([A-Z][a-z]+) spells and ([A-Z][a-z]+) spells you cast cost \{(\d+)\} less to cast\.?$/);
    if (costModPair) {
      result.costMod = { amount: Number(costModPair[3]), what: costModPair[1].toLowerCase(), anyOf: [costModPair[1].toLowerCase(), costModPair[2].toLowerCase()] };
      continue;
    }
    const costMod = line.match(/^(creature|artifact|enchantment|noncreature|instant and sorcery|instant|sorcery|[A-Z][a-z]+) spells you cast cost \{(\d+)\} less to cast\.?$/i);
    if (costMod) {
      result.costMod = { amount: Number(costMod[2]), what: costMod[1].toLowerCase() };
      continue;
    }
    if (/^lands you control have "\{t\}: add one mana of any color\."$/i.test(line)) {
      result.landsAnyColor = true;
      continue;
    }
    const manaCond = line.match(/^\{T\}: Add .+\. Activate only if you control (an artifact|a creature with power 4 or greater)\.?$/i);
    if (manaCond) {
      result.manaCond = manaCond[1].startsWith("an artifact") ? { type: "artifact" } : { type: "bigCreature" };
      continue;
    }
    const entersCounters = line.match(/^~ enters with (a|an|one|two|three|four|five|\d+) ([a-z]+|[+-]1\/[+-]1) counters? on it\.?$/i);
    if (entersCounters) {
      result.entersWithCounters = { n: /^\d+$/.test(entersCounters[1]) ? Number(entersCounters[1]) : (COUNT_WORD[entersCounters[1].toLowerCase()] ?? { four: 4, five: 5 }[entersCounters[1].toLowerCase()]), kind: entersCounters[2].toLowerCase() };
      continue;
    }
    const chargeEnters = line.match(/^~ enters tapped with (one|two|three|\d+) charge counters? on it\.?$/i);
    if (chargeEnters) {
      result.entersTapped = true;
      result.entersWithCounters = { n: /^\d+$/.test(chargeEnters[1]) ? Number(chargeEnters[1]) : COUNT_WORD[chargeEnters[1].toLowerCase()], kind: "charge" };
      continue;
    }
    // Reine Deckbau-Hinweise ohne Spielwirkung
    if (/^(partner|you may look at the top card of your library any time|partner\s*[—-]\s*.+|partner with .+|doctor's companion|friends forever|choose a background|~ can be your commander|ascend|companion .+)\.?$/i.test(line)) {
      result.inert = [...(result.inert ?? []), line];
      continue;
    }
    if (/^changeling$/i.test(line)) {
      result.changeling = true;
      continue;
    }
    if (/^devoid$/i.test(line)) {
      result.devoid = true;
      continue;
    }
    if (/^~ can't be countered\.?$/i.test(line)) {
      result.uncounterable = true;
      continue;
    }
    if (/^~ can't be blocked\.?$/i.test(line)) {
      result.selfGrants = [...(result.selfGrants ?? []), "unblockable"];
      continue;
    }
    if (/^~ attacks each (?:combat|turn) if able\.?$/i.test(line)) {
      result.selfGrants = [...(result.selfGrants ?? []), "must-attack"];
      continue;
    }
    const withCounters = line.match(/^~ enters with (\d+|x|an?|one|two|three) ([+-]1\/[+-]1) counters? on it\.?$/i);
    if (withCounters) {
      const raw = withCounters[1].toLowerCase();
      result.entersWithCounters = { n: /^\d+$/.test(raw) ? Number(raw) : raw === "x" ? "X" : COUNT_WORD[raw] ?? 1, kind: withCounters[2] };
      continue;
    }
    if (/^you may play an additional land on each of your turns\.?$/i.test(line)) {
      result.extraLand = 1;
      continue;
    }
    if (/^evolve$/i.test(line)) {
      result.triggers.push({ event: "creatureEnters", scope: { owner: "you", another: true }, cond: "evolve", text: "Evolve", effects: [{ type: "counters", n: 1, kind: "+1/+1", self: true }], specs: [], unparsed: [], summary: "Evolve: +1/+1-Marker, wenn die neue Kreatur größer ist." });
      continue;
    }
    if (/^living weapon$/i.test(line)) {
      result.triggers.push({ event: "etb", text: "Living weapon", effects: [{ type: "livingWeapon" }], specs: [], unparsed: [], summary: "Erzeugt einen 0/0-Germ-Spielstein und hängt sich daran." });
      continue;
    }
    if (/^convoke$/i.test(line)) {
      result.convoke = true;
      continue;
    }
    const toxic = line.match(/^toxic (\d+)$/i);
    if (toxic) {
      result.toxic = Number(toxic[1]);
      continue;
    }
    if (/^undying$/i.test(line)) {
      result.triggers.push({ event: "dies", text: "Undying", effects: [{ type: "undying", kind: "+1/+1" }], specs: [], unparsed: [], summary: "Kam ohne +1/+1-Marker ins Grab: kehrt mit einem +1/+1-Marker zurück." });
      continue;
    }
    if (/^persist$/i.test(line)) {
      result.triggers.push({ event: "dies", text: "Persist", effects: [{ type: "undying", kind: "-1/-1" }], specs: [], unparsed: [], summary: "Kam ohne −1/−1-Marker ins Grab: kehrt mit einem −1/−1-Marker zurück." });
      continue;
    }
    if (/^melee$/i.test(line)) {
      result.triggers.push({ event: "attacks", text: "Melee", effects: [{ type: "melee" }], specs: [], unparsed: [], summary: "Melee: +1/+1 für jeden angegriffenen Gegner." });
      continue;
    }
    if (/^delve$/i.test(line)) {
      result.delve = true;
      continue;
    }
    if (/^convoke$/i.test(line)) {
      result.convoke = true;
      continue;
    }
    const creatureAffinity = line.match(/^affinity for ([a-z]+)$/i);
    if (creatureAffinity) {
      const word = creatureAffinity[1].toLowerCase().replace(/s$/, "");
      result.costReduction = { amount: 1, per: word, mine: true };
      continue;
    }
    const powerEvasion = line.match(/^~ can't be blocked by creatures with power (\d+) or less\.?$/i);
    if (powerEvasion) {
      result.blockMinPower = Number(powerEvasion[1]) + 1;
      continue;
    }
    if (/^unearth (\{[^}]+\}(?:\{[^}]+\})*)$/i.test(line)) {
      const cost = line.match(/(\{[^}]+\}(?:\{[^}]+\})*)/)[1];
      result.activated.push({ index: result.activated.length, text: line, zone: "graveyard", cost: { tap: false, sacrifice: false, mana: cost }, sorcery: true, effects: [{ type: "unearth" }], specs: [], unparsed: [], summary: "Unearth: kehrt mit Eile zurück, wird am Zugende ins Exil geschickt." });
      continue;
    }
    if (/^~ can't be blocked by creatures with greater power\.?$/i.test(line)) {
      result.selfGrants = [...(result.selfGrants ?? []), "skulk"];
      continue;
    }
    if (/^creatures your opponents control enter tapped\.?$/i.test(line)) {
      result.oppEnterTapped = true;
      continue;
    }
    if (/^you may play lands from your graveyard\.?$/i.test(line)) {
      result.landsFromGraveyard = true;
      continue;
    }
    if (/^your opponents can't cast spells during your turn\.?$/i.test(line)) {
      result.noOppCastOnMyTurn = true;
      continue;
    }
    if (/^for mirrodin!$/i.test(line)) {
      result.triggers.push({ event: "etb", text: line, effects: [{ type: "jobSelect", token: "Rebel" }], specs: [], unparsed: [], summary: "For Mirrodin!: Erzeuge einen roten 2/2-Rebellen und hänge diese Ausrüstung an." });
      continue;
    }
    if (/^play with the top card of your library revealed\.?$/i.test(line)) {
      result.inert = [...(result.inert ?? []), line];
      continue;
    }
    if (/^creatures your opponents control attack each combat if able\.?$/i.test(line)) {
      result.statics.push({ scope: "opp", p: 0, th: 0, grants: ["must-attack"] });
      continue;
    }
    if (/^if one or more \+1\/\+1 counters would be put on a creature you control, that many plus one \+1\/\+1 counters are put on it instead\.?$/i.test(line)) {
      result.counterBonus = 1;
      continue;
    }
    const etbBonus = line.match(/^each other (nontoken )?creature you control enters with an additional ([+-]1\/[+-]1|[a-z ]+) counter on it\.?$/i);
    if (etbBonus) {
      result.etbBonus = { kind: etbBonus[2].toLowerCase(), nontoken: Boolean(etbBonus[1]) };
      continue;
    }
    const counterBan = line.match(/^creatures your opponents control with counters on them can't (attack or block|attack|block)\.?$/i);
    if (counterBan) {
      result.statics.push({ scope: "opp", counter: "any", p: 0, th: 0, grants: counterBan[1] === "attack or block" ? ["cant-attack", "cant-block"] : [`cant-${counterBan[1].toLowerCase()}`] });
      continue;
    }
    const counterStatic = line.match(/^each creature you control with an? ([+-]1\/[+-]1) counter on it has ([a-z, ]+?)\.?$/i);
    if (counterStatic) {
      const grants = counterStatic[2].split(/,\s*(?:and )?|\s+and\s+/).map(part => part.trim().toLowerCase());
      if (grants.every(part => KEYWORDS.includes(part))) {
        result.statics.push({ scope: "you", counter: counterStatic[1], p: 0, th: 0, grants });
        continue;
      }
    }
    const attachPer = line.match(/^(?:equipped|enchanted) creature gets ([+-]\d+)\/([+-]\d+) for each (artifact|creature|land|enchantment) you control\.?$/i);
    if (attachPer) {
      result.attachPer = { p: Number(attachPer[1]), th: Number(attachPer[2]), per: `${attachPer[3].toLowerCase()} you control` };
      continue;
    }
    const ownPower = line.match(/^~'s power is equal to the number of (artifacts|creatures|lands) you control\.?$/i);
    if (ownPower) {
      result.dynamicPT = { per: `${ownPower[1].toLowerCase().replace(/s$/, "")} you control`, mult: 1, powerOnly: true };
      continue;
    }
    const oppPower = line.match(/^~'s power is equal to the number of (artifacts|creatures|lands) your opponents control\.?$/i);
    if (oppPower) {
      result.dynamicPT = { per: `${oppPower[1].toLowerCase().replace(/s$/, "")} your opponents control`, mult: 1, powerOnly: true };
      continue;
    }
    const powerOnly = line.match(/^~'s power is equal to the number of ([a-z]+) cards in your graveyard\.?$/i);
    if (powerOnly) {
      result.dynamicPT = { per: `${powerOnly[1].toLowerCase()} card in your graveyard`, mult: 1, powerOnly: true };
      continue;
    }
    const chapter = line.match(/^((?:I|II|III|IV|V|VI)(?:, (?:I|II|III|IV|V|VI))*) \u2014 (?:[^\u2014.:]{1,40} \u2014 )?(.+)$/);
    if (chapter && /Saga/.test(typeLine ?? "")) {
      const roman = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
      const numbers = chapter[1].split(", ").map(item => roman[item]);
      const parsed = parseEffectText(chapter[2]);
      result.saga = result.saga ?? { max: 0 };
      result.saga.max = Math.max(result.saga.max, ...numbers);
      for (const number of numbers) result.triggers.push({ event: "chapter", chapter: number, text: line, ...parsed });
      continue;
    }
    if (/^job select$/i.test(line)) {
      result.triggers.push({ event: "etb", text: line, effects: [{ type: "jobSelect" }], specs: [], unparsed: [], summary: "Job select: Erzeuge einen 1/1-Hero-Spielstein und hänge diese Ausrüstung an." });
      continue;
    }
    const madness = line.match(/^madness\s*[\u2014-]?\s*(\{[^}]+\}(?:\{[^}]+\})*)(?:,\s*pay (\d+) life)?\.?$/i);
    if (madness) {
      result.madness = { cost: madness[1], life: madness[2] ? Number(madness[2]) : 0 };
      continue;
    }
    const hideaway = line.match(/^hideaway (\d+)$/i);
    if (hideaway) {
      result.triggers.push({ event: "etb", text: line, effects: [{ type: "hideaway", n: Number(hideaway[1]) }], specs: [], unparsed: [], summary: `Hideaway ${hideaway[1]}: Sieh dir die obersten ${hideaway[1]} Karten an, lege eine verdeckt ins Exil, den Rest nach unten.` });
      continue;
    }
    const support = line.match(/^support (\d+)$/i);
    if (support && /Creature/.test(typeLine ?? "")) {
      const parsedSupport = parseEffectText(`put a +1/+1 counter on each of up to ${{ 1: "one", 2: "two", 3: "three" }[Number(support[1])] ?? "three"} other target creatures`.replace("each of up to one other target creatures", "up to one other target creature"));
      result.triggers.push({ event: "etb", text: line, ...parsedSupport });
      continue;
    }
    const mutate = line.match(/^mutate (\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (mutate) {
      result.mutate = mutate[1];
      continue;
    }
    const evoke = line.match(/^evoke (\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (evoke) {
      result.evoke = evoke[1];
      continue;
    }
    // Aus dem Friedhof: Encore / Eternalize / Embalm (Kopie als Spielstein, Karte wird ins Exil gelegt)
    const yard = line.match(/^(encore|eternalize|embalm) (\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (yard) {
      const mode = yard[1].toLowerCase();
      const summary = { encore: "Encore: Karte ins Exil – für jeden Gegner ein Spielstein-Kopie mit Eile, die ihn angreifen muss; am Zugende opfern.", eternalize: "Eternalize: Karte ins Exil – schwarze 4/4-Zombie-Spielstein-Kopie.", embalm: "Embalm: Karte ins Exil – weiße Zombie-Spielstein-Kopie." }[mode];
      result.activated.push({ index: result.activated.length, text: line, zone: "graveyard", cost: { tap: false, sacrifice: false, mana: yard[2], exileSelf: true }, sorcery: true, effects: [{ type: "copyToken", mode }], specs: [], unparsed: [], summary });
      continue;
    }
    if (/^station$/i.test(line)) {
      result.station = { at: stationAt };
      result.activated.push({ index: result.activated.length, text: line, cost: { tap: false, sacrifice: false, mana: "", extra: [{ kind: "tap", what: "creature", n: 1, other: true }] }, sorcery: true, effects: [{ type: "station" }], specs: [], unparsed: [], summary: `Station: tappe eine andere Kreatur, lege Ladungsmarker in Höhe ihrer Stärke auf diese Karte${stationAt ? ` (ab ${stationAt} Markern eine Artefaktkreatur)` : ""}.` });
      continue;
    }
    const crew = line.match(/^crew (\d+)$/i);
    if (crew) {
      result.activated.push({ index: result.activated.length, text: line, cost: { tap: false, sacrifice: false, mana: "", crew: Number(crew[1]) }, sorcery: false, effects: [{ type: "animate", p: null, th: null, kws: [] }], specs: [], unparsed: [], summary: `Besatzung ${crew[1]}: wird bis zum Zugende zur Kreatur.` });
      continue;
    }
    // Eigene Einschränkung: „This creature can't block.“
    const selfCant = line.match(/^~ can't (attack or block|attack|block)\.?$/i);
    if (selfCant) {
      result.selfGrants = [...(result.selfGrants ?? []), ...(selfCant[1] === "attack or block" ? ["cant-attack", "cant-block"] : [`cant-${selfCant[1]}`])];
      continue;
    }
    // Beschränkungen durch Auren/Ausrüstung: „Enchanted creature can't attack or block.“
    const cant = line.match(/^(?:enchanted|equipped) creature can't (attack or block|attack|block)\.?$/i);
    if (cant) {
      const grants = cant[1] === "attack or block" ? ["cant-attack", "cant-block"] : [`cant-${cant[1]}`];
      result.attach = { p: result.attach?.p ?? 0, th: result.attach?.th ?? 0, grants: [...(result.attach?.grants ?? []), ...grants] };
      continue;
    }
    // „bis die Karte das Spiel verlässt“ (Oblivion Ring, Journey to Nowhere)
    if (/^when ~ leaves the battlefield, return the exiled card to the battlefield under its owner's control\.?$/i.test(line)) {
      result.returnExiled = true;
      continue;
    }
    if (/^you have no maximum hand size\.?$/i.test(line)) {
      result.noHandLimit = true;
      continue;
    }
    const reduce = line.match(/^~ costs \{(\d+)\} less to cast for each (creature|land|artifact) on the battlefield\.?$/i);
    if (reduce) {
      result.costReduction = { amount: Number(reduce[1]), per: reduce[2].toLowerCase() };
      continue;
    }
    // Ausrüsten: „Equip {2}“ (nur Manakosten) hängt die Karte an eine eigene Kreatur (nur als Zauberspruch).
    const equip = line.match(/^equip (\{[^}]+\}(?:\{[^}]+\})*)$/i);
    if (equip) {
      result.activated.push({
        index: result.activated.length,
        text: line,
        cost: { tap: false, sacrifice: false, mana: equip[1] },
        sorcery: true,
        effects: [{ type: "attach", t: 0 }],
        specs: [{ kind: "myCreature" }],
        unparsed: [],
        summary: "Hängt diese Karte an eine eigene Kreatur."
      });
      continue;
    }
    // Verzauberung (Aura): Ziel beim Wirken, bleibt danach an der Karte hängen.
    const enchant = line.match(/^enchant (creature you control|creature|land|artifact|permanent)$/i);
    if (enchant) {
      const kind = { "creature you control": "myCreature", creature: "creature", land: "land", artifact: "artifact", permanent: "permanent" }[enchant[1].toLowerCase()];
      result.aura = true;
      result.spell = { effects: [], specs: [{ kind }], unparsed: [], summary: "Verzauberung: hängt sich beim Auflösen an das Ziel." };
      continue;
    }
    // „As long as equipped creature is legendary, it has trample and haste.“
    const legendAttach = line.match(/^as long as equipped creature is legendary, it (gets|has|loses) (.+?)\.?$/i);
    if (legendAttach) {
      const clauses = parseAttachClauses(`${legendAttach[1]} ${legendAttach[2]}`);
      if (clauses) {
        result.attachLegendary = { p: clauses.p, th: clauses.th, grants: clauses.grants, revokes: clauses.revokes };
        continue;
      }
    }
    // Dauerbonus durch Anhängen: „Equipped creature gets +2/+1, has trample and loses flying.“
    const attach = line.match(/^(?:equipped|enchanted) creature (gets|has|loses) (.+?)\.?$/i);
    if (attach) {
      const clauses = parseAttachClauses(`${attach[1]} ${attach[2]}`);
      if (clauses) {
        result.attach = {
          p: (result.attach?.p ?? 0) + clauses.p,
          th: (result.attach?.th ?? 0) + clauses.th,
          grants: [...(result.attach?.grants ?? []), ...clauses.grants],
          ...(clauses.revokes.length || result.attach?.revokes?.length ? { revokes: [...(result.attach?.revokes ?? []), ...clauses.revokes] } : {})
        };
        continue;
      }
    }
    if (isKeywordLine(line)) continue;

    // Loyalitätsfähigkeit
    const loyalty = types.planeswalker ? line.match(/^([+−-]?\d+): (.+)$/) : null;
    if (loyalty) {
      const cost = { loyalty: Number(loyalty[1].replace("−", "-")) };
      const parsed = parseEffectText(loyalty[2]);
      result.activated.push({ index: result.activated.length, text: line, cost, sorcery: true, ...parsed });
      continue;
    }

    // Aktivierte Fähigkeit: Kosten: Wirkung (Tappen, Mana, sich selbst opfern, andere Karten opfern/abwerfen, Leben zahlen)
    const colon = line.indexOf(": ");
    if (colon > 0 && colon < 90 && !/^(when|whenever|at) /i.test(line)) {
      const cost = parseAbilityCost(line.slice(0, colon));
      const effectText = line.slice(colon + 2);
      if (cost) {
        const plainTap = cost.tap && !cost.mana && !cost.sacrifice && !cost.extra;
        if (/^add\b/i.test(effectText) && plainTap) continue; // einfaches Mana: wird als Manaquelle behandelt
        const parsed = parseEffectText(effectText);
        result.activated.push({ index: result.activated.length, text: line, cost, sorcery: /activate (this ability )?only as a sorcery/i.test(line), ...(cost.discardSelf ? { zone: "hand" } : {}), ...parsed });
        continue;
      }
      if (/^(\{|sacrifice|discard|pay|exile|remove|tap|untap|return)/i.test(line)) {
        result.notes.push(line);
        continue;
      }
    }

    // Ersatzeffekt: kommt getappt ins Spiel (bedingungslos oder „unless …“)
    if (/^~ enters( the battlefield)? tapped\.?$/i.test(line)) {
      result.entersTapped = true;
      continue;
    }
    const unless = line.match(/^~ enters( the battlefield)? tapped unless (.+?)\.?$/i);
    if (unless) {
      const condition = parseEntryCondition(unless[2]);
      if (condition) {
        result.entersTappedUnless = condition;
        continue;
      }
    }
    const shock = line.match(/^as ~ enters( the battlefield)?, you may pay (\d+) life\. if you don't, (?:it|~) enters( the battlefield)? tapped\.?$/i);
    if (shock) {
      result.shock = { life: Number(shock[2]) };
      continue;
    }
    const reveal = line.match(/^as ~ enters( the battlefield)?, you may reveal an? (.+?) card from your hand\. if you don't, (?:it|~) enters( the battlefield)? tapped\.?$/i);
    if (reveal) {
      const types = basicTypes(reveal[2]);
      if (types) {
        result.reveal = { types };
        continue;
      }
    }

    // Dauereffekte: Boni für Kreaturen
    const tokenAnthem = line.match(/^creature tokens you control get ([+-]\d+)\/([+-]\d+)\.?$/i);
    if (tokenAnthem) {
      result.statics.push({ scope: "you", tokenOnly: true, p: Number(tokenAnthem[1]), th: Number(tokenAnthem[2]), grants: [] });
      continue;
    }
    const anthem = line.match(/^(other )?creatures you control get ([+-]\d+)\/([+-]\d+)(?: and have ([a-z, ]+))?\.?$/i);
    const tribal = line.match(/^(other )?(?!creatures\b|other\b)([a-z]+)(?: creatures)? you control get ([+-]\d+)\/([+-]\d+)(?: and have ([a-z, ]+))?\.?$/i);
    const chosen = line.match(/^(other )?creatures you control of the chosen type get ([+-]\d+)\/([+-]\d+)(?: and have ([a-z, ]+))?\.?$/i);
    if (chosen) {
      const grants = (chosen[4] ?? "").split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word));
      result.statics.push({ scope: chosen[1] ? "youOther" : "you", chosen: true, p: Number(chosen[2]), th: Number(chosen[3]), grants });
      continue;
    }
    if (tribal) {
      const grants = (tribal[5] ?? "").split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word));
      result.statics.push({ scope: tribal[1] ? "youOther" : "you", subtype: tribal[2].toLowerCase(), p: Number(tribal[3]), th: Number(tribal[4]), grants });
      continue;
    }
    // „As ~ enters, choose a creature type.“ – der Spieler wählt beim Ins-Spiel-Kommen
    if (/^as ~ enters( the battlefield)?, choose a creature type\.?$/i.test(line)) {
      result.chooseType = true;
      continue;
    }
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
      const condition = trigger[2].toLowerCase();
      const events = /^~ enters( the battlefield)? or attacks$/.test(condition)
        ? [triggerEvent(trigger[1], "~ enters"), triggerEvent(trigger[1], "~ attacks")]
        : /^your commander enters or attacks$/.test(condition)
          ? [{ event: "creatureEnters", scope: { owner: "you", another: false, commander: true } }, { event: "creatureAttacks", scope: { owner: "you", another: false, commander: true } }]
          : /^~ enters( the battlefield)? or dies$/.test(condition)
          ? [triggerEvent(trigger[1], "~ enters"), triggerEvent(trigger[1], "~ dies")]
          : /^~ attacks or blocks$/.test(condition)
          ? [triggerEvent(trigger[1], "~ attacks"), triggerEvent(trigger[1], "~ blocks")]
          : [triggerEvent(trigger[1], condition)];
      if (events.every(Boolean)) {
        const selfEvent = events.every(event => ["etb", "attacks", "blocks", "dealsCombatDamage", "dies", "dealtDamage", "selfCounter"].includes(event.event));
        const effectText = selfEvent ? trigger[3].replace(/\b(on|it deals|returns?|gets?) it\b/g, match => match.replace(/\bit\b/, "~")) : trigger[3];
        const parsed = parseEffectText(effectText);
        if (parsed.specs.length <= 3) {
          for (const event of events) result.triggers.push({ ...event, text: line, ...parsed });
          continue;
        }
      }
    }
    result.notes.push(line);
  }
  for (const modal of modalTriggers) {
    const events = modal.condition === "~ attacks or blocks" ? [triggerEvent(modal.word, "~ attacks"), triggerEvent(modal.word, "~ blocks")] : modal.condition === "~ enters or attacks" ? [triggerEvent(modal.word, "~ enters"), triggerEvent(modal.word, "~ attacks")] : [triggerEvent(modal.word, modal.condition)];
    const modes = modal.modes.map(text => ({ label: text, ...parseEffectText(text) }));
    if (events.every(Boolean) && modes.every(mode => mode.specs.length <= 2)) for (const event of events) result.triggers.push({ ...event, text: modal.line, modes, effects: [], specs: [], unparsed: modes.flatMap(mode => mode.unparsed) });
    else result.notes.push(`${modal.word} ${modal.condition}, choose one — ${modal.modes.join(" • ")}`);
  }
  for (const tier of tiers) {
    for (const line of tier.lines) {
      const words = line.split(/[,;]/).map(part => part.trim().toLowerCase());
      if (words.length > 0 && words.every(word => KEYWORDS.includes(word))) {
        result.tiers = [...(result.tiers ?? []), { n: tier.n, kws: words }];
        continue;
      }
      const sub = parseCardText({ name, typeLine, oracleText: line });
      for (const item of sub.triggers) result.triggers.push({ ...item, minCharge: tier.n });
      for (const item of sub.statics) result.statics.push({ ...item, minCharge: tier.n });
      for (const item of sub.activated) result.activated.push({ ...item, index: result.activated.length, minCharge: tier.n });
      for (const note of sub.notes) result.notes.push(`${tier.n}+ | ${note}`);
    }
  }
  if (result.returnExiled) {
    for (const trigger of result.triggers) for (const effect of trigger.effects) if (effect.type === "exile") effect.until = true;
  }
  return result;
}

export { parseManaCost };
