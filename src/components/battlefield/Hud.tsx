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

/** Avatar, Lebenspunkte, Handkartenzahl, Manapool und Zähler eines Spielers (wie das HUD in MTG Arena). */
export default function Hud({ player, own }: { player: GamePlayer; own: boolean }) {
  const { game, canAct, act, nameOf, lifeOpen, toggleLife } = useBattlefield();
  const active = game.turn.active === player.userId && game.phase === "playing";
  const chips: string[] = [];
  if (player.poison > 0) chips.push(`Gift ${player.poison}`);
  if (player.energy > 0) chips.push(`Energie ${player.energy}`);
  if (player.experience > 0) chips.push(`Erfahrung ${player.experience}`);
  for (const other of game.players) {
    if (other.userId !== player.userId && (player.cmdDamage[other.userId] ?? 0) > 0) {
      chips.push(`Kommandantenschaden von ${other.name}: ${player.cmdDamage[other.userId]}/21`);
    }
  }
  void nameOf;

  return (
    <div className={`hud${own ? " own" : ""}${active ? " active" : ""}`}>
      <span className="hud-avatar" aria-hidden="true">{initials(player.name)}</span>
      <div className="hud-body">
        <div className="hud-line">
          <span className="hud-name">{player.name}{own ? " (du)" : ""}</span>
          {active && <span className="chip">am Zug</span>}
          {game.priority === player.userId && <span className="chip prio">Priorität</span>}
          {player.eliminated && <span className="chip out">ausgeschieden: {player.eliminated}</span>}
        </div>
        <div className="hud-line">
          <button
            type="button"
            className="life"
            aria-label={own ? `Leben: ${player.life}. Anklicken zum Anpassen` : `Leben von ${player.name}: ${player.life}`}
            disabled={!own || !canAct}
            onClick={toggleLife}
            title={own ? "Leben ändert sich automatisch (Kampf, Lebensverbindung). Anklicken für manuelle Korrektur." : undefined}
          >
            <span className="life-heart" aria-hidden="true">♥</span>
            {player.life}
          </button>
          {!own && (
            <span className="hand-badge" aria-label={`${player.counts.hand} Handkarten`} title="Handkarten">
              ✋ {player.counts.hand}
            </span>
          )}
          <ManaPool player={player} own={own} />
        </div>
        {chips.length > 0 && (
          <div className="hud-line">
            {chips.map(text => (
              <span key={text} className="chip">{text}</span>
            ))}
          </div>
        )}
        {own && lifeOpen && (
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
