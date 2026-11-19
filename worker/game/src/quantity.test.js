import { describe, expect, it } from "vitest";
import { parseCardText } from "./cardText.js";
import { attachQuantity, parseQuantity, rewriteEqualTo, singular } from "./quantity.js";

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
    expect(parseQuantity("the life lost this way", spec)).toBeNull();
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
});
