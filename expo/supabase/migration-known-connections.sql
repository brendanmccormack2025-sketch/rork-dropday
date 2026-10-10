-- Build in silence: people the creator knows never see (or influence) a post while it is on trial (idempotent).
-- Run AFTER migration-trial-engine.sql. Run manually in the Supabase SQL editor.
--
-- known_connections(user_id = creator, other_id = viewer) is the ONE place that says who knows whom. Sources today:
--   follow     a follow in either direction
--   contact    the creator's contacts contain the viewer's phone, or the viewer's contacts contain the creator's
--   hide_list  the creator's "Hide my trials from..." list (one direction: creator -> hidden person)
--   (friends from the messaging feature: just one more UNION ALL branch at the bottom of the view)
-- The engine and the feed only call trial_is_silenced() and never change when a source is added.
--
-- PRIVACY: phone numbers are UNVERIFIED and are used ONLY for this invisible exclusion. They are never shown to anyone,
-- never used for "your contact X is on Trial" or friend suggestions. Only HMAC-SHA256 hashes are stored (numbers are
-- hashed in the RPCs below with a secret pepper kept in Supabase Vault); the raw number is never stored or put in an
-- error message. Duplicate hashes are allowed (an unverified number can be claimed by several accounts).
--
-- SETUP (once): store the pepper in Vault, e.g. in the SQL editor
--   select vault.create_secret('<64+ random characters>', 'trial_contact_pepper');
-- Changing the pepper later invalidates every stored hash (users would re-enter / re-sync).

create extension if not exists pgcrypto with schema extensions;

-- Old follows (DropDay era) are ignored unless this is turned on; users cannot see or manage them in Trial.
alter table public.trial_engine_config add column if not exists known_source_follows boolean not null default false;

-- ── hashing ──────────────────────────────────────────────────────────────────
create or replace function public.trial_hash_phone(p_e164 text)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  pepper text;
begin
  if p_e164 is null or p_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid phone number' using errcode = '22023';   -- never echoes the value
  end if;
  select decrypted_secret into pepper from vault.decrypted_secrets where name = 'trial_contact_pepper' limit 1;
  if pepper is null or length(pepper) < 16 then
    raise exception 'contact pepper is not configured' using errcode = '55000';
  end if;
  return encode(hmac(p_e164, pepper, 'sha256'), 'hex');
end;
$$;

-- ── tables (RLS on; clients have no direct access except their own hide list) ─
create table if not exists public.user_phone_hash (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  hash       text not null,
  updated_at timestamptz not null default now()
);
create index if not exists user_phone_hash_hash_idx on public.user_phone_hash (hash);   -- NOT unique

create table if not exists public.contact_hashes (
  owner_id uuid not null references auth.users(id) on delete cascade,
  hash     text not null,
  primary key (owner_id, hash)
);
create index if not exists contact_hashes_hash_idx on public.contact_hashes (hash);

create table if not exists public.contact_sync_state (
  owner_id  uuid primary key references auth.users(id) on delete cascade,
  synced_at timestamptz not null default now(),
  n         integer not null default 0
);

create table if not exists public.hide_from_list (
  owner_id       uuid not null references auth.users(id) on delete cascade,
  hidden_user_id uuid not null references auth.users(id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (owner_id, hidden_user_id),
  check (owner_id <> hidden_user_id)
);

alter table public.user_phone_hash enable row level security;
alter table public.contact_hashes enable row level security;
alter table public.contact_sync_state enable row level security;
alter table public.hide_from_list enable row level security;
revoke all on table public.user_phone_hash, public.contact_hashes, public.contact_sync_state from anon, authenticated;
revoke all on table public.hide_from_list from anon;

-- the hide list: each user manages their own, and only they can read it
drop policy if exists hide_list_select on public.hide_from_list;
create policy hide_list_select on public.hide_from_list for select to authenticated using (owner_id = auth.uid());
drop policy if exists hide_list_insert on public.hide_from_list;
create policy hide_list_insert on public.hide_from_list for insert to authenticated with check (owner_id = auth.uid() and hidden_user_id <> auth.uid());
drop policy if exists hide_list_delete on public.hide_from_list;
create policy hide_list_delete on public.hide_from_list for delete to authenticated using (owner_id = auth.uid());
grant select, insert, delete on table public.hide_from_list to authenticated;

-- ── RPCs for the app ─────────────────────────────────────────────────────────
create or replace function public.set_my_phone(p_e164 text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into public.user_phone_hash (user_id, hash) values (auth.uid(), public.trial_hash_phone(p_e164))
  on conflict (user_id) do update set hash = excluded.hash, updated_at = now();
end;
$$;

create or replace function public.clear_my_phone()
returns void
language sql
security definer
set search_path = public
as $$ delete from public.user_phone_hash where user_id = auth.uid() $$;

-- Replaces the caller's contact hashes with the ones for these numbers (invalid entries are skipped, at most 10000).
create or replace function public.sync_my_contacts(p_numbers text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  delete from public.contact_hashes where owner_id = auth.uid();
  insert into public.contact_hashes (owner_id, hash)
  select distinct auth.uid(), public.trial_hash_phone(x.num)
  from (select num from unnest(p_numbers[1:10000]) as num where num ~ '^\+[1-9][0-9]{7,14}$') x
  on conflict do nothing;
  get diagnostics n = row_count;
  insert into public.contact_sync_state (owner_id, synced_at, n) values (auth.uid(), now(), n)
  on conflict (owner_id) do update set synced_at = now(), n = excluded.n;
  return n;
end;
$$;

create or replace function public.remove_my_contacts()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.contact_hashes where owner_id = auth.uid();
  delete from public.contact_sync_state where owner_id = auth.uid();
end;
$$;

-- Deletes everything this feature stores about the caller (also happens through the auth.users cascade on account deletion).
create or replace function public.delete_my_privacy_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.user_phone_hash where user_id = auth.uid();
  delete from public.contact_hashes where owner_id = auth.uid();
  delete from public.contact_sync_state where owner_id = auth.uid();
  delete from public.hide_from_list where owner_id = auth.uid();
end;
$$;

create or replace function public.my_privacy_status()
returns table (has_phone boolean, contacts_count integer, contacts_synced_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_phone_hash where user_id = auth.uid()),
         coalesce((select n from public.contact_sync_state where owner_id = auth.uid()), 0),
         (select synced_at from public.contact_sync_state where owner_id = auth.uid())
$$;

revoke all on function public.set_my_phone(text), public.clear_my_phone(), public.sync_my_contacts(text[]),
  public.remove_my_contacts(), public.delete_my_privacy_data(), public.my_privacy_status() from public, anon;
grant execute on function public.set_my_phone(text), public.clear_my_phone(), public.sync_my_contacts(text[]),
  public.remove_my_contacts(), public.delete_my_privacy_data(), public.my_privacy_status() to authenticated;

-- ── known_connections: one view, one UNION branch per source ─────────────────
create or replace view public.known_connections as
  -- follows, either direction
  select f.follower_id as user_id, f.followee_id as other_id, 'follow'::text as source from public.follows f
   where (select known_source_follows from public.trial_engine_config where id)
  union all
  select f.followee_id, f.follower_id, 'follow'::text from public.follows f
   where (select known_source_follows from public.trial_engine_config where id)
  union all
  -- contacts, either direction: the owner's contacts contain the other person's (unverified) phone hash
  select c.owner_id, p.user_id, 'contact'::text
    from public.contact_hashes c join public.user_phone_hash p on p.hash = c.hash and p.user_id <> c.owner_id
  union all
  select p.user_id, c.owner_id, 'contact'::text
    from public.contact_hashes c join public.user_phone_hash p on p.hash = c.hash and p.user_id <> c.owner_id
  union all
  -- the creator's own "hide my trials from" list (creator -> hidden person)
  select h.owner_id, h.hidden_user_id, 'hide_list'::text from public.hide_from_list h;
  -- union all select ... 'friend'::text from public.friends ...   (messaging feature: add the branch here)
revoke all on public.known_connections from anon, authenticated;

-- ── internals are not callable by apps (trial_is_silenced would be an oracle for "who knows whom") ─
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and (p.proname like 'trial\_%' or p.proname in ('run_trial_engine', 'record_view_progress_internal'))
      and p.proname not in ('trial_post_progress', 'trial_queue_position')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
  end loop;
end $$;
