import { useRef, useState, type ChangeEvent } from "react";
import { useDialogA11y } from "./useDialogA11y";
import {
  migrateAll,
  parseServiceAccount,
  readFirebase,
  resolveSupabaseUsers,
  type FirebaseSnapshot,
  type MigrationProgress,
  type MigrationReport,
  sumCopies,
  sumDeckCards,
  type SectionReport
} from "../firebaseMigration";
import "../importDialog.css";

type Step = "form" | "preview" | "running" | "done";

function sectionText(report: SectionReport, unit?: string): string {
  const parts = [`${report.written} von ${report.found} übernommen`];
  if (unit) parts[0] += ` (${report.copiesWritten} von ${report.copies} ${unit})`;
  if (report.skipped > 0) parts.push(`${report.skipped} übersprungen`);
  if (report.failed.length > 0) parts.push(`${report.failed.length} fehlgeschlagen`);
  return parts.join(", ");
}

export default function FirebaseMigrationDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("form");
  const [keyText, setKeyText] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<FirebaseSnapshot | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);

  // Während des Schreibens nicht per Escape schließen.
  useDialogA11y(dialogRef, onClose, { closeOnEscape: step !== "running" });

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) setKeyText(await file.text());
    event.target.value = "";
  };

  const read = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const account = parseServiceAccount(keyText);
      const loaded = await readFirebase(account, setStatus);
      setStatus("Ordne Konten in Supabase zu …");
      setSnapshot(await resolveSupabaseUsers(loaded));
      setKeyText("");
      setStep("preview");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Firebase konnte nicht gelesen werden.";
      setError(
        e instanceof TypeError
          ? "Die Verbindung zu Google wurde vom Browser blockiert oder ist nicht möglich (Netzwerk/CORS). " +
            "Bitte Verbindung prüfen und es erneut versuchen."
          : message
      );
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  const migrate = async () => {
    if (!snapshot || busy) return;
    setBusy(true);
    setError("");
    setStep("running");
    try {
      setReport(await migrateAll({ snapshot, overwrite, onProgress: setProgress }));
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Die Übernahme ist fehlgeschlagen.");
      setStep("preview");
    } finally {
      setBusy(false);
    }
  };

  const matched = snapshot?.users.filter((u) => u.supabaseId) ?? [];
  const unmatched = snapshot?.users.filter((u) => !u.supabaseId) ?? [];
  const totalCards = matched.reduce((sum, u) => sum + u.cards.length, 0);
  const totalCopies = matched.reduce((sum, u) => sum + sumCopies(u.cards), 0);
  const totalDecks = matched.reduce((sum, u) => sum + u.decks.length, 0);
  const totalDeckCards = matched.reduce((sum, u) => sum + sumDeckCards(u.decks), 0);
  const failed = report
    ? [...report.users.flatMap((u) => [...u.cards.failed, ...u.decks.failed]), ...report.listings.failed]
    : [];

  return (
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label="Firebase-Migration"
      >
        <div className="external-import-head">
          <div>
            <h2>Firebase-Migration (Admin)</h2>
            <p className="muted">
              Überträgt die Daten aller Nutzer von Firebase nach Supabase. Die Zuordnung erfolgt über die E-Mail-Adresse.
              Firebase wird nur gelesen. Der Schlüssel bleibt im Arbeitsspeicher und wird nicht gespeichert.
            </p>
          </div>
          <button className="secondary" type="button" onClick={onClose} disabled={step === "running"} aria-label="Schließen">×</button>
        </div>

        {step === "form" && (
          <div>
            <label>
              Firebase-Dienstkonto-Schlüssel (JSON-Datei)
              <input type="file" accept=".json,application/json" onChange={onFile} />
            </label>
            <label>
              … oder den Inhalt der Datei hier einfügen
              <textarea
                value={keyText}
                onChange={(e) => setKeyText(e.target.value)}
                rows={6}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder={'{\n  "type": "service_account",\n  "project_id": "…",\n  …\n}'}
              />
            </label>
            <p className="muted">
              Firebase Console → Zahnrad → Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“.
              Den Schlüssel danach in Firebase wieder löschen.
            </p>
            {busy && status && <p role="status" aria-live="polite">{status}</p>}
            {error && <div className="error" role="alert">{error}</div>}
            <button type="button" className="primary" onClick={read} disabled={busy || !keyText.trim()}>
              {busy ? "Lese Firebase …" : "Firebase lesen (noch nichts schreiben)"}
            </button>
          </div>
        )}

        {(step === "preview" || step === "running") && snapshot && (
          <div>
            <p>
              Projekt <strong>{snapshot.projectId}</strong>: <strong>{snapshot.users.length} Nutzer</strong> in Firebase,
              davon <strong>{matched.length}</strong> mit Supabase-Konto. Zu übertragen:
              {" "}<strong>{totalCards} Karten-Einträge</strong> (<strong>{totalCopies} Exemplare</strong> insgesamt),
              {" "}<strong>{totalDecks} Decks</strong> (<strong>{totalDeckCards} Karten</strong> in Decks)
              {" "}und <strong>{snapshot.listings.length} Marketplace-Angebote</strong>.
            </p>
            {!snapshot.authListLoaded && (
              <div className="notice" role="status">
                Die Firebase-Nutzerverwaltung konnte nicht gelesen werden; E-Mail-Adressen stammen aus den Profil-Daten
                und fehlen ggf. bei einzelnen Nutzern.
              </div>
            )}
            <table>
              <thead>
                <tr><th>E-Mail</th><th>Karten-Einträge</th><th>Exemplare</th><th>Decks</th><th>Supabase-Konto</th></tr>
              </thead>
              <tbody>
                {snapshot.users.map((u) => (
                  <tr key={u.firebaseUid}>
                    <td>{u.email || `(ohne E-Mail) ${u.firebaseUid}`}</td>
                    <td>{u.cards.length}</td>
                    <td>{sumCopies(u.cards)}</td>
                    <td>{u.decks.length}</td>
                    <td>{u.supabaseId ? "ja" : "nein – wird übersprungen"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unmatched.length > 0 && (
              <p className="muted">
                Nutzer ohne Supabase-Konto werden übersprungen (und deren Angebote auch). Konto zuerst anlegen und dann erneut lesen.
              </p>
            )}
            <p className="muted">
              „Karten-Einträge“ zählt jede Karte in jeder Druckversion einmal. „Exemplare“ ist die Summe aller
              Mengen und entspricht „Karten gesamt“ in der App.
            </p>
            <label>
              <input
                type="checkbox"
                checked={overwrite}
                disabled={step === "running"}
                onChange={(e) => setOverwrite(e.target.checked)}
              />{" "}
              Bereits vorhandene Einträge in Supabase überschreiben
            </label>
            <p className="muted">
              Ohne Haken bleibt unverändert, was in Supabase schon existiert (gleiche ID). Angebote werden immer neu geschrieben.
            </p>
            {step === "running" && progress && (
              <p role="status" aria-live="polite">
                Übertrage {progress.label} ({Math.min(progress.done + 1, progress.total)}/{progress.total}) …
              </p>
            )}
            {error && <div className="error" role="alert">{error}</div>}
            <button type="button" className="primary" onClick={migrate} disabled={busy || matched.length === 0}>
              {step === "running" ? "Übertrage …" : "Alles nach Supabase übertragen"}
            </button>
          </div>
        )}

        {step === "done" && report && (
          <div>
            <h3>Fertig</h3>
            <table>
              <thead>
                <tr><th>E-Mail</th><th>Karten-Einträge (Exemplare)</th><th>Decks (Karten darin)</th></tr>
              </thead>
              <tbody>
                {report.users.map((u) => (
                  <tr key={u.email}>
                    <td>{u.email}</td>
                    <td>{u.status === "ok" ? sectionText(u.cards, "Exemplaren") : "übersprungen (kein Supabase-Konto)"}</td>
                    <td>{u.status === "ok" ? sectionText(u.decks, "Karten") : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p><strong>Marketplace:</strong> {sectionText(report.listings)}</p>
            {failed.length > 0 && (
              <details>
                <summary>{failed.length} Einträge konnten nicht übernommen werden</summary>
                <ul>
                  {failed.slice(0, 100).map((item) => (
                    <li key={item.id}>{item.name}: {item.reason}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="muted">
              Nächste Schritte: Ergebnis prüfen, dann 02-migration-aufraeumen.sql ausführen und den Firebase-Schlüssel löschen.
            </p>
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              Fertig – App neu laden
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
