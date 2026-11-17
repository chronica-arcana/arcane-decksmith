import type { ReactNode } from "react";
import type { GameCard, GamePlayer, GameZone } from "../../gameClient";
import { useBattlefield } from "./BattlefieldContext";
import CardView, { CardBack } from "./CardView";

const ZONE_LABELS: Record<GameZone, string> = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};

/** Ablagestapel (Friedhof oder Exil): zeigt die oberste Karte; Klick öffnet die Zone, eigene Karten lassen sich hineinziehen. */
export function ZonePile({ player, zone }: { player: GamePlayer; zone: "graveyard" | "exile" }) {
  const { game, moveCard, openZone, dropProps, dropKey, setHover } = useBattlefield();
  const own = player.userId === game.you;
  const key = `${player.userId}:${zone}`;
  const top = player[zone].at(-1);
  const open = () => openZone(player.userId, zone);
  return (
    <PileFrame
      label={`${ZONE_LABELS[zone]} · ${player.counts[zone]}`}
      aria={`${ZONE_LABELS[zone]} von ${player.name}: ${player.counts[zone]}`}
      drop={dropKey === key}
      onOpen={open}
      dropHandlers={own ? dropProps(key, card => moveCard(card, zone)) : undefined}
    >
      {top ? <CardView card={top} size="sm" onHover={setHover} /> : <span className="pile-empty" />}
    </PileFrame>
  );
}

/**
 * Bibliothek mit Restkartenzähler. Karten zieht das Spiel selbst (Zugbeginn, Kartentexte). Nur wenn ein Kartentext manuell
 * umgesetzt werden muss, zieht ein Klick eine Karte und ein Rechtsklick öffnet Ansehen, Durchsuchen und Mischen.
 */
export function LibraryPile({ player }: { player: GamePlayer }) {
  const { game, canAct, act, libraryMenu, dropProps, dropKey, moveCard, manualMine, manualAllows, canDrawNow, drawCard } = useBattlefield();
  const own = player.userId === game.you;
  const key = `${player.userId}:library`;
  const manual = own && manualMine && canAct;
  const drawNow = own && canDrawNow;
  const clickable = drawNow || (manual && manualAllows.draw);
  const draw = () => (drawNow ? drawCard() : act({ type: "draw" }));
  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      className={`pile library${dropKey === key ? " drop" : ""}${clickable ? " clickable" : ""}${drawNow ? " draw-ready" : ""}`}
      aria-label={own ? `Bibliothek: ${player.counts.library} Karten${drawNow ? ". Anklicken zum Ziehen" : ""}` : `Bibliothek von ${player.name}: ${player.counts.library}`}
      title={drawNow ? "Klicke, um eine Karte zu ziehen" : manual && manualAllows.draw ? "Anklicken zieht eine Karte (Kartentext)" : undefined}
      onClick={() => clickable && draw()}
      onKeyDown={event => clickable && (event.key === "Enter" || event.key === " ") && draw()}
      onContextMenu={event => {
        if (!manual || !(manualAllows.look || manualAllows.shuffle || manualAllows.mill)) return;
        event.preventDefault();
        libraryMenu(event);
      }}
      {...(manual && manualAllows.move ? dropProps(key, (card: GameCard) => moveCard(card, "library", { position: "top" })) : {})}
    >
      <span className="gc sm library-card">
        <CardBack />
        <span className="library-count" aria-hidden="true">{player.counts.library}</span>
      </span>
      <span className="pile-label">Bibliothek · {player.counts.library}</span>
    </div>
  );
}

function PileFrame({
  label,
  aria,
  drop,
  onOpen,
  dropHandlers,
  children
}: {
  label: string;
  aria: string;
  drop: boolean;
  onOpen: () => void;
  dropHandlers?: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`pile clickable${drop ? " drop" : ""}`}
      aria-label={aria}
      onClick={onOpen}
      onKeyDown={event => (event.key === "Enter" || event.key === " ") && onOpen()}
      {...dropHandlers}
    >
      {children}
      <span className="pile-label">{label}</span>
    </div>
  );
}
