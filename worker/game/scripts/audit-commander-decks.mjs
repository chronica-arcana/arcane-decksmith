#!/usr/bin/env node
/**
 * Prüft, wie viele Karten aller Commander-Precons (MTGJSON) die Regel-Engine vollständig automatisch versteht.
 * Aufruf (braucht Netzwerk zu mtgjson.com):  node worker/game/scripts/audit-commander-decks.mjs [Cache-Ordner] [Deck-Filter]
 * Ausgabe: Gesamtquote, Quote je Deck und die häufigsten Lücken (nach Anzahl der Decks gewichtet).
 */
import fs from "node:fs";
import path from "node:path";
import { parseCardText } from "../src/cardText.js";

const API = "https://mtgjson.com/api/v5";
const cache = path.resolve(process.argv[2] ?? "/tmp/arcane-decksmith-audit");
const filter = (process.argv[3] ?? "").toLowerCase();
fs.mkdirSync(cache, { recursive: true });

async function getJson(url, file) {
  const target = path.join(cache, file);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return JSON.parse(fs.readFileSync(target, "utf8"));
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  fs.writeFileSync(target, text);
  return JSON.parse(text);
}

const KEYWORD_LINE = /^(Flying|Vigilance|Reach|Haste|Trample|Deathtouch|Lifelink|Menace|Flash|Hexproof|Defender|Indestructible|First strike|Double strike)/i;
function gaps(card) {
  const r = parseCardText({ name: card.name, typeLine: card.type ?? "", oracleText: card.text ?? "" });
  return [
    ...(r.spell?.unparsed ?? []),
    ...(r.spell?.modes?.flatMap(mode => mode.unparsed) ?? []),
    ...r.triggers.flatMap(trigger => trigger.unparsed),
    ...r.activated.flatMap(ability => ability.unparsed),
    ...r.notes.filter(note => !KEYWORD_LINE.test(note))
  ];
}

const list = (await getJson(`${API}/DeckList.json`, "DeckList.json")).data.filter(deck => deck.type === "Commander Deck" && (!filter || deck.name.toLowerCase().includes(filter) || deck.code.toLowerCase() === filter));
const unique = new Map();
const perDeck = [];
for (const entry of list) {
  const deck = (await getJson(`${API}/decks/${encodeURIComponent(entry.fileName)}.json`, `${entry.fileName}.json`)).data;
  const names = new Set();
  for (const board of ["commander", "mainBoard", "sideBoard"]) for (const card of deck[board] ?? []) if (card.name && !/^Basic Land/.test(card.type ?? "")) {
    names.add(card.name);
    if (!unique.has(card.name)) unique.set(card.name, card);
  }
  perDeck.push({ name: `${deck.name} (${deck.code})`, names: [...names] });
}

const status = new Map();
for (const [name, card] of unique) status.set(name, card.text ? gaps(card) : []);
const done = [...status.values()].filter(items => items.length === 0).length;
console.log(`Karten (ohne Standardländer): ${unique.size}, vollständig automatisch: ${done} (${((done / unique.size) * 100).toFixed(1)} %)\n`);
console.log("Quote je Deck:");
for (const deck of perDeck.sort((a, b) => a.name.localeCompare(b.name))) {
  const ok = deck.names.filter(name => status.get(name).length === 0).length;
  console.log(`  ${String(Math.round((ok / deck.names.length) * 100)).padStart(3)} %  ${deck.name}`);
}
const weight = new Map();
for (const deck of perDeck) for (const name of deck.names) if (status.get(name).length > 0) weight.set(name, (weight.get(name) ?? 0) + 1);
console.log("\nHäufigste Lücken (Decks · Karte · offener Text):");
for (const [name, decks] of [...weight].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(decks).padStart(3)} · ${name} · ${status.get(name)[0].slice(0, 90)}`);
