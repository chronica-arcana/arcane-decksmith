import { useState } from "react";
import type { GameAction, GameView } from "../../gameClient";
import CardView from "./CardView";

type Choice = NonNullable<GameView["choice"]>;

/** Auswahl, die ein Kartentext verlangt: Ziel eines Auslösers, Karten abwerfen, suchen oder wühlen. */
export default function ChoiceDialog({ choice, act, onHover }: { choice: Choice; act: (action: GameAction) => void; onHover: (card: import("../../gameClient").GameCard | null) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) =>
    setPicked(current => (current.includes(id) ? current.filter(item => item !== id) : choice.max === 1 ? [id] : current.length < choice.max ? [...current, id] : current));
  const ready = picked.length >= choice.min && picked.length <= choice.max;

  if (choice.kind === "yesno") {
    return (
      <div className="modal-back" role="presentation">
        <div className="modal choice" role="dialog" aria-label="Auswahl">
          <h3>{choice.prompt}</h3>
          <div className="start-actions">
            {choice.options.map(option => (
              <button key={option.id} type="button" className={option.id === "yes" ? "primary" : "secondary"} onClick={() => act({ type: "choose", ids: [option.id] })}>
                {option.label ?? option.id}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-back" role="presentation">
      <div className="modal choice" role="dialog" aria-label="Auswahl">
        <h3>{choice.prompt}</h3>
        <p className="muted">
          {choice.min === choice.max ? `Wähle ${choice.min}.` : `Wähle ${choice.min === 0 ? "bis zu" : `${choice.min} bis`} ${choice.max}.`} ({picked.length} gewählt)
        </p>
        <div className="zone-list">
          {choice.options.length === 0 && <span className="muted">Keine Optionen.</span>}
          {choice.options.map(option =>
            option.player ? (
              <button key={option.id} type="button" className={picked.includes(option.id) ? "primary" : "secondary"} onClick={() => toggle(option.id)}>
                {option.player.name}
              </button>
            ) : option.card ? (
              <CardView
                key={option.id}
                card={option.card}
                size="md"
                marked={picked.includes(option.id) ? "pick" : null}
                onSelect={() => toggle(option.id)}
                onHover={onHover}
              />
            ) : null
          )}
        </div>
        <div className="start-actions">
          <button
            type="button"
            className="primary"
            disabled={!ready}
            onClick={() => {
              act({ type: "choose", ids: picked });
              setPicked([]);
            }}
          >
            {choice.min === 0 && picked.length === 0 ? "Keine wählen" : "Bestätigen"}
          </button>
        </div>
      </div>
    </div>
  );
}
