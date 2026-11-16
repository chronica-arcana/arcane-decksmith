import type { DragEvent } from "react";
import type { GameCard } from "../../gameClient";

export type TileSize = "sm" | "md" | "lg";

/** Eine Karte auf dem Tisch: Bild, Stärke/Widerstandskraft, Marker, Zustände (getappt, beschwörungsmüde, Angriff, Block). */
export default function GameCardTile({
  card,
  size = "md",
  selected,
  glow,
  marked,
  onSelect,
  onHover,
  onDragStart
}: {
  card: GameCard;
  size?: TileSize;
  selected?: boolean;
  /** Spielbar/zahlbar: grüner Schein. */
  glow?: boolean;
  /** Zusätzliche Markierung (z. B. gewählter Angreifer oder Blocker). */
  marked?: "attack" | "block" | "pick" | null;
  onSelect?: (card: GameCard) => void;
  onHover?: (card: GameCard | null) => void;
  onDragStart?: (card: GameCard, event: DragEvent) => void;
}) {
  const counters = Object.entries(card.counters);
  const hidden = card.name === undefined;
  const hasStats = card.power !== undefined && card.power !== null && card.toughness !== undefined && card.toughness !== null;
  const classes = [
    "gc",
    size,
    card.tapped ? "tapped" : "",
    selected ? "selected" : "",
    glow ? "glow" : "",
    card.sick && card.kind === "creature" ? "sick" : "",
    card.attacking ? "attacking" : "",
    card.blocking ? "blocking" : "",
    marked ? `mark-${marked}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      draggable={Boolean(onDragStart)}
      onDragStart={event => onDragStart?.(card, event)}
      onClick={() => onSelect?.(card)}
      onMouseEnter={() => onHover?.(card)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(card)}
      onBlur={() => onHover?.(null)}
      aria-label={`${card.name ?? "Verdeckte Karte"}${card.tapped ? ", getappt" : ""}${card.sick && card.kind === "creature" ? ", beschwörungsmüde" : ""}${card.attacking ? ", greift an" : ""}`}
      aria-pressed={selected}
      title={card.name ?? "Verdeckte Karte"}
    >
      {hidden ? (
        <span className="gc-back">Verdeckt</span>
      ) : card.imageUri ? (
        <img src={card.imageUri} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="gc-text">
          <strong>{card.name}</strong>
          <small>{card.typeLine}</small>
        </span>
      )}
      {card.token && <span className="gc-badge token">Token</span>}
      {card.cmd && <span className="gc-badge cmd">Kommandant</span>}
      {hasStats && (
        <span className={`gc-stats${card.damage > 0 ? " hurt" : ""}`} aria-label={`Stärke ${card.power}, Widerstandskraft ${card.toughness}${card.damage ? `, ${card.damage} Schaden` : ""}`}>
          {card.power}/{card.toughness! - card.damage}
        </span>
      )}
      {counters.length > 0 && (
        <span className="gc-counters">
          {counters.map(([kind, n]) => (
            <span key={kind}>
              {n}× {kind}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
