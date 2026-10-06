-- Einmalige Datenübernahme Firebase → Supabase: Schreibrecht für DEIN Admin-Konto freigeben.
--
-- VOR DEM AUSFÜHREN: in der nächsten Zeile DEINE@EMAIL.DE durch die E-Mail-Adresse deines
-- Supabase-Kontos ersetzen (das Konto, mit dem du dich in der App anmeldest).
--
-- Ausführen: Supabase Dashboard → SQL Editor → New query → einfügen → Run.
-- Danach erscheint in der App (nach Neuladen) oben rechts der Button „Firebase-Migration“.
-- Nach der Übernahme unbedingt 02-migration-aufraeumen.sql ausführen.

create table if not exists arcane_private.migration_admin (user_id uuid primary key);
revoke all on arcane_private.migration_admin from anon, authenticated;

do $$
declare
  admin_email constant text := 'DEINE@EMAIL.DE';   -- <== hier ersetzen
begin
  if admin_email = 'DEINE@EMAIL.DE' then
    raise exception 'Bitte zuerst DEINE@EMAIL.DE durch deine eigene E-Mail-Adresse ersetzen.';
  end if;

  delete from arcane_private.migration_admin;
  insert into arcane_private.migration_admin (user_id)
    select id from auth.users where lower(email) = lower(admin_email);

  if not exists (select 1 from arcane_private.migration_admin) then
    raise exception 'Kein Supabase-Konto mit der E-Mail % gefunden. Zuerst in der App registrieren.', admin_email;
  end if;
end $$;

create or replace function arcane_private.is_migration_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from arcane_private.migration_admin where user_id = (select auth.uid()))
$$;

-- Von der App aufrufbar: Ist der angemeldete Nutzer der Migrations-Admin?
create or replace function public.migration_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select arcane_private.is_migration_admin()
$$;

-- Von der App aufrufbar (nur für den Admin): E-Mail → Supabase-Nutzer-ID.
create or replace function public.migration_user_ids(emails text[])
returns table (email text, id uuid) language sql stable security definer set search_path = '' as $$
  select lower(u.email)::text as email, u.id as id
  from auth.users u
  where arcane_private.is_migration_admin()
    and lower(u.email) = any (select lower(e) from unnest(emails) as e)
$$;

revoke all on function public.migration_is_admin() from public, anon;
revoke all on function public.migration_user_ids(text[]) from public, anon;
grant execute on function public.migration_is_admin() to authenticated;
grant execute on function public.migration_user_ids(text[]) to authenticated;
grant execute on function arcane_private.is_migration_admin() to authenticated;

-- Vorübergehend: Admin darf in allen vier Tabellen für alle Nutzer lesen/schreiben.
drop policy if exists migration_admin_all on public.profiles;
create policy migration_admin_all on public.profiles
  for all to authenticated
  using (arcane_private.is_migration_admin()) with check (arcane_private.is_migration_admin());

drop policy if exists migration_admin_all on public.collection_cards;
create policy migration_admin_all on public.collection_cards
  for all to authenticated
  using (arcane_private.is_migration_admin()) with check (arcane_private.is_migration_admin());

drop policy if exists migration_admin_all on public.decks;
create policy migration_admin_all on public.decks
  for all to authenticated
  using (arcane_private.is_migration_admin()) with check (arcane_private.is_migration_admin());

drop policy if exists migration_admin_all on public.market_listings;
create policy migration_admin_all on public.market_listings
  for all to authenticated
  using (arcane_private.is_migration_admin()) with check (arcane_private.is_migration_admin());
