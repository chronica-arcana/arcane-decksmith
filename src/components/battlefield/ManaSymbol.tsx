import { useState } from "react";
import { costSymbols, symbolCode, symbolUrl } from "./scryfallAssets";

const FALLBACK_COLORS: Record<string, string> = { W: "#f8f3d4", U: "#9ec9f0", B: "#a89c93", R: "#f0a58c", G: "#9fd3a3", C: "#cfcfcf" };
const NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos", T: "Tappen", X: "X" };

/** Offizielles Scryfall-Mana-Symbol; fällt bei Ladefehlern auf einen farbigen Kreis mit Buchstaben zurück. */
export function ManaSymbol({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const code = symbolCode(symbol);
  const label = NAMES[code] ?? code;
  if (failed) {
    return (
      <span className="mana-fallback" style={{ width: size, height: size, background: FALLBACK_COLORS[code] ?? "#ddd", fontSize: size * 0.55 }} role="img" aria-label={label}>
        {code.length <= 2 ? code : ""}
      </span>
    );
  }
  return <img className="mana-symbol" src={symbolUrl(symbol)} alt={label} width={size} height={size} loading="lazy" onError={() => setFailed(true)} />;
}

/** Manakosten als Symbolreihe. */
export function ManaCost({ cost, size = 16 }: { cost: string | null | undefined; size?: number }) {
  const symbols = costSymbols(cost);
  if (symbols.length === 0) return null;
  return (
    <span className="mana-cost" aria-label={`Manakosten ${symbols.map(symbolCode).join(" ")}`}>
      {symbols.map((symbol, index) => (
        <ManaSymbol key={`${symbol}-${index}`} symbol={symbol} size={size} />
      ))}
    </span>
  );
}
