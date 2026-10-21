import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import CardDetailsModal from "../components/CardDetailsModal";
import {
  TYPE_ORDER,
  cardMatchesColorFilter,
  primaryTypeGroup,
  toggleSetValue
} from "../cardFilters";
import { getSets, type ScryfallSet } from "../scryfall";
import { download, toCsv } from "../importExport";
import type {
  CardFinish,
  CardRecord,
  GroupBy,
  ViewMode
} from "../types";

const ExternalImportDialog = lazy(() => import("../components/ExternalImportDialog"));
const SetCardsModal = lazy(() => import("../components/SetCardsModal"));

const COLOR_NAMES: Record<string, string> = {
  W: "Weiß",
  U: "Blau",
  B: "Schwarz",
  R: "Rot",
  G: "Grün"
};

const COLOR_ORDER = ["W", "U", "B", "R", "G"];

const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR"
});

function formatEuro(value: number | undefined | null): string {
  return value === undefined || value === null || !Number.isFinite(value)
    ? "kein EUR-Preis"
    : EUR_FORMATTER.format(value);
}

function finishLabel(finish: CardFinish): string {
  return finish === "foil" ? "Foil" : "Non-Foil";
}

function finishCountsFor(card: CardRecord): Record<CardFinish, number> {
  const stored = card.finishCounts;

  if (stored) {
    const nonfoil = Math.max(0, Math.floor(Number(stored.nonfoil ?? 0)));
    const foil = Math.max(0, Math.floor(Number(stored.foil ?? 0)));

    if (nonfoil + foil > 0) {
      return { nonfoil, foil };
    }
  }

  return card.foil
    ? { nonfoil: 0, foil: card.count }
    : { nonfoil: card.count, foil: 0 };
}

function highestOwnedUnitValue(card: CardRecord): number | undefined {
  const counts = finishCountsFor(card);
  const prices: number[] = [];

  if (counts.nonfoil > 0 && card.priceEur !== undefined) {
    prices.push(card.priceEur);
  }

  if (counts.foil > 0 && card.priceEurFoil !== undefined) {
    prices.push(card.priceEurFoil);
  }

  return prices.length > 0 ? Math.max(...prices) : undefined;
}

function collectionValueForCard(card: CardRecord): {
  value: number;
  unpricedCopies: number;
} {
  const counts = finishCountsFor(card);
  let value = 0;
  let unpricedCopies = 0;

  if (counts.nonfoil > 0) {
    if (card.priceEur !== undefined) {
      value += counts.nonfoil * card.priceEur;
    } else {
      unpricedCopies += counts.nonfoil;
    }
  }

  if (counts.foil > 0) {
    if (card.priceEurFoil !== undefined) {
      value += counts.foil * card.priceEurFoil;
    } else {
      unpricedCopies += counts.foil;
    }
  }

  return { value, unpricedCopies };
}

function colorGroupName(colors: string[]): string {
  if (!colors.length) return "Farblos";

  const ordered = COLOR_ORDER.filter(color => colors.includes(color));
  return ordered.map(color => COLOR_NAMES[color] ?? color).join(" / ");
}

function compareGroupNames(a: string, b: string, group: GroupBy): number {
  if (group === "manaValue") {
    const av = Number(a.replace("MV ", ""));
    const bv = Number(b.replace("MV ", ""));
    return av - bv;
  }

  if (group === "type") {
    const ai = TYPE_ORDER.indexOf(a);
    const bi = TYPE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }

  if (group === "color") {
    if (a === "Farblos" && b !== "Farblos") return -1;
    if (b === "Farblos" && a !== "Farblos") return 1;

    const ac = a.split(" / ").length;
    const bc = b.split(" / ").length;
    if (ac !== bc) return ac - bc;
  }

  return a.localeCompare(b, "de", { numeric: true, sensitivity: "base" });
}

type CollectionPageProps = {
  cards: CardRecord[];
  onChange: (card: CardRecord) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onImportCards: (cards: CardRecord[]) => Promise<void>;
};

export default function CollectionPage({
  cards,
  onChange,
  onDelete,
  onImportCards
}: CollectionPageProps) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupBy>("none");
  const [view, setView] = useState<ViewMode>("grid");
  const [sort, setSort] = useState("name");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [setCatalog, setSetCatalog] = useState<ScryfallSet[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [openSet, setOpenSet] = useState<{ code: string; name: string } | null>(null);

  const [colorFilters, setColorFilters] = useState<Set<string>>(new Set());
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());
  const [setFilters, setSetFilters] = useState<Set<string>>(new Set());
  const [manaFilters, setManaFilters] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;

    void getSets()
      .then(sets => {
        if (active) setSetCatalog(sets);
      })
      .catch(error => {
        console.error("Set-Fortschritt konnte nicht geladen werden:", error);
      });

    return () => {
      active = false;
    };
  }, []);

  const selectedCard = useMemo(
    () => cards.find(card => card.id === selectedCardId) ?? null,
    [cards, selectedCardId]
  );

  const setOptions = useMemo(() => {
    const bySet = new Map<string, string>();

    for (const card of cards) {
      const code = card.set.toLowerCase();
      bySet.set(code, card.setName ?? card.set.toUpperCase());
    }

    return [...bySet.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], "de", { sensitivity: "base" })
    );
  }, [cards]);

  const setCompletion = useMemo(() => {
    const bySet = new Map<string, Set<string>>();

    for (const card of cards) {
      const key = card.set.toLowerCase();
      if (!bySet.has(key)) bySet.set(key, new Set());
      bySet.get(key)!.add(card.collectorNumber.toLowerCase());
    }

    return Array.from(bySet.entries())
      .map(([setCode, collectorNumbers]) => {
        const info = setCatalog.find(set => set.code.toLowerCase() === setCode);
        const total = info?.card_count ?? 0;
        const owned = collectorNumbers.size;

        return {
          code: setCode.toUpperCase(),
          name:
            info?.name ??
            cards.find(card => card.set.toLowerCase() === setCode)?.setName ??
            setCode.toUpperCase(),
          owned,
          total,
          percent: total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : 0
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, "de", { sensitivity: "base" })
      );
  }, [cards, setCatalog]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return cards
      .filter(card => {
        if (
          normalizedQuery &&
          !`${card.name} ${card.set} ${card.setName ?? ""} ${card.typeLine ?? ""} ${card.oracleText ?? ""}`
            .toLowerCase()
            .includes(normalizedQuery)
        ) {
          return false;
        }

        if (!cardMatchesColorFilter(card, colorFilters)) return false;

        if (typeFilters.size > 0 && !typeFilters.has(primaryTypeGroup(card.typeLine))) {
          return false;
        }

        if (setFilters.size > 0 && !setFilters.has(card.set.toLowerCase())) {
          return false;
        }

        if (manaFilters.size > 0) {
          const mv = Math.max(0, Math.floor(Number.isFinite(card.manaValue) ? card.manaValue : 0));
          const bucket = mv >= 7 ? "7+" : String(mv);
          if (!manaFilters.has(bucket)) return false;
        }

        return true;
      })
      .sort((a, b) =>
        sort === "mv"
          ? a.manaValue - b.manaValue
          : sort === "count"
            ? b.count - a.count
            : sort === "value"
              ? (highestOwnedUnitValue(b) ?? -1) - (highestOwnedUnitValue(a) ?? -1) ||
                a.name.localeCompare(b.name)
              : a.name.localeCompare(b.name)
      );
  }, [cards, colorFilters, manaFilters, query, setFilters, sort, typeFilters]);

  const total = cards.reduce((sum, card) => sum + card.count, 0);
  const visibleTotal = filtered.reduce((sum, card) => sum + card.count, 0);

  const collectionStats = useMemo(() => {
    const physicalTotal = cards.reduce((sum, card) => sum + card.count, 0);
    const uniqueTotal = cards.length;
    const nonlandCards = cards.filter(
      card => !/(?:^|\s)Land(?:\s|$|—)/i.test(card.typeLine ?? "")
    );
    const nonlandPhysicalTotal = nonlandCards.reduce((sum, card) => sum + card.count, 0);
    const averageCopies = uniqueTotal > 0 ? physicalTotal / uniqueTotal : 0;
    const weightedManaValue = nonlandCards.reduce(
      (sum, card) =>
        sum + (Number.isFinite(card.manaValue) ? card.manaValue : 0) * card.count,
      0
    );
    const averageManaValue =
      nonlandPhysicalTotal > 0 ? weightedManaValue / nonlandPhysicalTotal : 0;

    const colorCounts: Record<string, number> = {
      Weiß: 0,
      Blau: 0,
      Schwarz: 0,
      Rot: 0,
      Grün: 0,
      Mehrfarbig: 0,
      Farblos: 0
    };

    for (const card of cards) {
      const colors = card.colors ?? [];
      let key = "Farblos";
      if (colors.length > 1) key = "Mehrfarbig";
      else if (colors.length === 1) key = COLOR_NAMES[colors[0]] ?? "Farblos";
      colorCounts[key] = (colorCounts[key] ?? 0) + card.count;
    }

    const manaCounts: Record<string, number> = {
      "MV 0": 0,
      "MV 1": 0,
      "MV 2": 0,
      "MV 3": 0,
      "MV 4": 0,
      "MV 5": 0,
      "MV 6": 0,
      "MV 7+": 0
    };

    for (const card of nonlandCards) {
      const mv = Math.max(0, Math.floor(Number.isFinite(card.manaValue) ? card.manaValue : 0));
      const key = mv >= 7 ? "MV 7+" : `MV ${mv}`;
      manaCounts[key] = (manaCounts[key] ?? 0) + card.count;
    }

    const typeCounts: Record<string, number> = Object.fromEntries(
      TYPE_ORDER.map(type => [type, 0])
    );

    for (const card of cards) {
      const key = primaryTypeGroup(card.typeLine);
      typeCounts[key] = (typeCounts[key] ?? 0) + card.count;
    }

    const setMap = new Map<string, { name: string; count: number }>();
    for (const card of cards) {
      const key = card.set.toLowerCase();
      const existing = setMap.get(key);
      if (existing) existing.count += card.count;
      else {
        setMap.set(key, {
          name: card.setName ?? card.set.toUpperCase(),
          count: card.count
        });
      }
    }

    const sets = Array.from(setMap.values()).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, "de")
    );

    const mostFrequent = [...cards]
      .filter(card => card.count > 1)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"))
      .slice(0, 10);

    let collectionValue = 0;
    let unpricedCopies = 0;
    let mostValuableCard: { name: string; finish: CardFinish; value: number } | null = null;

    for (const card of cards) {
      const cardValue = collectionValueForCard(card);
      collectionValue += cardValue.value;
      unpricedCopies += cardValue.unpricedCopies;
      const counts = finishCountsFor(card);

      for (const finish of ["nonfoil", "foil"] as CardFinish[]) {
        if (counts[finish] <= 0) continue;
        const value = finish === "foil" ? card.priceEurFoil : card.priceEur;
        if (value === undefined) continue;

        if (!mostValuableCard || value > mostValuableCard.value) {
          mostValuableCard = { name: card.name, finish, value };
        }
      }
    }

    const toRows = (values: Record<string, number>, denominator: number) =>
      Object.entries(values)
        .map(([label, count]) => ({
          label,
          count,
          percentage: denominator > 0 ? (count / denominator) * 100 : 0
        }))
        .filter(row => row.count > 0);

    return {
      physicalTotal,
      uniqueTotal,
      averageCopies,
      averageManaValue,
      collectionValue,
      unpricedCopies,
      mostValuableCard,
      colors: toRows(colorCounts, physicalTotal),
      manaValues: toRows(manaCounts, nonlandPhysicalTotal),
      types: toRows(typeCounts, physicalTotal),
      mostFrequent,
      sets
    };
  }, [cards]);

  const groups = useMemo(() => {
    if (group === "none") return [["Alle Karten", filtered] as [string, CardRecord[]]];

    const grouped = filtered.reduce<Record<string, CardRecord[]>>((acc, card) => {
      const key =
        group === "color"
          ? colorGroupName(card.colors)
          : group === "type"
            ? primaryTypeGroup(card.typeLine)
            : group === "set"
              ? card.setName ?? card.set.toUpperCase()
              : `MV ${card.manaValue}`;

      (acc[key] ??= []).push(card);
      return acc;
    }, {});

    return Object.entries(grouped).sort(([a], [b]) => compareGroupNames(a, b, group));
  }, [filtered, group]);

  const activeFilterCount =
    colorFilters.size + typeFilters.size + setFilters.size + manaFilters.size;

  const resetFilters = () => {
    setColorFilters(new Set());
    setTypeFilters(new Set());
    setSetFilters(new Set());
    setManaFilters(new Set());
  };

  return (
    <section className="collection-page">
      <div className="pagehead">
        <div>
          <h2>Sammlung</h2>
          <p className="muted">
            {cards.length} unterschiedliche Karten · {total} physische Karten
          </p>
        </div>

        <div className="row">
          <button
            className="secondary"
            type="button"
            onClick={() => setImportOpen(true)}
          >
            Importieren
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              download("collection.csv", toCsv(cards), "text/csv;charset=utf-8")
            }
          >
            CSV export
          </button>
        </div>
      </div>

      <div className="collection-summary-strip" aria-label="Sammlungsstatistiken">
        <div>
          <strong>{collectionStats.physicalTotal}</strong>
          <span>Physisch</span>
        </div>
        <div>
          <strong>{collectionStats.uniqueTotal}</strong>
          <span>Unterschiedlich</span>
        </div>
        <div>
          <strong>{collectionStats.averageCopies.toFixed(2)}</strong>
          <span>Ø Exemplare</span>
        </div>
        <div>
          <strong>{collectionStats.averageManaValue.toFixed(2)}</strong>
          <span>Ø Mana Value</span>
        </div>
        <div>
          <strong>
            {collectionStats.unpricedCopies < collectionStats.physicalTotal
              ? formatEuro(collectionStats.collectionValue)
              : "—"}
          </strong>
          <span>Sammlungswert</span>
        </div>
        <div>
          <strong>
            {collectionStats.mostValuableCard
              ? formatEuro(collectionStats.mostValuableCard.value)
              : "—"}
          </strong>
          <span>Teuerste Karte</span>
        </div>
      </div>

      <details className="panel collection-stat-details">
        <summary className="collection-stats-toggle">Sammlungs-Statistiken im Detail</summary>

        <div className="collection-stat-grid">
          <div className="collection-stat-section">
            <h3>Farben</h3>
            <p className="muted">Verteilung der physischen Karten nach ihren gedruckten Farben.</p>
            {collectionStats.colors.map(row => (
              <div className="collection-stat-row" key={row.label}>
                <div className="collection-stat-label">
                  <span>{row.label}</span>
                  <span>{row.count} · {row.percentage.toFixed(1)}%</span>
                </div>
                <progress max={100} value={row.percentage} />
              </div>
            ))}
          </div>

          <div className="collection-stat-section">
            <h3>Mana Value</h3>
            <p className="muted">Nur Nichtländer, damit Länder die MV-0-Verteilung nicht verzerren.</p>
            {collectionStats.manaValues.map(row => (
              <div className="collection-stat-row" key={row.label}>
                <div className="collection-stat-label">
                  <span>{row.label}</span>
                  <span>{row.count} · {row.percentage.toFixed(1)}%</span>
                </div>
                <progress max={100} value={row.percentage} />
              </div>
            ))}
          </div>

          <div className="collection-stat-section">
            <h3>Kartenarten</h3>
            <p className="muted">Jede Karte wird nach ihrem primären Kartentyp genau einmal gezählt.</p>
            {collectionStats.types.map(row => (
              <div className="collection-stat-row" key={row.label}>
                <div className="collection-stat-label">
                  <span>{row.label}</span>
                  <span>{row.count} · {row.percentage.toFixed(1)}%</span>
                </div>
                <progress max={100} value={row.percentage} />
              </div>
            ))}
          </div>
        </div>

        <div className="collection-stat-grid collection-stat-extra">
          <div className="collection-stat-section">
            <h3>Häufigste Karten</h3>
            {collectionStats.mostFrequent.length === 0 ? (
              <p className="muted">Keine Karte ist mehrfach vorhanden.</p>
            ) : (
              <div className="deck-list">
                {collectionStats.mostFrequent.map(card => (
                  <div key={card.id}>
                    <span>{card.name}</span>
                    <strong>{card.count}×</strong>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="collection-stat-section">
            <h3>Set-Verteilung</h3>
            {collectionStats.sets.length === 0 ? (
              <p className="muted">Keine Set-Daten vorhanden.</p>
            ) : (
              <div className="deck-list">
                {collectionStats.sets.slice(0, 12).map(set => (
                  <div key={set.name}>
                    <span>{set.name}</span>
                    <strong>{set.count}</strong>
                  </div>
                ))}
                {collectionStats.sets.length > 12 && (
                  <small className="muted">+ {collectionStats.sets.length - 12} weitere Sets</small>
                )}
              </div>
            )}
          </div>
        </div>

        {collectionStats.unpricedCopies > 0 && (
          <p className="muted collection-price-note">
            {collectionStats.unpricedCopies} Exemplar(e) ohne EUR-Preis.
          </p>
        )}

        {collectionStats.mostValuableCard && (
          <p className="muted collection-price-note">
            Teuerste Einzelkarte: {collectionStats.mostValuableCard.name} · {finishLabel(collectionStats.mostValuableCard.finish)}.
          </p>
        )}
      </details>

      <details className="panel set-progress-panel">
        <summary className="collection-stats-toggle">Set-Fortschritt</summary>
        <p className="muted">
          Fortschritt anhand unterschiedlicher Collector Numbers in deiner Sammlung im Verhältnis zur von Scryfall gemeldeten Set-Größe.
        </p>

        {setCompletion.length === 0 ? (
          <div className="muted">Noch keine Sets in der Sammlung.</div>
        ) : (
          <div className="deck-list">
            {setCompletion.map(set => (
              <div key={set.code}>
                <span>
                  <button
                    type="button"
                    className="set-name-button"
                    onClick={() => setOpenSet({ code: set.code.toLowerCase(), name: set.name })}
                    aria-label={`Alle Karten von ${set.name} anzeigen`}
                  >
                    <strong>{set.name}</strong>
                  </button>{" "}
                  <span className="muted">({set.code})</span>
                </span>
                <span>
                  {set.total > 0
                    ? `${set.owned} / ${set.total} · ${set.percent} %`
                    : `${set.owned} gesammelt`}
                </span>
              </div>
            ))}
          </div>
        )}
      </details>

      <div className="collection-controls panel">
        <div className="collection-control-row">
          <label className="collection-search-field">
            <span className="sr-only">Sammlung durchsuchen</span>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Sammlung durchsuchen…"
            />
          </label>

          <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sortierung">
            <option value="name">Name</option>
            <option value="mv">Mana Value</option>
            <option value="count">Anzahl</option>
            <option value="value">Wert</option>
          </select>

          <select
            value={group}
            onChange={event => setGroup(event.target.value as GroupBy)}
            aria-label="Gruppierung"
          >
            <option value="none">Keine Gruppierung</option>
            <option value="color">Farbe</option>
            <option value="type">Typ</option>
            <option value="set">Set</option>
            <option value="manaValue">Mana Value</option>
          </select>

          <button
            className="secondary"
            type="button"
            onClick={() => setView(view === "grid" ? "list" : "grid")}
          >
            {view === "grid" ? "Listenansicht" : "Kartenansicht"}
          </button>
        </div>

        <div className="collection-filter-bar">
          <details className="collection-filter-group" name="collection-filter">
            <summary>Farbe {colorFilters.size > 0 ? `(${colorFilters.size})` : ""}</summary>
            <div className="collection-filter-options">
              {[
                ["W", "Weiß"],
                ["U", "Blau"],
                ["B", "Schwarz"],
                ["R", "Rot"],
                ["G", "Grün"],
                ["M", "Mehrfarbig"],
                ["C", "Farblos"]
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={colorFilters.has(value)}
                    onChange={() => setColorFilters(current => toggleSetValue(current, value))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </details>

          <details className="collection-filter-group" name="collection-filter">
            <summary>Kartentyp {typeFilters.size > 0 ? `(${typeFilters.size})` : ""}</summary>
            <div className="collection-filter-options">
              {TYPE_ORDER.map(type => (
                <label key={type}>
                  <input
                    type="checkbox"
                    checked={typeFilters.has(type)}
                    onChange={() => setTypeFilters(current => toggleSetValue(current, type))}
                  />
                  {type}
                </label>
              ))}
            </div>
          </details>

          <details className="collection-filter-group collection-set-filter" name="collection-filter">
            <summary>Set {setFilters.size > 0 ? `(${setFilters.size})` : ""}</summary>
            <div className="collection-filter-options collection-set-options">
              {setOptions.map(([code, name]) => (
                <label key={code}>
                  <input
                    type="checkbox"
                    checked={setFilters.has(code)}
                    onChange={() => setSetFilters(current => toggleSetValue(current, code))}
                  />
                  <span>{name}</span>
                  <small>{code.toUpperCase()}</small>
                </label>
              ))}
            </div>
          </details>

          <details className="collection-filter-group" name="collection-filter">
            <summary>Mana Value {manaFilters.size > 0 ? `(${manaFilters.size})` : ""}</summary>
            <div className="collection-filter-options collection-mv-options">
              {["0", "1", "2", "3", "4", "5", "6", "7+"].map(value => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={manaFilters.has(value)}
                    onChange={() => setManaFilters(current => toggleSetValue(current, value))}
                  />
                  MV {value}
                </label>
              ))}
            </div>
          </details>

          {activeFilterCount > 0 && (
            <button className="ghost" type="button" onClick={resetFilters}>
              Filter zurücksetzen ({activeFilterCount})
            </button>
          )}

          <span className="collection-filter-result muted">
            {filtered.length} Kartenarten · {visibleTotal} Exemplare sichtbar
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="panel collection-empty-state">
          <strong>Keine Karten für diese Filter gefunden.</strong>
          <span className="muted">Passe Suche oder Filter an.</span>
        </div>
      ) : (
        groups.map(([name, list]) => (
          <div key={name} className="collection-group">
            <h3 className="group-title">{name}</h3>

            <div className={view === "grid" ? "card-grid" : "list-view"}>
              {list.map(card => (
                <article
                  className="collection-card collection-card-clickable"
                  key={card.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`${card.name} anzeigen`}
                  onClick={() => setSelectedCardId(card.id)}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelectedCardId(card.id);
                    }
                  }}
                >
                  <div
                    className="select"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(card.id)}
                      onChange={() =>
                        setSelected(current => toggleSetValue(current, card.id))
                      }
                      aria-label={`${card.name} auswählen`}
                    />
                  </div>

                  <div className="collection-card-count">{card.count}×</div>

                  {card.imageUri ? (
                    <img src={card.imageUri} alt={card.name} loading="lazy" />
                  ) : (
                    <div className="collection-card-image-placeholder">Kein Bild</div>
                  )}

                  <div className="card-body">
                    <h3>{card.name}</h3>
                    <div className="meta">
                      {card.setName ?? card.set.toUpperCase()} · #{card.collectorNumber} · MV {card.manaValue}
                    </div>
                    <p>{card.typeLine}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))
      )}

      {selected.size > 0 && (
        <div className="bulkbar">
          {selected.size} ausgewählt
          <button
            type="button"
            onClick={async () => {
              for (const id of selected) {
                await onDelete(id);
              }
              setSelected(new Set());
            }}
          >
            Ausgewählte löschen
          </button>
        </div>
      )}

      {importOpen && (
        <Suspense fallback={<div className="loading">Import wird geladen…</div>}>
          <ExternalImportDialog
            mode="collection"
            pool={cards}
            onClose={() => setImportOpen(false)}
            onImportCollection={onImportCards}
          />
        </Suspense>
      )}

      {openSet && (
        <Suspense fallback={<div className="loading">Set wird geladen…</div>}>
          <SetCardsModal
            setCode={openSet.code}
            setName={openSet.name}
            ownedCards={cards.filter(card => card.set.toLowerCase() === openSet.code)}
            onClose={() => setOpenSet(null)}
          />
        </Suspense>
      )}

      {selectedCard && (
        <CardDetailsModal
          card={selectedCard}
          onChange={onChange}
          onDelete={onDelete}
          onClose={() => setSelectedCardId(null)}
        />
      )}
    </section>
  );
}
