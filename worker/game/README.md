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

## Spieltisch und Regelautomatik
- **Server-geführter Spielstand** (`gameLogic.js`): Bibliotheken werden auf dem Server mit `crypto.getRandomValues` gemischt. Jeder Spieler
  bekommt nur seine Sicht: eigene Hand, bei anderen nur Kartenzahlen; Bibliotheken und verdeckte Karten sieht nie jemand.
- **Kartendaten:** Beim Spielstart holt der Worker Stärke, Widerstandskraft, Loyalität, Typzeile und Schlüsselwörter bei Scryfall (best effort);
  Manakosten und Regeltext kommen aus der Sammlung bzw. ebenfalls von Scryfall.
- **Die Regeln setzt das Spiel durch:** Zugstruktur, Priorität und Stapel, Mana (Pool, Quellen werden automatisch getappt, Hybrid, X, Phyrexian,
  Kommandantensteuer), ein Land pro Zug, Beschwörungsmüdigkeit, Kampf (Angreifer, Blocker, Erstschlag, Doppelschlag, Todesberührung,
  Lebensverbindung, Trampeln, Flug/Reichweite, Drohung, Verteidiger, Wachsamkeit, Eile, unzerstörbar, Hexproof/Shroud bei Zielen),
  Handkartenlimit, Kommandantenschaden, Ausscheiden und Spielende. **Karten werden nur gezogen, wenn Regeln oder Kartentexte es verlangen.**
- **Kartentext-Engine (`cardText.js`):** Der englische Oracle-Text wird gelesen und ausgeführt: Karten ziehen, Leben gewinnen/verlieren, Schaden
  (beliebiges Ziel, Kreatur, Spieler, alle), Zerstören, Exil, zurück auf die Hand, Tappen/Enttappen, Neutralisieren, Marker, Stärke-Bonus bis
  Zugende, Spielsteine erzeugen, Wühlen, Mahlen, Abwerfen, Bibliothek durchsuchen (z. B. Basic Land), Karten aus dem Friedhof zurückholen,
  Mana erzeugen. Dazu **Ziele** (nur gültige Ziele, die Auswahl erfolgt beim Wirken), **Auslöser** („When ~ enters the battlefield“, „dies“,
  „attacks“), **aktivierte Fähigkeiten** (Kosten {T} und Mana) und **Loyalitätsfähigkeiten**.
- **Nicht automatisch:** Dauereffekte (z. B. „Creatures you control get +1/+1“), Bedingungen, „für jedes“, X-Effekte, Modi, Aura/Ausrüstung,
  Auslöser außer Betreten/Sterben/Angriff. Karten mit solchen Texten weisen in der Vorschau darauf hin. Wird ein nicht verstandener Satz
  ausgeführt, öffnet das Spiel ein **manuelles Fenster** nur für diesen Spieler (Karte ziehen, Karten bewegen, Leben, Marker, Spielsteine …),
  das er mit „Fertig“ schließt. Außerhalb dieses Fensters sind manuelle Eingriffe serverseitig gesperrt.
- **Commander mit 2 bis 4 Spielern**, Revanche (Gastgeber), Verlassen mitten im Spiel zählt als Aufgabe.
- **Verlauf:** Durable Object `History` je Konto (letzte 50 Spiele, auch abgebrochene), ohne zusätzliche Datenbank-Einrichtung.
- Keine Rückgängig-Funktion (sie würde Mogeln ermöglichen: ansehen, dann zurücknehmen).

## Bedienung am Spieltisch
- Der Spielraum füllt den ganzen Bildschirm (ohne Sammlung und App-Menü); oben links „Raum verlassen“. Es ist eine einzige Matte: Gegner oben
  (gespiegelt), Mitte mit Stapel und Kampf, du unten; die Phasen stehen unter der eigenen Hand. Chat und Verlauf liegen optional in einer
  Seitenleiste links, die große Kartenvorschau erscheint rechts.
- **Klick** = Hauptaktion: spielbare Handkarte (grün) spielen oder wirken, Land/Manaquelle für Mana tappen, Fähigkeit aktivieren; bei Zielen
  leuchten die gültigen Ziele auf (auch die Spieler-Avatare), im Angriffsschritt Angreifer wählen, beim Blocken Blocker und dann Angreifer.
  **Ziehen** auf den Tisch spielt eine Karte. **Rechtsklick oder langes Drücken** zeigt nur die gerade möglichen Aktionen.
- Wer am Zug ist, blendet kurz ein; Prioritäts-Anzeigen gibt es nicht.
- Oberfläche: Modul `src/components/battlefield`. Kartenbilder (small, normal, large) und Mana-Symbole kommen von Scryfall
  (`svgs.scryfall.io/card-symbols`); Schrift „Cinzel“ von Google Fonts mit Serifenschrift als Rückfall.

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
