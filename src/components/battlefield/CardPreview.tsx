import type { GameCard } from "../../gameClient";
import { imageFor } from "./scryfallAssets";

/** Große Ansicht der überfahrenen Karte (rechts, über allem, immer ganz sichtbar). Sie verschwindet, sobald die Maus oder der Finger die Karte verlässt. */
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
    </aside>
  );
}
