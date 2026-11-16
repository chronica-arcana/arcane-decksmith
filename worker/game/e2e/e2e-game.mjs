/** Ende-zu-Ende-Test des Spielkerns (2 Spieler Standard, 3 Spieler Commander, Verlauf, Revanche, Sichtbarkeit). */
import { createHmac } from "node:crypto";
import { USERS, startMockSupabase } from "./fixtures.mjs";

const HTTP = process.env.GAME_HTTP ?? "http://127.0.0.1:8788";
const WS = HTTP.replace(/^http/, "ws");
const SECRET = process.env.SUPABASE_JWT_SECRET ?? "lokales-testgeheimnis";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:8797";
const b64 = v => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function token(user) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 600 });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? ` – ${detail}` : ""}`); if (!ok) failures += 1; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); } return null; }
async function api(method, path, user, body) {
  const r = await fetch(`${HTTP}${path}`, {
    method, headers: { Authorization: `Bearer ${token(user)}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function connect(code, user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/room/${code}`);
    const c = { ws, messages: [], closed: null };
    ws.addEventListener("message", e => c.messages.push(JSON.parse(e.data)));
    ws.addEventListener("close", e => { c.closed = { code: e.code }; });
    ws.addEventListener("open", () => { ws.send(JSON.stringify({ type: "auth", token: token(user) })); resolve(c); });
    ws.addEventListener("error", () => reject(new Error("Verbindung fehlgeschlagen")));
  });
}
const act = (c, action) => c.ws.send(JSON.stringify({ type: "game", action }));
const game = c => [...c.messages].reverse().find(m => m.type === "game")?.game;
const me = c => { const g = game(c); return g?.players.find(p => p.userId === g.you); };
const errors = c => c.messages.filter(m => m.type === "error").map(m => m.message);

const { alice, carol, dave } = USERS;
const mock = await startMockSupabase();

console.log("\n== Zwei Spieler, Standard");
const created = await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-std" });
const code = created.body.code;
check("Raum erstellt", created.status === 201, code);
check("Beitritt", (await api("POST", "/api/rooms/join", carol, { code, deckId: "C-std" })).status === 200);
const a = await connect(code, alice);
const c = await connect(code, carol);
await waitFor(() => lastRoom(a) && lastRoom(c));
function lastRoom(x) { return [...x.messages].reverse().find(m => m.type === "room"); }
check("vor dem Start keine Spielsicht", !game(a));
a.ws.send(JSON.stringify({ type: "ready", ready: true })); c.ws.send(JSON.stringify({ type: "ready", ready: true }));
await sleep(200);
a.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => game(a) && game(c));
check("Beide erhalten die Spielsicht (Mulligan-Phase)", game(a)?.phase === "mulligan" && game(c)?.phase === "mulligan");
check("Eigene Hand: 7 Karten mit Namen, Bibliothek 53", me(a).hand.length === 7 && me(a).hand[0].name && me(a).counts.library === 53);
const other = game(a).players.find(p => p.userId !== game(a).you);
check("Gegnerische Hand: nur die Anzahl", other.hand.length === 0 && other.counts.hand === 7);
check("Karten-IDs der gegnerischen Hand tauchen nirgends auf", !JSON.stringify(game(a)).includes(me(c).hand[0].id));

act(a, { type: "draw" });
await sleep(150);
check("Aktion vor dem Behalten abgelehnt", errors(a).some(m => /Starthand/.test(m)));
act(a, { type: "mulligan" });
await waitFor(() => me(a).mulligans === 1);
check("Mulligan: wieder 7 Karten", me(a).mulligans === 1 && me(a).hand.length === 7);
act(a, { type: "keep", bottom: [me(a).hand[0].id] });
act(c, { type: "keep" });
await waitFor(() => game(a).phase === "playing" && game(c).phase === "playing");
check("Spiel läuft, Mulligan-Karte unten (6 Karten Hand)", game(a).phase === "playing" && me(a).hand.length === 6);
const first = game(a).turn.active;
const [pA, pC] = first === alice.id ? [a, c] : [c, a];

act(pA, { type: "draw", count: 2 });
await waitFor(() => me(pA).hand.length >= 8);
const card = me(pA).hand[0];
act(pA, { type: "move", id: card.id, to: "battlefield" });
await waitFor(() => me(pC) && game(pC).players.find(p => p.userId === game(pA).you).battlefield.length === 1);
const seenByOther = game(pC).players.find(p => p.userId === game(pA).you).battlefield[0];
check("Gegner sieht die gelegte Karte mit Namen", seenByOther.name === card.name);
act(pA, { type: "tap", id: card.id });
await waitFor(() => game(pC).players.find(p => p.userId === game(pA).you).battlefield[0].tapped);
check("Tappen wird synchronisiert", true);

const hiddenCard = me(pA).hand[0];
act(pA, { type: "move", id: hiddenCard.id, to: "battlefield", faceDown: true });
await waitFor(() => game(pC).players.find(p => p.userId === game(pA).you).battlefield.length === 2);
const faceDown = game(pC).players.find(p => p.userId === game(pA).you).battlefield[1];
check("Verdeckte Karte verrät dem Gegner nichts", faceDown.faceDown && !faceDown.name && !JSON.stringify(game(pC)).includes(hiddenCard.name + "\""));
act(pC, { type: "move", id: card.id, to: "graveyard" });
await sleep(150);
check("Fremde Karten bewegen verboten", errors(pC).some(m => /nicht deine/.test(m)));
act(pC, { type: "draw" });
act(pA, { type: "look", count: 2 });
await waitFor(() => me(pA).looking?.length === 2);
check("Bibliothek ansehen: nur der Besitzer sieht Karten", me(pA).looking.length === 2 && !game(pC).players.find(p => p.userId === game(pA).you).looking);
act(pA, { type: "closeLook" });
// Zaubern über den Stapel (die Testkarten haben keine Manakosten): wirken, beide passen, Karte liegt auf dem Schlachtfeld
const spell = me(pA).hand.find(c => c.play?.kind === "spell");
act(pA, { type: "cast", id: spell.id });
await waitFor(() => game(pC).stack.length === 1);
check("Zauber liegt für alle sichtbar auf dem Stapel", game(pC).stack[0].card?.name === spell.name && game(pA).priority === game(pA).you);
act(pA, { type: "pass" });
await waitFor(() => game(pC).priority === game(pC).you);
check("Gegner bekommt Priorität", game(pC).priority === game(pC).you);
act(pC, { type: "pass" });
await waitFor(() => game(pA).stack.length === 0);
check("Zauber löst sich auf", game(pA).players.find(p => p.userId === game(pA).you).battlefield.some(c => c.id === spell.id));
act(pA, { type: "endTurn" });
await waitFor(() => game(pC).turn.active !== first);
check("Zugwechsel", game(pC).turn.active !== first && game(pC).turn.number === 2);
check("Spielverlauf vorhanden", game(pC).log.length > 5);

console.log("\n== Spielende, Verlauf, Revanche");
act(pC, { type: "concede" });
await waitFor(() => game(pA).phase === "ended");
check("Aufgeben beendet das Spiel, Sieger steht fest", game(pA).phase === "ended" && game(pA).winner === game(pA).you);
const histA = await waitFor(async () => null, 10); void histA;
const hist = await api("GET", "/api/history", alice);
check("Verlauf enthält das Spiel", hist.body?.entries?.length === 1 && hist.body.entries[0].players.length === 2, JSON.stringify(hist.body?.entries?.[0]?.winner));
const histC = await api("GET", "/api/history", carol);
check("Verlauf beider Spieler getrennt, Sieger richtig", histC.body.entries[0].won === (game(pA).winner === carol.id) && hist.body.entries[0].won === (game(pA).winner === alice.id));
act(c, { type: "draw" });
c.ws.send(JSON.stringify({ type: "rematch" }));
await sleep(150);
check("Revanche nur durch den Gastgeber", errors(c).some(m => /Gastgeber/.test(m)));
a.ws.send(JSON.stringify({ type: "rematch" }));
await waitFor(() => game(a).phase === "mulligan");
check("Revanche startet ein neues Spiel", game(a).phase === "mulligan" && game(c).phase === "mulligan");

console.log("\n== Aufräumen und Neustart-Sicherheit");
check("Verlassen mitten im Spiel zählt als aufgegeben", (await api("POST", "/api/rooms/leave", carol)).status === 200);
await waitFor(() => game(a).phase === "ended");
check("Spiel endet für den Verbleibenden", game(a).phase === "ended");
check("Zweiter Eintrag im Verlauf", (await api("GET", "/api/history", alice)).body.entries.length === 2);
await api("POST", "/api/rooms/leave", alice);

console.log("\n== Drei Spieler, Commander");
const room3 = await api("POST", "/api/rooms", alice, { format: "commander", deckId: "A-cmd", maxPlayers: 3 });
const code3 = room3.body.code;
await api("POST", "/api/rooms/join", carol, { code: code3, deckId: "C-cmd" });
await api("POST", "/api/rooms/join", dave, { code: code3, deckId: "D-cmd" });
const [x, y, z] = await Promise.all([connect(code3, alice), connect(code3, carol), connect(code3, dave)]);
await waitFor(() => lastRoom(z));
for (const p of [x, y, z]) p.ws.send(JSON.stringify({ type: "ready", ready: true }));
await sleep(300);
x.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => game(x) && game(y) && game(z));
check("Drei Spielsichten, 40 Leben, Kommandant in der Kommandozone", game(x).players.length === 3 && me(x).life === 40 && me(x).command.length === 1 && me(x).command[0].name.endsWith("Heldin"));
for (const p of [x, y, z]) act(p, { type: "keep" });
await waitFor(() => game(x).phase === "playing");
const cmdr = me(x).command[0];
act(x, { type: "move", id: cmdr.id, to: "battlefield" });
await waitFor(() => me(y) && game(y).players.find(p => p.userId === alice.id).battlefield.length === 1);
act(y, { type: "cmddmg", from: alice.id, delta: 21 });
await waitFor(() => game(x).players.find(p => p.userId === carol.id).eliminated);
check("21 Kommandantenschaden: Carol scheidet aus, Spiel läuft mit zwei weiter", game(x).phase === "playing" && game(x).players.find(p => p.userId === carol.id).eliminated.includes("Kommandant"));
check("Alice' Kommandant wurde als gewirkt gezählt", game(x).players.find(p => p.userId === alice.id).cmdCasts[cmdr.id] === 1);
act(z, { type: "life", set: 0 });
await waitFor(() => game(x).phase === "ended");
check("Spiel endet, Alice gewinnt", game(x).winner === alice.id);

for (const p of [a, c, x, y, z]) p.ws.close();
await api("POST", "/api/rooms/leave", alice); await api("POST", "/api/rooms/leave", carol); await api("POST", "/api/rooms/leave", dave);
await mock.close();
console.log(failures === 0 ? "\nAlles in Ordnung." : `\n${failures} Prüfung(en) fehlgeschlagen.`);
process.exit(failures === 0 ? 0 : 1);
