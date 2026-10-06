-- Nach der Datenübernahme: alle vorübergehenden Rechte und Hilfsfunktionen wieder entfernen.
-- Ausführen: Supabase Dashboard → SQL Editor → New query → einfügen → Run.
-- Das Skript ist mehrfach ausführbar.

drop policy if exists migration_admin_all on public.profiles;
drop policy if exists migration_admin_all on public.collection_cards;
drop policy if exists migration_admin_all on public.decks;
drop policy if exists migration_admin_all on public.market_listings;

drop function if exists public.migration_user_ids(text[]);
drop function if exists public.migration_is_admin();
drop function if exists arcane_private.is_migration_admin();
drop table if exists arcane_private.migration_admin;
