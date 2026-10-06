import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { table: string; rows: unknown; options: unknown };
const upserts: Call[] = [];
const state = {
  rpc: [] as Array<{ email: string; id: string }>,
  existingCards: [] as string[],
  failRow: "" as string
};

vi.mock("./supabase", () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.range = () => Promise.resolve({
      data: table === "collection_cards" ? state.existingCards.map((card_id) => ({ card_id })) : [],
      error: null
    });
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
    chain.upsert = (rows: unknown, options: unknown) => {
      upserts.push({ table, rows, options });
      const bad = state.failRow;
      const failing = bad && (Array.isArray(rows) ? rows.some((r) => JSON.stringify(r).includes(bad)) : JSON.stringify(rows).includes(bad));
      return Promise.resolve({ error: failing ? { message: "violates check constraint" } : null });
    };
    return chain;
  };
  return { supabase: { from, rpc: () => Promise.resolve({ data: state.rpc, error: null }) }, supabaseConfigured: true };
});

import {
  buildListingRow,
  decodeFields,
  getAccessToken,
  migrateAll,
  parseServiceAccount,
  planMigration,
  readFirebase,
  resolveSupabaseUsers,
  sumCopies,
  sumDeckCards,
  type FirebaseSnapshot
} from "./firebaseMigration";

beforeEach(() => {
  upserts.length = 0;
  state.rpc = [];
  state.existingCards = [];
  state.failRow = "";
});

describe("decodeFields", () => {
  it("wandelt Firestore-REST-Werte in normale Objekte um", () => {
    expect(decodeFields({
      name: { stringValue: "Sol Ring" },
      count: { integerValue: "3" },
      price: { doubleValue: 1.5 },
      foil: { booleanValue: false },
      none: { nullValue: null },
      at: { timestampValue: "2026-01-01T00:00:00Z" },
      colors: { arrayValue: { values: [{ stringValue: "G" }, { stringValue: "U" }] } },
      empty: { arrayValue: {} },
      finishCounts: { mapValue: { fields: { foil: { integerValue: "1" }, nonfoil: { integerValue: "2" } } } }
    })).toEqual({
      name: "Sol Ring", count: 3, price: 1.5, foil: false, none: null,
      at: Date.parse("2026-01-01T00:00:00Z"), colors: ["G", "U"], empty: [],
      finishCounts: { foil: 1, nonfoil: 2 }
    });
    expect(decodeFields(undefined)).toEqual({});
  });
});

describe("parseServiceAccount", () => {
  it("akzeptiert eine Dienstkonto-Datei und lehnt anderes ab", () => {
    const ok = JSON.stringify({ type: "service_account", project_id: "p", client_email: "a@p.iam", private_key: "k", extra: 1 });
    expect(parseServiceAccount(ok)).toEqual({ project_id: "p", client_email: "a@p.iam", private_key: "k" });
    expect(() => parseServiceAccount("kein json")).toThrow(/JSON/);
    expect(() => parseServiceAccount('{"apiKey":"x"}')).toThrow(/Dienstkonto/);
  });
});

describe("getAccessToken", () => {
  it("signiert ein gültiges JWT und liefert das Token", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let binary = "";
    for (const b of pkcs8) binary += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;

    let assertion = "";
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      assertion = (init?.body as URLSearchParams).get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    });
    const token = await getAccessToken({ project_id: "p", client_email: "svc@p.iam", private_key: pem }, fetchImpl as unknown as typeof fetch);
    expect(token).toBe("tok");

    const [h, c, s] = assertion.split(".");
    const fromB64 = (v: string) => Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(fromB64(c))).iss).toBe("svc@p.iam");
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, fromB64(s), new TextEncoder().encode(`${h}.${c}`));
    expect(valid).toBe(true);
  });

  it("meldet abgelehnte Schlüssel", async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign"]
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let binary = "";
    for (const b of der) binary += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
    const fetchImpl = async () => new Response(JSON.stringify({ error_description: "Invalid grant" }), { status: 400 });
    await expect(getAccessToken({ project_id: "p", client_email: "x", private_key: pem }, fetchImpl as unknown as typeof fetch))
      .rejects.toThrow(/Invalid grant/);
  });
});

describe("readFirebase", () => {
  it("liest Nutzer, Unterkollektionen (mit Seiten), Auth-E-Mails und Angebote", async () => {
    const doc = (path: string, fields: Record<string, unknown> = {}) => ({
      name: `projects/p/databases/(default)/documents/${path}`, fields
    });
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok" });
      if (url.includes("accounts:batchGet")) return json({ users: [{ localId: "u1", email: "Alice@X.de" }] });
      if (url.includes("/documents/users?")) {
        return json({ documents: [
          doc("users/u1", { email: { stringValue: "alt@x.de" }, displayName: { stringValue: "Alice" } }),
          doc("users/u2", { email: { stringValue: "Bob@X.de" } })
        ] });
      }
      if (url.includes("/users/u1/collection") && !url.includes("pageToken")) {
        return json({ documents: [doc("users/u1/collection/c1", { name: { stringValue: "Sol Ring" }, count: { integerValue: "2" } })], nextPageToken: "n2" });
      }
      if (url.includes("/users/u1/collection") && url.includes("pageToken=n2")) {
        return json({ documents: [doc("users/u1/collection/c2", { name: { stringValue: "Mana Crypt" } })] });
      }
      if (url.includes("/users/u1/decks")) return json({ documents: [doc("users/u1/decks/d1", { name: { stringValue: "Deck" } })] });
      if (url.includes("/users/u2/")) return json({});
      if (url.includes("/documents/marketListings")) return json({ documents: [doc("marketListings/u1_c1", { ownerId: { stringValue: "u1" }, cardId: { stringValue: "c1" } })] });
      return new Response("{}", { status: 404 });
    });

    // Schlüssel wird nur für das Token gebraucht; hier ein echter Testschlüssel.
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign"]
    );
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    let binary = "";
    for (const b of der) binary += String.fromCharCode(b);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;

    const snap = await readFirebase({ project_id: "p", client_email: "svc", private_key: pem }, () => undefined, fetchImpl as unknown as typeof fetch);
    expect(snap.authListLoaded).toBe(true);
    expect(snap.users.map((u) => [u.firebaseUid, u.email, u.cards.length, u.decks.length])).toEqual([
      ["u1", "alice@x.de", 2, 1],
      ["u2", "bob@x.de", 0, 0]
    ]);
    expect(snap.users[0].displayName).toBe("Alice");
    expect(snap.users[0].cards[0]).toMatchObject({ id: "c1", name: "Sol Ring", count: 2 });
    expect(snap.listings).toEqual([{ id: "u1_c1", data: { ownerId: "u1", cardId: "c1" } }]);
    expect(requests.some((u) => u.includes("showMissing=true"))).toBe(true);
  });
});

describe("sumCopies / sumDeckCards", () => {
  it("summiert Exemplare statt Einträge zu zählen", () => {
    expect(sumCopies([{ count: 4 }, { count: 1 }, { count: 0 }])).toBe(5);
    expect(sumCopies([{}, { count: "x" }, { count: -2 }])).toBe(3);
    expect(sumCopies([])).toBe(0);
  });

  it("zählt Karten in Decks (Hauptdeck + Sideboard)", () => {
    const decks = [
      { cards: [{ count: 1 }, { count: 3 }], sideboard: [{ count: 2 }] },
      { cards: [{ count: 1 }] },
      {}
    ] as never;
    expect(sumDeckCards(decks)).toBe(7);
  });
});

describe("planMigration / buildListingRow", () => {
  it("überspringt vorhandene und ungültige Einträge, überschreibt auf Wunsch", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "" }, {}];
    expect(planMigration(items, new Set(["a"]), false)).toEqual({ toWrite: [{ id: "b" }], skipped: 3 });
    expect(planMigration(items, new Set(["a"]), true).toWrite.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("setzt Angebote auf die neue Nutzer-ID um", () => {
    const map = new Map([["fb1", "sb1"]]);
    expect(buildListingRow("fb1_c1", { id: "fb1_c1", ownerId: "fb1", cardId: "c1", name: "Sol Ring" }, map)).toEqual({
      id: "sb1_c1", owner_id: "sb1", data: { ownerId: "sb1", cardId: "c1", name: "Sol Ring" }
    });
    expect(buildListingRow("x", { ownerId: "unbekannt", cardId: "c" }, map)).toBeNull();
    expect(buildListingRow("x", { ownerId: "fb1" }, map)).toBeNull();
  });
});

const snapshot = (): FirebaseSnapshot => ({
  projectId: "p",
  authListLoaded: true,
  users: [
    { firebaseUid: "fb1", email: "alice@x.de", displayName: "Alice", cards: [{ id: "c1", name: "Sol Ring", count: 4 }, { id: "c2", name: "Mana Crypt", count: 1 }] as never, decks: [{ id: "d1", name: "Deck", cards: [{ count: 2 }, { count: 1 }] }] as never },
    { firebaseUid: "fb2", email: "ghost@x.de", displayName: "", cards: [{ id: "c9", name: "X" }] as never, decks: [] }
  ],
  listings: [
    { id: "fb1_c1", data: { ownerId: "fb1", cardId: "c1", name: "Sol Ring" } },
    { id: "fb2_c9", data: { ownerId: "fb2", cardId: "c9", name: "X" } }
  ]
});

describe("migrateAll", () => {
  it("überträgt je Konto, überspringt Nutzer ohne Konto und Angebote ohne Besitzer", async () => {
    state.rpc = [{ email: "alice@x.de", id: "sb1" }];
    const resolved = await resolveSupabaseUsers(snapshot());
    expect(resolved.users.map((u) => u.supabaseId)).toEqual(["sb1", undefined]);

    const report = await migrateAll({ snapshot: resolved, overwrite: false });
    expect(report.users[0]).toMatchObject({ email: "alice@x.de", status: "ok", profileWritten: true });
    expect(report.users[0].cards).toMatchObject({ found: 2, written: 2, skipped: 0, copies: 5, copiesWritten: 5 });
    expect(report.users[0].decks).toMatchObject({ found: 1, written: 1, copies: 3, copiesWritten: 3 });
    expect(report.users[1]).toMatchObject({ status: "no-account" });
    expect(report.listings).toMatchObject({ found: 2, written: 1, skipped: 1 });

    const cards = upserts.find((u) => u.table === "collection_cards")!;
    expect((cards.rows as Array<{ user_id: string }>).every((r) => r.user_id === "sb1")).toBe(true);
    const listing = upserts.find((u) => u.table === "market_listings")!;
    expect((listing.rows as Array<{ id: string }>)[0].id).toBe("sb1_c1");
    const profile = upserts.find((u) => u.table === "profiles")!;
    expect(profile.rows).toMatchObject({ user_id: "sb1", display_name: "Alice" });
  });

  it("lässt vorhandene Karten unverändert, außer bei „überschreiben“", async () => {
    state.rpc = [{ email: "alice@x.de", id: "sb1" }];
    state.existingCards = ["c1"];
    const resolved = await resolveSupabaseUsers(snapshot());

    const keep = await migrateAll({ snapshot: resolved, overwrite: false });
    expect(keep.users[0].cards).toMatchObject({ written: 1, skipped: 1 });

    upserts.length = 0;
    const over = await migrateAll({ snapshot: resolved, overwrite: true });
    expect(over.users[0].cards).toMatchObject({ written: 2, skipped: 0 });
  });

  it("meldet einzelne fehlgeschlagene Einträge und schreibt den Rest", async () => {
    state.rpc = [{ email: "alice@x.de", id: "sb1" }];
    state.failRow = "Mana Crypt";
    const resolved = await resolveSupabaseUsers(snapshot());
    const report = await migrateAll({ snapshot: resolved, overwrite: false });
    expect(report.users[0].cards.written).toBe(1);
    expect(report.users[0].cards).toMatchObject({ copies: 5, copiesWritten: 4 });
    expect(report.users[0].cards.failed).toEqual([{ id: "c2", name: "Mana Crypt", reason: "violates check constraint" }]);
  }, 20000);
});
