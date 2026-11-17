import { useState } from "react";
import type { GameLogLine } from "../../gameClient";

export type ChatApi = { lines: { id: number; text: string }[]; onSend: (text: string) => void; connected: boolean };

/** Seitenleiste links (optional): Chat und Spielverlauf. Sie verdeckt die Kartenvorschau nicht, die rechts erscheint. */
export default function ChatDrawer({ chat, log, tab, onTab, onClose }: { chat: ChatApi; log: GameLogLine[]; tab: "chat" | "log"; onTab: (tab: "chat" | "log") => void; onClose: () => void }) {
  const [text, setText] = useState("");
  return (
    <aside className="drawer" aria-label="Seitenleiste">
      <div className="drawer-head">
        <div className="drawer-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => onTab("chat")}>Chat</button>
          <button type="button" role="tab" aria-selected={tab === "log"} className={tab === "log" ? "on" : ""} onClick={() => onTab("log")}>Verlauf</button>
        </div>
        <button type="button" className="secondary" aria-label="Seitenleiste schließen" onClick={onClose}>✕</button>
      </div>
      {tab === "chat" ? (
        <>
          <ul className="drawer-lines" aria-label="Chat">
            {chat.lines.length === 0 && <li className="muted">Noch keine Nachrichten.</li>}
            {chat.lines.map(line => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
          <form
            className="drawer-form"
            onSubmit={event => {
              event.preventDefault();
              if (!text.trim()) return;
              chat.onSend(text);
              setText("");
            }}
          >
            <input value={text} onChange={event => setText(event.target.value)} placeholder="Nachricht" aria-label="Chat-Nachricht" />
            <button type="submit" className="secondary" disabled={!chat.connected}>Senden</button>
          </form>
        </>
      ) : (
        <ol className="drawer-lines" aria-label="Spielverlauf" reversed>
          {[...log].reverse().map(line => (
            <li key={line.n}>{line.text}</li>
          ))}
        </ol>
      )}
    </aside>
  );
}
