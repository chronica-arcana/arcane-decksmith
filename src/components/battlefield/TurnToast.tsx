/** Blendet beim Zugwechsel kurz ein, wer dran ist (reine CSS-Animation; ein neuer `key` startet sie neu). */
export default function TurnToast({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="turn-toast" role="status" aria-live="polite">
      <span>{text}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}
