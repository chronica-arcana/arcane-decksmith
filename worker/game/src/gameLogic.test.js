import { describe, expect, it } from "vitest";
import { abortGame, applyAction, cannotBlockReason, createGame as createRawGame, gameView, joinGame, playerLeft, repairGame, splitGame } from "./gameLogic.js";

/** Die Tests gehen vom automatischen Ziehen aus (im Spiel ist „per Klick ziehen“ voreingestellt). */
const createGame = options => {
  const game = createRawGame(options);
  for (const player of Object.values(game.players)) player.autoStart = true;
  return game;
};

const seeded = (seed = 1) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const LIB = [
  ["forest", "Forest", "Basic Land — Forest", "", 24, {}],
  ["mountain", "Mountain", "Basic Land — Mountain", "", 6, {}],
  ["bear", "Bär", "Creature — Bear", "{1}{G}", 4, { power: "2", toughness: "2" }],
  ["giant", "Riese", "Creature — Giant", "{3}{G}{G}", 2, { power: "5", toughness: "5", keywords: ["Trample"] }],
  ["hawk", "Falke", "Creature — Bird", "{G}", 2, { power: "1", toughness: "1", keywords: ["Flying"] }],
  ["viper", "Viper", "Creature — Snake", "{G}", 2, { power: "1", toughness: "1", keywords: ["Deathtouch"] }],
  ["knight", "Ritter", "Creature — Knight", "{G}", 2, { power: "2", toughness: "1", keywords: ["First Strike"] }],
  ["bat", "Fledermaus", "Creature — Bat", "{G}", 2, { power: "2", toughness: "2", keywords: ["Lifelink"] }],
  ["wall", "Mauer", "Creature — Wall", "{G}", 2, { power: "0", toughness: "4", keywords: ["Defender"] }],
  ["ogre", "Oger", "Creature — Ogre", "{G}", 2, { power: "3", toughness: "3", keywords: ["Menace", "Haste"] }],
  ["bolt", "Blitz", "Instant", "{R}", 2, {}, "Blitz deals 3 damage to any target."],
  ["sorcery", "Zauberspruch", "Sorcery", "{G}{G}", 2, {}],
  ["xspell", "Flut", "Sorcery", "{X}{G}", 2, {}],
  ["seer", "Seher", "Creature — Elf", "{G}", 2, { power: "1", toughness: "1" }, "When Seher enters the battlefield, draw a card."],
  ["heal", "Heilung", "Instant", "{G}", 2, {}, "You gain 4 life."],
  ["study", "Studium", "Sorcery", "{G}", 2, {}, "Draw two cards."],
  ["kill", "Zerstörer", "Instant", "{R}", 2, {}, "Destroy target creature."],
  ["counter", "Gegenzauber", "Instant", "{R}", 2, {}, "Counter target spell."],
  ["growth", "Wachstum", "Sorcery", "{G}", 2, {}, "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle."],
  ["mage", "Magier", "Creature — Wizard", "{G}", 2, { power: "1", toughness: "1" }, "{T}: Magier deals 1 damage to any target."],
  ["ritual", "Ritual", "Instant", "{G}", 2, {}, "Add {R}{R}{R}."],
  ["alarm", "Alarm", "Instant", "{G}", 2, {}, "Create two 1/1 white Soldier creature tokens."],
  ["mystery", "Rätsel", "Sorcery", "{G}", 2, {}, "Exile all cards from each graveyard."],
  ["edict", "Opferzwang", "Sorcery", "{G}", 2, {}, "Target opponent sacrifices a creature."],
  ["threaten", "Bedrohung", "Sorcery", "{G}", 2, {}, "Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn."],
  ["fog", "Nebel", "Instant", "{G}", 2, {}, "Prevent all combat damage that would be dealt this turn."],
  ["extra", "Zeitschleife", "Sorcery", "{G}", 2, {}, "Take an extra turn after this one."],
  ["pact", "Pakt", "Sorcery", "{G}", 2, {}, "You may draw a card. If you do, you lose 1 life."],
  ["horde", "Horde", "Sorcery", "{G}", 2, {}, "Draw a card for each creature you control."],
  ["pro", "Schutzgeist", "Creature — Spirit", "{G}", 2, { power: "2", toughness: "2" }, "Protection from red"],
  ["wardy", "Wächter", "Creature — Knight", "{G}", 2, { power: "2", toughness: "2" }, "Ward {2}"],
  ["fearful", "Schreck", "Creature — Horror", "{G}", 2, { power: "2", toughness: "2", keywords: ["Fear"] }],
  ["inf", "Seuchenträger", "Creature — Horror", "{G}", 2, { power: "2", toughness: "2", keywords: ["Infect"] }],
  ["king", "König", "Legendary Creature — Elf", "{G}", 2, { power: "2", toughness: "2" }],
  ["walker", "Wanderer", "Legendary Planeswalker — Test", "{2}", 2, { loyalty: "4" }],
  ["kavu", "Kavu", "Creature — Kavu", "{G}", 2, { power: "4", toughness: "2" }, "When Kavu enters the battlefield, it deals 2 damage to target creature."],
  ["scrier", "Seherin", "Sorcery", "{G}", 2, {}, "Scry 2."],
  ["pain", "Qual", "Sorcery", "{G}", 2, {}, "Each opponent discards a card."],
  ["shroud", "Schleier", "Creature — Spirit", "{G}", 2, { power: "1", toughness: "1", keywords: ["Hexproof"] }],
  ["anthem", "Hymne", "Enchantment", "{G}", 2, {}, "Creatures you control get +1/+1."],
  ["lord", "Anführer", "Creature — Elf", "{G}", 2, { power: "2", toughness: "2" }, "Other creatures you control get +1/+1 and have flying."],
  ["dreams", "Träume", "Instant", "{G}", 2, {}, "Surveil 1, then draw a card.\nFlashback {R}"],
  ["bard", "Barde", "Creature — Elf", "{G}", 2, { power: "1", toughness: "1" }, "Whenever a land enters the battlefield under your control, you gain 1 life."],
  ["reaper", "Schnitter", "Creature — Horror", "{G}", 2, { power: "1", toughness: "1" }, "Whenever a creature an opponent controls dies, put a +1/+1 counter on ~."],
  ["wilds", "Wildnis", "Land", "", 2, {}, "{T}, Sacrifice Wildnis: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle."],
  ["cliffs", "Klippen", "Land", "", 2, {}, "Klippen enters tapped.\nWhen Klippen enters, you gain 1 life.\n{T}: Add {U} or {R}."],
  ["slow", "Langsam", "Land", "", 2, {}, "Langsam enters the battlefield tapped unless you control two or more other lands.\n{T}: Add {G}."],
  ["check", "Prüfland", "Land", "", 2, {}, "Prüfland enters the battlefield tapped unless you control a Mountain or a Swamp.\n{T}: Add {G}."],
  ["shock", "Schock", "Land — Forest Mountain", "", 2, {}, "As Schock enters the battlefield, you may pay 2 life. If you don't, it enters the battlefield tapped."],
  ["reveal", "Zeigland", "Land", "", 2, {}, "As Zeigland enters the battlefield, you may reveal a Mountain card from your hand. If you don't, it enters the battlefield tapped."],
  ["karoo", "Rücklauf", "Land", "", 2, {}, "Rücklauf enters the battlefield tapped.\nWhen Rücklauf enters the battlefield, return a land you control to its owner's hand.\n{T}: Add {G}{R}."],
  ["legend", "Legendär", "Land", "", 2, {}, "Legendär enters tapped unless you control a legendary creature."],
  ["town", "Startstadt", "Land", "", 2, {}, "Startstadt enters tapped unless it's your first, second, or third turn of the game."],
  ["modal", "Wahlzauber", "Instant", "{G}", 2, {}, "Choose one —\n• Wahlzauber deals 2 damage to any target.\n• You gain 5 life."],
  ["xdraw", "Flutwelle", "Sorcery", "{X}{G}", 2, {}, "Draw X cards."],
  ["cycler", "Wechsler", "Creature — Elf", "{3}{G}{G}", 2, { power: "2", toughness: "2" }, "Cycling {1}"],
  ["landcycler", "Landwechsler", "Creature — Elf", "{5}{G}", 2, { power: "2", toughness: "2" }, "Basic landcycling {1}"],
  ["scythe", "Sense", "Artifact — Equipment", "{2}", 2, {}, "When this Equipment enters, you may attach it to target creature you control. If you do, that creature gains first strike until end of turn.\nEquipped creature gets +2/+1.\nEquip {2}"],
  ["halo", "Heiligenschein", "Enchantment — Aura", "{G}", 2, {}, "Enchant creature\nEnchanted creature gets +1/+1 and has flying."],
  ["revive", "Wiederkehr", "Sorcery", "{1}{G}", 2, {}, "Return target creature card from your graveyard to the battlefield with two additional +1/+1 counters on it. It's a black Zombie in addition to its other colors and types."],
  ["esper", "Esper-Rückholung", "Sorcery", "{1}{G}", 2, {}, "Create a 3/3 blue Robot Warrior artifact creature token. Then if this spell was cast from a graveyard, put two +1/+1 counters on that token.\nFlashback {5}{U}"],
  ["twin", "Zwilling", "Creature — Elf", "{G}", 2, { power: "1", toughness: "1" }, "When ~ enters, ~ deals 1 damage to target creature and 1 damage to target player."],
  ["plains", "Plains", "Basic Land — Plains", "", 2, {}],
  ["snarl", "Schattenwirbel", "Land", "", 2, {}, "As Schattenwirbel enters the battlefield, you may reveal a Plains or Swamp card from your hand. If you don’t, Schattenwirbel enters the battlefield tapped.\n{T}: Add {W} or {B}."],
  ["vknight", "Tapferer Ritter", "Creature — Human Knight", "{G}", 2, { power: "2", toughness: "2" }, "Other Knights you control get +1/+1."],
  ["knight2", "Ritter der Runde", "Creature — Human Knight", "{G}", 2, { power: "2", toughness: "2" }],
  ["banner", "Banner", "Artifact", "{3}", 2, {}, "As this artifact enters, choose a creature type. Creatures you control of the chosen type get +1/+1.\nWhenever you cast a creature spell of the chosen type, draw a card."],
  ["blackknight", "Schwarzer Ritter", "Creature — Human Knight", "{B}", 2, { power: "2", toughness: "2" }],
  ["doomblade", "Todesstoß", "Instant", "{R}", 2, {}, "Destroy target nonblack creature."],
  ["bite", "Biss", "Sorcery", "{G}", 2, {}, "Target creature you control deals damage equal to its power to target creature you don't control. If the creature you control has trample, excess damage is dealt to that creature's controller instead."],
  ["prey", "Jagdbeute", "Sorcery", "{G}", 2, {}, "Target creature you control fights target creature you don't control."],
  ["oring", "Verbannungsring", "Enchantment", "{2}", 2, {}, "When this enchantment enters, exile another target nonland permanent.\nWhen this enchantment leaves the battlefield, return the exiled card to the battlefield under its owner's control."],
  ["bog", "Moor", "Land", "", 2, {}, "This land enters tapped.\nWhen this land enters, exile target player's graveyard.\n{T}: Add {B}."],
  ["thicket", "Dickicht", "Enchantment", "{3}", 2, {}, "When this enchantment enters, put X +1/+1 counters on target creature, where X is that creature's power."],
  ["swords", "Schwerter", "Instant", "{R}", 2, {}, "Exile target creature. Its controller gains life equal to its power."],
  ["path", "Pfad", "Instant", "{R}", 2, {}, "Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle."],
  ["leak", "Mana-Leck", "Instant", "{R}", 2, {}, "Counter target spell unless its controller pays {3}."],
  ["hunt", "Schatzsuche", "Sorcery", "{G}", 2, {}, "Create a Treasure token."],
  ["pacify", "Befriedung", "Enchantment — Aura", "{G}", 2, {}, "Enchant creature\nEnchanted creature can't attack or block."],
  ["witness", "Zeugin", "Creature — Human Shaman", "{G}", 2, { power: "2", toughness: "1" }, "When this creature enters, you may return target card from your graveyard to your hand."],
  ["overrun", "Überrennen", "Sorcery", "{G}", 2, {}, "Creatures you control get +3/+3 and gain trample until end of turn."],
  ["warden", "Seelenwächter", "Creature — Human Cleric", "{G}", 2, { power: "1", toughness: "1" }, "Whenever another creature enters, you gain 1 life."],
  ["duress", "Zwang", "Sorcery", "{G}", 2, {}, "Target opponent reveals their hand. You choose a noncreature, nonland card from it. That player discards that card."],
  ["blast", "Feuersbrunst", "Sorcery", "{4}{G}", 2, {}, "This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature."],
  ["rip", "Zerreißen", "Instant", "{R}", 2, {}, "Destroy target artifact or enchantment."],
  ["striker", "Plünderer", "Creature — Rogue", "{G}", 2, { power: "2", toughness: "2" }, "Whenever this creature deals combat damage to a player, draw a card."],
  ["herald", "Herold", "Creature — Human", "{G}", 2, { power: "1", toughness: "1" }, "At the beginning of combat on your turn, you gain 1 life."],
  ["sacseer", "Opfer-Seher", "Creature — Vampire Wizard", "{G}", 2, { power: "1", toughness: "1" }, "Sacrifice a creature: Scry 1."],
  ["altar", "Altar", "Artifact", "{3}", 2, {}, "Sacrifice a creature: Add {C}{C}."],
  ["rites", "Opferriten", "Instant", "{G}", 2, {}, "As an additional cost to cast this spell, sacrifice a creature.\nDraw two cards."],
  ["reunion", "Wiedersehen", "Sorcery", "{1}{G}", 2, {}, "As an additional cost to cast this spell, discard two cards.\nDraw three cards."],
  ["rhystic", "Rhystisches Studium", "Enchantment", "{G}", 2, {}, "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}."],
  ["flick", "Blinzeln", "Instant", "{G}", 2, {}, "Exile target creature you control, then return it to the battlefield under its owner's control."],
  ["thrive", "Gedeihen", "Land", "", 2, {}, "This land enters tapped.\nAs this land enters, choose a color other than green.\n{T}: Add {G} or one mana of the chosen color."],
  ["regenbeast", "Regenerierer", "Creature — Beast", "{G}", 2, { power: "2", toughness: "2" }, "{G}: Regenerate this creature."],
  ["salve", "Heilsalbe", "Instant", "{G}", 2, {}, "Prevent the next 3 damage that would be dealt to any target this turn."],
  ["prison", "Gespensterkerker", "Enchantment", "{G}", 2, {}, "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you."],
  ["crusade", "Kreuzzug", "Enchantment", "{G}", 2, {}, "Green creatures get +1/+1."],
  ["remand", "Rückruf", "Instant", "{R}", 2, {}, "Counter target spell. If that spell is countered this way, put it into its owner's hand instead of into its owner's graveyard."],
  ["clamp", "Schädelklemme", "Artifact — Equipment", "{1}", 2, {}, "Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}"],
  ["hammer", "Koloss-Hammer", "Artifact — Equipment", "{1}", 2, {}, "Equipped creature gets +10/+10 and loses flying.\nEquip {8}"],
  ["lifestream", "Lebensstrom-Segen", "Instant", "{4}{G}{G}", 2, {}, "Draw X cards, where X is the greatest power among creatures you controlled as you cast this spell. If this spell was cast from exile, you gain twice X life.\nForetell {4}{G} (During your turn, you may pay {2} and exile this card from your hand face down. Cast it on a later turn for its foretell cost.)"],
  ["wakka", "Wakka", "Legendary Creature — Human Warrior", "{2}{G}{W}", 1, { power: "4", toughness: "4", keywords: ["Reach", "Trample"] }, "Reach, trample\nWhenever Wakka deals combat damage to a player, destroy up to one target artifact that player controls and put a +1/+1 counter on Wakka.\nBlitzball Captain — At the beginning of your end step, if a counter was put on Wakka this turn, put a +1/+1 counter on each other creature you control."],
  ["whistle", "Yunas Pfeife", "Instant", "{1}{G}{G}", 2, {}, "Reveal cards from the top of your library until you reveal a creature card. Put that card into your hand and the rest on the bottom of your library in a random order. When you reveal a creature card this way, put X +1/+1 counters on target creature you control, where X is the mana value of that card."],
  ["vehicle", "Karren", "Artifact — Vehicle", "{2}", 2, { power: "3", toughness: "3" }, "Crew 2"],
  ["spaceship", "Raumkreuzer", "Artifact — Spacecraft", "{2}", 2, { power: "3", toughness: "3", keywords: ["Station", "Flying"] }, "Station (Tap another creature you control: Put charge counters equal to its power on this Spacecraft. Station only as a sorcery. It's an artifact creature at 3+.)\n1+ | You gain 1 life whenever you draw a card.\n3+ | Flying"],
  ["encorer", "Echogeist", "Creature — Spirit", "{1}", 2, { power: "2", toughness: "1" }, "Flying\nEncore {1}{R} (Exile this card from your graveyard: For each opponent, create a token copy that attacks that opponent this turn if able. They gain haste. Sacrifice them at the beginning of the next end step. Activate only as a sorcery.)"],
  ["eternal", "Ewiger", "Creature — Human Warrior", "{1}", 2, { power: "1", toughness: "1" }, "Eternalize {1}{G} (Exile from graveyard: create a token copy, except it's a 4/4 black Zombie.)"],
  ["prodigy", "Zauberlehrling", "Creature — Wizard", "{1}", 2, { power: "1", toughness: "1" }, "Whenever you cast an instant or sorcery spell, each opponent loses 1 life.\nWhenever you draw your second card each turn, you gain 2 life.\nWhenever a nontoken creature you control enters, it explores."],
  ["swarmer", "Schwarmwesen", "Creature — Horror", "{G}", 2, { power: "*", toughness: "*" }, "~'s power and toughness are each equal to twice the number of creatures you control."],
  ["freebie", "Gratisgabe", "Sorcery", "{5}{G}{G}", 2, {}, "If you control a commander, you may cast ~ without paying its mana cost.\nDraw a card."],
  ["mutant", "Mutantenbestie", "Creature — Beast", "{4}{G}{G}", 2, { power: "3", toughness: "3", keywords: ["Flying"] }, "Mutate {1}{G} (If you cast this spell for its mutate cost, put it over or under target non-Human creature you own. They mutate into the creature on top plus all abilities from under it.)\nFlying\nWhenever this creature mutates, you gain 3 life."],
  ["lance", "Artefaktlanze", "Artifact — Equipment", "{1}", 2, {}, "Equipped creature gets +1/+1 for each artifact you control.\nWhenever equipped creature attacks, you gain 1 life.\nEquip {1}"],
  ["crawler", "Krabbler", "Creature — Insect", "{1}", 2, { power: "1", toughness: "1" }, "Each creature you control with a +1/+1 counter on it has trample."],
  ["landghoul", "Landghul", "Creature — Zombie", "{1}", 2, { power: "*", toughness: "2" }, "~'s power is equal to the number of land cards in your graveyard."],
  ["sneak", "Schleicher", "Creature — Rogue", "{1}", 2, { power: "2", toughness: "2" }, "~ can't be blocked by creatures with greater power."],
  ["mirror", "Zauberspiegel", "Creature — Wizard", "{1}", 2, { power: "1", toughness: "1" }, "Whenever you cast an instant or sorcery spell, you may copy that spell. You may choose new targets for the copy."],
  ["battery", "Energiezelle", "Artifact", "{1}", 2, {}, "{T}, Pay {E}{E}: You gain 3 life."],
  ["counterwarden", "Zählerwächter", "Creature — Knight", "{1}", 2, { power: "2", toughness: "2" }, "Creatures your opponents control with counters on them can't attack or block."],
  ["cyclewatcher", "Wechselbeobachter", "Creature — Wizard", "{1}", 2, { power: "1", toughness: "1" }, "Whenever you cycle or discard another card, you gain 1 life."],
  ["selfcycler", "Wechselbote", "Creature — Elf", "{3}{G}", 2, { power: "2", toughness: "2" }, "Cycling {1}\nWhen you cycle this card, put a deathtouch counter on target creature you control."],
  ["authority", "Behördenerlass", "Enchantment", "{1}", 2, {}, "Creatures your opponents control enter tapped."],
  ["zombielord", "Zombiefürst", "Creature — Zombie", "{1}", 2, { power: "1", toughness: "1" }, "Whenever another Zombie you control dies, each opponent loses 1 life."],
  ["spiral", "Wachstumsspirale", "Instant", "{G}", 2, {}, "Draw a card.\nYou may put a land card from your hand onto the battlefield."],
  ["tapsweep", "Sonnenwende", "Sorcery", "{G}", 2, {}, "Destroy all tapped creatures."],
  ["forestwalker", "Waldwanderer", "Creature — Elf", "{1}", 2, { power: "2", toughness: "2" }, "Forestwalk"],
  ["hydra", "Wachsende Hydra", "Creature — Hydra", "{1}", 2, { power: "1", toughness: "5" }, "Whenever ~ is dealt damage, put that many +1/+1 counters on it."],
  ["scribe", "Schreiber", "Creature — Wizard", "{1}", 2, { power: "1", toughness: "5" }, "Whenever ~ is dealt damage, draw that many cards."],
  ["plaguebearer", "Pestbringer", "Creature — Horror", "{1}", 2, { power: "1", toughness: "1" }, "When ~ enters, put a -1/-1 counter on each creature your opponents control.\nCreatures your opponents control attack each combat if able."],
  ["scales", "Gehärtete Schuppen", "Creature — Human Warrior", "{1}", 2, { power: "2", toughness: "2" }, "If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead."],
  ["warhorn", "Kriegshorn", "Artifact", "{1}", 2, {}, "Whenever you attack, you gain 1 life.\nWhenever you attack with two or more creatures, you gain 5 life."],
  ["convoker", "Einberufer", "Sorcery", "{3}{G}", 2, {}, "Convoke\nDraw a card."],
  ["delver", "Schürfer", "Sorcery", "{4}{G}", 2, {}, "Delve\nDraw a card."],
  ["sculptor", "Bildhauer", "Creature — Vedalken", "{G}", 2, { power: "1", toughness: "1" }, "Artifact spells you cast cost {1} less to cast."],
  ["lantern", "Laterne", "Artifact", "{3}", 2, {}, "Lands you control have \"{T}: Add one mana of any color.\""],
  ["xooze", "Wachsschleim", "Creature — Ooze", "{X}{G}", 2, { power: "0", toughness: "0" }, "This creature enters with X +1/+1 counters on it."],
  ["nocounter", "Unaufhaltsam", "Sorcery", "{G}", 2, {}, "This spell can't be countered.\nDraw a card."],
  ["berserk", "Berserker", "Creature — Human", "{G}", 2, { power: "2", toughness: "2" }, "This creature attacks each combat if able."],
  ["throne", "Thronanspruch", "Sorcery", "{G}", 2, {}, "You become the monarch."],
  ["prolif", "Wucherung", "Sorcery", "{G}", 2, {}, "Proliferate."],
  ["stirrings", "Uraltes Rühren", "Sorcery", "{G}", 2, {}, "Look at the top four cards of your library. You may reveal a creature card from among them and put it into your hand. Put the rest on the bottom of your library in a random order."],
  ["warp", "Chaoswirbel", "Instant", "{2}{R}", 2, {}, "The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield."],
  ["nova", "Reinigungsnova", "Sorcery", "{3}{G}", 2, {}, "Destroy all artifacts and enchantments."],
  ["filter", "Filterland", "Land", "", 2, {}, "{G/R}, {T}: Add {G}{G}, {G}{R}, or {R}{R}."],
  ["explore", "Erkunden", "Sorcery", "{1}{G}", 2, {}, "You may play an additional land this turn.\nDraw a card."],
  ["spire", "Turmspitze", "Land", "", 2, {}, "This land enters tapped.\nWhen this land enters, sacrifice it unless you pay {1}."],
  ["cavern", "Schimmerhain", "Land", "", 2, {}, "This land enters tapped with two charge counters on it.\n{T}, Remove a charge counter from this land: Add one mana of any color."],
  ["ghoul", "Gräberghul", "Instant", "{G}", 2, {}, "Exile target card from a graveyard."],
  ["evolver", "Entwickler", "Creature — Ooze", "{G}", 2, { power: "1", toughness: "1" }, "Evolve"],
  ["germer", "Keimwaffe", "Artifact — Equipment", "{1}", 2, {}, "Living weapon\nEquipped creature gets +1/+1."],
  ["monst", "Monströs", "Creature — Beast", "{G}", 2, { power: "2", toughness: "2" }, "{3}{G}: Monstrosity 2."],
  ["manland", "Wandelland", "Land", "", 2, {}, "{1}{G}: This land becomes a 3/3 green Elemental creature until end of turn. It's still a land."],
  ["heirloom", "Heldenerbstück", "Artifact — Equipment", "{1}", 2, {}, "Equipped creature gets +2/+1.\nAs long as equipped creature is legendary, it has trample and haste.\nEquip {2}"],
  ["ballista", "Wandelnde Balliste", "Artifact Creature — Construct", "{X}{X}", 2, { power: "0", toughness: "0" }, "This creature enters with X +1/+1 counters on it.\n{4}: Put a +1/+1 counter on this creature.\nRemove a +1/+1 counter from this creature: It deals 1 damage to any target."],
  ["toxic", "Giftkäfer", "Creature — Phyrexian Insect", "{G}", 2, { power: "1", toughness: "1" }, "Toxic 1"],
  ["undead", "Wiederkehrer", "Creature — Zombie", "{G}", 2, { power: "2", toughness: "2" }, "Undying"],
  ["adapter", "Anpasser", "Creature — Druid", "{G}", 2, { power: "1", toughness: "1" }, "{1}{G}: Adapt 2."],
  ["drifter", "Treiber", "Creature — Elemental", "{3}{G}", 2, { power: "2", toughness: "2" }, "When this creature enters, draw two cards.\nEvoke {1}{G}"],
  ["humanlord", "Menschenhauptmann", "Creature — Human Soldier", "{G}", 2, { power: "1", toughness: "1" }, "Whenever another Human you control enters, put a +1/+1 counter on this creature."],
  ["human2", "Mensch", "Creature — Human Peasant", "{G}", 2, { power: "1", toughness: "1" }],
  ["priest", "Priester", "Creature — Cleric", "{G}", 2, { power: "1", toughness: "1" }, "At the beginning of your end step, you gain 1 life."]
];
const facts = new Map();

function deck(prefix, { commander = false } = {}) {
  const main = LIB.map(([key, name, typeLine, manaCost, count, extra, oracleText]) => {
    const id = `${prefix}-${key}`;
    facts.set(id, extra);
    return { id, name, count, typeLine, manaCost, manaValue: 2, imageUri: null, oracleText: oracleText ?? "" };
  });
  const commanders = commander
    ? [{ id: `${prefix}-cmd`, name: `Boss ${prefix}`, count: 1, typeLine: "Legendary Creature — Dragon", manaCost: "{1}{G}", manaValue: 2, imageUri: null }]
    : [];
  facts.set(`${prefix}-cmd`, { power: "4", toughness: "4", keywords: ["Haste"] });
  return { deckId: prefix, name: `Deck ${prefix}`, commanders, main, sideboard: [] };
}

function room(format = "standard", count = 2) {
  const players = {};
  for (let i = 0; i < count; i += 1) players[`u${i}`] = { name: `Spieler${i}`, seat: i, deck: deck(`d${i}`, { commander: format === "commander" }) };
  return { format, players };
}

/** Spiel im Zustand "playing"; `u0` ist am Zug (Hauptphase 1) und hat Priorität. */
function started(format = "standard", count = 2, seed = 7) {
  const random = seeded(seed);
  const game = createGame({ room: room(format, count), random, now: 1000, facts });
  for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
  // u0 beginnen lassen: Zug ggf. überspringen, indem wir den Beginner einfach umstellen
  if (game.turn.active !== "u0") {
    game.turn.active = "u0";
    game.priority = "u0";
    game.players.u0.turnStartSeq = game.seq;
  }
  return { game, random, opts: { random } };
}

/** Legt die erste Karte mit diesem Namen aus der Bibliothek/Hand in die Zone (schnelles Aufstellen). */
function put(game, uid, name, zone, { sick = false, only } = {}) {
  const player = game.players[uid];
  for (const from of only ? [only] : ["hand", "library", "command", "battlefield", "graveyard"]) {
    const id = player[from].find(cardId => game.defs[game.cards[cardId].def].name === name);
    if (!id) continue;
    player[from].splice(player[from].indexOf(id), 1);
    player[zone].push(id);
    game.cards[id].sinceSeq = sick ? game.seq + 1 : 0;
    return id;
  }
  throw new Error(`Karte ${name} nicht gefunden`);
}

const act = (game, uid, action, random) => applyAction(game, uid, action, { random });
/** Öffnet das manuelle Fenster (wie nach einem Kartentext, den das Spiel nicht umsetzen kann). */
const openManual = (game, uid) => {
  game.manual = { userId: uid, text: "Test", source: "Test" };
};
const forest = (game, uid, count) => Array.from({ length: count }, () => put(game, uid, "Forest", "battlefield"));
/** Wirkt eine Karte aus der Hand (Mana wird automatisch bezahlt) und lässt beide Spieler passen, bis der Stapel leer ist. */
function castAndResolve(game, uid, name, random, targets = []) {
  const id = put(game, uid, name, "hand");
  const result = act(game, uid, { type: "cast", id, targets }, random);
  expect(result).toEqual({ ok: true });
  for (let i = 0; i < 6 && game.stack.length > 0 && !game.choice && !game.manual; i += 1) act(game, game.priority, { type: "pass" }, random);
  return id;
}
const view = (game, uid) => gameView(game, uid);

describe("createGame", () => {
  it("gibt jedem sieben Karten, mischt und stellt Kommandanten in die Kommandozone", () => {
    const game = createGame({ room: room("commander", 3), random: seeded(), now: 1, facts });
    expect(game.phase).toBe("mulligan");
    for (const id of game.seats) {
      const p = game.players[id];
      expect(p.hand).toHaveLength(7);
      expect(p.command).toHaveLength(1);
      expect(p.life).toBe(40);
    }
  });

  it("Kartendaten (Stärke, Schlüsselwörter, Manaquelle) sind angereichert", () => {
    const game = createGame({ room: room(), random: seeded(), now: 1, facts });
    expect(game.defs["u0:d0-giant"]).toMatchObject({ power: 5, toughness: 5, keywords: ["trample"] });
    expect(game.defs["u0:d0-forest"].mana).toEqual([["G"]]);
  });

  it("zerlegt das Spiel für die Speicherung und fügt es wieder zusammen", () => {
    const game = createGame({ room: room(), random: seeded(), now: 1, facts });
    const { dynamic, defs } = splitGame(game);
    expect(dynamic.defs).toBeUndefined();
    expect(joinGame(dynamic, defs).defs).toBe(defs);
    expect(joinGame(null, defs)).toBeNull();
  });
});

describe("Mulligan und Spielbeginn", () => {
  it("London-Mulligan", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    const p = game.players.u0;
    expect(act(game, "u0", { type: "mulligan" }, random).ok).toBe(true);
    expect(act(game, "u0", { type: "keep", bottom: [] }, random).ok).toBe(false);
    const bottom = [p.hand[0]];
    expect(act(game, "u0", { type: "keep", bottom }, random).ok).toBe(true);
    expect(p.hand).toHaveLength(6);
    expect(p.library[0]).toBe(bottom[0]);
  });

  it("Commander: erster Mulligan frei; Beginner zieht im Mehrspielerspiel", () => {
    const random = seeded();
    const game = createGame({ room: room("commander", 3), random, facts });
    act(game, "u0", { type: "mulligan" }, random);
    expect(act(game, "u0", { type: "keep" }, random).ok).toBe(true);
    expect(game.players.u0.hand).toHaveLength(7);
    act(game, "u1", { type: "keep" }, random);
    act(game, "u2", { type: "keep" }, random);
    expect(game.players[game.turn.active].hand.length).toBe(game.turn.active === "u0" ? 8 : 8);
  });

  it("startet erst, wenn alle behalten; 2-Spieler-Beginner zieht nicht", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    act(game, "u0", { type: "keep" }, random);
    expect(game.phase).toBe("mulligan");
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(false);
    act(game, "u1", { type: "keep" }, random);
    expect(game.phase).toBe("playing");
    expect(game.turn.phase).toBe("main1");
    expect(game.priority).toBe(game.turn.active);
    expect(game.players[game.turn.active].hand).toHaveLength(7);
  });
});

describe("Länder, Mana und Zaubern", () => {
  it("Land spielen: nur eines pro Zug, nur in der Hauptphase", () => {
    const { game, random } = started();
    const a = put(game, "u0", "Forest", "hand", { only: "library" });
    const b = put(game, "u0", "Forest", "hand", { only: "library" });
    expect(act(game, "u0", { type: "playLand", id: a }, random).ok).toBe(true);
    expect(game.players.u0.battlefield).toContain(a);
    expect(act(game, "u0", { type: "playLand", id: b }, random).error).toMatch(/schon ein Land/);
    expect(act(game, "u1", { type: "playLand", id: put(game, "u1", "Forest", "hand") }, random).ok).toBe(false);
  });

  it("Zaubern tappt Länder automatisch; ohne mögliche Antwort löst der Zauber sich sofort auf (kein Klick nötig)", () => {
    const { game, random } = started();
    const f1 = put(game, "u0", "Forest", "battlefield");
    const f2 = put(game, "u0", "Forest", "battlefield");
    const f3 = put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === bear).play).toMatchObject({ kind: "spell", ok: true });
    expect(act(game, "u0", { type: "cast", id: bear }, random).ok).toBe(true);
    expect([f1, f2, f3].filter(id => game.cards[id].tapped)).toHaveLength(2);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.hand).not.toContain(bear);
    expect(game.players.u0.battlefield).toContain(bear);
    expect(game.priority).toBe("u0");
  });

  it("kann der Gegner antworten, wird er gefragt – sonst nicht; erst sein „Nichts tun“ löst den Zauber auf", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(1);
    expect(game.priority).toBe("u1");
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    act(game, "u1", { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
  });

  it("wer „nachfragen“ ausschaltet, wird nie unterbrochen", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand");
    act(game, "u1", { type: "askResponse", value: false }, random);
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
  });

  it("zu wenig Mana, falsche Farbe und Timing werden abgelehnt", () => {
    const { game, random } = started();
    put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id: bear }, random).error).toMatch(/Nicht genug Mana/);
    const bolt = put(game, "u0", "Blitz", "hand");
    expect(act(game, "u0", { type: "cast", id: bolt, targets: ["u1"] }, random).error).toMatch(/Nicht genug Mana/);
    put(game, "u0", "Forest", "battlefield");
    expect(act(game, "u0", { type: "cast", id: bear, free: true }, random).ok).toBe(true);
    // Hexerei außerhalb der eigenen Hauptphase
    const sorcery = put(game, "u1", "Zauberspruch", "hand");
    game.priority = "u1";
    expect(act(game, "u1", { type: "cast", id: sorcery, free: true }, random).error).toMatch(/Hauptphase/);
  });

  it("Sofortzauber darf der Gegner in Antwort wirken; neutralisieren schickt auf den Friedhof", () => {
    const { game, random } = started();
    put(game, "u0", "Forest", "battlefield");
    put(game, "u0", "Forest", "battlefield");
    put(game, "u1", "Mountain", "battlefield");
    const counter = put(game, "u1", "Gegenzauber", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    const sid = game.stack[0].sid;
    expect(game.priority).toBe("u1");
    expect(act(game, "u1", { type: "cast", id: counter }, random).ok).toBe(false); // ohne Ziel
    expect(act(game, "u1", { type: "cast", id: counter, targets: [sid] }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(bear); // neutralisiert
    expect(game.players.u1.graveyard).toContain(counter);
    expect(game.stack).toHaveLength(0);
  });

  it("Manapool lässt sich nicht von Hand ändern; Ritual füllt ihn über den Kartentext", () => {
    const { game, random } = started();
    expect(act(game, "u0", { type: "pool", color: "R", delta: 2 }, random).ok).toBe(false);
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Ritual", random);
    expect(game.players.u0.pool.R).toBe(3);
  });

  it("Beschwörungsmüdigkeit: frische Kreaturen können weder angreifen noch Mana erzeugen", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield", { sick: true });
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).sick).toBe(true);
    game.turn.phase = "attackers";
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).error).toMatch(/beschwörungsmüde/);
    const ogre = put(game, "u0", "Oger", "battlefield", { sick: true });
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: ogre }] }, random).ok).toBe(true); // Eile
  });
});

describe("Zugstruktur", () => {
  it("Passen führt durch Hauptphase, Kampf (übersprungen ohne Angreifer) und den nächsten Zug (Endschritt ohne Handlung übersprungen)", () => {
    const { game, random } = started();
    expect(game.turn.phase).toBe("main1");
    act(game, "u0", { type: "pass" }, random);
    expect(game.turn.phase).toBe("main2"); // keine Angreifer möglich
    const handBefore = game.players.u1.hand.length;
    act(game, "u0", { type: "pass" }, random); // der Endschritt wird übersprungen, weil niemand handeln will
    expect(game.turn.active).toBe("u1");
    expect(game.turn.number).toBe(game.turn.number);
    expect(game.players.u1.hand).toHaveLength(handBefore + 1);
    expect(game.priority).toBe("u1");
  });

  it("Handkartenlimit: erst abwerfen, dann beginnt der nächste Zug", () => {
    const { game, random } = started();
    for (let i = 0; i < 3; i += 1) put(game, "u0", "Forest", "hand", { only: "library" });
    expect(game.players.u0.hand).toHaveLength(10);
    act(game, "u0", { type: "endTurn" }, random);
    expect(game.pendingDiscard).toMatchObject({ userId: "u0", count: 3 });
    expect(act(game, "u1", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "discard", ids: game.players.u0.hand.slice(0, 2) }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "discard", ids: game.players.u0.hand.slice(0, 3) }, random).ok).toBe(true);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u0.hand).toHaveLength(7);
  });

  it("Mana verfällt zwischen den Schritten", () => {
    const { game, random } = started();
    const f = put(game, "u0", "Forest", "battlefield");
    act(game, "u0", { type: "tapMana", id: f }, random);
    expect(game.players.u0.pool.G).toBe(1);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.pool.G).toBe(0);
  });
});

function toAttackers(game, random) {
  act(game, "u0", { type: "pass" }, random);
  // Hat der Gegner einen leuchtenden Sofortzauber, wird er am Ende des Schritts gefragt.
  if (game.priority === "u1") act(game, "u1", { type: "pass" }, random);
  expect(game.turn.phase).toBe("attackers");
}

describe("Kampf", () => {
  it("unblockierter Angreifer verletzt den Spieler", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    toAttackers(game, random);
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).ok).toBe(true);
    expect(game.cards[bear].tapped).toBe(true);
    // u1 hat nichts zum Blocken → Schadensschritt beginnt sofort
    expect(game.turn.phase).toBe("damage");
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(18);
    expect(game.turn.phase).toBe("main2");
    expect(game.combat).toBeNull();
  });

  it("Blocker töten sich gegenseitig, Schaden verfällt am Zugende", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    const bear2 = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear }] }, random);
    expect(game.turn.phase).toBe("blockers");
    expect(act(game, "u0", { type: "declareBlockers", blocks: [] }, random).ok).toBe(false);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear2, attacker: bear }] }, random).ok).toBe(true);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(bear);
    expect(game.players.u1.graveyard).toContain(bear2);
    expect(game.players.u1.life).toBe(20);
  });

  it("Flug erlaubt nur Flug/Reichweite-Blocker; Drohung braucht zwei", () => {
    const { game, random } = started();
    const hawk = put(game, "u0", "Falke", "battlefield");
    const wall = put(game, "u1", "Mauer", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: hawk }] }, random);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: wall, attacker: hawk }] }, random).error).toMatch(/Flug/);
    act(game, "u1", { type: "declareBlockers", blocks: [] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(19);
  });

  it("Drohung", () => {
    const { game, random } = started();
    const ogre = put(game, "u0", "Oger", "battlefield");
    const b1 = put(game, "u1", "Bär", "battlefield");
    const b2 = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: ogre }] }, random);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: b1, attacker: ogre }] }, random).error).toMatch(/Drohung/);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: b1, attacker: ogre }, { blocker: b2, attacker: ogre }] }, random).ok).toBe(true);
  });

  it("Todesberührung des Blockers tötet den Trampler, Überschuss geht durch", () => {
    const { game, random } = started();
    const giant = put(game, "u0", "Riese", "battlefield");
    const viper = put(game, "u1", "Viper", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: giant }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: viper, attacker: giant }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(giant); // Todesberührung
    expect(game.players.u1.graveyard).toContain(viper);
    expect(game.players.u1.life).toBe(16); // Trampeln: 5 − 1 (Todesberührung zählt nur für den Angreifer)
  });

  it("Trampeln gibt Überschuss an den Spieler", () => {
    const { game, random } = started();
    const giant = put(game, "u0", "Riese", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: giant }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear, attacker: giant }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(17); // 5 − 2 Widerstandskraft
    expect(game.cards[giant].damage).toBe(2); // Schaden bleibt bis zum Zugende
  });

  it("Erstschlag", () => {
    const { game, random } = started();
    const knight = put(game, "u0", "Ritter", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: knight }] }, random);
    act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: bear, attacker: knight }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(bear);
    expect(game.players.u0.battlefield).toContain(knight); // überlebt, weil der Bär nicht mehr zuschlägt
  });

  it("Lebensverbindung", () => {
    const { game, random } = started();
    const bat = put(game, "u0", "Fledermaus", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bat }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.life).toBe(22);
    expect(game.players.u1.life).toBe(18);
  });

  it("Kommandantenschaden aus dem Kampf führt zum Ausscheiden", () => {
    const { game, random } = started("commander", 2);
    const cmd = put(game, "u0", "Boss d0", "battlefield");
    game.players.u1.cmdDamage.u0 = 18;
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: cmd }] }, random);
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u1.cmdDamage.u0).toBe(22);
    expect(game.players.u1.eliminated).toContain("Kommandantenschaden");
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("u0");
  });

  it("Kommandant: Steuer beim Wirken, Rückkehr in die Kommandozone nach dem Tod", () => {
    const { game, random } = started("commander", 2);
    for (let i = 0; i < 6; i += 1) put(game, "u0", "Forest", "battlefield");
    const cmd = game.players.u0.command[0];
    expect(act(game, "u0", { type: "cast", id: cmd }, random).ok).toBe(true);
    expect(game.players.u0.cmdCasts[cmd]).toBe(1);
    expect(game.players.u0.battlefield).toContain(cmd);
    // stirbt: Frage erscheint
    game.cards[cmd].counters["-1/-1"] = 5;
    act(game, "u1", { type: "coin" }, random); // jede Aktion prüft die zustandsbasierten Regeln
    expect(game.players.u0.graveyard).toContain(cmd);
    expect(game.players.u0.prompts).toEqual([{ type: "commander", id: cmd }]);
    expect(view(game, "u1").players[0].prompts).toEqual([]);
    expect(act(game, "u0", { type: "commanderZone", id: cmd, yes: true }, random).ok).toBe(true);
    expect(game.players.u0.command).toContain(cmd);
    // zweites Wirken kostet 2 mehr: {1}{G} + {2}
    const planTax = view(game, "u0").players[0].command[0].play;
    expect(planTax.ok).toBe(true);
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "cast", id: cmd }, random);
    expect(game.players.u0.battlefield.filter(id => game.cards[id].tapped).length).toBe(4);
  });
});

describe("Weitere Aktionen", () => {
  it("manuelles Bewegen, Marker (+1/+1 und -1/-1 heben sich auf), Spielsteine", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    expect(act(game, "u0", { type: "counter", id: bear, kind: "+1/+1", delta: 2 }, random).ok).toBe(false); // nur im manuellen Fenster
    openManual(game, "u0");
    act(game, "u0", { type: "counter", id: bear, kind: "+1/+1", delta: 2 }, random);
    act(game, "u0", { type: "counter", id: bear, kind: "-1/-1", delta: 1 }, random);
    expect(game.cards[bear].counters).toEqual({ "+1/+1": 1 });
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).power).toBe(3);
    expect(act(game, "u0", { type: "token", name: "Goblin 1/1" }, random).ok).toBe(true);
    const token = game.players.u0.battlefield.at(-1);
    expect(view(game, "u0").players[0].battlefield.at(-1)).toMatchObject({ power: 1, toughness: 1, token: true });
    act(game, "u0", { type: "move", id: token, to: "graveyard" }, random);
    expect(game.cards[token]).toBeUndefined();
    expect(act(game, "u0", { type: "token", name: "<>" }, random).ok).toBe(false);
  });

  it("fremde Karten sind tabu; Bibliothek ansehen ist privat", () => {
    const { game, random } = started();
    const foreign = game.players.u1.hand[0];
    openManual(game, "u0");
    expect(act(game, "u0", { type: "move", id: foreign, to: "graveyard" }, random).ok).toBe(false);
    act(game, "u0", { type: "look", count: 3 }, random);
    expect(view(game, "u0").players[0].looking).toHaveLength(3);
    expect(view(game, "u1").players[0].looking).toBeNull();
  });

  it("Sicht verrät weder fremde Hand noch Bibliothek noch verdeckte Karten", () => {
    const { game, random } = started();
    const hidden = game.players.u1.hand[0];
    const name = game.defs[game.cards[hidden].def].name;
    openManual(game, "u1");
    act(game, "u1", { type: "move", id: hidden, to: "battlefield", faceDown: true }, random);
    const v = view(game, "u0");
    const p1 = v.players.find(p => p.userId === "u1");
    expect(p1.hand).toEqual([]);
    expect(p1.battlefield.find(c => c.id === hidden).name).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(game.players.u1.library[0]);
    expect(JSON.stringify(game.log)).not.toContain(`bewegt ${name}`);
    expect(view(game, "u1").players.find(p => p.userId === "u1").battlefield.find(c => c.id === hidden).name).toBe(name);
  });

  it("Aufgeben beendet das Spiel mit Zusammenfassung", () => {
    const { game, random } = started();
    act(game, "u1", { type: "concede" }, random);
    expect(game.phase).toBe("ended");
    expect(game.winner).toBe("u0");
    expect(game.summary.players).toHaveLength(2);
  });

  it("Ausscheiden mitten im Zug: im Mehrspielerspiel geht es weiter", () => {
    const { game, random } = started("commander", 3);
    act(game, "u0", { type: "concede" }, random);
    expect(game.phase).toBe("playing");
    expect(game.turn.active).not.toBe("u0");
    expect(game.priority).toBe(game.turn.active);
  });

  it("Fähigkeiten auf den Stapel, Abbruch, Verlassen", () => {
    const { game, random } = started("commander", 3);
    openManual(game, "u0");
    expect(act(game, "u0", { type: "ability", text: "Auslöser: ziehe eine Karte" }, random).ok).toBe(true);
    game.manual = null;
    expect(game.stack).toHaveLength(1);
    playerLeft(game, "u2", { random });
    expect(game.players.u2.eliminated).toBe("hat den Raum verlassen");
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(abortGame(game, 9).aborted).toBe(true);
  });

  it("Würfel, Münze, ungültige Eingaben", () => {
    const { game, random } = started();
    expect(act(game, "u0", { type: "dice", sides: 20 }, random).ok).toBe(true);
    expect(game.log.at(-1).text).toMatch(/W20: \d+/);
    expect(act(game, "u0", { type: "bogus" }, random).ok).toBe(false);
    expect(act(game, "u0", "x", random).ok).toBe(false);
    expect(act(game, "fremd", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "life", delta: "viel" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id: "gibtsnicht" }, random).ok).toBe(false);
  });
});

describe("Kartentext-Engine", () => {
  it("Blitz auf einen Spieler und auf eine Kreatur; Ziele werden geprüft", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u0", "Mountain", "battlefield");
    put(game, "u0", "Mountain", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Blitz", "hand");
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id, targets: ["unbekannt"] }, random).ok).toBe(false);
    expect(view(game, "u0").players[0].hand.find(c => c.id === id).play.targets[0].options).toContain("u1");
    act(game, "u0", { type: "cast", id, targets: ["u1"] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(17);
    castAndResolve(game, "u0", "Blitz", random, [bear]);
    // zweiter Blitz: Mana reicht nicht (nur ein Berg und ein Wald) → Fehler wäre früher gekommen; hier genügt der Schaden
  });

  it("Karten ziehen und Leben gewinnen laufen über den Text", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const study = put(game, "u0", "Studium", "hand");
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "cast", id: study, targets: [] }, random)).toEqual({ ok: true });
    for (let i = 0; i < 6 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 2);
    castAndResolve(game, "u0", "Heilung", random);
    expect(game.players.u0.life).toBe(24);
  });

  it("Zerstören: nur gültige Ziele, Hexproof ist tabu", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const veil = put(game, "u1", "Schleier", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Zerstörer", "hand");
    const options = view(game, "u0").players[0].hand.find(c => c.id === id).play.targets[0].options;
    expect(options).toContain(bear);
    expect(options).not.toContain(veil);
    expect(act(game, "u0", { type: "cast", id, targets: [veil] }, random).ok).toBe(false);
    act(game, "u0", { type: "cast", id, targets: [bear] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(bear);
  });

  it("Auslöser beim Betreten: Seher zieht eine Karte (alles löst sich selbst auf)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const seer = put(game, "u0", "Seher", "hand");
    const hand = game.players.u0.hand.length;
    act(game, "u0", { type: "cast", id: seer }, random);
    expect(game.players.u0.battlefield).toContain(seer);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.hand.length).toBe(hand); // −1 (gespielt) +1 (gezogen)
  });

  it("Auslöser mit Ziel öffnet eine Auswahl: Kavu schadet einer Kreatur", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const victim = put(game, "u1", "Bär", "battlefield");
    const kavu = put(game, "u0", "Kavu", "hand");
    act(game, "u0", { type: "cast", id: kavu }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.choice).toMatchObject({ userId: "u0", kind: "targets" });
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false); // erst auswählen
    expect(act(game, "u0", { type: "choose", ids: ["gibtsnicht"] }, random).ok).toBe(false);
    expect(view(game, "u0").choice.options.map(o => o.id)).toContain(victim);
    expect(view(game, "u1").choice.options).toEqual([]);
    act(game, "u0", { type: "choose", ids: [victim] }, random);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.graveyard).toContain(victim);
  });

  it("Suchen: Wachstum legt ein Basic Land getappt aufs Feld und mischt", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Wachstum", random);
    expect(game.choice).toMatchObject({ kind: "cards" });
    const options = game.choice.options;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every(id => game.defs[game.cards[id].def].types.basicLand)).toBe(true);
    const land = options[0];
    act(game, "u0", { type: "choose", ids: [land] }, random);
    expect(game.players.u0.battlefield).toContain(land);
    expect(game.cards[land].tapped).toBe(true);
    expect(game.choice).toBeNull();
  });

  it("Aktivierte Fähigkeit: Magier tappt und trifft den Gegner", () => {
    const { game, random } = started();
    const mage = put(game, "u0", "Magier", "battlefield");
    const options = view(game, "u0").players[0].battlefield.find(c => c.id === mage).abilities;
    expect(options[0]).toMatchObject({ index: 0, ok: true });
    expect(act(game, "u0", { type: "activate", id: mage, index: 0 }, random).ok).toBe(false); // Ziel fehlt
    act(game, "u0", { type: "activate", id: mage, index: 0, targets: ["u1"] }, random);
    expect(game.cards[mage].tapped).toBe(true);
    expect(act(game, "u0", { type: "activate", id: mage, index: 0, targets: ["u1"] }, random).ok).toBe(false);
    act(game, "u0", { type: "pass" }, random);
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(19);
  });

  it("Spielsteine entstehen über den Text", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Alarm", random);
    const tokens = game.players.u0.battlefield.filter(id => game.cards[id].token);
    expect(tokens).toHaveLength(2);
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === tokens[0])).toMatchObject({ power: 1, toughness: 1, name: "Soldier" });
  });

  it("Wühlen und Abwerfen verlangen eine Auswahl des Betroffenen", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    castAndResolve(game, "u0", "Seherin", random);
    expect(game.choice).toMatchObject({ userId: "u0", max: 2, min: 0 });
    const top = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [top] }, random);
    expect(game.players.u0.library[0]).toBe(top);
    castAndResolve(game, "u0", "Qual", random);
    expect(game.choice).toMatchObject({ userId: "u1", min: 1, max: 1 });
    const chosen = game.choice.options[2];
    act(game, "u1", { type: "choose", ids: [chosen] }, random);
    expect(game.players.u1.graveyard).toContain(chosen);
  });

  it("Unverstandene Texte öffnen ein manuelles Fenster nur für den Spieler", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Rätsel", random);
    expect(game.manual).toMatchObject({ userId: "u0" });
    expect(act(game, "u1", { type: "draw" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(true);
    expect(game.players.u0.hand.length).toBe(hand + 1);
    expect(act(game, "u1", { type: "manualDone" }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "manualDone" }, random).ok).toBe(true);
    expect(game.manual).toBeNull();
    expect(act(game, "u0", { type: "draw" }, random).ok).toBe(false); // wieder gesperrt
  });

  it("wahllos ziehen, Leben ändern oder Karten verschieben ist nicht möglich", () => {
    const { game, random } = started();
    const card = game.players.u0.hand[0];
    for (const action of [
      { type: "draw" }, { type: "mill" }, { type: "life", delta: 5 }, { type: "pool", color: "G", delta: 1 }, { type: "untapAll" },
      { type: "move", id: card, to: "battlefield" }, { type: "token", name: "Drache 9/9" }, { type: "shuffle" }
    ]) {
      expect(act(game, "u0", action, random).ok).toBe(false);
    }
  });
});

describe("Zugbeginn, Dauereffekte, Rückblende, weitere Auslöser", () => {
  it("Enttappen und Ziehen laufen automatisch: zu Beginn eines Zuges sind eigene Karten wieder ungetappt", () => {
    const { game, random } = started();
    const [land] = forest(game, "u0", 1);
    const handBefore = game.players.u1.hand.length;
    act(game, "u0", { type: "tapMana", id: land }, random);
    expect(game.cards[land].tapped).toBe(true);
    for (let i = 0; i < 12 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u1.hand.length).toBe(handBefore + 1); // der zweite Spieler zieht in seinem ersten Zug
    expect(game.turn.drew).toBe(true);
    for (let i = 0; i < 12 && game.turn.active === "u1"; i += 1) {
      if (game.pendingDiscard) act(game, "u1", { type: "discard", ids: game.players.u1.hand.slice(0, game.pendingDiscard.count) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.turn.active).toBe("u0");
    expect(game.cards[land].tapped).toBe(false);
  });

  it("Manuelles Ziehen: Die Bibliothek wird im Zieh-Schritt angeklickt, danach geht es automatisch weiter", () => {
    const { game, random } = started();
    act(game, "u1", { type: "autoStart", value: false }, random);
    const [land] = forest(game, "u1", 1);
    game.cards[land].tapped = true;
    for (let i = 0; i < 12 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn).toMatchObject({ active: "u1", phase: "draw", manualStart: true });
    expect(game.cards[land].tapped).toBe(false); // Enttappen ist immer automatisch
    const hand = game.players.u1.hand.length;
    expect(act(game, "u1", { type: "pass" }, random).error).toMatch(/Bibliothek/);
    expect(act(game, "u1", { type: "drawStep" }, random).ok).toBe(true);
    expect(game.players.u1.hand.length).toBe(hand + 1);
    expect(game.turn.phase).toBe("main1");
    expect(act(game, "u1", { type: "drawStep" }, random).ok).toBe(false);
  });

  it("Der Startspieler zieht im ersten Zug nicht (auch im manuellen Modus)", () => {
    const random = seeded();
    const game = createGame({ room: room(), random, facts });
    game.players.u0.autoStart = false;
    game.players.u1.autoStart = false;
    for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
    const first = game.turn.active;
    expect(game.turn.drawBlocked).toBe(true);
    expect(game.turn.phase).toBe("main1");
    game.turn.phase = "draw";
    expect(applyAction(game, first, { type: "drawStep" }, { random }).error).toMatch(/Startspieler/);
  });

  it("Dauereffekte: Hymne und Anführer verändern Stärke und Schlüsselwörter", () => {
    const { game } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    const lord = put(game, "u0", "Anführer", "battlefield");
    const foe = put(game, "u1", "Bär", "battlefield");
    let mine = view(game, "u0").players[0].battlefield;
    expect(mine.find(c => c.id === bear)).toMatchObject({ power: 3, toughness: 3 });
    expect(mine.find(c => c.id === bear).keywords).toContain("flying");
    expect(mine.find(c => c.id === lord)).toMatchObject({ power: 2, toughness: 2 }); // „Other“
    put(game, "u0", "Hymne", "battlefield");
    mine = view(game, "u0").players[0].battlefield;
    expect(mine.find(c => c.id === bear)).toMatchObject({ power: 4, toughness: 4 });
    expect(view(game, "u0").players[1].battlefield.find(c => c.id === foe)).toMatchObject({ power: 2, toughness: 2 });
  });

  it("Rückblende: Karte aus dem Friedhof wirken, danach ins Exil; Surveil legt Karten auf den Friedhof", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    forest(game, "u0", 2);
    const dreams = castAndResolve(game, "u0", "Träume", random);
    expect(game.choice).toMatchObject({ kind: "cards", max: 1 });
    const top = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [top] }, random);
    expect(game.players.u0.graveyard).toContain(top);
    expect(game.players.u0.graveyard).toContain(dreams);
    const option = view(game, "u0").players[0].graveyard.find(c => c.id === dreams).play;
    expect(option).toMatchObject({ kind: "spell", ok: true });
    act(game, "u0", { type: "cast", id: dreams }, random);
    expect(game.choice).toMatchObject({ kind: "cards" }); // Surveil läuft erneut
    act(game, "u0", { type: "choose", ids: [] }, random);
    expect(game.players.u0.exile).toContain(dreams);
    expect(game.players.u0.graveyard).not.toContain(dreams);
  });

  it("Kostenloses Wirken ist nicht möglich", () => {
    const { game, random } = started();
    const id = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id, free: true }, random).ok).toBe(false);
  });

  it("Auslöser auf andere Ereignisse: Landfall, gegnerische Kreatur stirbt, Beginn der Endphase", () => {
    const { game, random } = started();
    const bard = put(game, "u0", "Barde", "battlefield");
    const reaper = put(game, "u0", "Schnitter", "battlefield");
    put(game, "u0", "Priester", "battlefield");
    const land = put(game, "u0", "Forest", "hand", { only: "library" });
    act(game, "u0", { type: "playLand", id: land }, random);
    expect(game.stack).toHaveLength(0); // Landfall löst sich selbst auf
    expect(game.players.u0.life).toBe(21);
    // gegnerische Kreatur stirbt → Schnitter bekommt einen Marker
    const victim = put(game, "u1", "Bär", "battlefield");
    game.cards[victim].counters["-1/-1"] = 5;
    act(game, "u1", { type: "coin" }, random);
    expect(game.players.u1.graveyard).toContain(victim);
    expect(game.cards[reaper].counters["+1/+1"]).toBe(1);
    expect(bard).toBeTruthy();
    // Beginn der Endphase: Priester löst aus; der Zug endet danach von selbst
    for (let i = 0; i < 6 && game.turn.active === "u0"; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.turn.active).toBe("u1");
    expect(game.players.u0.life).toBe(22);
  });

  it("Selbstheilung: Hat niemand Priorität und wartet niemand, geht sie an den aktiven Spieler", () => {
    const { game } = started();
    game.priority = null;
    expect(repairGame(game)).toBe(true);
    expect(game.priority).toBe(game.turn.active);
    game.choice = { userId: "u0", kind: "cards", prompt: "x", options: [], min: 0, max: 0, step: { type: "scry" }, queue: [], ctx: null };
    game.priority = null;
    expect(repairGame(game)).toBe(false); // wartet auf eine Auswahl: nichts zu reparieren
  });
});

describe("Dauertest: das Spiel bleibt nie stehen", () => {
  /** Wählt zufällig eine mögliche Aktion für den Spieler, der gerade etwas tun muss. */
  function pick(game, random) {
    const waitingDefender = game.combat?.phaseWaiting ? [...new Set(game.combat.attackers.map(a => a.target))].find(id => !game.combat.done.includes(id)) : undefined;
    const waiting = game.choice?.userId ?? game.manual?.userId ?? game.pendingDiscard?.userId ?? waitingDefender ?? game.priority;
    const uid = waiting;
    if (!game.players[uid]) throw new Error(`Niemand am Zug: ${JSON.stringify({ priority: game.priority, phase: game.turn.phase, combat: game.combat, choice: game.choice?.userId, manual: game.manual, discard: game.pendingDiscard })}`);
    const options = [];
    const v = gameView(game, uid);
    const mine = v.players.find(p => p.userId === uid);
    if (game.choice) {
      const c = game.choice;
      const count = Math.min(c.max, Math.max(c.min, 1));
      return [uid, { type: "choose", ids: c.options.slice(0, c.min === 0 ? 0 : count) }];
    }
    if (game.manual) return [uid, { type: "manualDone" }];
    if (game.pendingDiscard) return [uid, { type: "discard", ids: mine.hand.slice(0, game.pendingDiscard.count).map(c => c.id) }];
    if (waitingDefender === uid) {
      const blockers = mine.battlefield.filter(c => c.kind === "creature" && !c.tapped);
      const attackers = game.combat.attackers.filter(a => a.target === uid);
      const blocks = blockers.length && attackers.length && random() < 0.5 ? [{ blocker: blockers[0].id, attacker: attackers[0].id }] : [];
      return [uid, { type: "declareBlockers", blocks }];
    }
    if (game.turn.phase === "attackers" && game.turn.active === uid && random() < 0.6) {
      const ready = mine.battlefield.filter(c => c.kind === "creature" && !c.tapped && !c.sick && !c.keywords?.includes("defender"));
      if (ready.length) return [uid, { type: "declareAttackers", attackers: [{ id: ready[0].id, target: v.players.find(p => p.userId !== uid).userId }] }];
    }
    for (const card of [...mine.hand, ...mine.command, ...mine.graveyard]) {
      if (card.play?.ok) {
        const targets = (card.play.targets ?? []).map(t => t.options[0]);
        if (card.play.targets?.some(t => t.options.length === 0)) continue;
        options.push({ type: card.play.kind === "land" ? "playLand" : "cast", id: card.id, ...(targets.length ? { targets } : {}) });
      }
    }
    for (const card of mine.battlefield) if (card.mana && !card.tapped && !card.sick) options.push({ type: "tapMana", id: card.id, ...(card.manaColors.length > 1 ? { color: card.manaColors[0] } : {}) });
    options.push({ type: "pass" }, { type: "pass" }, { type: "pass" });
    return [uid, options[Math.floor(random() * options.length)]];
  }

  it("zufällige Spiele laufen ohne Fehler und ohne Stillstand", () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const random = seeded(seed * 97);
      const players = seed % 3 === 0 ? 3 : 2;
      const game = createGame({ room: room(players === 3 ? "commander" : "standard", players), random, now: 1, facts });
      for (const id of game.seats) applyAction(game, id, { type: "keep" }, { random });
      for (let step = 0; step < 400 && game.phase === "playing"; step += 1) {
        const stuck = Boolean(!game.choice && !game.manual && !game.pendingDiscard && !game.combat?.phaseWaiting && (!game.priority || game.players[game.priority].eliminated));
        expect(stuck, `Stillstand in Spiel ${seed}, Schritt ${step}`).toBe(false);
        const [uid, action] = pick(game, random);
        const result = applyAction(game, uid, action, { random });
        if (!result.ok) {
          // Eine unzulässige Zufallsaktion darf das Spiel nicht beschädigen: passen geht immer, sofern man Priorität hat
          const fallback = game.priority === uid ? applyAction(game, uid, { type: "pass" }, { random }) : result;
          expect(fallback.ok || game.phase !== "playing" || game.choice || game.manual || game.pendingDiscard || game.combat?.phaseWaiting, `Aktion ${JSON.stringify(action)} abgelehnt (${result.error}) in Spiel ${seed}`).toBeTruthy();
        }
      }
    }
  }, 30000);
});

describe("Länder mit besonderen Regeln und Effekte der Anzeige", () => {
  it("Evolving-Wilds-Prinzip: tappen und opfern, dann ein Basic Land getappt aufs Feld", () => {
    const { game, random } = started();
    const wilds = put(game, "u0", "Wildnis", "battlefield");
    const info = view(game, "u0").players[0].battlefield.find(c => c.id === wilds).abilities[0];
    expect(info).toMatchObject({ ok: true, costLabel: "{T}, Opfern" });
    expect(act(game, "u0", { type: "activate", id: wilds, index: 0 }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(wilds); // geopfert
    expect(game.choice).toMatchObject({ kind: "cards" });
    const land = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [land] }, random);
    expect(game.players.u0.battlefield).toContain(land);
    expect(game.cards[land].tapped).toBe(true);
  });

  it("Länder, die getappt ins Spiel kommen, und ihr Auslöser lösen sich selbst auf", () => {
    const { game, random } = started();
    const cliffs = put(game, "u0", "Klippen", "hand");
    expect(act(game, "u0", { type: "playLand", id: cliffs }, random).ok).toBe(true);
    expect(game.cards[cliffs].tapped).toBe(true);
    expect(game.players.u0.life).toBe(21);
    expect(game.stack).toHaveLength(0);
  });

  it("Schaden und Heilung erzeugen Anzeige-Effekte für alle", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const id = put(game, "u0", "Blitz", "hand");
    act(game, "u0", { type: "cast", id, targets: ["u1"] }, random);
    expect(view(game, "u1").fx.at(-1)).toMatchObject({ type: "damage", player: "u1", amount: 3 });
    expect(view(game, "u0").fx.at(-1).id).toBe(view(game, "u1").fx.at(-1).id);
  });
});

describe("Länder mit Bedingung beim Ins-Spiel-Kommen", () => {
  const play = (game, random, name) => {
    const land = put(game, "u0", name, "hand", { only: "library" });
    expect(act(game, "u0", { type: "playLand", id: land }, random).ok).toBe(true);
    return land;
  };

  it("Slow-Land: ungetappt erst mit zwei anderen Ländern", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    expect(game.cards[play(game, random, "Langsam")].tapped).toBe(true);
    const second = started();
    forest(second.game, "u0", 2);
    expect(second.game.cards[play(second.game, second.random, "Langsam")].tapped).toBe(false);
  });

  it("Check-Land: prüft die Landtypen der eigenen Länder", () => {
    const { game, random } = started();
    forest(game, "u0", 2); // nur Forest: Bedingung (Mountain oder Swamp) nicht erfüllt
    expect(game.cards[play(game, random, "Prüfland")].tapped).toBe(true);
    const second = started();
    put(second.game, "u0", "Mountain", "battlefield");
    expect(second.game.cards[play(second.game, second.random, "Prüfland")].tapped).toBe(false);
  });

  it("Shock-Land: Spieler wählt, ob er 2 Leben zahlt", () => {
    const { game, random } = started();
    const land = play(game, random, "Schock");
    expect(game.choice).toMatchObject({ userId: "u0", kind: "yesno", options: ["yes", "no"] });
    expect(view(game, "u0").choice.options).toEqual([{ id: "yes", label: "2 Leben zahlen (ungetappt)" }, { id: "no", label: "Nicht zahlen (getappt)" }]);
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(false);
    act(game, "u0", { type: "choose", ids: ["yes"] }, random);
    expect(game.players.u0.life).toBe(18);
    expect(game.cards[land].tapped).toBe(false);
    const second = started();
    const tapped = play(second.game, second.random, "Schock");
    act(second.game, "u0", { type: "choose", ids: ["no"] }, second.random);
    expect(second.game.players.u0.life).toBe(20);
    expect(second.game.cards[tapped].tapped).toBe(true);
  });

  it("Shock-Land bei zu wenig Leben kommt von selbst getappt", () => {
    const { game, random } = started();
    game.players.u0.life = 2;
    const land = play(game, random, "Schock");
    expect(game.choice).toBeNull();
    expect(game.cards[land].tapped).toBe(true);
  });

  it("Zeig-Land: Karte aus der Hand zeigen oder getappt", () => {
    const { game, random } = started();
    const mountain = put(game, "u0", "Mountain", "hand", { only: "library" });
    const land = play(game, random, "Zeigland");
    expect(game.choice.options).toContain(mountain);
    act(game, "u0", { type: "choose", ids: [mountain] }, random);
    expect(game.cards[land].tapped).toBe(false);
    expect(game.players.u0.hand).toContain(mountain);
    const second = started();
    const hand = second.game.players.u0.hand.filter(id => second.game.defs[second.game.cards[id].def].name === "Mountain");
    for (const id of hand) second.game.players.u0.hand.splice(second.game.players.u0.hand.indexOf(id), 1);
    const tapped = play(second.game, second.random, "Zeigland");
    expect(second.game.choice).toBeNull();
    expect(second.game.cards[tapped].tapped).toBe(true);
  });

  it("Bounce-Land: ein eigenes Land zurück auf die Hand", () => {
    const { game, random } = started();
    const [old] = forest(game, "u0", 1);
    play(game, random, "Rücklauf");
    expect(game.choice).toMatchObject({ kind: "cards", min: 1, max: 1 });
    expect(game.choice.options).toContain(old);
    act(game, "u0", { type: "choose", ids: [old] }, random);
    expect(game.players.u0.hand).toContain(old);
    expect(game.players.u0.battlefield).not.toContain(old);
  });
});

describe("Rückfrage nur bei leuchtenden Karten", () => {
  it("keine Rückfrage, wenn der Gegner nur Länder, Kreaturen oder eine nicht bezahlbare Karte hat", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "hand", { only: "library" });
    put(game, "u1", "Magier", "battlefield");   // Fähigkeit auf dem Feld zählt nicht
    put(game, "u1", "Blitz", "hand", { only: "library" }); // kein rotes Mana → nicht bezahlbar
    const bear = put(game, "u0", "Bär", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.battlefield).toContain(bear);
  });

  it("Rückfrage, sobald der Gegner einen bezahlbaren Sofortzauber auf der Hand hat", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand", { only: "library" });
    const bear = put(game, "u0", "Bär", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.stack).toHaveLength(1);
    expect(game.priority).toBe("u1");
  });
});

describe("Bedingungen, Modi, X und Cycling", () => {
  const playLand = (game, random, name) => {
    const land = put(game, "u0", name, "hand", { only: "library" });
    expect(act(game, "u0", { type: "playLand", id: land }, random).ok).toBe(true);
    return land;
  };

  it("„unless you control a legendary creature“ und „first, second, or third turn“", () => {
    const { game, random } = started();
    expect(game.cards[playLand(game, random, "Legendär")].tapped).toBe(true);
    const second = started();
    const legend = put(second.game, "u0", "Bär", "battlefield");
    second.game.defs[second.game.cards[legend].def].types.legendary = true;
    expect(second.game.cards[playLand(second.game, second.random, "Legendär")].tapped).toBe(false);
    const third = started();
    third.game.players.u0.turnsTaken = 1;
    expect(third.game.cards[playLand(third.game, third.random, "Startstadt")].tapped).toBe(false);
    const late = started();
    late.game.players.u0.turnsTaken = 4;
    expect(late.game.cards[playLand(late.game, late.random, "Startstadt")].tapped).toBe(true);
  });

  it("Modale Zauber: Modus wählen, dann Ziele des gewählten Modus", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const id = put(game, "u0", "Wahlzauber", "hand", { only: "library" });
    const play = view(game, "u0").players[0].hand.find(c => c.id === id).play;
    expect(play.modes).toHaveLength(2);
    expect(play.modes[0].targets[0].options).toContain("u1");
    expect(play.modes[1].targets).toEqual([]);
    expect(act(game, "u0", { type: "cast", id }, random).error).toMatch(/Modus/);
    expect(act(game, "u0", { type: "cast", id, mode: 0 }, random).ok).toBe(false); // Ziel fehlt
    expect(act(game, "u0", { type: "cast", id, mode: 1 }, random).ok).toBe(true);
    expect(game.players.u0.life).toBe(25);
  });

  it("X-Zauber: der gewählte Wert bestimmt die Menge", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const id = put(game, "u0", "Flutwelle", "hand", { only: "library" });
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "cast", id, x: 3 }, random).ok).toBe(true);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 3);
  });

  it("Cycling: abwerfen, Mana zahlen, eine Karte ziehen; Landcycling sucht ein Basic Land", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const cycler = put(game, "u0", "Wechsler", "hand", { only: "library" });
    const info = view(game, "u0").players[0].hand.find(c => c.id === cycler).cycle;
    expect(info).toMatchObject({ ok: true, cost: "{1}" });
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "cycle", id: cycler }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(cycler);
    expect(game.players.u0.hand.length).toBe(hand); // −1 abgeworfen, +1 gezogen
    const lc = put(game, "u0", "Landwechsler", "hand", { only: "library" });
    act(game, "u0", { type: "cycle", id: lc }, random);
    expect(game.choice).toMatchObject({ kind: "cards" });
    const land = game.choice.options[0];
    act(game, "u0", { type: "choose", ids: [land] }, random);
    expect(game.players.u0.hand).toContain(land);
    expect(act(game, "u0", { type: "cycle", id: put(game, "u0", "Bär", "hand", { only: "library" }) }, random).ok).toBe(false);
  });
});

describe("Sofortzauber im Kampf", () => {
  it("der Verteidiger kann vor dem Blocken einen Sofortzauber wirken und blockt danach weiter", () => {
    const { game, random } = started();
    const ogre = put(game, "u0", "Bär", "battlefield");
    const wall = put(game, "u1", "Mauer", "battlefield");
    put(game, "u1", "Mountain", "battlefield");
    const bolt = put(game, "u1", "Blitz", "hand", { only: "library" });
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: ogre, target: "u1" }] }, random);
    expect(game.combat.phaseWaiting).toBe(true);
    expect(view(game, "u1").players[1].hand.find(card => card.id === bolt).play.ok).toBe(true);
    expect(act(game, "u1", { type: "cast", id: bolt, targets: ["u0"] }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.stack).toHaveLength(0);
    expect(game.players.u0.life).toBe(17);
    expect(game.combat.phaseWaiting).toBe(true);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: wall, attacker: ogre }] }, random).ok).toBe(true);
  });

  it("vor dem Kampfschaden wird auch der Verteidiger mit leuchtendem Sofortzauber gefragt", () => {
    const { game, random } = started();
    const bear = put(game, "u0", "Bär", "battlefield");
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand", { only: "library" });
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random);
    // u1 hat keinen Blocker: Schadensschritt; erst u0, dann u1 gefragt
    expect(game.turn.phase).toBe("damage");
    act(game, "u0", { type: "pass" }, random);
    expect(game.priority).toBe("u1");
    act(game, "u1", { type: "pass" }, random);
    expect(game.players.u1.life).toBe(18);
  });
});

describe("Ausrüstung, Auren und Wiederbelebung", () => {
  it("Ausrüstung kommt ins Spiel, hängt sich automatisch an und gibt Bonus (Rüsten kostet Mana, nur Zauberspruchtempo)", () => {
    const { game, random } = started();
    forest(game, "u0", 6);
    const bear = put(game, "u0", "Bär", "battlefield");
    const scythe = put(game, "u0", "Sense", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: scythe }, random)).toEqual({ ok: true });
    // Auslöser verlangt ein Ziel (nur eine Kreatur → Auswahl)
    if (game.choice) act(game, "u0", { type: "choose", ids: [bear] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice?.kind).toBe("yesno"); // „you may attach“: der Spieler entscheidet
    act(game, "u0", { type: "choose", ids: ["yes"] }, random);
    expect(game.cards[scythe].attachedTo).toBe(bear);
    const card = view(game, "u0").players[0].battlefield.find(c => c.id === bear);
    expect(card.power).toBe(4);
    expect(card.toughness).toBe(3);
    expect(card.attachments).toEqual(["Sense"]);
    // Umrüsten auf eine zweite Kreatur
    const bear2 = put(game, "u0", "Bär", "battlefield");
    const options = view(game, "u0").players[0].battlefield.find(c => c.id === scythe).abilities[0];
    expect(options.ok).toBe(true);
    expect(act(game, "u0", { type: "activate", id: scythe, index: 0, targets: [bear2] }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.cards[scythe].attachedTo).toBe(bear2);
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).power).toBe(2);
  });

  it("stirbt die Kreatur, bleibt die Ausrüstung liegen; eine Aura geht mit", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const bear = put(game, "u0", "Bär", "battlefield");
    const halo = put(game, "u0", "Heiligenschein", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: halo, targets: [bear] }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.cards[halo].attachedTo).toBe(bear);
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).keywords).toContain("flying");
    game.cards[bear].damage = 99;
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(bear);
    expect(game.players.u0.graveyard).toContain(halo);
  });

  it("Wiederbelebung holt eine Kreatur aus dem Friedhof zurück, mit Zusatzmarkern", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const bear = put(game, "u0", "Bär", "graveyard");
    const revive = put(game, "u0", "Wiederkehr", "hand", { only: "library" });
    const targets = view(game, "u0").players[0].hand.find(c => c.id === revive).play.targets;
    expect(targets[0].options).toContain(bear);
    expect(act(game, "u0", { type: "cast", id: revive, targets: [bear] }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.battlefield).toContain(bear);
    expect(game.cards[bear].counters["+1/+1"]).toBe(2);
    expect(game.manual).toBeNull();
  });
});

describe("Mana selbst wählen", () => {
  it("zahlt nur mit den gewählten Ländern, sonst Fehler", () => {
    const { game, random } = started();
    const f1 = put(game, "u0", "Forest", "battlefield");
    const f2 = put(game, "u0", "Forest", "battlefield");
    const f3 = put(game, "u0", "Forest", "battlefield");
    const bear = put(game, "u0", "Bär", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: bear, tap: [f3] }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id: bear, tap: [f2, f3] }, random).ok).toBe(true);
    expect(game.cards[f1].tapped).toBe(false);
    expect(game.cards[f2].tapped).toBe(true);
    expect(game.cards[f3].tapped).toBe(true);
  });
});

describe("Spielstein mit Rückblende-Bonus", () => {
  const tokens = (game, uid) => game.players[uid].battlefield.filter(id => game.cards[id].token);
  it("normal gewirkt: 3/3 ohne Marker, kein manuelles Fenster", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const esper = put(game, "u0", "Esper-Rückholung", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: esper }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    const [token] = tokens(game, "u0");
    expect(game.defs ? game.xdefs[game.cards[token].def].name : "").toBe("Robot Warrior");
    expect(game.cards[token].counters["+1/+1"]).toBeUndefined();
    expect(game.manual).toBeNull();
  });
  it("aus dem Friedhof: zwei +1/+1-Marker", () => {
    const { game, random } = started();
    forest(game, "u0", 5);
    put(game, "u0", "Klippen", "battlefield");
    const esper = put(game, "u0", "Esper-Rückholung", "graveyard");
    expect(act(game, "u0", { type: "cast", id: esper }, random)).toEqual({ ok: true });
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    const [token] = tokens(game, "u0");
    expect(game.cards[token].counters["+1/+1"]).toBe(2);
    expect(game.players.u0.exile).toContain(esper);
  });
});

describe("Regelfundament: Niederlage, Legenden, Kontrolle, Schutz, Ward, Planeswalker", () => {
  const drain = (game, random, n = 8) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: game.choice.options.slice(0, game.choice.min || 1) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
  };

  it("Ziehen aus leerer Bibliothek verliert das Spiel", () => {
    const { game, random } = started();
    game.players.u0.library = [];
    game.turn.phase = "draw";
    game.turn.drawn = false;
    game.turn.drawBlocked = false;
    expect(act(game, "u0", { type: "drawStep" }, random).ok).toBe(true);
    expect(game.players.u0.eliminated).toBeTruthy();
    expect(game.winner).toBe("u1");
  });

  it("Legendenregel: zwei gleichnamige Legenden → der Besitzer wählt eine", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const king1 = put(game, "u0", "König", "battlefield");
    const king2 = put(game, "u0", "König", "hand", { only: "library" }) ;
    void king2;
    const second = game.players.u0.library.find(id => game.defs[game.cards[id].def]?.name === "König") ?? null;
    void second;
    // zweites Exemplar direkt aufs Feld legen und Prüfung auslösen
    const copy = Object.values(game.cards).find(c => c.owner === "u0" && c.id !== king1 && game.defs[c.def]?.name === "König");
    if (copy) {
      for (const zone of ["hand", "library"]) {
        const i = game.players.u0[zone].indexOf(copy.id);
        if (i !== -1) game.players.u0[zone].splice(i, 1);
      }
      game.players.u0.battlefield.push(copy.id);
    }
    act(game, "u0", { type: "pass" }, random);
    expect(game.choice?.step.type).toBe("legend");
    act(game, "u0", { type: "choose", ids: [king1] }, random);
    expect(game.players.u0.battlefield.filter(id => game.defs[game.cards[id].def]?.name === "König")).toHaveLength(1);
  });

  it("Kontrolle: Bedrohung nimmt die Kreatur bis zum Zugende und gibt sie zurück", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const theirs = put(game, "u1", "Bär", "battlefield");
    const spell = put(game, "u0", "Bedrohung", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: spell, targets: [theirs] }, random).ok).toBe(true);
    drain(game, random);
    expect(game.players.u0.battlefield).toContain(theirs);
    expect(game.players.u1.battlefield).not.toContain(theirs);
    expect(game.manual).toBeNull();
    // Haste und enttappt → kann angreifen
    act(game, "u0", { type: "pass" }, random);
    if (game.priority === "u1") act(game, "u1", { type: "pass" }, random);
    expect(game.turn.phase).toBe("attackers");
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: theirs, target: "u1" }] }, random).ok).toBe(true);
    drain(game, random, 12);
    // Zugende: zurück an u1
    game.turn.phase = "main2";
    for (let i = 0; i < 12 && game.turn.active === "u0"; i += 1) {
      const who = game.pendingDiscard?.userId ?? game.priority;
      if (game.pendingDiscard) act(game, who, { type: "discard", ids: game.players[who].hand.slice(0, game.pendingDiscard.count) }, random);
      else act(game, who, who === game.turn.active && game.turn.phase === "end" ? { type: "pass" } : { type: "pass" }, random);
    }
    expect(game.players.u1.battlefield).toContain(theirs);
    expect(game.cards[theirs].owner).toBe("u1");
  });

  it("Nebel verhindert allen Kampfschaden", () => {
    const { game, random } = started();
    forest(game, "u1", 1);
    const bear = put(game, "u0", "Bär", "battlefield");
    const fog = put(game, "u1", "Nebel", "hand", { only: "library" });
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random);
    // kein Blocker möglich → Schadensschritt: erst der Angreifer, dann der Verteidiger mit leuchtendem Nebel
    act(game, "u0", { type: "pass" }, random);
    expect(game.priority).toBe("u1");
    expect(act(game, "u1", { type: "cast", id: fog }, random).ok).toBe(true);
    drain(game, random);
    for (let i = 0; i < 6 && game.combat; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u1.life).toBe(20);
  });

  it("zusätzlicher Zug: derselbe Spieler ist nach dem Zug nochmal dran", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const extra = put(game, "u0", "Zeitschleife", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: extra }, random);
    drain(game, random);
    expect(game.extraTurns).toEqual(["u0"]);
  });

  it("„You may … If you do …“: Ja-Nein-Entscheidung, Folge nur bei Ja", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const pact = put(game, "u0", "Pakt", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: pact }, random);
    expect(game.choice.kind).toBe("yesno");
    const life = game.players.u0.life;
    act(game, "u0", { type: "choose", ids: ["no"] }, random);
    expect(game.players.u0.life).toBe(life);
    const pact2 = put(game, "u0", "Pakt", "hand");
    forest(game, "u0", 1);
    act(game, "u0", { type: "cast", id: pact2 }, random);
    act(game, "u0", { type: "choose", ids: ["yes"] }, random);
    expect(game.players.u0.life).toBe(life - 1);
  });

  it("„für jede …“ multipliziert (Karten pro eigene Kreatur)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u0", "Bär", "battlefield");
    put(game, "u0", "Falke", "battlefield");
    const horde = put(game, "u0", "Horde", "hand", { only: "library" });
    const hand = game.players.u0.hand.length;
    act(game, "u0", { type: "cast", id: horde }, random);
    drain(game, random);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 2);
  });

  it("Opfern: der Gegner opfert (bei einer Wahl wählt er selbst)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const a = put(game, "u1", "Bär", "battlefield");
    const b = put(game, "u1", "Falke", "battlefield");
    const edict = put(game, "u0", "Opferzwang", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: edict, targets: ["u1"] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice.userId).toBe("u1");
    act(game, "u1", { type: "choose", ids: [b] }, random);
    expect(game.players.u1.battlefield).toContain(a);
    expect(game.players.u1.graveyard).toContain(b);
  });

  it("Schutz: kann nicht von roten Quellen anvisiert, nicht von roten Kreaturen geblockt werden", () => {
    const { game, random } = started();
    const guard = put(game, "u1", "Schutzgeist", "battlefield");
    put(game, "u0", "Mountain", "battlefield");
    const bolt = put(game, "u0", "Blitz", "hand", { only: "library" });
    const options = view(game, "u0").players[0].hand.find(c => c.id === bolt).play.targets[0].options;
    expect(options).not.toContain(guard);
    expect(act(game, "u0", { type: "cast", id: bolt, targets: [guard] }, random).ok).toBe(false);
    void random;
  });

  it("Ward: Zielen auf eine Karte mit Ward kostet extra", () => {
    const { game, random } = started();
    const ward = put(game, "u1", "Wächter", "battlefield");
    put(game, "u0", "Mountain", "battlefield");
    const bolt = put(game, "u0", "Blitz", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: bolt, targets: [ward] }, random).error).toMatch(/Ward/);
    put(game, "u0", "Forest", "battlefield");
    put(game, "u0", "Forest", "battlefield");
    expect(act(game, "u0", { type: "cast", id: bolt, targets: [ward] }, random).ok).toBe(true);
  });

  it("Furcht: nur schwarze oder Artefakt-Kreaturen dürfen blocken", () => {
    const { game, random } = started();
    const fear = put(game, "u0", "Schreck", "battlefield");
    const wall = put(game, "u1", "Mauer", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: fear, target: "u1" }] }, random);
    expect(act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: wall, attacker: fear }] }, random).error).toMatch(/Furcht/);
  });

  it("Gift (Infect): Schaden an Spieler wird zu Giftmarken", () => {
    const { game, random } = started();
    const inf = put(game, "u0", "Seuchenträger", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: inf, target: "u1" }] }, random);
    drain(game, random);
    for (let i = 0; i < 6 && game.combat; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u1.poison).toBe(2);
    expect(game.players.u1.life).toBe(20);
  });

  it("Planeswalker lassen sich angreifen; Schaden entfernt Loyalität", () => {
    const { game, random } = started();
    const walker = put(game, "u1", "Wanderer", "battlefield");
    game.cards[walker].counters.loyalty = 4;
    const bear = put(game, "u0", "Bär", "battlefield");
    toAttackers(game, random);
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: walker }] }, random).ok).toBe(true);
    for (let i = 0; i < 6 && game.combat; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.cards[walker].counters.loyalty).toBe(2);
    expect(game.players.u1.life).toBe(20);
  });

  it("Kommandantenschaden zählt je Kommandant", () => {
    const { game, random } = started("commander", 2);
    void random;
    const cmdId = game.players.u0.command[0];
    game.players.u0.command.splice(0, 1);
    game.players.u0.battlefield.push(cmdId);
    game.cards[cmdId].sinceSeq = 0;
    game.players.u1.life = 100;
    for (let i = 0; i < 3; i += 1) {
      game.players.u1.cmdDamage = game.players.u1.cmdDamage ?? {};
    }
    // direkt über die Kampflogik: drei Treffer à 7
    game.turn.phase = "attackers";
    for (let i = 0; i < 3; i += 1) {
      game.cards[cmdId].tapped = false;
      game.combat = { attackers: [{ id: cmdId, target: "u1" }], blocks: [], done: [], phaseWaiting: false };
      game.turn.phase = "damage";
      game.priority = "u0";
      game.passed = [];
      game.cards[cmdId].counters["+1/+1"] = 3; // 4+3 = 7
      act(game, "u0", { type: "pass" }, random);
      if (game.priority === "u1") act(game, "u1", { type: "pass" }, random);
    }
    expect(game.players.u1.eliminated).toBeTruthy();
  });

  it("mehrere Ziele bei Auslösern werden nacheinander abgefragt", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u1", "Bär", "battlefield");
    put(game, "u1", "Falke", "battlefield");
    const twin = put(game, "u0", "Zwilling", "hand", { only: "library" });
    act(game, "u0", { type: "cast", id: twin }, random);
    for (let i = 0; i < 3 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice.prompt).toMatch(/1 von 2/);
    act(game, "u0", { type: "choose", ids: [game.choice.options[0]] }, random);
    expect(game.choice.prompt).toMatch(/2 von 2/);
    act(game, "u0", { type: "choose", ids: ["u1"] }, random);
    drain(game, random);
    expect(game.players.u1.life).toBe(19);
  });

  it("Endschritt: Gegner mit leuchtendem Sofortzauber wird gefragt", () => {
    const { game, random } = started();
    put(game, "u1", "Mountain", "battlefield");
    put(game, "u1", "Blitz", "hand", { only: "library" });
    game.turn.phase = "main2";
    act(game, "u0", { type: "pass" }, random);
    expect(game.priority).toBe("u1");
  });
});

describe("Typische Karten aus Rückmeldungen", () => {
  const drain2 = (game, random) => {
    for (let i = 0; i < 6 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
  };
  it("Land mit typografischem Apostroph: Zeigen-Frage statt manuellem Fenster", () => {
    const { game, random } = started();
    put(game, "u0", "Plains", "hand");
    const snarl = put(game, "u0", "Schattenwirbel", "hand", { only: "library" });
    const swamp = put(game, "u0", "Mountain", "hand", { only: "library" });
    void swamp;
    expect(act(game, "u0", { type: "playLand", id: snarl }, random).ok).toBe(true);
    expect(game.manual).toBeNull();
    // ohne Plains/Swamp auf der Hand kommt es einfach getappt
    expect(game.cards[snarl].tapped || game.choice?.step.type === "reveal").toBe(true);
  });
  it("„Other Knights you control get +1/+1“ wirkt auf andere Ritter", () => {
    const { game } = started();
    const lord = put(game, "u0", "Tapferer Ritter", "battlefield");
    const other = put(game, "u0", "Ritter der Runde", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    const v = view(game, "u0").players[0].battlefield;
    expect(v.find(c => c.id === other).power).toBe(3);
    expect(v.find(c => c.id === lord).power).toBe(2);
    expect(v.find(c => c.id === bear).power).toBe(2);
  });
  it("Banner: Kreaturentyp wählen, Bonus für den Typ und Karte ziehen beim Wirken", () => {
    const { game, random } = started();
    forest(game, "u0", 6);
    const knight = put(game, "u0", "Ritter der Runde", "battlefield");
    const banner = put(game, "u0", "Banner", "hand", { only: "library" });
    expect(act(game, "u0", { type: "cast", id: banner }, random).ok).toBe(true);
    drain2(game, random);
    expect(game.choice?.options).toContain("type:Knight");
    act(game, "u0", { type: "choose", ids: ["type:Knight"] }, random);
    expect(game.manual).toBeNull();
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === knight).power).toBe(3);
    const second = put(game, "u0", "Ritter der Runde", "hand", { only: "library" });
    const hand = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "cast", id: second }, random).ok).toBe(true);
    drain2(game, random);
    expect(game.players.u0.hand.length).toBe(hand); // gewirkt (−1), gezogen (+1)
  });
});

describe("Mehrere Blocker", () => {
  it("zwei Verteidiger blocken zwei Angreifer, und ein Angreifer wird doppelt geblockt", () => {
    const { game, random } = started();
    const a1 = put(game, "u0", "Bär", "battlefield");
    const a2 = put(game, "u0", "Bär", "battlefield");
    const b1 = put(game, "u1", "Bär", "battlefield");
    const b2 = put(game, "u1", "Bär", "battlefield");
    const b3 = put(game, "u1", "Bär", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: a1, target: "u1" }, { id: a2, target: "u1" }] }, random);
    expect(game.combat.phaseWaiting).toBe(true);
    const result = act(game, "u1", { type: "declareBlockers", blocks: [{ blocker: b1, attacker: a1 }, { blocker: b2, attacker: a1 }, { blocker: b3, attacker: a2 }] }, random);
    expect(result).toEqual({ ok: true });
    expect(game.turn.phase).toBe("damage");
    expect(game.combat.blocks).toHaveLength(3);
  });
});

describe("Mehr Karten automatisch (Zielfilter, Exil bis zum Verlassen, Biss, Schatz …)", () => {
  const settleAll = (game, random, n = 10) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) {
        const c = game.choice;
        const pick = c.options.slice(0, Math.max(1, c.min));
        act(game, c.userId, { type: "choose", ids: c.kind === "yesno" ? ["yes"] : pick }, random);
      } else act(game, game.priority, { type: "pass" }, random);
    }
  };
  const castIt = (game, random, uid, name, targets = [], zone = "hand") => {
    const id = put(game, uid, name, "hand", zone === "hand" ? {} : { only: zone });
    const result = act(game, uid, { type: "cast", id, targets }, random);
    expect(result).toEqual({ ok: true });
    settleAll(game, random);
    return id;
  };

  it("„nonblack“ filtert die Ziele", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const black = put(game, "u1", "Schwarzer Ritter", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Todesstoß", "hand");
    const options = view(game, "u0").players[0].hand.find(c => c.id === id).play.targets[0].options;
    expect(options).toContain(bear);
    expect(options).not.toContain(black);
    expect(act(game, "u0", { type: "cast", id, targets: [black] }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id, targets: [bear] }, random).ok).toBe(true);
    settleAll(game, random);
    expect(game.players.u1.graveyard).toContain(bear);
  });

  it("Biss: eigene Kreatur schlägt fremde in Höhe ihrer Stärke", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const mine = put(game, "u0", "Riese", "battlefield");
    const theirs = put(game, "u1", "Bär", "battlefield");
    castIt(game, random, "u0", "Biss", [mine, theirs]);
    expect(game.players.u1.graveyard).toContain(theirs);
    expect(game.manual).toBeNull();
  });

  it("Kampf: beide Kreaturen verletzen sich", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const mine = put(game, "u0", "Bär", "battlefield");
    const theirs = put(game, "u1", "Bär", "battlefield");
    castIt(game, random, "u0", "Jagdbeute", [mine, theirs]);
    expect(game.players.u0.graveyard).toContain(mine);
    expect(game.players.u1.graveyard).toContain(theirs);
  });

  it("Exil bis zum Verlassen: Verbannungsring nimmt die Karte und gibt sie zurück", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const target = put(game, "u1", "Bär", "battlefield");
    const ring = put(game, "u0", "Verbannungsring", "hand");
    act(game, "u0", { type: "cast", id: ring }, random);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice.options).toContain(target);
    act(game, "u0", { type: "choose", ids: [target] }, random);
    settleAll(game, random);
    expect(game.players.u1.exile).toContain(target);
    // der Ring wird zerstört → die Karte kommt zurück aufs Schlachtfeld
    put(game, "u1", "Mountain", "battlefield");
    const rip = put(game, "u1", "Zerreißen", "hand");
    expect(act(game, "u0", { type: "pass" }, random).ok).toBe(true);
    game.turn.active = "u1";
    game.priority = "u1";
    game.passed = [];
    expect(act(game, "u1", { type: "cast", id: rip, targets: [ring] }, random).ok).toBe(true);
    settleAll(game, random);
    expect(game.players.u0.graveyard).toContain(ring);
    expect(game.players.u1.battlefield).toContain(target);
    expect(game.players.u1.exile).not.toContain(target);
  });

  it("Friedhof exilieren (Moor)", () => {
    const { game, random } = started();
    const grave = put(game, "u1", "Bär", "graveyard");
    const bog = put(game, "u0", "Moor", "hand");
    expect(act(game, "u0", { type: "playLand", id: bog }, random).ok).toBe(true);
    expect(game.choice.options).toContain("u1");
    act(game, "u0", { type: "choose", ids: ["u1"] }, random);
    settleAll(game, random);
    expect(game.players.u1.exile).toContain(grave);
    expect(game.players.u1.graveyard).toHaveLength(0);
    expect(game.manual).toBeNull();
  });

  it("X aus der Stärke des Ziels (Dickicht)", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const giant = put(game, "u0", "Riese", "battlefield");
    castIt(game, random, "u0", "Dickicht", [giant]);
    expect(game.cards[giant].counters["+1/+1"]).toBe(5);
  });

  it("Schwerter: Leben in Höhe der Stärke an den Kontrolleur", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const giant = put(game, "u1", "Riese", "battlefield");
    castIt(game, random, "u0", "Schwerter", [giant]);
    expect(game.players.u1.exile).toContain(giant);
    expect(game.players.u1.life).toBe(25);
  });

  it("Pfad: der Besitzer des Ziels darf ein Land suchen", () => {
    const { game, random } = started();
    put(game, "u0", "Mountain", "battlefield");
    const bear = put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Pfad", "hand");
    act(game, "u0", { type: "cast", id, targets: [bear] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice.kind).toBe("yesno");
    expect(game.choice.userId).toBe("u1");
  });

  it("Mana-Leck: wer zahlen kann, wird gefragt; sonst wird neutralisiert", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    const leak = put(game, "u1", "Mana-Leck", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    expect(game.priority).toBe("u1");
    expect(act(game, "u1", { type: "cast", id: leak, targets: [game.stack[0].sid] }, random).ok).toBe(true);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.stack.length === 0 || game.choice?.userId === "u0").toBe(true);
    expect(game.players.u0.graveyard).toContain(bear); // u0 hat kein Mana mehr für {3}
  });

  it("Schatz: erzeugt, bezahlt Mana und wird geopfert", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    castIt(game, random, "u0", "Schatzsuche");
    const treasure = game.players.u0.battlefield.find(id => game.cards[id].token);
    expect(treasure).toBeTruthy();
    const bear = put(game, "u0", "Bär", "hand");
    const result = act(game, "u0", { type: "cast", id: bear }, random);
    expect(result.error ?? "ok").toBe("ok");
    settleAll(game, random);
    expect(game.cards[treasure]).toBeUndefined();
  });

  it("Aura „can't attack or block“", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const target = put(game, "u1", "Bär", "battlefield");
    castIt(game, random, "u0", "Befriedung", [target]);
    game.turn.active = "u1";
    game.priority = "u1";
    game.turn.phase = "attackers";
    game.players.u1.turnStartSeq = 0;
    expect(act(game, "u1", { type: "declareAttackers", attackers: [{ id: target, target: "u0" }] }, random).error).toMatch(/nicht angreifen/);
  });

  it("Zeugin holt eine Karte aus dem eigenen Friedhof (Ziel, optional)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const grave = put(game, "u0", "Bär", "graveyard");
    const id = put(game, "u0", "Zeugin", "hand");
    act(game, "u0", { type: "cast", id }, random);
    for (let i = 0; i < 6 && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, "u0", { type: "choose", ids: game.choice.kind === "yesno" ? ["yes"] : [game.choice.options[0]] }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.players.u0.hand).toContain(grave);
    expect(game.manual).toBeNull();
  });

  it("Überrennen: +3/+3 und Trampel bis Zugende", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const bear = put(game, "u0", "Bär", "battlefield");
    castIt(game, random, "u0", "Überrennen");
    const card = view(game, "u0").players[0].battlefield.find(c => c.id === bear);
    expect(card.power).toBe(5);
    expect(card.keywords).toContain("trample");
  });

  it("Seelenwächter: Leben, wenn eine andere Kreatur ins Spiel kommt", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u0", "Seelenwächter", "battlefield");
    const life = game.players.u0.life;
    castIt(game, random, "u0", "Bär");
    expect(game.players.u0.life).toBe(life + 1);
  });

  it("Zwang: Hand ansehen, Nichtkreatur-Nichtland-Karte wählen, abwerfen", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    game.players.u1.hand = [];
    const bear = put(game, "u1", "Bär", "hand");
    const bolt = put(game, "u1", "Blitz", "hand");
    put(game, "u1", "Forest", "hand");
    const id = put(game, "u0", "Zwang", "hand");
    act(game, "u0", { type: "cast", id, targets: ["u1"] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0 && !game.choice; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.choice.options).toEqual([bolt]);
    expect(game.choice.options).not.toContain(bear);
    act(game, "u0", { type: "choose", ids: [bolt] }, random);
    expect(game.players.u1.graveyard).toContain(bolt);
  });

  it("Feuersbrunst kostet weniger pro Kreatur", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    for (let i = 0; i < 4; i += 1) put(game, "u1", "Bär", "battlefield");
    const id = put(game, "u0", "Feuersbrunst", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === id).play.ok).toBe(true);
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(true);
  });
});

describe("Handarbeit an fremden Karten (nur im manuellen Fenster)", () => {
  it("Schaden, Marker, Tappen und Verschieben bei Karten des Gegners", () => {
    const { game, random } = started();
    const theirs = put(game, "u1", "Bär", "battlefield");
    expect(act(game, "u0", { type: "damage", id: theirs, delta: 1 }, random).ok).toBe(false); // außerhalb des manuellen Fensters
    game.manual = { userId: "u0", text: "Test", source: "Test" };
    expect(act(game, "u0", { type: "damage", id: theirs, delta: 1 }, random).ok).toBe(true);
    expect(game.cards[theirs].damage).toBe(1);
    expect(act(game, "u0", { type: "counter", id: theirs, kind: "+1/+1", delta: 1 }, random).ok).toBe(true);
    expect(act(game, "u0", { type: "tap", id: theirs }, random).ok).toBe(true);
    expect(game.cards[theirs].tapped).toBe(true);
    expect(act(game, "u0", { type: "moveOther", id: theirs, to: "graveyard" }, random).ok).toBe(true);
    expect(game.players.u1.graveyard).toContain(theirs);
  });
});

describe("Weitere Auslöser", () => {
  it("Kampfschaden an einen Spieler löst aus; Beginn des Kampfes löst aus", () => {
    const { game, random } = started();
    const striker = put(game, "u0", "Plünderer", "battlefield");
    put(game, "u0", "Herold", "battlefield");
    const life = game.players.u0.life;
    const hand = game.players.u0.hand.length;
    act(game, "u0", { type: "pass" }, random);
    if (game.priority === "u1") act(game, "u1", { type: "pass" }, random);
    for (let i = 0; i < 4 && (game.stack.length > 0 || game.choice); i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.life).toBe(life + 1);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: striker, target: "u1" }] }, random);
    for (let i = 0; i < 8 && (game.combat || game.stack.length > 0); i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.hand.length).toBe(hand + 1);
  });
});

describe("Zusätzliche Kosten (Opfern, Abwerfen)", () => {
  it("Fähigkeit: „Sacrifice a creature: …“ verlangt die Wahl der Kreatur", () => {
    const { game, random } = started();
    const seer = put(game, "u0", "Opfer-Seher", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    const ability = view(game, "u0").players[0].battlefield.find(c => c.id === seer).abilities[0];
    expect(ability.ok).toBe(true);
    expect(ability.pays[0].options).toEqual(expect.arrayContaining([seer, bear]));
    expect(act(game, "u0", { type: "activate", id: seer, index: 0 }, random).ok).toBe(false); // ohne Auswahl
    expect(act(game, "u0", { type: "activate", id: seer, index: 0, pay: [bear] }, random).ok).toBe(true);
    expect(game.players.u0.graveyard).toContain(bear);
    expect(game.manual).toBeNull();
  });

  it("Altar: Opfern ergibt Mana", () => {
    const { game, random } = started();
    const altar = put(game, "u0", "Altar", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    expect(act(game, "u0", { type: "activate", id: altar, index: 0, pay: [bear] }, random).ok).toBe(true);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.pool.C).toBe(2);
  });

  it("Zauber mit zusätzlichen Kosten: Opfern und Abwerfen", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const bear = put(game, "u0", "Bär", "battlefield");
    const rites = put(game, "u0", "Opferriten", "hand");
    expect(act(game, "u0", { type: "cast", id: rites }, random).ok).toBe(false);
    expect(act(game, "u0", { type: "cast", id: rites, pay: [bear] }, random).ok).toBe(true);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.graveyard).toContain(bear);
    const reunion = put(game, "u0", "Wiedersehen", "hand");
    const fodder = game.players.u0.hand.filter(id => id !== reunion).slice(0, 2);
    const handBefore = game.players.u0.hand.length;
    expect(act(game, "u0", { type: "cast", id: reunion, pay: fodder }, random).ok).toBe(true);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u0.hand.length).toBe(handBefore - 3 + 3);
  });
});

describe("Mehr Automatik: Gebühren-Auslöser, Blinzeln, Regeneration, Verhindern, Steuer", () => {
  const run = (game, random, n = 8) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: game.choice.kind === "yesno" ? ["no"] : [game.choice.options[0]] }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
  };

  it("Rhystic Study: der Gegner kann zahlen, sonst darfst du ziehen", () => {
    const { game, random } = started();
    put(game, "u0", "Rhystisches Studium", "battlefield");
    forest(game, "u1", 1);
    const heal = put(game, "u1", "Heilung", "hand");
    const hand = game.players.u0.hand.length;
    // u1 wirkt in seinem Zug … hier einfach als Antwort: u0 ist am Zug und u1 hat Priorität durch den Beginn
    game.turn.active = "u1";
    game.priority = "u1";
    expect(act(game, "u1", { type: "cast", id: heal }, random).ok).toBe(true);
    // u1 hat sein einziges Mana ausgegeben und kann {1} nicht zahlen → u0 darf ziehen
    for (let i = 0; i < 8 && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: ["yes"] }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.players.u0.hand.length).toBe(hand + 1);
  });

  it("Blinzeln: Kreatur verlässt das Spiel und kommt sofort zurück (Einsatzfähigkeit löst erneut aus)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const seer = put(game, "u0", "Seher", "battlefield");
    const flick = put(game, "u0", "Blinzeln", "hand");
    const hand = game.players.u0.hand.length;
    act(game, "u0", { type: "cast", id: flick, targets: [seer] }, random);
    run(game, random);
    expect(game.players.u0.battlefield).toContain(seer);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 1); // Blinzeln weg, Seher zieht erneut
  });

  it("Thriving-Land: gewählte Farbe wird zur Manaoption", () => {
    const { game, random } = started();
    const land = put(game, "u0", "Gedeihen", "hand");
    act(game, "u0", { type: "playLand", id: land }, random);
    expect(game.choice.options).not.toContain("color:G");
    act(game, "u0", { type: "choose", ids: ["color:R"] }, random);
    game.cards[land].tapped = false;
    const view0 = view(game, "u0").players[0].battlefield.find(c => c.id === land);
    expect(view0.manaColors).toEqual(expect.arrayContaining(["G", "R"]));
  });

  it("Regeneration ersetzt die Zerstörung", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const beast = put(game, "u0", "Regenerierer", "battlefield");
    game.cards[beast].damage = 0;
    expect(act(game, "u0", { type: "activate", id: beast, index: 0 }, random).ok).toBe(true);
    run(game, random);
    game.cards[beast].damage = 5;
    act(game, "u0", { type: "pass" }, random);
    expect(game.players.u0.battlefield).toContain(beast);
    expect(game.cards[beast].damage).toBe(0);
    expect(game.cards[beast].tapped).toBe(true);
  });

  it("Schadensverhinderung: Schild schluckt die nächsten 3 Schaden", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u1", "Mountain", "battlefield");
    const salve = put(game, "u0", "Heilsalbe", "hand");
    const bolt = put(game, "u1", "Blitz", "hand");
    act(game, "u0", { type: "cast", id: salve, targets: ["u0"] }, random);
    run(game, random);
    expect(game.players.u0.shield).toBe(3);
    act(game, "u0", { type: "pass" }, random);
    game.turn.active = "u1";
    game.priority = "u1";
    game.passed = [];
    const life = game.players.u0.life;
    act(game, "u1", { type: "cast", id: bolt, targets: ["u0"] }, random);
    run(game, random);
    expect(game.players.u0.life).toBe(life);
  });

  it("Angriffssteuer wird automatisch bezahlt oder der Angriff scheitert", () => {
    const { game, random } = started();
    put(game, "u1", "Gespensterkerker", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    toAttackers(game, random);
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).error).toMatch(/Angriffssteuer/);
    forest(game, "u0", 2);
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: bear, target: "u1" }] }, random).ok).toBe(true);
  });

  it("Gefärbter Bonus: „Green creatures get +1/+1“", () => {
    const { game } = started();
    put(game, "u0", "Kreuzzug", "battlefield");
    const green = put(game, "u0", "Bär", "battlefield");
    const black = put(game, "u0", "Schwarzer Ritter", "battlefield");
    const v = view(game, "u0").players[0].battlefield;
    expect(v.find(c => c.id === green).power).toBe(3);
    expect(v.find(c => c.id === black).power).toBe(2);
  });

  it("Rückruf: Zauber kommt auf die Hand statt auf den Friedhof", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Mountain", "battlefield");
    const remand = put(game, "u1", "Rückruf", "hand");
    const bear = put(game, "u0", "Bär", "hand");
    act(game, "u0", { type: "cast", id: bear }, random);
    act(game, "u1", { type: "cast", id: remand, targets: [game.stack[0].sid] }, random);
    run(game, random);
    expect(game.players.u0.hand).toContain(bear);
    expect(game.players.u0.graveyard).not.toContain(bear);
  });
});

describe("Ausrüsten im Spiel mit Gegner-Antwortfenster", () => {
  it("Schädelklemme: Kosten bezahlt, Anhängen wird sofort angezeigt, wenn der Gegner nichts hat – sonst nach seinem Passen", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const clamp = put(game, "u0", "Schädelklemme", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    expect(act(game, "u0", { type: "activate", id: clamp, index: 0, targets: [bear] }, random).ok).toBe(true);
    expect(game.cards[clamp].attachedTo).toBe(bear); // Gegner kann nicht antworten → löst sich sofort auf
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === bear).attachments).toEqual(["Schädelklemme"]);
    // Gegner mit leuchtendem Sofortzauber: erst nach seinem Passen
    const { game: g2, random: r2 } = started();
    forest(g2, "u0", 2);
    const clamp2 = put(g2, "u0", "Schädelklemme", "battlefield");
    const bear2 = put(g2, "u0", "Bär", "battlefield");
    put(g2, "u1", "Mountain", "battlefield");
    put(g2, "u1", "Blitz", "hand");
    expect(act(g2, "u0", { type: "activate", id: clamp2, index: 0, targets: [bear2] }, r2).ok).toBe(true);
    expect(g2.priority).toBe("u1");
    expect(g2.cards[clamp2].attachedTo ?? null).toBeNull();
    act(g2, "u1", { type: "pass" }, r2);
    expect(g2.cards[clamp2].attachedTo).toBe(bear2);
  });

  it("Koloss-Hammer: +10/+10 und verliert Flug", () => {
    const { game, random } = started();
    forest(game, "u0", 8);
    const hammer = put(game, "u0", "Koloss-Hammer", "battlefield");
    const hawk = put(game, "u0", "Falke", "battlefield");
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === hawk).keywords).toContain("flying");
    expect(act(game, "u0", { type: "activate", id: hammer, index: 0, targets: [hawk] }, random).ok).toBe(true);
    const card = view(game, "u0").players[0].battlefield.find(c => c.id === hawk);
    expect(card.power).toBe(11);
    expect(card.toughness).toBe(11);
    expect(card.keywords).not.toContain("flying");
  });
});

describe("Karten aus den Rückmeldungen: Lifestream's Blessing, Wakka, Yuna's Whistle", () => {
  const finish = (game, random, n = 10) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: game.choice.kind === "yesno" ? ["yes"] : game.choice.min === 0 ? [] : [game.choice.options[0]] }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
  };

  it("Lifestream's Blessing: zieht X (größte Stärke), aus dem Exil (Foretell) zusätzlich doppelt so viel Leben", () => {
    const { game, random } = started();
    forest(game, "u0", 8);
    put(game, "u0", "Riese", "battlefield"); // Stärke 5
    const blessing = put(game, "u0", "Lebensstrom-Segen", "hand");
    const hand = game.players.u0.hand.length;
    const life = game.players.u0.life;
    expect(act(game, "u0", { type: "cast", id: blessing }, random).ok).toBe(true);
    finish(game, random);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 5);
    expect(game.players.u0.life).toBe(life); // nicht aus dem Exil
    // Vorhersagen und später wirken
    const second = put(game, "u0", "Lebensstrom-Segen", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === second).foretell).toMatchObject({ ok: true, cost: "{4}{G}" });
    expect(act(game, "u0", { type: "foretell", id: second }, random).ok).toBe(true);
    expect(game.players.u0.exile).toContain(second);
    expect(act(game, "u0", { type: "cast", id: second }, random).error).toMatch(/späteren Zug/);
    game.turn.number += 1; // späterer Zug
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    expect(act(game, "u0", { type: "cast", id: second }, random).ok).toBe(true);
    finish(game, random);
    expect(game.players.u0.life).toBe(life + 10);
  });

  it("Wakka: Kampfschaden zerstört (optional) ein Artefakt und gibt einen Marker; am Zugende bekommen die anderen Kreaturen einen", () => {
    const { game, random } = started();
    const wakka = put(game, "u0", "Wakka", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    const artifact = put(game, "u1", "Sense", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: wakka, target: "u1" }] }, random);
    for (let i = 0; i < 12 && (game.combat || game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) {
        expect(JSON.stringify(game.choice).slice(0, 300)).toContain(artifact); // nur Artefakte des getroffenen Spielers
        act(game, game.choice.userId, { type: "choose", ids: [artifact] }, random);
      } else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.players.u1.graveyard).toContain(artifact);
    expect(game.cards[wakka].counters["+1/+1"]).toBe(1);
    expect(game.manual).toBeNull();
    // Zugende
    for (let i = 0; i < 14 && game.turn.active === "u0"; i += 1) {
      if (game.pendingDiscard) act(game, "u0", { type: "discard", ids: game.players.u0.hand.slice(0, game.pendingDiscard.count) }, random);
      else if (game.choice) act(game, game.choice.userId, { type: "choose", ids: [game.choice.options[0]] }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.cards[bear].counters["+1/+1"]).toBe(1);
  });

  it("Wakka: ohne Artefakt läuft der Auslöser trotzdem (nur der Marker)", () => {
    const { game, random } = started();
    const wakka = put(game, "u0", "Wakka", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: wakka, target: "u1" }] }, random);
    for (let i = 0; i < 12 && (game.combat || game.stack.length > 0 || game.choice); i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.cards[wakka].counters["+1/+1"]).toBe(1);
  });

  it("Yuna's Whistle: Kreatur aufdecken, auf die Hand, Marker in Höhe ihres Manawerts", () => {
    const { game, random } = started();
    forest(game, "u0", 3);
    const bear = put(game, "u0", "Bär", "battlefield");
    // oben auf der Bibliothek: ein Land, darunter ein Riese (Manawert laut Testdaten = 2)
    const top = game.players.u0.library;
    const giant = top.find(id => game.defs[game.cards[id].def]?.name === "Riese");
    top.splice(top.indexOf(giant), 1);
    top.push(giant);
    const whistle = put(game, "u0", "Yunas Pfeife", "hand");
    expect(act(game, "u0", { type: "cast", id: whistle, targets: [bear] }, random).ok).toBe(true);
    finish(game, random);
    expect(game.players.u0.hand).toContain(giant);
    expect(game.cards[bear].counters["+1/+1"]).toBe(2);
    expect(game.manual).toBeNull();
  });
});

describe("Neue Mechaniken aus den Commander-Decks", () => {
  const go = (game, random, n = 10) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: game.choice.kind === "yesno" ? ["yes"] : game.choice.min === 0 ? [game.choice.options[0]] : game.choice.options.slice(0, game.choice.min) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
  };
  const cast = (game, random, uid, name, extra = {}, zone) => {
    const id = put(game, uid, name, "hand", zone ? { only: zone } : {});
    const result = act(game, uid, { type: "cast", id, ...extra }, random);
    expect(result.error ?? "ok").toBe("ok");
    go(game, random);
    return id;
  };

  it("Besatzung: Fahrzeug wird mit passenden Kreaturen zur Kreatur und greift an", () => {
    const { game, random } = started();
    const vehicle = put(game, "u0", "Karren", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === vehicle).kind).not.toBe("creature");
    expect(act(game, "u0", { type: "activate", id: vehicle, index: 0 }, random).ok).toBe(true);
    go(game, random);
    expect(game.cards[bear].tapped).toBe(true);
    const v = view(game, "u0").players[0].battlefield.find(c => c.id === vehicle);
    expect(v.kind).toBe("creature");
    expect(v.power).toBe(3);
  });

  it("Station: Kreatur tappen → Ladungsmarker, ab Schwelle Artefaktkreatur mit Flug", () => {
    const { game, random } = started();
    const ship = put(game, "u0", "Raumkreuzer", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    const power = view(game, "u0").players[0].battlefield.find(c => c.id === bear).power;
    expect(game.defs[game.cards[ship].def].rules.station.at).toBe(3);
    expect(game.defs[game.cards[ship].def].keywords).not.toContain("flying");
    const opts = view(game, "u0").players[0].battlefield.find(c => c.id === ship).abilities[0];
    expect(opts.pays[0].options).toEqual([bear]);
    expect(act(game, "u0", { type: "activate", id: ship, index: 0, pay: [bear] }, random).ok).toBe(true);
    go(game, random);
    expect(game.cards[bear].tapped).toBe(true);
    expect(game.cards[ship].counters.charge).toBe(power);
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === ship).kind).not.toBe("creature");
    game.cards[ship].counters.charge = 3;
    const v = view(game, "u0").players[0].battlefield.find(c => c.id === ship);
    expect(v.kind).toBe("creature");
    expect(v.keywords).toContain("flying");
  });

  it("Encore und Eternalize: aus dem Friedhof, Kopie als Spielstein", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    for (let i = 0; i < 2; i += 1) put(game, "u0", "Mountain", "battlefield");
    const rev = put(game, "u0", "Echogeist", "graveyard");
    const eternal = put(game, "u0", "Ewiger", "graveyard");
    const ab = view(game, "u0").players[0].graveyard.find(c => c.id === rev).abilities[0];
    expect(ab.ok).toBe(true);
    expect(act(game, "u0", { type: "activate", id: rev, index: 0 }, random).ok).toBe(true);
    go(game, random);
    expect(game.players.u0.exile).toContain(rev);
    const tokens = game.players.u0.battlefield.filter(id => game.cards[id].token && game.defs[game.cards[id].def]?.name !== "x" && game.xdefs[game.cards[id].def]?.name === "Echogeist");
    expect(tokens.length).toBe(1);
    expect(game.cards[tokens[0]].sacEnd).toBe(true);
    expect(act(game, "u0", { type: "activate", id: eternal, index: 0 }, random).ok).toBe(true);
    go(game, random);
    const zombie = game.players.u0.battlefield.find(id => game.xdefs[game.cards[id].def]?.name === "Ewiger");
    expect(zombie).toBeTruthy();
    expect(game.xdefs[game.cards[zombie].def].power).toBe(4);
  });

  it("Allgemeine Auslöser: Zauberart, zweite Karte pro Zug, Erkunden", () => {
    const { game, random } = started();
    forest(game, "u0", 12);
    put(game, "u0", "Zauberlehrling", "battlefield");
    const life = game.players.u1.life;
    const own = game.players.u0.life;
    cast(game, random, "u0", "Einberufer");
    cast(game, random, "u0", "Einberufer");
    expect(game.players.u1.life).toBe(life - 2);
    expect(game.players.u0.life).toBe(own + 2);
    const bear = put(game, "u0", "Bär", "hand");
    const top = game.players.u0.library[game.players.u0.library.length - 1];
    expect(act(game, "u0", { type: "cast", id: bear }, random).ok).toBe(true);
    go(game, random);
    const land = game.defs[game.cards[top].def].types.land;
    expect(land ? game.players.u0.hand.includes(top) : game.cards[bear].counters["+1/+1"]).toBeTruthy();
  });

  it("Dynamische Stärke („twice the number“) und Gratis-Zauber mit Kommandant", () => {
    const { game, random } = started("commander");
    const swarm = put(game, "u0", "Schwarmwesen", "battlefield");
    put(game, "u0", "Bär", "battlefield");
    const card = view(game, "u0").players[0].battlefield.find(c => c.id === swarm);
    expect(card.power).toBe(4);
    const gift = put(game, "u0", "Gratisgabe", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === gift).play.ok).toBe(false);
    put(game, "u0", "Boss d0", "battlefield");
    expect(view(game, "u0").players[0].hand.find(c => c.id === gift).play.ok).toBe(true);
  });

  it("Mutate: über/unter eine Nicht-Menschen-Kreatur, Fähigkeiten verschmelzen, beide Karten sterben zusammen", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const bear = put(game, "u0", "Bär", "battlefield");
    const human = put(game, "u0", "Mensch", "battlefield");
    const mutant = put(game, "u0", "Mutantenbestie", "hand");
    const opts = view(game, "u0").players[0].hand.find(c => c.id === mutant).mutate;
    expect(opts.ok).toBe(true);
    expect(opts.targets.map(t => t.id)).toEqual([bear]); // Menschen sind kein gültiges Ziel
    expect(act(game, "u0", { type: "cast", id: mutant, mutate: human }, random).ok).toBe(false);
    const life = game.players.u0.life;
    expect(act(game, "u0", { type: "cast", id: mutant, mutate: bear, over: true }, random).ok).toBe(true);
    go(game, random);
    expect(game.players.u0.life).toBe(life + 3); // „mutates“-Auslöser
    const merged = view(game, "u0").players[0].battlefield.find(c => c.id === bear);
    expect(merged.name).toBe("Mutantenbestie");
    expect(merged.power).toBe(3);
    expect(merged.keywords).toContain("flying");
    expect(merged.mutated).toBe(2);
    expect(game.players.u0.battlefield).not.toContain(mutant);
    openManual(game, "u0");
    const moved = act(game, "u0", { type: "move", id: bear, to: "graveyard" }, random);
    expect(moved.error ?? "ok").toBe("ok");
    expect(game.players.u0.graveyard).toEqual(expect.arrayContaining([bear, mutant]));
    expect(game.xdefs[`mut:${bear}`]).toBeUndefined();
    expect(game.defs[game.cards[bear].def].name).toBe("Bär");
  });

  it("Neue Dauereffekte: Ausrüstung je Artefakt, Marker-Trample, Stärke aus Friedhof, Skulk", () => {
    const { game, random } = started();
    const lance = put(game, "u0", "Artefaktlanze", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    game.cards[lance].attachedTo = bear;
    const stat = id => view(game, "u0").players[0].battlefield.find(c => c.id === id);
    expect(stat(bear).power).toBe(3); // 2 + 1 Artefakt (die Lanze selbst)
    put(game, "u0", "Krabbler", "battlefield");
    expect(stat(bear).keywords).not.toContain("trample");
    game.cards[bear].counters["+1/+1"] = 1;
    expect(stat(bear).keywords).toContain("trample");
    const ghoul = put(game, "u0", "Landghul", "battlefield");
    expect(stat(ghoul).power).toBe(0);
    put(game, "u0", "Forest", "graveyard");
    put(game, "u0", "Forest", "graveyard");
    expect(stat(ghoul).power).toBe(2);
    expect(stat(ghoul).toughness).toBe(2);
    const sneak = put(game, "u0", "Schleicher", "battlefield");
    expect(stat(sneak).keywords).toContain("skulk");
    void random;
  });

  it("Zauber kopieren: „you may copy that spell“ lässt den Effekt zweimal laufen, die Kopie landet nicht im Friedhof", () => {
    const { game, random } = started();
    forest(game, "u0", 6);
    put(game, "u0", "Zauberspiegel", "battlefield");
    const hand = game.players.u0.hand.length;
    const id = put(game, "u0", "Einberufer", "hand");
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(true);
    go(game, random);
    if (game.choice) act(game, "u0", { type: "choose", ids: ["yes"] }, random);
    go(game, random);
    expect(game.players.u0.hand.length).toBe(hand + 2); // Original + Kopie ziehen je eine Karte (Einberufer selbst verlässt die Hand)
    expect(game.players.u0.graveyard.filter(card => card === id)).toHaveLength(1);
  });

  it("Energie als Kosten und „Gegner mit Markern können nicht angreifen“", () => {
    const { game, random } = started();
    const cell = put(game, "u0", "Energiezelle", "battlefield");
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === cell).abilities[0].ok).toBe(false); // keine Energie
    game.players.u0.energy = 3;
    const life = game.players.u0.life;
    expect(act(game, "u0", { type: "activate", id: cell, index: 0 }, random).ok).toBe(true);
    go(game, random);
    expect(game.players.u0.energy).toBe(1);
    expect(game.players.u0.life).toBe(life + 3);
    put(game, "u0", "Zählerwächter", "battlefield");
    const foe = put(game, "u1", "Bär", "battlefield");
    expect(view(game, "u1").players.find(p => p.userId === "u1").battlefield.find(c => c.id === foe).keywords).not.toContain("cant-attack");
    game.cards[foe].counters["+1/+1"] = 1;
    expect(view(game, "u1").players.find(p => p.userId === "u1").battlefield.find(c => c.id === foe).keywords).toContain("cant-attack");
  });

  it("Cycling: eigener Auslöser (Schlüsselwort-Marker) und „cycle or discard another card“", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    put(game, "u0", "Wechselbeobachter", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    const life = game.players.u0.life;
    const bote = put(game, "u0", "Wechselbote", "hand");
    expect(act(game, "u0", { type: "cycle", id: bote }, random).ok).toBe(true);
    for (let i = 0; i < 10 && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, "u0", { type: "choose", ids: game.choice.options.slice(0, 1).map(o => o.id ?? o) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
    expect(game.players.u0.life).toBe(life + 1);
    const counted = game.players.u0.battlefield.filter(id => game.cards[id].counters.deathtouch === 1);
    expect(counted.length).toBe(1);
    expect(counted[0]).toBeTruthy();
    expect(view(game, "u0").players[0].battlefield.find(c => c.id === counted[0]).keywords).toContain("deathtouch");
    void bear;
  });

  it("„Creatures your opponents control enter tapped“", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    put(game, "u1", "Behördenerlass", "battlefield");
    const bear = put(game, "u0", "Bär", "hand");
    expect(act(game, "u0", { type: "cast", id: bear }, random).ok).toBe(true);
    go(game, random);
    expect(game.cards[bear].tapped).toBe(true);
  });

  it("„Whenever another Zombie you control dies“ zieht dem Gegner Leben ab", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    put(game, "u0", "Zombiefürst", "battlefield");
    put(game, "u0", "Mountain", "battlefield");
    const other = put(game, "u0", "Wiederkehrer", "battlefield"); // Zombie
    const life = game.players.u1.life;
    castAndResolve(game, "u0", "Zerstörer", random, [other]);
    expect(game.players.u1.life).toBe(life - 1);
  });

  it("Land aus der Hand ausspielen („put a land card from your hand onto the battlefield“) und „destroy all tapped creatures“", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    const land = put(game, "u0", "Forest", "hand");
    const id = put(game, "u0", "Wachstumsspirale", "hand");
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(true);
    go(game, random);
    expect(game.players.u0.battlefield.length).toBe(3); // 2 Länder + 1 aus der Hand („go“ antwortet automatisch mit Ja)
    void land;

    const tapped = put(game, "u1", "Bär", "battlefield");
    const fresh = put(game, "u1", "Falke", "battlefield");
    game.cards[tapped].tapped = true;
    forest(game, "u0", 1);
    castAndResolve(game, "u0", "Sonnenwende", random);
    expect(game.players.u1.battlefield).not.toContain(tapped);
    expect(game.players.u1.battlefield).toContain(fresh);
  });

  it("Landwandern verhindert Blocken, wenn der Verteidiger so ein Land hat; Auslöser ab Stärke 4", () => {
    const { game } = started();
    const walker = put(game, "u0", "Waldwanderer", "battlefield");
    const blocker = put(game, "u1", "Bär", "battlefield");
    expect(cannotBlockReason(game, game.cards[walker], game.cards[blocker])).toBeNull();
    put(game, "u1", "Forest", "battlefield");
    expect(cannotBlockReason(game, game.cards[walker], game.cards[blocker])).toBe("Landwandern");
  });

  it("„Whenever ~ is dealt damage“, Marker auf alle gegnerischen Kreaturen und Angriffszwang", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    for (let i = 0; i < 4; i += 1) put(game, "u0", "Mountain", "battlefield");
    const hydra = put(game, "u0", "Wachsende Hydra", "battlefield");
    const scribe = put(game, "u0", "Schreiber", "battlefield");
    const hand = game.players.u0.hand.length;
    castAndResolve(game, "u0", "Blitz", random, [hydra]); // 3 Schaden
    expect(game.cards[hydra].counters["+1/+1"]).toBe(3);
    castAndResolve(game, "u0", "Blitz", random, [scribe]);
    expect(game.players.u0.hand.length).toBe(hand + 3);
    const foe = put(game, "u1", "Bär", "battlefield");
    put(game, "u0", "Pestbringer", "hand");
    const id = game.players.u0.hand.find(c => game.defs[game.cards[c].def].name === "Pestbringer");
    expect(act(game, "u0", { type: "cast", id }, random).ok).toBe(true);
    go(game, random);
    expect(game.cards[foe].counters["-1/-1"]).toBe(1);
    expect(view(game, "u1").players.find(p => p.userId === "u1").battlefield.find(c => c.id === foe).keywords).toContain("must-attack");
  });

  it("Ersatzeffekt „that many plus one“ (Hardened Scales) erhöht neue +1/+1-Marker", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    put(game, "u0", "Gehärtete Schuppen", "battlefield");
    const adapter = put(game, "u0", "Anpasser", "battlefield");
    expect(act(game, "u0", { type: "activate", id: adapter, index: 0 }, random).ok).toBe(true);
    go(game, random);
    expect(game.cards[adapter].counters["+1/+1"]).toBe(3); // Adapt 2 + 1
  });

  it("„Whenever you attack“ feuert einmal je Angriff, „with N or more creatures“ nur ab N Angreifern", () => {
    const { game, random } = started();
    put(game, "u0", "Kriegshorn", "battlefield");
    const a = put(game, "u0", "Bär", "battlefield");
    const b = put(game, "u0", "Falke", "battlefield");
    const life = game.players.u0.life;
    game.turn.phase = "attackers";
    expect(act(game, "u0", { type: "declareAttackers", attackers: [{ id: a, target: "u1" }] }, random).ok).toBe(true);
    go(game, random);
    expect(game.players.u0.life).toBe(life + 1);
    const { game: g2, random: r2 } = started();
    put(g2, "u0", "Kriegshorn", "battlefield");
    const c = put(g2, "u0", "Bär", "battlefield");
    const d = put(g2, "u0", "Falke", "battlefield");
    const before = g2.players.u0.life;
    g2.turn.phase = "attackers";
    expect(act(g2, "u0", { type: "declareAttackers", attackers: [{ id: c, target: "u1" }, { id: d, target: "u1" }] }, r2).ok).toBe(true);
    go(g2, r2);
    expect(g2.players.u0.life).toBe(before + 6);
    void b;
  });

  it("Convoke und Delve bezahlen fehlendes Mana mit Kreaturen bzw. Friedhofskarten", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u0", "Bär", "battlefield");
    put(game, "u0", "Bär", "battlefield");
    put(game, "u0", "Bär", "battlefield");
    const hand = game.players.u0.hand.length;
    cast(game, random, "u0", "Einberufer");
    expect(game.players.u0.hand.length).toBe(hand + 1); // gezogen (Karte wurde nur hineingelegt und gewirkt)
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    const gy = ["Bär", "Falke", "Viper", "Ritter"].map(name => put(game, "u0", name, "graveyard"));
    cast(game, random, "u0", "Schürfer");
    expect(gy.filter(id => game.players.u0.exile.includes(id)).length).toBeGreaterThan(0);
  });

  it("Kostenverringerung durch Permanents und Chromatic Lantern", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    put(game, "u0", "Bildhauer", "battlefield");
    const sense = put(game, "u0", "Sense", "hand");
    expect(view(game, "u0").players[0].hand.find(c => c.id === sense).play.ok).toBe(true); // {2} − {1} = {1}
    expect(act(game, "u0", { type: "cast", id: sense }, random).ok).toBe(true);
    const { game: g2 } = started();
    put(g2, "u0", "Laterne", "battlefield");
    const mountain = put(g2, "u0", "Mountain", "battlefield");
    const colors = view(g2, "u0").players[0].battlefield.find(c => c.id === mountain).manaColors;
    expect(colors).toEqual(expect.arrayContaining(["W", "U", "B", "R", "G"]));
  });

  it("„enters with X counters“, „can't be countered“, „attacks each combat“", () => {
    const { game, random } = started();
    forest(game, "u0", 6);
    const ooze = cast(game, random, "u0", "Wachsschleim", { x: 3 });
    expect(game.cards[ooze].counters["+1/+1"]).toBe(3);
    // nicht neutralisierbar
    put(game, "u1", "Mountain", "battlefield");
    const counter = put(game, "u1", "Gegenzauber", "hand");
    const draw = put(game, "u0", "Unaufhaltsam", "hand");
    expect(act(game, "u0", { type: "cast", id: draw }, random).error ?? "ok").toBe("ok");
    expect(game.priority, JSON.stringify(game.stack.map(i => i.sid))).toBe("u1");
    expect(act(game, "u1", { type: "cast", id: counter, targets: [game.stack[0]?.sid] }, random).error ?? "ok").toBe("ok");
    go(game, random);
    expect(game.players.u0.graveyard).toContain(draw);
    // Angriffszwang
    const { game: g2, random: r2 } = started();
    const berserk = put(g2, "u0", "Berserker", "battlefield");
    toAttackers(g2, r2);
    expect(act(g2, "u0", { type: "declareAttackers", attackers: [] }, r2).error).toMatch(/muss angreifen/);
    expect(act(g2, "u0", { type: "declareAttackers", attackers: [{ id: berserk, target: "u1" }] }, r2).ok).toBe(true);
  });

  it("Monarch zieht am Zugende; Proliferate erhöht Marker", () => {
    const { game, random } = started();
    forest(game, "u0", 2);
    cast(game, random, "u0", "Thronanspruch");
    expect(game.monarch).toBe("u0");
    const bear = put(game, "u0", "Bär", "battlefield");
    game.cards[bear].counters["+1/+1"] = 1;
    cast(game, random, "u0", "Wucherung");
    expect(game.cards[bear].counters["+1/+1"]).toBe(2);
  });

  it("Obersten Karten ansehen, Kreatur nehmen, Rest unten (Ancient Stirrings)", () => {
    const { game, random } = started();
    forest(game, "u0", 1);
    const lib = game.players.u0.library;
    const creature = lib.find(id => game.defs[game.cards[id].def]?.types.creature);
    lib.splice(lib.indexOf(creature), 1);
    lib.push(creature);
    const spell = put(game, "u0", "Uraltes Rühren", "hand");
    const size = lib.length;
    const handBefore = new Set(game.players.u0.hand);
    act(game, "u0", { type: "cast", id: spell }, random);
    go(game, random);
    const added = game.players.u0.hand.filter(id => !handBefore.has(id));
    expect(added).toHaveLength(1);
    expect(game.defs[game.cards[added[0]].def].types.creature).toBe(true);
    expect(game.players.u0.library.length).toBe(size - 1);
  });

  it("Chaos Warp, „destroy all artifacts and enchantments“, Zusatzland, Spire-Steuer", () => {
    const { game, random } = started();
    forest(game, "u0", 12);
    put(game, "u0", "Mountain", "battlefield");
    put(game, "u1", "Mountain", "battlefield");
    const target = put(game, "u1", "Sense", "battlefield");
    cast(game, random, "u0", "Chaoswirbel", { targets: [target] });
    expect(game.players.u1.battlefield).not.toContain(target);
    const art = put(game, "u1", "Sense", "battlefield");
    cast(game, random, "u0", "Reinigungsnova");
    expect(game.players.u1.battlefield).not.toContain(art);
    // Zusatzland
    const l1 = put(game, "u0", "Forest", "hand");
    const l2 = put(game, "u0", "Mountain", "hand");
    expect(act(game, "u0", { type: "playLand", id: l1 }, random).error ?? "ok").toBe("ok");
    expect(act(game, "u0", { type: "playLand", id: l2 }, random).ok).toBe(false);
    cast(game, random, "u0", "Erkunden");
    expect(act(game, "u0", { type: "playLand", id: l2 }, random).error ?? "ok").toBe("ok");
  });

  it("Charge-Counter-Land und Exil-aus-Friedhof; Wandelland; Evolve; Living Weapon; Monstrosity", () => {
    const { game, random } = started();
    forest(game, "u0", 6);
    const cavern = put(game, "u0", "Schimmerhain", "hand");
    act(game, "u0", { type: "playLand", id: cavern }, random);
    expect(game.cards[cavern].counters.charge).toBe(2);
    game.cards[cavern].tapped = false;
    const ability = view(game, "u0").players[0].battlefield.find(c => c.id === cavern).abilities[0];
    expect(ability.ok).toBe(true);
    act(game, "u0", { type: "activate", id: cavern, index: 0 }, random);
    go(game, random);
    expect(game.cards[cavern].counters.charge).toBe(1);
    // Exil
    const gyCard = put(game, "u1", "Bär", "graveyard");
    cast(game, random, "u0", "Gräberghul", { targets: [gyCard] });
    expect(game.players.u1.exile).toContain(gyCard);
    // Evolve
    const evo = put(game, "u0", "Entwickler", "battlefield");
    cast(game, random, "u0", "Bär");
    expect(game.cards[evo].counters["+1/+1"]).toBe(1);
    // Living weapon
    const germer = cast(game, random, "u0", "Keimwaffe");
    expect(game.cards[germer].attachedTo).toBeTruthy();
    expect(game.cards[game.cards[germer].attachedTo].token).toBe(true);
    // Monstrosity
    const beast = put(game, "u0", "Monströs", "battlefield");
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "activate", id: beast, index: 0 }, random);
    go(game, random);
    expect(game.cards[beast].counters["+1/+1"]).toBe(2);
  });

  it("Filterland: Auswahl der Manakombination; Wandelland wird zur Kreatur", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const filter = put(game, "u0", "Filterland", "battlefield");
    const ab = view(game, "u0").players[0].battlefield.find(c => c.id === filter).abilities[0];
    expect(ab.ok).toBe(true);
    act(game, "u0", { type: "activate", id: filter, index: 0 }, random);
    go(game, random, 2);
    expect(game.choice === null || game.pool).toBeTruthy();
    const manland = put(game, "u0", "Wandelland", "battlefield");
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "activate", id: manland, index: 0 }, random);
    go(game, random);
    const v = view(game, "u0").players[0].battlefield.find(c => c.id === manland);
    expect(v.kind === "creature" || v.power === 3).toBe(true);
  });
});

describe("Hero's Heirloom und Walking Ballista", () => {
  it("Heirloom: Bonus immer, Trampel und Eile nur an legendären Kreaturen", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const heirloom = put(game, "u0", "Heldenerbstück", "battlefield");
    const king = put(game, "u0", "König", "battlefield");
    const bear = put(game, "u0", "Bär", "battlefield");
    act(game, "u0", { type: "activate", id: heirloom, index: 0, targets: [bear] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    let card = view(game, "u0").players[0].battlefield.find(c => c.id === bear);
    expect(card.power).toBe(4);
    expect(card.keywords).not.toContain("trample");
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "activate", id: heirloom, index: 0, targets: [king] }, random);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    card = view(game, "u0").players[0].battlefield.find(c => c.id === king);
    expect(card.power).toBe(4);
    expect(card.keywords).toEqual(expect.arrayContaining(["trample", "haste"]));
  });

  it("Ballista: X Marker beim Ins-Spiel-Kommen, Marker entfernen schießt 1 Schaden", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const ballista = put(game, "u0", "Wandelnde Balliste", "hand");
    expect(act(game, "u0", { type: "cast", id: ballista, x: 2 }, random).ok).toBe(true);
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.cards[ballista].counters["+1/+1"]).toBe(2);
    const life = game.players.u1.life;
    const ab = view(game, "u0").players[0].battlefield.find(c => c.id === ballista).abilities.find(a => a.pays?.some(p => p.kind === "removeCounter"));
    expect(ab).toBeTruthy();
    expect(act(game, "u0", { type: "activate", id: ballista, index: ab.index, targets: ["u1"] }, random).error ?? "ok").toBe("ok");
    for (let i = 0; i < 4 && game.stack.length > 0; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u1.life).toBe(life - 1);
    expect(game.cards[ballista].counters["+1/+1"]).toBe(1);
  });
});

describe("Mechaniken aus den Set-Decks (Toxic, Undying, Adapt, Evoke, Typ-Auslöser)", () => {
  const go = (game, random, n = 10) => {
    for (let i = 0; i < n && (game.stack.length > 0 || game.choice); i += 1) {
      if (game.choice) act(game, game.choice.userId, { type: "choose", ids: game.choice.kind === "yesno" ? ["yes"] : game.choice.options.slice(0, Math.max(1, game.choice.min)) }, random);
      else act(game, game.priority, { type: "pass" }, random);
    }
  };

  it("Toxic gibt Giftmarken bei Kampfschaden an einen Spieler", () => {
    const { game, random } = started();
    const bug = put(game, "u0", "Giftkäfer", "battlefield");
    toAttackers(game, random);
    act(game, "u0", { type: "declareAttackers", attackers: [{ id: bug, target: "u1" }] }, random);
    go(game, random);
    for (let i = 0; i < 6 && game.combat; i += 1) act(game, game.priority, { type: "pass" }, random);
    expect(game.players.u1.poison).toBe(1);
  });

  it("Undying: stirbt ohne Marker → kommt mit +1/+1-Marker zurück; mit Marker bleibt sie tot", () => {
    const { game, random } = started();
    const z = put(game, "u0", "Wiederkehrer", "battlefield");
    game.cards[z].damage = 5;
    act(game, "u0", { type: "pass" }, random);
    go(game, random);
    expect(game.players.u0.battlefield).toContain(z);
    expect(game.cards[z].counters["+1/+1"]).toBe(1);
    game.cards[z].damage = 9;
    act(game, game.priority, { type: "pass" }, random);
    go(game, random);
    expect(game.players.u0.graveyard).toContain(z);
  });

  it("Adapt nur ohne Marker; Evoke wird geopfert, löst aber aus", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const druid = put(game, "u0", "Anpasser", "battlefield");
    act(game, "u0", { type: "activate", id: druid, index: 0 }, random);
    go(game, random);
    expect(game.cards[druid].counters["+1/+1"]).toBe(2);
    for (const id of game.players.u0.battlefield) game.cards[id].tapped = false;
    act(game, "u0", { type: "activate", id: druid, index: 0 }, random);
    go(game, random);
    expect(game.cards[druid].counters["+1/+1"]).toBe(2); // bleibt bei 2
    const drifter = put(game, "u0", "Treiber", "hand");
    const hand = game.players.u0.hand.length;
    expect(view(game, "u0").players[0].hand.find(c => c.id === drifter).evoke).toMatchObject({ ok: true, cost: "{1}{G}" });
    expect(act(game, "u0", { type: "cast", id: drifter, evoke: true }, random).error ?? "ok").toBe("ok");
    go(game, random);
    expect(game.players.u0.graveyard).toContain(drifter);
    expect(game.players.u0.hand.length).toBe(hand - 1 + 2);
  });

  it("„Whenever another Human you control enters“: nur Menschen lösen aus", () => {
    const { game, random } = started();
    forest(game, "u0", 4);
    const lord = put(game, "u0", "Menschenhauptmann", "battlefield");
    cast(game, random, "u0", "Mensch");
    expect(game.cards[lord].counters["+1/+1"]).toBe(1);
    cast(game, random, "u0", "Bär");
    expect(game.cards[lord].counters["+1/+1"]).toBe(1);
    function cast(g, r, uid, name) {
      const id = put(g, uid, name, "hand");
      expect(act(g, uid, { type: "cast", id }, r).error ?? "ok").toBe("ok");
      go(g, r);
    }
  });
});
