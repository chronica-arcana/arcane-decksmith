import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DragEvent, MouseEvent } from "react";
import type { CardAbility, GameAction, GameCard, GameView, GameZone, PayRequirement, TargetOption } from "../../gameClient";
import tableImage from "../../assets/game/table.webp";
import ActionBar from "./ActionBar";
import { BattlefieldContext, type BattlefieldApi, type Mark } from "./BattlefieldContext";
import CardPreview from "./CardPreview";
import CardView from "./CardView";
import CenterZone from "./CenterZone";
import CoinFlip from "./CoinFlip";
import ChatDrawer, { type ChatApi } from "./ChatDrawer";
import ChoiceDialog from "./ChoiceDialog";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import FxLayer from "./FxLayer";
import MulliganScreen from "./MulliganScreen";
import PhaseStrip from "./PhaseStrip";
import PlayerZone from "./PlayerZone";
import ManaPick from "./ManaPick";
import SettingsDialog from "./SettingsDialog";
import "./battlefield.css";

const ZONE_LABELS: Record<GameZone, string> = {
  library: "Bibliothek",
  hand: "Hand",
  battlefield: "Schlachtfeld",
  graveyard: "Friedhof",
  exile: "Exil",
  command: "Kommandozone"
};
const MANA_NAMES: Record<string, string> = { W: "Weiß", U: "Blau", B: "Schwarz", R: "Rot", G: "Grün", C: "Farblos" };

type Menu = { x: number; y: number; items: MenuItem[] } | null;
type Targeting = { name: string; specs: TargetOption[]; picked: string[]; run: (targets: string[]) => GameAction };

/**
 * Battlefield: der Spielraum. Er füllt den ganzen Bildschirm (ohne Sammlung, Menü oder Seitenkopf der App) und zeigt eine einzige,
 * durchgehende Matte: Gegner oben (gespiegelt), Mitte mit Stapel und Kampf, dein Platz unten, darunter die Phasen.
 * Die Regeln setzt der Server durch: Karten, Mana, Ziele und Effekte folgen dem Kartentext; von Hand greifst du nur ein,
 * wenn ein Kartentext nicht automatisch umgesetzt werden kann.
 */
export default function Battlefield({
  game,
  hostId,
  send,
  onRematch,
  onLeave,
  chat,
  notice
}: {
  game: GameView;
  hostId: string;
  send: (action: GameAction) => void;
  onRematch: () => void;
  /** Raum verlassen (Bestätigung übernimmt der Aufrufer). */
  onLeave: () => void;
  chat?: ChatApi;
  notice?: string;
}) {
  const me = game.players.find(player => player.userId === game.you);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [hover, setHover] = useState<GameCard | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [zoneView, setZoneView] = useState<{ owner: string; zone: GameZone } | null>(null);
  const [discardPick, setDiscardPick] = useState<string[]>([]);
  const [attackPick, setAttackPick] = useState<string[]>([]);
  const [attackTarget, setAttackTarget] = useState("");
  const [blockPick, setBlockPick] = useState<string | null>(null);
  const [blockState, setBlockState] = useState<{ turn: number; map: Record<string, string> }>({ turn: -1, map: {} });
  // Die Auswahl gilt nur für diesen Zug und bleibt stehen, bis der Server den Block angenommen hat (bei Ablehnung geht sie nicht verloren).
  const setBlocks = (update: (current: Record<string, string>) => Record<string, string>) =>
    setBlockState(current => ({ turn: game.turn.number, map: update(current.turn === game.turn.number ? current.map : {}) }));
  const [castX, setCastX] = useState<{ id: string; name: string; value: number } | null>(null);
  const [drawer, setDrawer] = useState<"chat" | "log" | null>(null);
  const [lifeOpen, setLifeOpen] = useState(false);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chooseMana, setChooseManaState] = useState(() => {
    try {
      return localStorage.getItem("ad-choose-mana") === "1";
    } catch {
      return false;
    }
  });
  const setChooseMana = (value: boolean) => {
    setChooseManaState(value);
    try {
      localStorage.setItem("ad-choose-mana", value ? "1" : "0");
    } catch {
      // ohne Speicher: gilt nur für diese Sitzung
    }
  };
  const [payPick, setPayPick] = useState<{ action: GameAction; name: string; cost: string } | null>(null);
  const [modePick, setModePick] = useState<{ card: GameCard; x?: number } | null>(null);
  const [coinDone, setCoinDone] = useState<number | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const hoverTimer = useRef<number | undefined>(undefined);

  // Vollbild: Der Hintergrund (App mit Sammlung usw.) scrollt nicht mit.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Eine Berührung oder ein Klick außerhalb der Karten blendet die Vorschau aus (Touch kennt kein „Maus verlässt Karte“).
    const hide = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".gc")) return;
      window.clearTimeout(hoverTimer.current);
      setHover(null);
      setPinnedId(null);
    };
    window.addEventListener("pointerdown", hide);
    return () => {
      document.body.style.overflow = previous;
      window.clearTimeout(hoverTimer.current);
      window.removeEventListener("pointerdown", hide);
    };
  }, []);

  const allCards = useMemo(() => {
    const map = new Map<string, GameCard>();
    for (const player of game.players) {
      for (const list of [player.hand, player.battlefield, player.graveyard, player.exile, player.command, player.looking ?? []]) {
        for (const card of list) map.set(card.id, card);
      }
    }
    for (const item of game.stack) if (item.card) map.set(item.card.id, item.card);
    return map;
  }, [game]);

  if (!me) return null;

  const opponents = game.players.filter(player => player.userId !== game.you);
  const livingOpponents = opponents.filter(player => !player.eliminated);
  const nameOf = (id: string | null) => game.players.find(player => player.userId === id)?.name ?? (id ? allCards.get(id)?.name ?? "" : "");
  const step = game.turn.phase;
  const isActive = game.turn.active === game.you;
  const canAct = game.phase === "playing" && !me.eliminated;
  const iHavePriority = game.priority === game.you && canAct && !game.choice && !game.manual;
  const manualMine = game.manual?.userId === game.you;
  const manualText = game.manual?.text ?? "";
  const has = (pattern: RegExp) => pattern.test(manualText);
  /** Im manuellen Fenster ist nur erlaubt, was der Kartentext verlangt. */
  const manualAllows = {
    draw: has(/draw/i),
    mill: has(/mill/i),
    life: has(/life|damage/i),
    counters: has(/counter/i),
    token: has(/token|create/i),
    move: has(/return|exile|destroy|sacrifice|discard|into (your|the|its owner)|onto the battlefield|from (your|a) (graveyard|hand|library)|search/i),
    tap: has(/\btap|untap/i),
    reveal: has(/reveal/i),
    flip: has(/face|manifest|morph/i),
    shuffle: has(/shuffle|search/i),
    look: has(/look|search|scry|surveil/i)
  };
  const canDrawNow = game.phase === "playing" && !me.eliminated && game.turn.active === game.you && step === "draw" && !game.turn.drawn && !game.turn.drawBlocked && game.stack.length === 0 && !game.choice && !game.manual;
  const beganAt = game.turn.beganAt ?? 0;
  const showCoin = game.phase === "playing" && game.turn.number === 1 && beganAt > 0 && coinDone !== beganAt && beganAt >= mountedAt - 4000 && Boolean(game.turn.first);
  const target = attackTarget || livingOpponents[0]?.userId || "";
  const awaitingMe = Boolean(game.combat?.awaiting.includes(game.you));
  const blocks = awaitingMe && blockState.turn === game.turn.number ? blockState.map : {};
  const attackedMe = game.combat?.attackers.filter(attacker => attacker.target === game.you) ?? [];
  const canAttack = me.battlefield.some(card => card.kind === "creature" && !card.tapped && !card.sick && !card.faceDown && !card.keywords?.includes("defender"));
  const attackStep = canAct && isActive && step === "attackers" && game.stack.length === 0 && !game.choice && !game.manual;
  const discarding = game.pendingDiscard?.userId === game.you;
  const previewCard = hover ?? (pinnedId ? allCards.get(pinnedId) : undefined) ?? null;
  const inCombat = new Set<string>();
  for (const card of allCards.values()) if (card.attacking || card.blocking) inCombat.add(card.id);

  const act = (action: GameAction) => send(action);
  const setHoverStable = (card: GameCard | null) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(card), card ? 70 : 140);
  };
  const zoneOf = (card: GameCard): GameZone | null => {
    for (const zone of ["hand", "battlefield", "graveyard", "exile", "command"] as const) {
      if (me[zone].some(item => item.id === card.id)) return zone;
    }
    return me.looking?.some(item => item.id === card.id) ? "library" : null;
  };
  const moveCard = (card: GameCard, to: GameZone, extra: { position?: "top" | "bottom"; faceDown?: boolean } = {}) =>
    act({ type: "move", id: card.id, to, ...extra });

  // ---------- Zielwahl ----------
  const currentSpec = targeting ? targeting.specs[targeting.picked.length] : undefined;
  const isTarget = (id: string) => Boolean(currentSpec?.options.includes(id)) && !(currentSpec?.kind.startsWith("pay") && targeting?.picked.includes(id));
  const pickTarget = (id: string) => {
    if (!targeting || !isTarget(id)) return;
    const picked = [...targeting.picked, id];
    if (picked.length >= targeting.specs.length) {
      payOrAct(targeting.run(picked));
      setTargeting(null);
      setZoneView(current => (current?.zone === "graveyard" ? null : current));
    } else setTargeting({ ...targeting, picked });
  };
  const startTargeting = (name: string, specs: TargetOption[], run: (targets: string[]) => GameAction) => {
    if (specs.length === 0) return payOrAct(run([]));
    setTargeting({ name, specs, picked: [], run });
    // Ziele im eigenen Friedhof: gleich öffnen, damit man die Karte anklicken kann
    if (specs.some(spec => spec.kind.startsWith("gy"))) setZoneView({ owner: game.you, zone: "graveyard" });
  };

  /** Ziele und zusätzliche Kosten (Karten opfern/abwerfen) werden nacheinander gewählt; die Kosten-Auswahl geht als `pay` zum Server. */
  const withPays = (specs: TargetOption[], pays: PayRequirement[] | undefined, build: (targets: string[], pay: string[]) => GameAction) => {
    const picks: TargetOption[] = (pays ?? [])
      .filter(item => item.kind !== "life")
      .flatMap(item => Array.from({ length: item.n }, () => ({ kind: item.kind === "discard" ? "payDiscard" : "paySacrifice", options: item.options })));
    return { specs: [...specs, ...picks], run: (picked: string[]) => build(picked.slice(0, specs.length), picked.slice(specs.length)) };
  };

  /** Mit „Mana selbst wählen“ erst die Länder wählen lassen, sonst sofort ausführen. */
  const payOrAct = (action: GameAction) => {
    if (!chooseMana || (action.type !== "cast" && action.type !== "activate" && action.type !== "cycle")) return act(action);
    const card = allCards.get(action.id);
    if (!card) return act(action);
    let cost = "";
    if (action.type === "cast") cost = (card.manaCost ?? "").replace(/\{X\}/gi, () => `{${action.x ?? 0}}`);
    else if (action.type === "cycle") cost = card.cycle?.cost ?? "";
    else cost = (card.abilities?.find(ability => ability.index === action.index)?.costLabel ?? "").replace(/\{T\}/g, "");
    const sources = me.battlefield.filter(item => item.mana && !item.tapped && !item.sick && item.id !== (action.type === "activate" ? action.id : ""));
    if (!/\{[^}]+\}/.test(cost) || sources.length === 0) return act(action);
    setPayPick({ action, name: card.name ?? "Karte", cost });
  };

  const startCast = (card: GameCard, x?: number, mode?: number) => {
    if (card.play?.kind === "land") return act({ type: "playLand", id: card.id });
    if (x === undefined && /\{X\}/i.test(card.manaCost ?? "")) return setCastX({ id: card.id, name: card.name ?? "", value: 0 });
    if (mode === undefined && card.play?.modes?.length) return setModePick({ card, x });
    const chosen = mode !== undefined ? card.play?.modes?.[mode] : undefined;
    const flow = withPays(chosen?.targets ?? card.play?.targets ?? [], card.play?.pays, (targets, pay) => ({
      type: "cast",
      id: card.id,
      ...(mode !== undefined ? { mode } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(targets.length > 0 ? { targets } : {}),
      ...(pay.length > 0 ? { pay } : {})
    }));
    startTargeting(card.name ?? "Zauber", flow.specs, flow.run);
  };
  const startActivate = (card: GameCard, ability: CardAbility) => {
    const flow = withPays(ability.targets, ability.pays, (targets, pay) => ({
      type: "activate",
      id: card.id,
      index: ability.index,
      ...(targets.length > 0 ? { targets } : {}),
      ...(pay.length > 0 ? { pay } : {})
    }));
    startTargeting(card.name ?? "Fähigkeit", flow.specs, flow.run);
  };

  // ---------- Drag and Drop ----------
  const onDragStart = (card: GameCard, event: DragEvent) => {
    event.dataTransfer.setData("text/plain", card.id);
    event.dataTransfer.effectAllowed = "move";
  };
  const dropProps = (key: string, handler: (card: GameCard) => void) => ({
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDropKey(key);
    },
    onDragLeave: () => setDropKey(current => (current === key ? null : current)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropKey(null);
      const card = allCards.get(event.dataTransfer.getData("text/plain"));
      if (card && card.owner === game.you && canAct) handler(card);
    }
  });
  /** Eine Karte auf den Tisch ziehen: Land legen bzw. Zauber wirken (nur, wenn die Regeln es jetzt erlauben). */
  const dropOnTable = (card: GameCard) => {
    const zone = zoneOf(card);
    if ((zone === "hand" || zone === "command") && card.play?.ok) startCast(card);
    else if (manualMine && manualAllows.move && zone && zone !== "battlefield") moveCard(card, "battlefield");
  };

  // ---------- Menüs ----------
  const cardMenu = (card: GameCard, x: number, y: number) => {
    const items: MenuItem[] = [{ label: "Groß ansehen", onClick: () => setPinnedId(card.id) }];
    const stackItem = game.stack.find(item => item.card?.id === card.id);
    if (card.owner === game.you && canAct && !stackItem && !targeting) {
      const zone = zoneOf(card);
      const moves = (zones: GameZone[]) =>
        zones
          .filter(z => z !== zone && (z !== "command" || (game.format === "commander" && card.cmd)))
          .map(z => ({ label: `→ ${ZONE_LABELS[z]}`, onClick: () => moveCard(card, z) }));
      const library: MenuItem[] = [
        { label: "→ Bibliothek oben", onClick: () => moveCard(card, "library", { position: "top" }) },
        { label: "→ Bibliothek unten", onClick: () => moveCard(card, "library", { position: "bottom" }) }
      ];
      if (zone === "hand" && card.cycle) {
        items.push({ label: `Cycling ${card.cycle.cost}${card.cycle.search ? " (Land suchen)" : " (Karte ziehen)"}`, disabled: !card.cycle.ok, onClick: () => payOrAct({ type: "cycle", id: card.id }) });
      }
      if ((zone === "hand" || zone === "command" || zone === "graveyard") && card.play) {
        items.push({ label: card.play.kind === "land" ? "Land spielen" : zone === "graveyard" ? "Mit Rückblende wirken" : "Wirken", disabled: !card.play.ok, onClick: () => startCast(card) });
      }
      if (zone === "battlefield") {
        if (card.mana && !card.tapped && !card.sick) {
          for (const color of card.manaColors ?? []) {
            items.push({ label: `Mana ${MANA_NAMES[color] ?? color}`, onClick: () => act({ type: "tapMana", id: card.id, color }) });
          }
        }
        for (const ability of card.abilities ?? []) {
          items.push({ label: `Fähigkeit: ${ability.text}`, disabled: !ability.ok, onClick: () => startActivate(card, ability) });
        }
      }
      if (manualMine) {
        const manual: MenuItem[] = [];
        const creature = card.kind === "creature" || /planeswalker/i.test(card.typeLine ?? "");
        if (zone === "hand") {
          if (manualAllows.reveal) manual.push({ label: "Zeigen / verbergen", onClick: () => act({ type: "reveal", id: card.id }) });
          if (manualAllows.flip) manual.push({ label: "Verdeckt ausspielen", onClick: () => moveCard(card, "battlefield", { faceDown: true }) });
          if (manualAllows.move) manual.push({ label: "→ Schlachtfeld", onClick: () => moveCard(card, "battlefield") }, ...moves(["graveyard", "exile"]), ...library);
        } else if (zone === "battlefield") {
          if (manualAllows.tap) manual.push({ label: card.tapped ? "Enttappen" : "Tappen", onClick: () => act({ type: "tap", id: card.id }) });
          if (manualAllows.flip) manual.push({ label: "Umdrehen", onClick: () => act({ type: "flip", id: card.id }) });
          if (manualAllows.counters && creature) {
            manual.push({ label: "+1/+1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "+1/+1", delta: 1 }) });
            manual.push({ label: "−1/−1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "-1/-1", delta: 1 }) });
            for (const kind of Object.keys(card.counters)) manual.push({ label: `${kind}-Marker entfernen`, onClick: () => act({ type: "counter", id: card.id, kind, delta: -1 }) });
          }
          if (manualAllows.move) manual.push(...moves(["hand", "graveyard", "exile", "command"]), ...library);
        } else if (zone && manualAllows.move) {
          manual.push({ label: "→ Schlachtfeld", onClick: () => moveCard(card, "battlefield") }, ...moves(["hand", "graveyard", "exile", "command"]), ...library);
        }
        if (manual.length > 0) items.push({ label: "Laut Kartentext:", onClick: () => undefined, heading: true }, ...manual);
      }
    }
    // Handarbeit an Karten der Gegner (nur im manuellen Fenster, nur was der Kartentext verlangt), z. B. Schaden an einer fremden Kreatur
    if (manualMine && canAct && !stackItem && !targeting && card.owner !== game.you && game.players.some(p => p.userId === card.owner && p.battlefield.some(c => c.id === card.id))) {
      const manual: MenuItem[] = [];
      const isCreature = card.kind === "creature";
      if (isCreature && manualAllows.life) {
        manual.push({ label: "+1 Schaden", onClick: () => act({ type: "damage", id: card.id, delta: 1 }) });
        manual.push({ label: "−1 Schaden", onClick: () => act({ type: "damage", id: card.id, delta: -1 }) });
      }
      if (isCreature && manualAllows.counters) {
        manual.push({ label: "+1/+1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "+1/+1", delta: 1 }) });
        manual.push({ label: "−1/−1 Marker", onClick: () => act({ type: "counter", id: card.id, kind: "-1/-1", delta: 1 }) });
      }
      if (manualAllows.tap) manual.push({ label: card.tapped ? "Enttappen" : "Tappen", onClick: () => act({ type: "tap", id: card.id }) });
      if (manualAllows.move) {
        manual.push({ label: "→ Friedhof", onClick: () => act({ type: "moveOther", id: card.id, to: "graveyard" }) });
        manual.push({ label: "→ Exil", onClick: () => act({ type: "moveOther", id: card.id, to: "exile" }) });
        manual.push({ label: "→ Hand des Besitzers", onClick: () => act({ type: "moveOther", id: card.id, to: "hand" }) });
      }
      if (manual.length > 0) items.push({ label: "Laut Kartentext:", onClick: () => undefined, heading: true }, ...manual);
    }
    setMenu({ x, y, items });
  };

  const gameMenu = (event: MouseEvent) => {
    const items: MenuItem[] = [{ label: "Einstellungen …", onClick: () => setSettingsOpen(true) }];
    if (manualMine) {
      const manual: MenuItem[] = [];
      if (manualAllows.draw) manual.push({ label: "Karte ziehen", onClick: () => act({ type: "draw" }) });
      if (manualAllows.mill) manual.push({ label: "Oberste Karte mahlen", onClick: () => act({ type: "mill" }) });
      if (manualAllows.shuffle) manual.push({ label: "Bibliothek mischen", onClick: () => act({ type: "shuffle" }) });
      if (manualAllows.tap) manual.push({ label: "Alles enttappen", onClick: () => act({ type: "untapAll" }) });
      if (manualAllows.token) {
        manual.push({
          label: "Spielstein erzeugen …",
          onClick: () => {
            const name = window.prompt("Spielstein (z. B. „Goblin 1/1“):", "Goblin 1/1")?.trim();
            if (name) act({ type: "token", name });
          }
        });
      }
      if (manualAllows.life) manual.push({ label: "Leben anpassen …", onClick: () => setLifeOpen(true) });
      if (manual.length > 0) items.push({ label: "Laut Kartentext:", onClick: () => undefined, heading: true }, ...manual);
    }
    if (canAct) {
      items.push({
        label: "Aufgeben",
        onClick: () => {
          if (window.confirm("Wirklich aufgeben?")) act({ type: "concede" });
        }
      });
    }
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const libraryMenu = (event: MouseEvent) => {
    const look = (count: number | "all") => {
      act({ type: "look", count });
      setZoneView({ owner: game.you, zone: "library" });
    };
    setMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        ...(manualAllows.look ? [{ label: "Oberste 3 ansehen", onClick: () => look(3) }, { label: "Bibliothek durchsuchen", onClick: () => look("all") }] : []),
        ...(manualAllows.shuffle ? [{ label: "Mischen", onClick: () => act({ type: "shuffle" }) }] : []),
        ...(manualAllows.mill ? [{ label: "Oberste Karte mahlen", onClick: () => act({ type: "mill" }) }] : [])
      ]
    });
  };

  // ---------- Klick = Hauptaktion ----------
  const clickCard = (card: GameCard, event: MouseEvent) => {
    if (targeting) {
      if (isTarget(card.id)) pickTarget(card.id);
      return;
    }
    const own = card.owner === game.you;
    const zone = own ? zoneOf(card) : null;
    if (!own) {
      if (awaitingMe && blockPick && attackedMe.some(attacker => attacker.id === card.id)) {
        setBlocks(current => ({ ...current, [blockPick]: card.id }));
        setBlockPick(null);
      }
      return;
    }
    if (discarding && zone === "hand") {
      setDiscardPick(current => (current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id]));
      return;
    }
    if (zone === "battlefield") {
      if (attackStep && card.kind === "creature") {
        if (!card.tapped && !card.sick && !card.keywords?.includes("defender") && livingOpponents.length > 0) {
          setAttackPick(current => (current.includes(card.id) ? current.filter(id => id !== card.id) : [...current, card.id]));
        }
        return;
      }
      if (awaitingMe && step === "blockers" && card.kind === "creature" && !card.tapped) {
        setBlockPick(current => (current === card.id ? null : card.id));
        return;
      }
      if (!canAct || game.choice || (game.manual && !manualMine)) return;
      if (card.mana && !card.tapped && !card.sick) {
        const colors = card.manaColors ?? [];
        if (colors.length > 1) {
          setMenu({
            x: event.clientX,
            y: event.clientY,
            items: [
              { label: "Mana wählen", onClick: () => undefined, heading: true },
              ...colors.map(color => ({ label: MANA_NAMES[color] ?? color, onClick: () => act({ type: "tapMana", id: card.id, color }) }))
            ]
          });
        } else act({ type: "tapMana", id: card.id });
        return;
      }
      const abilities = card.abilities ?? [];
      if (abilities.length === 1 && abilities[0].ok) {
        startActivate(card, abilities[0]);
        return;
      }
      if (abilities.length > 0) {
        cardMenu(card, event.clientX, event.clientY);
        return;
      }
      return;
    }
    if ((zone === "hand" || zone === "command" || zone === "graveyard") && canAct && card.play?.ok) {
      startCast(card);
    }
  };

  const markOf = (card: GameCard): Mark =>
    isTarget(card.id)
      ? "target"
      : attackPick.includes(card.id)
        ? "attack"
        : blockPick === card.id
          ? "pick"
          : blocks[card.id]
            ? "block"
            : discardPick.includes(card.id)
              ? "pick"
              : null;

  const api: BattlefieldApi = {
    game,
    me,
    opponents,
    canAct,
    iHavePriority,
    isActive,
    discarding,
    nameOf,
    act,
    moveCard,
    clickCard,
    cardMenu,
    setHover: setHoverStable,
    onDragStart,
    dropProps,
    dropKey,
    dropOnTable,
    markOf,
    openZone: (owner, zone) => setZoneView(current => (current?.owner === owner && current.zone === zone ? null : { owner, zone })),
    libraryMenu,
    manualMine,
    targeting: targeting ? { name: targeting.name, specs: targeting.specs, picked: targeting.picked } : null,
    isTarget,
    pickTarget,
    lifeOpen,
    toggleLife: () => setLifeOpen(open => !open),
    manualAllows,
    canDrawNow,
    drawCard: () => act({ type: "drawStep" }),
    inCombat,
    allCards,
    pendingBlocks: blocks
  };

  const frame = (children: React.ReactNode) =>
    createPortal(
    <div className="room" data-opps={opponents.length} style={{ backgroundImage: `url(${tableImage})` }} role="region" aria-label="Spieltisch">
      <header className="room-top">
        <button type="button" className="secondary leave" onClick={onLeave}>← Raum verlassen</button>
        <span className="room-title">{game.format === "commander" ? "Commander" : "Standard"}</span>
        <div className="room-tools">
          {chat && <button type="button" className="secondary" aria-pressed={drawer === "chat"} onClick={() => setDrawer(drawer === "chat" ? null : "chat")}>Chat</button>}
          <button type="button" className="secondary" aria-pressed={drawer === "log"} onClick={() => setDrawer(drawer === "log" ? null : "log")}>Verlauf</button>
          <button type="button" className="secondary menu-btn" aria-label="Weitere Aktionen" onClick={gameMenu}>⋯</button>
        </div>
      </header>
      {children}
      {notice && <div className="room-notice" role="alert">{notice}</div>}
      {drawer && (
        <ChatDrawer
          chat={chat ?? { lines: [], onSend: () => undefined, connected: false }}
          log={game.log}
          tab={drawer === "chat" && chat ? "chat" : "log"}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
        />
      )}
      <CardPreview card={previewCard} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>,
    document.body
  );

  if (game.phase === "mulligan") {
    return frame(<MulliganScreen game={game} me={me} act={act} onHover={setHoverStable} />);
  }

  const zoneOwner = zoneView ? game.players.find(player => player.userId === zoneView.owner) : undefined;
  const zoneCards: GameCard[] =
    zoneOwner && zoneView ? (zoneView.zone === "library" ? (zoneOwner.looking ?? []) : zoneOwner[zoneView.zone as "graveyard" | "exile" | "command" | "hand"]) : [];

  return (
    <BattlefieldContext.Provider value={api}>
      {frame(
        <>
          <main className="mat">
            <div className={`mat-opps${opponents.length > 1 ? " multi" : ""}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, opponents.length)}, minmax(0, 1fr))` }}>
              {opponents.map(player => (
                <PlayerZone key={player.userId} player={player} />
              ))}
            </div>
            <CenterZone>
              <ActionBar
                game={game}
                me={me}
                hostId={hostId}
                nameOf={nameOf}
                allCards={allCards}
                act={act}
                iHavePriority={iHavePriority}
                isActive={isActive}
                discarding={discarding}
                attackStep={attackStep}
                awaitingMe={awaitingMe}
                livingOpponents={livingOpponents}
                attackPick={attackPick}
                clearAttackPick={() => setAttackPick([])}
                target={target}
                setAttackTarget={setAttackTarget}
                blockPick={blockPick}
                blocks={blocks}
                resetBlocks={() => {
                  setBlocks(() => ({}));
                  setBlockPick(null);
                }}
                discardPick={discardPick}
                clearDiscardPick={() => setDiscardPick([])}
                canAttack={canAttack}
                targeting={targeting}
                cancelTargeting={() => setTargeting(null)}
                onRematch={onRematch}
                onLeave={onLeave}
              />
            </CenterZone>
            <PlayerZone player={me} />
            <PhaseStrip
              game={game}
              activeName={nameOf(game.turn.active)}
              hint={isActive ? "Du bist am Zug" : `${nameOf(game.turn.active)} ist am Zug`}
              detail={
                game.phase !== "playing" || game.turn.manualStart
                  ? undefined
                  : game.turn.drew
                    ? "Alles enttappt, Karte gezogen"
                    : game.turn.number === 1 && game.players.length === 2
                      ? "Im ersten Zug zieht der Startspieler nicht"
                      : "Alles enttappt"
              }
            />
          </main>

          <FxLayer fx={game.fx ?? []} />

          {showCoin && game.turn.first && <CoinFlip players={game.players} firstId={game.turn.first} onDone={() => setCoinDone(beganAt)} />}

          {modePick && (
            <div className="modal-back">
              <div className="modal small" role="dialog" aria-label="Modus wählen">
                <h3>{modePick.card.name}: Wähle einen Modus</h3>
                <div className="mode-list">
                  {modePick.card.play?.modes?.map((mode, index) => {
                    const blocked = mode.targets.some(target => target.options.length === 0) || mode.manual;
                    return (
                      <button
                        key={index}
                        type="button"
                        className="secondary"
                        disabled={blocked}
                        onClick={() => {
                          const { card, x } = modePick;
                          setModePick(null);
                          startCast(card, x, index);
                        }}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
                <div className="start-actions">
                  <button type="button" className="secondary" onClick={() => setModePick(null)}>Abbrechen</button>
                </div>
              </div>
            </div>
          )}

          {settingsOpen && <SettingsDialog me={me} act={act} onClose={() => setSettingsOpen(false)} chooseMana={chooseMana} onChooseMana={setChooseMana} />}
          {payPick && (
            <ManaPick
              name={payPick.name}
              cost={payPick.cost}
              sources={me.battlefield.filter(item => item.mana && !item.tapped && !item.sick && !(payPick.action.type === "activate" && item.id === payPick.action.id))}
              onPay={ids => {
                act({ ...payPick.action, tap: ids } as GameAction);
                setPayPick(null);
              }}
              onAuto={() => {
                act(payPick.action);
                setPayPick(null);
              }}
              onCancel={() => setPayPick(null)}
            />
          )}

          {game.choice && game.choice.userId === game.you && <ChoiceDialog key={game.choice.prompt} choice={game.choice} act={act} onHover={setHoverStable} />}

          {zoneView && zoneOwner && (
            <div className="modal-back" onClick={() => (zoneView.zone === "library" && act({ type: "closeLook" }), setZoneView(null))}>
              <div className="modal" role="dialog" aria-label={ZONE_LABELS[zoneView.zone]} onClick={event => event.stopPropagation()}>
                <div className="modal-head">
                  <h3>
                    {ZONE_LABELS[zoneView.zone]} von {zoneOwner.name}
                    {zoneView.zone === "library" ? " (oberste Karten zuerst)" : ""}
                  </h3>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      if (zoneView.zone === "library") act({ type: "closeLook" });
                      setZoneView(null);
                    }}
                  >
                    Schließen
                  </button>
                </div>
                <div className="zone-list">
                  {zoneCards.length === 0 && <span className="muted">Leer.</span>}
                  {[...zoneCards].reverse().map(card => (
                    <CardView
                      key={card.id}
                      card={card}
                      size="md"
                      marked={markOf(card)}
                      onSelect={clickCard}
                      onHover={setHoverStable}
                      onMenu={cardMenu}
                      onDragStart={card.owner === game.you ? onDragStart : undefined}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {castX && (
            <div className="modal-back">
              <div className="modal small" role="dialog" aria-label="X wählen">
                <h3>{castX.name}: Wert für X</h3>
                <div className="start-actions">
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={castX.value}
                    onChange={event => setCastX({ ...castX, value: Math.max(0, Number(event.target.value) || 0) })}
                    aria-label="Wert für X"
                  />
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      const card = allCards.get(castX.id);
                      setCastX(null);
                      if (card) startCast(card, castX.value);
                    }}
                  >
                    Wirken
                  </button>
                  <button type="button" className="secondary" onClick={() => setCastX(null)}>Abbrechen</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </BattlefieldContext.Provider>
  );
}
