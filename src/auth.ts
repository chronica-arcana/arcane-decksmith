import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { ensureProfile } from "./db";

export type AppUser = { uid: string; email: string | null };
export type AuthState = {
  user: AppUser | null;
  loading: boolean;
  /** true, solange der Nutzer über den Link aus der Passwort-Reset-Mail angemeldet ist. */
  recovery: boolean;
};

const NOT_CONFIGURED = "Supabase ist noch nicht konfiguriert.";

function toUser(user: User | null | undefined): AppUser | null {
  return user ? { uid: user.id, email: user.email ?? null } : null;
}

/** Ziel der Links in Bestätigungs- und Reset-Mails (muss in Supabase freigegeben sein). */
function redirectUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export function subscribeAuth(cb: (state: AuthState) => void) {
  if (!supabase) {
    cb({ user: null, loading: false, recovery: false });
    return () => undefined;
  }
  cb({ user: null, loading: true, recovery: false });

  let recovery = false;
  let profileUid: string | null = null;
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    const user = toUser(session?.user);
    if (event === "PASSWORD_RECOVERY") recovery = true;
    if (event === "SIGNED_OUT" || !user) recovery = false;
    // Kein Supabase-Aufruf direkt im Callback (Deadlock-Gefahr): verzögert ausführen.
    if (user && user.uid !== profileUid) {
      profileUid = user.uid;
      setTimeout(() => { void ensureProfile(user.uid, user.email ?? undefined).catch(() => undefined); }, 0);
    }
    if (!user) profileUid = null;
    cb({ user, loading: false, recovery });
  });
  return () => data.subscription.unsubscribe();
}

/** Registriert ein Konto. `needsConfirmation`: es wurde eine Bestätigungs-Mail verschickt. */
export async function register(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl() }
  });
  if (error) throw error;
  return { needsConfirmation: !data.session };
}

export async function login(email: string, password: string) {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function resetPassword(email: string) {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
  if (error) throw error;
}

/** Setzt ein neues Passwort für den aktuell (über den Reset-Link) angemeldeten Nutzer. */
export async function updatePassword(password: string) {
  if (!supabase) throw new Error(NOT_CONFIGURED);
  const { error } = await supabase.auth.updateUser({ password });
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
    email_not_confirmed: "Bitte zuerst die E-Mail-Adresse über den Link in der Bestätigungs-Mail bestätigen.",
    user_already_exists: "Diese E-Mail-Adresse ist bereits registriert.",
    email_exists: "Diese E-Mail-Adresse ist bereits registriert.",
    weak_password: "Das Passwort ist zu schwach (mindestens 6 Zeichen).",
    same_password: "Das neue Passwort muss sich vom bisherigen unterscheiden.",
    signup_disabled: "Neue Registrierungen sind derzeit deaktiviert.",
    over_request_rate_limit: "Zu viele Versuche. Bitte später erneut versuchen.",
    over_email_send_rate_limit: "Zu viele E-Mails angefordert. Bitte später erneut versuchen."
  };
  return map[info.code ?? ""] ?? "Die Anmeldung konnte nicht durchgeführt werden.";
}
