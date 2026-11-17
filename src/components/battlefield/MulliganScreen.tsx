import { useState } from "react";
import type { GameAction, GameCard, GamePlayer, GameView } from "../../gameClient";
import CardPreview from "./CardPreview";
import CardView from "./CardView";

/** Starthand: alle Karten in Bildschirmbreite, beim Darüberfahren groß; Behalten oder Mulligan (London-Regel). */
export default function MulliganScreen({
  game,
  me,
  act,
  background
}: {
  game: GameView;
  me: GamePlayer;
  act: (action: GameAction) => void;
  background: string;
}) {
  const [bottomPick, setBottomPick] = useState<string[]>([]);
  const [hover, setHover] = useState<GameCard | null>(null);
  const bottomNeeded = Math.max(0, me.mulligans - (game.format === "commander" ? 1 : 0));

  return (
    <section className="arena arena-start" style={{ backgroundImage: `url(${background})` }} aria-label="Spieltisch">
      <div className="start-panel">
        <h3>Deine Starthand</h3>
        <p className="muted">
          Behalte die Karten oder nimm einen Mulligan (London-Mulligan: neue sieben Karten, danach legst du so viele Karten unter die
          Bibliothek, wie du Mulligans genommen hast{game.format === "commander" ? "; der erste Mulligan ist kostenlos" : ""}).
        </p>
        {me.kept ? (
          <div className="notice" role="status">Du hast behalten. Warte auf die anderen Spieler …</div>
        ) : (
          <>
            <div className="start-hand">
              {me.hand.map(card => (
                <CardView
                  key={card.id}
                  card={card}
                  size="fill"
                  marked={bottomPick.includes(card.id) ? "pick" : null}
                  onHover={setHover}
                  onSelect={c =>
                    bottomNeeded > 0 &&
                    setBottomPick(current => (current.includes(c.id) ? current.filter(id => id !== c.id) : [...current, c.id]))
                  }
                />
              ))}
            </div>
            {bottomNeeded > 0 && (
              <p className="muted">
                Klicke {bottomNeeded} Karte{bottomNeeded === 1 ? "" : "n"} an, die unter die Bibliothek kommen ({bottomPick.length} gewählt).
              </p>
            )}
            <div className="start-actions">
              <button
                type="button"
                className="primary"
                disabled={bottomPick.length !== bottomNeeded}
                onClick={() => {
                  act({ type: "keep", bottom: bottomPick });
                  setBottomPick([]);
                }}
              >
                Behalten
              </button>
              {me.mulligans < 6 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setBottomPick([]);
                    act({ type: "mulligan" });
                  }}
                >
                  Mulligan ({me.mulligans} bisher)
                </button>
              )}
            </div>
          </>
        )}
        <ul className="muted">
          {game.players.map(player => (
            <li key={player.userId}>
              {player.name}: {player.eliminated ? `ausgeschieden (${player.eliminated})` : player.kept ? "hat behalten" : "entscheidet noch"}
            </li>
          ))}
        </ul>
      </div>
      <CardPreview card={hover} />
    </section>
  );
}
