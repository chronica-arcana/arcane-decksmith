/**
 * Bilder für Spielsteine: Sie haben keine eigene Karte im Deck, daher wird das Token-Bild bei Scryfall gesucht
 * (Name, wenn bekannt auch Stärke/Widerstandskraft) und für die Sitzung zwischengespeichert.
 */
const cache = new Map<string, Promise<string | null>>();

type ScryfallCard = { image_uris?: { normal?: string }; card_faces?: { image_uris?: { normal?: string } }[]; power?: string; toughness?: string };

export function tokenImage(name: string, power?: number | null, toughness?: number | null): Promise<string | null> {
  if (import.meta.env.MODE === "test" || typeof fetch !== "function") return Promise.resolve(null);
  const key = `${name}|${power ?? ""}/${toughness ?? ""}`;
  const known = cache.get(key);
  if (known) return known;
  const search = (query: string) =>
    fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=art&order=released&dir=desc`)
      .then(response => (response.ok ? (response.json() as Promise<{ data?: ScryfallCard[] }>) : null))
      .then(body => body?.data ?? []);
  const pick = (cards: ScryfallCard[]) => {
    for (const card of cards) {
      const uri = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
      if (uri) return uri;
    }
    return null;
  };
  const clean = name.replace(/"/g, "");
  const stats = power !== null && power !== undefined && toughness !== null && toughness !== undefined ? ` pow=${power} tou=${toughness}` : "";
  const promise = search(`t:token !"${clean}"${stats}`)
    .then(cards => (cards.length > 0 ? cards : search(`t:token !"${clean}"`)))
    .then(pick)
    .catch(() => null);
  cache.set(key, promise);
  return promise;
}
