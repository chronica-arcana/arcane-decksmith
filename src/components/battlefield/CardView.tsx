import { useRef } from "react";
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent } from "react";
import type { GameCard } from "../../gameClient";
import cardBack from "../../assets/game/cardback.webp";
import { ManaSymbol } from "./ManaSymbol";
import { imageFor } from "./scryfallAssets";

export type TileSize = "sm" | "md" | "lg" | "fill";

/** Rückseite einer Karte (Bibliothek, Hand der Gegner, verdeckte Karten). */
export function CardBack({ className = "" }: { className?: string }) {
  return <img className={`gc-backimg ${className}`} src={cardBack} alt="" draggable={false} />;
}

/**
 * Eine Karte auf dem Tisch. Klick = Hauptaktion, Rechtsklick oder langes Drücken = Menü, Ziehen = Karte bewegen,
 * Darüberfahren = große Vorschau.
 */
export default function CardView({
  card,
  size = "md",
  style,
  selected,
  glow,
  marked,
  onSelect,
  onHover,
  onMenu,
  onDragStart
}: {
  card: GameCard;
  size?: TileSize;
  style?: CSSProperties;
  selected?: boolean;
  /** Spielbar/zahlbar: grüner Schein. */
  glow?: boolean;
  marked?: "attack" | "block" | "pick" | "target" | null;
  onSelect?: (card: GameCard, event: MouseEvent) => void;
  onHover?: (card: GameCard | null) => void;
  onMenu?: (card: GameCard, x: number, y: number) => void;
  onDragStart?: (card: GameCard, event: DragEvent) => void;
}) {
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
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

  const startPress = (event: PointerEvent) => {
    if (!onMenu || event.pointerType === "mouse") return;
    const { clientX, clientY } = event;
    press.current = {
      fired: false,
      timer: window.setTimeout(() => {
        if (press.current) press.current.fired = true;
        onMenu(card, clientX, clientY);
      }, 500)
    };
  };
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };

  return (
    <button
      type="button"
      className={classes}
      style={style}
      draggable={Boolean(onDragStart)}
      onDragStart={event => onDragStart?.(card, event)}
      onClick={event => {
        if (press.current?.fired) {
          press.current = null;
          return;
        }
        onSelect?.(card, event);
      }}
      onContextMenu={event => {
        event.preventDefault();
        onMenu?.(card, event.clientX, event.clientY);
      }}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onMouseEnter={() => onHover?.(card)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(card)}
      onBlur={() => onHover?.(null)}
      aria-label={`${card.name ?? "Verdeckte Karte"}${card.tapped ? ", getappt" : ""}${card.sick && card.kind === "creature" ? ", beschwörungsmüde" : ""}${card.attacking ? ", greift an" : ""}`}
      title={card.name ?? "Verdeckte Karte"}
    >
      {hidden ? (
        <CardBack />
      ) : card.imageUri ? (
        <img src={imageFor(card.imageUri, size === "sm" ? "small" : "normal") ?? card.imageUri} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="gc-text">
          <strong>{card.name}</strong>
          <small>{card.typeLine}</small>
        </span>
      )}
      {card.mana && !card.tapped && !card.sick && (card.manaColors?.length ?? 0) > 0 && (
        <span className="gc-mana" title="Anklicken für Mana">
          <ManaSymbol symbol={`{${card.manaColors![0]}}`} size={15} />
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
