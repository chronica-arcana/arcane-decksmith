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

> **Wichtig:** Passwörter lassen sich aus Firebase nicht mitnehmen; die Nutzer brauchen in Supabase ein eigenes Konto (gleiche E-Mail). Die **Daten** aller Nutzer überträgst du als Admin in Schritt 8 ohne Terminal.

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
3. **Nicht in die App** gehören der **Secret key / service_role key**. Er umgeht alle Zugriffsregeln. Du brauchst ihn für die normale Einrichtung nicht (nur für die Notlösung per Terminal in Schritt 8e).

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

## Schritt 8 – Alle Daten aus Firebase übernehmen (Admin, ohne Terminal, ca. 15 Min.)

Du überträgst **einmalig den gesamten Inhalt von Firebase für alle Nutzer** nach Supabase: Sammlungen, Decks, Anzeigenamen und Marketplace-Angebote. Die Nutzer müssen nichts tun. Zugeordnet wird über die **E-Mail-Adresse**; dafür müssen die Konten in Supabase schon existieren (mit derselben E-Mail wie in Firebase). Firebase wird nur **gelesen**.

> Voraussetzungen: Schritte 1–7 erledigt, die neue App läuft auf Vercel, und du hast ein Supabase-Konto (das **Admin-Konto**, mit dem du in der App angemeldet bist). Das Firebase-Projekt existiert noch.

### 8a) Schreibrecht für dein Admin-Konto freigeben (Supabase, ca. 2 Min.)
1. Öffne in diesem Repository die Datei `supabase/migration-tools/01-migration-freigeben.sql` (auf GitHub anklicken und den Inhalt kopieren).
2. Supabase → **SQL Editor → New query** → einfügen.
3. Ersetze in der Zeile `admin_email constant text := 'DEINE@EMAIL.DE';` die Adresse durch die E-Mail deines Supabase-Admin-Kontos (genau die, mit der du dich in der App anmeldest).
4. **Run**. Erwartet: „Success“. Meldet das Skript „Kein Supabase-Konto mit der E-Mail … gefunden“, stimmt die Adresse nicht bzw. das Konto fehlt noch.

Das Skript erlaubt vorübergehend **nur diesem einen Konto**, für alle Nutzer zu schreiben, und legt zwei kleine Hilfsfunktionen an. Alle Prüfregeln (Größen, Formate) gelten weiter. Andere Nutzer bekommen dadurch keine zusätzlichen Rechte.

### 8b) Firebase-Schlüssel erzeugen (Firebase Console, ca. 2 Min.)
Die Firestore-Regeln erlauben Nutzern nur ihre eigenen Daten. Zum Lesen **aller** Daten braucht der Admin einen Dienstkonto-Schlüssel:
1. https://console.firebase.google.com → Projekt → **Zahnrad → Projekteinstellungen → Dienstkonten**.
2. Reiter **Firebase Admin SDK** → **Neuen privaten Schlüssel generieren** → **Schlüssel generieren**. Es wird eine `.json`-Datei heruntergeladen.
3. Datei **nirgends hochladen oder weitergeben** (sie gibt vollen Zugriff auf dein Firebase-Projekt). Sie wird nur im Browser deines Computers gelesen.

### 8c) Übernahme in der App (ca. 5 Min.)
1. Öffne die App, **melde dich mit dem Admin-Konto an** und lade die Seite einmal neu (F5). Oben rechts erscheint der Button **„Firebase-Migration“**. (Erscheint er nicht: siehe 8e.)
2. Klicke ihn an, wähle die `.json`-Datei aus (oder füge ihren Inhalt ein) und klicke **„Firebase lesen (noch nichts schreiben)“**.
3. Du siehst eine Übersicht je Nutzer: E-Mail, Anzahl Karten und Decks, und ob ein Supabase-Konto gefunden wurde. Oben stehen die Summen inklusive Marketplace-Angeboten. Prüfe sie.
   - **„nein – wird übersprungen“** heißt: Zu dieser E-Mail gibt es noch kein Supabase-Konto. Lege es an (Registrierung oder Einladung), dann Dialog schließen und Schritt 2 wiederholen.
4. Haken **„Bereits vorhandene Einträge in Supabase überschreiben“** nur setzen, wenn in Supabase schon Daten liegen, die durch die Firebase-Versionen ersetzt werden sollen. Standard ist: Vorhandenes bleibt unverändert.
5. **„Alles nach Supabase übertragen“** klicken und warten (der Fortschritt läuft je Nutzer).
6. Am Ende zeigt eine Tabelle je Nutzer „X von Y übernommen“, außerdem die Marketplace-Zahlen. Einträge, die eine Prüfregel verletzen, sind unter „konnten nicht übernommen werden“ mit Grund aufgelistet; alle anderen sind trotzdem übernommen.

Der Vorgang ist **wiederholbar** (Einträge werden per ID geschrieben, nichts wird doppelt angelegt).

Was übernommen wird: Sammlung, Decks, Anzeigename (nur wenn im neuen Konto noch keiner gesetzt ist, oder bei „überschreiben“) und Marketplace-Angebote (ID und Besitzer werden auf die neuen Nutzer-IDs umgestellt).

### 8d) Aufräumen – wichtig (ca. 3 Min.)
1. Prüfe stichprobenweise in der App (Sammlung, Decks) und in Supabase unter **Table Editor** (`collection_cards`, `decks`, `market_listings`).
2. Supabase **SQL Editor → New query** → Inhalt von `supabase/migration-tools/02-migration-aufraeumen.sql` einfügen → **Run**. Das entfernt das Schreibrecht und die Hilfsfunktionen wieder; der Button verschwindet nach dem Neuladen.
3. **Firebase-Schlüssel löschen:** Google Cloud Console (console.cloud.google.com) → richtiges Projekt wählen → **IAM & Verwaltung → Dienstkonten** → Dienstkonto `firebase-adminsdk-…` → Reiter **Schlüssel** → den gerade erzeugten Schlüssel löschen. Auch die heruntergeladene `.json`-Datei von deinem Rechner löschen.
4. Erst wenn alles geprüft ist, kannst du das Firebase-Projekt abschalten/löschen.

### 8e) Wenn etwas nicht klappt
| Meldung / Symptom | Lösung |
| --- | --- |
| Button „Firebase-Migration“ fehlt | 8a nicht ausgeführt oder falsche E-Mail eingesetzt; nicht mit dem Admin-Konto angemeldet; Seite nicht neu geladen; Demo-Modus aktiv. |
| „Das ist keine Dienstkonto-Schlüsseldatei“ | Es muss die Datei aus 8b sein (enthält `"type": "service_account"`), nicht die `firebaseConfig`. |
| „Google hat die Anmeldung mit dem Schlüssel abgelehnt“ | Schlüssel wurde gelöscht/ist abgelaufen oder die Systemzeit des Rechners geht stark falsch. Neuen Schlüssel erzeugen. |
| „Google-API 403 … has not been used / disabled“ | In der Google Cloud Console unter **APIs & Dienste → Bibliothek** die **Cloud Firestore API** (und optional die **Identity Toolkit API**) aktivieren; 1–2 Minuten warten. |
| „Google-API 403 … permission“ | Das Dienstkonto braucht Leserechte: Google Cloud Console → IAM → dem `firebase-adminsdk-…`-Konto die Rolle **Cloud Datastore Viewer** (oder Firebase Admin) geben. |
| Hinweis „Nutzerverwaltung konnte nicht gelesen werden“ | Nicht schlimm: E-Mails stammen dann aus den Profil-Daten. Fehlt bei einzelnen Nutzern die E-Mail, bleibt „nein – wird übersprungen“ stehen. Identity Toolkit API aktivieren, dann erneut lesen. |
| „Verbindung zu Google … blockiert (Netzwerk/CORS)“ | Der Browser darf die Google-Schnittstelle nicht erreichen (Firmen-Netz, Browser-Erweiterung, Werbeblocker). Anderes Netz/Browser im privaten Fenster ohne Erweiterungen versuchen. Hilft das nicht, gibt es als Notlösung das Terminal-Skript `scripts/migrate-firestore-to-supabase.mjs` (Anleitung im Kopf der Datei). |
| Einträge „fehlgeschlagen“ | Der Datensatz verletzt eine Prüfregel der neuen Datenbank (z. B. zu lange Texte). Der Grund steht in der Liste. |

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
