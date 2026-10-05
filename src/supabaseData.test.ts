import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<[string, unknown[]]> = [];
let rangeResult: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null };

vi.mock("./supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "like", "order", "eq"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.range = (...args: unknown[]) => {
    calls.push(["range", args]);
    return Promise.resolve(rangeResult);
  };
  return { supabase: { from: () => builder }, supabaseConfigured: true };
});

import { authMessage } from "./auth";
import { fetchAllRows } from "./db";
import { loadMarketPage } from "./marketDb";

const row = (n: number) => ({ id: `id${n}`, data: { name: `Karte ${n}`, ownerId: "o" } });

beforeEach(() => {
  calls.length = 0;
  rangeResult = { data: [], error: null };
});

describe("fetchAllRows", () => {
  it("liest so lange Seiten, bis eine Seite nicht mehr voll ist", async () => {
    const pages = [Array.from({ length: 1000 }, (_, i) => i), Array.from({ length: 1000 }, (_, i) => 1000 + i), [2000]];
    const seen: Array<[number, number]> = [];
    const rows = await fetchAllRows<number>(async (from, to) => {
      seen.push([from, to]);
      return { data: pages.shift() ?? [], error: null };
    });
    expect(rows).toHaveLength(2001);
    expect(seen).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("wirft Datenbankfehler als Error", async () => {
    await expect(fetchAllRows(async () => ({ data: null, error: { message: "kaputt" } }))).rejects.toThrow("kaputt");
  });
});

describe("loadMarketPage", () => {
  it("meldet weitere Seiten und liefert den Offset als Cursor", async () => {
    rangeResult = { data: [row(1), row(2), row(3)], error: null };
    const page = await loadMarketPage({ pageSize: 2, cursor: { offset: 10 } });
    expect(page.listings.map((l) => l.id)).toEqual(["id1", "id2"]);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).toEqual({ offset: 12 });
    expect(calls).toContainEqual(["range", [10, 12]]);
  });

  it("sucht nach Namensanfang und maskiert LIKE-Sonderzeichen", async () => {
    rangeResult = { data: [row(1)], error: null };
    const page = await loadMarketPage({ search: "  50%_Sol " });
    expect(page.hasMore).toBe(false);
    expect(calls).toContainEqual(["like", ["name_lower", "50\\%\\_sol%"]]);
  });

  it("wirft bei Datenbankfehlern", async () => {
    rangeResult = { data: null, error: { message: "nein" } };
    await expect(loadMarketPage()).rejects.toThrow("nein");
  });
});

describe("authMessage", () => {
  it("übersetzt Supabase-Fehlercodes", () => {
    expect(authMessage({ code: "invalid_credentials" })).toContain("nicht korrekt");
    expect(authMessage({ code: "email_not_confirmed" })).toContain("bestätigen");
    expect(authMessage({ name: "AuthRetryableFetchError", status: 0 })).toContain("Netzwerk");
    expect(authMessage(undefined)).toContain("nicht durchgeführt");
  });
});
