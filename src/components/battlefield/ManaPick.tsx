import { useState } from "react";
import type { GameCard } from "../../gameClient";
import { ManaCost, ManaSymbol } from "./ManaSymbol";

/**
 * „Mana selbst wählen“: Der Spieler markiert, welche Länder (Manaquellen) für diesen Zauber getappt werden.
 * Bei mehrfarbigen Decks trifft die Automatik nicht immer die beste Wahl.
 */
export default function ManaPick({
  name,
  cost,
  sources,
  onPay,
  onAuto,
  onCancel
}: {
  name: string;
  cost: string;
  sources: GameCard[];
  onPay: (ids: string[]) => void;
  onAuto: () => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked(list => (list.includes(id) ? list.filter(item => item !== id) : [...list, id]));
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal small" role="dialog" aria-label="Mana wählen" onClick={event => event.stopPropagation()}>
        <div className="modal-head">
          <h3>{name}: Mana wählen</h3>
          <button type="button" className="secondary" onClick={onCancel}>Abbrechen</button>
        </div>
        <p className="mana-cost-line">
          Kosten: <ManaCost cost={cost} size={18} />
        </p>
        <p className="muted">Tippe die Länder an, die bezahlen sollen.</p>
        <div className="mana-sources">
          {sources.map(card => (
            <button key={card.id} type="button" className={`mana-source${picked.includes(card.id) ? " on" : ""}`} aria-pressed={picked.includes(card.id)} onClick={() => toggle(card.id)}>
              {(card.manaColors ?? []).map(color => (
                <ManaSymbol key={color} symbol={`{${color}}`} size={18} />
              ))}
              <span>{card.name}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" disabled={picked.length === 0} onClick={() => onPay(picked)}>Mit Auswahl bezahlen</button>
          <button type="button" className="secondary" onClick={onAuto}>Automatisch bezahlen</button>
        </div>
      </div>
    </div>
  );
}
