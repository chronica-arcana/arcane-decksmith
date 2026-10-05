-- Arcane Decksmith: Datenbankschema für Supabase (Ersatz für Firestore + firestore.rules).
--
-- Ausführen: Supabase Dashboard → SQL Editor → New query → Inhalt einfügen → Run
-- (oder per CLI: `supabase db push`). Das Skript ist mehrfach ausführbar.
--
-- Die Eingabeprüfung der alten Firestore-Regeln steckt jetzt in CHECK-Constraints
-- (Funktionen im Schema arcane_private), die Zugriffsrechte in Row Level Security.

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen für die Validierung (nicht über die API aufrufbar: eigenes Schema)
-- ---------------------------------------------------------------------------
create schema if not exists arcane_private;
grant usage on schema arcane_private to authenticated, service_role;

-- Pflichtfeld: String mit Länge min..max
create or replace function arcane_private.req_str(d jsonb, f text, min_len int, max_len int)
returns boolean language sql immutable as $$
  select coalesce(case when jsonb_typeof(d -> f) = 'string'
    then char_length(d ->> f) between min_len and max_len else false end, false)
$$;

-- Optionales Feld: fehlt oder String mit Länge <= max
create or replace function arcane_private.opt_str(d jsonb, f text, max_len int)
returns boolean language sql immutable as $$
  select coalesce(not (d ? f) or (case when jsonb_typeof(d -> f) = 'string'
    then char_length(d ->> f) <= max_len else false end), false)
$$;

create or replace function arcane_private.opt_num(d jsonb, f text)
returns boolean language sql immutable as $$
  select coalesce(not (d ? f) or jsonb_typeof(d -> f) = 'number', false)
$$;

create or replace function arcane_private.req_num(d jsonb, f text)
returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(d -> f) = 'number', false)
$$;

create or replace function arcane_private.req_arr(d jsonb, f text, max_len int)
returns boolean language sql immutable as $$
  select coalesce(case when jsonb_typeof(d -> f) = 'array'
    then jsonb_array_length(d -> f) <= max_len else false end, false)
$$;

create or replace function arcane_private.opt_arr(d jsonb, f text, max_len int)
returns boolean language sql immutable as $$
  select coalesce(not (d ? f) or (case when jsonb_typeof(d -> f) = 'array'
    then jsonb_array_length(d -> f) <= max_len else false end), false)
$$;

-- Ganze Zahl im Bereich min..max
create or replace function arcane_private.int_between(v jsonb, min_v numeric, max_v numeric)
returns boolean language sql immutable as $$
  select coalesce(case when jsonb_typeof(v) = 'number'
    then (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
         and (v #>> '{}')::numeric between min_v and max_v
    else false end, false)
$$;

create or replace function arcane_private.key_count(d jsonb)
returns int language sql immutable as $$
  select case when jsonb_typeof(d) = 'object' then (select count(*)::int from jsonb_object_keys(d)) else 2147483647 end
$$;

-- Sammlungseintrag
create or replace function arcane_private.valid_card(card_id text, d jsonb)
returns boolean language sql immutable as $$
  select coalesce(
    arcane_private.key_count(d) <= 40
    and d ->> 'id' = card_id
    and arcane_private.req_str(d, 'name', 1, 300)
    and arcane_private.req_str(d, 'set', 0, 20)
    and arcane_private.req_str(d, 'collectorNumber', 0, 20)
    and arcane_private.int_between(d -> 'count', 0, 100000)
    and jsonb_typeof(d -> 'foil') = 'boolean'
    and arcane_private.req_num(d, 'manaValue')
    and arcane_private.req_arr(d, 'colors', 6)
    and arcane_private.req_arr(d, 'colorIdentity', 6)
    and (not (d ? 'finishCounts') or (
      jsonb_typeof(d -> 'finishCounts') = 'object'
      and arcane_private.int_between(d -> 'finishCounts' -> 'nonfoil', 0, 1000000000)
      and arcane_private.int_between(d -> 'finishCounts' -> 'foil', 0, 1000000000)))
    and arcane_private.opt_str(d, 'comment', 2000)
    and arcane_private.opt_str(d, 'oracleText', 10000)
    and arcane_private.opt_str(d, 'typeLine', 300)
    and arcane_private.opt_str(d, 'location', 300)
    and arcane_private.opt_str(d, 'condition', 100)
    and arcane_private.opt_arr(d, 'tags', 50)
    and arcane_private.opt_num(d, 'priceEur')
    and arcane_private.opt_num(d, 'priceEurFoil'),
    false)
$$;

-- Deck (zusätzlich höchstens 1 MiB, wie das alte Firestore-Dokumentlimit)
create or replace function arcane_private.valid_deck(deck_id text, d jsonb)
returns boolean language sql immutable as $$
  select coalesce(
    arcane_private.key_count(d) <= 40
    and d ->> 'id' = deck_id
    and arcane_private.req_str(d, 'name', 0, 200)
    and d ->> 'format' in ('commander', 'standard')
    and arcane_private.req_arr(d, 'commanderIds', 2)
    and arcane_private.req_arr(d, 'cards', 500)
    and arcane_private.req_arr(d, 'sideboard', 200)
    and arcane_private.req_arr(d, 'colors', 6)
    and arcane_private.req_num(d, 'createdAt')
    and arcane_private.req_num(d, 'updatedAt')
    and arcane_private.opt_str(d, 'notes', 50000)
    and arcane_private.opt_arr(d, 'sourceCards', 700)
    and octet_length(d::text) <= 1048576,
    false)
$$;

-- Tauschangebot: ID = <ownerId>_<cardId>; Bilder nur von Scryfall.
create or replace function arcane_private.valid_listing(listing_id text, owner uuid, d jsonb)
returns boolean language sql immutable as $$
  select coalesce(
    arcane_private.key_count(d) <= 20
    and d ->> 'ownerId' = owner::text
    and arcane_private.req_str(d, 'cardId', 1, 80)
    and listing_id = (d ->> 'ownerId') || '_' || (d ->> 'cardId')
    and arcane_private.req_str(d, 'ownerName', 2, 30)
    and (d ->> 'ownerName') not like '%@%'
    and arcane_private.req_str(d, 'name', 1, 300)
    and arcane_private.req_str(d, 'nameLower', 0, 300)
    and arcane_private.req_str(d, 'set', 0, 20)
    and arcane_private.req_str(d, 'collectorNumber', 0, 20)
    and arcane_private.req_str(d, 'lang', 0, 10)
    and jsonb_typeof(d -> 'offered') = 'object'
    and arcane_private.int_between(d -> 'offered' -> 'nonfoil', 0, 1000)
    and arcane_private.int_between(d -> 'offered' -> 'foil', 0, 1000)
    and ((d -> 'offered' ->> 'nonfoil')::numeric + (d -> 'offered' ->> 'foil')::numeric) > 0
    and arcane_private.req_num(d, 'createdAt')
    and arcane_private.req_num(d, 'updatedAt')
    and arcane_private.opt_str(d, 'setName', 100)
    and arcane_private.opt_str(d, 'typeLine', 300)
    and (not (d ? 'imageUri') or (
      arcane_private.req_str(d, 'imageUri', 0, 500)
      and (d ->> 'imageUri') ~ '^https://cards[.]scryfall[.]io/.*'))
    and arcane_private.opt_num(d, 'priceEur')
    and arcane_private.opt_num(d, 'priceEurFoil'),
    false)
$$;

grant execute on all functions in schema arcane_private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

-- Profil (Anzeigename für den Marketplace). Nur der Besitzer kann es lesen.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null default '' check (char_length(email) <= 320),
  display_name text check (display_name is null or char_length(display_name) <= 40),
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

-- Sammlung: ein Eintrag je Karte, vollständiger Datensatz als JSON.
create table if not exists public.collection_cards (
  user_id uuid not null references auth.users (id) on delete cascade,
  card_id text not null check (char_length(card_id) between 1 and 200),
  data jsonb not null,
  primary key (user_id, card_id),
  constraint collection_cards_valid check (arcane_private.valid_card(card_id, data))
);

-- Decks
create table if not exists public.decks (
  user_id uuid not null references auth.users (id) on delete cascade,
  deck_id text not null check (char_length(deck_id) between 1 and 200),
  data jsonb not null,
  primary key (user_id, deck_id),
  constraint decks_valid check (arcane_private.valid_deck(deck_id, data))
);

-- Marketplace: für alle angemeldeten Spieler lesbar.
create table if not exists public.market_listings (
  id text primary key check (char_length(id) <= 200),
  owner_id uuid not null references auth.users (id) on delete cascade,
  data jsonb not null,
  name_lower text generated always as (data ->> 'nameLower') stored,
  updated_at_ms numeric generated always as ((data ->> 'updatedAt')::numeric) stored,
  constraint market_listings_valid check (arcane_private.valid_listing(id, owner_id, data))
);

create index if not exists market_listings_owner_idx on public.market_listings (owner_id);
create index if not exists market_listings_recent_idx on public.market_listings (updated_at_ms desc, id);
create index if not exists market_listings_name_idx on public.market_listings (name_lower, id);
create index if not exists market_listings_name_prefix_idx on public.market_listings (name_lower text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Zugriffsrechte: Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.collection_cards enable row level security;
alter table public.decks enable row level security;
alter table public.market_listings enable row level security;

revoke all on public.profiles, public.collection_cards, public.decks, public.market_listings from anon;
grant select, insert, update, delete
  on public.profiles, public.collection_cards, public.decks, public.market_listings
  to authenticated, service_role;

drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists collection_cards_own on public.collection_cards;
create policy collection_cards_own on public.collection_cards
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists decks_own on public.decks;
create policy decks_own on public.decks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists market_listings_read on public.market_listings;
create policy market_listings_read on public.market_listings
  for select to authenticated
  using (true);

drop policy if exists market_listings_insert on public.market_listings;
create policy market_listings_insert on public.market_listings
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists market_listings_update on public.market_listings;
create policy market_listings_update on public.market_listings
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists market_listings_delete on public.market_listings;
create policy market_listings_delete on public.market_listings
  for delete to authenticated
  using (owner_id = (select auth.uid()));
