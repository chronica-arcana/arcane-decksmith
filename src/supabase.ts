import { createClient } from "@supabase/supabase-js";

const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();

export const supabaseConfigured = Boolean(url && anonKey);

/**
 * Supabase-Client (Auth + Postgres). Ohne Konfiguration bleibt er `null`;
 * die App läuft dann im lokalen Demo-Modus.
 *
 * PKCE statt Implicit-Flow: Bestätigungs- und Reset-Links kommen als `?code=…`
 * zurück. Die App nutzt Hash-Routing (`#/…`), ein Token im Hash würde kollidieren.
 */
export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;
