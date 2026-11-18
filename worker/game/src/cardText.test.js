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
    expect(spell("Doom Blade", "Instant", "Destroy target creature with a +1/+1 counter on it.")).toMatchObject({ effects: [], unparsed: ["Destroy target creature with a +1/+1 counter on it"] });
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
