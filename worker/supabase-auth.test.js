import { describe, expect, it } from "vitest";
import { AuthError, authenticate, verifySupabaseJwt } from "./supabase-auth.js";

const SUPABASE_URL = "https://abcd.supabase.co";
const enc = new TextEncoder();

function b64url(input) {
  const bytes = typeof input === "string" ? enc.encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function claims(overrides = {}) {
  return {
    iss: `${SUPABASE_URL}/auth/v1`,
    aud: "authenticated",
    sub: "11111111-1111-1111-1111-111111111111",
    email: "a@example.com",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides
  };
}

async function signEs256(payload, privateKey, kid = "k1") {
  const input = `${b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

async function signHs256(payload, secret) {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}

async function jwksFetch(publicKey, kid = "k1") {
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid, alg: "ES256", use: "sig" };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    expect(url).toBe(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  return { fetchImpl, calls: () => calls };
}

const env = { SUPABASE_URL, SUPABASE_JWT_SECRET: "geheim" };

describe("verifySupabaseJwt", () => {
  it("akzeptiert ein gültiges ES256-Token (JWKS)", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { fetchImpl } = await jwksFetch(pair.publicKey);
    const token = await signEs256(claims(), pair.privateKey);
    const result = await verifySupabaseJwt(token, env, fetchImpl);
    expect(result.sub).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("lehnt ein mit fremdem Schlüssel signiertes ES256-Token ab", async () => {
    const good = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const evil = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { fetchImpl } = await jwksFetch(good.publicKey);
    const token = await signEs256(claims(), evil.privateKey);
    await expect(verifySupabaseJwt(token, env, fetchImpl)).rejects.toThrow("Signatur");
  });

  it("akzeptiert ein gültiges HS256-Token", async () => {
    const token = await signHs256(claims(), "geheim");
    const result = await verifySupabaseJwt(token, env, async () => { throw new Error("kein JWKS nötig"); });
    expect(result.email).toBe("a@example.com");
  });

  it("lehnt falsches HS256-Geheimnis, Ablauf, fremdes Projekt und falsche Zielgruppe ab", async () => {
    await expect(verifySupabaseJwt(await signHs256(claims(), "falsch"), env)).rejects.toThrow("Signatur");
    await expect(verifySupabaseJwt(await signHs256(claims({ exp: 1 }), "geheim"), env)).rejects.toThrow("abgelaufen");
    await expect(
      verifySupabaseJwt(await signHs256(claims({ iss: "https://evil.supabase.co/auth/v1" }), "geheim"), env)
    ).rejects.toThrow("anderen Projekt");
    await expect(verifySupabaseJwt(await signHs256(claims({ aud: "anon" }), "geheim"), env)).rejects.toThrow("angemeldete");
  });

  it("lehnt alg=none und Müll ab", async () => {
    const none = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims()))}.`;
    await expect(verifySupabaseJwt(none, env)).rejects.toBeInstanceOf(AuthError);
    await expect(verifySupabaseJwt("abc", env)).rejects.toBeInstanceOf(AuthError);
    await expect(verifySupabaseJwt("", env)).rejects.toBeInstanceOf(AuthError);
  });

  it("lädt JWKS nach einem Schlüsselwechsel (unbekannte kid) einmal neu", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { fetchImpl, calls } = await jwksFetch(pair.publicKey, "neu");
    const token = await signEs256(claims(), pair.privateKey, "neu");
    await verifySupabaseJwt(token, { SUPABASE_URL: `${SUPABASE_URL}/` }, fetchImpl);
    expect(calls()).toBeGreaterThanOrEqual(1);
  });
});

describe("authenticate", () => {
  it("verlangt einen Bearer-Header", async () => {
    await expect(authenticate(new Request("https://w.example/"), env)).rejects.toBeInstanceOf(AuthError);
  });

  it("liefert userId und E-Mail", async () => {
    const token = await signHs256(claims(), "geheim");
    const request = new Request("https://w.example/", { headers: { Authorization: `Bearer ${token}` } });
    const result = await authenticate(request, env);
    expect(result.userId).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.email).toBe("a@example.com");
  });
});
