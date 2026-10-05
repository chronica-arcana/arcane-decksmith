# Migration von Firebase auf Supabase – Schritt für Schritt

Diese Anleitung richtet **Supabase** (Login + Datenbank), **Vercel** (Hosting) und die **Cloudflare Worker** (URL-Import, KI) neu ein und übernimmt auf Wunsch die Daten aus Firebase.

Dauer: ca. 45–60 Minuten. Reihenfolge einhalten – spätere Schritte brauchen Werte aus früheren.

| Teil | Alt | Neu |
| --- | --- | --- |
| Login | Firebase Authentication | Supabase Auth (E-Mail + Passwort) |
| Daten | Firestore | Supabase Postgres (`supabase/migrations/`) |
| Zugriffsregeln | `firestore.rules` | Row Level Security + CHECK-Constraints |
| URL-Import | Cloud Function (Blaze-Plan) | Cloudflare Worker `worker/import-proxy.js` |
| KI-Worker | prüft Firebase-ID-Token | prüft Supabase-Token (`worker/supabase-auth.js`) |
| Hosting | GitHub Pages | Vercel |

> **Wichtig:** Passwörter lassen sich aus Firebase nicht mitnehmen. Übernommene Nutzer setzen ihr Passwort einmal über „Passwort vergessen?“ neu (Schritt 8).

---

## Schritt 0 – Vorbereitung (5 Min.)

1. Den Pull-Request mit dieser Migration prüfen und nach `main` mergen (oder lokal auf dem Branch arbeiten). Vercel baut danach automatisch.
2. Notiere dir (Texteditor, nicht ins Repo):
   - die **Vercel-Adresse** (z. B. `https://arcane-decksmith.vercel.app`)
   - die **Cloudflare-Worker-Adressen** (Import-Worker, KI-Worker)
3. Falls du Daten aus Firebase mitnehmen willst: **Firebase-Projekt nicht löschen**, bis Schritt 8 abgeschlossen ist.

---

## Schritt 1 – Supabase-Projekt anlegen (5 Min.)

1. https://supabase.com → **Sign in** (mit GitHub oder E-Mail) → **New project**.
2. Organisation wählen (oder anlegen), dann:
   - **Name:** `arcane-decksmith`
   - **Database password:** *Generate a password* und im Passwortmanager speichern (wird für die App nicht gebraucht, nur für direkte DB-Zugriffe).
   - **Region:** `Central EU (Frankfurt)` (Datenschutz, geringe Latenz).
   - Tarif: **Free** reicht zum Start. Hinweis: Free-Projekte werden nach ca. 7 Tagen ohne Aktivität pausiert (per Klick wieder aktivierbar).
3. **Create new project** und warten, bis der Status grün ist (ca. 2 Minuten).

## Schritt 2 – Werte für die App notieren (2 Min.)

1. Links unten **Project Settings** (Zahnrad) → **API Keys** (bei älteren Oberflächen: **API**).
2. Notiere:
   - **Project URL** → z. B. `https://abcdxyz.supabase.co` → wird zu `VITE_SUPABASE_URL`
   - **Publishable key** (beginnt mit `sb_publishable_…`) **oder** der ältere **anon public**-Key (beginnt mit `eyJ…`) → wird zu `VITE_SUPABASE_ANON_KEY`. Beide funktionieren.
3. **Nicht in die App** gehören der **Secret key / service_role key**. Er umgeht alle Zugriffsregeln. Du brauchst ihn nur kurz für Schritt 8.

## Schritt 3 – Datenbank anlegen (5 Min.)

1. Links **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `supabase/migrations/20261005000000_init.sql` einfügen und **Run** klicken.
3. Erwartet: „Success. No rows returned“. Das Skript ist wiederholbar; ein zweiter Lauf schadet nicht.
4. Prüfen: **Table Editor** zeigt die Tabellen `profiles`, `collection_cards`, `decks`, `market_listings`. Unter **Authentication → Policies** ist bei jeder Tabelle „RLS enabled“ gesetzt.

Was das Skript erzwingt (entspricht den alten Firestore-Regeln): jeder sieht und ändert nur eigene Sammlung/Decks/Profile; Marketplace-Angebote sind für alle angemeldeten Nutzer lesbar, aber nur vom Besitzer änderbar; Felder und Größen werden geprüft; Bilder nur von `cards.scryfall.io`; keine E-Mail im Anzeigenamen.

## Schritt 4 – Login einrichten (5 Min.)

1. **Authentication** → **Sign In / Providers** (oder **Providers**) → **Email**: aktiviert lassen.
2. Optionen dort:
   - **Confirm email**: *an* (empfohlen). Neue Nutzer müssen ihre Adresse per Link bestätigen; die App zeigt dazu einen Hinweis. Für reine Tests darfst du es ausschalten.
   - **Minimum password length**: auf `8` stellen (die App verlangt clientseitig mindestens 6).
3. **Authentication → URL Configuration**:
   - **Site URL:** deine Vercel-Adresse, z. B. `https://arcane-decksmith.vercel.app`
   - **Redirect URLs** → *Add URL* (beide eintragen):
     - `https://arcane-decksmith.vercel.app/**` (deine echte Adresse)
     - `http://localhost:5173/**` (für lokale Entwicklung)
   - Ohne diesen Eintrag funktionieren Bestätigungs- und Passwort-Reset-Links nicht (sie landen sonst auf der falschen Seite).
4. **Wichtig für Produktion – eigener E-Mail-Versand:** Der eingebaute Supabase-Versand ist stark begrenzt (nur wenige E-Mails pro Stunde, nur an Teammitglieder des Projekts). Für echte Nutzer unter **Authentication → Emails → SMTP Settings** einen eigenen SMTP-Dienst eintragen (z. B. Resend, Brevo oder Postmark – alle haben kostenlose Kontingente).
5. Optional: **Authentication → Emails → Templates** – Betreff/Text der Mails auf Deutsch anpassen.

## Schritt 5 – Vercel konfigurieren (5 Min.)

1. https://vercel.com → dein Projekt → **Settings → Environment Variables**.
2. **Alte `VITE_FIREBASE_*`-Variablen und die falsch benannten (`apiKey`, `projectId` …) löschen.**
3. Neu anlegen (Environments: *Production*, *Preview* und *Development* anhaken). Beim Typ **nicht „Sensitive“** wählen, da `VITE_`-Werte ohnehin im Browser landen:

   | Name | Wert |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Project URL aus Schritt 2 |
   | `VITE_SUPABASE_ANON_KEY` | Publishable/anon key aus Schritt 2 |
   | `VITE_SITE_URL` | `https://arcane-decksmith.vercel.app/` (deine Adresse, mit `/` am Ende) |
   | `VITE_IMPORT_PROXY_URL` | Adresse des Import-Workers (Schritt 6), ohne `?url=…` |

   `VITE_AI_WORKER_URL` und `VITE_DECK_INTELLIGENCE_URL` nur setzen, wenn dein KI-Worker eine andere Adresse als `https://arcane-decksmith-ai.arcane-decksmith-api.workers.dev` hat.
4. **Deployments** → beim neuesten Deployment `⋯` → **Redeploy**. (Umgebungsvariablen wirken erst nach einem neuen Build.)

## Schritt 6 – Cloudflare Worker anpassen (10–15 Min.)

Cloudflare Dashboard → **Workers & Pages** → Worker auswählen → **Settings → Variables and secrets**.

### 6a) Import-Worker (`worker/import-proxy.js`)
- Variable `ALLOWED_ORIGINS` (Typ *Text*) = `https://arcane-decksmith.vercel.app` (ohne Pfad und ohne `/` am Ende; mehrere Adressen mit Komma, z. B. zusätzlich `http://localhost:5173` zum Testen).
- Code unverändert lassen (er prüft keinen Login).
- Test im Browser: `https://<import-worker>.workers.dev/?url=https://archidekt.com/decks/<id>` liefert JSON mit Karten.

### 6b) KI-/Deck-Intelligence-Worker (Groq)
Dieser Worker prüfte bisher das Firebase-Token und muss jetzt Supabase-Tokens prüfen.

1. Variablen/Secrets setzen:
   - `SUPABASE_URL` (Text) = Project URL aus Schritt 2
   - `ALLOWED_ORIGINS` (Text) = Vercel-Adresse wie oben
   - `SUPABASE_JWT_SECRET` (**Secret**) – **nur**, wenn dein Supabase-Projekt noch den alten gemeinsamen Schlüssel nutzt: *Project Settings → JWT Keys → Legacy JWT Secret*. Bei Projekten mit asymmetrischen Schlüsseln (Standard bei neuen Projekten, Algorithmus ES256) wird nichts benötigt; der öffentliche Schlüssel wird automatisch über `…/auth/v1/.well-known/jwks.json` geladen.
   - Groq-Schlüssel und weitere vorhandene Secrets **unverändert lassen**.
2. Im Worker-Code die Firebase-Tokenprüfung (Aufruf der Google-Schlüssel/`securetoken`-Prüfung, Prüfung von `aud`/`iss` mit der Firebase-Projekt-ID, ggf. `user_id`/`uid`) durch `authenticate()` aus `worker/supabase-auth.js` ersetzen:

   ```js
   import { authenticate, AuthError } from "./supabase-auth.js"; // im Dashboard-Editor: Inhalt der Datei oben einfügen und "export" entfernen

   // …in fetch(request, env):
   let auth;
   try {
     auth = await authenticate(request, env);   // prüft Signatur, Ablauf, Projekt
   } catch (error) {
     if (error instanceof AuthError) {
       return new Response(JSON.stringify({ error: error.message }), {
         status: error.status,
         headers: { "Content-Type": "application/json", ...corsHeaders }
       });
     }
     throw error;
   }
   const userId = auth.userId;   // vorher: Firebase-UID – z. B. als Schlüssel für Rate-Limits
   ```
3. Code **Deploy**en.
4. **Du hast angeboten, den Worker-Code bereitzustellen:** Schick mir den Code der beiden Worker (ohne Secrets), dann baue ich die Prüfung passend ein und teste sie mit Unit-Tests.

Hinweis zu Rate-Limits/Zählern: Falls der Worker pro Nutzer zählt (KV/Durable Object), ändert sich die Nutzerkennung (Firebase-UID → Supabase-UUID). Alte Zähler verfallen dadurch; das ist unkritisch.

## Schritt 7 – GitHub aufräumen (3 Min.)

1. Repo → **Settings → Secrets and variables → Actions**: Die Secrets `VITE_FIREBASE_*` löschen (werden nicht mehr gebraucht). Vercel liest seine eigenen Variablen.
2. **Settings → Pages**: Veröffentlichung abschalten (Hosting läuft über Vercel).
3. Die Variable `VITE_IMPORT_PROXY_URL` auf GitHub wird nicht mehr genutzt und kann ebenfalls weg.

## Schritt 8 – Daten aus Firebase übernehmen (optional, 15 Min.)

Überspringen, wenn du frisch starten willst (Nutzer registrieren sich neu).

### 8a) Voraussetzungen
- Node.js 22 lokal installiert, Repo geklont (`npm ci`).
- `npm install --no-save firebase-admin` (ändert `package.json` nicht).
- **Firebase-Zugangsdatei:** Firebase Console → Zahnrad → **Projekteinstellungen → Dienstkonten → Neuen privaten Schlüssel generieren** → JSON-Datei speichern (z. B. `serviceAccount.json`; Dateien dieses Namens sind per `.gitignore` ausgeschlossen, trotzdem **nie committen**).
- **Supabase Secret key:** Schritt 2, *Secret key* bzw. *service_role* (nur lokal in der Konsole nutzen).

### 8b) Trockenlauf (schreibt nichts)
```bash
FIREBASE_SERVICE_ACCOUNT=./serviceAccount.json \
SUPABASE_URL=https://abcdxyz.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<secret key> \
node scripts/migrate-firestore-to-supabase.mjs --create-users
```
Die Ausgabe listet je Nutzer die Zahl der Karten und Decks und am Ende eine Zusammenfassung. Nutzer ohne E-Mail im Profil werden übersprungen.

### 8c) Wirklich übernehmen
```bash
… node scripts/migrate-firestore-to-supabase.mjs --create-users --apply
```
- `--create-users` legt fehlende Supabase-Konten an (E-Mail bereits bestätigt, zufälliges Passwort).
- Sammlung, Decks, Profil/Anzeigename und Marketplace-Angebote werden übernommen. In Angeboten wird die alte Nutzer-ID durch die neue ersetzt.
- Einzelne Datensätze, die die neuen Prüfregeln verletzen, werden mit Meldung übersprungen (Exit-Code 2); alles andere wird geschrieben. Das Skript ist wiederholbar (Upsert).
- Mit `--skip-market` bleiben Angebote draußen.

### 8d) Nutzer informieren
Jeder übernommene Nutzer öffnet die Seite → **„Passwort vergessen?“** → E-Mail eingeben → Link in der Mail → neues Passwort festlegen. (Dafür muss der E-Mail-Versand aus Schritt 4 funktionieren.)

### 8e) Danach
- Dienstkonto-Schlüssel in der Firebase Console **löschen** und den Supabase **Secret key** über *Project Settings → API Keys* rotieren, falls er irgendwo gelandet ist.
- Firebase erst abschalten, wenn alle Daten geprüft sind (Schritt 9).

## Schritt 9 – Funktionstest (10 Min.)

Auf der Vercel-Adresse (privates Fenster, damit keine alte Sitzung stört):

1. **Registrieren** mit neuer Adresse → Bestätigungs-Mail → Link anklicken → Anmeldung klappt.
2. **Passwort vergessen** → Mail → Link → „Neues Passwort festlegen“ erscheint → danach angemeldet.
3. **Karte hinzufügen**, Seite neu laden → Karte noch da. In Supabase *Table Editor → collection_cards* erscheint die Zeile.
4. **Deck anlegen/speichern** → `decks` enthält die Zeile.
5. **Import:** große CSV importieren (Fortschritt läuft), **Deck-Link-Import** (Archidekt) testen.
6. **Marketplace:** Anzeigenamen speichern, Karte anbieten, mit zweitem Konto sichtbar prüfen, eigenes Angebot löschen.
7. **KI-Analyse/Deck-Intelligence** starten (benötigt Schritt 6b).
8. Abmelden/Anmelden.

## Fehlersuche

| Symptom | Ursache / Lösung |
| --- | --- |
| Seite zeigt „Supabase ist noch nicht konfiguriert“ | `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` fehlen oder nach dem Setzen **nicht neu deployt** (Schritt 5.4). Namen müssen exakt stimmen. |
| Reset-/Bestätigungslink öffnet die falsche Seite oder „Redirect URL not allowed“ | Schritt 4.3: Site URL und Redirect URLs prüfen (`/**` am Ende). |
| Mails kommen nicht an | Eingebauter Versand begrenzt → eigenes SMTP (Schritt 4.4); Spam-Ordner prüfen. |
| „E-Mail oder Passwort ist nicht korrekt“ nach Migration | Übernommene Konten haben kein bekanntes Passwort → „Passwort vergessen?“. |
| Speichern schlägt mit `violates check constraint` fehl | Datensatz verletzt eine Prüfregel (Größe/Format). Meldung nennt `collection_cards_valid`, `decks_valid` oder `market_listings_valid`. |
| Marketplace/Sammlung leer, obwohl Daten existieren | Migration (Schritt 3) nicht ausgeführt, oder Daten gehören zu einem anderen Konto (neue UUID). |
| Import-Link „nicht erreichbar“ / CORS-Fehler | `ALLOWED_ORIGINS` im Import-Worker enthält die Vercel-Adresse nicht (genau: `https://…`, ohne Pfad). `VITE_IMPORT_PROXY_URL` gesetzt und neu deployt? |
| KI meldet 401 / „Anmeldung erforderlich“ | KI-Worker prüft noch das Firebase-Token (Schritt 6b) oder `SUPABASE_URL`/`SUPABASE_JWT_SECRET` fehlen. In den Worker-Logs (Cloudflare → Logs) steht der genaue Grund. |
| Free-Projekt reagiert nicht | Supabase pausiert inaktive Free-Projekte → im Dashboard **Restore project**. |

## Rückfallplan
Bis zum Löschen des Firebase-Projekts bleiben dessen Daten unverändert. Die alte Firebase-Version liegt im Git-Verlauf (Commit vor dieser Migration), falls du zurück müsstest.
