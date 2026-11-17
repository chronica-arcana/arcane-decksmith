import type { GamePlayer } from "../../gameClient";
import { ManaSymbol } from "./ManaSymbol";

const COLORS = ["W", "U", "B", "R", "G", "C"] as const;
const NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos" };

/**
 * Manapool mit offiziellen Scryfall-Symbolen. Er füllt sich, wenn du Länder oder Manaquellen antippst oder ein Kartentext Mana
 * erzeugt, und leert sich zwischen den Schritten. Beim Wirken wird er zuerst verbraucht, danach tappt das Spiel Quellen.
 */
export default function ManaPool({ player }: { player: GamePlayer }) {
  const colors = COLORS.filter(color => player.pool[color] > 0);
  if (colors.length === 0) return null;
  return (
    <span className="mana-pool" role="group" aria-label="Manapool">
      {colors.map(color => {
        const count = player.pool[color];
        return (
          <span key={color} className={`mana-slot${count > 0 ? " filled" : ""}`} aria-label={`${NAMES[color]}: ${count}`} title={`${NAMES[color]}: ${count}`}>
            <ManaSymbol symbol={`{${color}}`} size={22} />
            <span className="mana-count">{count}</span>
          </span>
        );
      })}
    </span>
  );
}
