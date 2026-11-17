import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean; heading?: boolean };

/** Kontextmenü an einer Bildschirmposition; schließt bei Klick daneben, Escape oder Scrollen. Zeigt nur die übergebenen (möglichen) Einträge. */
export default function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4))
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const close = (event: Event) => {
      if (event.type === "pointerdown" && ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="table-menu" role="menu" style={pos}>
      {items.map((item, index) =>
        item.heading ? (
          <div key={`${item.label}-${index}`} className="table-menu-head">{item.label}</div>
        ) : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
