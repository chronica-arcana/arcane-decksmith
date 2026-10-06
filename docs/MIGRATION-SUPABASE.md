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

> **Wichtig:** Passwörter lassen sich aus Firebase nicht mitnehmen; die Nutzer brauchen in Supabase ein eigenes Konto (gleiche E-Mail). Die **Daten** wurden in Schritt 8 übertragen.

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
3. **Nicht in die App** gehören der **Secret key / service_role key**. Er umgeht alle Zugriffsregeln. Du brauchst ihn für die normale Einrichtung nicht (nur für eine spätere Datenübernahme per Skript aus dem Git-Verlauf).

## Schritt 3 – Datenbank anlegen (5 Min.)

1. Links **SQL Editor** → **New query**.
2. Den kompletten Inhalt von `supabase/migrations/20261005000000_init.sql` einfügen und **Run** klicken.
3. Erwartet: „Success. No rows returned“. Das Skript ist wiederholbar; ein zweiter Lauf schadet nicht.
4. Prüfen: **Table Editor** zeigt die Tabellen `profiles`, `collection_cards`, `decks`, `market_listings`. Unter **Authentication → Policies** ist bei jeder Tabelle „RLS enabled“ gesetzt.

Was das Skript erzwingt (entspricht den alten Firestore-Regeln): jeder sieht und ändert nur eigene Sammlung/Decks/Profile; Marketplace-Angebote sind für alle angemeldeten Nutzer lesbar, aber nur vom Besitzer änderbar; Felder und Größen werden geprüft; Bilder nur von `cards.scryfall.io`; keine E-Mail im Anzeigenamen.

## Schritt 4 – Login einrichten (5 Min.)

1. **Authentication** → **Sign In / Providers** (oder **Providers**) → **Email**: aktiviert lassen.
2. Optionen dort:
   - **Allow new users to sign up**: **aus**. Die App hat keine Registrierung mehr; Konten legt nur der Administrator an (siehe „Konten verwalten“ unten). Ohne diesen Schalter könnte jeder, der die Projekt-URL und den öffentlichen Schlüssel kennt, sich über die API selbst ein Konto anlegen.
   - **Confirm email**: egal, wenn du Konten im Dashboard mit „Auto Confirm User“ anlegst.
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
Der Worker prüfte bisher das Firebase-Token. Die umgebaute Version liegt in **`worker/ai-worker.js`** (komplette Datei, KI-Analyse und Deck-Intelligence unverändert; nur Anmeldung und Origin-Prüfung geändert).

1. Cloudflare → Worker (`arcane-decksmith-ai`) → **Edit code**: den gesamten bisherigen Code durch den Inhalt von `worker/ai-worker.js` ersetzen → **Deploy**.
2. **Settings → Variables and secrets** – diese Einträge setzen:

   | Name | Typ | Wert |
   | --- | --- | --- |
   | `ALLOWED_ORIGINS` | Text | `https://arcane-decksmith.vercel.app` (deine Adresse, ohne Pfad; mehrere mit Komma, z. B. zusätzlich `http://localhost:5173`) |
   | `SUPABASE_URL` | Text | Project URL aus Schritt 2 (z. B. `https://abcdxyz.supabase.co`) |
   | `SUPABASE_JWT_SECRET` | Secret | **nur** bei einem Projekt mit altem gemeinsamem Schlüssel: *Project Settings → JWT Keys → Legacy JWT Secret*. Bei neuen Projekten (ES256) weglassen, der öffentliche Schlüssel wird automatisch geladen. |
   | `GROQ_API_KEY` | Secret | unverändert lassen |
   | `TOPDECK_API_KEY` | Secret | unverändert lassen |

3. Was sich gegenüber dem alten Worker geändert hat:
   - Die feste Origin `https://chronica-arcana.github.io` ist weg; erlaubt sind nur die Seiten aus `ALLOWED_ORIGINS`. Fehlt die Variable, antwortet der Worker mit 500 „ALLOWED_ORIGINS fehlt“.
   - Die Prüfung des Firebase-ID-Tokens (Google-Zertifikate, Projekt-ID `arcane-decksmith-6a99f`) ist durch die Prüfung des Supabase-Tokens ersetzt (Signatur, Ablauf, Projekt, Zielgruppe).
   - Fehlermeldung ohne gültige Anmeldung: 401 „Anmeldung fehlt“ bzw. „Anmeldung konnte nicht bestätigt werden“. 500/503 bedeutet: `SUPABASE_URL`/`SUPABASE_JWT_SECRET` fehlen oder falsch.
4. Test (ohne Anmeldung muss der Worker ablehnen): im Browser ist `POST` nötig, daher in der App eine KI-Analyse starten. In Cloudflare → Worker → **Logs** siehst du bei Problemen die genaue Ursache („Supabase token verification failed: …“).

Hinweis: Der Worker hat keine eigenen Rate-Limits (auch vorher nicht); die Nutzerkennung wird derzeit nicht für Zähler verwendet.

## Schritt 7 – GitHub aufräumen (3 Min.)

1. Repo → **Settings → Secrets and variables → Actions**: Die Secrets `VITE_FIREBASE_*` löschen (werden nicht mehr gebraucht). Vercel liest seine eigenen Variablen.
2. **Settings → Pages**: Veröffentlichung abschalten (Hosting läuft über Vercel).
3. Die Variable `VITE_IMPORT_PROXY_URL` auf GitHub wird nicht mehr genutzt und kann ebenfalls weg.

## Schritt 8 – Daten aus Firebase übernehmen (abgeschlossen)

Die Übernahme aller Firebase-Daten (Sammlungen, Decks, Anzeigenamen, Marketplace-Angebote) ist erfolgt. Die dafür gebauten Werkzeuge (Admin-Dialog in der App, Terminal-Skript, SQL-Freigabe) wurden danach wieder aus dem Repository entfernt. Sie stehen weiterhin im Git-Verlauf (zuletzt vorhanden im Commit `624aeeb`, „Merge pull request #30“), falls eine Übernahme wiederholt werden muss.

**Wichtig – Freigabe zurücknehmen:** Falls du nach der Migration das Aufräum-Skript noch nicht ausgeführt hast, führe jetzt im Supabase **SQL Editor** Folgendes aus. Es entfernt das vorübergehende Schreibrecht für das Admin-Konto und ist beliebig oft ausführbar:

```sql
drop policy if exists migration_admin_all on public.profiles;
drop policy if exists migration_admin_all on public.collection_cards;
drop policy if exists migration_admin_all on public.decks;
drop policy if exists migration_admin_all on public.market_listings;

drop function if exists public.migration_user_ids(text[]);
drop function if exists public.migration_is_admin();
drop function if exists arcane_private.is_migration_admin();
drop table if exists arcane_private.migration_admin;
```

Außerdem sollte der **Firebase-Dienstkonto-Schlüssel** in der Google Cloud Console (IAM & Verwaltung → Dienstkonten → Schlüssel) gelöscht und die heruntergeladene `.json`-Datei vom Rechner entfernt sein.

## Schritt 9 – Funktionstest (10 Min.)

Auf der Vercel-Adresse (privates Fenster, damit keine alte Sitzung stört):

1. **Anmelden** mit einem vom Administrator angelegten Konto.
2. Kontrolle: Auf der Startseite gibt es **keinen** Demo-Modus, **keine** Registrierung und **kein** „Passwort vergessen“.
3. **Karte hinzufügen**, Seite neu laden → Karte noch da. In Supabase *Table Editor → collection_cards* erscheint die Zeile.
4. **Deck anlegen/speichern** → `decks` enthält die Zeile.
5. **Import:** große CSV importieren (Fortschritt läuft), **Deck-Link-Import** (Archidekt) testen.
6. **Marketplace:** Anzeigenamen speichern, Karte anbieten, mit zweitem Konto sichtbar prüfen, eigenes Angebot löschen.
7. **KI-Analyse/Deck-Intelligence** starten (benötigt Schritt 6b).
8. Abmelden/Anmelden.

## Fehlersuche

| Symptom | Ursache / Lösung |
| --- | --- |
| Startseite zeigt „Die Anmeldung ist nicht eingerichtet“ | `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` fehlen oder nach dem Setzen **nicht neu deployt** (Schritt 5.4). Namen müssen exakt stimmen. |
| „E-Mail oder Passwort ist nicht korrekt“ | Passwort im Supabase Dashboard neu setzen (siehe „Konten verwalten“). |
| Speichern schlägt mit `violates check constraint` fehl | Datensatz verletzt eine Prüfregel (Größe/Format). Meldung nennt `collection_cards_valid`, `decks_valid` oder `market_listings_valid`. |
| Marketplace/Sammlung leer, obwohl Daten existieren | Migration (Schritt 3) nicht ausgeführt, oder Daten gehören zu einem anderen Konto (neue UUID). |
| Import-Link „nicht erreichbar“ / CORS-Fehler | `ALLOWED_ORIGINS` im Import-Worker enthält die Vercel-Adresse nicht (genau: `https://…`, ohne Pfad). `VITE_IMPORT_PROXY_URL` gesetzt und neu deployt? |
| KI meldet 401 / „Anmeldung erforderlich“ | KI-Worker prüft noch das Firebase-Token (Schritt 6b) oder `SUPABASE_URL`/`SUPABASE_JWT_SECRET` fehlen. In den Worker-Logs (Cloudflare → Logs) steht der genaue Grund. |
| Free-Projekt reagiert nicht | Supabase pausiert inaktive Free-Projekte → im Dashboard **Restore project**. |

## Rückfallplan
Bis zum Löschen des Firebase-Projekts bleiben dessen Daten unverändert. Die alte Firebase-Version liegt im Git-Verlauf (Commit vor dieser Migration), falls du zurück müsstest.

## Konten verwalten (Administrator)

Die App hat **keine Selbstregistrierung, keinen Demo-Modus und kein „Passwort vergessen“**. Alles läuft über das Supabase Dashboard unter **Authentication → Users**:
- **Neues Konto:** *Add user → Create new user*, E-Mail und Passwort eintragen, **Auto Confirm User** angehakt lassen. Die Daten des Nutzers entstehen beim ersten Speichern.
- **Passwort ändern/zurücksetzen:** Beim Nutzer `⋯ → Update password` bzw. ein neues Passwort setzen und dem Nutzer sicher mitteilen.
- **Konto sperren oder löschen:** `⋯ → Ban user` bzw. `Delete user` (löscht auch alle Daten des Nutzers).
- **Registrierung über die API verhindern:** *Sign In / Providers → „Allow new users to sign up“* ausschalten (siehe Schritt 4).
