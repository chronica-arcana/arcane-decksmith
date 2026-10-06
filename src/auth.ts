import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { ensureProfile } from "./db";

export type AppUser = { uid: string; email: string | null };
export type AuthState = { user: AppUser | null; loading: boolean };

const NOT_CONFIGURED = "Supabase ist noch nicht konfiguriert.";

function toUser(user: User | null | undefined): AppUser | null {
  return user ? { uid: user.id, email: user.email ?? null } : null;
}

export function subscribeAuth(cb: (state: AuthState) => void) {
  if (!supabase) {
    cb({ user: null, loading: false });
    return () => undefined;
  }
  cb({ user: null, loading: true });

  let profileUid: string | null = null;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    const user = toUser(session?.user);
    // Kein Supabase-Aufruf direkt im Callback (Deadlock-Gefahr): verzögert ausführen.
    if (user && user.uid !== profileUid) {
      profileUid = user.uid;
      setTimeout(() => { void ensureProfile(user.uid, user.email ?? undefined).catch(() => undefined); }, 0);
    }
    if (!user) profileUid = null;
    cb({ user, loading: false });
  });
  return () => data.subscription.unsubscribe();
}

export async function login(email: string, password: string) {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function logout() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Aktuelle Sitzung inklusive Access-Token (wird bei Bedarf automatisch erneuert). */
export async function getSession(): Promise<{ user: AppUser; accessToken: string } | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const session: Session | null = data.session;
  const user = toUser(session?.user);
  return session && user ? { user, accessToken: session.access_token } : null;
}

export function authMessage(error: unknown): string {
  const info = (error ?? {}) as { code?: string; name?: string; status?: number };
  if (info.name === "AuthRetryableFetchError" || info.status === 0) {
    return "Netzwerkfehler. Bitte Verbindung prüfen.";
  }
  const map: Record<string, string> = {
    validation_failed: "Bitte eine gültige E-Mail-Adresse eingeben.",
    email_address_invalid: "Bitte eine gültige E-Mail-Adresse eingeben.",
    invalid_credentials: "E-Mail oder Passwort ist nicht korrekt.",
    email_not_confirmed: "Diese E-Mail-Adresse ist noch nicht bestätigt. Bitte den Administrator kontaktieren.",
    over_request_rate_limit: "Zu viele Versuche. Bitte später erneut versuchen."
  };
  return map[info.code ?? ""] ?? "Die Anmeldung konnte nicht durchgeführt werden.";
}
