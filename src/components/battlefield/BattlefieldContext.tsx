import { createContext, useContext } from "react";
import type { DragEvent, MouseEvent } from "react";
import type { GameAction, GameCard, GamePlayer, GameView, GameZone } from "../../gameClient";

export type Mark = "attack" | "block" | "pick" | null;

/** Alles, was die Zonen-Komponenten vom Spieltisch brauchen (Zustand, Aktionen, Ziehen-und-Ablegen). */
export type BattlefieldApi = {
  game: GameView;
  me: GamePlayer;
  opponents: GamePlayer[];
  canAct: boolean;
  iHavePriority: boolean;
  isActive: boolean;
  discarding: boolean;
  nameOf: (userId: string | null) => string;
  act: (action: GameAction) => void;
  moveCard: (card: GameCard, to: GameZone, extra?: { position?: "top" | "bottom"; faceDown?: boolean }) => void;
  clickCard: (card: GameCard, event: MouseEvent) => void;
  cardMenu: (card: GameCard, x: number, y: number) => void;
  setHover: (card: GameCard | null) => void;
  onDragStart: (card: GameCard, event: DragEvent) => void;
  dropProps: (key: string, handler: (card: GameCard) => void) => {
    onDragOver: (event: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (event: DragEvent) => void;
  };
  dropKey: string | null;
  dropOnTable: (card: GameCard) => void;
  markOf: (card: GameCard) => Mark;
  openZone: (owner: string, zone: GameZone) => void;
  libraryMenu: (event: MouseEvent) => void;
  lifeOpen: boolean;
  toggleLife: () => void;
  /** Karten, die gerade im Kampf in der Mitte liegen (Angreifer, bestätigte Blocker) und nicht mehr auf dem Feld. */
  inCombat: Set<string>;
  allCards: Map<string, GameCard>;
  pendingBlocks: Record<string, string>;
};

export const BattlefieldContext = createContext<BattlefieldApi | null>(null);

export function useBattlefield(): BattlefieldApi {
  const value = useContext(BattlefieldContext);
  if (!value) throw new Error("useBattlefield außerhalb des Spieltischs verwendet.");
  return value;
}
