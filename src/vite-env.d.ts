/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_IMPORT_PROXY_URL?: string;
  readonly VITE_AI_WORKER_URL?: string;
  readonly VITE_DECK_INTELLIGENCE_URL?: string;
  readonly VITE_SITE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
