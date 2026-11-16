import { useEffect, useState } from "react";
import type { DeckCheck, GameApi, RoomFormat } from "../../gameClient";
import { GameApiError } from "../../gameClient";
import type { DeckRecord } from "../../types";

export type DeckPickerResult = { deckId: string | null; ok: boolean };

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; check: DeckCheck }
  | { status: "error"; message: string };

/**
 * Deck-Auswahl für einen Raum. Die Prüfung läuft auf dem Server: Besitz gegen die Sammlung und Gültigkeit
 * für das Format. Ungültige Decks werden mit einer genauen Liste der Probleme angezeigt.
 */
export default function DeckPicker({
  decks,
  format,
  api,
  onChange
}: {
  decks: DeckRecord[];
  format: RoomFormat;
  api: GameApi;
  onChange: (result: DeckPickerResult) => void;
}) {
  const matching = decks.filter(deck => deck.format === format);
  const [deckId, setDeckId] = useState("");
  const [state, setState] = useState<CheckState>({ status: "idle" });

  // Format oder Deckliste ändert sich: Auswahl zurücksetzen.
  useEffect(() => {
    setDeckId("");
    setState({ status: "idle" });
    onChange({ deckId: null, ok: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format]);

  const choose = async (id: string) => {
    setDeckId(id);
    if (!id) {
      setState({ status: "idle" });
      onChange({ deckId: null, ok: false });
      return;
    }
    setState({ status: "checking" });
    onChange({ deckId: id, ok: false });
    try {
      const check = await api.checkDeck(id, format);
      setState({ status: "done", check });
      onChange({ deckId: id, ok: check.ok });
    } catch (error) {
      setState({ status: "error", message: error instanceof GameApiError ? error.message : "Die Prüfung ist fehlgeschlagen." });
      onChange({ deckId: id, ok: false });
    }
  };

  return (
    <div className="game-deck-picker">
      <label>
        Deck
        <select value={deckId} onChange={event => void choose(event.target.value)} aria-label="Deck wählen">
          <option value="">
            {matching.length === 0 ? `Kein ${format === "commander" ? "Commander" : "Standard"}-Deck vorhanden` : "Deck wählen …"}
          </option>
          {matching.map(deck => (
            <option key={deck.id} value={deck.id}>
              {deck.name}
            </option>
          ))}
        </select>
      </label>

      {state.status === "checking" && <p className="muted" role="status">Deck wird geprüft …</p>}

      {state.status === "error" && <div className="error" role="alert">{state.message}</div>}

      {state.status === "done" && state.check.ok && (
        <div className="notice" role="status">
          Das Deck ist spielbereit ({state.check.summary.totalCards} Karten).
        </div>
      )}

      {state.status === "done" && !state.check.ok && (
        <div className="error" role="alert">
          <strong>Mit diesem Deck kannst du den Raum nicht betreten:</strong>
          <ul>
            {state.check.errors.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
