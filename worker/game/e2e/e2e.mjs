/**
 * Ende-zu-Ende-Test gegen `wrangler dev` (echte Worker-Laufzeit mit Durable Objects).
 * Start: in worker/game `npx wrangler dev --port 8788`, dann `node e2e/e2e.mjs`.
 * Benötigt die Werte aus .dev.vars (SUPABASE_URL, SUPABASE_JWT_SECRET).
 */
import { createHmac } from "node:crypto";
import http from "node:http";

const BASE = process.env.GAME_URL ?? "ws://127.0.0.1:8788";
const SECRET = process.env.SUPABASE_JWT_SECRET ?? "lokales-testgeheimnis";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://test.supabase.co";
const HIBERNATION_WAIT_MS = Number(process.env.HIBERNATION_WAIT_MS ?? 35000);

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
function token(sub, email, overrides = {}) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({
    iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", sub, email,
    exp: Math.floor(Date.now() / 1000) + 600, ...overrides
  });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "OK  " : "FAIL"} ${label}${detail ? ` – ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Verbindet und sammelt alle Nachrichten. */
function connect(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${room}`);
    const client = { ws, messages: [], closed: null };
    ws.addEventListener("message", (event) => client.messages.push(JSON.parse(event.data)));
    ws.addEventListener("close", (event) => { client.closed = { code: event.code, reason: event.reason }; });
    ws.addEventListener("open", () => resolve(client));
    ws.addEventListener("error", () => reject(new Error("Verbindung fehlgeschlagen")));
  });
}
const send = (client, data) => client.ws.send(typeof data === "string" ? data : JSON.stringify(data));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(25); }
  return null;
}
const lastView = (client) => [...client.messages].reverse().find((m) => m.type === "view");

const room = `T${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
const A = { id: "11111111-1111-1111-1111-111111111111", email: "alice@example.com" };
const B = { id: "22222222-2222-2222-2222-222222222222", email: "bob@example.com" };

// 1) Health und Zugriffsschutz
const health = await fetch(`http://127.0.0.1:8788/health`).then((r) => r.json());
check("Health-Endpunkt antwortet", health.ok === true);
const noUpgrade = await fetch(`http://127.0.0.1:8788/room/${room}`);
check("Ohne WebSocket-Upgrade: 426", noUpgrade.status === 426, String(noUpgrade.status));
// Node-fetch darf keinen Upgrade-Header senden, daher ein normales HTTP-Request.
const badOriginStatus = await new Promise((resolve, reject) => {
  const request = http.request(
    { host: "127.0.0.1", port: 8788, path: `/room/${room}`, headers: { Origin: "https://evil.example", Upgrade: "websocket", Connection: "Upgrade" } },
    (response) => { response.resume(); resolve(response.statusCode); }
  );
  request.on("error", reject);
  request.end();
});
check("Fremde Origin: 403", badOriginStatus === 403, String(badOriginStatus));

// 2) Anmeldung
const wrong = await connect(room);
send(wrong, { type: "auth", token: token(A.id, A.email).slice(0, -3) + "xyz" });
await waitFor(() => wrong.closed);
check("Falsch signiertes Token: Verbindung geschlossen (4001)", wrong.closed?.code === 4001, JSON.stringify(wrong.closed));

const noAuth = await connect(room);
send(noAuth, { type: "chat", text: "ohne Anmeldung" });
await waitFor(() => noAuth.closed);
check("Nachricht ohne Anmeldung: geschlossen", noAuth.closed !== null, JSON.stringify(noAuth.closed));

const expired = await connect(room);
send(expired, { type: "auth", token: token(A.id, A.email, { exp: 1 }) });
await waitFor(() => expired.closed);
check("Abgelaufenes Token: geschlossen", expired.closed?.code === 4001);

// 3) Zwei Spieler, versteckte Informationen
const a = await connect(room);
send(a, { type: "auth", token: token(A.id, A.email) });
const welcomeA = await waitFor(() => a.messages.find((m) => m.type === "welcome"));
check("Alice erhält 'welcome'", Boolean(welcomeA));
const b = await connect(room);
send(b, { type: "auth", token: token(B.id, B.email) });
await waitFor(() => b.messages.find((m) => m.type === "welcome"));
await waitFor(() => lastView(a)?.view.players.length === 2);
check("Alice sieht beide Spieler (Name nur Vorderteil der E-Mail)", lastView(a).view.players.map((p) => p.name).join() === "alice,bob");

send(a, { type: "draw" });
send(a, { type: "draw" });
await waitFor(() => lastView(a)?.view.players.find((p) => p.userId === A.id)?.handCount === 2);
const viewA = lastView(a).view;
const viewB = lastView(b).view;
const aliceForA = viewA.players.find((p) => p.userId === A.id);
const aliceForB = viewB.players.find((p) => p.userId === A.id);
check("Alice sieht ihre eigene Hand (2 Karten)", aliceForA.hand?.length === 2, JSON.stringify(aliceForA.hand));
check("Bob sieht von Alice nur die Anzahl", aliceForB.handCount === 2 && aliceForB.hand === undefined);
const everythingBobReceived = JSON.stringify(b.messages);
check("Alices Karten kommen in keiner Nachricht an Bob vor", aliceForA.hand.every((card) => !everythingBobReceived.includes(card)));
check("Die Bibliothek wird nie übertragen", !JSON.stringify(a.messages).includes('"library"') && !everythingBobReceived.includes('"library"'));
check("Bibliothek: nur Anzahl (18)", aliceForA.libraryCount === 18);

// 4) Chat
send(b, { type: "chat", text: "Hallo Alice" });
const chat = await waitFor(() => a.messages.find((m) => m.type === "chat"));
check("Chat kommt bei Alice an", chat?.text === "Hallo Alice" && chat.from === "bob");

// 5) Ungültige Eingaben und Ratenbegrenzung
send(a, "kein json");
const err = await waitFor(() => a.messages.find((m) => m.type === "error" && /JSON/.test(m.message)));
check("Ungültiges JSON wird abgelehnt", Boolean(err));
send(a, { type: "give-me-bobs-hand" });
const err2 = await waitFor(() => a.messages.find((m) => m.type === "error" && /Unbekannt/.test(m.message)));
check("Unbekannter Nachrichtentyp wird abgelehnt", Boolean(err2));
for (let i = 0; i < 60; i += 1) send(b, { type: "chat", text: `Flut ${i}` });
const limited = await waitFor(() => b.messages.find((m) => m.type === "error" && /Zu viele/.test(m.message)));
check("Nachrichtenflut wird gebremst", Boolean(limited));

// 6) Raum voll (4 Spieler)
const extra = [];
for (let i = 3; i <= 5; i += 1) {
  const client = await connect(room);
  send(client, { type: "auth", token: token(`${i}${i}${i}${i}${i}${i}${i}${i}-1111-1111-1111-111111111111`, `spieler${i}@example.com`) });
  extra.push(client);
  await sleep(150);
}
await waitFor(() => extra[2].closed);
check("Spieler 3 und 4 werden aufgenommen", !extra[0].closed && !extra[1].closed);
check("Spieler 5 wird abgewiesen (Raum voll)", extra[2].closed?.code === 4002, JSON.stringify(extra[2].closed));

// 7) Wiederverbinden: alte Verbindung wird ersetzt, Hand bleibt erhalten
const a2 = await connect(room);
send(a2, { type: "auth", token: token(A.id, A.email) });
await waitFor(() => a.closed);
check("Alte Verbindung von Alice wird ersetzt (4000)", a.closed?.code === 4000, JSON.stringify(a.closed));
await waitFor(() => lastView(a2));
check("Nach dem Wiederverbinden ist Alices Hand noch da", lastView(a2).view.players.find((p) => p.userId === A.id).hand.length === 2);

// 8) Hibernation: nach Ruhe wacht das Objekt mit neuem Speicher-Zustand auf, Verbindungen und Daten bleiben
const before = lastView(a2).instance;
console.log(`... warte ${HIBERNATION_WAIT_MS / 1000} s auf Hibernation`);
await sleep(HIBERNATION_WAIT_MS);
send(a2, { type: "draw" });
await waitFor(() => lastView(a2).view.players.find((p) => p.userId === A.id).handCount === 3);
const after = lastView(a2);
check("Nach der Ruhephase funktioniert dieselbe Verbindung weiter (Hand = 3)", after.view.players.find((p) => p.userId === A.id).handCount === 3);
check("Objekt ist zwischenzeitlich hibernierte (neue Instanz)", after.instance !== before, `${before} -> ${after.instance}`);
check("Zustand blieb über die Hibernation erhalten (3 Karten, Reihenfolge ohne Duplikate)", new Set(after.view.players.find((p) => p.userId === A.id).hand).size === 3);

for (const client of [a, a2, b, noAuth, wrong, expired, ...extra]) { try { client.ws.close(); } catch {} }
console.log(failures === 0 ? "\nALLE PRÜFUNGEN BESTANDEN" : `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN`);
process.exit(failures === 0 ? 0 : 1);
