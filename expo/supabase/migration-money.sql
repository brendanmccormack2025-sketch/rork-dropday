-- Tryal Money tab (v1). Idempotent; last in MIGRATIONS_ORDER.txt, after migration-sanctions.sql. See PLAN-CLIPS.md.
-- Built one step at a time; each step appends its own section below and is safe to re-run.
--
--   STEP 1  the database feature flag and the STRICT adult check
--
-- Everything Money does is behind the flag 'money' (app_flags). It is OFF for everyone except the allow-listed testers (the owner).
-- The adult check is strict: a known birthdate and 18+. 'unknown' (no birthdate) is NOT adult here, unlike friends_is_minor() elsewhere.
-- The functions that look at other people's age or flag state are internal (revoked from apps): an app could otherwise ask
-- "is this user an adult?" about anybody. The app only calls my_features().

-- ── 1. feature flags ─────────────────────────────────────────────────────────────────────
create table if not exists public.app_flags (
  key            text primary key,
  enabled        boolean not null default false,
  allow_user_ids uuid[] not null default '{}',     -- testers: the flag is on for them while enabled = false
  updated_at     timestamptz not null default now()
);
alter table public.app_flags enable row level security;
revoke all on table public.app_flags from anon, authenticated;

-- 'money': off for everyone except the owner (constants/debug.ts OWNER_USER_ID). Re-running never resets a flag that was changed:
-- the row is only created when missing, and the owner is only ADDED to the allow-list.
insert into public.app_flags (key, enabled, allow_user_ids) values ('money', false, array['aee21757-1ded-41a7-9392-bddbf0d657df']::uuid[])
  on conflict (key) do update
    set allow_user_ids = (select array(select distinct u from unnest(public.app_flags.allow_user_ids || excluded.allow_user_ids) u))
    where not (excluded.allow_user_ids <@ public.app_flags.allow_user_ids);

create or replace function public.flag_on(p_key text, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null and coalesce((select f.enabled or p_user = any (f.allow_user_ids) from public.app_flags f where f.key = p_key), false)
$$;

-- ── 2. the strict adult check ─────────────────────────────────────────────────────────────
-- A known birthdate and age_tier = 'adult' (18+). No birthdate, a teen or an under-13 is never adult here.
create or replace function public.money_is_adult(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles p where p.id = p_user and p.birthdate is not null and public.age_tier(p.birthdate) = 'adult')
$$;

-- May this account use Money at all (browse, create, submit)? Flag on, adult, and not suspended or banned.
create or replace function public.money_allowed(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user is not null
     and public.flag_on('money', p_user)
     and public.money_is_adult(p_user)
     and not exists (select 1 from public.account_sanction_of(p_user))
$$;

-- What the app reads at launch:
--   money            show the tab at all (flag on, and not a KNOWN minor: a person with no birthdate yet still sees the tab so
--                    they can be asked for it on first visit; teens and under-13s never see it)
--   needs_birthdate  the flag is on for me and I have not given a birthdate: ask before anything else
--   allowed          I may actually use Money (money_allowed)
create or replace function public.my_features()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  bd date;
  has_profile boolean;
  on_flag boolean;
begin
  if me is null then
    return jsonb_build_object('money', false, 'needs_birthdate', false, 'allowed', false);
  end if;
  select p.birthdate, true into bd, has_profile from public.profiles p where p.id = me;
  on_flag := public.flag_on('money', me);
  return jsonb_build_object(
    'money', coalesce(on_flag and has_profile and not exists (select 1 from public.account_sanction_of(me)) and (bd is null or public.age_tier(bd) = 'adult'), false),
    'needs_birthdate', coalesce(on_flag and has_profile and bd is null, false),
    'allowed', public.money_allowed(me)
  );
end;
$$;

revoke all on function public.flag_on(text, uuid), public.money_is_adult(uuid), public.money_allowed(uuid) from public, anon, authenticated;
revoke all on function public.my_features() from public, anon;
grant execute on function public.my_features() to authenticated;

-- ══ STEP 2: birthdate collection and lock-down ═══════════════════════════════════════════
-- Money is 18+. The birthdate is collected at sign-up (new users) or on the first Money visit (existing users), then it is
-- (a) written only through set_my_birthdate / the sign-up trigger, never by a direct profile write, (b) set once: a person can
-- not move it later to become an adult, and (c) unreadable by other people once money_apply_birthdate_lockdown() has run.
-- That last part is deliberately NOT automatic: profiles is publicly readable with a table-wide select grant and builds 48/49
-- select `birthdate` from it, so revoking the column would break their profile load. Until the owner runs the lock-down, the
-- app never stores a birthdate (set_my_birthdate refuses, and the sign-up trigger ignores the one in the metadata), so a date
-- is never sitting in a publicly readable column.

alter table public.profiles add column if not exists birthdate_set_at timestamptz;

-- Who may write the birthdate column: the sign-up trigger and set_my_birthdate (a transaction-local flag they set), an admin,
-- and the service role / SQL editor (no JWT user). Everyone else: refused. A set date can only be changed by an admin.
create or replace function public.birthdate_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted boolean := coalesce(nullif(current_setting('tryal.birthdate_write', true), ''), '') = '1'
                     or auth.uid() is null
                     or public.mod_is_admin();
begin
  if tg_op = 'INSERT' then
    if new.birthdate is not null and not trusted then
      raise exception 'birthdate can only be set through the app flow' using errcode = '42501';
    end if;
    if new.birthdate is not null then new.birthdate_set_at := coalesce(new.birthdate_set_at, now()); end if;
    return new;
  end if;
  if new.birthdate is distinct from old.birthdate then
    if not trusted then
      raise exception 'birthdate can only be set through the app flow' using errcode = '42501';
    end if;
    if old.birthdate is not null and not (auth.uid() is null or public.mod_is_admin()) then
      raise exception 'birthdate is already set' using errcode = '42501';
    end if;
    new.birthdate_set_at := now();
  end if;
  if new.birthdate_set_at is distinct from old.birthdate_set_at and not (auth.uid() is null or public.mod_is_admin()) then
    new.birthdate_set_at := old.birthdate_set_at;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_birthdate_guard on public.profiles;
create trigger profiles_birthdate_guard
  before insert or update on public.profiles
  for each row execute function public.birthdate_write_guard();

-- Has the owner applied the lock-down? (a flag row, written only by money_apply_birthdate_lockdown)
insert into public.app_flags (key, enabled, allow_user_ids)
values ('birthdate_lockdown', false, '{}')
on conflict (key) do nothing;

-- Text -> date, or null when it is not a real calendar date (never raises).
create or replace function public.birthdate_parse(p text)
returns date
language plpgsql
immutable
as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then
  return null;
end;
$$;

-- A date that makes sense: not in the future, not before 1900.
create or replace function public.birthdate_is_valid(p date)
returns boolean
language sql
immutable
as $$ select p is not null and p <= current_date and p >= date '1900-01-01' $$;

-- The app calls this once, on the first Money visit. Returns the age tier ('under_13' | 'teen' | 'adult').
--   * refuses until the lock-down is applied (so the date is never publicly readable)
--   * refuses an invalid date, and a second set (only an admin can correct a date)
--   * stores the date even for a minor (a minor is then a known minor everywhere age_tier is used), but never lets Money open
create or replace function public.set_my_birthdate(p_birthdate date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cur date;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.app_flags where key = 'birthdate_lockdown' and enabled) then
    raise exception 'birthdate is not available yet' using errcode = '55000';
  end if;
  if not public.birthdate_is_valid(p_birthdate) then raise exception 'invalid birthdate' using errcode = '22007'; end if;
  select birthdate into cur from public.profiles where id = me;
  if not found then raise exception 'no profile' using errcode = 'P0002'; end if;
  if cur is not null then raise exception 'birthdate is already set' using errcode = '42501'; end if;
  perform set_config('tryal.birthdate_write', '1', true);
  update public.profiles set birthdate = p_birthdate where id = me;
  perform set_config('tryal.birthdate_write', '', true);
  return public.age_tier(p_birthdate);
end;
$$;

-- My own birthdate, for the client's age checks (the column itself is unreadable after the lock-down).
create or replace function public.my_birthdate()
returns date
language sql
stable
security definer
set search_path = public
as $$ select p.birthdate from public.profiles p where p.id = auth.uid() $$;

-- Sign-up: the profile row is created from the auth metadata. The metadata birthdate is copied only when the lock-down is applied
-- and the value is valid; otherwise it is ignored (the person is asked on their first Money visit instead). Same inserts as before.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  bd date;
begin
  if exists (select 1 from public.app_flags where key = 'birthdate_lockdown' and enabled) then
    bd := public.birthdate_parse(new.raw_user_meta_data->>'birthdate');
    if not public.birthdate_is_valid(bd) then bd := null; end if;
  end if;
  perform set_config('tryal.birthdate_write', '1', true);
  insert into public.profiles (id, username, display_name, birthdate)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'dropper_' || left(new.id::text, 8)),
    coalesce(new.raw_user_meta_data->>'username', 'dropper_' || left(new.id::text, 8)),
    bd
  )
  on conflict (id) do nothing;
  perform set_config('tryal.birthdate_write', '', true);
  return new;
end;
$$;

-- The owner's switch. Run it in the SQL editor ONLY once no build that selects `birthdate` from profiles is in use (48/49 do):
--   select public.money_apply_birthdate_lockdown();
-- It (1) copies a birthdate from the sign-up metadata onto profiles that have none, (2) takes the column away from anon and
-- authenticated (every other column stays readable, exactly as before), (3) turns the birthdate_lockdown flag on.
-- Re-run public.money_refresh_profile_grants() after ANY migration that adds a column to profiles (new columns are not granted).
create or replace function public.money_refresh_profile_grants()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles' and column_name not in ('birthdate', 'birthdate_set_at');
  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
  return cols;
end;
$$;

create or replace function public.money_apply_birthdate_lockdown()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  copied int := 0;
begin
  if auth.uid() is not null and not public.mod_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform set_config('tryal.birthdate_write', '1', true);
  with src as (
    select p.id, public.birthdate_parse(u.raw_user_meta_data->>'birthdate') as bd
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.birthdate is null
  ), upd as (
    update public.profiles p set birthdate = s.bd
    from src s where p.id = s.id and public.birthdate_is_valid(s.bd)
    returning 1
  )
  select count(*) into copied from upd;
  perform set_config('tryal.birthdate_write', '', true);
  perform public.money_refresh_profile_grants();
  update public.app_flags set enabled = true where key = 'birthdate_lockdown';
  return format('lockdown applied; %s birthdates copied from sign-up metadata', copied);
end;
$$;

revoke all on function public.birthdate_write_guard(), public.birthdate_is_valid(date), public.birthdate_parse(text), public.money_refresh_profile_grants(), public.money_apply_birthdate_lockdown() from public, anon, authenticated;
revoke all on function public.set_my_birthdate(date), public.my_birthdate() from public, anon;
grant execute on function public.set_my_birthdate(date), public.my_birthdate() to authenticated;
