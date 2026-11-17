import type { GameStep, GameView } from "../../gameClient";

type Item = { key: string; label: string; auto?: boolean; steps: GameStep[]; sub?: { step: GameStep; label: string }[] };

const ITEMS: Item[] = [
  { key: "untap", label: "Enttappen", auto: true, steps: ["untap"] },
  { key: "upkeep", label: "Versorgung", auto: true, steps: ["upkeep"] },
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
export default function PhaseStrip({ game, activeName }: { game: GameView; activeName: string }) {
  const current = game.turn.phase;
  const currentIndex = ITEMS.findIndex(item => item.steps.includes(current));
  return (
    <nav className="phase-strip" aria-label="Phasen">
      <span className="phase-turn">Zug {game.turn.number} · {activeName}</span>
      <ol className="phase-list">
        {ITEMS.map((item, index) => {
          const on = item.steps.includes(current);
          const done = (item.auto && !game.turn.manualStart) || currentIndex > index;
          return (
            <li key={item.key} className={`phase${on ? " on" : ""}${done ? " done" : ""}${item.auto && !game.turn.manualStart ? " auto" : ""}`} aria-current={on ? "step" : undefined}>
              <span className="phase-dot" aria-hidden="true" />
              <span className="phase-label">{item.label}</span>
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
