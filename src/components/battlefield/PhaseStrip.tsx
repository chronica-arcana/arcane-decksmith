import type { GameStep, GameView } from "../../gameClient";

type Item = { key: string; label: string; auto?: boolean; steps: GameStep[]; sub?: { step: GameStep; label: string }[] };

const ITEMS: Item[] = [
  { key: "untap", label: "Enttappen", auto: true, steps: [] },
  { key: "upkeep", label: "Versorgung", auto: true, steps: [] },
  { key: "draw", label: "Ziehen", auto: true, steps: ["draw"] },
  { key: "main1", label: "Hauptphase 1", steps: ["main1"] },
  {
    key: "combat",
    label: "Kampf",
    steps: ["attackers", "blockers", "damage"],
    sub: [
      { step: "attackers", label: "Angreifer" },
      { step: "blockers", label: "Blocker" },
      { step: "damage", label: "Schaden" }
    ]
  },
  { key: "main2", label: "Hauptphase 2", steps: ["main2"] },
  { key: "end", label: "Zugende", steps: ["end"] }
];

/** Zeitleiste des Zuges unter der eigenen Hand: Enttappen, Versorgung und Ziehen laufen automatisch, danach Haupt-, Kampf- und Endphasen. */
export default function PhaseStrip({ game, activeName, hint, detail, pass, onPass }: { game: GameView; activeName: string; hint?: string; detail?: string; pass?: { label: string; next: "combat" | "main2" | "end" } | null; onPass?: () => void }) {
  const current = game.turn.phase;
  const currentIndex = ITEMS.findIndex(item => item.steps.includes(current));
  return (
    <nav className="phase-strip" aria-label="Phasen">
      <span className="phase-turn">Zug {game.turn.number} · {activeName}</span>
      {game.phase === "playing" && hint && (
        // Der Zugwechsel erscheint nur kurz (CSS-Animation); ein neuer key startet sie neu.
        <span key={`${game.turn.number}-${game.turn.active}`} className="phase-hint" role="status">
          {hint}
          {detail && <small> · {detail}</small>}
        </span>
      )}
      <ol className="phase-list">
        {ITEMS.map((item, index) => {
          const on = item.steps.includes(current);
          const manualDraw = item.key === "draw" && game.turn.manualStart;
          const done = (item.auto && !manualDraw) || currentIndex > index;
          const next = Boolean(pass && onPass && ((pass.next === "combat" && item.key === "combat") || (pass.next === "main2" && item.key === "main2") || (pass.next === "end" && item.key === "end")));
          return (
            <li key={item.key} className={`phase${next ? " next" : ""}${on ? " on" : ""}${done ? " done" : ""}${item.auto && !manualDraw ? " auto" : ""}`} aria-current={on ? "step" : undefined}>
              <span className="phase-dot" aria-hidden="true" />
              {next && pass ? (
                <button type="button" className="phase-next" title={pass.label} aria-label={pass.label} onClick={onPass}>
                  {item.label}<span aria-hidden="true"> →</span>
                </button>
              ) : (
                <span className="phase-label">{item.label}</span>
              )}
              {item.sub && on && (
                <span className="phase-sub">
                  {item.sub.map(sub => (
                    <span key={sub.step} className={sub.step === current ? "on" : ""}>{sub.label}</span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
