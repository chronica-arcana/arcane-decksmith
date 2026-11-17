import type { GameCard, GamePlayer } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView from "./CardView";
import CommanderZone from "./CommanderZone";
import { HandFan, OpponentHand } from "./HandFan";
import Hud from "./Hud";
import { LibraryPile, ZonePile } from "./Pile";

/**
 * Platz eines Spielers auf der gemeinsamen Matte. Dein Platz liegt unten (Feld oben, darunter HUD, Hand und Ablagen),
 * der gegnerische oben und gespiegelt (HUD, Hand und Ablagen am oberen Rand, Länder vor Kreaturen zur Mitte hin).
 */
export default function PlayerZone({ player }: { player: GamePlayer }) {
  const { game, canAct, dropProps, dropKey, dropOnTable, clickCard, cardMenu, setHover, onDragStart, markOf, inCombat } = useBattlefield();
  const own = player.userId === game.you;
  const active = game.turn.active === player.userId && game.phase === "playing";
  const onField = player.battlefield.filter(card => !inCombat.has(card.id));
  const creatures = onField.filter(card => card.kind === "creature");
  const others = onField.filter(card => card.kind === "other");
  const lands = onField.filter(card => card.kind === "land");

  // Jede Karte steckt in einem Slot, der bei Platzmangel schrumpft (Karten überlappen dann): Der Tisch bleibt fest und scrollt nie.
  const tile = (card: GameCard, size: "sm" | "md") => (
    <div key={card.id} className={`field-slot ${size}${card.tapped ? " tapped" : ""}`}>
      <CardView
        card={card}
        size={size}
        marked={markOf(card)}
        onSelect={clickCard}
        onHover={setHover}
        onMenu={cardMenu}
        onDragStart={own ? onDragStart : undefined}
      />
    </div>
  );
  const size = own ? "md" : "sm";
  const creatureRow = creatures.length > 0 && (
    <div className="field-row creatures" aria-label={`Kreaturen von ${player.name}`}>
      {creatures.map(card => tile(card, size))}
    </div>
  );
  const landRow = others.length + lands.length > 0 && (
    <div className="field-row lands" aria-label={`Länder und Permanents von ${player.name}`}>
      {own ? others.map(card => tile(card, size)) : lands.map(card => tile(card, "sm"))}
      {own ? lands.map(card => tile(card, "sm")) : others.map(card => tile(card, size))}
    </div>
  );

  const field = (
    <div className="zone-field">
      {own ? (
        <>
          {creatureRow}
          {landRow}
        </>
      ) : (
        <>
          {landRow}
          {creatureRow}
        </>
      )}
      {player.battlefield.length === 0 && <span className="muted field-empty">Keine Karten im Spiel.</span>}
    </div>
  );
  const dock = (
    <div className="zone-dock">
      <div className="dock-left">
        <Hud player={player} own={own} />
      </div>
      <div className="dock-center">{own ? <HandFan player={player} /> : <OpponentHand player={player} />}</div>
      <div className="dock-right">
        <ZonePile player={player} zone="graveyard" />
        <ZonePile player={player} zone="exile" />
        <LibraryPile player={player} />
        <CommanderZone player={player} />
      </div>
    </div>
  );

  return (
    <section
      className={`zone ${own ? "zone-me" : "zone-opp"}${active ? " active" : ""}${player.eliminated ? " out" : ""}${own && dropKey === "table" ? " drop" : ""}`}
      aria-label={`Platz von ${player.name}`}
      {...(own && canAct ? dropProps("table", dropOnTable) : {})}
    >
      {own ? (
        <>
          {field}
          {dock}
        </>
      ) : (
        <>
          {dock}
          {field}
        </>
      )}
    </section>
  );
}
