import { describe, expect, it, vi } from "vitest";
import { buildDef, fetchScryfallFacts, keywordsOf, manaSourceOf, parseManaCost, typesOf } from "./cardFacts.js";
import { describeCost, emptyPool, planPayment } from "./manaPayment.js";

describe("cardFacts", () => {
  it("Typen", () => {
    expect(typesOf("Legendary Creature — Elf Druid")).toMatchObject({ creature: true, legendary: true, land: false });
    expect(typesOf("Basic Land — Forest")).toMatchObject({ land: true, basicLand: true });
    expect(typesOf("Instant")).toMatchObject({ instant: true });
    expect(typesOf("Artifact Creature — Golem // Land")).toMatchObject({ creature: true, land: false });
  });

  it("Schlüsselwörter aus Liste und Text", () => {
    expect(keywordsOf({ keywords: ["Flying", "Landfall"] })).toEqual(["flying"]);
    expect(keywordsOf({ oracleText: "First strike, lifelink\nWhenever this attacks, draw." })).toEqual(["first strike", "lifelink"]);
    expect(keywordsOf({ oracleText: "Flying (This creature can't be blocked except by...)\nWhen it enters, flying creatures get +1." })).toEqual(["flying"]);
  });

  it("Manakosten", () => {
    expect(parseManaCost("{2}{W}{W}")).toEqual({ reqs: [{ opts: ["W"], kind: "color" }, { opts: ["W"], kind: "color" }], generic: 2, x: 0 });
    expect(parseManaCost("{X}{R}").x).toBe(1);
    expect(parseManaCost("{W/U}{2/B}{G/P}").reqs.map(r => r.kind)).toEqual(["hybrid", "twobrid", "phyrexian"]);
    expect(parseManaCost("").reqs).toEqual([]);
  });

  it("Manaquellen", () => {
    expect(manaSourceOf({ typeLine: "Basic Land — Forest" })).toEqual([new Set(["G"])]);
    expect(manaSourceOf({ typeLine: "Land", oracleText: "{T}: Add {R} or {G}." })).toEqual([new Set(["R", "G"])]);
    expect(manaSourceOf({ typeLine: "Artifact", oracleText: "{T}: Add {C}{C}." })).toEqual([new Set(["C"]), new Set(["C"])]);
    expect(manaSourceOf({ typeLine: "Artifact", oracleText: "{T}: Add one mana of any color." })[0].size).toBe(5);
    expect(manaSourceOf({ typeLine: "Creature", oracleText: "Flying" })).toBeNull();
    expect(manaSourceOf({ typeLine: "Land", oracleText: "", produced: ["U"] })).toEqual([new Set(["U"])]);
  });

  it("buildDef verbindet Schnappschuss und Scryfall-Werte", () => {
    const def = buildDef({ name: "Bär", typeLine: "Creature — Bear", manaCost: "{1}{G}", manaValue: 2 }, { power: "2", toughness: "2", keywords: ["Trample"] });
    expect(def).toMatchObject({ power: 2, toughness: 2, keywords: ["trample"], manaCost: "{1}{G}" });
    expect(buildDef({ name: "X", typeLine: "Creature" }, { power: "*", toughness: "1+*" })).toMatchObject({ power: null, powerText: "*" });
  });

  it("Scryfall-Abruf: Pakete, Fehlerfall, ungültige IDs", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id, power: "3", toughness: "4", keywords: ["Flying"], card_faces: [] }] }) });
    const facts = await fetchScryfallFacts([id, id, "kaputt"], { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).identifiers).toEqual([{ id }]);
    expect(facts.get(id)).toMatchObject({ power: "3", toughness: "4" });
    const broken = await fetchScryfallFacts([id], { fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) });
    expect(broken.size).toBe(0);
  });
});

const land = (id, ...colors) => ({ id, units: [colors] });

describe("planPayment", () => {
  const none = emptyPool();

  it("zahlt farbige und generische Kosten und spart flexible Quellen", () => {
    const sources = [land("f1", "G"), land("f2", "G"), land("i1", "U"), land("dual", "G", "U")];
    const plan = planPayment({ manaCost: "{1}{G}{U}", pool: none, sources });
    expect(plan.ok).toBe(true);
    expect(plan.tap).toHaveLength(3);
    expect(plan.tap).not.toContain("dual");
  });

  it("nutzt zuerst den Pool", () => {
    const pool = { ...none, R: 2 };
    const plan = planPayment({ manaCost: "{R}{R}", pool, sources: [land("m", "R")] });
    expect(plan).toMatchObject({ ok: true, tap: [], poolUsed: { R: 2 } });
  });

  it("scheitert mit Hinweis, wenn Farbe fehlt", () => {
    const plan = planPayment({ manaCost: "{U}", pool: none, sources: [land("f", "G")] });
    expect(plan).toEqual({ ok: false, missing: "{U}" });
  });

  it("X-Kosten, Kommandantensteuer und Überschuss im Pool", () => {
    const sol = { id: "sol", units: [["C"], ["C"]] };
    const plan = planPayment({ manaCost: "{X}{R}", x: 1, extraGeneric: 0, pool: none, sources: [sol, land("m", "R")] });
    expect(plan.ok).toBe(true);
    const tax = planPayment({ manaCost: "{R}", extraGeneric: 2, pool: none, sources: [sol, land("m", "R")] });
    expect(tax).toMatchObject({ ok: true, tap: expect.arrayContaining(["sol", "m"]) });
    const extra = planPayment({ manaCost: "{1}", pool: none, sources: [sol] });
    expect(extra.poolAdd.C).toBe(1);
  });

  it("Hybrid, Zwei-oder-Farbe und Phyrexian", () => {
    expect(planPayment({ manaCost: "{W/U}", pool: none, sources: [land("i", "U")] }).ok).toBe(true);
    expect(planPayment({ manaCost: "{2/W}", pool: none, sources: [land("a", "G"), land("b", "G")] }).ok).toBe(true);
    const phy = planPayment({ manaCost: "{G/P}", pool: none, sources: [] });
    expect(phy).toMatchObject({ ok: true, lifeLoss: 2 });
  });

  it("Beschreibung", () => {
    expect(describeCost("{2}{W}{W}")).toBe("{2}{W}{W}");
    expect(describeCost("")).toBe("{0}");
  });
});
