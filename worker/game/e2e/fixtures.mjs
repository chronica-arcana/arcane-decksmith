/** Testdaten und Schein-Supabase für den Ende-zu-Ende-Test (bildet RLS nach: jeder sieht nur seine Daten). */
import http from "node:http";

const LEGAL = { standard: "legal", commander: "legal" };

export function card(id, name, extra = {}) {
  return {
    id, oracleId: `o-${name}`, name, set: "tst", collectorNumber: id, lang: "en", foil: false, count: 1,
    addedAt: 0, updatedAt: 0, manaValue: 2, colors: [], colorIdentity: [], typeLine: "Artifact",
    legalities: LEGAL, imageUris: { normal: `https://cards.scryfall.io/${id}.jpg` }, ...extra
  };
}
const entry = (record, count = 1) => ({ id: record.id, name: record.name, count });

/** Ein Nutzer mit gültigem Standard-Deck, gültigem Commander-Deck und (optional) einem ungültigen Deck. */
function userData(prefix, { withBadDeck = false } = {}) {
  const std = Array.from({ length: 15 }, (_, i) => card(`${prefix}-s${i}`, `${prefix} Standardkarte ${i}`, { count: 4 }));
  const commander = card(`${prefix}-c0`, `${prefix} Heldin`, { typeLine: "Legendary Creature — Human", colorIdentity: ["G"] });
  const spells = Array.from({ length: 60 }, (_, i) => card(`${prefix}-k${i}`, `${prefix} Zauber ${i}`, { colorIdentity: ["G"] }));
  const forest = card(`${prefix}-f`, "Forest", { typeLine: "Basic Land — Forest", isBasicLand: true, count: 80, colorIdentity: ["G"] });
  const decks = {
    [`${prefix}-std`]: { id: `${prefix}-std`, name: `${prefix} Standard`, format: "standard", commanderIds: [], cards: std.map(r => entry(r, 4)), sideboard: [] },
    [`${prefix}-cmd`]: { id: `${prefix}-cmd`, name: `${prefix} Commander`, format: "commander", commanderIds: [commander.id], cards: [...spells.map(r => entry(r)), entry(forest, 39)], sideboard: [] }
  };
  if (withBadDeck) {
    // Ungültig: Das Deck enthält eine Karte, die nicht in der Sammlung ist.
    const bad = structuredClone(decks[`${prefix}-std`]);
    bad.id = `${prefix}-bad`;
    bad.name = `${prefix} Unvollständig`;
    bad.cards[0] = { id: `${prefix}-geist`, name: "Geisterkarte", count: 4 };
    decks[bad.id] = bad;
  }
  return { collection: [...std, commander, ...spells, forest], decks };
}

export const USERS = {
  alice: { id: "11111111-1111-1111-1111-111111111111", email: "alice@example.com", data: userData("A") },
  bob: { id: "22222222-2222-2222-2222-222222222222", email: "bob@example.com", data: userData("B", { withBadDeck: true }) },
  carol: { id: "33333333-3333-3333-3333-333333333333", email: "carol@example.com", data: userData("C") },
  dave: { id: "44444444-4444-4444-4444-444444444444", email: "dave@example.com", data: userData("D") }
};

const subOf = token => {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub; } catch { return null; }
};

/** Startet den Schein-Server; liefert `{ close, requests }` (requests: Liste der Datenbankabfragen). */
export function startMockSupabase(port = 8797, anonKey = "anon-test-key") {
  const requests = [];
  const byId = Object.fromEntries(Object.values(USERS).map(user => [user.id, user]));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    requests.push({ path: url.pathname, query: url.search, apikey: req.headers.apikey, hasToken: Boolean(token) });
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.apikey !== anonKey) return send(401, { message: "Invalid API key" });

    const me = byId[subOf(token)];
    const filter = name => url.searchParams.get(name)?.replace(/^eq\./, "");
    const wanted = filter("user_id");
    // RLS: fremde Zeilen bleiben unsichtbar.
    if (!me || wanted !== me.id) return send(200, []);

    if (url.pathname === "/rest/v1/decks") {
      const deck = me.data.decks[filter("deck_id")];
      return send(200, deck ? [{ data: deck }] : []);
    }
    if (url.pathname === "/rest/v1/collection_cards") {
      const [from, to] = (req.headers.range ?? "0-999").split("-").map(Number);
      return send(200, me.data.collection.slice(from, to + 1).map(data => ({ data })));
    }
    if (url.pathname === "/rest/v1/profiles") {
      return send(200, me.id === USERS.alice.id ? [{ display_name: "Alice Profil" }] : []);
    }
    return send(404, { message: "unbekannt" });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({
    requests, close: () => new Promise(done => server.close(done))
  })));
}
