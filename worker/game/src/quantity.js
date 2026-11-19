/**
 * Mengenangaben in Kartentexten („where X is …“, „equal to …“, „for each …“) als berechenbare Beschreibung.
 *
 * `parseQuantity("the number of Vampires you control")` → `{ kind: "count", spec: {...}, who: "you" }`.
 * Ausgewertet wird die Beschreibung von der Spiel-Engine (`evalQuantity` in gameLogic.js).
 * Unbekannte Formulierungen ergeben `null` – dann bleibt der Satz unverstanden (kein stilles Raten).
 */

/** Plural → Singular für einfache Nomen („Vampires“ → „vampire“, „artifact creatures“ → „artifact creature“). */
export function singular(phrase) {
  return phrase
    .trim()
    .split(" ")
    .map((word, index, words) => (index === words.length - 1 ? word.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : word))
    .join(" ");
}

const REF = { its: "it", "~'s": "self", "that creature's": "it", "that permanent's": "it", "that card's": "it", "that spell's": "it", "that artifact's": "it", "the sacrificed creature's": "it", "the exiled creature's": "it", "the exiled card's": "it", "enchanted creature's": "attached", "equipped creature's": "attached" };

/**
 * @param {string} text Mengenangabe (ohne „where X is“/„equal to“)
 * @param {(phrase: string) => object|null} parseSpec Ziel-Parser des Kartentexts (für Zählfilter)
 */
export function parseQuantity(text, parseSpec) {
  let t = String(text ?? "").toLowerCase().trim().replace(/[.,]$/, "");
  let mult = 1;
  if (t.startsWith("twice ")) {
    mult = 2;
    t = t.slice(6);
  }
  const done = q => (q ? { ...q, ...(mult !== 1 ? { mult } : {}) } : null);
  let m;
  if ((m = t.match(/^(its|~'s|that creature's|that permanent's|that card's|that spell's|that artifact's|the sacrificed creature's|the exiled creature's|the exiled card's|enchanted creature's|equipped creature's) (power|toughness|mana value)$/))) {
    return done({ kind: "stat", ref: REF[m[1]], stat: m[2] === "mana value" ? "mv" : m[2] });
  }
  if ((m = t.match(/^the (power|toughness|mana value) of (?:it|that card|that creature|the sacrificed (?:permanent|creature|artifact)|the exiled card)$/))) {
    return done({ kind: "stat", ref: /sacrificed/.test(t) ? "sacrificed" : "it", stat: m[1] === "mana value" ? "mv" : m[1] });
  }
  if ((m = t.match(/^the sacrificed (?:permanent|creature|artifact)'s (power|toughness|mana value)$/))) return done({ kind: "stat", ref: "sacrificed", stat: m[1] === "mana value" ? "mv" : m[1] });
  if (/^the life lost this way$/.test(t)) return done({ kind: "lifeLost" });
  if (/^the number of opponents?(?: you have)?$/.test(t)) return done({ kind: "opponents" });
  if (/^the number of opponents? you attacked this turn$/.test(t)) return done({ kind: "oppAttacked" });
  if (/^the number of cards? in your hand$/.test(t)) return done({ kind: "zone", zone: "hand" });
  if ((m = t.match(/^the number of (?:(creature|land|artifact|enchantment|instant and sorcery|instant|sorcery|permanent) )?cards? in your graveyard$/))) return done({ kind: "zone", zone: "graveyard", type: m[1] ?? null });
  if ((m = t.match(/^the number of (?:([+-]1\/[+-]1|[a-z]+) )?counters? on (~|it|that creature)$/))) return done({ kind: "counters", counter: m[1] ?? "any", ref: m[2] === "~" ? "self" : "it" });
  if ((m = t.match(/^the greatest (power|toughness|mana value) among (creatures|artifacts|permanents|other creatures) you control$/))) {
    return done({ kind: "greatest", stat: m[1] === "mana value" ? "mv" : m[1], what: m[2].replace(/^other /, "").replace(/s$/, ""), other: m[2].startsWith("other") });
  }
  if (/^the number of differently named lands you control$/.test(t)) return done({ kind: "distinctLands" });
  if (/^the number of attacking creatures(?: you control)?$/.test(t)) return done({ kind: "attacking" });
  if ((m = t.match(/^the number of (.+?) (you control|your opponents control|on the battlefield|that player controls|target player controls)$/))) {
    const spec = parseSpec(`target ${singular(m[1])}`);
    if (!spec) return null;
    return done({ kind: "count", spec, who: { "you control": "you", "your opponents control": "opp", "on the battlefield": "all", "that player controls": "subject", "target player controls": "subject" }[m[2]] });
  }
  return null;
}

/** „… for each <Filter>“: Menge, mit der die Zahl der Effekte multipliziert wird. */
export function parseForEach(tail, parseSpec) {
  return parseQuantity(`the number of ${tail}`, parseSpec);
}

/** Setzt die Mengenangabe auf alle Effekte, deren Zahl „X“ ist (auch verschachtelt, z. B. in „may“). */
export function attachQuantity(effects, quantity, field = "xRef") {
  return effects.map(effect => {
    const next = { ...effect };
    if (["X", "-X"].includes(next.n) || ["X", "-X"].includes(next.p) || ["X", "-X"].includes(next.th) || next.count === "X") next[field] = quantity;
    if (Array.isArray(next.effects)) next.effects = attachQuantity(next.effects, quantity, field);
    return next;
  });
}

/** Hat ein Effekt (oder ein verschachtelter) eine X-Zahl? */
export const usesX = effects => effects.some(effect => ["X", "-X"].includes(effect.n) || effect.count === "X" || ["X", "-X"].includes(effect.p) || ["X", "-X"].includes(effect.th) || (Array.isArray(effect.effects) && usesX(effect.effects)));

/**
 * Formt „… equal to <Menge>“ in die X-Form um, damit die normalen Satzregeln greifen.
 * @returns {{ text: string, quantity: string } | null}
 */
export function rewriteEqualTo(sentence) {
  const s = sentence.trim().replace(/\.$/, "");
  let m;
  const rules = [
    [/^(.+?) deals? damage equal to (.+?) to (.+)$/i, mm => [`${mm[1]} deals X damage to ${mm[3]}`, mm[2]]],
    [/^(.+?) deals? damage to (.+?) equal to (.+)$/i, mm => [`${mm[1]} deals X damage to ${mm[2]}`, mm[3]]],
    [/^(you|target player|each opponent|each player|that player) (gains?|loses?) life equal to (.+)$/i, mm => [`${mm[1]} ${mm[2]} X life`, mm[3]]],
    [/^(you |target player |that player )?draws? cards equal to (.+)$/i, mm => [`${mm[1] ?? ""}draw X cards`, mm[2]]],
    [/^(you |target player |that player |each opponent )?mills? cards equal to (.+)$/i, mm => [`${mm[1] ?? ""}mill X cards`, mm[2]]],
    [/^create a number of (.+?) equal to (.+)$/i, mm => [`create X ${mm[1]}`, mm[2]]],
    [/^put a number of (.+?) counters on (.+?) equal to (.+)$/i, mm => [`put X ${mm[1]} counters on ${mm[2]}`, mm[3]]],
    [/^put a number of (.+?) counters equal to (.+?) on (.+)$/i, mm => [`put X ${mm[1]} counters on ${mm[3]}`, mm[2]]],
    [/^(.+?) gets? \+x\/\+0 until end of turn, where x is (.+)$/i, mm => [`${mm[1]} gets +X/+0 until end of turn`, mm[2]]]
  ];
  for (const [re, build] of rules) {
    if ((m = s.match(re))) {
      const [text, quantity] = build(m);
      return { text, quantity };
    }
  }
  return null;
}

const COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const countOf = word => (/^\d+$/.test(word) ? Number(word) : COUNT[word] ?? null);

/**
 * Bedingungen („intervening if“): `parseCondition("you control three or more artifacts")`.
 * Rückgabe: Beschreibung für `evalCondition` in gameLogic.js oder `null` (unbekannt → Satz bleibt unverstanden).
 */
export function parseCondition(text, parseSpec) {
  const t = String(text ?? "").toLowerCase().trim();
  let m;
  if ((m = t.match(/^you control (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)(?: or more)? (.+)$/)) && !/^(commander|your commander)$/.test(m[2])) {
    const n = countOf(m[1]);
    const spec = parseSpec(`target ${singular(m[2].replace(/ other than ~$/, ""))}`);
    return n && spec ? { kind: "controls", n, spec, other: / other than ~$/.test(m[2]) } : null;
  }
  if ((m = t.match(/^you control (?:a|your) commander$/))) return { kind: "commander" };
  if ((m = t.match(/^you don't control an? (.+)$/))) {
    const spec = parseSpec(`target ${singular(m[1])}`);
    return spec ? { kind: "controls", n: 1, spec, negate: true } : null;
  }
  if (/^you attacked (?:with a creature )?this turn$/.test(t)) return { kind: "attacked" };
  if ((m = t.match(/^you gained (?:(\d+) or more )?life this turn$/))) return { kind: "gainedLife", n: m[1] ? Number(m[1]) : 1 };
  if (/^you're the monarch$/.test(t)) return { kind: "monarch" };
  if (/^~ is tapped$/.test(t)) return { kind: "selfTapped" };
  if (/^~ is untapped$/.test(t)) return { kind: "selfUntapped" };
  if (/^an opponent controls more lands than you$/.test(t)) return { kind: "oppMoreLands" };
  if ((m = t.match(/^you have (\d+) or (more|less) life$/))) return { kind: "life", n: Number(m[1]), op: m[2] === "more" ? "gte" : "lte" };
  if (/^you have no cards in hand$/.test(t)) return { kind: "emptyHand" };
  if ((m = t.match(/^there are (\w+) or more cards in your graveyard$/))) return countOf(m[1]) ? { kind: "graveyard", n: countOf(m[1]) } : null;
  if ((m = t.match(/^(?:~|it|this spell) was cast from exile$/))) return { kind: "castFromExile" };
  if ((m = t.match(/^you've cast (two|three|four|\d+) or more (noncreature )?spells this turn$/))) return { kind: "castCount", n: countOf(m[1]), noncreature: Boolean(m[2]) };
  if ((m = t.match(/^an opponent has (\w+) or more cards in their graveyard$/))) return countOf(m[1]) ? { kind: "oppGraveyard", n: countOf(m[1]) } : null;
  if (/^it's your turn$/.test(t)) return { kind: "yourTurn" };
  if (/^it's not your turn$/.test(t)) return { kind: "notYourTurn" };
  return null;
}

const COLOR_WORDS = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
const KEYWORD_WORDS = ["flying", "haste", "trample", "vigilance", "menace", "lifelink", "deathtouch", "reach", "first strike", "double strike", "hexproof", "indestructible"];

/**
 * Ausnahmen bei Kopien („except it isn't legendary, it's a 4/4 black Zombie, it has haste“).
 * Rückgabe: Änderungen für die Kopie oder `null`, wenn eine Ausnahme unbekannt ist.
 */
export function parseCopyExceptions(text) {
  const mods = { kws: [], addSubtypes: [] };
  if (!text) return mods;
  const parts = text.toLowerCase().replace(/\.$/, "").split(/,\s*(?:and\s+)?|\s+and\s+(?=it|its|he|she|they)/).map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    let m;
    if (/^(?:it|he|she|they) (?:isn't|aren't) legendary$/.test(part)) mods.nonlegendary = true;
    else if ((m = part.match(/^(?:it|they) (?:has|have|gains?) ([a-z ]+)$/)) && KEYWORD_WORDS.includes(m[1])) mods.kws.push(m[1]);
    else if ((m = part.match(/^(?:it's|they're) (?:a|an) ((?:\d+\/\d+ )?(?:(?:white|blue|black|red|green|colorless) )*(?:[a-z]+ )*?)(?:creature )?in addition to its other types$/))) {
      const words = m[1].trim().split(/\s+/).filter(Boolean);
      for (const word of words) {
        if (/^\d+\/\d+$/.test(word)) [mods.power, mods.toughness] = word.split("/").map(Number);
        else if (COLOR_WORDS[word]) mods.color = COLOR_WORDS[word];
        else if (word === "artifact") mods.artifact = true;
        else if (word !== "colorless") mods.addSubtypes.push(word);
      }
    } else if ((m = part.match(/^(?:it's|they're) (?:a|an) (\d+)\/(\d+) ((?:(?:white|blue|black|red|green) )*)([a-z]+)$/))) {
      mods.power = Number(m[1]);
      mods.toughness = Number(m[2]);
      const color = m[3].trim().split(/\s+/).find(word => COLOR_WORDS[word]);
      if (color) mods.color = COLOR_WORDS[color];
      mods.addSubtypes.push(m[4]);
    } else if ((m = part.match(/^(?:it|they) (?:enters|enter) with (\w+) additional \+1\/\+1 counters? on (?:it|them)$/))) mods.plusCounters = m[1];
    else if (/^it's an artifact in addition to its other types$/.test(part)) mods.artifact = true;
    else return null;
  }
  return mods;
}
