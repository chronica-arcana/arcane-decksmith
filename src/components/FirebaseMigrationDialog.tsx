import { useRef, useState, type FormEvent } from "react";
import { useDialogA11y } from "./useDialogA11y";
import {
  firebaseErrorMessage,
  loadFromFirebase,
  parseFirebaseConfig,
  runMigration,
  type FirebaseExport,
  type MigrationProgress,
  type MigrationReport,
  type SectionReport
} from "../firebaseMigration";
import "../importDialog.css";

type Step = "form" | "loaded" | "running" | "done";

function ReportLine({ label, report }: { label: string; report: SectionReport }) {
  return (
    <li>
      <strong>{label}:</strong> {report.written} übernommen
      {report.skipped > 0 && `, ${report.skipped} übersprungen (bereits vorhanden)`}
      {report.failed.length > 0 && `, ${report.failed.length} fehlgeschlagen`}
      {` (in Firebase gefunden: ${report.found})`}
    </li>
  );
}

export default function FirebaseMigrationDialog({
  uid,
  onClose
}: {
  uid: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("form");
  const [config, setConfig] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<FirebaseExport | null>(null);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);

  // Während des Schreibens nicht per Escape schließen.
  useDialogA11y(dialogRef, onClose, { closeOnEscape: step !== "running" });

  const load = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const parsed = parseFirebaseConfig(config);
      const loaded = await loadFromFirebase(parsed, email, password);
      setPassword("");
      setData(loaded);
      setStep("loaded");
    } catch (e: unknown) {
      setError(firebaseErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const migrate = async () => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    setStep("running");
    try {
      const result = await runMigration({ uid, data, overwrite, onProgress: setProgress });
      setReport(result);
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Die Übernahme ist fehlgeschlagen.");
      setStep("loaded");
    } finally {
      setBusy(false);
    }
  };

  const failedItems = report ? [...report.cards.failed, ...report.decks.failed] : [];

  return (
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label="Daten aus Firebase übernehmen"
      >
        <div className="external-import-head">
          <div>
            <h2>Daten aus Firebase übernehmen</h2>
            <p className="muted">
              Einmalig: Sammlung und Decks aus deinem alten Konto in dieses Konto kopieren.
              Die Anmeldedaten werden nur für diesen Vorgang verwendet und nicht gespeichert.
            </p>
          </div>
          <button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={step === "running"}
            aria-label="Schließen"
          >
            ×
          </button>
        </div>

        {step === "form" && (
          <form onSubmit={load}>
            <label>
              Firebase-Konfiguration
              <textarea
                value={config}
                onChange={(e) => setConfig(e.target.value)}
                rows={8}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  authDomain: "….firebaseapp.com",\n  projectId: "…",\n  …\n};'}
                required
              />
              <span className="muted">
                Firebase Console → Zahnrad → Projekteinstellungen → Allgemein → Meine Apps → Konfig. Den Block kopieren und hier einfügen.
              </span>
            </label>
            <label>
              Altes Konto: E-Mail
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="off" required />
            </label>
            <label>
              Altes Konto: Passwort
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="off" required />
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <button type="submit" className="primary" disabled={busy || !config.trim() || !email || !password}>
              {busy ? "Lade aus Firebase…" : "Aus Firebase laden"}
            </button>
          </form>
        )}

        {(step === "loaded" || step === "running") && data && (
          <div>
            <p>
              In Firebase gefunden: <strong>{data.cards.length} Karten</strong> und <strong>{data.decks.length} Decks</strong>.
            </p>
            <label>
              <input
                type="checkbox"
                checked={overwrite}
                disabled={step === "running"}
                onChange={(e) => setOverwrite(e.target.checked)}
              />{" "}
              Bereits vorhandene Einträge mit gleicher ID überschreiben
            </label>
            <p className="muted">
              Ohne Haken bleiben Karten und Decks, die in diesem Konto schon existieren, unverändert.
              Marketplace-Angebote werden nicht übernommen; biete Karten dort einfach neu an.
            </p>
            {step === "running" && progress && (
              <p role="status" aria-live="polite">
                {progress.phase === "cards" ? "Karten" : "Decks"}: {progress.done}/{progress.total} …
              </p>
            )}
            {error && <div className="error" role="alert">{error}</div>}
            <button type="button" className="primary" onClick={migrate} disabled={busy}>
              {step === "running" ? "Übernehme …" : "In dieses Konto übernehmen"}
            </button>
          </div>
        )}

        {step === "done" && report && (
          <div>
            <h3>Fertig</h3>
            <ul>
              <ReportLine label="Karten" report={report.cards} />
              <ReportLine label="Decks" report={report.decks} />
              {report.displayNameCopied && <li><strong>Anzeigename</strong> übernommen</li>}
            </ul>
            {failedItems.length > 0 && (
              <details>
                <summary>{failedItems.length} Einträge konnten nicht übernommen werden</summary>
                <ul>
                  {failedItems.slice(0, 50).map((item) => (
                    <li key={item.id}>{item.name}: {item.reason}</li>
                  ))}
                </ul>
              </details>
            )}
            <button type="button" className="primary" onClick={() => window.location.reload()}>
              Fertig – Daten neu laden
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
