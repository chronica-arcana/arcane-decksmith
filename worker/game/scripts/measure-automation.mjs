#!/usr/bin/env node
/**
 * Misst die Automatisierungsquote der bevorzugten Commander-Sets mit dem Parser der Spiel-Engine.
 *
 * Aufruf: node worker/game/scripts/measure-automation.mjs <Cache-Ordner> [--json Ausgabe.json] [--gaps Ausgabe.json]
 * Der Cache-Ordner enthält MTGJSON-Daten: DeckList.json und decks/<fileName>.json (wie beim Audit-Skript).
 *
 * Eine Karte gilt als vollständig automatisiert, wenn kein Satz ihres Texts unverstanden bleibt
 * (keine `unparsed`-Teile in Zauber, Modi, Auslösern, Fähigkeiten und keine Hinweis-Zeilen außer reinen Schlüsselwörtern).
 */
import fs from "node:fs";
import path from "node:path";
import { parseCardText } from "../src/cardText.js";

const PRIORITY_SETS = ["FIC", "TRC", "FRC", "TMC", "DRC", "ECC", "C20", "MIC", "VOC", "ONC", "LCC", "TDC", "EOC"];
const FOCUS_SETS = ["FIC", "TRC"];
const KEYWORD_NOTE = /^(Flying|Vigilance|Reach|Haste|Trample|Deathtouch|Lifelink|Menace|Flash|Hexproof|Defender|Indestructible|First strike|Double strike)/i;

const args = process.argv.slice(2);
const cache = args[0];
if (!cache) {
  console.error("Aufruf: node measure-automation.mjs <Cache-Ordner> [--json datei] [--gaps datei]");
  process.exit(1);
}
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const deckList = JSON.parse(fs.readFileSync(path.join(cache, "DeckList.json"), "utf8")).data.filter(deck => deck.type === "Commander Deck" && !/Collector/.test(deck.name));

export function gapsOf(card) {
  const rules = parseCardText({ name: card.name, typeLine: card.type, oracleText: card.text ?? "" });
  return [
    ...(rules.spell?.unparsed ?? []),
    ...(rules.spell?.modes?.flatMap(mode => mode.unparsed) ?? []),
    ...rules.triggers.flatMap(trigger => trigger.unparsed),
    ...rules.activated.flatMap(ability => ability.unparsed),
    ...rules.notes.filter(note => !KEYWORD_NOTE.test(note))
  ];
}

function measure(codes) {
  const cards = new Map();
  const decks = [];
  for (const entry of deckList.filter(deck => codes.includes(deck.code))) {
    const data = JSON.parse(fs.readFileSync(path.join(cache, "decks", `${entry.fileName}.json`), "utf8")).data;
    const names = new Set();
    for (const board of ["commander", "mainBoard", "sideBoard"]) {
      for (const card of data[board] ?? []) {
        if (/^Basic Land/.test(card.type)) continue;
        names.add(card.name);
        if (!cards.has(card.name)) cards.set(card.name, card);
      }
    }
    decks.push({ name: `${entry.code} ${entry.name}`, names: [...names] });
  }
  const gaps = new Map([...cards].map(([name, card]) => [name, gapsOf(card)]));
  const automated = [...gaps.values()].filter(list => list.length === 0).length;
  return {
    cards: cards.size,
    automated,
    rate: Math.round((automated / Math.max(1, cards.size)) * 1000) / 10,
    decks: decks.map(deck => ({ name: deck.name, rate: Math.round((deck.names.filter(name => gaps.get(name).length === 0).length / deck.names.length) * 100) })),
    gaps: [...gaps].filter(([, list]) => list.length > 0).map(([name, list]) => ({ name, type: cards.get(name).type, text: cards.get(name).text, gaps: list }))
  };
}

const focus = measure(FOCUS_SETS);
const all = measure(PRIORITY_SETS);
console.log(`Star Trek + Final Fantasy: ${focus.automated}/${focus.cards} (${focus.rate} %)`);
for (const deck of focus.decks) console.log(`  ${deck.rate}% ${deck.name}`);
console.log(`Alle ${deckList.filter(deck => PRIORITY_SETS.includes(deck.code)).length} Set-Decks: ${all.automated}/${all.cards} (${all.rate} %)`);
const json = option("--json");
if (json) fs.writeFileSync(json, JSON.stringify({ measuredAt: new Date().toISOString(), focus: { cards: focus.cards, automated: focus.automated, rate: focus.rate, decks: focus.decks }, all: { cards: all.cards, automated: all.automated, rate: all.rate } }, null, 2) + "\n");
const gapFile = option("--gaps");
if (gapFile) fs.writeFileSync(gapFile, JSON.stringify({ focus: focus.gaps, all: all.gaps }));
