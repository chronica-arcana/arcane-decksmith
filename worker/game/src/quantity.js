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
    if (["X", "-X"].includes(next.n) || ["X", "-X"].includes(next.p) || ["X", "-X"].includes(next.th)) next[field] = quantity;
    if (Array.isArray(next.effects)) next.effects = attachQuantity(next.effects, quantity, field);
    return next;
  });
}

/** Hat ein Effekt (oder ein verschachtelter) eine X-Zahl? */
export const usesX = effects => effects.some(effect => ["X", "-X"].includes(effect.n) || ["X", "-X"].includes(effect.p) || ["X", "-X"].includes(effect.th) || (Array.isArray(effect.effects) && usesX(effect.effects)));

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
  if (/^it's your turn$/.test(t)) return { kind: "yourTurn" };
  if (/^it's not your turn$/.test(t)) return { kind: "notYourTurn" };
  return null;
}
