import { useCallback, useState } from "react";
import type { GameView } from "../../gameClient";

type Fx = GameView["fx"][number];

function Float({ item }: { item: Fx }) {
  // Position und Treffer-Blitz werden einmalig beim Einblenden gesetzt (das Ziel wird über data-Attribute gefunden).
  const place = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      const target = document.querySelector(item.card ? `[data-card="${item.card}"]` : `[data-player="${item.player}"]`);
      const rect = target?.getBoundingClientRect();
      if (!target || !rect) {
        element.style.display = "none";
        return;
      }
      element.style.left = `${rect.left + rect.width / 2}px`;
      element.style.top = `${rect.top + rect.height / 2}px`;
      const cls = item.type === "damage" ? "hit" : "healed";
      target.classList.add(cls);
      window.setTimeout(() => target.classList.remove(cls), 700);
    },
    [item.id, item.card, item.player, item.type]
  );
  return (
    <div ref={place} className={`fx-float ${item.type}`} aria-hidden="true">
      {item.type === "damage" ? "−" : "+"}
      {item.amount}
    </div>
  );
}

/** Schwebende Zahlen und Treffer-Blitze für Schaden und Heilung. Beim ersten Anzeigen werden bereits vergangene Effekte nicht erneut abgespielt. */
export default function FxLayer({ fx }: { fx: Fx[] }) {
  const [baseline] = useState(() => fx.at(-1)?.id ?? 0);
  return (
    <div className="fx-layer">
      {fx
        .filter(item => item.id > baseline)
        .map(item => (
          <Float key={item.id} item={item} />
        ))}
    </div>
  );
}
