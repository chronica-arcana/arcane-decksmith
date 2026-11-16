import { useEffect, useState } from "react";
import type { GameApi, HistoryEntry } from "../../gameClient";

const FORMATS = { standard: "Standard", commander: "Commander" } as const;

/** Verlauf der letzten Spiele (bis zu 50) mit einfacher Bilanz. */
export default function HistoryPanel({ api }: { api: GameApi }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api
      .getHistory()
      .then(list => active && setEntries(list))
      .catch(() => active && setError("Der Verlauf konnte nicht geladen werden."));
    return () => {
      active = false;
    };
  }, [api]);

  if (error) return <div className="panel"><div className="error" role="alert">{error}</div></div>;
  if (!entries) return null;

  const played = entries.filter(entry => !entry.aborted);
  const wins = played.filter(entry => entry.won).length;

  return (
    <div className="panel">
      <h3>Deine letzten Spiele</h3>
      {entries.length === 0 ? (
        <p className="muted">Noch keine Spiele. Erstelle einen Raum und lade jemanden ein.</p>
      ) : (
        <>
          <p className="muted">
            Bilanz der letzten {played.length} Spiele: {wins} Siege, {played.length - wins} Niederlagen.
          </p>
          <ul aria-label="Spielverlauf">
            {entries.map(entry => (
              <li key={entry.id}>
                {new Date(entry.endedAt).toLocaleString("de-DE")} · {FORMATS[entry.format]} · {entry.turns} Züge ·{" "}
                <strong>{entry.aborted ? "abgebrochen" : entry.won ? "Sieg" : "Niederlage"}</strong> ·{" "}
                {entry.players.map(player => `${player.name} (${player.deckName})`).join(" gegen ")}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
