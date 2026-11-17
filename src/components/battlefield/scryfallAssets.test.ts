import { describe, expect, it } from "vitest";
import { costSymbols, imageFor, symbolCode, symbolUrl } from "./scryfallAssets";

describe("scryfallAssets", () => {
  it("stellt Kartenbilder auf die gewünschte Größe um", () => {
    const url = "https://cards.scryfall.io/normal/front/a/b/abc.jpg?1700000000";
    expect(imageFor(url, "small")).toBe("https://cards.scryfall.io/small/front/a/b/abc.jpg?1700000000");
    expect(imageFor(url, "large")).toBe("https://cards.scryfall.io/large/front/a/b/abc.jpg?1700000000");
    expect(imageFor("https://example.com/bild.jpg", "large")).toBe("https://example.com/bild.jpg");
    expect(imageFor(null, "normal")).toBeNull();
  });

  it("bildet Symbole auf die offiziellen Dateien ab", () => {
    expect(symbolCode("{W/U}")).toBe("WU");
    expect(symbolCode("{2/W}")).toBe("2W");
    expect(symbolCode("{t}")).toBe("T");
    expect(symbolUrl("{G}")).toBe("https://svgs.scryfall.io/card-symbols/G.svg");
    expect(symbolUrl("{G/P}")).toBe("https://svgs.scryfall.io/card-symbols/GP.svg");
  });

  it("zerlegt Manakosten", () => {
    expect(costSymbols("{2}{W}{U/B}")).toEqual(["{2}", "{W}", "{U/B}"]);
    expect(costSymbols("")).toEqual([]);
    expect(costSymbols(undefined)).toEqual([]);
  });
});
