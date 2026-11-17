import { useEffect, useRef, useState } from "react";
import { getSession } from "../../auth";
import Battlefield from "../battlefield/Battlefield";
import {
  GameApiError,
  type GameAction,
  type GameView,
  connectGame,
  gameSocketUrl,
  type ConnectionStatus,
  type GameApi,
  type GameConnection,
  type RoomView
} from "../../gameClient";

const FORMAT_LABELS = { standard: "Standard", commander: "Commander" } as const;

type LogLine = { id: number; text: string };

/** Raumansicht: Einladungscode, Spielerliste, „bereit“, Start (Gastgeber), Entfernen, Chat. */
export default function GameRoomPanel({
  code,
  baseUrl,
  api,
  onLeft
}: {
  code: string;
  baseUrl: string;
  api: GameApi;
  /** Der Raum ist nicht mehr nutzbar (verlassen, entfernt, geschlossen). */
  onLeft: (notice?: string) => void;
}) {
  const [status, setStatus] = useState<ConnectionStatus>({ state: "connecting" });
  const [room, setRoom] = useState<RoomView | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [chat, setChat] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const connection = useRef<GameConnection | null>(null);
  const lineId = useRef(0);
  const finished = useRef(false);

  const addLog = (text: string) => setLog(current => [...current.slice(-49), { id: (lineId.current += 1), text }]);

  useEffect(() => {
    const url = gameSocketUrl(baseUrl, code);
    if (!url) {
      setError("Der Raumcode oder die Adresse des Spiel-Servers ist ungültig.");
      return undefined;
    }
    finished.current = false;
    let reconnect: number | undefined;
    connection.current = connectGame({
      url,
      getToken: async () => (await getSession())?.accessToken ?? null,
      onStatus: next => {
        setStatus(next);
        if (next.state === "closed" && !finished.current) {
          finished.current = true;
          // 4005 = entfernt/verlassen, 4006 = Raum geschlossen, 4004 = kein Mitglied
          if (next.code === 4004 || next.code === 4005 || next.code === 4006) onLeft(next.detail);
          else reconnect = window.setTimeout(() => setAttempt(value => value + 1), 1500); // Verbindung verloren: automatisch neu verbinden
        }
      },
      onMessage: message => {
        if (message.type === "room") setRoom(message.room);
        if (message.type === "game") setGame(message.game);
        if (message.type === "chat") addLog(`${message.from}: ${message.text}`);
        if (message.type === "system") addLog(message.text);
        if (message.type === "error") addLog(`Hinweis: ${message.message}`);
        if (message.type === "closed" && !finished.current) {
          finished.current = true;
          onLeft(message.reason);
        }
      }
    });
    return () => {
      finished.current = true;
      window.clearTimeout(reconnect);
      connection.current?.close();
      connection.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, baseUrl, attempt]);

  // Stand abgleichen, wenn der Tab wieder sichtbar wird und regelmäßig, damit keine Seite mit einem veralteten Spiel hängen bleibt.
  useEffect(() => {
    if (status.state !== "open") return undefined;
    const sync = () => connection.current?.send({ type: "sync" });
    const timer = window.setInterval(sync, 20_000);
    const visible = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [status.state]);

  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof GameApiError ? failure.message : "Die Aktion ist fehlgeschlagen.");
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Der Code konnte nicht kopiert werden. Bitte markieren und kopieren.");
    }
  };

  const sendAction = (action: GameAction) => connection.current?.send({ type: "game", action });
  const leave = () => {
    if (game && game.phase !== "ended" && !window.confirm("Das Spiel läuft noch. Wenn du den Raum verlässt, gibst du auf. Wirklich verlassen?")) return;
    void run(async () => {
      await api.leaveRoom();
      finished.current = true;
      onLeft(room && room.you === room.hostId ? "Du hast den Raum geschlossen." : "Du hast den Raum verlassen.");
    });
  };

  const me = room?.players.find(player => player.userId === room.you);
  const isHost = Boolean(room && room.you === room.hostId);
  const open = room?.status === "open";
  const everyoneReady = Boolean(room && room.players.length >= 2 && room.players.every(player => player.ready));
  const connected = status.state === "open";

  // Läuft das Spiel, gehört der ganze Bildschirm dem Spieltisch (kein Menü, keine Sammlung).
  if (game && room) {
    return (
      <Battlefield
        game={game}
        hostId={room.hostId}
        send={sendAction}
        onRematch={() => connection.current?.send({ type: "rematch" })}
        onLeave={leave}
        chat={{ lines: log, onSend: text => connection.current?.send({ type: "chat", text }), connected }}
        notice={error || (status.state !== "open" ? "Verbindung unterbrochen – verbinde neu …" : "")}
      />
    );
  }

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Dein Spielraum</h2>
          <p className="muted">
            Teile den Einladungscode mit deinen Mitspielern. Sie brauchen ein Konto und ein gültiges Deck.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="game-room-code">
          <span className="muted">Einladungscode</span>
          <strong aria-label="Einladungscode">{code}</strong>
          <button type="button" className="secondary" onClick={() => void copyCode()}>
            {copied ? "Kopiert" : "Kopieren"}
          </button>
        </div>
        {room && (
          <p className="muted">
            {FORMAT_LABELS[room.format]} · {room.players.length} von {room.maxPlayers} Plätzen ·{" "}
            {open ? "wartet auf den Start" : "Spiel gestartet"} · gültig bis {new Date(room.expiresAt).toLocaleString("de-DE")}
          </p>
        )}
        <p className="muted" role="status">
          {status.state === "open" ? "Verbunden" : status.state === "connecting" ? "Verbinde …" : status.detail}
        </p>
        {status.state === "closed" && (
          <button type="button" className="secondary" onClick={() => onLeft()}>
            Zurück zur Lobby
          </button>
        )}
      </div>

      {room && (
        <div className="panel">
          <h3>Spieler</h3>
          <ul className="game-player-list">
            {room.players.map(player => (
              <li key={player.userId}>
                <strong>{player.name}</strong>
                {player.isHost && <span className="muted"> · Gastgeber</span>}
                {player.bot && <span className="muted"> · Bot</span>}
                {player.userId === room.you && <span className="muted"> · du</span>}
                <span className="muted">
                  {" "}
                  · Deck: {player.deck.name} ({player.deck.cardCount} Karten) · {player.online ? "online" : "offline"} ·{" "}
                </span>
                <span>{player.ready ? "bereit" : "nicht bereit"}</span>
                {isHost && open && player.userId !== room.you && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void run(() => api.kickPlayer(player.userId))}
                    aria-label={`${player.name} entfernen`}
                  >
                    Entfernen
                  </button>
                )}
              </li>
            ))}
          </ul>

          {open && me && (
            <div className="row">
              <button
                type="button"
                className={me.ready ? "secondary" : "primary"}
                disabled={!connected}
                onClick={() => connection.current?.send({ type: "ready", ready: !me.ready })}
              >
                {me.ready ? "Nicht mehr bereit" : "Bereit"}
              </button>
              {isHost && (
                <button
                  type="button"
                  className="primary"
                  disabled={!connected || !everyoneReady}
                  title={everyoneReady ? undefined : "Es braucht mindestens 2 Spieler, und alle müssen bereit sein."}
                  onClick={() => connection.current?.send({ type: "start" })}
                >
                  Spiel starten
                </button>
              )}
            </div>
          )}

          {open && isHost && !everyoneReady && (
            <p className="muted">Zum Starten brauchst du mindestens 2 Spieler, und alle müssen „bereit“ sein.</p>
          )}
          {!open && <div className="notice" role="status">Das Spiel wird vorbereitet …</div>}
        </div>
      )}

      <div className="panel">
        <h3>Chat</h3>
        <form
          className="row"
          onSubmit={event => {
            event.preventDefault();
            if (!chat.trim()) return;
            connection.current?.send({ type: "chat", text: chat });
            setChat("");
          }}
        >
          <input value={chat} onChange={event => setChat(event.target.value)} placeholder="Nachricht" aria-label="Chat-Nachricht" />
          <button type="submit" className="secondary" disabled={!connected}>
            Senden
          </button>
        </form>
        {log.length > 0 && (
          <ul>
            {log.map(line => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
        )}
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="row">
        <button type="button" className="secondary" onClick={leave}>
          {isHost ? "Raum schließen" : "Raum verlassen"}
        </button>
      </div>
    </section>
  );
}
