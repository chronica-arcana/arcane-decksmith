import { useEffect, useState } from "react";
import type { GameAction, GameCard, GamePlayer, GameStep, GameView } from "../../gameClient";


export type ActionBarProps = {
  game: GameView;
  me: GamePlayer;
  hostId: string;
  nameOf: (userId: string | null) => string;
  allCards: Map<string, GameCard>;
  act: (action: GameAction) => void;
  iHavePriority: boolean;
  isActive: boolean;
  discarding: boolean;
  attackStep: boolean;
  awaitingMe: boolean;
  livingOpponents: GamePlayer[];
  attackPick: string[];
  clearAttackPick: () => void;
  target: string;
  setAttackTarget: (userId: string) => void;
  blockPick: string | null;
  blocks: Record<string, string>;
  resetBlocks: () => void;
  discardPick: string[];
  clearDiscardPick: () => void;
  canAttack: boolean;
  targeting: { name: string; specs: { kind: string }[]; picked: string[] } | null;
  cancelTargeting: () => void;
  onRematch: () => void;
  onLeave: () => void;
};

const TARGET_LABELS: Record<string, string> = {
  any: "ein beliebiges Ziel", player: "einen Spieler", opponent: "einen Gegner", creature: "eine Kreatur", planeswalker: "einen Planeswalker",
  artifact: "ein Artefakt", enchantment: "eine Verzauberung", land: "ein Land", permanent: "einen Permanent", nonland: "einen Nichtland-Permanent",
  creatureOrPlaneswalker: "eine Kreatur oder einen Planeswalker", artifactOrEnchantment: "ein Artefakt oder eine Verzauberung",
  paySacrifice: "eine Karte, die du opferst", payDiscard: "eine Karte, die du abwirfst", payTap: "ein Permanent, das du tappst", payCounter: "ein Permanent, von dem ein Marker entfernt wird", spell: "einen Zauber", creatureSpell: "einen Kreaturenzauber", noncreatureSpell: "einen Nichtkreaturenzauber", instantOrSorcerySpell: "einen Spontan- oder Hexereizauber"
};

/**
 * Kann der Spieler gerade einfach zur nächsten Phase weitergehen? Dann übernimmt die Phasenleiste unten den Knopf
 * (die nächste Phase pulsiert) – die Aktionsleiste zeigt ihn nicht mehr. Rückgabe: Beschriftung und Ziel-Phase.
 */
export function passInfo(props: ActionBarProps): { label: string; next: "combat" | "main2" | "end" } | null {
  const { game } = props;
  const step: GameStep = game.turn.phase;
  if (game.phase === "ended" || props.targeting || game.manual?.userId === game.you || props.me.prompts[0]) return null;
  if (props.discarding && game.pendingDiscard) return null;
  if (props.attackStep && props.iHavePriority) return null;
  if (props.awaitingMe && step === "blockers" && game.stack.length === 0) return null;
  if (!props.iHavePriority || !props.isActive || game.stack.length > 0 || step === "draw" || step === "blockers") return null;
  const attack = props.canAttack && props.livingOpponents.length > 0;
  if (step === "main1") return { label: attack ? "Weiter zum Kampf" : "Weiter zur Hauptphase 2", next: attack ? "combat" : "main2" };
  if (step === "attackers") return { label: "Kein Angriff", next: "main2" };
  if (step === "damage") return { label: "Kampfschaden verursachen", next: "main2" };
  if (step === "main2") return { label: "Zug beenden", next: "end" };
  return { label: "Zug beenden", next: "end" };
}

/** Die einzige Schaltflächenleiste: zeigt nur, was im aktuellen Moment wirklich möglich ist. Prioritäts-Hinweise gibt es bewusst nicht. */
export default function ActionBar(props: ActionBarProps) {
  const { game, me, act, nameOf } = props;
  const step: GameStep = game.turn.phase;
  const winner = game.players.find(player => player.userId === game.winner);

  if (game.phase === "ended") {
    return (
      <div className="action-bar" role="status">
        <strong>Das Spiel ist beendet. {winner ? `${winner.name} gewinnt.` : "Kein Sieger."}</strong>
        {game.you === props.hostId ? (
          <button type="button" className="primary" onClick={props.onRematch}>Revanche</button>
        ) : (
          <span className="muted">Der Gastgeber ({nameOf(props.hostId)}) kann eine Revanche starten.</span>
        )}
        <button type="button" className="secondary" onClick={props.onLeave}>Raum verlassen</button>
      </div>
    );
  }

  if (props.targeting) {
    const spec = props.targeting.specs[props.targeting.picked.length];
    return (
      <div className="action-bar" role="status">
        <strong>{props.targeting.name}: Wähle {TARGET_LABELS[spec?.kind ?? ""] ?? "ein Ziel"} (leuchtet auf).</strong>
        <button type="button" className="secondary" onClick={props.cancelTargeting}>Abbrechen</button>
      </div>
    );
  }

  if (game.manual?.userId === game.you) {
    return (
      <div className="action-bar" role="alert">
        <strong>Dieser Kartentext lässt sich nicht automatisch umsetzen: {game.manual.text}</strong>
        {(game.manual.hints?.length ?? 0) > 0 ? (
          <span className="manual-hints" aria-label="Vorschläge">
            {game.manual.hints!.map(hint =>
              hint.action ? (
                <button
                  key={hint.label}
                  type="button"
                  className="secondary"
                  onClick={() => {
                    for (let i = 0; i < Math.max(1, hint.repeat ?? 1); i += 1) act(hint.action!);
                  }}
                >
                  {hint.label}
                </button>
              ) : (
                <span key={hint.label} className="muted manual-tip">{hint.label}</span>
              )
            )}
          </span>
        ) : (
          <span className="muted">Du darfst jetzt von Hand eingreifen (Rechtsklick auf Karten, Bibliothek, ⋯-Menü).</span>
        )}
        <button type="button" className="primary" onClick={() => act({ type: "manualDone" })}>Fertig</button>
      </div>
    );
  }

  const prompt = me.prompts[0];
  if (prompt) {
    return (
      <div className="action-bar" role="alert">
        <strong>{props.allCards.get(prompt.id)?.name ?? "Dein Kommandant"} hat das Spiel verlassen. In die Kommandozone zurücklegen?</strong>
        <button type="button" className="primary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: true })}>Ja, in die Kommandozone</button>
        <button type="button" className="secondary" onClick={() => act({ type: "commanderZone", id: prompt.id, yes: false })}>Nein</button>
      </div>
    );
  }

  if (props.discarding && game.pendingDiscard) {
    const { count } = game.pendingDiscard;
    return (
      <div className="action-bar" role="alert">
        <strong>Handkartenlimit: Wähle {count} Karte{count === 1 ? "" : "n"} in deiner Hand zum Abwerfen ({props.discardPick.length}/{count}).</strong>
        <button
          type="button"
          className="primary"
          disabled={props.discardPick.length !== count}
          onClick={() => {
            act({ type: "discard", ids: props.discardPick });
            props.clearDiscardPick();
          }}
        >
          Abwerfen
        </button>
      </div>
    );
  }

  if (props.attackStep && props.iHavePriority) {
    return (
      <div className="action-bar" role="status">
        <strong>Angriff: Klicke deine Kreaturen an, die angreifen sollen ({props.attackPick.length} gewählt).</strong>
        {(props.livingOpponents.length > 1 || props.livingOpponents.some(player => player.battlefield.some(card => /Planeswalker/.test(card.typeLine ?? "")))) && (
          <label>
            Ziel{" "}
            <select value={props.target} onChange={event => props.setAttackTarget(event.target.value)} aria-label="Angriffsziel">
              {props.livingOpponents.flatMap(player => [
                <option key={player.userId} value={player.userId}>{player.name}</option>,
                ...player.battlefield
                  .filter(card => /Planeswalker/.test(card.typeLine ?? ""))
                  .map(card => (
                    <option key={card.id} value={card.id}>{card.name} ({player.name})</option>
                  ))
              ])}
            </select>
          </label>
        )}
        {props.attackPick.length > 0 && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              act({ type: "declareAttackers", attackers: props.attackPick.map(id => ({ id, target: props.target })) });
              props.clearAttackPick();
            }}
          >
            Angriff bestätigen
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            props.clearAttackPick();
            act({ type: "pass" });
          }}
        >
          Kein Angriff
        </button>
      </div>
    );
  }

  if (props.awaitingMe && step === "blockers" && game.stack.length === 0) {
    const count = Object.keys(props.blocks).length;
    return (
      <div className="action-bar" role="status">
        <strong>
          Du wirst angegriffen. {props.blockPick ? "Klicke jetzt den Angreifer an, den diese Kreatur blocken soll." : "Klicke eine deiner Kreaturen an, dann den Angreifer."}
          {count > 0 ? ` (${count} Block${count === 1 ? "" : "s"})` : ""}
        </strong>
        <button
          type="button"
          className="primary"
          onClick={() => {
            // Die Auswahl bleibt stehen, bis der Server den Block annimmt (dann endet „awaitingMe“); bei Ablehnung erscheint die Meldung.
            act({ type: "declareBlockers", blocks: Object.entries(props.blocks).map(([blocker, attacker]) => ({ blocker, attacker })) });
          }}
        >
          {count === 0 ? "Nicht blocken" : "Blocken bestätigen"}
        </button>
        {count > 0 && <button type="button" className="secondary" onClick={props.resetBlocks}>Zurücksetzen</button>}
      </div>
    );
  }

  if (props.iHavePriority && props.isActive && game.stack.length === 0 && step === "draw") {
    return (
      <div className="action-bar side" role="status">
        <strong>Ziehen: Klicke auf deine Bibliothek, um eine Karte zu ziehen.</strong>
      </div>
    );
  }

  if (props.iHavePriority && game.stack.length > 0) {
    // Nur wer wirklich antworten kann, wird überhaupt gefragt.
    const top = game.stack.at(-1)!;
    const what = top.card ? `${top.card.name}.` : `${top.sourceName ?? "Effekt"}: ${(top.text || "Fähigkeit").replace(/~/g, top.sourceName ?? "")}`;
    return (
      <div className="action-bar side" role="alert">
        <strong>Reaktion ausspielen? {nameOf(top.controller)} spielt {what}</strong>
        <span className="muted">Die leuchtenden Karten kannst du jetzt spielen.</span>
        <button type="button" className="primary go" onClick={() => act({ type: "pass" })}>Nein</button>
      </div>
    );
  }

  // Antwortfenster ohne Stapel (z. B. vor dem Kampfschaden): nur wer reagieren darf, sieht die Frage.
  if (props.iHavePriority && !props.isActive) {
    return (
      <div className="action-bar side" role="alert">
        <strong>Reaktion ausspielen?</strong>
        <span className="muted">Die leuchtenden Karten kannst du jetzt spielen.</span>
        <button type="button" className="primary go" onClick={() => act({ type: "pass" })}>Nein</button>
      </div>
    );
  }

  // Weiter-Knopf: sitzt in der Phasenleiste (nächste Phase pulsiert).
  if (passInfo(props)) return null;
  if (props.iHavePriority) return null;

  const waiting = game.manual
    ? `${nameOf(game.manual.userId)} setzt einen Kartentext um …`
    : game.choice
      ? `${nameOf(game.choice.userId)} trifft eine Auswahl …`
      : game.combat?.awaiting.length
        ? `${game.combat.awaiting.map(nameOf).join(", ")} bestimmt Blocker …`
        : game.pendingDiscard
          ? `${nameOf(game.pendingDiscard.userId)} wirft Karten ab …`
          : game.priority && game.priority !== game.turn.active
            ? `Warten auf Reaktion von ${nameOf(game.priority)} …`
            : game.priority
              ? `${nameOf(game.priority)} überlegt …`
              : "";
  if (!waiting) return null;
  // „Warten auf Reaktion“ bleibt stehen, solange das Spiel wirklich auf jemanden wartet; bloßes „überlegt“ verschwindet nach kurzer Zeit.
  return /^Warten auf Reaktion/.test(waiting) ? (
    <div className="action-bar side hint" role="status">
      <span className="muted">{waiting}</span>
    </div>
  ) : (
    <TransientHint key={waiting} text={waiting} />
  );
}

/** Wartehinweise („… überlegt …“) erscheinen nur kurz und verschwinden dann von selbst; bei neuem Text kommen sie wieder. */
function TransientHint({ text }: { text: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 2800);
    return () => window.clearTimeout(timer);
  }, []);
  return visible ? (
    <div className="action-bar side hint" role="status">
      <span className="muted">{text}</span>
    </div>
  ) : null;
}
