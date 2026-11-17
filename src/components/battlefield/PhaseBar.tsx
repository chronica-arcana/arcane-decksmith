import type { GameStep, GameView } from "../../gameClient";

type Item = { key: string; label: string; auto?: boolean; steps: GameStep[]; sub?: { step: GameStep; label: string }[] };

const ITEMS: Item[] = [
  { key: "untap", label: "Enttappen", auto: true, steps: [] },
  { key: "upkeep", label: "Versorgung", auto: true, steps: [] },
  { key: "draw", label: "Ziehen", auto: true, steps: [] },
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

/** Zeitleiste des Zuges: Enttappen, Versorgung und Ziehen laufen automatisch, danach Haupt-, Kampf- und Endphasen. */
export default function PhaseBar({ game, activeName }: { game: GameView; activeName: string }) {
  const current = game.turn.phase;
  return (
    <nav className="phase-bar" aria-label="Phasen">
      <div className="phase-head">
        <span className="phase-turn">Zug {game.turn.number}</span>
        <span className="phase-active">{activeName}</span>
      </div>
      <ol className="phase-list">
        {ITEMS.map(item => {
          const on = item.steps.includes(current);
          const done = item.auto || ITEMS.findIndex(other => other.steps.includes(current)) > ITEMS.indexOf(item);
          return (
            <li key={item.key} className={`phase${on ? " on" : ""}${done ? " done" : ""}${item.auto ? " auto" : ""}`} aria-current={on ? "step" : undefined}>
              <span className="phase-dot" aria-hidden="true" />
              <span className="phase-label">{item.label}</span>
              {item.sub && on && (
                <ul className="phase-sub">
                  {item.sub.map(sub => (
                    <li key={sub.step} className={sub.step === current ? "on" : ""}>{sub.label}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
