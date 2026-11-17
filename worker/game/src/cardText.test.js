import { describe, expect, it } from "vitest";
import { parseCardText } from "./cardText.js";

const spell = (name, typeLine, oracleText) => parseCardText({ name, typeLine, oracleText }).spell;

describe("cardText: Zauber", () => {
  it("Lightning Bolt: Schaden auf ein beliebiges Ziel", () => {
    const parsed = spell("Lightning Bolt", "Instant", "Lightning Bolt deals 3 damage to any target.");
    expect(parsed).toEqual({ effects: [{ type: "damage", n: 3, to: { k: "target", t: 0 } }], specs: [{ kind: "any" }], unparsed: [] });
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
      .toEqual([{ type: "search", what: "basic land", to: "battlefield", tapped: true }]);
    expect(spell("Raise Dead", "Sorcery", "Return target creature card from your graveyard to your hand.").effects)
      .toEqual([{ type: "gyReturn", what: "creature", to: "hand" }]);
    expect(spell("Dark Ritual", "Instant", "Add {B}{B}{B}.").effects).toEqual([{ type: "mana", symbols: ["B", "B", "B"] }]);
    expect(spell("Raise the Alarm", "Instant", "Create two 1/1 white Soldier creature tokens.").effects)
      .toEqual([{ type: "token", n: 2, p: 1, th: 1, name: "Soldier" }]);
  });

  it("alles Unverstandene bleibt unausgeführt und wird gemeldet", () => {
    expect(spell("Doom Blade", "Instant", "Destroy target nonblack creature.")).toMatchObject({ effects: [], unparsed: ["Destroy target nonblack creature"] });
    expect(spell("Cryptic", "Instant", "Choose one —\n• Counter target spell.\n• Draw a card.").unparsed).toHaveLength(1);
    const mixed = spell("Mix", "Sorcery", "Draw a card. Each player sacrifices a creature.");
    expect(mixed.effects).toHaveLength(1);
    expect(mixed.unparsed).toEqual(["Each player sacrifices a creature"]);
  });
});

describe("cardText: Permanents", () => {
  it("Einfach-Auslöser beim Betreten", () => {
    const parsed = parseCardText({ name: "Elvish Visionary", typeLine: "Creature — Elf Shaman", oracleText: "When Elvish Visionary enters the battlefield, draw a card." });
    expect(parsed.triggers).toEqual([
      { event: "etb", text: "When ~ enters the battlefield, draw a card.", effects: [{ type: "draw", who: { k: "you" }, n: 1 }], specs: [], unparsed: [] }
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
    expect(flier).toEqual({ spell: null, triggers: [], activated: [], notes: [] });
    const pw = parseCardText({ name: "Jace", typeLine: "Legendary Planeswalker — Jace", oracleText: "+1: Draw a card.\n−3: Return target creature to its owner's hand." });
    expect(pw.activated.map(a => a.cost.loyalty)).toEqual([1, -3]);
    expect(pw.activated[1].effects[0]).toMatchObject({ type: "bounce" });
  });

  it("Dauereffekte und Sonderkosten werden als Hinweis geführt", () => {
    const anthem = parseCardText({ name: "Glorious Anthem", typeLine: "Enchantment", oracleText: "Creatures you control get +1/+1." });
    expect(anthem.notes).toEqual(["Creatures you control get +1/+1."]);
    const elder = parseCardText({ name: "Sakura-Tribe Elder", typeLine: "Creature", oracleText: "Sacrifice Sakura-Tribe Elder: Search your library for a basic land card." });
    expect(elder.activated).toEqual([]);
    expect(elder.notes).toHaveLength(1);
  });
});
