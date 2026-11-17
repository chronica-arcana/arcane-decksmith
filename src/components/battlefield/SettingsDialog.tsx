import type { GameAction, GamePlayer } from "../../gameClient";

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="setting">
      <div>
        <strong>{label}</strong>
        <div className="muted">{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " on" : ""}`} onClick={() => onChange(!on)}>
        <span className="switch-knob" />
        <span className="switch-text">{on ? "An" : "Aus"}</span>
      </button>
    </div>
  );
}

/** Einstellungen mit An/Aus-Schaltern. */
export default function SettingsDialog({ me, act, onClose }: { me: GamePlayer; act: (action: GameAction) => void; onClose: () => void }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal small" role="dialog" aria-label="Einstellungen" onClick={event => event.stopPropagation()}>
        <div className="modal-head">
          <h3>Einstellungen</h3>
          <button type="button" className="secondary" onClick={onClose}>Schließen</button>
        </div>
        <Switch
          label="Karte automatisch ziehen"
          hint="An: Zu Beginn deines Zuges wird gezogen. Aus: Du klickst im Zieh-Schritt auf deine Bibliothek."
          on={me.autoStart ?? true}
          onChange={value => act({ type: "autoStart", value })}
        />
        <Switch
          label="Nachfragen, wenn ich antworten kann"
          hint="An: Wirkt dein Gegner etwas und du kannst mit einem Sofortzauber oder einer Fähigkeit antworten, hält das Spiel an. Aus: Es läuft immer durch."
          on={me.askResponse ?? true}
          onChange={value => act({ type: "askResponse", value })}
        />
      </div>
    </div>
  );
}
