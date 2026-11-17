import type { GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import ManaPool from "./ManaPool";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

/** Avatar, Lebenspunkte, Handkartenzahl, Manapool und Zähler eines Spielers. Der Avatar ist anklickbar, wenn der Spieler ein Ziel sein kann. */
export default function Hud({ player, own }: { player: GamePlayer; own: boolean }) {
  const { game, act, manualMine, lifeOpen, toggleLife, isTarget, pickTarget } = useBattlefield();
  const active = game.turn.active === player.userId && game.phase === "playing";
  const targetable = isTarget(player.userId);
  const chips: string[] = [];
  if (player.poison > 0) chips.push(`Gift ${player.poison}`);
  if (player.energy > 0) chips.push(`Energie ${player.energy}`);
  if (player.experience > 0) chips.push(`Erfahrung ${player.experience}`);
  for (const other of game.players) {
    if (other.userId !== player.userId && (player.cmdDamage[other.userId] ?? 0) > 0) {
      chips.push(`Kommandantenschaden von ${other.name}: ${player.cmdDamage[other.userId]}/21`);
    }
  }

  return (
    <div className={`hud${own ? " own" : ""}${active ? " active" : ""}`}>
      <button
        type="button"
        className={`hud-avatar${targetable ? " targetable" : ""}`}
        aria-label={targetable ? `${player.name} als Ziel wählen` : `Spieler ${player.name}`}
        disabled={!targetable}
        onClick={() => pickTarget(player.userId)}
      >
        {initials(player.name)}
      </button>
      <div className="hud-body">
        <div className="hud-line">
          <span className="hud-name">{player.name}{own ? " (du)" : ""}</span>
          {player.eliminated && <span className="chip out">ausgeschieden: {player.eliminated}</span>}
        </div>
        <div className="hud-line">
          <button
            type="button"
            className="life"
            aria-label={`Leben${own ? "" : ` von ${player.name}`}: ${player.life}`}
            disabled={!(own && manualMine)}
            onClick={toggleLife}
          >
            <span className="life-heart" aria-hidden="true">♥</span>
            {player.life}
          </button>
          {!own && (
            <span className="hand-badge" aria-label={`${player.counts.hand} Handkarten`} title="Handkarten">
              ✋ {player.counts.hand}
            </span>
          )}
          <ManaPool player={player} />
        </div>
        {chips.length > 0 && (
          <div className="hud-line">
            {chips.map(text => (
              <span key={text} className="chip">{text}</span>
            ))}
          </div>
        )}
        {own && manualMine && lifeOpen && (
          <div className="life-pop" role="group" aria-label="Leben manuell anpassen">
            <button type="button" onClick={() => act({ type: "life", delta: -5 })}>−5</button>
            <button type="button" onClick={() => act({ type: "life", delta: -1 })}>−1</button>
            <button type="button" onClick={() => act({ type: "life", delta: 1 })}>+1</button>
            <button type="button" onClick={() => act({ type: "life", delta: 5 })}>+5</button>
            <button type="button" onClick={() => act({ type: "pcounter", kind: "poison", delta: 1 })}>Gift +1</button>
          </div>
        )}
      </div>
    </div>
  );
}
