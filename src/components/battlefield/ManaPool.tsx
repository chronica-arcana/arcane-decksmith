import type { GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import { ManaSymbol } from "./ManaSymbol";

const COLORS = ["W", "U", "B", "R", "G", "C"] as const;
const NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos" };

/**
 * Manapool mit offiziellen Scryfall-Symbolen. Deine Länder füllen ihn beim Tappen automatisch; für Effekte, die Mana erzeugen,
 * addiert ein Klick auf ein Symbol Mana, ein Rechtsklick nimmt es weg. Der Pool leert sich zwischen den Schritten.
 */
export default function ManaPool({ player, own }: { player: GamePlayer; own: boolean }) {
  const { act, canAct } = useBattlefield();
  const colors = own ? COLORS : COLORS.filter(color => player.pool[color] > 0);
  if (colors.length === 0) return null;
  return (
    <span className="mana-pool" role="group" aria-label="Manapool">
      {colors.map(color => {
        const count = player.pool[color];
        const content = (
          <>
            <ManaSymbol symbol={`{${color}}`} size={22} />
            <span className="mana-count">{count}</span>
          </>
        );
        return own && canAct ? (
          <button
            key={color}
            type="button"
            className={`mana-slot${count > 0 ? " filled" : ""}`}
            aria-label={`${NAMES[color]}: ${count}. Klick: +1, Rechtsklick: −1`}
            title={`${NAMES[color]}: Klick +1, Rechtsklick −1`}
            onClick={() => act({ type: "pool", color, delta: 1 })}
            onContextMenu={event => {
              event.preventDefault();
              if (count > 0) act({ type: "pool", color, delta: -1 });
            }}
          >
            {content}
          </button>
        ) : (
          <span key={color} className={`mana-slot${count > 0 ? " filled" : ""}`} aria-label={`${NAMES[color]}: ${count}`}>
            {content}
          </span>
        );
      })}
    </span>
  );
}
