import { useMemo, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { GameAction, GameCard, GamePlayer, GameStep, GameView, GameZone } from "../../gameClient";
import tableImage from "../../assets/game/table.webp";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import GameCardTile, { CardBack } from "./GameCardTile";
import "./game.css";

const ZONE_LABELS: Record<GameZone, string> = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};
const STEP_LABELS: Record<GameStep, string> = {
  main1: "Haupt 1",
  attackers: "Angriff",
  blockers: "Blocken",
  damage: "Schaden",
  main2: "Haupt 2",
  end: "Ende"
};
const STEPS: GameStep[] = ["main1", "attackers", "blockers", "damage", "main2", "end"];
const MANA_COLORS = ["W", "U", "B", "R", "G", "C"] as const;
const MANA_NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos" };

type Menu = { x: number; y: number; items: MenuItem[] } | null;
type PileZone = "graveyard" | "exile" | "command";

/**
 * Der Spieltisch: Die Spieler sitzen um einen Tisch. Gegner oben (gespiegelt), du unten. Karten bedienst du wie am echten Tisch:
 * anklicken oder auf den Tisch ziehen zum Spielen, Bibliothek anklicken zum Ziehen, Rechtsklick/langes Drücken für weitere Möglichkeiten.
 */
export default function GameTable({
  game,
  hostId,
  send,
  onRematch,
  onLeave
}: {
  game: GameView;
  hostId: string;
  send: (action: GameAction) => void;
  onRematch: () => void;
  onLeave: () => void;
}) {
  const me = game.players.find(player => player.userId === game.you);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [hover, setHover] = useState<GameCard | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [zoneView, setZoneView] = useState<{ owner: string; zone: GameZone } | null>(null);
  const [bottomPick, setBottomPick] = useState<string[]>([]);
  const [discardPick, setDiscardPick] = useState<string[]>([]);
  const [attackPick, setAttackPick] = useState<string[]>([]);
  const [attackTarget, setAttackTarget] = useState("");
  const [blockPick, setBlockPick] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<string, string>>({});
  const [castX, setCastX] = useState<{ id: string; name: string; value: number } | null>(null);
  const [lifeOpen, setLifeOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const allCards = useMemo(() => {
    const map = new Map<string, GameCard>();
    for (const player of game.players) {
      for (const list of [player.hand, player.battlefield, player.graveyard, player.exile, player.command, player.looking ?? []]) {
        for (const card of list) map.set(card.id, card);
      }
    }
    for (const item of game.stack) if (item.card) map.set(item.card.id, item.card);
    return map;
  }, [game]);

  if (!me) return null;

  const opponents = game.players.filter(player => player.userId !== game.you);
  const livingOpponents = opponents.filter(player => !player.eliminated);
  const nameOf = (userId: string | null) => game.players.find(player => player.userId === userId)?.name ?? "";
  const step = game.turn.phase;
  const isActive = game.turn.active === game.you;
  const canAct = game.phase === "playing" && !me.eliminated;
  const iHavePriority = game.priority === game.you && canAct;
  const target = attackTarget || livingOpponents[0]?.userId || "";
  const awaitingMe = Boolean(game.combat?.awaiting.includes(game.you));
  const attackedMe = game.combat?.attackers.filter(attacker => attacker.target === game.you) ?? [];
  const bottomNeeded = Math.max(0, me.mulligans - (game.format === "commander" ? 1 : 0));
  const attackStep = canAct && isActive && step === "attackers" && game.stack.length === 0;
  const discarding = game.pendingDiscard?.userId === game.you;
  const winner = game.players.find(player => player.userId === game.winner);
  const previewCard = hover ?? (pinnedId ? allCards.get(pinnedId) : undefined) ?? null;

  const act = (action: GameAction) => send(action);
  const zoneOf = (card: GameCard): GameZone | null => {
    for (const zone of ["hand", "battlefield", "graveyard", "exile", "command"] as const) {
      if (me[zone].some(item => item.id === card.id)) return zone;
    }
    return me.looking?.some(item => item.id === card.id) ? "library" : null;
  };
  const moveCard = (card: GameCard, to: GameZone, extra: { position?: "top" | "bottom"; faceDown?: boolean } = {}) =>
    act({ type: "move", id: card.id, to, ...extra });

  const primaryPlay = (card: GameCard, free = false) => {
    if (card.play?.kind === "land") return act({ type: "playLand", id: card.id });
    if (!free && /\{X\}/i.test(card.manaCost ?? "")) return setCastX({ id: card.id, name: card.name ?? "", value: 0 });
    act({ type: "cast", id: card.id, ...(free ? { free: true } : {}) });
  };

  // ---------- Drag and Drop ----------
  const onDragStart = (card: GameCard, event: DragEvent) => {
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
  };
  const dropProps = (key: string, handler: (card: GameCard) => void) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDropKey(key);
    },
    onDragLeave: () => setDropKey(current => (current === key ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropKey(null);
      const card = allCards.get(event.dataTransfer.getData("text/plain"));
      if (card && card.owner === game.you && canAct) handler(card);
    }
  });
  const dropOnTable = (card: GameCard) => {
    const zone = zoneOf(card);
    if (zone === "hand" || zone === "command") {
      if (card.play?.ok) primaryPlay(card);
      else if (card.play) act({ type: card.play.kind === "land" ? "playLand" : "cast", id: card.id } as GameAction);
      else moveCard(card, "battlefield");
    } else if (zone && zone !== "battlefield") moveCard(card, "battlefield");
  };

  // ---------- Menüs ----------
  const cardMenu = (card: GameCard, x: number, y: number) => {
    const items: MenuItem[] = [{ label: "Groß ansehen", onClick: () => setPinnedId(card.id) }];
    const stackItem = game.stack.find(item => item.card?.id === card.id);
    if (stackItem && iHavePriority) items.push({ label: "Neutralisieren", onClick: () => act({ type: "counterSpell", sid: stackItem.sid }) });
    if (card.owner === game.you && canAct && !stackItem) {
      const zone = zoneOf(card);
      const moves = (zones: GameZone[]) =>
        zones
          .filter(z => z !== zone && (z !== "command" || (game.format === "commander" && card.cmd)))
          .map(z => ({ label: `→ ${ZONE_LABELS[z]}`, onClick: () => moveCard(card, z) }));
      const library: MenuItem[] = [
        { label: "→ Bibliothek oben", onClick: () => moveCard(card, "library", { position: "top" }) },
        { label: "→ Bibliothek unten", onClick: () => moveCard(card, "library", { position: "bottom" }) }
      ];
      if ((zone === "hand" || zone === "command") && card.play) {
        items.push({ label: card.play.kind === "land" ? "Land spielen" : "Wirken", disabled: !card.play.ok, onClick: () => primaryPlay(card) });
        if (card.play.kind === "spell" && iHavePriority) items.push({ label: "Ohne Kosten wirken", onClick: () => primaryPlay(card, true) });
      }
      if (zone === "hand") {
        items.push({ label: card.name ? "Zeigen / verbergen" : "Zeigen", onClick: () => act({ type: "reveal", id: card.id }) });
        items.push({ label: "Verdeckt ausspielen", onClick: () => moveCard(card, "battlefield", { faceDown: true }) });
        items.push({ label: "Manuell auslegen", onClick: () => moveCard(card, "battlefield") });
        items.push(...moves(["graveyard", "exile"]), ...library);
      } else if (zone === "battlefield") {
        if (card.mana && !card.tapped && !card.sick) {
          for (const color of card.manaColors ?? []) {
            items.push({ label: `Mana ${MANA_NAMES[color] ?? color}`, onClick: () => act({ type: "tapMana", id: card.id, color }) });
          }
        }
        items.push({ label: card.tapped ? "Enttappen" : "Tappen", onClick: () => act({ type: "tap", id: card.id }) });
        items.push({ label: "Umdrehen", onClick: () => act({ type: "flip", id: card.id }) });
        items.push({ label: "+1/+1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "+1/+1", delta: 1 }) });
        items.push({ label: "−1/−1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "-1/-1", delta: 1 }) });
        items.push({
          label: "Anderen Marker hinzufügen …",
          onClick: () => {
            const kind = window.prompt("Markerart (z. B. Loyalität, Ladung):", "Ladung")?.trim();
            if (kind) act({ type: "counter", id: card.id, kind, delta: 1 });
          }
        });
        for (const kind of Object.keys(card.counters)) {
          items.push({ label: `${kind}-Marker entfernen`, onClick: () => act({ type: "counter", id: card.id, kind, delta: -1 }) });
        }
        items.push(...moves(["hand", "graveyard", "exile", "command"]), ...library);
      } else if (zone) {
        items.push({ label: "→ Schlachtfeld", onClick: () => moveCard(card, "battlefield") });
        items.push(...moves(["hand", "graveyard", "exile", "command"]), ...library);
      }
    }
    setMenu({ x, y, items });
  };

  const gameMenu = (event: MouseEvent) => {
    const items: MenuItem[] = [
      { label: "Verlauf anzeigen", onClick: () => setLogOpen(true) },
      {
        label: "Spielstein erzeugen …",
        onClick: () => {
          const name = window.prompt("Spielstein (z. B. „Goblin 1/1“):", "Goblin 1/1")?.trim();
          if (name) act({ type: "token", name });
        }
      },
      {
        label: "Fähigkeit auf den Stapel …",
        disabled: !iHavePriority,
        onClick: () => {
          const text = window.prompt("Fähigkeit oder Auslöser:")?.trim();
          if (text) act({ type: "ability", text });
        }
      },
      { label: "Würfel W6", onClick: () => act({ type: "dice", sides: 6 }) },
      { label: "Würfel W20", onClick: () => act({ type: "dice", sides: 20 }) },
      { label: "Münze werfen", onClick: () => act({ type: "coin" }) },
      { label: "Oberste Karte mahlen", onClick: () => act({ type: "mill" }) },
      { label: "Alles enttappen", onClick: () => act({ type: "untapAll" }) },
      { label: me.autoPass ?? true ? "Automatisch passen: aus" : "Automatisch passen: an", onClick: () => act({ type: "autoPass", value: !(me.autoPass ?? true) }) }
    ];
    if (canAct && isActive && game.stack.length === 0 && !game.combat) items.push({ label: "Zug sofort beenden", onClick: () => act({ type: "endTurn" }) });
    if (canAct) {
      items.push({
        label: "Aufgeben",
        onClick: () => {
          if (window.confirm("Wirklich aufgeben?")) act({ type: "concede" });
        }
      });
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  // ---------- Klick = Hauptaktion ----------
  const clickCard = (card: GameCard, event: MouseEvent) => {
    const own = card.owner === game.you;
    const zone = own ? zoneOf(card) : null;
    if (!own) {
      if (awaitingMe && blockPick && attackedMe.some(attacker => attacker.id === card.id)) {
        setBlocks(current => ({ ...current, [blockPick]: card.id }));
        setBlockPick(null);
      } else setPinnedId(current => (current === card.id ? null : card.id));
      return;
    }
    if (discarding && zone === "hand") {
      setDiscardPick(current => (current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id]));
      return;
    }
    if (zone === "battlefield") {
      if (attackStep && card.kind === "creature") {
        if (!card.tapped && !card.sick && !card.keywords?.includes("defender") && livingOpponents.length > 0) {
          setAttackPick(current => (current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id]));
        }
        return;
      }
      if (awaitingMe && step === "blockers" && card.kind === "creature" && !card.tapped) {
        setBlockPick(current => (current === card.id ? null : card.id));
        return;
      }
      if (!canAct) return;
      if (card.mana && !card.tapped && !card.sick) {
        const colors = card.manaColors ?? [];
        if (colors.length > 1) {
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: "Mana wählen", onClick: () => undefined, heading: true },
              ...colors.map(color => ({ label: MANA_NAMES[color] ?? color, onClick: () => act({ type: "tapMana", id: card.id, color }) }))
            ]
          });
        } else act({ type: "tapMana", id: card.id });
        return;
      }
      if (!card.mana) act({ type: "tap", id: card.id });
      return;
    }
    if ((zone === "hand" || zone === "command") && canAct && card.play?.ok) {
      primaryPlay(card);
      return;
    }
    setPinnedId(current => (current === card.id ? null : card.id));
  };

  const tileProps = (card: GameCard) => ({
    card,
    onSelect: clickCard,
    onHover: setHover,
    onMenu: cardMenu,
    onDragStart: card.owner === game.you ? onDragStart : undefined,
    marked: (attackPick.includes(card.id) ? "attack" : blockPick === card.id ? "pick" : blocks[card.id] ? "block" : discardPick.includes(card.id) ? "pick" : null) as
      | "attack"
      | "block"
      | "pick"
      | null
  });

  // ---------- Starthand ----------
  if (game.phase === "mulligan") {
    return (
      <section className="table table-start" style={{ backgroundImage: `url(${tableImage})` }} aria-label="Spieltisch">
        <div className="table-panel">
          <h3>Deine Starthand</h3>
          <p className="muted">
            Behalte die Karten oder nimm einen Mulligan (London-Mulligan: neue sieben Karten, danach legst du so viele Karten unter die
            Bibliothek, wie du Mulligans genommen hast{game.format === "commander" ? "; der erste Mulligan ist kostenlos" : ""}).
          </p>
          {me.kept ? (
            <div className="notice" role="status">Du hast behalten. Warte auf die anderen Spieler …</div>
          ) : (
            <>
              <div className="start-hand">
                {me.hand.map(card => (
                  <GameCardTile
                    key={card.id}
                    card={card}
                    size="fill"
                    marked={bottomPick.includes(card.id) ? "pick" : null}
                    onHover={setHover}
                    onSelect={c =>
                      bottomNeeded > 0 &&
                      setBottomPick(current => (current.includes(c.id) ? current.filter(id => id !== c.id) : [...current, c.id]))
                    }
                  />
                ))}
              </div>
              {bottomNeeded > 0 && (
                <p className="muted">
                  Klicke {bottomNeeded} Karte{bottomNeeded === 1 ? "" : "n"} an, die unter die Bibliothek kommen ({bottomPick.length} gewählt).
                </p>
              )}
              <div className="table-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={bottomPick.length !== bottomNeeded}
                  onClick={() => {
                    act({ type: "keep", bottom: bottomPick });
                    setBottomPick([]);
                  }}
                >
                  Behalten
                </button>
                {me.mulligans < 6 && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setBottomPick([]);
                      act({ type: "mulligan" });
                    }}
                  >
                    Mulligan ({me.mulligans} bisher)
                  </button>
                )}
              </div>
            </>
          )}
          <ul className="muted">
            {game.players.map(player => (
              <li key={player.userId}>
                {player.name}: {player.eliminated ? `ausgeschieden (${player.eliminated})` : player.kept ? "hat behalten" : "entscheidet noch"}
              </li>
            ))}
          </ul>
        </div>
        <Preview card={previewCard} />
      </section>
    );
  }

  // ---------- Bausteine ----------
  const renderPile = (player: GamePlayer, zone: PileZone) => {
    if (zone === "command" && game.format !== "commander") return null;
    const own = player.userId === game.you;
    const cards = player[zone];
    const top = cards.at(-1);
    const key = `${player.userId}:${zone}`;
    const open = () => setZoneView(current => (current?.owner === player.userId && current.zone === zone ? null : { owner: player.userId, zone }));
    return (
      <div
        key={zone}
        role="button"
        tabIndex={0}
        className={`pile${dropKey === key ? " drop" : ""}`}
        aria-label={`${ZONE_LABELS[zone]} von ${player.name}: ${player.counts[zone]}`}
        onClick={open}
        onKeyDown={event => (event.key === "Enter" || event.key === " ") && open()}
        {...(own ? dropProps(key, card => moveCard(card, zone)) : {})}
      >
        {top ? <GameCardTile card={top} size="sm" onHover={setHover} /> : <span className="pile-empty" />}
        <span className="pile-label">{ZONE_LABELS[zone]} · {player.counts[zone]}</span>
      </div>
    );
  };

  const renderLibrary = (player: GamePlayer) => {
    const own = player.userId === game.you;
    return (
      <button
        key="library"
        type="button"
        className={`pile library${dropKey === `${player.userId}:library` ? " drop" : ""}`}
        aria-label={own ? `Bibliothek: ${player.counts.library} Karten. Anklicken zum Ziehen` : `Bibliothek von ${player.name}: ${player.counts.library}`}
        title={own ? "Anklicken: Karte ziehen · Rechtsklick: ansehen, durchsuchen, mischen" : undefined}
        disabled={!own && true}
        onClick={() => own && canAct && act({ type: "draw" })}
        onContextMenu={event => {
          if (!own) return;
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: "Oberste 3 ansehen", onClick: () => (act({ type: "look", count: 3 }), setZoneView({ owner: game.you, zone: "library" })) },
              { label: "Oberste 5 ansehen", onClick: () => (act({ type: "look", count: 5 }), setZoneView({ owner: game.you, zone: "library" })) },
              { label: "Bibliothek durchsuchen", onClick: () => (act({ type: "look", count: "all" }), setZoneView({ owner: game.you, zone: "library" })) },
              { label: "Mischen", onClick: () => act({ type: "shuffle" }) },
              { label: "Oberste Karte mahlen", onClick: () => act({ type: "mill" }) }
            ]
          });
        }}
        {...(own ? dropProps(`${player.userId}:library`, card => moveCard(card, "library", { position: "top" })) : {})}
      >
        <span className="gc sm library-card">
          <CardBack />
        </span>
        <span className="pile-label">Bibliothek · {player.counts.library}</span>
      </button>
    );
  };

  const renderHand = (player: GamePlayer, own: boolean) => {
    if (!own) {
      const backs = Math.min(player.counts.hand - player.hand.length, 10);
      return (
        <div className="hand opp-hand" aria-label={`Hand von ${player.name}: ${player.counts.hand} Karten`}>
          {player.hand.map(card => (
            <GameCardTile key={card.id} card={card} size="sm" onHover={setHover} />
          ))}
          {Array.from({ length: backs }, (_, i) => (
            <span key={i} className="gc sm back-only">
              <CardBack />
            </span>
          ))}
          <span className="hand-count">{player.counts.hand}</span>
        </div>
      );
    }
    const overlap = Math.min(0.78, Math.max(0, ((me.hand.length - 7) / Math.max(me.hand.length, 1)) * 1.15));
    return (
      <div
        className={`hand${dropKey === "hand" ? " drop" : ""}`}
        aria-label="Deine Hand"
        style={{ "--overlap": overlap } as React.CSSProperties}
        {...dropProps("hand", card => moveCard(card, "hand"))}
      >
        {me.hand.length === 0 && <span className="muted">Keine Karten auf der Hand.</span>}
        {me.hand.map(card => (
          <GameCardTile key={card.id} {...tileProps(card)} size="md" glow={Boolean(card.play?.ok) && canAct && !discarding} />
        ))}
      </div>
    );
  };

  const renderSeat = (player: GamePlayer) => {
    const own = player.userId === game.you;
    const active = game.turn.active === player.userId && game.phase === "playing";
    const rows = {
      creature: player.battlefield.filter(card => card.kind === "creature"),
      other: player.battlefield.filter(card => card.kind === "other"),
      land: player.battlefield.filter(card => card.kind === "land")
    };
    const size = own ? "md" : "sm";
    const chips: string[] = [];
    if (player.poison > 0) chips.push(`Gift ${player.poison}`);
    if (player.energy > 0) chips.push(`Energie ${player.energy}`);
    if (player.experience > 0) chips.push(`Erfahrung ${player.experience}`);
    for (const other of game.players) {
      if (other.userId !== player.userId && (player.cmdDamage[other.userId] ?? 0) > 0) {
        chips.push(`Kommandantenschaden von ${other.name}: ${player.cmdDamage[other.userId]}/21`);
      }
    }
    for (const card of player.command) {
      if (game.format === "commander" && (player.cmdCasts[card.id] ?? 0) > 0) chips.push(`${card.name}: Steuer +${2 * player.cmdCasts[card.id]}`);
    }

    return (
      <div
        key={player.userId}
        className={`seat ${own ? "me" : "opp"}${active ? " active" : ""}${player.eliminated ? " out" : ""}${own && dropKey === "table" ? " drop" : ""}`}
        aria-label={`Platz von ${player.name}`}
        {...(own && canAct ? dropProps("table", dropOnTable) : {})}
      >
        <div className="seat-head">
          <span className="seat-name">{player.name}{own ? " (du)" : ""}</span>
          <button
            type="button"
            className="life"
            aria-label={own ? `Leben: ${player.life}. Anklicken zum Anpassen` : `Leben von ${player.name}: ${player.life}`}
            disabled={!own || !canAct}
            onClick={() => setLifeOpen(open => !open)}
            title={own ? "Leben ändert sich automatisch (Kampf, Lebensverbindung). Anklicken für manuelle Korrektur." : undefined}
          >
            {player.life}
          </button>
          {MANA_COLORS.filter(color => player.pool[color] > 0).map(color => (
            <span key={color} className={`mana ${color}`} title={`${player.pool[color]}× ${MANA_NAMES[color]}`}>{player.pool[color]}</span>
          ))}
          {active && <span className="chip">am Zug</span>}
          {game.priority === player.userId && <span className="chip">Priorität</span>}
          {player.eliminated && <span className="chip out">ausgeschieden: {player.eliminated}</span>}
          {chips.map(text => (
            <span key={text} className="chip">{text}</span>
          ))}
          {own && lifeOpen && (
            <span className="life-pop" role="group" aria-label="Leben manuell anpassen">
              <button type="button" onClick={() => act({ type: "life", delta: -5 })}>−5</button>
              <button type="button" onClick={() => act({ type: "life", delta: -1 })}>−1</button>
              <button type="button" onClick={() => act({ type: "life", delta: 1 })}>+1</button>
              <button type="button" onClick={() => act({ type: "life", delta: 5 })}>+5</button>
              <button type="button" onClick={() => act({ type: "pcounter", kind: "poison", delta: 1 })}>Gift +1</button>
            </span>
          )}
        </div>

        <div className="seat-base">
          <div className="piles piles-l">
            {(["graveyard", "exile", "command"] as const).map(zone => renderPile(player, zone))}
          </div>
          {renderHand(player, own)}
          <div className="piles piles-r">{renderLibrary(player)}</div>
        </div>

        <div className="field">
          {own ? (
            <>
              {rows.creature.length > 0 && <div className="field-row" aria-label={`Kreaturen von ${player.name}`}>{rows.creature.map(card => <GameCardTile key={card.id} {...tileProps(card)} size={size} />)}</div>}
              {rows.other.length + rows.land.length > 0 && (
                <div className="field-row" aria-label={`Länder und Permanents von ${player.name}`}>
                  {rows.other.map(card => <GameCardTile key={card.id} {...tileProps(card)} size={size} />)}
                  {rows.land.map(card => <GameCardTile key={card.id} {...tileProps(card)} size="sm" />)}
                </div>
              )}
            </>
          ) : (
            <>
              {rows.other.length + rows.land.length > 0 && (
                <div className="field-row" aria-label={`Länder und Permanents von ${player.name}`}>
                  {rows.land.map(card => <GameCardTile key={card.id} {...tileProps(card)} size="sm" />)}
                  {rows.other.map(card => <GameCardTile key={card.id} {...tileProps(card)} size={size} />)}
                </div>
              )}
              {rows.creature.length > 0 && <div className="field-row" aria-label={`Kreaturen von ${player.name}`}>{rows.creature.map(card => <GameCardTile key={card.id} {...tileProps(card)} size={size} />)}</div>}
            </>
          )}
          {player.battlefield.length === 0 && <span className="muted field-empty">Keine Karten im Spiel.</span>}
        </div>
      </div>
    );
  };

  // ---------- Aktionsleiste: nur, was gerade möglich ist ----------
  const goLabel =
    game.stack.length > 0
      ? "Passen – Stapel auflösen"
      : step === "main1"
        ? "Weiter zum Kampf"
        : step === "attackers"
          ? "Kein Angriff"
          : step === "damage"
            ? "Kampfschaden verursachen"
            : step === "main2"
              ? "Weiter zum Zugende"
              : isActive
                ? "Zug beenden"
                : "Passen";

  const renderBar = () => {
    if (game.phase === "ended") {
      return (
        <div className="bar" role="status">
          <strong>Das Spiel ist beendet. {winner ? `${winner.name} gewinnt.` : "Kein Sieger."}</strong>
          {game.you === hostId ? (
            <button type="button" className="primary" onClick={onRematch}>Revanche</button>
          ) : (
            <span className="muted">Der Gastgeber ({nameOf(hostId)}) kann eine Revanche starten.</span>
          )}
          <button type="button" className="secondary" onClick={onLeave}>Raum verlassen</button>
        </div>
      );
    }
    const prompt = me.prompts[0];
    if (prompt) {
      return (
        <div className="bar" role="alert">
          <strong>{allCards.get(prompt.id)?.name ?? "Dein Kommandant"} hat das Spiel verlassen. In die Kommandozone zurücklegen?</strong>
          <button type="button" className="primary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: true })}>Ja, in die Kommandozone</button>
          <button type="button" className="secondary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: false })}>Nein</button>
        </div>
      );
    }
    if (discarding && game.pendingDiscard) {
      return (
        <div className="bar" role="alert">
          <strong>Handkartenlimit: Wähle {game.pendingDiscard.count} Karte{game.pendingDiscard.count === 1 ? "" : "n"} in deiner Hand zum Abwerfen ({discardPick.length}/{game.pendingDiscard.count}).</strong>
          <button
            type="button"
            className="primary"
            disabled={discardPick.length !== game.pendingDiscard.count}
            onClick={() => {
              act({ type: "discard", ids: discardPick });
              setDiscardPick([]);
            }}
          >
            Abwerfen
          </button>
        </div>
      );
    }
    if (attackStep && iHavePriority) {
      return (
        <div className="bar" role="status">
          <strong>Angriff: Klicke deine Kreaturen an, die angreifen sollen ({attackPick.length} gewählt).</strong>
          {livingOpponents.length > 1 && (
            <label>
              Ziel{" "}
              <select value={target} onChange={event => setAttackTarget(event.target.value)} aria-label="Angriffsziel">
                {livingOpponents.map(player => (
                  <option key={player.userId} value={player.userId}>{player.name}</option>
                ))}
              </select>
            </label>
          )}
          {attackPick.length > 0 && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                act({ type: "declareAttackers", attackers: attackPick.map(id => ({ id, target })) });
                setAttackPick([]);
              }}
            >
              Angriff bestätigen
            </button>
          )}
          <button type="button" className="secondary" onClick={() => (setAttackPick([]), act({ type: "pass" }))}>Kein Angriff</button>
        </div>
      );
    }
    if (awaitingMe && step === "blockers") {
      return (
        <div className="bar" role="status">
          <strong>
            Du wirst angegriffen. {blockPick ? "Klicke jetzt den Angreifer an, den diese Kreatur blocken soll." : "Klicke eine deiner Kreaturen an, dann den Angreifer."}
            {Object.keys(blocks).length > 0 ? ` (${Object.keys(blocks).length} Block${Object.keys(blocks).length === 1 ? "" : "s"})` : ""}
          </strong>
          <button
            type="button"
            className="primary"
            onClick={() => {
              act({ type: "declareBlockers", blocks: Object.entries(blocks).map(([blocker, attacker]) => ({ blocker, attacker })) });
              setBlocks({});
              setBlockPick(null);
            }}
          >
            {Object.keys(blocks).length === 0 ? "Nicht blocken" : "Blocken bestätigen"}
          </button>
          {Object.keys(blocks).length > 0 && <button type="button" className="secondary" onClick={() => setBlocks({})}>Zurücksetzen</button>}
        </div>
      );
    }
    if (iHavePriority) {
      return (
        <div className="bar" role="status">
          <span className="chip mine">Du hast Priorität</span>
          <button type="button" className="primary go" onClick={() => act({ type: "pass" })}>{goLabel}</button>
        </div>
      );
    }
    return (
      <div className="bar" role="status">
        <span className="muted">
          {game.priority
            ? `${nameOf(game.priority)} hat Priorität …`
            : game.combat?.awaiting.length
              ? `${game.combat.awaiting.map(nameOf).join(", ")} bestimmt Blocker …`
              : game.pendingDiscard
                ? `${nameOf(game.pendingDiscard.userId)} wirft Karten ab …`
                : "Warten …"}
        </span>
      </div>
    );
  };

  const zoneOwner = zoneView ? game.players.find(player => player.userId === zoneView.owner) : undefined;
  const zoneCards: GameCard[] =
    zoneOwner && zoneView ? (zoneView.zone === "library" ? (zoneOwner.looking ?? []) : zoneOwner[zoneView.zone as "graveyard" | "exile" | "command" | "hand"]) : [];

  return (
    <section className="table" style={{ backgroundImage: `url(${tableImage})` }} aria-label="Spieltisch">
      <header className="table-top">
        <div className="turn">
          <strong>Zug {game.turn.number}</strong>
          <span className="muted">{nameOf(game.turn.active)}</span>
        </div>
        <div className="steps" aria-label="Schritt">
          {STEPS.map(item => (
            <span key={item} className={`step${step === item ? " on" : ""}`}>{STEP_LABELS[item]}</span>
          ))}
        </div>
        <button type="button" className="ticker" onClick={() => setLogOpen(true)} title="Spielverlauf öffnen">
          {game.log.at(-1)?.text ?? ""}
        </button>
        <button type="button" className="secondary menu-btn" aria-label="Weitere Aktionen" onClick={gameMenu}>⋯</button>
      </header>

      <div className="table-body">
        <div className="table-seats">
          <div className={`opps${opponents.length > 1 ? " multi" : ""}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, opponents.length)}, minmax(0, 1fr))` }}>
            {opponents.map(renderSeat)}
          </div>
          {renderSeat(me)}
        </div>

        {game.stack.length > 0 && (
          <aside className="stack" aria-label="Stapel">
            <h3>Stapel</h3>
            {[...game.stack].reverse().map((item, index) => (
              <div key={item.sid} className={`stack-item${index === 0 ? " top" : ""}`}>
                {item.card ? (
                  <GameCardTile card={item.card} size="sm" onHover={setHover} onMenu={cardMenu} onSelect={clickCard} />
                ) : (
                  <span className="stack-ability">{item.text}</span>
                )}
                <span className="muted">{nameOf(item.controller)}</span>
              </div>
            ))}
          </aside>
        )}
      </div>

      {renderBar()}

      <Preview card={previewCard} />

      {zoneView && zoneOwner && (
        <div className="modal-back" onClick={() => (zoneView.zone === "library" && act({ type: "closeLook" }), setZoneView(null))}>
          <div className="modal" role="dialog" aria-label={ZONE_LABELS[zoneView.zone]} onClick={event => event.stopPropagation()}>
            <div className="modal-head">
              <h3>
                {ZONE_LABELS[zoneView.zone]} von {zoneOwner.name}
                {zoneView.zone === "library" ? " (oberste Karten zuerst)" : ""}
              </h3>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (zoneView.zone === "library") act({ type: "closeLook" });
                  setZoneView(null);
                }}
              >
                Schließen
              </button>
            </div>
            <div className="zone-list">
              {zoneCards.length === 0 && <span className="muted">Leer.</span>}
              {[...zoneCards].reverse().map(card => (
                <GameCardTile key={card.id} {...tileProps(card)} size="md" />
              ))}
            </div>
            <p className="muted">Rechtsklick oder langes Drücken auf eine Karte zeigt die Möglichkeiten; Karten lassen sich auf den Tisch ziehen.</p>
          </div>
        </div>
      )}

      {castX && (
        <div className="modal-back">
          <div className="modal small" role="dialog" aria-label="X wählen">
            <h3>{castX.name}: Wert für X</h3>
            <div className="table-actions">
              <input
                type="number"
                min={0}
                max={99}
                value={castX.value}
                onChange={event => setCastX({ ...castX, value: Math.max(0, Number(event.target.value) || 0) })}
                aria-label="Wert für X"
              />
              <button
                type="button"
                className="primary"
                onClick={() => {
                  act({ type: "cast", id: castX.id, x: castX.value });
                  setCastX(null);
                }}
              >
                Wirken
              </button>
              <button type="button" className="secondary" onClick={() => setCastX(null)}>Abbrechen</button>
            </div>
          </div>
        </div>
      )}

      {logOpen && (
        <div className="modal-back" onClick={() => setLogOpen(false)}>
          <div className="modal small" role="dialog" aria-label="Spielverlauf" onClick={event => event.stopPropagation()}>
            <div className="modal-head">
              <h3>Spielverlauf</h3>
              <button type="button" className="secondary" onClick={() => setLogOpen(false)}>Schließen</button>
            </div>
            <ol className="log" reversed>
              {[...game.log].reverse().map(line => (
                <li key={line.n}>{line.text}</li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}

function Preview({ card }: { card: GameCard | null }) {
  if (!card || card.name === undefined) return null;
  return (
    <div className="preview" aria-label="Kartenvorschau">
      {card.imageUri ? (
        <img src={card.imageUri} alt={card.name} />
      ) : (
        <div className="preview-text">
          <strong>{card.name}</strong>
          <span>{card.typeLine}</span>
        </div>
      )}
      {card.keywords && card.keywords.length > 0 && <div className="preview-kw">{card.keywords.join(", ")}</div>}
    </div>
  );
}
