/**
 * Prüft den Ablauf eines Raums. Benötigt eine Worker-Instanz mit kurzer Lebensdauer:
 *   npx wrangler dev --port 8788 --var ROOM_TTL_SECONDS:6
 * Danach `node e2e/e2e-expiry.mjs`.
 */
import { createHmac } from "node:crypto";
import { USERS, startMockSupabase } from "./fixtures.mjs";

const HTTP = process.env.GAME_HTTP ?? "http://127.0.0.1:8788";
const SECRET = process.env.SUPABASE_JWT_SECRET ?? "lokales-testgeheimnis";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:8797";
const b64 = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const token = user => {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 600 });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
};
const api = async (method, path, user, body) => {
  const response = await fetch(`${HTTP}${path}`, { method, headers: { Authorization: `Bearer ${token(user)}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` – ${detail}` : ""}`); if (!ok) failures += 1; };

const mock = await startMockSupabase();
const { alice } = USERS;
const created = await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-std" });
const code = created.body.code;
check("Raum erstellt", created.status === 201, code);

const messages = [];
let closed = null;
const ws = new WebSocket(`${HTTP.replace(/^http/, "ws")}/room/${code}`);
ws.addEventListener("message", event => messages.push(JSON.parse(event.data)));
ws.addEventListener("close", event => { closed = { code: event.code, reason: event.reason }; });
await new Promise(resolve => ws.addEventListener("open", resolve));
ws.send(JSON.stringify({ type: "auth", token: token(alice) }));
await sleep(500);
check("Alice ist im Raum verbunden", messages.some(m => m.type === "room"));
check("'Mein Raum' zeigt den Raum vor dem Ablauf", (await api("GET", "/api/rooms/mine", alice)).body.room?.code === code);

console.log("... warte auf den Ablauf des Raums");
await sleep(9000);
check("Beim Ablauf wird Alice informiert und getrennt (4006)", messages.some(m => m.type === "closed" && /abgelaufen/.test(m.reason)) && closed?.code === 4006, JSON.stringify(closed));
check("Der abgelaufene Raum existiert nicht mehr (404)", (await api("GET", `/api/rooms/${code}`, alice)).status === 404);
check("Alice ist wieder frei", (await api("GET", "/api/rooms/mine", alice)).body.room === null);
check("Alice kann einen neuen Raum erstellen", (await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-std" })).status === 201);

await mock.close();
console.log(failures === 0 ? "\nALLE PRÜFUNGEN BESTANDEN" : `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN`);
process.exit(failures === 0 ? 0 : 1);
