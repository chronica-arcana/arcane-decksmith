import { useEffect, useMemo, useState } from "react";
import HistoryPanel from "../components/game/HistoryPanel";
import DeckPicker, { type DeckPickerResult } from "../components/game/DeckPicker";
import GameRoomPanel from "../components/game/GameRoomPanel";
import { getSession } from "../auth";
import { loadDecks } from "../db";
import {
  DEFAULT_GAME_WORKER_URL,
  GameApiError,
  createGameApi,
  normalizeRoomCode,
  type RoomFormat,
  type RoomInfo
} from "../gameClient";
import type { DeckRecord } from "../types";

const FORMAT_LABELS: Record<RoomFormat, string> = { standard: "Standard", commander: "Commander" };
const NO_DECK: DeckPickerResult = { deckId: null, ok: false };

export function gameWorkerUrl(): string {
  return (import.meta.env.VITE_GAME_WORKER_URL as string | undefined)?.trim() || DEFAULT_GAME_WORKER_URL;
}

/**
 * Online spielen: Raum mit Einladungscode erstellen oder beitreten. Ein Konto kann immer nur in einem Raum
 * sein. Das Deck wird auf dem Server streng geprüft (eigene Karten, Formatgültigkeit).
 */
export default function GamePage({ uid }: { uid: string }) {
  const baseUrl = gameWorkerUrl();
  const api = useMemo(() => createGameApi({ baseUrl, getToken: async () => (await getSession())?.accessToken ?? null }), [baseUrl]);

  const [decks, setDecks] = useState<DeckRecord[] | null>(null);
  const [roomCode, setRoomCode] = useState<string | null | undefined>(undefined); // undefined = lädt
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([loadDecks(uid), api.getMyRoom()])
      .then(([loadedDecks, room]) => {
        if (!active) return;
        setDecks(loadedDecks);
        setRoomCode(room?.code ?? null);
      })
      .catch(error => {
        if (active) setLoadError(error instanceof Error ? error.message : "Die Daten konnten nicht geladen werden.");
      });
    return () => {
      active = false;
    };
  }, [api, uid]);

  if (loadError) {
    return (
      <section>
        <div className="panel">
          <div className="error" role="alert">{loadError}</div>
        </div>
      </section>
    );
  }
  if (roomCode === undefined || decks === null) return <div className="loading">Spielbereich wird geladen …</div>;

  if (roomCode) {
    return (
      <GameRoomPanel
        code={roomCode}
        baseUrl={baseUrl}
        api={api}
        onLeft={message => {
          setNotice(message ?? "");
          setRoomCode(null);
        }}
      />
    );
  }

  return (
    <Lobby
      decks={decks}
      api={api}
      notice={notice}
      onEntered={code => {
        setNotice("");
        setRoomCode(code);
      }}
    />
  );
}

function Lobby({
  decks,
  api,
  notice,
  onEntered
}: {
  decks: DeckRecord[];
  api: ReturnType<typeof createGameApi>;
  notice: string;
  onEntered: (code: string) => void;
}) {
  // Raum erstellen
  const [format, setFormat] = useState<RoomFormat>("commander");
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [createDeck, setCreateDeck] = useState<DeckPickerResult>(NO_DECK);
  const [createError, setCreateError] = useState("");
  const [busy, setBusy] = useState(false);

  // Raum beitreten
  const [codeInput, setCodeInput] = useState("");
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [joinDeck, setJoinDeck] = useState<DeckPickerResult>(NO_DECK);
  const [joinError, setJoinError] = useState("");

  const describe = (error: unknown) => (error instanceof GameApiError ? error.message : "Die Aktion ist fehlgeschlagen.");

  const create = async () => {
    if (!createDeck.deckId || !createDeck.ok || busy) return;
    setBusy(true);
    setCreateError("");
    try {
      const result = await api.createRoom({ format, deckId: createDeck.deckId, ...(format === "commander" ? { maxPlayers } : {}) });
      onEntered(result.code);
    } catch (error) {
      if (error instanceof GameApiError && error.code) onEntered(error.code); // schon in einem Raum
      else setCreateError(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    setJoinError("");
    setInfo(null);
    setJoinDeck(NO_DECK);
    const code = normalizeRoomCode(codeInput);
    if (!code) {
      setJoinError("Bitte einen gültigen Einladungscode eingeben (4 bis 12 Buchstaben oder Ziffern).");
      return;
    }
    setBusy(true);
    try {
      setInfo(await api.getRoomInfo(code));
    } catch (error) {
      setJoinError(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (!info || !joinDeck.deckId || !joinDeck.ok || busy) return;
    setBusy(true);
    setJoinError("");
    try {
      const result = await api.joinRoom({ code: info.code, deckId: joinDeck.deckId });
      onEntered(result.code);
    } catch (error) {
      if (error instanceof GameApiError && error.code) onEntered(error.code);
      else setJoinError(describe(error));
    } finally {
      setBusy(false);
    }
  };

  const joinable = info && info.status === "open" && info.playerCount < info.maxPlayers;

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Online spielen</h2>
          <p className="muted">
            Spiele mit deinen eigenen Karten gegen andere Spieler. Dein Deck wird beim Betreten geprüft: Du brauchst alle
            Karten in deiner Sammlung (Basic Lands ausgenommen), und das Deck muss für das Format gültig sein.
          </p>
        </div>
      </div>

      {notice && <div className="notice" role="status">{notice}</div>}

      <div className="panel">
        <h3>Raum erstellen</h3>
        <label>
          Format
          <select value={format} onChange={event => setFormat(event.target.value as RoomFormat)} aria-label="Format">
            <option value="commander">Commander (2 bis 4 Spieler)</option>
            <option value="standard">Standard (2 Spieler)</option>
          </select>
        </label>
        {format === "commander" && (
          <label>
            Plätze
            <select value={maxPlayers} onChange={event => setMaxPlayers(Number(event.target.value))} aria-label="Plätze">
              {[2, 3, 4].map(n => (
                <option key={n} value={n}>{n} Spieler</option>
              ))}
            </select>
          </label>
        )}
        <DeckPicker decks={decks} format={format} api={api} onChange={setCreateDeck} />
        {createError && <div className="error" role="alert">{createError}</div>}
        <button type="button" className="primary" disabled={!createDeck.ok || busy} onClick={() => void create()}>
          Raum erstellen
        </button>
        <p className="muted">Der Einladungscode ist 24 Stunden gültig. Du kannst immer nur in einem Raum gleichzeitig sein.</p>
      </div>

      <div className="panel">
        <h3>Raum beitreten</h3>
        <form
          className="row"
          onSubmit={event => {
            event.preventDefault();
            void lookup();
          }}
        >
          <input
            value={codeInput}
            onChange={event => setCodeInput(event.target.value.toUpperCase())}
            maxLength={12}
            placeholder="Einladungscode"
            aria-label="Einladungscode"
          />
          <button type="submit" className="secondary" disabled={busy || !codeInput.trim()}>
            Raum suchen
          </button>
        </form>
        {joinError && <div className="error" role="alert">{joinError}</div>}

        {info && (
          <div>
            <p>
              <strong>{FORMAT_LABELS[info.format]}</strong>-Raum von <strong>{info.hostName}</strong> · {info.playerCount} von{" "}
              {info.maxPlayers} Plätzen belegt
              {info.status !== "open" && " · Spiel bereits gestartet"}
            </p>
            {joinable ? (
              <>
                <DeckPicker decks={decks} format={info.format} api={api} onChange={setJoinDeck} />
                <button type="button" className="primary" disabled={!joinDeck.ok || busy} onClick={() => void join()}>
                  Beitreten
                </button>
              </>
            ) : (
              <div className="error" role="alert">
                {info.status !== "open" ? "Das Spiel hat bereits begonnen." : "Der Raum ist voll."}
              </div>
            )}
          </div>
        )}
      </div>
      <HistoryPanel api={api} />
    </section>
  );
}
