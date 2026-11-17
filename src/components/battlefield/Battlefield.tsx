import { useMemo, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { GameAction, GameCard, GameView, GameZone } from "../../gameClient";
import tableImage from "../../assets/game/table.webp";
import ActionBar from "./ActionBar";
import { BattlefieldContext, type BattlefieldApi, type Mark } from "./BattlefieldContext";
import CardPreview from "./CardPreview";
import CardView from "./CardView";
import CenterZone from "./CenterZone";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import MulliganScreen from "./MulliganScreen";
import PhaseBar from "./PhaseBar";
import PlayerZone from "./PlayerZone";
import "./battlefield.css";

const ZONE_LABELS: Record<GameZone, string> = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};
const MANA_NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos" };

type Menu = { x: number; y: number; items: MenuItem[] } | null;

/**
 * Battlefield: der Spieltisch im Stil von MTG Arena. Gegner oben (gespiegelt), neutrale Mitte mit Stapel und Kampf,
 * eigener Platz unten, Phasenleiste rechts. Karten, Bilder und Mana-Symbole kommen von Scryfall.
 * Bedienung: Klick = Hauptaktion, Ziehen auf den Tisch spielt Karten, Rechtsklick oder langes Drücken zeigt die möglichen Aktionen.
 */
export default function Battlefield({
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
  const attackStep = canAct && isActive && step === "attackers" && game.stack.length === 0;
  const discarding = game.pendingDiscard?.userId === game.you;
  const previewCard = hover ?? (pinnedId ? allCards.get(pinnedId) : undefined) ?? null;
  const inCombat = new Set<string>();
  for (const card of allCards.values()) if (card.attacking || card.blocking) inCombat.add(card.id);

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
      event.stopPropagation();
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

  // ---------- Menüs und Klicks ----------
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

  const markOf = (card: GameCard): Mark =>
    attackPick.includes(card.id) ? "attack" : blockPick === card.id ? "pick" : blocks[card.id] ? "block" : discardPick.includes(card.id) ? "pick" : null;

  const libraryMenu = (event: MouseEvent) => {
    const look = (count: number | "all") => {
      act({ type: "look", count });
      setZoneView({ owner: game.you, zone: "library" });
    };
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: "Oberste 3 ansehen", onClick: () => look(3) },
        { label: "Oberste 5 ansehen", onClick: () => look(5) },
        { label: "Bibliothek durchsuchen", onClick: () => look("all") },
        { label: "Mischen", onClick: () => act({ type: "shuffle" }) },
        { label: "Oberste Karte mahlen", onClick: () => act({ type: "mill" }) }
      ]
    });
  };

  const api: BattlefieldApi = {
    game,
    me,
    opponents,
    canAct,
    iHavePriority,
    isActive,
    discarding,
    nameOf,
    act,
    moveCard,
    clickCard,
    cardMenu,
    setHover,
    onDragStart,
    dropProps,
    dropKey,
    dropOnTable,
    markOf,
    openZone: (owner, zone) => setZoneView(current => (current?.owner === owner && current.zone === zone ? null : { owner, zone })),
    libraryMenu,
    lifeOpen,
    toggleLife: () => setLifeOpen(open => !open),
    inCombat,
    allCards,
    pendingBlocks: blocks
  };

  if (game.phase === "mulligan") return <MulliganScreen game={game} me={me} act={act} background={tableImage} />;

  const zoneOwner = zoneView ? game.players.find(player => player.userId === zoneView.owner) : undefined;
  const zoneCards: GameCard[] =
    zoneOwner && zoneView ? (zoneView.zone === "library" ? (zoneOwner.looking ?? []) : zoneOwner[zoneView.zone as "graveyard" | "exile" | "command" | "hand"]) : [];

  return (
    <BattlefieldContext.Provider value={api}>
      <section className="arena" style={{ backgroundImage: `url(${tableImage})` }} aria-label="Spieltisch">
        <header className="arena-top">
          <button type="button" className="ticker" onClick={() => setLogOpen(true)} title="Spielverlauf öffnen">
            {game.log.at(-1)?.text ?? ""}
          </button>
          <button type="button" className="secondary menu-btn" aria-label="Weitere Aktionen" onClick={gameMenu}>⋯</button>
        </header>

        <div className="arena-grid">
          <div className="arena-main">
            <div className={`opps${opponents.length > 1 ? " multi" : ""}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, opponents.length)}, minmax(0, 1fr))` }}>
              {opponents.map(player => (
                <PlayerZone key={player.userId} player={player} />
              ))}
            </div>
            <CenterZone>
              <ActionBar
                game={game}
                me={me}
                hostId={hostId}
                nameOf={nameOf}
                allCards={allCards}
                act={act}
                iHavePriority={iHavePriority}
                isActive={isActive}
                discarding={discarding}
                attackStep={attackStep}
                awaitingMe={awaitingMe}
                livingOpponents={livingOpponents}
                attackPick={attackPick}
                clearAttackPick={() => setAttackPick([])}
                target={target}
                setAttackTarget={setAttackTarget}
                blockPick={blockPick}
                blocks={blocks}
                resetBlocks={() => {
                  setBlocks({});
                  setBlockPick(null);
                }}
                discardPick={discardPick}
                clearDiscardPick={() => setDiscardPick([])}
                onRematch={onRematch}
                onLeave={onLeave}
              />
            </CenterZone>
            <PlayerZone player={me} />
          </div>
          <PhaseBar game={game} activeName={nameOf(game.turn.active)} />
        </div>

        <CardPreview card={previewCard} />

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
                  <CardView
                    key={card.id}
                    card={card}
                    size="md"
                    marked={markOf(card)}
                    onSelect={clickCard}
                    onHover={setHover}
                    onMenu={cardMenu}
                    onDragStart={card.owner === game.you ? onDragStart : undefined}
                  />
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
              <div className="start-actions">
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
    </BattlefieldContext.Provider>
  );
}
