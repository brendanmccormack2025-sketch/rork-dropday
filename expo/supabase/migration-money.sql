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
