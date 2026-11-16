import { useMemo, useState } from "react";
import type { GameAction, GameCard, GamePlayer, GameView, GameZone } from "../../gameClient";
import "./game.css";

const ZONE_LABELS: Record<GameZone, string> = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};
const PHASE_LABELS: Record<string, string> = {
  beginning: "Anfang",
  main1: "Hauptphase 1",
  combat: "Kampf",
  main2: "Hauptphase 2",
  end: "Ende"
};
const PHASE_ORDER = ["beginning", "main1", "combat", "main2", "end"];
const PLAYER_COUNTER_LABELS = { poison: "Gift", energy: "Energie", experience: "Erfahrung" } as const;

function CardTile({
  card,
  selected,
  onSelect,
  small
}: {
  card: GameCard;
  selected?: boolean;
  onSelect?: (card: GameCard) => void;
  small?: boolean;
}) {
  const counters = Object.entries(card.counters);
  return (
    <button
      type="button"
      className={`game-card${card.tapped ? " tapped" : ""}${selected ? " selected" : ""}${small ? " small" : ""}`}
      onClick={() => onSelect?.(card)}
      aria-label={`${card.name ?? "Verdeckte Karte"}${card.tapped ? " (getappt)" : ""}`}
      title={card.name ?? "Verdeckte Karte"}
    >
      {card.name === undefined ? (
        <span className="back">Verdeckt</span>
      ) : card.imageUri ? (
        <img src={card.imageUri} alt={card.name} loading="lazy" />
      ) : (
        <span className="game-card-text">{card.name}</span>
      )}
      {card.token && <span className="badge token">Token</span>}
      {counters.length > 0 && <span className="badge">{counters.map(([kind, n]) => `${n}× ${kind}`).join(", ")}</span>}
    </button>
  );
}

/** Der Spieltisch: alle Spieler, eigene Hand, Aktionen, Verlauf. Der Server entscheidet über alles. */
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
  const [zoneView, setZoneView] = useState<{ owner: string; zone: GameZone } | null>(null);
  const [bottomPick, setBottomPick] = useState<string[]>([]);
  const [tokenName, setTokenName] = useState("");
  const [counterKind, setCounterKind] = useState("+1/+1");
  const [lookCount, setLookCount] = useState(3);

  const allCards = useMemo(() => {
    const map = new Map<string, GameCard>();
    for (const player of game.players) {
      for (const list of [player.hand, player.battlefield, player.graveyard, player.exile, player.command, player.looking ?? []]) {
        for (const card of list) map.set(card.id, card);
      }
    }
    return map;
  }, [game]);

  if (!me) return null;
  const selected = selectedId ? allCards.get(selectedId) : undefined;
  const mine = selected && selected.owner === game.you;
  const myZoneOf = (id: string): GameZone | null => {
    for (const zone of ["hand", "battlefield", "graveyard", "exile", "command"] as const) {
      if (me[zone].some(card => card.id === id)) return zone;
    }
    return me.looking?.some(card => card.id === id) ? "library" : null;
  };
  const selectedZone = selected && mine ? myZoneOf(selected.id) : null;
  const isActive = game.turn.active === game.you;
  const hostName = game.players.find(player => player.userId === hostId)?.name ?? "";
  const winner = game.players.find(player => player.userId === game.winner);
  const bottomNeeded = Math.max(0, me.mulligans - (game.format === "commander" ? 1 : 0));

  const act = (action: GameAction) => send(action);
  const moveTo = (to: GameZone, extra: { position?: "top" | "bottom"; faceDown?: boolean } = {}) => {
    if (selected && mine) act({ type: "move", id: selected.id, to, ...extra });
  };

  // ---------- Mulligan ----------
  if (game.phase === "mulligan") {
    return (
      <section className="game-table">
        <div className="panel">
          <h3>Starthand</h3>
          <p className="muted">
            Behalte deine sieben Karten oder nimm einen Mulligan (London-Mulligan: neue sieben Karten, danach legst du so viele Karten
            unter die Bibliothek, wie du Mulligans genommen hast{game.format === "commander" ? "; der erste Mulligan ist kostenlos" : ""}).
          </p>
          {me.kept ? (
            <div className="notice" role="status">Du hast behalten. Warte auf die anderen Spieler …</div>
          ) : (
            <>
              <div className="game-hand">
                {me.hand.map(card => (
                  <CardTile
                    key={card.id}
                    card={card}
                    selected={bottomPick.includes(card.id)}
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
              <div className="game-actions">
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

  const zoneOwner = zoneView ? game.players.find(player => player.userId === zoneView.owner) : undefined;
  const zoneCards: GameCard[] =
    zoneOwner && zoneView ? (zoneView.zone === "library" ? (zoneOwner.looking ?? []) : zoneOwner[zoneView.zone as "graveyard" | "exile" | "command" | "hand"]) : [];

  const renderSeat = (player: GamePlayer) => {
    const own = player.userId === game.you;
    const active = game.turn.active === player.userId;
    return (
      <div key={player.userId} className={`panel game-seat${active ? " active" : ""}${player.eliminated ? " out" : ""}`}>
        <div className="game-seat-head">
          <strong>{player.name}{own ? " (du)" : ""}</strong>
          {active && game.phase === "playing" && <span className="muted">am Zug</span>}
          {player.eliminated && <span className="error">ausgeschieden: {player.eliminated}</span>}
          {own && !player.eliminated && (
            <>
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: -1 })} aria-label="Leben minus 1">−1</button>
              <span className="game-life" aria-label="Leben">{player.life}</span>
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: 1 })} aria-label="Leben plus 1">+1</button>
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: -5 })}>−5</button>
              <button type="button" className="secondary" onClick={() => act({ type: "life", delta: 5 })}>+5</button>
            </>
          )}
          {!own && <span className="game-life" aria-label={`Leben von ${player.name}`}>{player.life}</span>}
        </div>
        <div className="game-stats">
          {player.deckName && <span>{player.deckName}</span>}
          {(["poison", "energy", "experience"] as const).map(kind =>
            player[kind] > 0 || own ? (
              <span key={kind}>
                {PLAYER_COUNTER_LABELS[kind]}: {player[kind]}
                {own && !player.eliminated && (
                  <>
                    {" "}
                    <button type="button" className="secondary" onClick={() => act({ type: "pcounter", kind, delta: 1 })} aria-label={`${PLAYER_COUNTER_LABELS[kind]} plus`}>+</button>
                    <button type="button" className="secondary" onClick={() => act({ type: "pcounter", kind, delta: -1 })} aria-label={`${PLAYER_COUNTER_LABELS[kind]} minus`}>−</button>
                  </>
                )}
              </span>
            ) : null
          )}
          {(["library", "hand", "graveyard", "exile", "command"] as const).map(zone => (
            <span key={zone}>
              {zone === "graveyard" || zone === "exile" || zone === "command" || (own && zone === "library") ? (
                <button type="button" className="secondary" onClick={() => setZoneView({ owner: player.userId, zone })}>
                  {ZONE_LABELS[zone]}: {player.counts[zone]}
                </button>
              ) : (
                <>{ZONE_LABELS[zone]}: {player.counts[zone]}</>
              )}
            </span>
          ))}
          {game.format === "commander" &&
            game.players
              .filter(other => other.userId !== player.userId && (player.cmdDamage[other.userId] ?? 0) > 0)
              .map(other => (
                <span key={other.userId}>Kommandantenschaden von {other.name}: {player.cmdDamage[other.userId]}</span>
              ))}
        </div>
        {game.format === "commander" && own && !player.eliminated && (
          <div className="game-actions">
            {game.players
              .filter(other => other.userId !== game.you)
              .map(other => (
                <span key={other.userId}>
                  Kommandantenschaden von {other.name}:{" "}
                  <button type="button" className="secondary" onClick={() => act({ type: "cmddmg", from: other.userId, delta: 1 })}>+1</button>
                  <button type="button" className="secondary" onClick={() => act({ type: "cmddmg", from: other.userId, delta: -1 })}>−1</button>
                </span>
              ))}
          </div>
        )}
        {game.format === "commander" && player.command.length > 0 && (
          <p className="muted">
            Kommandant-Steuer:{" "}
            {player.command
              .map(card => `${card.name}: +${2 * (player.cmdCasts[card.id] ?? 0)}`)
              .join(", ")}
          </p>
        )}
        <div className="game-cards" aria-label={`Schlachtfeld von ${player.name}`}>
          {player.battlefield.length === 0 && <span className="muted">Keine Karten im Spiel.</span>}
          {player.battlefield.map(card => (
            <CardTile key={card.id} card={card} selected={card.id === selectedId} onSelect={c => setSelectedId(c.id === selectedId ? null : c.id)} />
          ))}
        </div>
      </div>
    );
  };

  const opponents = game.players.filter(player => player.userId !== game.you);

  return (
    <section className="game-table">
      <div className="panel game-bar">
        <div>
          <strong>Zug {game.turn.number}</strong>{" "}
          <span className="muted">
            {game.players.find(player => player.userId === game.turn.active)?.name ?? ""}
          </span>
        </div>
        <div className="phases" aria-label="Phase">
          {PHASE_ORDER.map(phase => (
            <span key={phase} className={`game-phase${game.turn.phase === phase ? " current" : ""}`}>{PHASE_LABELS[phase]}</span>
          ))}
        </div>
        {game.phase === "playing" && (
          <div className="game-actions">
            <button type="button" className="secondary" disabled={!isActive || game.turn.phase === "end"} onClick={() => act({ type: "nextPhase" })}>
              Nächste Phase
            </button>
            <button type="button" className="primary" disabled={!isActive} onClick={() => act({ type: "endTurn" })}>
              Zug beenden
            </button>
          </div>
        )}
      </div>

      {game.phase === "ended" && (
        <div className="notice" role="status">
          <strong>Das Spiel ist beendet.</strong> {winner ? `${winner.name} gewinnt.` : "Kein Sieger."}
          <div className="game-actions">
            {game.you === hostId ? (
              <button type="button" className="primary" onClick={onRematch}>Revanche</button>
            ) : (
              <span className="muted">Der Gastgeber ({hostName}) kann eine Revanche starten.</span>
            )}
            <button type="button" className="secondary" onClick={onLeave}>Raum verlassen</button>
          </div>
        </div>
      )}

      {opponents.map(renderSeat)}
      {renderSeat(me)}

      <div className="panel">
        <h3>Hand ({me.hand.length})</h3>
        <div className="game-hand" aria-label="Deine Hand">
          {me.hand.length === 0 && <span className="muted">Keine Karten auf der Hand.</span>}
          {me.hand.map(card => (
            <CardTile key={card.id} card={card} selected={card.id === selectedId} onSelect={c => setSelectedId(c.id === selectedId ? null : c.id)} />
          ))}
        </div>
        {game.phase === "playing" && !me.eliminated && (
          <div className="game-actions">
            <button type="button" className="secondary" onClick={() => act({ type: "draw" })}>Karte ziehen</button>
            <button type="button" className="secondary" onClick={() => act({ type: "mill" })}>Oberste Karte mahlen</button>
            <button type="button" className="secondary" onClick={() => act({ type: "shuffle" })}>Bibliothek mischen</button>
            <button type="button" className="secondary" onClick={() => act({ type: "untapAll" })}>Alles enttappen</button>
            <label>
              Oberste{" "}
              <input type="number" min={1} max={20} value={lookCount} onChange={event => setLookCount(Number(event.target.value) || 1)} style={{ width: "4.5em" }} aria-label="Anzahl Karten ansehen" />
            </label>
            <button type="button" className="secondary" onClick={() => { act({ type: "look", count: lookCount }); setZoneView({ owner: game.you, zone: "library" }); }}>
              ansehen
            </button>
            <button type="button" className="secondary" onClick={() => { act({ type: "look", count: "all" }); setZoneView({ owner: game.you, zone: "library" }); }}>
              Bibliothek durchsuchen
            </button>
          </div>
        )}
      </div>

      {selected && (
        <div className="panel game-selected" aria-label="Ausgewählte Karte">
          {selected.imageUri && selected.name !== undefined ? <img src={selected.imageUri} alt={selected.name} /> : <span className="muted">Verdeckt</span>}
          <div>
            <h3>{selected.name ?? "Verdeckte Karte"}</h3>
            {selected.typeLine && <p className="muted">{selected.typeLine}</p>}
            {mine && selectedZone && game.phase === "playing" && !me.eliminated ? (
              <div className="game-actions">
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
                    <button type="button" className="secondary" onClick={() => moveTo("battlefield", { faceDown: true })}>Verdeckt ausspielen</button>
                  </>
                )}
                {(["battlefield", "hand", "graveyard", "exile", "command"] as const)
                  .filter(zone => zone !== selectedZone)
                  .map(zone => (
                    <button key={zone} type="button" className="secondary" onClick={() => moveTo(zone)}>→ {ZONE_LABELS[zone]}</button>
                  ))}
                <button type="button" className="secondary" onClick={() => moveTo("library", { position: "top" })}>→ Bibliothek oben</button>
                <button type="button" className="secondary" onClick={() => moveTo("library", { position: "bottom" })}>→ Bibliothek unten</button>
              </div>
            ) : (
              <p className="muted">{mine ? "" : "Das ist die Karte eines anderen Spielers."}</p>
            )}
            {Object.keys(selected.counters).length > 0 && (
              <p>{Object.entries(selected.counters).map(([kind, n]) => <span key={kind} className="game-counter-chip">{n}× {kind} </span>)}</p>
            )}
          </div>
        </div>
      )}

      {zoneView && zoneOwner && (
        <div className="panel">
          <div className="game-bar">
            <h3>{ZONE_LABELS[zoneView.zone]} von {zoneOwner.name}{zoneView.zone === "library" ? " (angesehene Karten, oberste zuerst)" : ""}</h3>
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
          <div className="game-zone-list">
            {zoneCards.length === 0 && <span className="muted">Leer.</span>}
            {zoneCards.map(card => (
              <CardTile key={card.id} card={card} small selected={card.id === selectedId} onSelect={c => setSelectedId(c.id === selectedId ? null : c.id)} />
            ))}
          </div>
          {zoneView.zone === "library" && <p className="muted">Karte antippen, dann oben in der Kartenleiste in eine Zone legen. Danach die Bibliothek mischen.</p>}
        </div>
      )}

      <div className="panel">
        <h3>Werkzeuge</h3>
        <div className="game-actions">
          <input value={tokenName} onChange={event => setTokenName(event.target.value)} placeholder="Spielstein, z. B. Goblin 1/1" aria-label="Name des Spielsteins" maxLength={40} />
          <button type="button" className="secondary" disabled={!tokenName.trim()} onClick={() => { act({ type: "token", name: tokenName }); setTokenName(""); }}>Spielstein erzeugen</button>
          <button type="button" className="secondary" onClick={() => act({ type: "dice", sides: 6 })}>W6</button>
          <button type="button" className="secondary" onClick={() => act({ type: "dice", sides: 20 })}>W20</button>
          <button type="button" className="secondary" onClick={() => act({ type: "coin" })}>Münze</button>
          {game.phase === "playing" && !me.eliminated && (
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

      <LogPanel game={game} />
    </section>
  );
}

function LogPanel({ game }: { game: GameView }) {
  return (
    <div className="panel">
      <h3>Spielverlauf</h3>
      <ol className="game-log" aria-label="Spielverlauf" reversed>
        {[...game.log].reverse().map(line => (
          <li key={line.n}>{line.text}</li>
        ))}
      </ol>
    </div>
  );
}
