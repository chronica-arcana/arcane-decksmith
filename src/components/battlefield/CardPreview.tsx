import type { GameCard } from "../../gameClient";
import { ManaCost } from "./ManaSymbol";
import { imageFor } from "./scryfallAssets";

/** Große Detailansicht beim Darüberfahren: hochauflösendes Scryfall-Bild (large), Kosten als Symbole, Typ und Schlüsselwörter. */
export default function CardPreview({ card }: { card: GameCard | null }) {
  if (!card || card.name === undefined) return null;
  const image = imageFor(card.imageUri, "large");
  return (
    <aside className="card-preview" aria-label="Kartenvorschau">
      {image ? (
        <img src={image} alt={card.name} />
      ) : (
        <div className="preview-text">
          <strong>{card.name}</strong>
          <span>{card.typeLine}</span>
        </div>
      )}
      <div className="preview-meta">
        <strong>{card.name}</strong>
        {card.manaCost && <ManaCost cost={card.manaCost} size={16} />}
        {card.typeLine && <span className="muted">{card.typeLine}</span>}
        {card.power !== null && card.power !== undefined && card.toughness !== null && card.toughness !== undefined && (
          <span className="muted">
            {card.power}/{card.toughness}
            {card.damage > 0 ? ` (${card.damage} Schaden)` : ""}
          </span>
        )}
        {card.keywords && card.keywords.length > 0 && <span className="preview-kw">{card.keywords.join(", ")}</span>}
      </div>
    </aside>
  );
}
