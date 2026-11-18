import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPreconDeck,
  loadPreconDeckList,
  preconCollectionCards,
  preconDeckRecord,
  resolvePreconDeck,
  type PreconDeck,
  type PreconDeckSummary,
  type PreconResolution
} from "../precons";
import type { CardRecord, DeckRecord } from "../types";
import { useDialogA11y } from "./useDialogA11y";
import "../importDialog.css";

type PreconImportDialogProps = {
  collection: CardRecord[];
  onClose: () => void;
  onAddCards: (cards: CardRecord[]) => Promise<void>;
  onSaveDeck: (deck: DeckRecord) => Promise<void>;
};

/** So viele Decks zeigt die Liste auf einmal; „Mehr anzeigen“ lädt weitere (es gibt über 200 Commander-Decks). */
const PAGE_SIZE = 60;

function sectionLabel(section: string): string {
  if (section === "commander") return "Commander";
  if (section === "sideboard") return "Zusatzkarten";
  return "Deck";
}

export default function PreconImportDialog({
  collection,
  onClose,
  onAddCards,
  onSaveDeck
}: PreconImportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [decks, setDecks] = useState<PreconDeckSummary[]>([]);
  const [listBusy, setListBusy] = useState(true);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("Commander Deck");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [deck, setDeck] = useState<PreconDeck | null>(null);
  const [resolution, setResolution] = useState<PreconResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [confirmed, setConfirmed] = useState(false);
  const [addToCollection, setAddToCollection] = useState(true);
  const [createDeck, setCreateDeck] = useState(true);
  // Bei einem Wiederholungsversuch (z. B. Deck-Speichern schlug fehl) dürfen die
  // Karten nicht ein zweites Mal zur Sammlung addiert werden.
  const [collectionDone, setCollectionDone] = useState(false);
  const [error, setError] = useState("");

  useDialogA11y(dialogRef, () => {
    if (!busy) onClose();
  });

  useEffect(() => {
    let cancelled = false;
    loadPreconDeckList()
      .then(list => {
        if (!cancelled) setDecks(list);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Precon-Liste konnte nicht geladen werden.");
      })
      .finally(() => {
        if (!cancelled) setListBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of decks) counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [decks]);

  const filteredDecks = useMemo(() => {
    const search = query.trim().toLowerCase();
    return decks.filter(item =>
      (!type || item.type === type) &&
      (!search ||
        item.name.toLowerCase().includes(search) ||
        item.code.toLowerCase() === search ||
        item.releaseDate.startsWith(search))
    );
  }, [decks, query, type]);

  const visibleDecks = filteredDecks.slice(0, limit);

  const collectionCards = useMemo(
    () => resolution ? preconCollectionCards(resolution.resolved) : [],
    [resolution]
  );

  const totalCopies = deck?.rows.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const resolvedCopies = resolution?.resolved.reduce((sum, item) => sum + item.row.count, 0) ?? 0;
  const unresolvedCopies = resolution?.unresolved.reduce((sum, row) => sum + row.count, 0) ?? 0;

  const ownedIds = useMemo(() => new Set(collection.map(card => card.id)), [collection]);
  const alreadyOwned = collectionCards.filter(card => ownedIds.has(card.id)).length;

  const groupedRows = useMemo(() => {
    if (!resolution) return [];
    const sections = ["commander", "main", "sideboard"] as const;
    return sections
      .map(section => ({
        section,
        rows: resolution.resolved
          .filter(item => item.row.section === section)
          .sort((a, b) => a.card.name.localeCompare(b.card.name, "de"))
      }))
      .filter(group => group.rows.length > 0);
  }, [resolution]);

  const selectDeck = async (summary: PreconDeckSummary) => {
    setBusy(true);
    setError("");
    setDeck(null);
    setResolution(null);
    setConfirmed(false);
    setCollectionDone(false);
    setProgress({ processed: 0, total: 0 });

    try {
      const loaded = await loadPreconDeck(summary);
      setDeck(loaded);
      setProgress({ processed: 0, total: loaded.rows.length });
      const resolved = await resolvePreconDeck(loaded, (processed, total) =>
        setProgress({ processed, total })
      );
      setResolution(resolved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deck konnte nicht geladen werden.");
    } finally {
      setBusy(false);
    }
  };

  const backToList = () => {
    setDeck(null);
    setResolution(null);
    setConfirmed(false);
    setCollectionDone(false);
    setError("");
  };

  const nothingSelected = !addToCollection && !createDeck;

  const apply = async () => {
    if (!deck || !resolution || !confirmed || busy || nothingSelected || collectionCards.length === 0) return;
    setBusy(true);
    setError("");
    let collectionSaved = collectionDone;
    try {
      if (addToCollection && !collectionSaved) {
        await onAddCards(collectionCards);
        collectionSaved = true;
        setCollectionDone(true);
      }
      if (createDeck) {
        await onSaveDeck(
          preconDeckRecord(deck, resolution.resolved, collection, addToCollection)
        );
      }
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Speichern fehlgeschlagen.";
      setError(
        collectionSaved && createDeck
          ? `${message} Die Karten sind bereits in der Sammlung und werden bei einem erneuten Versuch nicht doppelt hinzugefügt.`
          : message
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="precon-import-title"
      >
        <div className="external-import-head">
          <div>
            <h2 id="precon-import-title">Precon-Deck zur Sammlung hinzufügen</h2>
            <p className="muted">
              Wähle ein vorkonstruiertes Deck. Alle Karten werden mit ihrer exakten Druckversion (Set, Nummer, Foil) aus MTGJSON übernommen und vor dem Speichern angezeigt.
            </p>
          </div>
          <button className="secondary" type="button" onClick={onClose} disabled={busy} aria-label="Dialog schließen">×</button>
        </div>

        {!deck && (
          <div className="external-import-source">
            <div className="external-import-deck-fields">
              <label>
                <span>Suche</span>
                <input
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                  placeholder="Name, Setcode oder Jahr"
                  autoFocus
                />
              </label>
              <label>
                <span>Produkttyp</span>
                <select
                  value={type}
                  onChange={event => {
                    setType(event.target.value);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  <option value="">Alle Typen ({decks.length})</option>
                  {types.map(item => <option key={item.name} value={item.name}>{item.name} ({item.count})</option>)}
                </select>
              </label>
            </div>

            {listBusy ? (
              <div className="external-import-loading" role="status">
                <div className="external-import-loading-spinner" aria-hidden="true" />
                <div className="external-import-loading-copy"><strong>Precon-Liste wird geladen…</strong></div>
              </div>
            ) : (
              <>
                <div className="external-import-summary-list precon-list" role="list">
                  {visibleDecks.map(item => (
                    <button
                      type="button"
                      role="listitem"
                      className="external-import-summary-row precon-list-row"
                      key={item.fileName}
                      onClick={() => void selectDeck(item)}
                      disabled={busy}
                    >
                      <span>
                        <strong>{item.name}</strong>
                        <small className="muted"> · {item.type}</small>
                      </span>
                      <strong>{item.code} · {item.releaseDate.slice(0, 4)}</strong>
                    </button>
                  ))}
                  {visibleDecks.length === 0 && decks.length > 0 && (
                    <div className="external-import-summary-note">Keine passenden Decks gefunden.</div>
                  )}
                </div>
                {decks.length > 0 && (
                  <p className="muted external-import-help" role="status">
                    {visibleDecks.length} von {filteredDecks.length} Decks angezeigt (insgesamt {decks.length} verfügbar).
                  </p>
                )}
                {filteredDecks.length > visibleDecks.length && (
                  <div className="external-import-actions">
                    <button type="button" className="secondary" onClick={() => setLimit(value => value + PAGE_SIZE)}>
                      Mehr anzeigen (+{Math.min(PAGE_SIZE, filteredDecks.length - visibleDecks.length)})
                    </button>
                    <button type="button" className="secondary" onClick={() => setLimit(filteredDecks.length)}>
                      Alle anzeigen ({filteredDecks.length})
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {busy && deck === null && !listBusy && (
          <div className="external-import-loading" role="status" aria-live="polite">
            <div className="external-import-loading-spinner" aria-hidden="true" />
            <div className="external-import-loading-copy"><strong>Deckliste wird geladen…</strong></div>
          </div>
        )}

        {busy && deck && !resolution && (
          <div className="external-import-loading" role="status" aria-live="polite">
            <div className="external-import-loading-spinner" aria-hidden="true" />
            <div className="external-import-loading-copy">
              <strong>Druckversionen werden bei Scryfall geprüft…</strong>
              <span>{progress.processed}/{progress.total} Einträge</span>
              <div className="external-import-loading-bar" aria-hidden="true">
                <span style={{ width: progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "8%" }} />
              </div>
            </div>
          </div>
        )}

        {deck && resolution && (
          <>
            <div className="external-import-summary">
              <div><span>Deck</span><strong>{deck.name}</strong></div>
              <div><span>Gesamt</span><strong>{totalCopies} Karten</strong></div>
              <div><span>Erkannt</span><strong>{resolvedCopies} Karten</strong></div>
              <div><span>Bereits in Sammlung</span><strong>{alreadyOwned} Druckversion(en)</strong></div>
            </div>

            <div className="external-import-preview-head">
              <div>
                <h3>{deck.code} · {deck.type} · {deck.releaseDate}</h3>
                <p className="muted">
                  Wähle unten, ob die Karten zur Sammlung hinzugefügt und/oder als Deck angelegt werden. Bei der Sammlung werden die Anzahlen auf deinen Bestand addiert.
                </p>
              </div>
              <button className="secondary" type="button" onClick={backToList} disabled={busy}>Anderes Deck</button>
            </div>

            <div className="external-import-large-review">
              {groupedRows.map(group => (
                <section className="external-import-summary-list-section" key={group.section}>
                  <div className="external-import-summary-list-head">
                    <h4>{sectionLabel(group.section)}</h4>
                    <span>{group.rows.reduce((sum, item) => sum + item.row.count, 0)} Karten</span>
                  </div>
                  <div className="external-import-summary-list" role="list">
                    {group.rows.map(({ row, card }) => (
                      <div className="external-import-summary-row" role="listitem" key={`${group.section}-${card.id}-${row.foil ? "f" : "n"}`}>
                        <span>
                          {card.name}
                          <small className="muted"> · {card.set.toUpperCase()} #{card.collector_number}{row.foil ? " · Foil" : ""}{ownedIds.has(card.id) ? " · bereits vorhanden" : ""}</small>
                        </span>
                        <strong>{row.count}×</strong>
                      </div>
                    ))}
                  </div>
                </section>
              ))}

              {resolution.unresolved.length > 0 && (
                <section className="external-import-summary-list-section external-import-summary-list-section-warning">
                  <div className="external-import-summary-list-head">
                    <h4>Nicht eindeutig erkannt</h4>
                    <span>{unresolvedCopies} Karten</span>
                  </div>
                  <p className="external-import-summary-note">
                    Für diese Karten liefert Scryfall keine passende Druckversion. Sie werden nicht übernommen und können manuell über die Suche ergänzt werden.
                  </p>
                  <div className="external-import-summary-list" role="list">
                    {resolution.unresolved.map((row, index) => (
                      <div className="external-import-summary-row external-import-summary-row-warning" role="listitem" key={`missing-${index}`}>
                        <span>{row.name}{row.setCode ? ` · ${row.setCode.toUpperCase()} #${row.collectorNumber ?? "?"}` : ""}</span>
                        <strong>{row.count}×</strong>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <div className="external-import-duplicate-options precon-targets" role="group" aria-label="Was soll angelegt werden?">
              <label>
                <input
                  type="checkbox"
                  checked={addToCollection}
                  disabled={collectionDone}
                  onChange={event => setAddToCollection(event.target.checked)}
                />
                <span>Karten zur Sammlung hinzufügen{collectionDone ? " (bereits erledigt)" : ""}</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={createDeck}
                  onChange={event => setCreateDeck(event.target.checked)}
                />
                <span>Als Deck in der Deckliste anlegen</span>
              </label>
            </div>
            {nothingSelected && (
              <p className="muted external-import-help">Bitte mindestens eine Option auswählen.</p>
            )}

            <label className="external-import-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
              />
              <span>
                {unresolvedCopies > 0
                  ? `Ich möchte die ${resolvedCopies} erkannten Karten übernehmen (${unresolvedCopies} fehlen).`
                  : `Ich möchte alle ${resolvedCopies} Karten des Decks übernehmen.`}
              </span>
            </label>
          </>
        )}

        {error && <div className="external-import-error" role="alert">{error}</div>}

        <div className="external-import-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>Abbrechen</button>
          {resolution && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy || !confirmed || nothingSelected || collectionCards.length === 0}
            >
              {busy
                ? "Speichere…"
                : createDeck && addToCollection
                  ? "Zur Sammlung hinzufügen & Deck anlegen"
                  : createDeck
                    ? "Deck anlegen"
                    : `${resolvedCopies} Karte(n) hinzufügen`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
