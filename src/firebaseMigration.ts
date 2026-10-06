import { BATCH_SIZE, cleanRecord, loadCollection, loadDecks, throwIfError, withRetry } from "./db";
import { loadDisplayName, saveDisplayName } from "./marketDb";
import { supabase } from "./supabase";
import type { CardRecord, DeckRecord } from "./types";

/**
 * Einmalige Übernahme der Daten aus dem alten Firebase-Konto in das Supabase-Konto.
 * Läuft komplett im Browser: Der Nutzer meldet sich mit seinem alten Firebase-Login an,
 * die App liest Sammlung/Decks (nur die eigenen) und schreibt sie in Supabase.
 * Das Firebase-Paket wird nur beim Öffnen des Dialogs nachgeladen.
 */

export type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
};

export type FirebaseExport = {
  cards: CardRecord[];
  decks: DeckRecord[];
  displayName: string;
};

export type FailedItem = { id: string; name: string; reason: string };
export type SectionReport = { found: number; written: number; skipped: number; failed: FailedItem[] };
export type MigrationReport = { cards: SectionReport; decks: SectionReport; displayNameCopied: boolean };
export type MigrationProgress = { phase: "cards" | "decks"; done: number; total: number };

/** Liest die Firebase-Web-Konfiguration aus eingefügtem Text (JS-Objekt oder JSON). */
export function parseFirebaseConfig(text: string): FirebaseConfig {
  const values: Record<string, string> = {};
  for (const match of text.matchAll(/["']?([A-Za-z]+)["']?\s*:\s*["']([^"']*)["']/g)) {
    values[match[1]] = match[2].trim();
  }
  const missing = ["apiKey", "authDomain", "projectId"].filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new Error(
      `In der eingefügten Konfiguration fehlen: ${missing.join(", ")}. ` +
      "Bitte den kompletten Block „firebaseConfig = { … }“ aus der Firebase Console kopieren."
    );
  }
  return {
    apiKey: values.apiKey,
    authDomain: values.authDomain,
    projectId: values.projectId,
    ...(values.storageBucket ? { storageBucket: values.storageBucket } : {}),
    ...(values.messagingSenderId ? { messagingSenderId: values.messagingSenderId } : {}),
    ...(values.appId ? { appId: values.appId } : {})
  };
}

/** Bestimmt, welche Einträge geschrieben werden (ohne vorhandene, außer bei „überschreiben“). */
export function planMigration<T extends { id?: unknown }>(
  incoming: T[],
  existingIds: ReadonlySet<string>,
  overwrite: boolean
): { toWrite: Array<T & { id: string }>; skipped: number } {
  const toWrite: Array<T & { id: string }> = [];
  let skipped = 0;
  for (const item of incoming) {
    if (typeof item.id !== "string" || !item.id) {
      skipped += 1;
      continue;
    }
    if (!overwrite && existingIds.has(item.id)) {
      skipped += 1;
      continue;
    }
    toWrite.push(item as T & { id: string });
  }
  return { toWrite, skipped };
}

export function firebaseErrorMessage(error: unknown): string {
  const code = String((error as { code?: string } | null)?.code ?? "");
  if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) {
    return "E-Mail oder Passwort des alten Firebase-Kontos stimmen nicht.";
  }
  if (code.includes("too-many-requests")) return "Zu viele Versuche. Bitte später erneut versuchen.";
  if (code.includes("network-request-failed")) return "Netzwerkfehler. Bitte Verbindung prüfen.";
  if (code.includes("invalid-api-key") || code.includes("api-key-not-valid")) {
    return "Der API-Schlüssel in der Konfiguration ist ungültig.";
  }
  if (code.includes("requests-from-referer") || code.includes("referer")) {
    return "Der Firebase-API-Schlüssel ist auf andere Webseiten beschränkt. In der Google Cloud Console unter " +
      "„APIs & Dienste → Anmeldedaten“ die Adresse dieser Seite als Referrer erlauben.";
  }
  if (code.includes("permission-denied")) {
    return "Firestore verweigert den Zugriff (Regeln). Wurde das Firebase-Projekt gelöscht oder sind die Regeln geändert?";
  }
  return error instanceof Error && error.message ? error.message : "Firebase konnte nicht gelesen werden.";
}

/** Meldet sich mit dem alten Konto an, liest die eigenen Daten und meldet sich wieder ab. */
export async function loadFromFirebase(
  config: FirebaseConfig,
  email: string,
  password: string
): Promise<FirebaseExport> {
  const [{ initializeApp, deleteApp }, authApi, firestoreApi] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore")
  ]);

  const app = initializeApp(config, `migration-${Date.now()}`);
  try {
    // Nichts im Browser speichern: die Anmeldung gilt nur für diesen Vorgang.
    const auth = authApi.initializeAuth(app, { persistence: authApi.inMemoryPersistence });
    const credential = await authApi.signInWithEmailAndPassword(auth, email.trim(), password);
    const uid = credential.user.uid;

    const db = firestoreApi.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
    const [cardSnap, deckSnap, profileSnap] = await Promise.all([
      firestoreApi.getDocs(firestoreApi.collection(db, "users", uid, "collection")),
      firestoreApi.getDocs(firestoreApi.collection(db, "users", uid, "decks")),
      firestoreApi.getDoc(firestoreApi.doc(db, "users", uid))
    ]);

    await authApi.signOut(auth);

    const displayName = profileSnap.exists() ? profileSnap.data().displayName : "";
    return {
      cards: cardSnap.docs.map((d) => ({ ...(d.data() as CardRecord), id: d.id })),
      decks: deckSnap.docs.map((d) => ({ ...(d.data() as DeckRecord), id: d.id })),
      displayName: typeof displayName === "string" ? displayName : ""
    };
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
}

type Row = Record<string, unknown>;

/** Schreibt Zeilen blockweise; schlägt ein Block fehl, werden die Zeilen einzeln versucht. */
async function writeRows(
  table: "collection_cards" | "decks",
  conflict: string,
  items: Array<{ id: string; name: string; row: Row }>,
  onProgress: (done: number) => void
): Promise<{ written: number; failed: FailedItem[] }> {
  const client = supabase;
  if (!client) throw new Error("Supabase ist nicht konfiguriert.");
  const failed: FailedItem[] = [];
  let written = 0;

  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const chunk = items.slice(start, start + BATCH_SIZE);
    try {
      await withRetry(async () => {
        const { error } = await client.from(table).upsert(chunk.map((item) => item.row), { onConflict: conflict });
        throwIfError(error);
      });
      written += chunk.length;
    } catch {
      for (const item of chunk) {
        const { error } = await client.from(table).upsert(item.row, { onConflict: conflict });
        if (error) failed.push({ id: item.id, name: item.name, reason: error.message });
        else written += 1;
      }
    }
    onProgress(Math.min(start + chunk.length, items.length));
  }
  return { written, failed };
}

export async function runMigration(options: {
  uid: string;
  data: FirebaseExport;
  overwrite: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrationReport> {
  const { uid, data, overwrite, onProgress } = options;

  const [existingCards, existingDecks] = await Promise.all([loadCollection(uid), loadDecks(uid)]);

  const cardPlan = planMigration(data.cards, new Set(existingCards.map((c) => c.id)), overwrite);
  const deckPlan = planMigration(data.decks, new Set(existingDecks.map((d) => d.id)), overwrite);

  const cardResult = await writeRows(
    "collection_cards",
    "user_id,card_id",
    cardPlan.toWrite.map((card) => ({
      id: card.id,
      name: card.name ?? card.id,
      row: { user_id: uid, card_id: card.id, data: cleanRecord(card) }
    })),
    (done) => onProgress?.({ phase: "cards", done, total: cardPlan.toWrite.length })
  );

  const deckResult = await writeRows(
    "decks",
    "user_id,deck_id",
    deckPlan.toWrite.map((deck) => ({
      id: deck.id,
      name: deck.name ?? deck.id,
      row: { user_id: uid, deck_id: deck.id, data: cleanRecord(deck) }
    })),
    (done) => onProgress?.({ phase: "decks", done, total: deckPlan.toWrite.length })
  );

  let displayNameCopied = false;
  if (data.displayName.trim()) {
    try {
      if (!(await loadDisplayName(uid)).trim()) {
        await saveDisplayName(uid, data.displayName.trim());
        displayNameCopied = true;
      }
    } catch {
      // Der Anzeigename ist optional und lässt sich später im Marketplace setzen.
    }
  }

  return {
    cards: { found: data.cards.length, written: cardResult.written, skipped: cardPlan.skipped, failed: cardResult.failed },
    decks: { found: data.decks.length, written: deckResult.written, skipped: deckPlan.skipped, failed: deckResult.failed },
    displayNameCopied
  };
}
