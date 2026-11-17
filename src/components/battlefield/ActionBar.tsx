import type { GameAction, GameCard, GamePlayer, GameStep, GameView } from "../../gameClient";

const GO_LABELS: Record<string, string> = {
  main1: "Weiter zum Kampf",
  attackers: "Kein Angriff",
  damage: "Kampfschaden verursachen",
  main2: "Weiter zum Zugende"
};

export type ActionBarProps = {
  game: GameView;
  me: GamePlayer;
  hostId: string;
  nameOf: (userId: string | null) => string;
  allCards: Map<string, GameCard>;
  act: (action: GameAction) => void;
  iHavePriority: boolean;
  isActive: boolean;
  discarding: boolean;
  attackStep: boolean;
  awaitingMe: boolean;
  livingOpponents: GamePlayer[];
  attackPick: string[];
  clearAttackPick: () => void;
  target: string;
  setAttackTarget: (userId: string) => void;
  blockPick: string | null;
  blocks: Record<string, string>;
  resetBlocks: () => void;
  discardPick: string[];
  clearDiscardPick: () => void;
  onRematch: () => void;
  onLeave: () => void;
};

/** Die einzige Schaltflächenleiste: zeigt nur, was im aktuellen Moment wirklich möglich ist. */
export default function ActionBar(props: ActionBarProps) {
  const { game, me, act, nameOf } = props;
  const step: GameStep = game.turn.phase;
  const winner = game.players.find(player => player.userId === game.winner);

  if (game.phase === "ended") {
    return (
      <div className="action-bar" role="status">
        <strong>Das Spiel ist beendet. {winner ? `${winner.name} gewinnt.` : "Kein Sieger."}</strong>
        {game.you === props.hostId ? (
          <button type="button" className="primary" onClick={props.onRematch}>Revanche</button>
        ) : (
          <span className="muted">Der Gastgeber ({nameOf(props.hostId)}) kann eine Revanche starten.</span>
        )}
        <button type="button" className="secondary" onClick={props.onLeave}>Raum verlassen</button>
      </div>
    );
  }

  const prompt = me.prompts[0];
  if (prompt) {
    return (
      <div className="action-bar" role="alert">
        <strong>{props.allCards.get(prompt.id)?.name ?? "Dein Kommandant"} hat das Spiel verlassen. In die Kommandozone zurücklegen?</strong>
        <button type="button" className="primary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: true })}>Ja, in die Kommandozone</button>
        <button type="button" className="secondary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: false })}>Nein</button>
      </div>
    );
  }

  if (props.discarding && game.pendingDiscard) {
    const { count } = game.pendingDiscard;
    return (
      <div className="action-bar" role="alert">
        <strong>Handkartenlimit: Wähle {count} Karte{count === 1 ? "" : "n"} in deiner Hand zum Abwerfen ({props.discardPick.length}/{count}).</strong>
        <button
          type="button"
          className="primary"
          disabled={props.discardPick.length !== count}
          onClick={() => {
            act({ type: "discard", ids: props.discardPick });
            props.clearDiscardPick();
          }}
        >
          Abwerfen
        </button>
      </div>
    );
  }

  if (props.attackStep && props.iHavePriority) {
    return (
      <div className="action-bar" role="status">
        <strong>Angriff: Klicke deine Kreaturen an, die angreifen sollen ({props.attackPick.length} gewählt).</strong>
        {props.livingOpponents.length > 1 && (
          <label>
            Ziel{" "}
            <select value={props.target} onChange={event => props.setAttackTarget(event.target.value)} aria-label="Angriffsziel">
              {props.livingOpponents.map(player => (
                <option key={player.userId} value={player.userId}>{player.name}</option>
              ))}
            </select>
          </label>
        )}
        {props.attackPick.length > 0 && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              act({ type: "declareAttackers", attackers: props.attackPick.map(id => ({ id, target: props.target })) });
              props.clearAttackPick();
            }}
          >
            Angriff bestätigen
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            props.clearAttackPick();
            act({ type: "pass" });
          }}
        >
          Kein Angriff
        </button>
      </div>
    );
  }

  if (props.awaitingMe && step === "blockers") {
    const count = Object.keys(props.blocks).length;
    return (
      <div className="action-bar" role="status">
        <strong>
          Du wirst angegriffen. {props.blockPick ? "Klicke jetzt den Angreifer an, den diese Kreatur blocken soll." : "Klicke eine deiner Kreaturen an, dann den Angreifer."}
          {count > 0 ? ` (${count} Block${count === 1 ? "" : "s"})` : ""}
        </strong>
        <button
          type="button"
          className="primary"
          onClick={() => {
            act({ type: "declareBlockers", blocks: Object.entries(props.blocks).map(([blocker, attacker]) => ({ blocker, attacker })) });
            props.resetBlocks();
          }}
        >
          {count === 0 ? "Nicht blocken" : "Blocken bestätigen"}
        </button>
        {count > 0 && <button type="button" className="secondary" onClick={props.resetBlocks}>Zurücksetzen</button>}
      </div>
    );
  }

  if (props.iHavePriority) {
    const label = game.stack.length > 0 ? "Passen – Stapel auflösen" : (GO_LABELS[step] ?? (props.isActive ? "Zug beenden" : "Passen"));
    return (
      <div className="action-bar" role="status">
        <span className="chip prio">Du hast Priorität</span>
        <button type="button" className="primary go" onClick={() => act({ type: "pass" })}>{label}</button>
      </div>
    );
  }

  return (
    <div className="action-bar" role="status">
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
}
