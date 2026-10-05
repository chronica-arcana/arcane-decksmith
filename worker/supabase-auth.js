/**
 * Prüft Supabase-Access-Tokens (JWT) in einem Cloudflare Worker – Ersatz für die
 * Prüfung von Firebase-ID-Tokens.
 *
 * Benötigte Worker-Variablen:
 *   SUPABASE_URL         z. B. https://abcdxyz.supabase.co  (ohne Slash am Ende)
 *   SUPABASE_JWT_SECRET  nur nötig, wenn das Projekt noch den alten gemeinsamen
 *                        HS256-Schlüssel nutzt (Settings → JWT Keys → Legacy JWT Secret).
 *                        Bei neuen Projekten (asymmetrische Schlüssel, ES256/RS256)
 *                        wird der öffentliche Schlüssel automatisch über JWKS geladen.
 *
 * Verwendung im Worker:
 *   const auth = await authenticate(request, env);   // wirft bei fehlendem/ungültigem Token
 *   auth.userId, auth.email
 *
 * Die Datei hat keine Importe, damit sich der Inhalt direkt in den Cloudflare-Editor
 * kopieren lässt (das Wort `export` vor den Funktionen dort einfach entfernen).
 */

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map(); // url -> { keys, expiresAt }

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
  } catch {
    throw new AuthError("Ungültiges Token.");
  }
}

async function loadJwks(supabaseUrl, fetchImpl, forceRefresh) {
  const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetchImpl(url);
  if (!response.ok) throw new AuthError("Schlüssel zur Token-Prüfung nicht verfügbar.", 503);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_TTL_MS });
  return keys;
}

async function verifySignature(header, signingInput, signature, env, fetchImpl) {
  const data = new TextEncoder().encode(signingInput);

  if (header.alg === "HS256") {
    if (!env.SUPABASE_JWT_SECRET) throw new AuthError("Token-Prüfung nicht konfiguriert.", 500);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify("HMAC", key, signature, data);
  }

  const algorithms = {
    ES256: { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
    RS256: { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } }
  };
  const algorithm = algorithms[header.alg];
  if (!algorithm) throw new AuthError("Nicht unterstütztes Token-Verfahren.");

  const find = async (refresh) => {
    const keys = await loadJwks(env.SUPABASE_URL, fetchImpl, refresh);
    return keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg));
  };
  // Nach einem Schlüsselwechsel einmal neu laden, bevor das Token abgelehnt wird.
  const jwk = (await find(false)) ?? (await find(true));
  if (!jwk) throw new AuthError("Unbekannter Schlüssel.");

  const key = await crypto.subtle.importKey("jwk", jwk, algorithm.import, false, ["verify"]);
  return crypto.subtle.verify(algorithm.verify, key, signature, data);
}

/** Prüft Signatur, Aussteller, Zielgruppe und Ablauf; liefert die Token-Claims. */
export async function verifySupabaseJwt(token, env, fetchImpl = fetch) {
  if (!env?.SUPABASE_URL) throw new AuthError("Token-Prüfung nicht konfiguriert.", 500);
  const supabaseUrl = String(env.SUPABASE_URL).replace(/\/+$/, "");

  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) throw new AuthError("Ungültiges Token.");
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") {
    throw new AuthError("Ungültiges Token.");
  }

  const valid = await verifySignature(
    header,
    `${headerPart}.${payloadPart}`,
    base64UrlToBytes(signaturePart),
    { ...env, SUPABASE_URL: supabaseUrl },
    fetchImpl
  );
  if (!valid) throw new AuthError("Token-Signatur ungültig.");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new AuthError("Token abgelaufen.");
  if (payload.iss !== `${supabaseUrl}/auth/v1`) throw new AuthError("Token stammt von einem anderen Projekt.");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes("authenticated")) throw new AuthError("Token ist nicht für angemeldete Nutzer.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new AuthError("Token ohne Nutzerkennung.");

  return payload;
}

/** Liest `Authorization: Bearer …` aus der Anfrage und prüft das Token. */
export async function authenticate(request, env, fetchImpl = fetch) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new AuthError("Anmeldung erforderlich.");
  const claims = await verifySupabaseJwt(match[1].trim(), env, fetchImpl);
  return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : null, claims };
}
