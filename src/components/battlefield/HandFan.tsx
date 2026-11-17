import type { CSSProperties } from "react";
import type { GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView, { CardBack } from "./CardView";

/** Eigene Hand als Fächer: Die Karten stehen im Bogen, die überfahrene Karte richtet sich auf, hebt sich und wird groß. */
export function HandFan({ player }: { player: GamePlayer }) {
  const { game, canAct, discarding, tileMarks, dropProps, dropKey, moveCard, clickCard, cardMenu, setHover, onDragStart } = useFanApi();
  const count = player.hand.length;
  const overlap = Math.min(0.72, Math.max(0.05, ((count - 5) / Math.max(count, 1)) * 1.2));
  void game;
  return (
    <div
      className={`hand-fan${dropKey === "hand" ? " drop" : ""}`}
      aria-label="Deine Hand"
      style={{ "--overlap": overlap } as CSSProperties}
      {...dropProps("hand", card => moveCard(card, "hand"))}
    >
      {count === 0 && <span className="muted hand-empty">Keine Karten auf der Hand.</span>}
      {player.hand.map((card, index) => {
        const mid = (count - 1) / 2;
        const offset = index - mid;
        const spread = Math.min(5, 36 / Math.max(count, 1));
        const style = {
          "--rot": `${offset * spread}deg`,
          "--lift": `${Math.abs(offset) ** 2 * (count > 6 ? 1.6 : 2.4)}px`
        } as CSSProperties;
        return (
          <CardView
            key={card.id}
            card={card}
            size="md"
            style={style}
            glow={Boolean(card.play?.ok) && canAct && !discarding}
            marked={tileMarks(card)}
            onSelect={clickCard}
            onHover={setHover}
            onMenu={cardMenu}
            onDragStart={onDragStart}
          />
        );
      })}
    </div>
  );
}

/** Gegnerische Hand: Kartenrücken oben am Rand (gezeigte Karten offen), Anzahl im HUD. */
export function OpponentHand({ player }: { player: GamePlayer }) {
  const { setHover } = useBattlefield();
  const backs = Math.min(player.counts.hand - player.hand.length, 10);
  return (
    <div className="hand-fan opp" aria-label={`Hand von ${player.name}: ${player.counts.hand} Karten`}>
      {player.hand.map(card => (
        <CardView key={card.id} card={card} size="sm" onHover={setHover} />
      ))}
      {Array.from({ length: backs }, (_, i) => (
        <span key={i} className="gc sm back-only">
          <CardBack />
        </span>
      ))}
    </div>
  );
}

function useFanApi() {
  const api = useBattlefield();
  return { ...api, tileMarks: api.markOf };
}
