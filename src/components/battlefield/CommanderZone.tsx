import type { GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView from "./CardView";
import { ManaSymbol } from "./ManaSymbol";

/** Kommandozone: Kommandant(en) mit Wirk-Zähler und Kommandantensteuer ({2} je früherem Wirken). */
export default function CommanderZone({ player }: { player: GamePlayer }) {
  const { game, clickCard, cardMenu, setHover, onDragStart, markOf, dropProps, dropKey, moveCard, dropOnTable } = useBattlefield();
  if (game.format !== "commander") return null;
  const own = player.userId === game.you;
  const key = `${player.userId}:command`;
  const casts = Object.values(player.cmdCasts).reduce((sum, n) => sum + n, 0);
  const tax = Math.min(2 * Math.max(0, ...Object.values(player.cmdCasts), 0), 40);
  void dropOnTable;
  return (
    <div
      className={`command-zone${dropKey === key ? " drop" : ""}`}
      aria-label={`Kommandozone von ${player.name}`}
      {...(own ? dropProps(key, card => moveCard(card, "command")) : {})}
    >
      <span className="command-title">Kommandozone</span>
      <div className="command-cards">
        {player.command.length === 0 && <span className="pile-empty command-empty" />}
        {player.command.map(card => (
          <CardView
            key={card.id}
            card={card}
            size="sm"
            marked={markOf(card)}
            glow={own && Boolean(card.play?.ok)}
            onSelect={clickCard}
            onHover={setHover}
            onMenu={cardMenu}
            onDragStart={own ? onDragStart : undefined}
          />
        ))}
      </div>
      <span className="command-tax" title="Kommandantensteuer: {2} für jedes frühere Wirken">
        {casts}× gewirkt
        {tax > 0 && (
          <>
            {" · "}Steuer <ManaSymbol symbol={`{${tax}}`} size={16} />
          </>
        )}
      </span>
    </div>
  );
}
