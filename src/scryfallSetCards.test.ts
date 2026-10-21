import { afterEach, describe, expect, it, vi } from "vitest";
import { getSetCards } from "./scryfall";

const card = (id: string, cn: string) => ({ id, name: `Karte ${cn}`, set: "tst", collector_number: cn });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSetCards", () => {
  it("liest alle Seiten, sortiert nach Sammlernummer und nutzt einen Cache", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(
        calls.length === 1
          ? { data: [card("c", "10"), card("a", "2")], has_more: true, next_page: "https://api.scryfall.com/cards/search?page=2" }
          : { data: [card("b", "1")], has_more: false }
      ));
    }));

    const cards = await getSetCards("TST");
    expect(cards.map(c => c.id)).toEqual(["b", "a", "c"]);

    const first = new URL(calls[0]);
    expect(first.searchParams.get("q")).toBe("e:tst");
    expect(first.searchParams.get("unique")).toBe("prints");
    expect(first.searchParams.get("include_extras")).toBe("true");
    expect(calls[1]).toContain("page=2");

    await getSetCards("tst");
    expect(calls).toHaveLength(2);
  });

  it("gibt bei 404 (keine Treffer) eine leere Liste zurück", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await getSetCards("nix")).toEqual([]);
  });

  it("lehnt ungültige Set-Codes ab", async () => {
    await expect(getSetCards("a b")).rejects.toThrow("Ungültiger Set-Code");
    await expect(getSetCards("")).rejects.toThrow("Ungültiger Set-Code");
  });
});
