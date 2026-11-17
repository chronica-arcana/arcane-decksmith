/** Blendet beim Zugwechsel kurz ein, wer dran ist (reine CSS-Animation; ein neuer `key` startet sie neu). */
export default function TurnToast({ text }: { text: string }) {
  return (
    <div className="turn-toast" role="status" aria-live="polite">
      {text}
    </div>
  );
}
