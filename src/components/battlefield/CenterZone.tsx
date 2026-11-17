import type { ReactNode } from "react";
import type { GameCard } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView from "./CardView";

/**
 * Mitte des Tisches (kein eigener Kasten, nur die Mitte der Matte): links der Stapel (oberster zuerst), daneben die Kampfbahnen
 * (Angreifer mit Blockern darunter) und die Aktionsleiste. Sie erscheinen nur, wenn es etwas zu zeigen gibt.
 */
export default function CenterZone({ children }: { children: ReactNode }) {
  const { game, allCards, nameOf, clickCard, cardMenu, setHover, markOf, pendingBlocks, isTarget, pickTarget } = useBattlefield();
  const combat = game.combat;
  const lanes = (combat?.attackers ?? [])
    .map(attacker => {
      const card = allCards.get(attacker.id);
      if (!card) return null;
      const blockers: GameCard[] = [];
      for (const block of combat?.blocks ?? []) {
        if (block.attacker !== attacker.id) continue;
        const blocker = allCards.get(block.blocker);
        if (blocker) blockers.push(blocker);
      }
      for (const [blockerId, attackerId] of Object.entries(pendingBlocks)) {
        if (attackerId !== attacker.id) continue;
        const blocker = allCards.get(blockerId);
        if (blocker && !blockers.some(item => item.id === blocker.id)) blockers.push(blocker);
      }
      return { attacker, card, blockers };
    })
    .filter((lane): lane is NonNullable<typeof lane> => lane !== null);

  return (
    <section className="mid" aria-label="Mitte: Stapel und Kampf">
      {(game.stack.length > 0 || lanes.length > 0) && (
        <div className="mid-content">
          {game.stack.length > 0 && (
            <div className="stack" aria-label="Stapel">
              <span className="mid-title">Stapel</span>
              <div className="stack-cards">
                {[...game.stack].reverse().map((item, index) => (
                  <div key={item.sid} className={`stack-item${index === 0 ? " top" : ""}`}>
                    {item.card ? (
                      <CardView card={item.card} size="sm" marked={isTarget(item.sid) ? "target" : null} onHover={setHover} onMenu={cardMenu} onSelect={(card, event) => (isTarget(item.sid) ? pickTarget(item.sid) : clickCard(card, event))} />
                    ) : (
                      <span className="stack-ability">{item.text || "Fähigkeit"}</span>
                    )}
                    <span className="muted">{nameOf(item.controller)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {lanes.length > 0 && (
            <div className="combat" aria-label="Kampf">
              <span className="mid-title">Kampf</span>
              <div className="combat-lanes">
                {lanes.map(({ attacker, card, blockers }) => (
                  <div key={attacker.id} className="lane">
                    <span className="lane-target muted">→ {nameOf(attacker.target)}</span>
                    <CardView card={card} size="md" marked={markOf(card)} onSelect={clickCard} onHover={setHover} onMenu={cardMenu} />
                    <div className="lane-blockers">
                      {blockers.map(blocker => (
                        <CardView key={blocker.id} card={blocker} size="sm" marked={markOf(blocker)} onSelect={clickCard} onHover={setHover} onMenu={cardMenu} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
