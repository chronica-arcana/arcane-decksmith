import type { CSSProperties } from "react";
import type { GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView, { CardBack } from "./CardView";

/**
 * Eigene Hand als Fächer. Jede Karte steckt in einem festen „Slot“: Der Slot ändert beim Darüberfahren weder Größe noch Lage,
 * nur die Karte darin hebt sich. Dadurch bleibt der Hover stabil und flackert nicht zwischen Nachbarkarten.
 * Bei vielen Karten schrumpfen die Slots und die Karten überlappen von selbst.
 */
export function HandFan({ player }: { player: GamePlayer }) {
  const { canAct, discarding, markOf, dropProps, dropKey, moveCard, clickCard, cardMenu, setHover, onDragStart, manualMine } = useBattlefield();
  const count = player.hand.length;
  return (
    <div
      className={`hand-fan${dropKey === "hand" ? " drop" : ""}`}
      aria-label="Deine Hand"
      {...(manualMine ? dropProps("hand", card => moveCard(card, "hand")) : {})}
    >
      {count === 0 && <span className="muted hand-empty">Keine Karten auf der Hand.</span>}
      {player.hand.map((card, index) => {
        const offset = index - (count - 1) / 2;
        const spread = Math.min(4, 30 / Math.max(count, 1));
        const style = {
          "--rot": `${offset * spread}deg`,
          "--lift": `${Math.abs(offset) ** 2 * (count > 6 ? 0.9 : 1.6)}px`
        } as CSSProperties;
        return (
          <div key={card.id} className="fan-slot" style={style}>
            <CardView
              card={card}
              size="md"
              glow={Boolean(card.play?.ok) && canAct && !discarding}
              marked={markOf(card)}
              onSelect={clickCard}
              onHover={setHover}
              onMenu={cardMenu}
              onDragStart={onDragStart}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Gegnerische Hand: Kartenrücken (gezeigte Karten offen), die Anzahl steht im HUD. */
export function OpponentHand({ player }: { player: GamePlayer }) {
  const { setHover } = useBattlefield();
  const backs = Math.min(player.counts.hand - player.hand.length, 12);
  return (
    <div className="hand-fan opp" aria-label={`Hand von ${player.name}: ${player.counts.hand} Karten`}>
      {player.hand.map(card => (
        <div key={card.id} className="fan-slot">
          <CardView card={card} size="sm" onHover={setHover} />
        </div>
      ))}
      {Array.from({ length: backs }, (_, i) => (
        <div key={i} className="fan-slot">
          <span className="gc sm back-only">
            <CardBack />
          </span>
        </div>
      ))}
    </div>
  );
}
