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

> **Wichtig:** Das Supabase-Konto ist ein neues Konto (Registrierung in Schritt 8a). Die **Daten** aus Firebase übernimmst du danach mit dem Dialog „Daten aus Firebase“ (Schritt 8), ganz ohne Terminal.

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
3. **Nicht in die App** gehören der **Secret key / service_role key**. Er umgeht alle Zugriffsregeln. Du brauchst ihn für die normale Einrichtung nicht (nur für die optionale Terminal-Variante in Schritt 8).

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

## Schritt 8 – Daten aus Firebase übernehmen (optional, ohne Terminal, ca. 10 Min.)

Überspringen, wenn du frisch starten willst. Die Übernahme läuft **in der App selbst**: Du meldest dich mit deinem **alten Firebase-Login** an, und die App kopiert **deine eigene** Sammlung und deine Decks in dein neues Konto. Jeder Nutzer macht das für sich selbst; ein Admin-Zugriff ist nicht nötig. Dein altes Passwort bleibt dafür gültig (es wird nur in Firebase verwendet und nicht gespeichert).

> Voraussetzung: Das Firebase-Projekt existiert noch (nicht löschen, bevor alle fertig sind) und Schritte 1–7 sind erledigt.

### 8a) Neues Konto anlegen und anmelden
1. Öffne die Vercel-Adresse und **registriere dich** mit derselben E-Mail wie im alten Konto (oder einer anderen, das ist egal).
2. Bestätige die E-Mail über den Link in der Bestätigungs-Mail und melde dich an.

### 8b) Firebase-Konfiguration kopieren
1. https://console.firebase.google.com → dein Projekt → **Zahnrad → Projekteinstellungen → Allgemein**.
2. Nach unten zu **Meine Apps** scrollen (Web-App `</>`), unter **SDK-Einrichtung und -Konfiguration** **Konfig** wählen.
3. Den gesamten Block `const firebaseConfig = { … };` markieren und kopieren (mit der Maus oder dem Kopier-Symbol).

### 8c) Übernahme-Dialog
1. In der App oben rechts auf **„Daten aus Firebase“** klicken.
2. Die kopierte Konfiguration in das große Feld einfügen.
3. **E-Mail und Passwort deines alten Firebase-Kontos** eintragen → **Aus Firebase laden**.
4. Die App zeigt, was gefunden wurde („X Karten und Y Decks“).
5. Den Haken **„Bereits vorhandene Einträge … überschreiben“** nur setzen, wenn im neuen Konto schon Karten mit gleicher ID liegen, die ersetzt werden sollen. Ohne Haken bleibt Vorhandenes unverändert.
6. **In dieses Konto übernehmen** klicken und warten, bis „Fertig“ erscheint (der Fortschritt wird angezeigt).
7. Die Zusammenfassung zeigt je Bereich „übernommen / übersprungen / fehlgeschlagen“. Fehlgeschlagene Einträge sind ausklappbar mit Grund. Danach **„Fertig – Daten neu laden“** klicken.

Gut zu wissen:
- Der Vorgang ist wiederholbar. Er ändert nichts in Firebase (nur Lesen).
- **Marketplace-Angebote** werden nicht übernommen; biete die Karten im Marketplace einfach neu an. Der Anzeigename wird übernommen, falls im neuen Konto noch keiner gesetzt ist.
- Mehrere Nutzer? Jeder wiederholt 8a–8c mit dem eigenen alten Login.

### 8d) Wenn etwas nicht klappt
| Meldung | Lösung |
| --- | --- |
| „E-Mail oder Passwort des alten Firebase-Kontos stimmen nicht“ | Das sind die **alten** Firebase-Zugangsdaten. Falls vergessen: Im Firebase-Projekt unter *Authentication → Users* beim Konto `⋯ → Passwort zurücksetzen` bzw. die Zurücksetzen-Mail auslösen. |
| „In der eingefügten Konfiguration fehlen …“ | Den **kompletten** Block aus 8b kopieren (`apiKey`, `authDomain`, `projectId` sind Pflicht). |
| „API-Schlüssel ist auf andere Webseiten beschränkt“ | Google Cloud Console (console.cloud.google.com) → Projekt wählen → **APIs & Dienste → Anmeldedaten** → den „Browser key“ öffnen → unter *Website-Einschränkungen* deine Vercel-Adresse (`https://…vercel.app/*`) hinzufügen → speichern, 1–2 Minuten warten. |
| „Firestore verweigert den Zugriff“ | Die Firestore-Regeln im Firebase-Projekt wurden geändert oder das Projekt wurde gelöscht. Unter *Firestore Database → Regeln* muss der Besitzer seine Daten lesen dürfen (`users/{userId}/…`). |
| Einträge „fehlgeschlagen“ | Der Datensatz verletzt eine Prüfregel der neuen Datenbank (z. B. zu lange Texte). Der Grund steht in der Liste; die übrigen Einträge sind trotzdem übernommen. |
| Die Schaltfläche „Daten aus Firebase“ fehlt | Sie erscheint nur mit echtem Konto, nicht im Demo-Modus. Vercel-Deployment mit dem aktuellen `main` abwarten. |

### 8e) Danach
- Prüfe in der App Sammlung und Decks (Schritt 9).
- Erst wenn alle Nutzer ihre Daten übernommen haben, kannst du das Firebase-Projekt abschalten bzw. löschen (Firebase Console → Projekteinstellungen → ganz unten *Projekt löschen*). Vorher ggf. in der Firebase Console unter *Firestore Database* stichprobenartig vergleichen.
- Der Button „Daten aus Firebase“ kann nach der Migration wieder aus der App entfernt werden (sag Bescheid, dann baue ich ihn zurück).

<details>
<summary>Alternative für Fortgeschrittene (Terminal): Massenübernahme aller Nutzer</summary>

Das Skript `scripts/migrate-firestore-to-supabase.mjs` übernimmt alle Nutzer auf einmal und legt fehlende Konten an. Es braucht Node.js, den Firebase-Dienstkonto-Schlüssel und den Supabase Secret key und wird mit `node scripts/migrate-firestore-to-supabase.mjs --create-users` (Trockenlauf) bzw. mit `--apply` gestartet. Details stehen im Kopf der Datei. Für die normale Nutzung ist der Dialog oben einfacher.
</details>

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
