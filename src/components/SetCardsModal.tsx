import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogA11y } from "./useDialogA11y";
import { getSetCards, imageFor, type ScryfallCard } from "../scryfall";
import {
  buildSetCardRows,
  filterSetCardRows,
  setProgressStats,
  type SetCardFilter
} from "../setProgress";
import type { CardRecord } from "../types";

const FILTERS: Array<{ value: SetCardFilter; label: string }> = [
  { value: "all", label: "Alle" },
  { value: "owned", label: "Vorhanden" },
  { value: "missing", label: "Fehlend" }
];

const RARITY_LABELS: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  mythic: "Mythic",
  special: "Special",
  bonus: "Bonus"
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; cards: ScryfallCard[] };

/** Pop-up mit allen Karten eines Sets; Karten, die man nicht besitzt, sind ausgegraut. */
export default function SetCardsModal({
  setCode,
  setName,
  ownedCards,
  onClose
}: {
  setCode: string;
  setName: string;
  /** Sammlungseinträge dieses Sets. */
  ownedCards: CardRecord[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<SetCardFilter>("all");
  const [attempt, setAttempt] = useState(0);

  useDialogA11y(dialogRef, onClose);

  useEffect(() => {
    let active = true;

    getSetCards(setCode)
      .then(cards => {
        if (active) setState({ status: "ready", cards });
      })
      .catch(error => {
        if (!active) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Die Karten konnten nicht geladen werden."
        });
      });

    return () => {
      active = false;
    };
  }, [setCode, attempt]);

  const rows = useMemo(
    () => (state.status === "ready" ? buildSetCardRows(state.cards, ownedCards) : []),
    [state, ownedCards]
  );
  const stats = useMemo(() => setProgressStats(rows, ownedCards), [rows, ownedCards]);
  const visible = useMemo(() => filterSetCardRows(rows, filter), [rows, filter]);

  return createPortal(
    <div
      className="card-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="set-cards-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-cards-title"
      >
        <header className="set-cards-head">
          <div>
            <h2 id="set-cards-title">
              {setName} <span className="muted">({setCode.toUpperCase()})</span>
            </h2>
            {state.status === "ready" && (
              <p className="muted" role="status">
                {stats.owned} / {stats.total} Karten · {stats.percent} %
                {stats.unmatched > 0 &&
                  ` · ${stats.unmatched} Sammlungseintrag${stats.unmatched === 1 ? "" : "e"} ohne Entsprechung in dieser Liste`}
              </p>
            )}
          </div>
          <button className="secondary" type="button" onClick={onClose} aria-label="Fenster schließen">
            ×
          </button>
        </header>

        {state.status === "ready" && rows.length > 0 && (
          <div className="set-cards-filters" role="group" aria-label="Anzeige filtern">
            {FILTERS.map(item => (
              <button
                key={item.value}
                type="button"
                className={filter === item.value ? "secondary active" : "secondary"}
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="set-cards-body">
          {state.status === "loading" && <div className="loading">Karten des Sets werden geladen…</div>}

          {state.status === "error" && (
            <div className="set-cards-message" role="alert">
              <strong>Die Karten des Sets konnten nicht geladen werden.</strong>
              <p className="muted">{state.message}</p>
              <button type="button" className="secondary" onClick={() => {
                  setState({ status: "loading" });
                  setAttempt(value => value + 1);
                }}>
                Erneut versuchen
              </button>
            </div>
          )}

          {state.status === "ready" && rows.length === 0 && (
            <div className="set-cards-message">
              <strong>Für dieses Set liefert Scryfall keine Karten.</strong>
            </div>
          )}

          {state.status === "ready" && rows.length > 0 && visible.length === 0 && (
            <div className="set-cards-message">
              <strong>{filter === "missing" ? "Keine fehlenden Karten – das Set ist komplett." : "Keine Karten in dieser Ansicht."}</strong>
            </div>
          )}

          {visible.length > 0 && (
            <div className="set-cards-grid">
              {visible.map(({ card, owned }) => {
                const image = imageFor(card);
                const rarity = card.rarity ? RARITY_LABELS[card.rarity] ?? card.rarity : "";

                return (
                  <article
                    key={card.id}
                    className={`collection-card set-card${owned > 0 ? "" : " set-card-missing"}`}
                    aria-label={`${card.name}, Nummer ${card.collector_number}, ${
                      owned > 0 ? `${owned} mal im Besitz` : "nicht im Besitz"
                    }`}
                  >
                    {owned > 0 && <div className="collection-card-count">{owned}×</div>}

                    {image ? (
                      <img src={image} alt={card.name} loading="lazy" />
                    ) : (
                      <div className="collection-card-image-placeholder">Kein Bild</div>
                    )}

                    <div className="card-body">
                      <h3>{card.name}</h3>
                      <div className="meta">
                        #{card.collector_number}
                        {rarity && ` · ${rarity}`}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
