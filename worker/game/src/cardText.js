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
  text = text.replace(/\bthis (creature|permanent|artifact|enchantment|land|planeswalker|spell|equipment|aura|vehicle)\b/gi, "~");
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
  const words = rest.split(" ");
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

  // „… for each …“: der Effekt wird mit der Anzahl multipliziert.
  if ((m = lower.match(/^(.+?) for each (creature you control|land you control|artifact you control|creature your opponents control|creature|land|artifact|card in your hand|opponent)$/))) {
    const head = parseSentence(s.slice(0, m[1].length), specs);
    if (head && head.length === 1 && typeof head[0].n === "number" && head[0].n === 1) return [{ ...head[0], per: m[2] }];
    return null;
  }

  // „You may …“: der Spieler entscheidet (Ja/Nein); „If you do, …“ folgt nur nach „Ja“.
  if ((m = lower.match(/^you may (.+)$/))) {
    const inner = parseSentence(s.slice(8), specs);
    return inner ? [{ type: "may", effects: inner }] : null;
  }
  if ((m = lower.match(/^if you do, (.+)$/)) && !/^that creature gains/.test(m[1])) {
    const inner = parseSentence(s.slice(11), specs);
    return inner ? [{ type: "ifDid", effects: inner }] : null;
  }

  if ((m = lower.match(/^gain control of (target creature|target permanent|target artifact|target land|target enchantment)( until end of turn)?$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "control", t, untilEot: Boolean(m[2]) }];
  }
  if (lower === "untap that creature" || lower === "untap it") return [{ type: "untapLast" }];
  if (/^(?:it|that creature) gains haste until end of turn$/.test(lower)) return [{ type: "hasteLast" }];
  if (lower === "prevent all combat damage that would be dealt this turn") return [{ type: "fog" }];
  if (lower === "take an extra turn after this one") return [{ type: "extraTurn" }];
  if ((m = lower.match(/^(target creature|~) gains? ([a-z ,]+?) until end of turn$/))) {
    const kws = m[2].split(/,| and /).map(word => word.trim()).filter(Boolean);
    if (kws.length === 0 || !kws.every(word => KEYWORDS.includes(word))) return null;
    if (m[1] === "~") return [{ type: "grantKw", kws, self: true }];
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "grantKw", kws, t }];
  }
  if ((m = lower.match(new RegExp(`^${WHO} sacrifices? (?:a|an|one) (creature|artifact|enchantment|land|permanent|nonland permanent)$`)))) {
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
  if ((m = lower.match(/^destroy all (creatures|lands|artifacts|enchantments)$/))) {
    return [{ type: "destroyAll", what: { creatures: "creature", lands: "land", artifacts: "artifact", enchantments: "enchantment" }[m[1]] }];
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
  if ((m = lower.match(/^(?:you |)(?:create|creates) (a|an|one|two|three) (treasure|food|clue|blood) tokens?$/i))) {
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
  if ((m = lower.match(/^(creatures you control|creatures your opponents control|all creatures) (?:get ([+-]\d+)\/([+-]\d+) and gain ([a-z, ]+)|gain ([a-z ,]+?) and get ([+-]x|[+-]\d+)\/([+-]x|[+-]\d+)) until end of turn(?:, where x is the number of creatures you control)?$/))) {
    const scope = m[1] === "creatures you control" ? "you" : m[1] === "all creatures" ? "all" : "opp";
    const kws = (m[4] ?? m[5]).split(/,| and /).map(word => word.trim()).filter(word => KEYWORDS.includes(word));
    const parse = value => (/x$/.test(value) ? "X" : Number(value));
    return [{ type: "pumpAll", scope, p: m[2] !== undefined ? Number(m[2]) : parse(m[6]), th: m[3] !== undefined ? Number(m[3]) : parse(m[7]), kws, ...(m[6] && /x/.test(m[6]) ? { xPer: "creature you control" } : {}) }];
  }
  if ((m = lower.match(new RegExp(`^each player discards their hand, then draws ${N} cards$`)))) {
    return num(m[1]) === null ? null : [{ type: "discardHand", who: { k: "each" } }, { type: "draw", who: { k: "each" }, n: num(m[1]) }];
  }
  if (lower === "each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way") return [{ type: "discardHand", who: { k: "each" }, drawGreatest: true }];
  if (lower === "reveal the top card of your library") return [{ type: "revealTop" }];
  if ((m = lower.match(/^if it's a (land|creature|artifact|enchantment) card, put it onto the battlefield$/))) return [{ type: "revealIf", what: m[1], to: "battlefield" }];
  if ((m = lower.match(/^otherwise, put it into your hand$/))) return [{ type: "revealElse", to: "hand" }];
  if ((m = lower.match(/^~ deals ([0-9]+) damage to each creature with flying and each player$/))) return [{ type: "damage", n: Number(m[1]), to: { k: "flyingAndPlayers" } }];
  if (lower === "~ deals x damage to each creature, where x is the number of creatures on the battlefield") return [{ type: "damage", n: 1, per: "creature", to: { k: "eachCreature" } }];
  if ((m = lower.match(/^~ deals ([0-9]+) damage to each creature and each player$/))) return [{ type: "damage", n: Number(m[1]), to: { k: "everything" } }];
  if ((m = lower.match(/^return ~ to its owner's hand$/))) return [{ type: "returnSelf" }];
  if ((m = lower.match(/^destroy (another target .+)$/))) {
    const t = addTarget(specs, m[1]);
    return t === null ? null : [{ type: "destroy", t }];
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

  if ((m = s.match(new RegExp(`^(?:Its controller |That player |You )?[Cc]reates? ${N} (\\d+)/(\\d+) ([A-Za-z ,]+?) creature tokens?(?: with ([a-z ,]+?))?$`)))) {
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
  if ((m = lower.match(/^search your library for (a|an|up to one|up to two|up to three|two|three) ((?:basic land|land|creature|artifact|enchantment|planeswalker|instant|sorcery|plains|island|swamp|mountain|forest)(?:, (?:plains|island|swamp|mountain|forest))*(?:,? or (?:plains|island|swamp|mountain|forest))?) cards?(?:, reveal (?:it|that card|those cards))?(?:,| and)? ?(?:then )?put (?:it|that card|them|those cards) (into your hand|onto the battlefield( tapped)?)(?:,)? ?(?:then shuffle)?$/))) {
    const count = { a: 1, an: 1, "up to one": 1, "up to two": 2, "up to three": 3, two: 2, three: 3 }[m[1]];
    const what = m[2].replace(/,? or /g, "|").replace(/, /g, "|");
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
    else if ((m = part.match(/^Sacrifice (a|an|another|one|two|three) (creature|artifact|land|enchantment|permanent|nonland permanent)s?$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "sacrifice", what: m[2].toLowerCase() === "nonland permanent" ? "nonland" : m[2].toLowerCase(), n: COUNT_WORD[m[1].toLowerCase()] ?? 1, other: m[1].toLowerCase() === "another" }];
    } else if ((m = part.match(/^Discard (a|one|two|three) cards?$/i))) {
      cost.extra = [...(cost.extra ?? []), { kind: "discard", n: COUNT_WORD[m[1].toLowerCase()] ?? 1 }];
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
    case "draw": return `${who} ${effect.who?.k === "you" ? "ziehst" : "zieht"} ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "life": {
      const loss = effect.negate || (typeof effect.n === "number" && effect.n < 0);
      const amount = typeof effect.n === "number" ? Math.abs(effect.n) : effect.n;
      return loss ? `${who} ${effect.who?.k === "you" ? "verlierst" : "verliert"} ${amount} Leben.` : `${who} ${effect.who?.k === "you" ? "erhältst" : "erhält"} ${amount} Leben.`;
    }
    case "mill": return `${who} mahlt ${effect.n} ${plural(effect.n, "Karte", "Karten")}.`;
    case "discard": return `${who} wirft ${effect.n} ${plural(effect.n, "Karte", "Karten")} ab.`;
    case "scry": return `Wühlen ${effect.n}.`;
    case "surveil": return `Überwachen ${effect.n}.`;
    case "damage": return `${effect.n} Schaden an ${{ target: "das Ziel", eachOpp: "jeden Gegner", each: "jeden Spieler", eachCreature: "jede Kreatur", eachOppCreature: "jede gegnerische Kreatur" }[effect.to.k]}.`;
    case "destroy": return "Zerstört das Ziel.";
    case "destroyAll": return `Zerstört alle ${{ creature: "Kreaturen", land: "Länder", artifact: "Artefakte", enchantment: "Verzauberungen" }[effect.what] ?? "Permanents"}.`;
    case "exile": return "Schickt das Ziel ins Exil.";
    case "bounce": return "Das Ziel geht zurück auf die Hand seines Besitzers.";
    case "bounceOwnLand": return "Du legst ein eigenes Land zurück auf die Hand.";
    case "tap": return "Tappt das Ziel.";
    case "untap": return "Enttappt das Ziel.";
    case "counterSpell": return "Neutralisiert den Zielzauber.";
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
    case "bite": return "Die eigene Kreatur fügt der Ziel-Kreatur Schaden in Höhe ihrer Stärke zu.";
    case "biteTrample": return "";
    case "fight": return "Beide Kreaturen fügen sich gegenseitig Schaden in Höhe ihrer Stärke zu.";
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
    const pieces = sentence.split(/,? then | and /).map(piece => piece.trim()).map((piece, index) => (index > 0 && /^\d+ damage to /i.test(piece) ? `~ deals ${piece}` : piece));
    const split = pieces.length > 1 ? tryParts(pieces) : null;
    if (split) effects.push(...split);
    else unparsed.push(sentence);
  }
  return { effects, specs, unparsed, summary: summarize({ effects, unparsed }) };
}

const BASIC_TYPES = ["plains", "island", "swamp", "mountain", "forest"];
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

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
  if (/^~ enters( the battlefield)?$/.test(condition)) return { event: "etb" };
  if (/^~ dies$/.test(condition) || /^~ is put into a graveyard from the battlefield$/.test(condition)) return { event: "dies" };
  if (/^~ or another creature dies$/.test(condition)) return { event: "creatureDies", scope: { owner: "any", another: false } };
  if (/^equipped creature dies$/.test(condition)) return { event: "equippedDies" };
  if (/^~ deals combat damage to a player$/.test(condition)) return { event: "dealsCombatDamage" };
  if (/^equipped creature deals combat damage to a player$/.test(condition)) return { event: "equippedDealsCombatDamage" };
  if (word === "At" && /^the beginning of combat on your turn$/.test(condition)) return { event: "beginCombat", scope: { owner: "you", another: false } };
  if (/^you gain life$/.test(condition)) return { event: "youGainLife", scope: { owner: "you", another: false } };
  if (/^you draw a card$/.test(condition)) return { event: "youDraw", scope: { owner: "you", another: false } };
  if (/^an opponent draws a card$/.test(condition)) return { event: "oppDraw", scope: { owner: "opp", another: false } };
  if (/^another creature enters( the battlefield)?$/.test(condition)) return { event: "creatureEnters", scope: { owner: "any", another: true } };
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
  if (/^you cast a creature spell of the chosen type$/.test(condition)) return { event: "castCreature", chosenType: true, scope: { owner: "you", another: false } };
  if (/^you cast a creature spell$/.test(condition)) return { event: "castCreature", scope: { owner: "you", another: false } };
  if (word === "At" && condition === "the beginning of your upkeep") return { event: "upkeep", scope: { owner: "you", another: false } };
  if (word === "At" && condition === "the beginning of your end step") return { event: "endStep", scope: { owner: "you", another: false } };
  return null;
}

const stripPrefix = line => line.replace(/^[•*]\s*/, "").replace(/^[A-Z][^—.:]{0,60}[!.]?\s*[—-]\s*(?=(?:When|Whenever|At)\b)/, "");

/**
 * Zerlegt den Text einer Karte in Zauber-Effekt, Auslöser, aktivierte Fähigkeiten und nicht automatisch behandelbare Hinweise.
 * @returns {{ spell: object|null, triggers: object[], activated: object[], notes: string[] }}
 */
export function parseCardText({ name, typeLine, oracleText }) {
  const types = typesOf(typeLine);
  const rawLines = normalizeText(oracleText, name);
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
    if (rawLines.some(line => /^choose one\s*[—-]/i.test(line)) && modeLines.length >= 2) {
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
      const additional = line.match(/^as an additional cost to cast ~, (sacrifice|discard) (a|an|one|two|three) (creature|artifact|land|enchantment|permanent|card)s?\.?$/i);
      if (additional) {
        const kind = additional[1].toLowerCase();
        result.additionalCost = [{ kind, n: COUNT_WORD[additional[2].toLowerCase()] ?? 1, ...(kind === "sacrifice" ? { what: additional[3].toLowerCase() } : {}) }];
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
    // Dauerbonus durch Anhängen: „Equipped creature gets +2/+1 and has first strike.“
    const attach = line.match(/^(?:equipped|enchanted) creature (?:gets ([+-]\d+)\/([+-]\d+))?(?: and )?(?:has ([a-z, ]+))?\.?$/i);
    if (attach && (attach[1] !== undefined || attach[3])) {
      const grants = (attach[3] ?? "").split(/,| and /).map(word => word.trim().toLowerCase()).filter(word => KEYWORDS.includes(word));
      result.attach = { p: attach[1] !== undefined ? Number(attach[1]) : 0, th: attach[2] !== undefined ? Number(attach[2]) : 0, grants };
      continue;
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
        result.activated.push({ index: result.activated.length, text: line, cost, sorcery: /activate (this ability )?only as a sorcery/i.test(line), ...parsed });
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
        : [triggerEvent(trigger[1], condition)];
      if (events.every(Boolean)) {
        const parsed = parseEffectText(trigger[3]);
        if (parsed.specs.length <= 3) {
          for (const event of events) result.triggers.push({ ...event, text: line, ...parsed });
          continue;
        }
      }
    }
    result.notes.push(line);
  }
  if (result.returnExiled) {
    for (const trigger of result.triggers) for (const effect of trigger.effects) if (effect.type === "exile") effect.until = true;
  }
  return result;
}

export { parseManaCost };
