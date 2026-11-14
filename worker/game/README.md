# Spiel-Worker (Online-Spiel, Machbarkeitstest)

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

## Aufbau
- `src/index.js` – Worker-Einstieg (Herkunftsprüfung, Raumcode) und die Klasse `GameRoom` (Durable Object).
- `src/protocol.js` – reine Logik (Nachrichten prüfen, Spielstand, Sicht pro Spieler, Ratenbegrenzung); in Node testbar
  (`protocol.test.js`, läuft mit `npm test` im Hauptprojekt).
- Anmeldung: Der Client schickt als **erste Nachricht** `{ "type": "auth", "token": … }` (nie in der Adresse). Geprüft wird mit
  `worker/supabase-auth.js` (dieselbe Prüfung wie beim KI-Worker). Wer sich nicht binnen 10 Sekunden anmeldet, wird getrennt.
- Nachrichten (Client → Server): `auth`, `chat`, `draw`. Server → Client: `welcome`, `view`, `chat`, `error`.
- Grenzen: höchstens 4 Spieler je Raum, 4 KB je Nachricht, Ratenbegrenzung je Verbindung.

## Einrichtung ohne Terminal (GitHub-Workflow)
1. **Cloudflare-Token erzeugen:** Cloudflare Dashboard → *My Profile → API Tokens → Create Token* → Vorlage
   **„Edit Cloudflare Workers“** → Account und Zonen auswählen → Token kopieren (wird nur einmal angezeigt).
2. **Account-ID:** Cloudflare Dashboard → *Workers & Pages* → rechte Seitenleiste „Account ID“.
3. **GitHub → Repo → Settings → Secrets and variables → Actions:**
   - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (und `SUPABASE_URL` ist durch den Keep-alive schon vorhanden).
   - Variable `SITE_URL` ist vorhanden. Optional `GAME_ALLOWED_ORIGINS` (kommagetrennt, ohne Pfad), wenn mehr als die Seite erlaubt sein soll.
   - Nur bei einem Supabase-Projekt mit altem HS256-Schlüssel zusätzlich das Secret `SUPABASE_JWT_SECRET`.
4. **Actions → „Deploy Spiel-Worker“ → Run workflow.** Beim ersten Lauf legt Cloudflare das Durable Object an.
5. **Testen:** Im Browser `https://arcane-decksmith-game.<dein-subdomain>.workers.dev/health` öffnen (erwartet `{"ok":true,…}`).
   Danach in der App die versteckte Seite **`#/spieltest`** mit zwei Konten in zwei Browsern öffnen und denselben Raumcode verwenden.
   Hat der Worker eine andere Adresse, in Vercel `VITE_GAME_WORKER_URL` setzen oder sie auf der Testseite eintragen.

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
Meilenstein 1: Räume mit Einladungscode in Supabase, Deck-Wahl und strenge Prüfung (Besitz und Formatgültigkeit) auf dem Server.
