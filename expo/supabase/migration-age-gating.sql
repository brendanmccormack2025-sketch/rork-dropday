-- Trial: Age-gating & mature-content filtering
-- Run this in the Supabase SQL editor.

-- ============================================================================
-- 1. profiles.birthdate (date of birth, nullable for backfill of existing rows)
-- ============================================================================
alter table public.profiles
  add column if not exists birthdate date;

-- ============================================================================
-- 2. posts.is_mature (boolean, default false)
-- ============================================================================
alter table public.posts
  add column if not exists is_mature boolean not null default false;

create index if not exists posts_is_mature_idx
  on public.posts (is_mature);

-- ============================================================================
-- 3. public.age_tier(birthdate) — returns 'under_13' | 'teen' | 'adult' | 'unknown'
-- ============================================================================
-- Returns 'unknown' when birthdate is NULL so callers can decide a safe default.
create or replace function public.age_tier(birthdate date)
returns text
language sql
immutable
as $$
  select case
    when birthdate is null then 'unknown'
    when age(birthdate) < interval '13 years' then 'under_13'
    when age(birthdate) < interval '18 years' then 'teen'
    else 'adult'
  end
$$;

grant execute on function public.age_tier(date) to anon, authenticated;
