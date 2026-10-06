import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./ai-worker.js";

const SUPABASE_URL = "https://abcd.supabase.co";
const ORIGIN = "https://arcane-decksmith.vercel.app";
const enc = new TextEncoder();

function b64url(input) {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(overrides = {}, secret = "geheim") {
  const payload = {
    iss: `${SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    sub: "11111111-1111-1111-1111-111111111111",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides
  };
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(input)))}`;
}

const env = {
  ALLOWED_ORIGINS: `${ORIGIN}/, http://localhost:5173`,
  SUPABASE_URL,
  SUPABASE_JWT_SECRET: "geheim",
  GROQ_API_KEY: "groq-test"
};

async function call(path, { method = "POST", origin = ORIGIN, auth, body, e = env } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  if (auth !== undefined) headers.Authorization = auth;
  const request = new Request(`https://worker.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return worker.fetch(request, e, { waitUntil() {} });
}

const HEADINGS = [
  "Kurzfazit", "Mana-Kurve und Länder", "Kartenrollen und Synergien", "Interaktion und Kartennachschub",
  "Stärken", "Schwächen", "Spielweise", "Mulligan und frühe Züge", "Fazit"
];

function modelAnswer(selection = "PURCHASE_SELECTION: [[P001]]") {
  const sections = HEADINGS.map(h => `### ${h}\nText zu [[C001]] und [[D001]].`).join("\n\n");
  return `${sections}\n${selection}`;
}

const analysisBody = {
  analysis: "Commander [[C001]]\nKarte [[D001]]\nKandidat [[P001]]",
  cardMap: { "[[C001]]": "Atraxa Prime", "[[D001]]": "Sol Ring", "[[P001]]": "Arcane Signet" }
};

function mockGroq(...contents) {
  const queue = [...contents];
  const fetchMock = vi.fn(async (url) => {
    expect(String(url)).toContain("api.groq.com");
    const content = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Worker-Auth-Block", () => {
  it("ist identisch mit worker/supabase-auth.js", () => {
    const source = readFileSync(new URL("./supabase-auth.js", import.meta.url), "utf8");
    const expected = source
      .slice(source.indexOf("const JWKS_TTL_MS"))
      .replace("export class", "class")
      .replaceAll("export async function", "async function")
      .trim();
    const worker = readFileSync(new URL("./ai-worker.js", import.meta.url), "utf8");
    const block = worker
      .slice(worker.indexOf("// ---- BEGIN supabase-auth"), worker.indexOf("// ---- END supabase-auth"))
      .split("\n")
      .slice(1)
      .join("\n")
      .trim();
    expect(block).toBe(expected);
  });
});

describe("CORS und Konfiguration", () => {
  it("beantwortet Preflight für erlaubte Origins (auch mit Slash in der Variable)", async () => {
    const response = await call("/", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const local = await call("/", { method: "OPTIONS", origin: "http://localhost:5173" });
    expect(local.status).toBe(204);
  });

  it("lehnt fremde Origins ab", async () => {
    expect((await call("/", { method: "OPTIONS", origin: "https://evil.example" })).status).toBe(403);
    const post = await call("/", { origin: "https://evil.example", auth: `Bearer ${await token()}`, body: {} });
    expect(post.status).toBe(403);
    expect(post.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("meldet fehlende Konfiguration deutlich", async () => {
    const response = await call("/", { e: { SUPABASE_URL } });
    expect(response.status).toBe(500);
  });

  it("erlaubt nur POST", async () => {
    expect((await call("/", { method: "GET" })).status).toBe(405);
  });
});

describe("Anmeldung", () => {
  it("verlangt ein Token", async () => {
    expect((await call("/", { body: analysisBody })).status).toBe(401);
    expect((await call("/", { auth: "Basic abc", body: analysisBody })).status).toBe(401);
    expect((await call("/", { auth: "Bearer ", body: analysisBody })).status).toBe(401);
  });

  it("lehnt falsch signierte, abgelaufene und fremde Tokens ab", async () => {
    const bad = [
      await token({}, "falsch"),
      await token({ exp: 1 }),
      await token({ iss: "https://evil.supabase.co/auth/v1" }),
      await token({ aud: "anon" })
    ];
    for (const value of bad) {
      const response = await call("/", { auth: `Bearer ${value}`, body: analysisBody });
      expect(response.status).toBe(401);
    }
  });

  it("meldet 500, wenn die Token-Prüfung nicht konfiguriert ist", async () => {
    const response = await call("/", {
      auth: `Bearer ${await token()}`,
      body: analysisBody,
      e: { ...env, SUPABASE_URL: undefined }
    });
    expect(response.status).toBe(500);
  });
});

describe("Routing und Eingabeprüfung", () => {
  it("antwortet 404 für unbekannte Pfade", async () => {
    expect((await call("/unbekannt", { auth: `Bearer ${await token()}`, body: {} })).status).toBe(404);
  });

  it("prüft die Deckanalyse-Eingabe", async () => {
    const auth = `Bearer ${await token()}`;
    expect((await call("/", { auth, body: {} })).status).toBe(400);
    expect((await call("/", { auth, body: { analysis: "x".repeat(12001), cardMap: {} } })).status).toBe(413);
    const unknownToken = await call("/", {
      auth,
      body: { analysis: "[[D009]]", cardMap: { "[[D001]]": "Sol Ring" } }
    });
    expect(unknownToken.status).toBe(400);
  });
});

describe("KI-Analyse (Groq)", () => {
  it("liefert die Analyse mit aufgelösten Kartennamen und gewählten Anschaffungen", async () => {
    const groq = mockGroq(modelAnswer());
    const response = await call("/", { auth: `Bearer ${await token()}`, body: analysisBody });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const data = await response.json();
    expect(data.explanation).toContain("Atraxa Prime");
    expect(data.explanation).toContain("Sol Ring");
    expect(data.explanation).not.toContain("[[");
    expect(data.explanation).not.toContain("PURCHASE_SELECTION");
    expect(data.selectedPurchaseTokens).toEqual(["[[P001]]"]);
    expect(groq).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(groq.mock.calls[0][1].body);
    expect(groq.mock.calls[0][1].headers.Authorization).toBe("Bearer groq-test");
    expect(sent.messages[0].content).toContain("[[C001]]");
  });

  it("versucht es nach einem Regelverstoß ein zweites Mal", async () => {
    const groq = mockGroq(modelAnswer("PURCHASE_SELECTION: [[P009]]"), modelAnswer("PURCHASE_SELECTION: NONE"));
    const response = await call("/", { auth: `Bearer ${await token()}`, body: analysisBody });
    expect(response.status).toBe(200);
    expect((await response.json()).selectedPurchaseTokens).toEqual([]);
    expect(groq).toHaveBeenCalledTimes(2);
  });

  it("antwortet 502, wenn auch der zweite Versuch ungültig ist", async () => {
    mockGroq("Kein gültiges Format");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await call("/", { auth: `Bearer ${await token()}`, body: analysisBody });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("Groq hat auch nach einem automatischen Korrekturversuch");
  });
});

describe("Deck-Intelligence", () => {
  it("liefert für Standard ohne TopDeck-Schlüssel eine gültige Antwortstruktur", async () => {
    vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("/deck-intelligence", {
      auth: `Bearer ${await token()}`,
      body: { action: "build", format: "standard", commanders: [], deckCards: ["Sol Ring"], candidateCards: ["Arcane Signet"] }
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.topDeck.available).toBe(false);
    expect(data.topDeck.cacheState).toBe("missing_key");
    expect(data.spellbook.available).toBe(false);
    expect(data.edhrec.available).toBe(false);
    expect(data.cardSignals).toEqual({});
  });

  it("verlangt auch hier eine Anmeldung und gültiges JSON", async () => {
    expect((await call("/deck-intelligence", { body: {} })).status).toBe(401);
    const request = new Request("https://worker.example/deck-intelligence", {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${await token()}` },
      body: "kein json"
    });
    expect((await worker.fetch(request, env, { waitUntil() {} })).status).toBe(400);
  });
});
