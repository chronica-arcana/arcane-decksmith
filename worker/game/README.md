# Spiel-Worker (Online-Spiel: Räume, Spieltisch, Verlauf)

Cloudflare Worker mit einem **Durable Object je Raum**. Er ist die Grundlage für das geplante Online-Spiel
(digitaler Spieltisch) und beweist in diesem ersten Schritt drei Dinge:

1. Angemeldete Nutzer (Supabase-Token) verbinden sich per WebSocket mit einem Raum.
2. Der **Spielstand liegt auf dem Server**; jeder Spieler bekommt nur **seine eigene Sicht** (eigene Hand sichtbar, vom
   Gegner nur die Kartenzahl, die Bibliothek nie).
3. Das Objekt nutzt **WebSocket-Hibernation**: ruhende Räume verbrauchen keine Rechenzeit, der Zustand bleibt erhalten.

## Festgelegte Entscheidungen
| Thema | Entscheidung |
| --- | --- |
| Spielart | Digitaler Spieltisch, keine Regelautomatik |
| Mogelschutz | Wichtig → Server-geführter Spielstand, getrennte Sichten, Mischen auf dem Server |
| Formate | Standard (2 Spieler) und Commander (2 bis 4 Spieler) |
| Zugang | Nur per Einladungscode, nur angemeldete Konten |
| Eigene Karten | Strenge Prüfung auf dem Server gegen die Sammlung. Basic Lands gemäß offiziellen Regeln: beliebig viele erlaubt, keine Besitzprüfung |

## Meilenstein 1: Räume mit Einladungscode
- Ein Konto kann **immer nur in einem Raum** sein (Durable Object `Lobby` führt das Register, mit Selbstheilung).
- Der Einladungscode (6 Zeichen) ist **24 Stunden gültig**; danach schließt der Raum automatisch.
- Beim Erstellen und Beitreten wird das Deck **auf dem Server streng geprüft** (Besitz in der Sammlung, Formatregeln aus
  `src/deckBuilder.ts`, Basic Lands ohne Besitzprüfung). Ein ungültiges Deck verhindert das Betreten; die App zeigt die Gründe.
- Raum: bereit/nicht bereit, Gastgeber startet (mind. 2 Spieler, alle bereit), Gastgeber kann entfernen, Chat.
- HTTP-Schnittstelle (Bearer-Token): `GET /api/rooms/mine`, `GET /api/rooms/<code>`, `POST /api/decks/check`, `POST /api/rooms`, `POST /api/rooms/join`, `POST /api/rooms/leave`, `POST /api/rooms/kick`, `GET /api/history`.
- WebSocket `/room/<code>`: Client → Server `auth`, `chat`, `ready`, `start`, `rematch`, `game`; Server → Client `welcome`, `room`, `game`, `chat`, `system`, `closed`, `error`.
- Dateien: `src/index.js` (Worker, `Lobby`, `GameRoom`), `roomLogic.js`, `deckValidation.js`, `supabaseData.js`, `protocol.js` (alle mit Tests).
- Die App-Seite ist versteckt unter **`#/spielen`**.

## Spieltisch (Meilensteine 2 bis 5)
- **Server-geführter Spielstand** (`gameLogic.js`): Bibliotheken werden auf dem Server mit `crypto.getRandomValues` gemischt. Jeder Spieler
  bekommt nur seine Sicht: eigene Hand, bei anderen nur Kartenzahlen; Bibliotheken und verdeckte Karten sieht nie jemand.
- **Keine Regelautomatik.** Spieler bewegen ihre eigenen Karten selbst (Zonen: Bibliothek, Hand, Schlachtfeld, Friedhof, Exil, Kommandozone).
  Automatisch sind nur Komfortfunktionen: Starthand und London-Mulligan (bei Commander der erste kostenlos), Startspieler per Zufall,
  Zugwechsel mit Enttappen und Ziehen (im 2-Spieler-Spiel zieht der Startspieler im ersten Zug nicht), Ausscheiden bei 0 Leben,
  10 Giftmarken oder 21 Kommandantenschaden, Sieger bei einem verbleibenden Spieler.
- **Aktionen:** ziehen, mahlen, mischen, Bibliothek ansehen/durchsuchen, bewegen (auch verdeckt), tappen, umdrehen, Karte zeigen,
  Marker auf Karten, Spielsteine, Leben, Gift/Energie/Erfahrung, Kommandantenschaden und -steuer, Würfel, Münze, Phase/Zug, Aufgeben.
- **Öffentlicher Spielverlauf:** nennt Karten nur, wenn sie öffentlich werden (z. B. Bibliothek → Hand bleibt „eine Karte“).
- **Commander mit bis zu 4 Spielern**, Revanche (Gastgeber), Verlassen mitten im Spiel zählt als Aufgabe.
- **Verlauf:** Durable Object `History` je Konto (letzte 50 Spiele, auch abgebrochene), ohne zusätzliche Datenbank-Einrichtung.
- Keine Rückgängig-Funktion (sie würde Mogeln ermöglichen: ansehen, dann zurücknehmen).

## Einrichtung ohne Terminal (GitHub-Workflow)
1. **Cloudflare-Token erzeugen:** Cloudflare Dashboard → *My Profile → API Tokens → Create Token* → Vorlage
   **„Edit Cloudflare Workers“** → Account und Zonen auswählen → Token kopieren (wird nur einmal angezeigt).
2. **Account-ID:** Cloudflare Dashboard → *Workers & Pages* → rechte Seitenleiste „Account ID“.
3. **GitHub → Repo → Settings → Secrets and variables → Actions:**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (`SUPABASE_URL` und `SUPABASE_ANON_KEY` sind durch den Keep-alive schon vorhanden).
   - Variable `SITE_URL` ist vorhanden. Optional `GAME_ALLOWED_ORIGINS` (kommagetrennt, ohne Pfad), wenn mehr als die Seite erlaubt sein soll.
   - Nur bei einem Supabase-Projekt mit altem HS256-Schlüssel zusätzlich das Secret `SUPABASE_JWT_SECRET`.
4. **Actions → „Deploy Spiel-Worker“ → Run workflow.** Beim ersten Lauf legt Cloudflare das Durable Object an.
5. **Testen:** Im Browser `https://arcane-decksmith-game.<dein-subdomain>.workers.dev/health` öffnen (erwartet `{"ok":true,…}`).
   Danach in der App die versteckte Seite **`#/spielen`** mit zwei Konten in zwei Browsern öffnen: ein Konto erstellt den Raum, das andere tritt mit dem Code bei.
   Hat der Worker eine andere Adresse, in Vercel `VITE_GAME_WORKER_URL` setzen.

## Lokal testen (optional, mit Terminal)
```bash
cd worker/game && npm ci
# .dev.vars anlegen (nicht committen): SUPABASE_URL, SUPABASE_JWT_SECRET, ALLOWED_ORIGINS, ALLOW_NO_ORIGIN=true
npx wrangler dev --port 8788
node e2e/e2e.mjs        # Ende-zu-Ende-Test gegen die echte Worker-Laufzeit (inkl. Hibernation, ca. 45 s)
```

## Gratis-Tarif (Stand der geprüften Dokumentation, vor dem Start erneut prüfen)
Durable Objects sind im Gratis-Tarif nur mit SQLite-Speicher verfügbar (hier der Fall). Wichtig: **Hibernation nutzen**, Spielstand
**gebündelt** speichern, nicht bei jeder Aktion (der Test speichert aus Einfachheit noch bei jedem Zug).

## Nächste Schritte
Mögliche Erweiterungen: Zuschauer, Karten-Zoom per Tastenkürzel, Kartenreihenfolge/Position auf dem Schlachtfeld, Turnier-Statistiken.
