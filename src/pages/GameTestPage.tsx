import { useEffect, useRef, useState } from "react";
import { getSession } from "../auth";
import {
  DEFAULT_GAME_WORKER_URL,
  connectGame,
  gameSocketUrl,
  randomRoomCode,
  type ConnectionStatus,
  type GameConnection,
  type GameView
} from "../gameClient";

type LogLine = { id: number; text: string };

/**
 * Versteckte Testseite (#/spieltest) für den Machbarkeitstest des Online-Spiels.
 * Zeigt, dass Anmeldung, Echtzeit-Verbindung und getrennte Sichten funktionieren.
 */
export default function GameTestPage() {
  const [baseUrl, setBaseUrl] = useState(
    (import.meta.env.VITE_GAME_WORKER_URL as string | undefined)?.trim() || DEFAULT_GAME_WORKER_URL
  );
  const [room, setRoom] = useState(() => randomRoomCode());
  const [status, setStatus] = useState<ConnectionStatus>({ state: "closed", code: 0, detail: "Nicht verbunden." });
  const [view, setView] = useState<GameView | null>(null);
  const [instance, setInstance] = useState("");
  const [chat, setChat] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const connection = useRef<GameConnection | null>(null);
  const lineId = useRef(0);

  const addLog = (text: string) =>
    setLog(current => [...current.slice(-49), { id: (lineId.current += 1), text }]);

  const disconnect = () => {
    connection.current?.close();
    connection.current = null;
  };

  useEffect(() => disconnect, []);

  const connect = () => {
    setError("");
    const url = gameSocketUrl(baseUrl, room);
    if (!url) {
      setError("Worker-Adresse oder Raumcode (4 bis 12 Buchstaben/Ziffern) ist ungültig.");
      return;
    }
    disconnect();
    setView(null);
    setLog([]);
    connection.current = connectGame({
      url,
      getToken: async () => (await getSession())?.accessToken ?? null,
      onStatus: next => {
        setStatus(next);
        if (next.state === "closed") addLog(next.detail);
        if (next.state === "open") addLog("Verbunden, melde an …");
      },
      onMessage: message => {
        if (message.type === "welcome") addLog(`Angemeldet im Raum ${message.roomCode}.`);
        if (message.type === "view") {
          setView(message.view);
          if (message.instance) setInstance(message.instance);
        }
        if (message.type === "chat") addLog(`${message.from}: ${message.text}`);
        if (message.type === "error") addLog(`Fehler: ${message.message}`);
      }
    });
  };

  const connected = status.state === "open";
  const me = view?.players.find(player => player.userId === view.you);

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Spieltest (Machbarkeitstest)</h2>
          <p className="muted">
            Interne Testseite für das Online-Spiel. Öffne dieselbe Seite mit einem zweiten Konto und gib denselben
            Raumcode ein: Jeder sieht nur seine eigene Hand, vom anderen nur die Anzahl der Karten.
          </p>
        </div>
      </div>

      <div className="panel">
        <label>
          Adresse des Spiel-Workers
          <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} disabled={connected} />
        </label>
        <label>
          Raumcode
          <input
            value={room}
            onChange={event => setRoom(event.target.value.toUpperCase())}
            maxLength={12}
            disabled={connected}
            aria-label="Raumcode"
          />
        </label>
        <div className="row">
          <button type="button" className="secondary" onClick={() => setRoom(randomRoomCode())} disabled={connected}>
            Neuer Code
          </button>
          {connected ? (
            <button type="button" className="secondary" onClick={disconnect}>
              Trennen
            </button>
          ) : (
            <button type="button" className="primary" onClick={connect} disabled={status.state === "connecting"}>
              {status.state === "connecting" ? "Verbinde …" : "Verbinden"}
            </button>
          )}
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <p className="muted" role="status">
          Status: {status.state === "open" ? "verbunden" : status.state === "connecting" ? "verbindet" : status.detail}
          {instance && ` · Server-Instanz ${instance}`}
        </p>
      </div>

      {view && (
        <div className="panel">
          <h3>Raum {view.roomCode}</h3>
          <ul>
            {view.players.map(player => (
              <li key={player.userId}>
                <strong>{player.name}</strong>
                {player.userId === view.you && " (du)"} · Platz {player.seat + 1} ·{" "}
                {player.online ? "online" : "offline"} · Hand: {player.handCount} · Bibliothek: {player.libraryCount}
                {player.hand && player.hand.length > 0 && <> — {player.hand.join(", ")}</>}
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" className="primary" onClick={() => connection.current?.send({ type: "draw" })} disabled={!connected || !me}>
              Karte ziehen
            </button>
          </div>
          <form
            className="row"
            onSubmit={event => {
              event.preventDefault();
              if (!chat.trim()) return;
              connection.current?.send({ type: "chat", text: chat });
              setChat("");
            }}
          >
            <input value={chat} onChange={event => setChat(event.target.value)} placeholder="Chat-Nachricht" aria-label="Chat-Nachricht" />
            <button type="submit" className="secondary" disabled={!connected}>
              Senden
            </button>
          </form>
        </div>
      )}

      {log.length > 0 && (
        <div className="panel">
          <h3>Protokoll</h3>
          <ul>
            {log.map(line => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
