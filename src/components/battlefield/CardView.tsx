import { useEffect, useRef, useState } from "react";
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent } from "react";
import type { GameCard } from "../../gameClient";
import cardBack from "../../assets/game/cardback.webp";
import { ManaSymbol } from "./ManaSymbol";
import { imageFor } from "./scryfallAssets";
import { tokenImage } from "./tokenImage";

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
  const [tokenUri, setTokenUri] = useState<string | null>(null);
  const needsTokenImage = Boolean(card.token && !card.imageUri && card.name !== undefined);
  useEffect(() => {
    if (!needsTokenImage || !card.name) return undefined;
    let cancelled = false;
    void tokenImage(card.name, card.power, card.toughness).then(uri => {
      if (!cancelled) setTokenUri(uri);
    });
    return () => {
      cancelled = true;
    };
  }, [needsTokenImage, card.name, card.power, card.toughness]);
  const imageUri = card.imageUri ?? tokenUri;
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
      data-card={card.id}
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
      ) : imageUri ? (
        <img src={imageFor(imageUri, size === "sm" ? "small" : "normal") ?? imageUri} alt="" loading="lazy" draggable={false} />
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
      {card.cmd && <span className="gc-badge cmd" title="Kommandant">♛ {size === "sm" ? "Kdr." : "Kommandant"}</span>}
      {card.goaded && <span className="gc-badge chosen" title="Aufgestachelt: greift jeden Kampf an, wenn möglich einen anderen Spieler">Goad</span>}
      {card.chosenType && <span className="gc-badge chosen" title={`Gewählter Typ: ${card.chosenType}`}>Typ: {card.chosenType}</span>}
      {card.attachedName && <span className="gc-badge attach" title={`Hängt an ${card.attachedName}`}>↳ {card.attachedName}</span>}
      {(card.attachments?.length ?? 0) > 0 && <span className="gc-badge attached" title={card.attachments!.join(", ")}>+ {card.attachments!.join(", ")}</span>}
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
