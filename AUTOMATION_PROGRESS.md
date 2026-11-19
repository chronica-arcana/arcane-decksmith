# Automatisierung der Kartentexte – Fortschritt

Messung: `node worker/game/scripts/measure-automation.mjs <Cache-Ordner> --json automation-progress.json`
(Cache = MTGJSON `DeckList.json` + `decks/*.json`, siehe `worker/game/scripts/audit-commander-decks.mjs`).
Eine Karte zählt nur als automatisiert, wenn **kein** Satz ihres Texts unverstanden bleibt. Maschinenlesbarer Stand: `automation-progress.json`.

## Aktueller Stand

| Bereich | Automatisch | Karten | Quote |
|---|---|---|---|
| Star Trek + Final Fantasy (TRC, FIC) | siehe automation-progress.json | 545 | – |
| Alle 36 Set-Decks | siehe automation-progress.json | 2 006 | – |

Startpunkt der autonomen Phase (PR #69): Star Trek/FF 278/545 (51,0 %), alle Decks 728/2 006 (36,3 %).

## Zyklen

| # | Inhalt | Star Trek/FF | Alle |
|---|---|---|---|
| 1 | Generischer Mengen-Baustein (`quantity.js`): „where X is …“, „… equal to …“, X bei Spielsteinen und +X/+X | 284 (52,1 %) | 755 (37,6 %) |
| 2 | Generisches „for each <Filter>“ über den Mengen-Baustein | 286 (52,5 %) | 762 (38,0 %) |
| 3 | „When you do“, „(you may) sacrifice a <Typ>“ als Effekt, „return ~ from your graveyard“ | 287 (52,7 %) | 770 (38,4 %) |
| 4 | Generische Bedingungen (`parseCondition`): Kontrolle von N <Filter>, Leben erhalten, Monarch, Angriff, Handkarten, Friedhof, eigener Zug … | 287 (52,7 %) | 779 (38,8 %) |
| 5 | Ausrüstung/Aura: Schutz vor Farben, „+N/+N for each …“ (Mengen-Baustein), verliehene Auslöser in Anführungszeichen | 289 (53,0 %) | 782 (39,0 %) |
| 6 | Typ-Tod-Auslöser, „one or more <Typ> attack“, „enters with X counters“, „another target“ bei Markern, Schaden an bis zu N Zielen, kostenloses Wirken aus Friedhof/Hand/Exil („without paying its mana cost“, danach Exil) | 290 (53,2 %) | 790 (39,4 %) |
| 7 | „A, then B“ allgemein, +X/+X für alle, „exile the top X“, Spielsteine mit „can't block“, „during your turn … have“, Wert des geopferten Permanents | 296 (54,3 %) | 797 (39,7 %) |
| 8 | Kurznamen legendärer Karten („Loran enters“), „Then …“, „becomes tapped“, „those creatures get …“, „you may sacrifice it“, Gearhulk-Form, „up to two <Typ> cards from among them“ | 303 (55,6 %) | 810 (40,4 %) |

## Implementierte Bausteine (Auswahl)

Siehe `worker/game/README.md` („Zuletzt neu“) für die vollständige Liste. Architektur:
- `cardText.js`: Satz-Parser (Auslöser, Effekte, Kosten, Ziele, Dauereffekte).
- `quantity.js`: berechenbare Mengen (Werte von Karten, Zählungen mit Zielfiltern, Zonen, Marker, größte Werte, Gegneranzahl).
- `gameLogic.js`: Engine; `evalQuantity` wertet Mengen aus.

## Lückenanalyse (zuletzt)

Siehe Abschnitt unten, wird pro Analysezyklus aktualisiert.

## Nächste Schritte (priorisiert)

1. Generisches „for each <Filter>“ über `quantity.js` statt fester Liste.
2. Bedingungen („intervening if“) als generischer Baustein mit Zustandsabfragen.
3. Kartenspezifische Restlücken der Star-Trek-/FF-Decks mit 1 offenen Satz.

## Bekannte Probleme

- Ein älterer Test (Chaos Warp) war einmalig unter Last rot (Zeitlimit vermutet).

## Wiederaufnahme

Branch `claude/affectionate-hamilton-wshhv7`, offener PR #69. Letzter getesteter Commit: siehe `git log -1`.
