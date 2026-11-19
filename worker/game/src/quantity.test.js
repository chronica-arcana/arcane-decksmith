import { describe, expect, it } from "vitest";
import { parseCardText } from "./cardText.js";
import { attachQuantity, parseCondition, parseQuantity, rewriteEqualTo, singular } from "./quantity.js";

const spec = phrase => ({ phrase });

describe("quantity: Mengenangaben", () => {
  it("erkennt Werte, Zählungen und Verdopplung", () => {
    expect(parseQuantity("its power", spec)).toEqual({ kind: "stat", ref: "it", stat: "power" });
    expect(parseQuantity("~'s toughness", spec)).toEqual({ kind: "stat", ref: "self", stat: "toughness" });
    expect(parseQuantity("twice the number of cards in your hand", spec)).toEqual({ kind: "zone", zone: "hand", mult: 2 });
    expect(parseQuantity("the number of Vampires you control", spec)).toEqual({ kind: "count", spec: { phrase: "target vampire" }, who: "you" });
    expect(parseQuantity("the number of +1/+1 counters on ~", spec)).toEqual({ kind: "counters", counter: "+1/+1", ref: "self" });
    expect(parseQuantity("the greatest power among creatures you control", spec)).toMatchObject({ kind: "greatest", stat: "power", what: "creature" });
    expect(parseQuantity("the number of opponents you attacked this turn", spec)).toEqual({ kind: "oppAttacked" });
  });

  it("lehnt Unbekanntes ab (kein Raten)", () => {
    expect(parseQuantity("the number of colors of mana spent to cast ~", spec)).toBeNull();
    expect(parseQuantity("the amount of mana spent to cast it", spec)).toBeNull();
  });

  it("formt „equal to“ in die X-Form um und hängt die Menge an X-Effekte", () => {
    expect(rewriteEqualTo("~ deals damage equal to its power to any target")).toEqual({ text: "~ deals X damage to any target", quantity: "its power" });
    expect(rewriteEqualTo("You gain life equal to the number of creatures you control")).toEqual({ text: "You gain X life", quantity: "the number of creatures you control" });
    expect(attachQuantity([{ type: "draw", n: "X" }, { type: "draw", n: 1 }], { kind: "opponents" })).toEqual([{ type: "draw", n: "X", xRef: { kind: "opponents" } }, { type: "draw", n: 1 }]);
    expect(singular("artifact creatures")).toBe("artifact creature");
  });

  it("Kartentexte mit „where X is“ und „equal to“ werden verstanden", () => {
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    expect(parse("Creature — X", "When ~ enters, create X 1/1 colorless Borg artifact creature tokens, where X is its power.").triggers[0].effects[0]).toMatchObject({ type: "token", n: "X", xRef: { kind: "stat" } });
    expect(parse("Creature — X", "When ~ enters, you gain life equal to the number of creatures you control.").triggers[0].effects[0]).toMatchObject({ type: "life", xRef: { kind: "count", who: "you" } });
    expect(parse("Sorcery", "Draw cards equal to the greatest power among creatures you control.").spell.unparsed).toEqual([]);
  });

  it("„for each <Filter>“ mit dem Mengen-Baustein", () => {
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    expect(parse("Creature — X", "When ~ enters, put a +1/+1 counter on ~ for each Vampire you control.").triggers[0].effects[0]).toMatchObject({ type: "counters", perQ: { kind: "count", who: "you" } });
    expect(parse("Sorcery", "Draw a card for each opponent you attacked this turn.").spell.effects[0]).toMatchObject({ perQ: { kind: "oppAttacked" } });
  });

  it("„When you do“ wie „If you do“, Opfern als Teil eines Effekts, Rückkehr aus dem Friedhof", () => {
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    const parsed = parse("Creature — X", "At the beginning of your end step, you may sacrifice another creature. When you do, draw a card.");
    expect(parsed.triggers[0].effects.map(effect => effect.type)).toEqual(["may", "ifDid"]);
    expect(parse("Creature — X", "Whenever you sacrifice a creature, return this card from your graveyard to your hand.").notes.length + parse("Sorcery", "Return this card from your graveyard to your hand.").spell.unparsed.length).toBeLessThanOrEqual(1);
  });

  it("Bedingungen werden erkannt; Unbekanntes bleibt offen", () => {
    expect(parseCondition("you control three or more artifacts", spec)).toEqual({ kind: "controls", n: 3, spec: { phrase: "target artifact" }, other: false });
    expect(parseCondition("you gained 7 or more life this turn", spec)).toEqual({ kind: "gainedLife", n: 7 });
    expect(parseCondition("you're the monarch", spec)).toEqual({ kind: "monarch" });
    expect(parseCondition("it was kicked", spec)).toBeNull();
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    expect(parse("Creature — X", "At the beginning of your end step, if you gained life this turn, draw a card.").triggers[0].effects[0]).toMatchObject({ type: "ifCond", cond: { kind: "gainedLife" } });
  });

  it("„A, then B“, Spielsteine mit „can't block“, „during your turn … have hexproof“, Wert des geopferten Permanents", () => {
    const parse = (typeLine, oracleText) => parseCardText({ name: "Karte", typeLine, oracleText });
    expect(parse("Sorcery", "Draw a card, then creatures you control get +1/+1 until end of turn.").spell.effects.map(effect => effect.type)).toEqual(["draw", "pumpAll"]);
    expect(parse("Creature — X", "When ~ enters, create X 1/1 white Tribble creature tokens with \"This token can't block,\" where X is ~'s power.").triggers[0].effects[0]).toMatchObject({ type: "token", keywords: ["cant-block"], xRef: { kind: "stat", ref: "self" } });
    expect(parse("Artifact — Spacecraft", "During your turn, ~ and creatures you control have hexproof.").statics[0]).toMatchObject({ duringYourTurn: true, grants: ["hexproof"] });
    expect(parse("Creature — X", "Whenever ~ attacks, you may sacrifice an artifact. If you do, each opponent loses life equal to the mana value of the sacrificed permanent.").triggers[0].unparsed).toEqual([]);
  });
});
