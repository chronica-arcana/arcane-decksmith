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
| 9 | Opfer-Ereignisse („whenever you sacrifice a Clue/Treasure …“), „life lost this way“, „one or more creatures attack“, „~ or another legendary permanent enters“, Unwinding Clock, Friedhofsziele mit Untertypen, „a commander you control enters or attacks“ | 309 (56,7 %) | 825 (41,1 %) |
| 10 | Bedingungen als Baustein auch für Dauereffekte und Kosten (`evalCondition`): „can't be blocked if …“, „as long as …, ~ has …“, „costs {N} less if …“; „you've cast two or more noncreature spells“; „all nonartifact creatures get -X/-X“; Monstrosity X; „search for up to X“ | 313 (57,4 %) | 831 (41,4 %) |
| 11 | Kopie-Baustein: Spielstein-Kopien mit Ausnahmen („isn't legendary“, „has haste“, „4/4 black Zombie“ …), Klone beim Ins-Spiel-Kommen; Spielsteine lösen jetzt „enters“-Auslöser aus (Regelkorrektur) | 315 (57,8 %) | 837 (41,7 %) |
| 12 | Mehrfach-Modi: „Choose two / three / one or more“, „you may choose both instead“ mit Kommandant; modale Auslöser mit zwei Modi; Ziele der gewählten Modi werden verkettet; Client-Mehrfachauswahl | 317 (58,2 %) | 841 (41,9 %) |
| 13 | Filter wie Zielangaben (Marker „with a +1/+1 counter on it“, „without flying“, „that entered this turn“); allgemeine Auslöser „Whenever a <Filter> enters/dies/attacks/deals combat damage“; „~ gets +1/+1 for each …“ als Dauereffekt; Marker auf „each <Filter>“ | 317 (58,2 %) | 861 (42,9 %) |
| 14 | Goad (Aufstacheln): Ziel, „up to N“, „all creatures you don't control“, „each creature target player controls“; Angriffspflicht auch beim Passen, Mehrspieler-Zielregel, endet mit dem nächsten Zug des Aufstachlers; Angriffskosten heben die Pflicht auf (508.1d); Client-Badge und Zielwahl | 318 (58,3 %) | 862 (43,0 %) |
| 15 | Allgemeine Dauereffekte „<Filter> you control get/have …“ (Farbe, Marker, Schlüsselwort, getappt; auch gegnerische); „up to N target …“ für beliebige Ein-Ziel-Sätze; „tap/untap all <Filter>“; „target attacking creature gains …“; Korrektur: Farben/„tapped“ wurden als Kreaturtyp gelesen | 320 (58,7 %) | 871 (43,4 %) |
| 16 | Gruppen bis Zugende („<Filter> you control get/gain … until end of turn“), Spielstein-Filter („creature tokens“, „nontoken“), Wirk-Auslöser mit Filter (Typ, Nicht-Typ, Manawert, {X}, mehrfarbig, legendär), „up to N“ auch für Friedhofskarten | 321 (58,9 %) | 879 (43,8 %) |
| 17 | Phasen-Auslöser: erste/zweite/jede Hauptphase, „each combat“, „combat on each opponent's turn“, „each player's/opponent's end step/upkeep“, eigener Ziehschritt; „one or more <Filter> you control attack“; Eigenschaftswörter vor Kreaturtypen („nontoken Vampires“, „legendary Dragon“) | 321 (58,9 %) | 884 (44,1 %) |
| 18 | Spielsteine „tapped (and attacking)“ (greifen das Ziel der Quelle an), vorangestelltes „For each <Menge>, …“, verliehenes Melee („Creatures you control have melee“), „it deals that much damage to each other opponent“ mit Kampfschaden-Menge, Auslöser „deals combat damage to an opponent“ | 325 (59,6 %) | 894 (44,6 %) |
| 19 | Zusatzkosten „pay N life“/„pay X life“ (X wählbar, Leben bis 0 zahlbar – Regelkorrektur), Tap-Kosten mit beliebigem Filter („Tap an untapped legendary creature/Cleric you control“), „put a creature card with mana value N or less from your hand onto the battlefield“ | 328 (60,2 %) | 900 (44,9 %) |
| 20 | Auslöser „When ~ leaves the battlefield“ (Exil, Hand, Bibliothek, Friedhof) | 328 (60,2 %) | 903 (45,0 %) |

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
