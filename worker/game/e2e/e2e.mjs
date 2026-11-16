/**
 * Ende-zu-Ende-Test gegen `wrangler dev` (echte Worker-Laufzeit mit Durable Objects) und einen
 * Schein-Supabase-Server mit nachgebauten Zugriffsregeln.
 *
 * Start: in worker/game `npx wrangler dev --port 8788`, dann `node e2e/e2e.mjs`
 * (Werte in .dev.vars: SUPABASE_URL=http://127.0.0.1:8797, SUPABASE_ANON_KEY=anon-test-key, SUPABASE_JWT_SECRET=lokales-testgeheimnis).
 */
import { createHmac } from "node:crypto";
import { USERS, startMockSupabase } from "./fixtures.mjs";

const HTTP = process.env.GAME_HTTP ?? "http://127.0.0.1:8788";
const WS = HTTP.replace(/^http/, "ws");
const SECRET = process.env.SUPABASE_JWT_SECRET ?? "lokales-testgeheimnis";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:8797";
const ORIGIN = "https://arcane-decksmith.vercel.app";
const IDLE_WAIT_MS = Number(process.env.IDLE_WAIT_MS ?? 35000);

const b64 = value => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
function token(user, overrides = {}) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: `${SUPABASE_URL}/auth/v1`, aud: "authenticated", sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 600, ...overrides });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "OK  " : "FAIL"} ${label}${detail ? ` – ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = fn(); if (value) return value; await sleep(25); }
  return null;
}

/** HTTP-Aufruf der Schnittstelle als Nutzer (oder ohne Token). */
async function api(method, path, user, body, headers = {}) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}

/** WebSocket-Verbindung eines Nutzers; sammelt Nachrichten. */
function connect(code, user, { auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/room/${code}`);
    const client = { ws, messages: [], closed: null };
    ws.addEventListener("message", event => client.messages.push(JSON.parse(event.data)));
    ws.addEventListener("close", event => { client.closed = { code: event.code, reason: event.reason }; });
    ws.addEventListener("open", () => {
      if (auth && user) ws.send(JSON.stringify({ type: "auth", token: token(user) }));
      resolve(client);
    });
    ws.addEventListener("error", () => reject(new Error("Verbindung fehlgeschlagen")));
  });
}
const send = (client, data) => client.ws.send(JSON.stringify(data));
const lastRoom = client => [...client.messages].reverse().find(m => m.type === "room");
const hasType = (client, type) => client.messages.find(m => m.type === type);

const { alice, bob, carol, dave } = USERS;
const mock = await startMockSupabase();

// ---------------------------------------------------------------- 1) Grundlagen und Zugriffsschutz
console.log("\n== Grundlagen");
check("Health-Endpunkt antwortet", (await api("GET", "/health")).body?.ok === true);
check("API ohne Token: 401", (await api("GET", "/api/rooms/mine", null, null, { Origin: ORIGIN })).status === 401);
check("API mit fremder Origin: 403", (await api("GET", "/api/rooms/mine", alice, null, { Origin: "https://evil.example" })).status === 403);
const preflight = await api("OPTIONS", "/api/rooms", null, null, { Origin: ORIGIN, "Access-Control-Request-Method": "POST" });
check("Preflight für erlaubte Origin: 204 mit CORS-Header", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === ORIGIN);
const badToken = await fetch(`${HTTP}/api/rooms/mine`, { headers: { Authorization: `Bearer ${token(alice).slice(0, -3)}xyz` } });
check("API mit gefälschtem Token: 401", badToken.status === 401);
check("Unbekannter Pfad: 404", (await api("GET", "/api/gibt-es-nicht", alice)).status === 404);

// ---------------------------------------------------------------- 2) Deck prüfen
console.log("\n== Deck-Prüfung (serverseitig, gegen die Datenbank)");
const okDeck = await api("POST", "/api/decks/check", alice, { deckId: "A-std", format: "standard" });
check("Gültiges Standard-Deck wird akzeptiert", okDeck.body.ok === true && okDeck.body.summary.totalCards === 60, JSON.stringify(okDeck.body.summary));
check("Gültiges Commander-Deck wird akzeptiert", (await api("POST", "/api/decks/check", alice, { deckId: "A-cmd", format: "commander" })).body.ok === true);
const wrongFormat = await api("POST", "/api/decks/check", alice, { deckId: "A-std", format: "commander" });
check("Standard-Deck im Commander-Raum: Formatfehler", wrongFormat.body.errors.some(e => e.code === "format_mismatch"));
const badDeck = await api("POST", "/api/decks/check", bob, { deckId: "B-bad", format: "standard" });
check("Unvollständiges Deck wird mit Fehlerliste abgelehnt", badDeck.body.ok === false && badDeck.body.errors.some(e => e.code === "not_in_collection"), badDeck.body.errors?.[0]?.message);
const foreign = await api("POST", "/api/decks/check", bob, { deckId: "A-std", format: "standard" });
check("Fremdes Deck ist nicht abrufbar (Zugriffsregeln)", foreign.body.ok === false && foreign.body.errors[0].code === "deck_missing");
check("Ungültige Anfrage: 400", (await api("POST", "/api/decks/check", alice, { format: "standard" })).status === 400);
check("Datenbankabfragen tragen anon-Schlüssel und Nutzer-Token", mock.requests.length > 0 && mock.requests.every(r => r.apikey === "anon-test-key" && r.hasToken));

// ---------------------------------------------------------------- 3) Standard-Raum
console.log("\n== Standard-Raum (2 Spieler)");
const missingDeck = await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-gibt-es-nicht" });
check("Raum mit nicht existierendem Deck: 422", missingDeck.status === 422);
const created = await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-std" });
const code = created.body?.code;
check("Alice erstellt einen Raum (201, Code mit 6 Zeichen)", created.status === 201 && /^[A-Z2-9]{6}$/.test(code ?? ""), code);
const again = await api("POST", "/api/rooms", alice, { format: "standard", deckId: "A-std" });
check("Alice kann keinen zweiten Raum erstellen (409)", again.status === 409 && again.body.code === code);
const mine = await api("GET", "/api/rooms/mine", alice);
check("'Mein Raum' zeigt Code, Format und Gastgeber-Rolle", mine.body.room?.code === code && mine.body.room.format === "standard" && mine.body.room.isHost === true);
const info = await api("GET", `/api/rooms/${code}`, bob);
check("Bob sieht die Rauminfo (Gastgebername aus dem Profil, kein Deck)", info.body.room?.hostName === "Alice Profil" && info.body.room.playerCount === 1 && !JSON.stringify(info.body).includes("A-s0"));
check("Unbekannter Raumcode: 404", (await api("GET", "/api/rooms/ZZZZZZ", bob)).status === 404);

const outsider = await connect(code, bob);
await waitFor(() => outsider.closed);
check("Nicht-Mitglied wird per WebSocket abgewiesen (4004)", outsider.closed?.code === 4004, JSON.stringify(outsider.closed));

const bobBad = await api("POST", "/api/rooms/join", bob, { code, deckId: "B-bad" });
check("Bob mit ungültigem Deck kann nicht beitreten (422 mit Hinweisen)", bobBad.status === 422 && bobBad.body.errors.length > 0, bobBad.body.errors?.[0]?.message);
check("… und ist danach in keinem Raum", (await api("GET", "/api/rooms/mine", bob)).body.room === null);
const bobJoin = await api("POST", "/api/rooms/join", bob, { code: code.toLowerCase(), deckId: "B-std" });
check("Bob mit gültigem Deck tritt bei (Code auch in Kleinbuchstaben)", bobJoin.status === 200 && bobJoin.body.code === code);
check("Erneutes Beitreten ist unschädlich", (await api("POST", "/api/rooms/join", bob, { code, deckId: "B-std" })).status === 200);
check("Dritter Spieler: Raum ist voll (409)", (await api("POST", "/api/rooms/join", carol, { code, deckId: "C-std" })).status === 409);

const a = await connect(code, alice);
const b = await connect(code, bob);
await waitFor(() => lastRoom(a)?.room.players.length === 2 && lastRoom(b)?.room.players.length === 2);
const roomA = lastRoom(a).room;
check("Beide sehen beide Spieler (Alice mit Profilnamen, Bob mit E-Mail-Vorderteil)", roomA.players.map(p => p.name).join() === "Alice Profil,bob");
check("Gastgeber und Platzreihenfolge stimmen", roomA.hostId === alice.id && roomA.players[0].isHost && roomA.players[1].seat === 1);
check("Decks sind nur als Name und Kartenzahl sichtbar", roomA.players[1].deck.name === "B Standard" && roomA.players[1].deck.cardCount === 60);
const everythingAliceGot = JSON.stringify(a.messages);
check("Keine Kartenliste von Bobs Deck in Alices Nachrichten", !everythingAliceGot.includes("B-s0") && !everythingAliceGot.includes("Standardkarte"));

send(b, { type: "start" });
const notHost = await waitFor(() => b.messages.find(m => m.type === "error" && /Gastgeber/.test(m.message)));
check("Nur der Gastgeber kann starten", Boolean(notHost));
send(a, { type: "start" });
await waitFor(() => a.messages.find(m => m.type === "error" && /bereit/.test(m.message)));
check("Start ohne Bereitschaft wird abgelehnt", Boolean(a.messages.find(m => m.type === "error" && /bereit/.test(m.message))));
send(a, { type: "ready", ready: true }); send(b, { type: "ready", ready: true });
await waitFor(() => lastRoom(a)?.room.players.every(p => p.ready));
check("Beide sind bereit", lastRoom(a).room.players.every(p => p.ready));
send(a, { type: "start" });
await waitFor(() => lastRoom(b)?.room.status === "playing");
check("Spiel startet (Status 'playing', Systemmeldung bei beiden)", lastRoom(b).room.status === "playing" && Boolean(hasType(a, "system")) && Boolean(hasType(b, "system")));
check("Nach dem Start kann niemand mehr beitreten (409)", (await api("POST", "/api/rooms/join", carol, { code, deckId: "C-std" })).status === 409);
send(b, { type: "chat", text: "Hallo Alice" });
check("Chat kommt an", Boolean(await waitFor(() => a.messages.find(m => m.type === "chat" && m.text === "Hallo Alice" && m.from === "bob"))));
send(a, { type: "draw" });
check("Alte Spiel-Demo-Nachrichten sind nicht mehr erlaubt", Boolean(await waitFor(() => a.messages.find(m => m.type === "error" && /Unbekannt/.test(m.message)))));

// ---------------------------------------------------------------- 4) Ein Raum je Konto, Verlassen
console.log("\n== Ein Raum zugleich, Verlassen, Entfernen (Commander)");
const carolRoom = await api("POST", "/api/rooms", carol, { format: "commander", deckId: "C-cmd", maxPlayers: 3 });
const ccode = carolRoom.body?.code;
check("Carol erstellt einen Commander-Raum für 3 Spieler", carolRoom.status === 201);
const bobElsewhere = await api("POST", "/api/rooms/join", bob, { code: ccode, deckId: "B-cmd" });
check("Bob ist schon in einem Raum und kann nicht in einen zweiten (409)", bobElsewhere.status === 409 && bobElsewhere.body.code === code);
await api("POST", "/api/rooms/leave", bob, {});
await waitFor(() => b.closed);
check("Bob verlässt den Raum: seine Verbindung wird getrennt (4005)", b.closed?.code === 4005, JSON.stringify(b.closed));
await waitFor(() => lastRoom(a)?.room.players.length === 1);
check("Alice sieht, dass Bob weg ist", lastRoom(a).room.players.length === 1);
check("Bob ist danach in keinem Raum", (await api("GET", "/api/rooms/mine", bob)).body.room === null);

check("Bob tritt dem Commander-Raum bei", (await api("POST", "/api/rooms/join", bob, { code: ccode, deckId: "B-cmd" })).status === 200);
check("Dave tritt dem Commander-Raum bei", (await api("POST", "/api/rooms/join", dave, { code: ccode, deckId: "D-cmd" })).status === 200);
const standardInCommander = await api("POST", "/api/rooms/join", USERS.alice, { code: ccode, deckId: "A-cmd" });
check("Alice (in einem anderen Raum) kann nicht beitreten (409)", standardInCommander.status === 409);

const cb = await connect(ccode, bob);
const cd = await connect(ccode, dave);
const cc = await connect(ccode, carol);
await waitFor(() => lastRoom(cc)?.room.players.length === 3);
check("Commander-Raum: 3 Spieler, Format Commander", lastRoom(cc).room.players.length === 3 && lastRoom(cc).room.format === "commander");
const kickByNonHost = await api("POST", "/api/rooms/kick", dave, { userId: bob.id });
check("Nur der Gastgeber kann Spieler entfernen (403)", kickByNonHost.status === 403);
check("Der Gastgeber kann sich nicht selbst entfernen", (await api("POST", "/api/rooms/kick", carol, { userId: carol.id })).status === 403);
const kicked = await api("POST", "/api/rooms/kick", carol, { userId: bob.id });
await waitFor(() => cb.closed);
check("Gastgeber entfernt Bob: Verbindung getrennt (4005) mit Hinweis", kicked.status === 200 && cb.closed?.code === 4005 && Boolean(hasType(cb, "closed")));
await waitFor(() => lastRoom(cc)?.room.players.length === 2);
check("Carol und Dave sehen: Bob ist weg", lastRoom(cc).room.players.length === 2);
const bobNew = await api("POST", "/api/rooms", bob, { format: "standard", deckId: "B-std" });
check("Bob ist frei und kann einen eigenen Raum erstellen", bobNew.status === 201);
await api("POST", "/api/rooms/leave", bob, {});

await api("POST", "/api/rooms/leave", carol, {});
await waitFor(() => cd.closed && cc.closed);
check("Verlässt der Gastgeber den Raum, wird der Raum geschlossen (4006 bei allen)", cd.closed?.code === 4006 && cc.closed?.code === 4006 && Boolean(hasType(cd, "closed")));
check("Der geschlossene Raum existiert nicht mehr (404)", (await api("GET", `/api/rooms/${ccode}`, dave)).status === 404);
check("Dave ist frei (kann einen Raum erstellen)", (await api("POST", "/api/rooms", dave, { format: "commander", deckId: "D-cmd" })).status === 201);

// ---------------------------------------------------------------- 5) Anmelde-Timeout und Hibernation
console.log("\n== Anmelde-Timeout und Hibernation");
const idleRoom = await api("POST", "/api/rooms", carol, { format: "standard", deckId: "C-std" });
const idleCode = idleRoom.body?.code;
const silent = await connect(idleCode, null, { auth: false });
// Der Server beendet die Verbindung nach 10 s (Meldung kommt sofort). Das close-Ereignis des Node-Clients
// folgt lokal erst ca. 10 s später (er wartet auf das Ende der TCP-Verbindung), daher wird die Meldung geprüft.
const timeoutMessage = await waitFor(() => silent.messages.find(m => m.type === "error" && /Anmeldung erforderlich/.test(m.message)), 14000);
check("Wer sich nicht anmeldet, wird nach 10 Sekunden abgewiesen", Boolean(timeoutMessage));
await waitFor(() => silent.closed, 14000);
check("… und die Verbindung wird beendet (4001)", silent.closed?.code === 4001, JSON.stringify(silent.closed));

const c1 = await connect(idleCode, carol);
await waitFor(() => lastRoom(c1));
const before = lastRoom(c1).instance;
console.log(`... warte ${IDLE_WAIT_MS / 1000} s auf Hibernation`);
await sleep(IDLE_WAIT_MS);
send(c1, { type: "ready", ready: true });
await waitFor(() => lastRoom(c1)?.room.players[0].ready);
const after = lastRoom(c1);
check("Nach der Ruhephase funktioniert dieselbe Verbindung weiter", after.room.players[0].ready === true);
check("Das Raumobjekt war zwischenzeitlich hibernierte (neue Instanz)", after.instance !== before, `${before} -> ${after.instance}`);
check("Der Raumzustand blieb erhalten (Spieler, Deck, Format)", after.room.players[0].deck.name === "C Standard" && after.room.format === "standard");

for (const client of [a, b, cb, cd, cc, c1, silent, outsider]) { try { client.ws.close(); } catch {} }
await mock.close();
console.log(failures === 0 ? "\nALLE PRÜFUNGEN BESTANDEN" : `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN`);
process.exit(failures === 0 ? 0 : 1);
