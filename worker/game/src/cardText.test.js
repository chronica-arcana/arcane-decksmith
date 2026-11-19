import { describe, expect, it } from "vitest";
import { parseCardText } from "./cardText.js";

const spell = (name, typeLine, oracleText) => parseCardText({ name, typeLine, oracleText }).spell;

describe("cardText: Zauber", () => {
  it("Lightning Bolt: Schaden auf ein beliebiges Ziel", () => {
    const parsed = spell("Lightning Bolt", "Instant", "Lightning Bolt deals 3 damage to any target.");
    expect(parsed).toEqual({ effects: [{ type: "damage", n: 3, to: { k: "target", t: 0 } }], specs: [{ kind: "any" }], unparsed: [], summary: "3 Schaden an das Ziel. Ziel: Beliebiges Ziel (Spieler, Kreatur oder Planeswalker)." });
  });

  it("Divination, Giant Growth, Counterspell, Murder", () => {
    expect(spell("Divination", "Sorcery", "Draw two cards.").effects).toEqual([{ type: "draw", who: { k: "you" }, n: 2 }]);
    expect(spell("Giant Growth", "Instant", "Target creature gets +3/+3 until end of turn.")).toMatchObject({
      effects: [{ type: "pump", p: 3, th: 3, t: 0 }], specs: [{ kind: "creature" }]
    });
    expect(spell("Counterspell", "Instant", "Counter target spell.").effects).toEqual([{ type: "counterSpell", t: 0 }]);
    expect(spell("Murder", "Instant", "Destroy target creature.").effects).toEqual([{ type: "destroy", t: 0 }]);
    expect(spell("Hero's Downfall", "Instant", "Destroy target creature or planeswalker.").specs).toEqual([{ kind: "creatureOrPlaneswalker" }]);
  });

  it("zusammengesetzte Sätze: Lightning Helix, Preordain-artig", () => {
    const helix = spell("Lightning Helix", "Instant", "Lightning Helix deals 3 damage to any target and you gain 3 life.");
    expect(helix.effects).toEqual([{ type: "damage", n: 3, to: { k: "target", t: 0 } }, { type: "life", who: { k: "you" }, n: 3 }]);
    const pre = spell("Preordain", "Sorcery", "Scry 2, then draw a card.");
    expect(pre.effects).toEqual([{ type: "scry", n: 2 }, { type: "draw", who: { k: "you" }, n: 1 }]);
  });

  it("Suchen, Zurückholen, Mana, Spielsteine", () => {
    expect(spell("Rampant Growth", "Sorcery", "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.").effects)
      .toEqual([{ type: "search", what: "basic land", to: "battlefield", tapped: true, count: 1, upTo: false }]);
    expect(spell("Raise Dead", "Sorcery", "Return target creature card from your graveyard to your hand.").effects)
      .toEqual([{ type: "reanimate", t: 0, to: "hand", counters: 0 }]);
    expect(spell("Dark Ritual", "Instant", "Add {B}{B}{B}.").effects).toEqual([{ type: "mana", symbols: ["B", "B", "B"] }]);
    expect(spell("Raise the Alarm", "Instant", "Create two 1/1 white Soldier creature tokens.").effects)
      .toEqual([{ type: "token", n: 2, p: 1, th: 1, name: "Soldier" }]);
  });

  it("alles Unverstandene bleibt unausgeführt und wird gemeldet", () => {
    expect(spell("Doom Blade", "Instant", "Destroy target creature that was dealt damage this turn.")).toMatchObject({ effects: [], unparsed: ["Destroy target creature that was dealt damage this turn"] });
    expect(spell("Wahl", "Instant", "Choose one or both —\n• Counter target spell.\n• Draw a card.").unparsed).toHaveLength(1);
    const mixed = spell("Mix", "Sorcery", "Draw a card. Exile all cards from each graveyard.");
    expect(mixed.effects).toHaveLength(1);
    expect(mixed.unparsed).toEqual(["Exile all cards from each graveyard"]);
  });
});

describe("cardText: Permanents", () => {
  it("Einfach-Auslöser beim Betreten", () => {
    const parsed = parseCardText({ name: "Elvish Visionary", typeLine: "Creature — Elf Shaman", oracleText: "When Elvish Visionary enters the battlefield, draw a card." });
    expect(parsed.triggers).toEqual([
      { event: "etb", text: "When ~ enters the battlefield, draw a card.", effects: [{ type: "draw", who: { k: "you" }, n: 1 }], specs: [], unparsed: [], summary: "Du ziehst 1 Karte." }
    ]);
  });

  it("Auslöser mit Ziel, Sterbe- und Angriffsauslöser", () => {
    const shock = parseCardText({ name: "Flametongue Kavu", typeLine: "Creature — Kavu", oracleText: "When Flametongue Kavu enters the battlefield, it deals 4 damage to target creature." });
    expect(shock.triggers[0]).toMatchObject({ event: "etb", effects: [{ type: "damage", n: 4, to: { k: "target", t: 0 } }], specs: [{ kind: "creature" }] });
    const dies = parseCardText({ name: "Blood Artist", typeLine: "Creature", oracleText: "When ~ dies, target player loses 1 life and you gain 1 life." });
    expect(dies.triggers[0]).toMatchObject({ event: "dies", specs: [{ kind: "player" }] });
    const attacks = parseCardText({ name: "Rager", typeLine: "Creature", oracleText: "Whenever Rager attacks, draw a card." });
    expect(attacks.triggers[0].event).toBe("attacks");
  });

  it("aktivierte Fähigkeiten (Tappen, Mana) und Loyalität; Manaquellen und Schlüsselwörter werden übersprungen", () => {
    const tapper = parseCardText({ name: "Prodigal Sorcerer", typeLine: "Creature — Human Wizard", oracleText: "{T}: Prodigal Sorcerer deals 1 damage to any target." });
    expect(tapper.activated).toHaveLength(1);
    expect(tapper.activated[0]).toMatchObject({ cost: { tap: true, mana: "" }, effects: [{ type: "damage", n: 1 }] });
    const elves = parseCardText({ name: "Llanowar Elves", typeLine: "Creature", oracleText: "{T}: Add {G}." });
    expect(elves.activated).toEqual([]);
    const flier = parseCardText({ name: "Hawk", typeLine: "Creature", oracleText: "Flying, vigilance" });
    expect(flier).toEqual({ spell: null, triggers: [], activated: [], notes: [], statics: [], flashback: null, cycling: null, entersTapped: false, entersTappedUnless: null, shock: null, reveal: null });
    const pw = parseCardText({ name: "Jace", typeLine: "Legendary Planeswalker — Jace", oracleText: "+1: Draw a card.\n−3: Return target creature to its owner's hand." });
    expect(pw.activated.map(a => a.cost.loyalty)).toEqual([1, -3]);
    expect(pw.activated[1].effects[0]).toMatchObject({ type: "bounce" });
  });

  it("Dauereffekte und Sonderkosten werden als Hinweis geführt", () => {
    const odd = parseCardText({ name: "Seltsam", typeLine: "Enchantment", oracleText: "Whenever a creature becomes tapped, draw a card." });
    expect(odd.notes).toEqual(["Whenever a creature becomes tapped, draw a card."]);
    const discardCost = parseCardText({ name: "Opfer", typeLine: "Creature", oracleText: "Exile a card from your graveyard: Draw a card." });
    expect(discardCost.activated).toEqual([]);
    expect(discardCost.notes).toHaveLength(1);
    const extra = parseCardText({ name: "Opfer", typeLine: "Creature", oracleText: "Discard a card: Draw a card." });
    expect(extra.activated[0].cost.extra).toEqual([{ kind: "discard", n: 1 }]);
  });
});

describe("cardText: Dauereffekte, Auslöser, Rückblende", () => {
  it("Boni für Kreaturen werden als Dauereffekt erkannt", () => {
    const anthem = parseCardText({ name: "Glorious Anthem", typeLine: "Enchantment", oracleText: "Creatures you control get +1/+1." });
    expect(anthem.statics).toEqual([{ scope: "you", p: 1, th: 1, grants: [] }]);
    expect(anthem.notes).toEqual([]);
    const lord = parseCardText({ name: "Lord", typeLine: "Creature", oracleText: "Other creatures you control get +1/+1 and have flying." });
    expect(lord.statics).toEqual([{ scope: "youOther", p: 1, th: 1, grants: ["flying"] }]);
    expect(parseCardText({ name: "Fluch", typeLine: "Enchantment", oracleText: "Creatures your opponents control get -1/-1." }).statics[0].scope).toBe("opp");
  });

  it("weitere Auslöser", () => {
    const events = text => parseCardText({ name: "X", typeLine: "Creature", oracleText: text }).triggers.map(t => [t.event, t.scope]);
    expect(events("Whenever a creature an opponent controls dies, put a +1/+1 counter on ~.")).toEqual([["creatureDies", { owner: "opp", another: false }]]);
    expect(events("Whenever another creature you control dies, draw a card.")).toEqual([["creatureDies", { owner: "you", another: true }]]);
    expect(events("Whenever a land enters the battlefield under your control, you gain 1 life.")).toEqual([["landEnters", { owner: "you", another: false }]]);
    expect(events("At the beginning of your upkeep, draw a card.")).toEqual([["upkeep", { owner: "you", another: false }]]);
    expect(events("At the beginning of your end step, you gain 1 life.")).toEqual([["endStep", { owner: "you", another: false }]]);
  });

  it("Wühlen/Surveil, Gegner schwächen, Rückblende", () => {
    expect(spell("Dreams", "Instant", "Surveil 1, then draw a card.\nFlashback {3}{U}{U}").effects).toEqual([{ type: "surveil", n: 1 }, { type: "draw", who: { k: "you" }, n: 1 }]);
    expect(parseCardText({ name: "Dreams", typeLine: "Instant", oracleText: "Surveil 1, then draw a card.\nFlashback {3}{U}{U}" }).flashback).toBe("{3}{U}{U}");
    const sephiroth = parseCardText({ name: "Sephiroth", typeLine: "Creature", oracleText: "When Sephiroth enters, creatures your opponents control get -2/-2 until end of turn." });
    expect(sephiroth.triggers[0].effects).toEqual([{ type: "pumpAll", scope: "opp", p: -2, th: -2 }]);
  });
});

describe("cardText: Opferkosten, getappt ins Spiel, Zusammenfassung", () => {
  it("Evolving Wilds: {T}, Opfere diese Karte: Basic Land suchen", () => {
    const wilds = parseCardText({ name: "Evolving Wilds", typeLine: "Land", oracleText: "{T}, Sacrifice Evolving Wilds: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle." });
    expect(wilds.activated).toHaveLength(1);
    expect(wilds.activated[0].cost).toEqual({ tap: true, sacrifice: true, mana: "" });
    expect(wilds.activated[0].effects).toEqual([{ type: "search", what: "basic land", to: "battlefield", tapped: true, count: 1, upTo: false }]);
    expect(wilds.notes).toEqual([]);
  });

  it("kommt getappt ins Spiel", () => {
    const cliffs = parseCardText({ name: "Swiftwater Cliffs", typeLine: "Land", oracleText: "Swiftwater Cliffs enters tapped.\nWhen Swiftwater Cliffs enters, you gain 1 life.\n{T}: Add {U} or {R}." });
    expect(cliffs.entersTapped).toBe(true);
    expect(cliffs.triggers[0]).toMatchObject({ event: "etb", summary: "Du erhältst 1 Leben." });
    expect(cliffs.notes).toEqual([]);
  });

  it("fasst Effekte auf Deutsch zusammen und lässt Unverstandenes im Original", () => {
    const parsed = spell("X", "Sorcery", "Draw two cards. Exile all cards from each graveyard.");
    expect(parsed.summary).toBe("Du ziehst 2 Karten. Exile all cards from each graveyard.");
  });
});

describe("cardText: Länder, die unter Bedingungen getappt ins Spiel kommen", () => {
  const land = text => parseCardText({ name: "Land", typeLine: "Land", oracleText: text });

  it("Zähl-Bedingungen (Slow-, Fast- und Battle-Länder)", () => {
    expect(land("Land enters tapped unless you control two or more other lands.").entersTappedUnless).toEqual({ kind: "lands", n: 2, op: "gte", basic: false });
    expect(land("Land enters the battlefield tapped unless you control two or fewer other lands.").entersTappedUnless).toEqual({ kind: "lands", n: 2, op: "lte", basic: false });
    expect(land("Land enters the battlefield tapped unless you control two or more basic lands.").entersTappedUnless).toMatchObject({ basic: true, op: "gte" });
  });

  it("Landtyp-Bedingung (Check-Länder) und Lebens-Bedingung", () => {
    expect(land("Land enters tapped unless you control a Plains or an Island.").entersTappedUnless).toEqual({ kind: "types", types: ["plains", "island"] });
    expect(land("Land enters the battlefield tapped unless a player has 13 or less life.").entersTappedUnless).toEqual({ kind: "lowLife", n: 13 });
    expect(land("Land enters tapped unless you control a legendary creature.").entersTappedUnless).toEqual({ kind: "controls", legendary: true, type: "creature" });
    expect(land("Land enters tapped unless you control a Gate.").entersTappedUnless).toEqual({ kind: "controls", legendary: false, type: "gate" });
    expect(land("Land enters tapped unless you control three or more tokens.").entersTappedUnless).toBeNull();
    expect(land("Land enters tapped unless you control three or more tokens.").notes).toHaveLength(1);
    expect(land("Land enters tapped unless it's your first, second, or third turn of the game.").entersTappedUnless).toEqual({ kind: "turn", n: 3 });
  });

  it("Shock-Länder und „Karte zeigen“-Länder", () => {
    expect(land("As Land enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped.").shock).toEqual({ life: 2 });
    expect(land("As Land enters the battlefield, you may reveal a Forest or Island card from your hand. If you don't, it enters the battlefield tapped.").reveal).toEqual({ types: ["forest", "island"] });
  });

  it("Bounce-Länder: eigenes Land zurück auf die Hand", () => {
    const karoo = land("Land enters the battlefield tapped.\nWhen Land enters the battlefield, return a land you control to its owner's hand.\n{T}: Add {R}{G}.");
    expect(karoo.entersTapped).toBe(true);
    expect(karoo.triggers[0].effects).toEqual([{ type: "bounceOwnLand" }]);
  });
});

describe("cardText: Modi, X-Werte, Cycling", () => {
  it("Modale Zauber: ein Modus pro Aufzählungspunkt", () => {
    const parsed = spell("Cryptic", "Instant", "Choose one —\n• Counter target spell.\n• Draw a card.");
    expect(parsed.modes).toHaveLength(2);
    expect(parsed.modes[0]).toMatchObject({ label: "Counter target spell.", effects: [{ type: "counterSpell", t: 0 }], specs: [{ kind: "spell" }] });
    expect(parsed.modes[1].effects).toEqual([{ type: "draw", who: { k: "you" }, n: 1 }]);
  });

  it("X als Menge", () => {
    expect(spell("Flut", "Sorcery", "Draw X cards.").effects).toEqual([{ type: "draw", who: { k: "you" }, n: "X" }]);
    expect(spell("Feuer", "Sorcery", "Feuer deals X damage to each opponent.").effects).toEqual([{ type: "damage", n: "X", to: { k: "eachOpp" } }]);
    expect(spell("Drain", "Sorcery", "Target opponent loses X life.").effects[0]).toMatchObject({ n: "X", negate: true });
    expect(spell("Flut", "Sorcery", "Draw X cards.").summary).toBe("Du ziehst X Karten.");
  });

  it("Cycling und Landcycling", () => {
    expect(parseCardText({ name: "Karte", typeLine: "Creature", oracleText: "Flying\nCycling {2}" }).cycling).toEqual({ cost: "{2}", search: null });
    expect(parseCardText({ name: "Karte", typeLine: "Creature", oracleText: "Basic landcycling {1}" }).cycling).toEqual({ cost: "{1}", search: "basic land" });
    expect(parseCardText({ name: "Karte", typeLine: "Instant", oracleText: "Draw a card.\nCycling {1}" }).spell.effects).toHaveLength(1);
  });
});

describe("cardText: neue Mechaniken (Station, Encore, allgemeine Auslöser)", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Station: Fähigkeit, Schwelle als Kreatur und Stufen", () => {
    const parsed = parse("Artifact — Spacecraft", "Station (Tap another creature you control: Put charge counters equal to its power on this Spacecraft. Station only as a sorcery. It's an artifact creature at 8+.)\n1+ | Whenever you draw a card, you gain 1 life.\n8+ | Flying\nOther artifacts you control have hexproof.");
    expect(parsed.station).toEqual({ at: 8 });
    expect(parsed.activated[0]).toMatchObject({ sorcery: true, effects: [{ type: "station" }] });
    expect(parsed.tiers).toEqual([{ n: 8, kws: ["flying"] }]);
    expect(parsed.triggers[0]).toMatchObject({ event: "youDraw", minCharge: 1 });
  });

  it("Encore/Eternalize/Embalm sind Fähigkeiten aus dem Friedhof", () => {
    for (const word of ["Encore", "Eternalize", "Embalm"]) {
      const parsed = parse("Creature — Spirit", `${word} {2}{B}`);
      expect(parsed.activated[0]).toMatchObject({ zone: "graveyard", sorcery: true, cost: { mana: "{2}{B}", exileSelf: true }, effects: [{ type: "copyToken", mode: word.toLowerCase() }] });
    }
  });

  it("Auslöser nach Zauberart, Nichtspielstein, zweiter Karte und mehreren Kreaturen", () => {
    const events = text => parse("Creature — X", text).triggers.map(trigger => trigger.event);
    expect(events("Whenever you cast an instant or sorcery spell, draw a card.")).toEqual(["castKind"]);
    expect(events("Whenever a nontoken creature you control dies, draw a card.")).toEqual(["creatureDies"]);
    expect(events("Whenever you draw your second card each turn, draw a card.")).toEqual(["youDrawSecond"]);
    expect(events("Whenever one or more creatures you control deal combat damage to a player, draw a card.")).toEqual(["creaturesDealDamage"]);
    expect(events("Whenever a land you control enters, proliferate.")).toEqual(["landEnters"]);
  });

  it("Erkunden, Einfrieren, Marker verdoppeln, Gratis-Zauber, Partner", () => {
    const parsed = parse("Creature — X", "Whenever a creature you control enters, it explores.\nWhenever ~ attacks, double the number of each kind of counter on target creature.");
    expect(parsed.triggers[0].effects).toEqual([{ type: "explore", who: "subject" }]);
    expect(parsed.triggers[1].effects).toEqual([{ type: "doubleCounters", t: 0 }]);
    expect(parse("Sorcery", "If you control a commander, you may cast ~ without paying its mana cost.\nDraw a card.").freeWithCommander).toBe(true);
    expect(parse("Legendary Creature — X", "Partner—Character select").notes).toEqual([]);
  });
});

describe("cardText: Mutate", () => {
  it("Mutate-Kosten und „whenever this creature mutates“", () => {
    const parsed = parseCardText({ name: "Biest", typeLine: "Creature — Beast", oracleText: "Mutate {3}{U} (If you cast this spell for its mutate cost, put it over or under target non-Human creature you own.)\nFlying\nWhenever this creature mutates, draw a card." });
    expect(parsed.mutate).toBe("{3}{U}");
    expect(parsed.triggers[0]).toMatchObject({ event: "mutates", effects: [{ type: "draw" }] });
    expect(parsed.notes).toEqual([]);
  });
});

describe("cardText: weitere Lücken (Kopieren, Skulk, Stufen, Einzelzeilen)", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Zauber kopieren und „choose new targets“", () => {
    const parsed = parse("Creature — X", "Whenever you cast an instant or sorcery spell, you may copy that spell. You may choose new targets for the copy.");
    expect(parsed.triggers[0]).toMatchObject({ event: "castKind", unparsed: [] });
    expect(parse("Creature — X", "When ~ enters, copy target instant or sorcery spell.").triggers[0].effects[0]).toMatchObject({ type: "copySpell", n: 1 });
  });

  it("Delve/Convoke bei Kreaturen, Skulk-Text, Marker-Dauereffekt, Ausrüstung je Artefakt, Stärke aus Friedhof", () => {
    const parsed = parse("Creature — X", "Delve\n~ can't be blocked by creatures with greater power.\nEach creature you control with a +1/+1 counter on it has trample.\n~'s power is equal to the number of land cards in your graveyard.");
    expect(parsed.delve).toBe(true);
    expect(parsed.selfGrants).toContain("skulk");
    expect(parsed.statics[0]).toMatchObject({ counter: "+1/+1", grants: ["trample"] });
    expect(parsed.dynamicPT).toMatchObject({ powerOnly: true });
    expect(parse("Artifact — Equipment", "Equipped creature gets +1/+1 for each artifact you control.").attachPer).toEqual({ p: 1, th: 1, per: "artifact you control" });
  });

  it("Auslöser: „~ or another creature you control dies“, zweiter Zauber, am Ausgerüsteten", () => {
    expect(parse("Creature — X", "Whenever ~ or another creature you control dies, draw a card.").triggers[0]).toMatchObject({ event: "creatureDies", scope: { owner: "you", another: false } });
    expect(parse("Creature — X", "Whenever you cast your second spell each turn, draw a card.").triggers[0].event).toBe("castSecond");
    expect(parse("Artifact — Equipment", "Whenever equipped creature attacks, you scry 2.").triggers[0]).toMatchObject({ event: "attachedAttacks", effects: [{ type: "scry", n: 2 }] });
  });

  it("Filter wie Zielangaben: Marker, „without“, „that entered this turn“; allgemeine Auslöser und Marker auf „each …“", () => {
    expect(parse("Enchantment", "Whenever a creature you control with a +1/+1 counter on it dies, draw a card.").triggers[0]).toMatchObject({ event: "creatureDies", scope: { owner: "you", spec: { kind: "creature", counter: "+1/+1" } } });
    expect(parse("Enchantment", "Whenever a creature you control without flying dies, draw a card.").triggers[0].scope.spec).toMatchObject({ noKeyword: "flying" });
    expect(parse("Enchantment", "Whenever a green creature you control enters, draw a card.").triggers[0]).toMatchObject({ event: "creatureEnters", scope: { owner: "you", spec: { colors: ["G"] } } });
    expect(parse("Enchantment", "Whenever an artifact creature an opponent controls attacks, draw a card.").triggers[0]).toMatchObject({ event: "creatureAttacks", scope: { owner: "opp" } });
    expect(parse("Enchantment", "Whenever an artifact you control attacks, draw a card.").triggers).toEqual([]); // „attacks“ nur für Kreaturen
    expect(parse("Sorcery", "Put a +1/+1 counter on each artifact creature you control.").spell.effects[0]).toMatchObject({ type: "countersEach", spec: { types: ["artifact"], ctrl: "you" } });
    expect(parse("Creature — Elf", "~ gets +1/+0 for each artifact you control.").statics[0]).toMatchObject({ scope: "self", perQ: { p: 1, th: 0 } });
  });

  it("Goad-Sätze", () => {
    expect(parse("Instant", "Goad target creature.").spell.effects).toEqual([{ type: "goad", t: 0 }]);
    expect(parse("Sorcery", "Goad all creatures you don't control.").spell.effects).toEqual([{ type: "goad", all: true }]);
    expect(parse("Sorcery", "Goad each creature target player controls.").spell.effects).toEqual([{ type: "goad", eachOfTarget: 0 }]);
    const two = parse("Sorcery", "Goad up to two target creatures.").spell;
    expect(two.effects).toHaveLength(2);
    expect(two.specs.every(spec => spec.optional)).toBe(true);
    expect(parse("Sorcery", "Goad up to X target creatures.").spell.unparsed).toHaveLength(1);
  });

  it("Mehrfach-Modi: „Choose two“, „one or more“, „both“ mit Kommandant, modaler Auslöser mit zwei Modi", () => {
    expect(parse("Sorcery", "Choose two —\n• Draw a card.\n• You gain 3 life.\n• Scry 2.").spell.modeCount).toEqual({ min: 2, max: 2 });
    expect(parse("Sorcery", "Choose one or more —\n• Draw a card.\n• You gain 3 life.").spell.modeCount).toEqual({ min: 1, max: 2 });
    expect(parse("Instant", "Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Draw a card.\n• Gain 3 life.").spell.modeCount).toMatchObject({ min: 1, max: 1, commanderMax: 2 });
    expect(parse("Instant", "Choose one —\n• Draw a card.\n• Gain 3 life.").spell.modeCount).toBeUndefined();
    const titan = parse("Creature — Giant", "When ~ enters, choose two —\n• Draw a card.\n• You gain 3 life.\n• Scry 1.").triggers[0];
    expect(titan.pick).toBe(2);
    expect(titan.modes).toHaveLength(3);
  });

  it("Einzeilige Modi, Länder mit „unless … eight or more lands“, Suche nach Basisländern", () => {
    expect(parse("Instant", "Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Draw a card.\n• Gain 3 life.").spell.modes).toHaveLength(2);
    expect(parse("Land", "~ enters tapped unless your opponents control eight or more lands.").entersTappedUnless).toEqual({ kind: "oppLands", n: 8 });
    expect(parse("Sorcery", "Search your library for a basic Plains, Island, or Swamp card, put it onto the battlefield tapped, then shuffle").spell.effects[0]).toMatchObject({ type: "search", what: "plains|island|swamp", tapped: true });
  });
});

describe("cardText: Auslöser der Gegner und Sammelmarker", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Gegner wirkt Spontanzauber, ein Vampir stirbt, Marker auf alle Angreifer, ~ kann nicht neutralisiert werden", () => {
    expect(parse("Creature — X", "Whenever an opponent casts an instant or sorcery spell, draw a card.").triggers[0]).toMatchObject({ event: "castKind", scope: { owner: "opp" } });
    expect(parse("Creature — X", "Whenever a Vampire you control dies, you gain 2 life.").triggers[0]).toMatchObject({ event: "creatureDies", scope: { subtype: "vampire", another: false } });
    expect(parse("Creature — X", "Whenever ~ attacks, put a +1/+1 counter on each attacking creature you control.").triggers[0].effects[0]).toMatchObject({ type: "countersAll", attacking: true });
    expect(parse("Instant", "This spell can't be countered.\nDraw a card.").uncounterable).toBe(true);
  });
});

describe("cardText: Sagas, Marker-Arten und Einzeltexte", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Saga: Kapitel werden zu Auslösern mit Nummer, höchstes Kapitel = Opferpunkt", () => {
    const parsed = parse("Enchantment — Saga", "(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Aerospark — Draw a card.\nII, III — You gain 2 life.");
    expect(parsed.saga).toEqual({ max: 3 });
    expect(parsed.triggers.map(trigger => [trigger.event, trigger.chapter])).toEqual([["chapter", 1], ["chapter", 2], ["chapter", 3]]);
    expect(parsed.notes).toEqual([]);
  });

  it("Schildmarker, Betäubungsmarker, alle Friedhöfe exilieren, „you and target opponent each draw“", () => {
    expect(parse("Sorcery", "Put a stun counter on target creature.").spell.effects[0]).toMatchObject({ type: "counters", kind: "stun" });
    expect(parse("Sorcery", "Put a shield counter on target creature.").spell.effects[0]).toMatchObject({ kind: "shield" });
    expect(parse("Sorcery", "Exile all graveyards.").spell.effects).toEqual([{ type: "exileAllGraveyards" }]);
    expect(parse("Sorcery", "You and target opponent each draw three cards.").spell.effects).toHaveLength(2);
  });
});

describe("cardText: Marker-Paket, Hideaway, Storm, Support, Madness, modale Auslöser", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Marker: verschieben, „put counters on a creature“, Bonus beim Eintritt, Filter nach Markern", () => {
    expect(parse("Sorcery", "Move a counter from target creature you control onto a second target creature you control.").spell.effects[0]).toMatchObject({ type: "moveCounter", from: 0, to: 1 });
    expect(parse("Creature — X", "Whenever you put one or more counters on a creature, draw a card.").triggers[0].event).toBe("countersPut");
    expect(parse("Creature — X", "Whenever a creature you control with a +1/+1 counter on it deals combat damage to a player, draw a card.").triggers[0]).toMatchObject({ event: "creatureDealsCombatDamage", scope: { counter: "+1/+1" } });
    expect(parse("Creature — X", "Each other nontoken creature you control enters with an additional +1/+1 counter on it.").etbBonus).toEqual({ kind: "+1/+1", nontoken: true });
  });

  it("Hideaway, Storm, Support, Madness, Job select", () => {
    const land = parse("Land", "Hideaway 4\n{G}, {T}: You may play the exiled card without paying its mana cost if creatures you control have total power 10 or greater.");
    expect(land.triggers[0].effects[0]).toMatchObject({ type: "hideaway", n: 4 });
    expect(land.activated[0].effects[0]).toMatchObject({ type: "playHidden", cond: { kind: "totalPower", n: 10 } });
    expect(parse("Sorcery", "Draw a card.\nStorm").storm).toBe(true);
    expect(parse("Creature — X", "Support 2").triggers[0].effects).toHaveLength(2);
    expect(parse("Creature — X", "Madness {1}{R}").madness).toEqual({ cost: "{1}{R}", life: 0 });
    expect(parse("Artifact — Equipment", "Job select").triggers[0].effects[0].type).toBe("jobSelect");
  });

  it("Modaler Auslöser: „When ~ enters, choose one —“ mit Aufzählung", () => {
    const parsed = parse("Creature — X", "When ~ enters, choose one —\n• Draw a card.\n• You gain 3 life.");
    expect(parsed.triggers[0]).toMatchObject({ event: "etb" });
    expect(parsed.triggers[0].modes).toHaveLength(2);
    expect(parsed.notes).toEqual([]);
  });
});

describe("cardText: Star-Trek- und Final-Fantasy-Paket", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Typ-Dauereffekte, verliehene Auslöser, Evasion, Unearth, Affinity für Typen", () => {
    expect(parse("Creature — X", "Klingons and Warriors you control have vigilance.").statics[0]).toMatchObject({ anyOf: ["klingon", "warrior"], grants: ["vigilance"] });
    expect(parse("Artifact", "Historic creatures you control have flying.").statics[0]).toMatchObject({ anyOf: ["artifact", "legendary"] });
    expect(parse("Artifact", "Artifact creatures you control have \"Whenever this creature deals combat damage to a player, draw a card.\"").grantedTriggers[0]).toMatchObject({ what: "artifact", trigger: { event: "dealsCombatDamage" } });
    expect(parse("Creature — X", "~ can't be blocked by creatures with power 2 or less.").blockMinPower).toBe(3);
    expect(parse("Creature — X", "Unearth {3}{B}").activated[0]).toMatchObject({ zone: "graveyard", effects: [{ type: "unearth" }] });
    expect(parse("Creature — X", "Affinity for Vulcans").costReduction).toEqual({ amount: 1, per: "vulcan", mine: true });
  });

  it("Einzeltexte der Decks", () => {
    expect(parse("Instant", "Counter target noncreature spell. Its controller creates two Treasure tokens.").spell.effects[1]).toMatchObject({ type: "namedToken", n: 2, forTargetController: 0 });
    expect(parse("Sorcery", "Destroy target artifact, target creature, target enchantment, and target land.").spell.specs).toHaveLength(4);
    expect(parse("Sorcery", "Destroy all creatures with no counters on them.").spell.effects[0]).toMatchObject({ noCounters: true });
    expect(parse("Sorcery", "Each player shuffles their hand and graveyard into their library, then draws seven cards.").spell.effects[0]).toEqual({ type: "wheel", n: 7 });
    expect(parse("Creature — X", "When ~ enters, destroy up to one target artifact or enchantment.").triggers[0].specs[0]).toMatchObject({ optional: true });
    expect(parse("Artifact", "At the beginning of each player's draw step, if ~ is untapped, that player draws an additional card.").triggers[0]).toMatchObject({ event: "drawStep", effects: [{ type: "ifCond", cond: { kind: "selfUntapped" } }] });
    expect(parse("Instant", "You gain 2 life, draw two cards, then discard two cards.").spell.effects.map(effect => effect.type)).toEqual(["life", "draw", "discard"]);
  });
});

describe("cardText: Star Trek/FF Runde 2", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Aktivierte Fähigkeit mit Modi wird in einzelne Fähigkeiten geteilt; Reanimation mit Filter", () => {
    const parsed = parse("Artifact", "{1}{W}, {T}, Exile ~: Choose one —\n• Return target creature card with mana value 4 or less from your graveyard to the battlefield tapped.\n• Exile target Skeleton, Spirit, or Zombie.");
    expect(parsed.activated).toHaveLength(2);
    expect(parsed.activated[0]).toMatchObject({ cost: { exileSelf: true }, effects: [{ type: "reanimate", tapped: true }], specs: [{ kind: "gyCreature", mvMax: 4 }] });
    expect(parsed.activated[1].specs[0]).toMatchObject({ subtypes: ["skeleton", "spirit", "zombie"] });
  });

  it("Kosten: Marker von beliebigem Permanent, Artefaktkreatur opfern, Karte aus der Hand abwerfen", () => {
    expect(parse("Creature — X", "{T}, Remove a counter from a nonland permanent you control: Draw a card.").activated[0].cost.extra[0]).toMatchObject({ kind: "removeAnyCounter", nonland: true });
    expect(parse("Creature — X", "{1}, Sacrifice an artifact creature: Draw a card.").activated[0].cost.extra[0]).toMatchObject({ kind: "sacrifice", artifactCreature: true });
    expect(parse("Creature — X", "{W}{B}, Discard this card: It deals 2 damage to target creature. You gain 2 life.").activated[0]).toMatchObject({ zone: "hand", cost: { discardSelf: true }, effects: [{ type: "damage" }, { type: "life" }] });
  });

  it("Auslöser und Einzeltexte", () => {
    expect(parse("Creature — X", "Whenever an Equipment you control enters, create a 2/2 red Rebel creature token.").triggers[0]).toMatchObject({ event: "permanentEnters", scope: { permType: "equipment" } });
    expect(parse("Creature — X", "Whenever another Klingon or Warrior you control enters, ~ deals 1 damage to each opponent.").triggers[0].scope).toMatchObject({ anyOf: ["klingon", "warrior"], another: true });
    expect(parse("Creature — X", "Klingon spells and Warrior spells you cast cost {1} less to cast.").costMod).toMatchObject({ anyOf: ["klingon", "warrior"] });
    expect(parse("Artifact", "~ enters with two charge counters on it.").entersWithCounters).toEqual({ n: 2, kind: "charge" });
    expect(parse("Sorcery", "Exile up to two target creatures.").spell.specs).toHaveLength(2);
    expect(parse("Creature — X", "When ~ enters, support 2.").triggers[0].effects).toHaveLength(2);
    expect(parse("Sorcery", "Look at the top seven cards of your library. Put two of them into your hand and the rest on the bottom of your library in any order.").spell.unparsed).toEqual([]);
    expect(parse("Creature — X", "When ~ enters, you may discard your hand. If you do, draw a card for each card discarded this way.").triggers[0].unparsed).toEqual([]);
  });
});

describe("cardText: Star Trek/FF Runde 3", () => {
  const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });

  it("Kommandant/Angriff-Auslöser, Marker-Kosten, Eintritts-Marker, Token-Anthem", () => {
    expect(parse("Artifact", "Whenever your commander enters or attacks, put a page counter on ~.").triggers.map(t => [t.event, t.scope.commander])).toEqual([["creatureEnters", true], ["creatureAttacks", true]]);
    expect(parse("Creature — X", "Whenever a creature you control attacks, you gain 1 life.").triggers[0].event).toBe("creatureAttacks");
    expect(parse("Artifact", "{T}, Remove a counter from ~: Draw a card.").activated[0].cost.extra[0]).toMatchObject({ kind: "removeCounter", counter: "any" });
    expect(parse("Artifact", "~ enters with a page counter on it.").entersWithCounters).toEqual({ n: 1, kind: "page" });
    expect(parse("Creature — X", "Creature tokens you control get +1/+1.").statics[0]).toMatchObject({ tokenOnly: true, p: 1, th: 1 });
    expect(parse("Artifact Creature — Golem", "~'s power is equal to the number of artifacts you control.").dynamicPT).toMatchObject({ per: "artifact you control", powerOnly: true });
  });

  it("Spruchtexte: Drachen zerstören, Syphon Mind, Satyr Wayfinder, „for each attacking creature“", () => {
    expect(parse("Sorcery", "Destroy all non-Dragon creatures.").spell.effects[0]).toMatchObject({ type: "destroyAll", nonSubtype: "dragon" });
    expect(parse("Sorcery", "Each other player discards a card. You draw a card for each card discarded this way.").spell.unparsed).toEqual([]);
    expect(parse("Creature — X", "When ~ enters, reveal the top four cards of your library. You may put a land card from among them into your hand. Put the rest into your graveyard.").triggers[0].unparsed).toEqual([]);
    expect(parse("Instant", "Draw a card for each attacking creature.").spell.effects[0]).toMatchObject({ per: "attacking creature" });
  });
});

describe("cardText: Kurznamen legendärer Karten und weitere Satzformen", () => {
  it("„Loran“ steht für „Loran of the Third Path“, „Lieutenant Sulu“ für „Lieutenant Hikaru Sulu“", () => {
    const loran = parseCardText({ name: "Loran of the Third Path", typeLine: "Legendary Creature — Human Artificer", oracleText: "When Loran enters, destroy up to one target artifact or enchantment." });
    expect(loran.triggers[0]).toMatchObject({ event: "etb", effects: [{ type: "destroy" }] });
    const sulu = parseCardText({ name: "Lieutenant Hikaru Sulu", typeLine: "Legendary Creature — Human Soldier", oracleText: "Whenever Lieutenant Sulu becomes tapped, he explores." });
    expect(sulu.triggers[0].event).toBe("becomesTapped");
    // nicht legendär: keine Kurzform
    const plain = parseCardText({ name: "Goblin Guide", typeLine: "Creature — Goblin", oracleText: "Whenever a Goblin you control attacks, draw a card." });
    expect(plain.triggers[0]?.event).not.toBe("attacks");
  });

  it("„Then …“, „those creatures get …“, „you may sacrifice it“", () => {
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    expect(parse("Creature — X", "When ~ enters, draw a card. Then put a +1/+1 counter on ~ for each creature you control.").triggers[0].unparsed).toEqual([]);
    expect(parse("Creature — X", "Whenever you attack with three or more creatures, those creatures get +1/+1 until end of turn.").triggers[0].effects[0]).toMatchObject({ type: "pumpAll", attackingOnly: true });
    expect(parse("Artifact", "At the beginning of your end step, you may sacrifice it.").triggers[0].effects[0]).toMatchObject({ type: "may" });
  });
});
