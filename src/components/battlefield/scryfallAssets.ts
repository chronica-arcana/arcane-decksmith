/**
 * Scryfall-Ressourcen für den Spieltisch: Kartenbilder in der passenden Größe und die offiziellen Mana-Symbole
 * (https://svgs.scryfall.io/card-symbols/…). Die Bild-URLs stammen aus `image_uris` der Scryfall-API und werden
 * hier nur auf die benötigte Größe (small, normal, large) umgestellt.
 */

export type ImageSize = "small" | "normal" | "large";

const SIZE_PATTERN = /\/(small|normal|large|png|art_crop|border_crop)\//;

/** Bild-URL einer Karte in der gewünschten Scryfall-Größe (unbekannte URL-Formen bleiben unverändert). */
export function imageFor(uri: string | null | undefined, size: ImageSize): string | null {
  if (!uri) return null;
  return SIZE_PATTERN.test(uri) ? uri.replace(SIZE_PATTERN, `/${size}/`) : uri;
}

export const SYMBOL_BASE = "https://svgs.scryfall.io/card-symbols/";

/** Dateiname eines Symbols, z. B. "{W/U}" → "WU", "{2/W}" → "2W", "{T}" → "T". */
export function symbolCode(symbol: string): string {
  return symbol.replace(/[{}]/g, "").replace(/\//g, "").toUpperCase();
}

export function symbolUrl(symbol: string): string {
  return `${SYMBOL_BASE}${symbolCode(symbol)}.svg`;
}

/** Zerlegt Kostenangaben wie "{2}{W}{U/B}" in einzelne Symbole. */
export function costSymbols(cost: string | null | undefined): string[] {
  return [...String(cost ?? "").matchAll(/\{[^}]+\}/g)].map(match => match[0]);
}
