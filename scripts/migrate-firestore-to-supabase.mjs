#!/usr/bin/env node
/**
 * Übernimmt Konten und Daten aus Firebase (Firestore) nach Supabase.
 *
 * Vorbereitung (einmalig, außerhalb des Projekts installieren, damit package.json sauber bleibt):
 *   npm install --no-save firebase-admin
 *
 * Aufruf (zuerst Trockenlauf, schreibt nichts):
 *   FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json \
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role / secret key> \
 *   node scripts/migrate-firestore-to-supabase.mjs
 *
 * Danach wirklich schreiben:
 *   … node scripts/migrate-firestore-to-supabase.mjs --apply
 *
 * Optionen:
 *   --apply           schreibt in Supabase (ohne: nur zählen und prüfen)
 *   --create-users    legt fehlende Supabase-Konten an (E-Mail bestätigt, zufälliges Passwort);
 *                     die Nutzer setzen ihr Passwort über „Passwort vergessen?“ neu.
 *   --skip-market     Tauschangebote nicht übernehmen
 *
 * Passwörter lassen sich aus Firebase nicht mitnehmen. Der Service-Role-Key und die
 * Service-Account-Datei sind Geheimnisse: nie committen, nach der Migration widerrufen.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  cardRow, chunk, deckRow, listingRow, normalizeEmail, profileRow
} from "./migration-lib.mjs";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const CREATE_USERS = args.has("--create-users");
const SKIP_MARKET = args.has("--skip-market");

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Umgebungsvariable ${name} fehlt (siehe Kopf der Datei).`);
    process.exit(1);
  }
  return value;
}

let admin;
try {
  admin = await import("firebase-admin");
} catch {
  console.error("firebase-admin fehlt. Bitte `npm install --no-save firebase-admin` ausführen.");
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(need("FIREBASE_SERVICE_ACCOUNT"), "utf8"));
admin.default.initializeApp({ credential: admin.default.credential.cert(serviceAccount) });
const firestore = admin.default.firestore();

const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false }
});

const stats = {
  users: 0, usersCreated: 0, usersMissing: 0,
  cards: 0, decks: 0, profiles: 0, listings: 0, listingsSkipped: 0, failedRows: 0
};

/** E-Mail → Supabase-Nutzer-ID (alle vorhandenen Konten, seitenweise). */
async function loadSupabaseUsers() {
  const map = new Map();
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const user of data.users) if (user.email) map.set(normalizeEmail(user.email), user.id);
    if (data.users.length < 1000) return map;
  }
}

/** Schreibt Zeilen als Upsert; bei einem Fehler im Block werden die Zeilen einzeln versucht. */
async function writeRows(table, rows, onConflict, label) {
  if (!APPLY || rows.length === 0) return;
  for (const block of chunk(rows)) {
    const { error } = await supabase.from(table).upsert(block, { onConflict });
    if (!error) continue;
    for (const row of block) {
      const single = await supabase.from(table).upsert(row, { onConflict });
      if (single.error) {
        stats.failedRows += 1;
        console.warn(`  ! ${label} ${row.card_id ?? row.deck_id ?? row.id}: ${single.error.message}`);
      }
    }
  }
}

const supabaseUsers = await loadSupabaseUsers();
const uidMap = new Map(); // Firebase-UID → Supabase-ID

console.log(APPLY ? "== SCHREIBMODUS ==" : "== Trockenlauf (nichts wird geschrieben) ==");

for (const ref of await firestore.collection("users").listDocuments()) {
  const profileSnap = await ref.get();
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const email = normalizeEmail(profile.email);
  if (!email) {
    console.warn(`- Nutzer ${ref.id}: keine E-Mail im Profil, übersprungen`);
    stats.usersMissing += 1;
    continue;
  }
  stats.users += 1;

  let supabaseId = supabaseUsers.get(email);
  if (!supabaseId && CREATE_USERS) {
    if (APPLY) {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        password: randomBytes(24).toString("base64url")
      });
      if (error) {
        console.warn(`- ${email}: Konto konnte nicht angelegt werden: ${error.message}`);
        stats.usersMissing += 1;
        continue;
      }
      supabaseId = data.user.id;
    } else {
      supabaseId = `dry-run-${ref.id}`;
    }
    stats.usersCreated += 1;
  }
  if (!supabaseId) {
    console.warn(`- ${email}: kein Supabase-Konto (mit --create-users anlegen oder zuerst registrieren), übersprungen`);
    stats.usersMissing += 1;
    continue;
  }
  uidMap.set(ref.id, supabaseId);

  const [cards, decks] = await Promise.all([ref.collection("collection").get(), ref.collection("decks").get()]);
  stats.cards += cards.size;
  stats.decks += decks.size;
  stats.profiles += 1;
  console.log(`- ${email}: ${cards.size} Karten, ${decks.size} Decks`);

  if (APPLY) {
    await writeRows("profiles", [profileRow(supabaseId, profile)], "user_id", "Profil");
    await writeRows("collection_cards", cards.docs.map((d) => cardRow(supabaseId, d.id, d.data())), "user_id,card_id", "Karte");
    await writeRows("decks", decks.docs.map((d) => deckRow(supabaseId, d.id, d.data())), "user_id,deck_id", "Deck");
  }
}

if (!SKIP_MARKET) {
  const listings = await firestore.collection("marketListings").get();
  const rows = [];
  for (const doc of listings.docs) {
    const row = listingRow(doc.id, doc.data(), uidMap);
    if (row) rows.push(row); else stats.listingsSkipped += 1;
  }
  stats.listings = rows.length;
  await writeRows("market_listings", rows.map(({ legacyId, ...row }) => row), "id", "Angebot");
}

console.log("\nErgebnis:", stats);
if (!APPLY) console.log("Trockenlauf beendet. Mit --apply wirklich schreiben.");
if (stats.failedRows > 0) process.exitCode = 2;
