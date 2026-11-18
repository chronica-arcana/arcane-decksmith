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
  Mana erzeugen, Überwachen (Surveil). Dazu **Dauereffekte** („Creatures you control get +1/+1“, „Other creatures you control get +1/+1 and have flying“),
  **Rückblende** (Flashback aus dem Friedhof, danach Exil) und mehr Auslöser (Kreatur stirbt/betritt, Land betritt, Beginn der Versorgung/Endphase). Dazu **Ziele** (nur gültige Ziele, die Auswahl erfolgt beim Wirken), **Auslöser** („When ~ enters the battlefield“, „dies“,
  „attacks“), **aktivierte Fähigkeiten** (Kosten {T} und Mana) und **Loyalitätsfähigkeiten**.
- **Zugbeginn:** Enttappen und Versorgung laufen immer automatisch. Die Karte wird standardmäßig automatisch gezogen (Startspieler im ersten Zug nicht);
  in den Einstellungen lässt sich das auf **manuell** stellen: Dann klickst du im Zieh-Schritt auf deine Bibliothek und es geht danach von selbst weiter.
  Ein Kampf ohne mögliche Angreifer und ein Endschritt ohne offene Auslöser werden übersprungen.
- **Stapel ohne Klicks:** Gewirkte Zauber, Auslöser und Fähigkeiten lösen sich selbst auf. Nur wenn der Gegner (oder du bei Zügen des Gegners) wirklich
  antworten kann (Sofortzauber, Blitz, bezahlbare Fähigkeit), hält das Spiel an und fragt nach („Nicht antworten“). In den Einstellungen abschaltbar.
- **Länder mit besonderen Regeln:** „kommt getappt ins Spiel“, Opferkosten wie bei Evolving Wilds ({T}, Sacrifice), Landfall und Auslöser beim Betreten.
  Bedingte Länder: „unless you control two or more/fewer other lands“ (Slow-/Fast-Länder), „… two or more basic lands“ (Battle-Länder),
  „unless you control a Plains or an Island“ (Check-Länder), „unless a player has 13 or less life“, Shock-Länder („you may pay 2 life“ mit Ja/Nein-Frage),
  „you may reveal a … card from your hand“ (Karte zeigen oder getappt) und Bounce-Länder („return a land you control to its owner's hand“).
- **Animationen:** Angreifer stürmen in die Mitte, Blocker schieben sich davor, Schaden und Heilung zeigen schwebende Zahlen mit Treffer-Blitz,
  zu Spielbeginn entscheidet ein animierter Münzwurf (eigene Grafiken optional: `src/assets/game/coin-front.webp` und `coin-back.webp`).
- **Stabilität:** Wirft die Regel-Engine einen Fehler, wird der Zustand zurückgesetzt und neu gesendet; der Client gleicht den Stand beim Sichtbarwerden
  und alle 20 Sekunden ab und verbindet sich bei Abbruch automatisch neu. Ein Dauertest spielt 300 Zufallsspiele ohne Stillstand.
- **Nicht automatisch:** Bedingte Dauereffekte, Bedingungen, „für jedes“, X-Effekte, Modi, Aura/Ausrüstung,
  Auslöser außer Betreten/Sterben/Angriff. Karten mit solchen Texten weisen in der Vorschau darauf hin. Wird ein nicht verstandener Satz
  ausgeführt, öffnet das Spiel ein **manuelles Fenster** nur für diesen Spieler (Karte ziehen, Karten bewegen, Leben, Marker, Spielsteine …),
  das er mit „Fertig“ schließt. Außerhalb dieses Fensters sind manuelle Eingriffe serverseitig gesperrt.
- **Commander mit 2 bis 4 Spielern**, Revanche (Gastgeber), Verlassen mitten im Spiel zählt als Aufgabe.
- **Verlauf:** Durable Object `History` je Konto (letzte 50 Spiele, auch abgebrochene), ohne zusätzliche Datenbank-Einrichtung.
- Keine Rückgängig-Funktion (sie würde Mogeln ermöglichen: ansehen, dann zurücknehmen).

## Bot-Gegner

Beim Erstellen eines Raums kann „Gegen einen Bot spielen“ gewählt werden. Der Bot spielt ein **Deck aus der eigenen Sammlung** des Gastgebers (gleiche strenge Prüfung wie für Spieler, fremde Decks werden abgelehnt). Er belegt den zweiten Platz (2 Spieler), ist immer bereit und handelt serverseitig im Durable Object (`src/bot.js`): Mulligan, Länder, Zauber mit passenden Zielen, Fähigkeiten, Angriffe, Blocks, Auswahlen und Antworten auf Zauber. Er sieht nur seine eigene Hand. Zwischen zwei Bot-Aktionen liegt eine kurze Pause (Alarm), damit man seine Züge verfolgen kann. Partien gegen den Bot erscheinen nicht im Verlauf. Getestet durch Bot-gegen-Bot-Simulationen (Standard und Commander) und im Ende-zu-Ende-Test.

## Weitere Regelautomatik

Bedingte Länder („enters tapped unless you control a legendary creature“, „… on turn 3 or earlier“), modale Zauber („Choose one“ mit Auswahldialog), X-Zauber (X wird abgefragt) und Cycling sind automatisiert.

Außerdem automatisiert: Ausrüstung („Equip {N}“, „Equipped creature gets …“, Anhängen beim Ins-Spiel-Kommen) und Auren („Enchant creature“ mit Bonus), Wiederbelebung gezielt aus dem eigenen Friedhof, Sofortzauber im Angriff (Antwort vor dem Blocken und vor dem Kampfschaden) sowie „Mana selbst wählen“ (Einstellung; der Server bezahlt dann nur mit den gewählten Ländern).

## Regelabdeckung (Stand: Regelprüfung)

Neu automatisiert: Niederlage durch Ziehen aus leerer Bibliothek, Legendenregel (Auswahl), Planeswalker als Angriffsziel, Kommandantenschaden je Kommandant, Kontrollwechsel (bis Zugende oder dauerhaft, z. B. „Gain control of target creature“), Schutz vor Farben, Ward (Mana-Aufpreis beim Wirken), Furcht, Einschüchtern, Schleichen, Gift (Infect), Wither, Prowess, Nebel („prevent all combat damage“), zusätzliche Züge, „You may … / If you do …“ mit Ja/Nein-Auswahl, „… for each …“, „sacrifices a creature“, Auslöser mit mehreren Zielen sowie Antwortfenster am Ende jedes Schritts (Hauptphase 1, Angriff, Schaden, Hauptphase 2, Endschritt) für Gegner mit leuchtendem Sofortzauber.

Bewusst vereinfacht: Ward gilt nur für Mana-Kosten und wird sofort beim Wirken bezahlt (nicht als Auslöser); Schutz gilt nur vor Farben; Schaden verhindern gibt es nur als „alle Kampfschaden dieses Zuges“; Kontrollwechsel durch Auren („You control enchanted creature“), Kopieren, Kicker, Ersatzeffekte, verzögerte Auslöser und doppelseitige Karten sind weiterhin nicht automatisiert (manuelles Fenster).

## Kartentext-Abdeckung (Stichprobe)

`src/cardCorpus.js` enthält eine Stichprobe von rund 230 echten Kartentexten (Removal, Zähler, Ramp, Auren, Ausrüstung, Planeswalker, Lands, Commander-Staples …). `cardCorpus.test.js` stellt sicher, dass mindestens 75 % davon vollständig automatisch verstanden werden (derzeit etwa 78 %). Zuletzt ergänzt: Zielfilter („nonblack“, „tapped“, „an opponent controls“, „with power 4 or greater“), Exil „bis die Karte das Spiel verlässt“ (Oblivion Ring, White Auracite), Biss und Kampf („deals damage equal to its power“, „fights“), „where X is that creature's power“, Friedhof exilieren, Leben in Höhe von Stärke/Widerstandskraft/Manawert, „unless its controller pays“, Suchen (mehrere Karten, bestimmte Landtypen, Cultivate), Schatz-, Nahrungs- und Hinweis-Spielsteine, Aufdecken und Abwerfen (Thoughtseize/Duress), „Can't attack or block“-Auren, Kostenverringerung, kein Handkartenlimit sowie neue Auslöser (Leben gewinnen, Karte ziehen, Kampfschaden, Kampfbeginn, Ausrüstung stirbt).

Zusätzlich automatisiert (zweite Runde): zusätzliche Kosten (Kreatur opfern, Karten abwerfen, Leben zahlen) für Zauber und Fähigkeiten mit Auswahl der Karten, Tutoren, Spielsteine mit Schlüsselwörtern, „enters or attacks“, Rhystic Study und andere „unless that player pays“-Auslöser, „You may pay … If you do“, Blinzeln (Flicker), Regeneration, Schadensschilde („prevent the next N damage“), Kreaturenfarbe-Boni („White creatures get +1/+1“), Angriffssteuer (Propaganda), Thriving-Länder (Farbwahl), Rückholen/Remand beim Neutralisieren, „can't block“, Zielunionen („artifact, enchantment, or land“), Windfall und Wheel of Fortune.

Weiterhin manuell (bewusst nicht automatisiert): Kopieren, Teilen in Stapel (Fact or Fiction), Neuordnen der obersten Karten (Ponder), zusätzliche Kosten („As an additional cost“), „Choose a color/another creature“ beim Ins-Spiel-Kommen, Schaden verhindern (außer „all combat damage“), Planeswalker mit Verwandlung, Kicker/Evoke. Im manuellen Fenster geht jetzt auch Handarbeit an Karten der Gegner (Schaden, Marker, Tappen, zerstören/exilieren), damit nichts an der Bedienung scheitert.

## Prüfung aller Commander-Precons

`node worker/game/scripts/audit-commander-decks.mjs [Cache-Ordner] [Deck-Filter]` lädt alle Commander-Decks von MTGJSON, lässt jeden Kartentext durch den Parser laufen und zeigt die Quote je Deck sowie die häufigsten Lücken (nach Anzahl der Decks gewichtet). Stand dieser Runde: von 6 580 verschiedenen Karten (ohne Standardländer) versteht die Engine rund **17 %** vollständig; bei den vier Final-Fantasy-Decks (FIC) sind es 37 % der 315 Karten. Für die bevorzugten Sets (`FIC,TRC,FRC,TMC,DRC,ECC,C20,MIC,VOC,ONC,LCC,TDC,EOC`: Final Fantasy, Star Trek, Fractured Reality, Turtles, Aetherdrift, Lorwyn Eclipsed, Ikoria, Innistrad, Phyrexia, Lost Caverns, Tarkir Dragonstorm, Edge of Eternities; 36 Decks, 2 006 Karten) sind es derzeit rund **29,5 %**. Häufigste offene Mechaniken dort: „Choose one“ auf Permanents, Hideaway, Madness, Storm, „Enchant player“, Support, Job select, Kopieren („new targets for the copy“), „look at the top card any time“. Die Texte sind sehr vielfältig (über 7 000 verschiedene Satzformen), deshalb bleibt ein großer Teil weiterhin manuell. Zuletzt neu: Cycling-/Abwerf-Auslöser („whenever you cycle or discard“, „when you cycle this card“), Schlüsselwort-Marker (deathtouch counter …), „opponents' creatures enter tapped“, „another Zombie you control dies“, Land aus der Hand legen, „destroy all tapped creatures“, Landwandern (Islandwalk …), Auslöser für Kreaturen ab Stärke N, Zauber kopieren („copy that spell“, „copy target instant or sorcery spell“; Kopien behalten die Ziele des Originals), Skulk-Text, Delve/Convoke bei Kreaturen, Marker-Dauereffekte („each creature with a +1/+1 counter has trample“, „opponents' creatures with counters can't attack“), Ausrüstung „+1/+1 for each artifact“, Stärke aus dem Friedhof, „whenever equipped creature attacks“, „second spell each turn“, Energie als Kosten, Modi-Zauber mit „choose one. If you control a commander … both“ (nur ein Modus; die Beidseitigkeit fehlt), Mutate (Kontextmenü „Mutate {Kosten} → über/unter Kreatur“, nur eigene Nicht-Menschen; Fähigkeiten aller Karten, Auslöser „whenever this creature mutates“, beim Verlassen des Feldes gehen alle Karten zusammen in dieselbe Zone; vereinfacht: Zählungen „times this creature has mutated“ fehlen), Station (Raumschiffe mit Ladungsmarkern, Stufen „N+ |“, Artefaktkreatur ab Schwelle), Encore/Eternalize/Embalm (Fähigkeiten aus dem Friedhof mit Spielstein-Kopie, Sacrifice am Zugende), Auslöser nach Zauberart („instant or sorcery“), „second card each turn“, „nontoken“, „one or more creatures … deal combat damage“, Erkunden, „doesn't untap“, Marker verdoppeln, „twice the number of“-Stärke, Gratis-Zauber mit Kommandant, Toxic, Undying/Persist, Adapt, Melee, Evoke, Typ-Auslöser („another Human you control enters“), Kampfschaden-Auslöser beliebiger eigener Kreaturen, Besatzung (Crew) und „becomes a creature“, Foretell, Delve/Convoke, Kostenverringerung, Monarch, Proliferate, „Look at the top N“, Chaos Warp, Filterländer, Charge-Counter-Länder, „enters with X counters“, „can't be countered“, Angriffszwang, Kampf-/Marker-Auslöser (Wakka), Yuna's Whistle, Lifestream's Blessing und bedingte Ausrüstungsboni (Hero's Heirloom).

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
