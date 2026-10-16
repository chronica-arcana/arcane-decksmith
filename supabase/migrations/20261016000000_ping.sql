-- Keep-alive: Eine winzige, öffentlich aufrufbare Funktion, die die Datenbank wirklich anfragt.
-- Der GitHub-Workflow .github/workflows/keepalive.yml ruft sie täglich auf, damit das
-- Supabase-Projekt im Gratis-Tarif nicht wegen Inaktivität pausiert wird.
--
-- Ausführen: Supabase Dashboard → SQL Editor → New query → einfügen → Run (mehrfach ausführbar).
--
-- Die Funktion gibt nur { "ok": true, "at": <Zeitstempel> } zurück und verrät nichts über Daten
-- (die Tabelle wird nur angefragt, ihr Inhalt wird nicht ausgegeben).

create or replace function public.ping()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'at', now())
  from (select count(*) from (select 1 from public.market_listings limit 1) as touched) as t
$$;

revoke all on function public.ping() from public;
grant execute on function public.ping() to anon, authenticated;
