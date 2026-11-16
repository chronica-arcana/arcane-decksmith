import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { GameAction, GameCard, GamePlayer, GameStep, GameView, GameZone } from "../../gameClient";
import GameCardTile from "./GameCardTile";
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
  main1: "Hauptphase 1",
  attackers: "Angreifer",
  blockers: "Blocker",
  damage: "Kampfschaden",
  main2: "Hauptphase 2",
  end: "Zugende"
};
const STEPS: GameStep[] = ["main1", "attackers", "blockers", "damage", "main2", "end"];
const MANA_COLORS = ["W", "U", "B", "R", "G", "C"] as const;
const PLAYER_COUNTER_LABELS = { poison: "Gift", energy: "Energie", experience: "Erfahrung" } as const;

function PoolView({ pool }: { pool: GamePlayer["pool"] }) {
  const filled = MANA_COLORS.filter(color => pool[color] > 0);
  if (filled.length === 0) return null;
  return (
    <span className="mat-pool" aria-label="Manapool">
      {filled.map(color => (
        <span key={color} className={`mat-mana ${color}`} title={`${pool[color]}× ${color}`}>
          {pool[color]}
        </span>
      ))}
    </span>
  );
}

/** Der Spieltisch (Spielmatte): Gegner oben, eigener Bereich unten, Stapel, Hand als Fächer, Kampf und Aktionen. */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<GameCard | null>(null);
  const [zoneView, setZoneView] = useState<{ owner: string; zone: GameZone } | null>(null);
  const [bottomPick, setBottomPick] = useState<string[]>([]);
  const [discardPick, setDiscardPick] = useState<string[]>([]);
  const [attackPick, setAttackPick] = useState<string[]>([]);
  const [attackTarget, setAttackTarget] = useState("");
  const [blockPick, setBlockPick] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<Record<string, string>>({});
  const [tokenName, setTokenName] = useState("");
  const [abilityText, setAbilityText] = useState("");
  const [counterKind, setCounterKind] = useState("+1/+1");
  const [lookCount, setLookCount] = useState(3);
  const [castX, setCastX] = useState<{ id: string; name: string; value: number } | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);

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
  const alive = (player: GamePlayer) => !player.eliminated;
  const nameOf = (userId: string | null) => game.players.find(player => player.userId === userId)?.name ?? "";
  const step = game.turn.phase;
  const isActive = game.turn.active === game.you;
  const iHavePriority = game.priority === game.you && game.phase === "playing" && !me.eliminated;
  const selected = selectedId ? allCards.get(selectedId) : undefined;
  const preview = hover ?? selected ?? null;
  const act = (action: GameAction) => send(action);
  const target = attackTarget || opponents.find(alive)?.userId || "";
  const awaitingMe = Boolean(game.combat?.awaiting.includes(game.you));
  const attackedMe = game.combat?.attackers.filter(attacker => attacker.target === game.you) ?? [];
  const bottomNeeded = Math.max(0, me.mulligans - (game.format === "commander" ? 1 : 0));
  const hostName = nameOf(hostId);
  const winner = game.players.find(player => player.userId === game.winner);

  // ---------- Aktionen mit Hilfslogik ----------
  const primaryPlay = (card: GameCard, free = false) => {
    if (card.play?.kind === "land") return act({ type: "playLand", id: card.id });
    if (!free && /\{X\}/i.test(card.manaCost ?? "")) return setCastX({ id: card.id, name: card.name ?? "", value: 0 });
    act({ type: "cast", id: card.id, ...(free ? { free: true } : {}) });
  };

  const selectCard = (card: GameCard) => {
    // Kampf: Angreifer wählen
    if (isActive && step === "attackers" && card.owner === game.you && card.kind === "creature") {
      if (!card.tapped && !card.sick && !card.keywords?.includes("defender") && game.players.some(alive)) {
        setAttackPick(current => (current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id]));
        return;
      }
    }
    // Kampf: Blocker bestimmen
    if (awaitingMe && step === "blockers") {
      if (card.owner === game.you && card.kind === "creature" && !card.tapped) {
        setBlockPick(card.id === blockPick ? null : card.id);
        return;
      }
      if (blockPick && attackedMe.some(attacker => attacker.id === card.id)) {
        setBlocks(current => ({ ...current, [blockPick]: card.id }));
        setBlockPick(null);
        return;
      }
    }
    setSelectedId(current => (current === card.id ? null : card.id));
  };

  const onDragStart = (card: GameCard, event: DragEvent) => {
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
  };
  const dragId = (event: DragEvent) => event.dataTransfer.getData("text/plain");
  const dropProps = (key: string, handler: (card: GameCard) => void) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDropZone(key);
    },
    onDragLeave: () => setDropZone(current => (current === key ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropZone(null);
      const card = allCards.get(dragId(event));
      if (card && card.owner === game.you) handler(card);
    }
  });
  const zoneOf = (card: GameCard): GameZone | null => {
    for (const zone of ["hand", "battlefield", "graveyard", "exile", "command"] as const) {
      if (me[zone].some(item => item.id === card.id)) return zone;
    }
    return me.looking?.some(item => item.id === card.id) ? "library" : null;
  };
  const moveCard = (card: GameCard, to: GameZone, extra: { position?: "top" | "bottom"; faceDown?: boolean } = {}) =>
    act({ type: "move", id: card.id, to, ...extra });

  // ---------- Mulligan ----------
  if (game.phase === "mulligan") {
    return (
      <section className="mat-main" aria-label="Spieltisch">
        <div className="panel">
          <h3>Starthand</h3>
          <p className="muted">
            Behalte deine sieben Karten oder nimm einen Mulligan (London-Mulligan: neue sieben Karten, danach legst du so viele Karten unter die
            Bibliothek, wie du Mulligans genommen hast{game.format === "commander" ? "; der erste Mulligan ist kostenlos" : ""}).
          </p>
          {me.kept ? (
            <div className="notice" role="status">Du hast behalten. Warte auf die anderen Spieler …</div>
          ) : (
            <>
              <div className="mat-row">
                {me.hand.map(card => (
                  <GameCardTile
                    key={card.id}
                    card={card}
                    size="lg"
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
                  Wähle {bottomNeeded} Karte{bottomNeeded === 1 ? "" : "n"}, die unter die Bibliothek kommen ({bottomPick.length} gewählt).
                </p>
              )}
              <div className="mat-dock">
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
                <button
                  type="button"
                  className="secondary"
                  disabled={me.mulligans >= 6}
                  onClick={() => {
                    setBottomPick([]);
                    act({ type: "mulligan" });
                  }}
                >
                  Mulligan ({me.mulligans} bisher)
                </button>
              </div>
            </>
          )}
          <ul>
            {game.players.map(player => (
              <li key={player.userId}>
                {player.name}: {player.eliminated ? `ausgeschieden (${player.eliminated})` : player.kept ? "hat behalten" : "entscheidet noch"}
              </li>
            ))}
          </ul>
        </div>
        <LogPanel game={game} />
      </section>
    );
  }

  // ---------- Kopfzeile / Weiter-Knopf ----------
  const goLabel = !iHavePriority
    ? game.priority
      ? `Warte auf ${nameOf(game.priority)}`
      : game.combat?.awaiting.length
        ? "Blocker werden bestimmt …"
        : game.pendingDiscard
          ? "Warte auf Abwurf …"
          : "Warten …"
    : game.stack.length > 0
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

  // ---------- Zone ansehen ----------
  const zoneOwner = zoneView ? game.players.find(player => player.userId === zoneView.owner) : undefined;
  const zoneCards: GameCard[] =
    zoneOwner && zoneView ? (zoneView.zone === "library" ? (zoneOwner.looking ?? []) : zoneOwner[zoneView.zone as "graveyard" | "exile" | "command" | "hand"]) : [];

  // ---------- Spielerbereich ----------
  const renderSeat = (player: GamePlayer) => {
    const own = player.userId === game.you;
    const active = game.turn.active === player.userId && game.phase === "playing";
    const rows = {
      creature: player.battlefield.filter(card => card.kind === "creature"),
      other: player.battlefield.filter(card => card.kind === "other"),
      land: player.battlefield.filter(card => card.kind === "land")
    };
    const size = own ? "md" : "sm";
    const tile = (card: GameCard, tileSize: "sm" | "md" = size) => (
      <GameCardTile
        key={card.id}
        card={card}
        size={tileSize}
        selected={card.id === selectedId}
        marked={
          attackPick.includes(card.id) ? "attack" : blockPick === card.id ? "pick" : blocks[card.id] ? "block" : null
        }
        onSelect={selectCard}
        onHover={setHover}
      />
    );
    return (
      <div
        key={player.userId}
        className={`mat-seat${own ? " me" : ""}${active ? " active" : ""}${player.eliminated ? " out" : ""}${own && dropZone === "battlefield" ? " mat-drop" : ""}`}
        aria-label={`Bereich von ${player.name}`}
        {...(own && !player.eliminated
          ? dropProps("battlefield", card => {
              const zone = zoneOf(card);
              if (zone === "hand" || zone === "command") primaryPlay(card);
              else if (zone) moveCard(card, "battlefield");
            })
          : {})}
      >
        <div className="mat-head">
          <span className="mat-name">{player.name}{own ? " (du)" : ""}</span>
          {active && <span className="mat-chip">am Zug</span>}
          {game.priority === player.userId && <span className="mat-chip">hat Priorität</span>}
          {player.eliminated && <span className="error">ausgeschieden: {player.eliminated}</span>}
          <span className="mat-life" aria-label={own ? "Leben" : `Leben von ${player.name}`}>
            {own && !player.eliminated && (
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: -1 })} aria-label="Leben minus 1">−</button>
            )}
            <span>{player.life}</span>
            {own && !player.eliminated && (
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: 1 })} aria-label="Leben plus 1">+</button>
            )}
          </span>
          <PoolView pool={player.pool} />
          {player.deckName && <span className="muted">{player.deckName}</span>}
        </div>

        <div className="mat-chips">
          {(["poison", "energy", "experience"] as const).map(kind =>
            player[kind] > 0 || (own && kind === "poison") ? (
              <span key={kind} className="mat-chip">
                {PLAYER_COUNTER_LABELS[kind]}: {player[kind]}
                {own && (
                  <>
                    <button type="button" className="secondary" onClick={() => act({ type: "pcounter", kind, delta: 1 })} aria-label={`${PLAYER_COUNTER_LABELS[kind]} plus`}>+</button>
                    <button type="button" className="secondary" onClick={() => act({ type: "pcounter", kind, delta: -1 })} aria-label={`${PLAYER_COUNTER_LABELS[kind]} minus`}>−</button>
                  </>
                )}
              </span>
            ) : null
          )}
          {game.format === "commander" &&
            game.players
              .filter(other => other.userId !== player.userId && (player.cmdDamage[other.userId] ?? 0) > 0)
              .map(other => (
                <span key={other.userId} className="mat-chip">
                  Kommandantenschaden von {other.name}: {player.cmdDamage[other.userId]}/21
                  {own && (
                    <>
                      <button type="button" className="secondary" onClick={() => act({ type: "cmddmg", from: other.userId, delta: 1 })} aria-label={`Kommandantenschaden von ${other.name} plus`}>+</button>
                      <button type="button" className="secondary" onClick={() => act({ type: "cmddmg", from: other.userId, delta: -1 })} aria-label={`Kommandantenschaden von ${other.name} minus`}>−</button>
                    </>
                  )}
                </span>
              ))}
          {game.format === "commander" && player.command.length > 0 &&
            player.command.map(card => (
              <span key={card.id} className="mat-chip">
                {card.name}: Steuer +{2 * (player.cmdCasts[card.id] ?? 0)}
              </span>
            ))}
        </div>

        <div className="mat-piles">
          {(["library", "hand"] as const).map(zone => (
            <span key={zone} className="mat-chip">{ZONE_LABELS[zone]}: {player.counts[zone]}</span>
          ))}
          {(["graveyard", "exile", "command"] as const).map(zone =>
            zone === "command" && game.format !== "commander" ? null : (
              <button
                key={zone}
                type="button"
                className={`secondary mat-pile${own && dropZone === zone ? " mat-drop" : ""}`}
                onClick={() => setZoneView(current => (current?.owner === player.userId && current.zone === zone ? null : { owner: player.userId, zone }))}
                {...(own ? dropProps(zone, card => moveCard(card, zone)) : {})}
              >
                {ZONE_LABELS[zone]}: {player.counts[zone]}
              </button>
            )
          )}
          {own && (
            <button
              type="button"
              className={`secondary mat-pile${dropZone === "library" ? " mat-drop" : ""}`}
              onClick={() => {
                act({ type: "look", count: lookCount });
                setZoneView({ owner: game.you, zone: "library" });
              }}
              {...dropProps("library", card => moveCard(card, "library", { position: "top" }))}
              title="Oberste Karten ansehen; Karten hierher ziehen legt sie oben auf die Bibliothek"
            >
              Bibliothek ansehen
            </button>
          )}
        </div>

        <div className="mat-rows">
          {rows.creature.length > 0 && (
            <div className="mat-row" aria-label={`Kreaturen von ${player.name}`}>
              <span className="mat-row-label">Kreaturen</span>
              {rows.creature.map(card => tile(card))}
            </div>
          )}
          {rows.other.length + rows.land.length > 0 && (
            <div className="mat-row" aria-label={`Länder und Permanents von ${player.name}`}>
              <span className="mat-row-label">Permanents und Länder</span>
              {rows.other.map(card => tile(card))}
              {rows.land.map(card => tile(card, "sm"))}
            </div>
          )}
          {player.battlefield.length === 0 && <span className="muted">Keine Karten im Spiel.</span>}
        </div>
      </div>
    );
  };

  const selectedZone = selected && selected.owner === game.you ? zoneOf(selected) : null;
  const canAct = game.phase === "playing" && !me.eliminated;
  const onStack = selected ? game.stack.some(item => item.card?.id === selected.id) : false;

  return (
    <section className="mat" aria-label="Spieltisch">
      <div className="mat-main">
        {/* Kopfzeile */}
        <div className="panel mat-bar">
          <div className="mat-turn">
            <strong>Zug {game.turn.number}</strong>
            <span className="muted">{nameOf(game.turn.active)}</span>
            {isActive && <span className="muted">Länder gespielt: {game.turn.landsPlayed}/1</span>}
          </div>
          <div className="mat-steps" aria-label="Schritt">
            {STEPS.map(item => (
              <span key={item} className={`mat-step${step === item ? " on" : ""}`}>{STEP_LABELS[item]}</span>
            ))}
          </div>
          {game.phase === "playing" && (
            <div className="mat-dock">
              <span className={`mat-priority${iHavePriority ? " mine" : ""}`} role="status">
                {iHavePriority ? "Du hast Priorität" : game.priority ? `${nameOf(game.priority)} hat Priorität` : "Kein Spieler hat Priorität"}
              </span>
              <button type="button" className="primary mat-go" disabled={!iHavePriority} onClick={() => act({ type: "pass" })}>
                {goLabel}
              </button>
              <label className="muted">
                <input
                  type="checkbox"
                  checked={me.autoPass ?? true}
                  onChange={event => act({ type: "autoPass", value: event.target.checked })}
                />{" "}
                Bei leerem Stapel automatisch passen
              </label>
            </div>
          )}
        </div>

        {game.phase === "ended" && (
          <div className="notice" role="status">
            <strong>Das Spiel ist beendet.</strong> {winner ? `${winner.name} gewinnt.` : "Kein Sieger."}
            <div className="mat-dock">
              {game.you === hostId ? (
                <button type="button" className="primary" onClick={onRematch}>Revanche</button>
              ) : (
                <span className="muted">Der Gastgeber ({hostName}) kann eine Revanche starten.</span>
              )}
              <button type="button" className="secondary" onClick={onLeave}>Raum verlassen</button>
            </div>
          </div>
        )}

        {/* Fragen an den Spieler */}
        {me.prompts.map(prompt => (
          <div key={prompt.id} className="mat-banner" role="alert">
            <strong>{allCards.get(prompt.id)?.name ?? "Dein Kommandant"} hat das Spiel verlassen.</strong>
            <span>In die Kommandozone zurücklegen?</span>
            <div className="row">
              <button type="button" className="primary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: true })}>Ja, in die Kommandozone</button>
              <button type="button" className="secondary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: false })}>Nein</button>
            </div>
          </div>
        ))}

        {game.pendingDiscard?.userId === game.you && (
          <div className="mat-banner" role="alert">
            <strong>Handkartenlimit: Wirf {game.pendingDiscard.count} Karte{game.pendingDiscard.count === 1 ? "" : "n"} ab.</strong>
            <span>Klicke die Karten in deiner Hand an ({discardPick.length} gewählt).</span>
            <div className="row">
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
          </div>
        )}

        {isActive && step === "attackers" && game.phase === "playing" && (
          <div className="mat-banner" role="status">
            <strong>Angriff</strong>
            <span>Klicke deine Kreaturen an, die angreifen sollen ({attackPick.length} gewählt). Angreifer werden getappt, außer sie haben Wachsamkeit.</span>
            <div className="row">
              {opponents.filter(alive).length > 1 && (
                <label>
                  Ziel{" "}
                  <select value={target} onChange={event => setAttackTarget(event.target.value)} aria-label="Angriffsziel">
                    {opponents.filter(alive).map(player => (
                      <option key={player.userId} value={player.userId}>{player.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="primary"
                disabled={!iHavePriority || attackPick.length === 0}
                onClick={() => {
                  act({ type: "declareAttackers", attackers: attackPick.map(id => ({ id, target })) });
                  setAttackPick([]);
                }}
              >
                Angriff bestätigen
              </button>
            </div>
          </div>
        )}

        {awaitingMe && step === "blockers" && (
          <div className="mat-banner" role="status">
            <strong>Du wirst angegriffen</strong>
            <span>
              Wähle eine deiner Kreaturen und dann den Angreifer, den sie blocken soll. Zugewiesen: {Object.keys(blocks).length}.
              {blockPick ? " Jetzt den Angreifer anklicken." : ""}
            </span>
            <div className="row">
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
              {Object.keys(blocks).length > 0 && (
                <button type="button" className="secondary" onClick={() => setBlocks({})}>Zuweisung zurücksetzen</button>
              )}
            </div>
          </div>
        )}

        {/* Gegner */}
        <div className="mat-opps">{opponents.map(renderSeat)}</div>

        {/* Stapel */}
        {game.stack.length > 0 && (
          <div className="panel mat-stack" aria-label="Stapel">
            <h3>Stapel ({game.stack.length}) – oberster zuerst</h3>
            {[...game.stack].reverse().map((item, index) => (
              <div key={item.sid} className={`mat-stack-item${index === 0 ? " top" : ""}`}>
                {item.card ? (
                  <GameCardTile card={item.card} size="sm" onHover={setHover} onSelect={selectCard} />
                ) : (
                  <span className="mat-chip">Fähigkeit</span>
                )}
                <div>
                  <strong>{item.card?.name ?? item.text}</strong>
                  <div className="muted">von {nameOf(item.controller)}</div>
                </div>
                {iHavePriority && (
                  <button type="button" className="secondary" onClick={() => act({ type: "counterSpell", sid: item.sid })}>Neutralisieren</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Ich */}
        {renderSeat(me)}

        {/* Zone ansehen */}
        {zoneView && zoneOwner && (
          <div className="panel">
            <div className="mat-bar">
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
            {zoneView.zone === "library" && zoneOwner.userId === game.you && (
              <div className="mat-dock">
                <label>
                  Oberste{" "}
                  <input type="number" min={1} max={20} value={lookCount} onChange={event => setLookCount(Number(event.target.value) || 1)} style={{ width: "4.5em" }} aria-label="Anzahl Karten ansehen" />
                </label>
                <button type="button" className="secondary" onClick={() => act({ type: "look", count: lookCount })}>ansehen</button>
                <button type="button" className="secondary" onClick={() => act({ type: "look", count: "all" })}>Bibliothek durchsuchen</button>
                <button type="button" className="secondary" onClick={() => act({ type: "shuffle" })}>Mischen</button>
              </div>
            )}
            <div className="mat-zone-list">
              {zoneCards.length === 0 && <span className="muted">Leer.</span>}
              {zoneCards.map(card => (
                <GameCardTile key={card.id} card={card} size="sm" selected={card.id === selectedId} onSelect={selectCard} onHover={setHover} onDragStart={card.owner === game.you ? onDragStart : undefined} />
              ))}
            </div>
          </div>
        )}

        {/* Hand */}
        <div className="panel">
          <div className="mat-bar">
            <h3>Hand ({me.hand.length})</h3>
            {canAct && (
              <div className="mat-dock">
                <button type="button" className="secondary" onClick={() => act({ type: "draw" })}>Karte ziehen</button>
                <button type="button" className="secondary" onClick={() => act({ type: "untapAll" })}>Alles enttappen</button>
              </div>
            )}
          </div>
          <div
            className={`mat-hand${me.hand.length > 8 ? " crowded" : ""}${dropZone === "hand" ? " mat-drop" : ""}`}
            aria-label="Deine Hand"
            {...dropProps("hand", card => moveCard(card, "hand"))}
          >
            {me.hand.length === 0 && <span className="muted">Keine Karten auf der Hand.</span>}
            {me.hand.map(card => (
              <GameCardTile
                key={card.id}
                card={card}
                size="md"
                selected={card.id === selectedId}
                glow={Boolean(card.play?.ok) && canAct}
                marked={discardPick.includes(card.id) ? "pick" : null}
                onHover={setHover}
                onDragStart={onDragStart}
                onSelect={c => {
                  if (game.pendingDiscard?.userId === game.you) {
                    setDiscardPick(current => (current.includes(c.id) ? current.filter(id => id !== c.id) : [...current, c.id]));
                  } else selectCard(c);
                }}
              />
            ))}
          </div>
        </div>

        {/* Aktionen für die gewählte Karte */}
        {selected && (
          <div className="panel" aria-label="Ausgewählte Karte">
            <h3>{selected.name ?? "Verdeckte Karte"}</h3>
            {selected.typeLine && <p className="muted">{selected.typeLine}{selected.manaCost ? ` · ${selected.manaCost}` : ""}</p>}
            {selected.owner === game.you && selectedZone && canAct && !onStack ? (
              <div className="mat-dock">
                {(selectedZone === "hand" || selectedZone === "command") && selected.play && (
                  <>
                    <button type="button" className="primary" disabled={!selected.play.ok} onClick={() => primaryPlay(selected)}>
                      {selected.play.kind === "land" ? "Land spielen" : "Wirken"}
                    </button>
                    {selected.play.kind === "spell" && (
                      <button type="button" className="secondary" disabled={!iHavePriority} onClick={() => primaryPlay(selected, true)}>Ohne Kosten wirken</button>
                    )}
                  </>
                )}
                {selectedZone === "battlefield" && selected.mana && !selected.tapped && !selected.sick && (
                  <button type="button" className="secondary" onClick={() => act({ type: "tapMana", id: selected.id })}>Für Mana tappen</button>
                )}
                {selectedZone === "battlefield" && selected.mana && !selected.tapped && !selected.sick &&
                  MANA_COLORS.map(color => (
                    <button key={color} type="button" className={`secondary mat-mana ${color}`} aria-label={`Mana ${color}`} onClick={() => act({ type: "tapMana", id: selected.id, color })}>
                      {color}
                    </button>
                  ))}
                {selectedZone === "battlefield" && (
                  <>
                    <button type="button" className="secondary" onClick={() => act({ type: "tap", id: selected.id })}>{selected.tapped ? "Enttappen" : "Tappen"}</button>
                    <button type="button" className="secondary" onClick={() => act({ type: "flip", id: selected.id })}>Umdrehen</button>
                    <input value={counterKind} onChange={event => setCounterKind(event.target.value)} aria-label="Markerart" style={{ width: "6em" }} maxLength={20} />
                    <button type="button" className="secondary" onClick={() => act({ type: "counter", id: selected.id, kind: counterKind, delta: 1 })}>Marker +</button>
                    <button type="button" className="secondary" onClick={() => act({ type: "counter", id: selected.id, kind: counterKind, delta: -1 })}>Marker −</button>
                  </>
                )}
                {selectedZone === "hand" && (
                  <>
                    <button type="button" className="secondary" onClick={() => act({ type: "reveal", id: selected.id })}>Zeigen / verbergen</button>
                    <button type="button" className="secondary" onClick={() => moveCard(selected, "battlefield", { faceDown: true })}>Verdeckt ausspielen</button>
                  </>
                )}
                {(["battlefield", "hand", "graveyard", "exile", "command"] as const)
                  .filter(zone => zone !== selectedZone && (zone !== "command" || game.format === "commander"))
                  .map(zone => (
                    <button key={zone} type="button" className="secondary" onClick={() => moveCard(selected, zone)}>
                      {selectedZone === "hand" && zone === "battlefield" ? "Manuell auslegen" : `→ ${ZONE_LABELS[zone]}`}
                    </button>
                  ))}
                <button type="button" className="secondary" onClick={() => moveCard(selected, "library", { position: "top" })}>→ Bibliothek oben</button>
                <button type="button" className="secondary" onClick={() => moveCard(selected, "library", { position: "bottom" })}>→ Bibliothek unten</button>
              </div>
            ) : (
              <p className="muted">{selected.owner === game.you ? "" : "Karte eines anderen Spielers."}</p>
            )}
            {selected.keywords && selected.keywords.length > 0 && <p className="muted">Schlüsselwörter: {selected.keywords.join(", ")}</p>}
          </div>
        )}

        {castX && (
          <div className="mat-banner" role="dialog" aria-label="X wählen">
            <strong>{castX.name}: Wert für X</strong>
            <div className="row">
              <input
                type="number"
                min={0}
                max={99}
                value={castX.value}
                onChange={event => setCastX({ ...castX, value: Math.max(0, Number(event.target.value) || 0) })}
                aria-label="Wert für X"
                style={{ width: "5em" }}
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
        )}

        {/* Werkzeuge */}
        <div className="panel">
          <h3>Werkzeuge</h3>
          <div className="mat-tools">
            <input value={tokenName} onChange={event => setTokenName(event.target.value)} placeholder="Spielstein, z. B. Goblin 1/1" aria-label="Name des Spielsteins" maxLength={40} />
            <button type="button" className="secondary" disabled={!tokenName.trim()} onClick={() => { act({ type: "token", name: tokenName }); setTokenName(""); }}>Spielstein erzeugen</button>
            <input value={abilityText} onChange={event => setAbilityText(event.target.value)} placeholder="Fähigkeit/Auslöser auf den Stapel" aria-label="Fähigkeit auf den Stapel" maxLength={100} />
            <button type="button" className="secondary" disabled={!abilityText.trim() || !iHavePriority} onClick={() => { act({ type: "ability", text: abilityText }); setAbilityText(""); }}>Auf den Stapel</button>
            <button type="button" className="secondary" onClick={() => act({ type: "mill" })}>Oberste Karte mahlen</button>
            <button type="button" className="secondary" onClick={() => act({ type: "dice", sides: 6 })}>W6</button>
            <button type="button" className="secondary" onClick={() => act({ type: "dice", sides: 20 })}>W20</button>
            <button type="button" className="secondary" onClick={() => act({ type: "coin" })}>Münze</button>
            {canAct && isActive && game.stack.length === 0 && (
              <button type="button" className="secondary" onClick={() => act({ type: "endTurn" })}>Zug sofort beenden</button>
            )}
            {canAct && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (window.confirm("Wirklich aufgeben?")) act({ type: "concede" });
                }}
              >
                Aufgeben
              </button>
            )}
          </div>
        </div>
      </div>

      <aside className="mat-side">
        <div className="panel mat-preview" aria-label="Kartenvorschau">
          {preview?.imageUri && preview.name !== undefined ? (
            <img src={preview.imageUri} alt={preview.name} />
          ) : (
            <span className="muted">{preview?.name ?? "Fahre mit der Maus über eine Karte."}</span>
          )}
        </div>
        <LogPanel game={game} />
      </aside>
    </section>
  );
}

function LogPanel({ game }: { game: GameView }) {
  return (
    <div className="panel">
      <h3>Spielverlauf</h3>
      <ol className="mat-log" aria-label="Spielverlauf" reversed>
        {[...game.log].reverse().map(line => (
          <li key={line.n}>{line.text}</li>
        ))}
      </ol>
    </div>
  );
}
