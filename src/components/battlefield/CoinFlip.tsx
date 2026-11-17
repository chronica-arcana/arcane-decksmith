import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { GamePlayer } from "../../gameClient";

// Optionale eigene Münz-Grafiken: src/assets/game/coin-front.webp und coin-back.webp (ohne sie wird eine goldene Münze gezeichnet).
const IMAGES = import.meta.glob("../../assets/game/coin-*.webp", { eager: true, import: "default" }) as Record<string, string>;
const imageOf = (side: "front" | "back") => Object.entries(IMAGES).find(([path]) => path.endsWith(`coin-${side}.webp`))?.[1];

/** Münzwurf zu Spielbeginn: bei zwei Spielern dreht sich eine Münze, bei mehreren wird reihum ausgelost. Danach wird ausgeblendet. */
export default function CoinFlip({ players, firstId, onDone }: { players: GamePlayer[]; firstId: string; onDone: () => void }) {
  const winner = players.find(player => player.userId === firstId);
  const two = players.length === 2;
  const frontWins = players[0]?.userId === firstId;
  const style = { "--turns": `${frontWins ? 1800 : 1980}deg` } as CSSProperties;
  // Sicherheitsnetz: Auch ohne Animationsereignis (z. B. bei reduzierter Bewegung) wird nach dem Wurf ausgeblendet.
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const timer = window.setTimeout(() => done.current(), 6000);
    return () => window.clearTimeout(timer);
  }, []);
  const front = imageOf("front");
  const back = imageOf("back");

  return (
    <div className="coin-overlay" role="dialog" aria-label="Münzwurf: Wer beginnt?" onAnimationEnd={event => event.animationName === "coin-out" && onDone()}>
      <div className="coin-box">
        <h3>Wer beginnt?</h3>
        {two ? (
          <>
            <div className="coin" style={style}>
              <div className="coin-face front" style={front ? { backgroundImage: `url(${front})` } : undefined}>
                {!front && <span>{players[0].name}</span>}
              </div>
              <div className="coin-face back" style={back ? { backgroundImage: `url(${back})` } : undefined}>
                {!back && <span>{players[1].name}</span>}
              </div>
            </div>
            <div className="coin-names">
              <span>Kopf: {players[0].name}</span>
              <span>Zahl: {players[1].name}</span>
            </div>
          </>
        ) : (
          <ul className="coin-roulette">
            {players.map((player, index) => (
              <li key={player.userId} className={player.userId === firstId ? "pick" : ""} style={{ animationDelay: `${index * 0.35}s` }}>
                {player.name}
              </li>
            ))}
          </ul>
        )}
        <p className="coin-result" role="status">{winner?.name} beginnt!</p>
      </div>
    </div>
  );
}
