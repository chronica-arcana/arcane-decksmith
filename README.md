# Arcane Decksmith – MTG Sammlung & Deckbuilder

React/TypeScript-Projekt (Vite) für Vercel + Supabase (Auth/Postgres) + Cloudflare Workers + Scryfall.

## Wichtige Annahmen

- Die Anwendung speichert Kartendaten als schlankes eigenes Schema, nicht als vollständige Scryfall-Objekte.
- Decks werden aus der Sammlung gebaut. Es werden keine fehlenden Karten automatisch aus Scryfall „herbeigezaubert“.
- Commander wird automatisch nur als einzelner Commander gewählt. Partner-/Friends-Forever-/Doctor's-Companion-Kandidaten werden erkannt, ein Paar wird aber bewusst nicht automatisch kombiniert.
- Standard-Decks werden nach Scryfalls `legalities.standard` gefiltert; die offizielle Mindestgröße ist 60 Karten, Sideboard maximal 15.
- Commander wird als 99 + 1 modelliert (`deckStats().total` zählt Hauptdeck + Commander).
- Preise sind absichtlich nicht Teil des Deck-Scorings.
- Importe raten keine Druckversionen: Set + Collector Number sind autoritativ. Passen mehrere Druckversionen, wird die Zeile beim Sammlungsimport als „mehrdeutig“ markiert und nicht übernommen. Große Importe (über 100 unterschiedliche Einträge) laufen ausschließlich, atomar und deterministisch über Scryfall Bulk Data.
- Precon-Decks (Kartensuche → „Precon-Deck hinzufügen“) stammen aus [MTGJSON](https://mtgjson.com). Jede Karte wird über ihre Scryfall-ID bzw. Set + Collector Number exakt aufgelöst. Der Precon kann zur Sammlung hinzugefügt und/oder als Deck in der Deckliste angelegt werden (Commander werden als Commander übernommen, Zusatzkarten ins Sideboard).

## Marketplace (Tauschangebote)

Alles läuft über den Bereich **Marketplace**: Im Tab **Karten hinzufügen** durchsuchst und filterst du deine Sammlung (Name, Farbe, Typ, Set, Mana Value wie in der Sammlung), legst je Karte die Anzahl Non-Foil/Foil fest (höchstens so viele, wie in der Sammlung sind) und klickst **Im Marketplace anbieten**. Im Tab **Angebote anderer Spieler** sehen angemeldete Spieler die Angebote anderer (Suche nach Namensanfang, „Weitere Angebote laden“), unter **Meine Angebote** verwaltest du deine eigenen. Die Sammlung selbst enthält keine Marketplace-Funktionen.

- Öffentlich für andere angemeldete Spieler sind nur Karte, Anzahl, Richtpreis und der selbst gewählte **Anzeigename**. E-Mail-Adressen werden nicht veröffentlicht; „@“ und Web-Adressen sind im Anzeigenamen nicht erlaubt.
- Es gibt bewusst keinen Kontakt-Kanal in der App. Wie sich Spieler einigen, regeln sie außerhalb.
- Angebote liegen in der Tabelle `market_listings` (ID `<userId>_<cardId>`). Row Level Security erlaubt Lesen nur für angemeldete Nutzer und Schreiben nur für den Besitzer; CHECK-Constraints prüfen Felder/Größen und erlauben nur Scryfall-Bild-URLs (`supabase/migrations/`).
- Sinkt der Bestand einer Karte oder wird sie gelöscht, wird das Angebot automatisch angepasst bzw. entfernt. Änderungen über den Massen-Import werden nicht automatisch abgeglichen.
- Preise sind Richtwerte vom Zeitpunkt des Angebots (Scryfall, EUR).

## KI-Analyse und Deck-Intelligence

Die KI-Erklärungen und Zusatzdaten (Turnier-, Combo- und Community-Signale) laufen über einen **Cloudflare Worker** (nicht im Browser). Die Standard-URL ist `https://arcane-decksmith-ai.arcane-decksmith-api.workers.dev`; sie lässt sich über `VITE_AI_WORKER_URL` bzw. `VITE_DECK_INTELLIGENCE_URL` überschreiben.

Der Quellcode des Workers liegt in `worker/ai-worker.js` (eine Datei, direkt in den Cloudflare-Editor einfügbar). Der Client sendet das Supabase-Access-Token als `Authorization: Bearer …`; Tokenprüfung und Rate-Limits müssen im Worker umgesetzt sein (Token-Prüfung: `worker/supabase-auth.js`, im Worker eingebettet). Ist der Worker nicht erreichbar, zeigt die App einen Hinweis und arbeitet nur mit den Sammlungsdaten weiter.

## Lokal starten

1. Node.js 22 installieren.
2. `npm ci`
3. `.env.example` nach `.env.local` kopieren und die Supabase-Werte eintragen.
4. `npm run dev`
5. Prüfen: `npm run check`, `npm run lint`, `npm test`, `npm run build`

### Umgebungsvariablen

| Variable | Pflicht | Zweck |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | ja (ohne sie ist keine Anmeldung möglich) | Projekt-URL, z. B. `https://abcd.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | ja (ohne ihn ist keine Anmeldung möglich) | Öffentlicher Schlüssel (`anon` bzw. „Publishable key“); durch Row Level Security abgesichert |
| `VITE_IMPORT_PROXY_URL` | nein | Eigener HTTP-Proxy für den URL-Import (`GET ?url=…`, liefert JSON), z. B. der Cloudflare Worker aus `worker/`. Ohne Angabe ist der Link-Import deaktiviert (CSV/TXT geht weiterhin). Bei Vercel wird der Wert als Environment Variable gesetzt. |
| `VITE_AI_WORKER_URL` | nein | Basis-URL des KI-Workers |
| `VITE_DECK_INTELLIGENCE_URL` | nein | URL des Deck-Intelligence-Endpunkts |
| `VITE_SITE_URL` | nein | Öffentliche Basis-URL der Seite; damit wird `og:image` mit absoluter URL erzeugt (bei Vercel manuell als Environment Variable setzen). |

## Supabase

Einrichtung Schritt für Schritt: [docs/MIGRATION-SUPABASE.md](docs/MIGRATION-SUPABASE.md).

- Authentication: E-Mail/Passwort. Die App hat **keine Selbstregistrierung und kein „Passwort vergessen“**; Konten und Passwörter verwaltet der Administrator im Supabase Dashboard (*Authentication → Users*). Zusätzlich sollte dort die Registrierung deaktiviert sein (*Sign In / Providers → „Allow new users to sign up“ aus*).
- Datenbank: `supabase/migrations/*.sql` im SQL Editor ausführen. Tabellen: `profiles`, `collection_cards`, `decks`, `market_listings`. Zugriff nur über Row Level Security, Eingaben werden per CHECK-Constraints geprüft (Ersatz für die früheren Firestore-Regeln).
- **URL-Import (Moxfield, Archidekt, Deckstats)** läuft über den Cloudflare Worker (nächster Abschnitt). Moxfield blockiert automatisierte Abrufe gelegentlich; dann hilft der CSV/TXT-Export aus Moxfield.

### URL-Import über Cloudflare Worker

Der Link-Import läuft über einen Cloudflare Worker im kostenlosen Tarif (`worker/import-proxy.js`; Sicherheitsregeln: nur Moxfield/Archidekt/Deckstats, HTTPS, Host-Prüfung nach Weiterleitungen, 5-MB-Limit).

1. Cloudflare Dashboard → **Workers & Pages → Create → Create Worker**, Namen vergeben (z. B. `arcane-decksmith-import`) und **Deploy** klicken.
2. **Edit code**: Inhalt von `worker/import-proxy.js` einfügen und **Deploy** klicken.
3. Worker → **Settings → Variables and secrets → Add**: Typ *Text*, Name `ALLOWED_ORIGINS`, Wert die Adresse der Seite, z. B. `https://arcane-decksmith.vercel.app` (ohne Pfad). Mehrere Adressen mit Komma trennen.
4. Vercel → **Settings → Environment Variables**: `VITE_IMPORT_PROXY_URL` = Worker-Adresse (z. B. `https://arcane-decksmith-import.<konto>.workers.dev`), danach neu deployen.

Test im Browser: `https://<worker>.workers.dev/?url=https://archidekt.com/decks/<id>` liefert JSON mit den Karten. Moxfield blockiert Abrufe von Rechenzentren gelegentlich; dann hilft der CSV/TXT-Export.

## Hosting (Vercel)

Die Seite wird über Vercel veröffentlicht; der GitHub-Workflow `ci.yml` führt nur Typecheck, Lint und Tests aus.

1. Vercel → **Add New → Project** → Repository `chronica-arcana/arcane-decksmith` importieren (Framework: Vite, Einstellungen kommen aus `vercel.json`).
2. **Settings → Environment Variables**: `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` sowie optional `VITE_IMPORT_PROXY_URL`, `VITE_AI_WORKER_URL`, `VITE_DECK_INTELLIGENCE_URL` und `VITE_SITE_URL` (die Vercel-Adresse, z. B. `https://arcane-decksmith.vercel.app/`) eintragen und neu deployen.
3. Supabase → Authentication → URL Configuration: **Site URL** und **Redirect URLs** auf die Vercel-Domain setzen.
4. Cloudflare-Worker: `ALLOWED_ORIGINS` um die Vercel-Domain ergänzen (ohne Pfad, mehrere Adressen mit Komma).

`base: "./"` bleibt gesetzt; die Navigation nutzt Hash-Routing, daher sind keine Rewrite-Regeln nötig.

## Schlüssel und Sicherheit

`VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` sind öffentlich (stecken im ausgelieferten JavaScript); die Absicherung erfolgt durch Supabase Auth und Row Level Security. Der **service_role-/Secret-Key** gehört nie in den Browser, nie mit `VITE_`-Präfix und nie ins Repository.

## Datenschutz

Kartensuche und Bilder gehen direkt an Scryfall, Precon-Listen an MTGJSON. Die Texterkennung des Scanners (Tesseract) läuft im Browser; WASM-Kern und Sprachdaten werden beim ersten Scannen geladen. Sammlung und Decks liegen bei angemeldeten Nutzern in Supabase (Postgres).
