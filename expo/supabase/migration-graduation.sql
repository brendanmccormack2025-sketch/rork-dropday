-- Graduation MVP (idempotent).
--
-- A creator who has outgrown Trial is "graduated": a verified big creator who can no longer publish NEW posts to
-- Trial, but who keeps everything else (watching, likes, reactions, messages, follows). "restricted" is a neutral
-- posting block set by an administrator. Only the service role / SQL editor can change a status; clients cannot.
--
--   profiles.creator_status   'active' (default) | 'graduated' | 'restricted'
--   profiles.graduation_reason, graduated_at, graduated_by
--   profiles.instagram_url, tiktok_url, youtube_url   external links shown on a graduated profile (admin-set)
--   creator_status_audit      one row per status change (written by a trigger)
--
-- Enforcement (the app also checks, but THIS is what cannot be bypassed):
--   * posts: a BEFORE INSERT trigger and a RESTRICTIVE insert policy reject a ROOT post (parent_post_id is null)
--     from a graduated or restricted user. A reaction (parent_post_id set) is always allowed.
--   * group_posts (if the table exists): the same.
--   * Likes, follows, messages, reactions and reading are untouched. Existing posts keep their lifecycle.
--
-- Note: profiles are readable by everyone, so graduation_reason is readable too. Write reasons that are fine to be
-- public ("Reached 100k followers").
--
-- Run manually in the Supabase SQL editor. Safe to re-run. Rollback notes at the bottom.

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists creator_status text not null default 'active';
alter table public.profiles add column if not exists graduation_reason text;
alter table public.profiles add column if not exists graduated_at timestamptz;
alter table public.profiles add column if not exists graduated_by uuid;
alter table public.profiles add column if not exists instagram_url text;
alter table public.profiles add column if not exists tiktok_url text;
alter table public.profiles add column if not exists youtube_url text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_creator_status_check') then
    alter table public.profiles
      add constraint profiles_creator_status_check check (creator_status in ('active', 'graduated', 'restricted'));
  end if;
end $$;

-- ── 2. Audit table (no client access at all) ────────────────────────────────
create table if not exists public.creator_status_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  old_status text,
  new_status text not null,
  reason text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists creator_status_audit_user_idx on public.creator_status_audit (user_id, changed_at desc);
alter table public.creator_status_audit enable row level security;   -- no policies: only the service role / dashboard
revoke all on table public.creator_status_audit from anon, authenticated;

-- ── 3. Clients cannot touch the status or the graduation fields ─────────────
-- PostgREST runs client requests as the database role anon / authenticated; the SQL editor runs as postgres and the
-- service role as service_role. A trigger (not column privileges) is used because profiles has a table-wide UPDATE
-- grant that other migrations rely on.
create or replace function public.profiles_protect_creator_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;   -- administrator (SQL editor / service role)
  end if;
  if tg_op = 'INSERT' then
    new.creator_status := 'active';
    new.graduation_reason := null;
    new.graduated_at := null;
    new.graduated_by := null;
    new.instagram_url := null;
    new.tiktok_url := null;
    return new;
  end if;
  if new.creator_status is distinct from old.creator_status
     or new.graduation_reason is distinct from old.graduation_reason
     or new.graduated_at is distinct from old.graduated_at
     or new.graduated_by is distinct from old.graduated_by
     or new.instagram_url is distinct from old.instagram_url
     or new.tiktok_url is distinct from old.tiktok_url then
    raise exception 'creator status and graduation fields can only be changed by an administrator'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect_creator_fields on public.profiles;
create trigger profiles_protect_creator_fields
  before insert or update on public.profiles
  for each row execute function public.profiles_protect_creator_fields();

-- ── 4. Audit every status change ────────────────────────────────────────────
create or replace function public.profiles_audit_creator_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.creator_status_audit (user_id, old_status, new_status, reason, changed_by)
  values (new.id, old.creator_status, new.creator_status, new.graduation_reason, coalesce(new.graduated_by, auth.uid()));
  return new;
end;
$$;

drop trigger if exists profiles_audit_creator_status on public.profiles;
create trigger profiles_audit_creator_status
  after update of creator_status on public.profiles
  for each row
  when (old.creator_status is distinct from new.creator_status)
  execute function public.profiles_audit_creator_status();

-- ── 5. Posting enforcement ──────────────────────────────────────────────────
-- The status of a user, readable whatever RLS says (definer). Unknown user = 'active' (the FK fails elsewhere).
create or replace function public.creator_status_of(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select creator_status from public.profiles where id = uid), 'active');
$$;

-- BEFORE INSERT on posts / group_posts: a clear, mappable message for the app. Reactions are not root posts.
create or replace function public.enforce_creator_posting()
returns trigger
language plpgsql
as $$
declare
  st text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;   -- administrator / service role
  end if;
  -- (to_jsonb so the same function can run on tables without a parent_post_id column)
  if tg_table_name = 'posts' and (to_jsonb(new) ->> 'parent_post_id') is not null then
    return new;   -- a reaction: always allowed
  end if;
  st := public.creator_status_of(new.user_id);
  if st = 'graduated' then
    raise exception 'POSTING_GRADUATED: graduated creators can no longer post to Trial' using errcode = 'P0001';
  elsif st = 'restricted' then
    raise exception 'POSTING_RESTRICTED: posting is currently restricted for this account' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_creator_posting on public.posts;
create trigger enforce_creator_posting
  before insert on public.posts
  for each row execute function public.enforce_creator_posting();

-- The insert policy itself (restrictive = ANDed with whatever permissive insert policies exist).
drop policy if exists "creator status gate (posts)" on public.posts;
create policy "creator status gate (posts)"
  on public.posts
  as restrictive
  for insert
  to authenticated
  with check (parent_post_id is not null or public.creator_status_of(user_id) = 'active');

do $$
begin
  if to_regclass('public.group_posts') is not null then
    execute 'drop trigger if exists enforce_creator_posting on public.group_posts';
    execute 'create trigger enforce_creator_posting before insert on public.group_posts for each row execute function public.enforce_creator_posting()';
    execute 'drop policy if exists "creator status gate (group posts)" on public.group_posts';
    execute 'create policy "creator status gate (group posts)" on public.group_posts as restrictive for insert to authenticated with check (public.creator_status_of(user_id) = ''active'')';
  end if;
end $$;

-- ── 6. Administrator functions (service role / SQL editor only) ─────────────
create or replace function public.admin_set_creator_status(
  p_username text,
  p_status text,
  p_reason text,
  p_admin uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
begin
  if p_status not in ('active', 'graduated', 'restricted') then
    raise exception 'status must be active, graduated or restricted';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required';
  end if;
  select id into uid from public.profiles where lower(username) = lower(btrim(p_username));
  if uid is null then
    raise exception 'no user named %', p_username;
  end if;
  update public.profiles
     set creator_status = p_status,
         graduation_reason = btrim(p_reason),
         graduated_at = case when p_status = 'graduated' then now() else null end,
         graduated_by = p_admin
   where id = uid;
  return format('%s is now %s (%s)', p_username, p_status, btrim(p_reason));
end;
$$;

create or replace function public.admin_set_creator_links(
  p_username text,
  p_instagram text default null,   -- null = leave as is, '' = clear
  p_tiktok text default null,
  p_youtube text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
begin
  if p_instagram is not null and p_instagram <> '' and p_instagram !~* '^https://([a-z0-9-]+\.)*instagram\.com(/|$)' then
    raise exception 'instagram link must be an https instagram.com URL';
  end if;
  if p_tiktok is not null and p_tiktok <> '' and p_tiktok !~* '^https://([a-z0-9-]+\.)*tiktok\.com(/|$)' then
    raise exception 'tiktok link must be an https tiktok.com URL';
  end if;
  if p_youtube is not null and p_youtube <> '' and p_youtube !~* '^https://([a-z0-9-]+\.)*(youtube\.com|youtu\.be)(/|$)' then
    raise exception 'youtube link must be an https youtube.com or youtu.be URL';
  end if;
  select id into uid from public.profiles where lower(username) = lower(btrim(p_username));
  if uid is null then
    raise exception 'no user named %', p_username;
  end if;
  update public.profiles
     set instagram_url = case when p_instagram is null then instagram_url when p_instagram = '' then null else p_instagram end,
         tiktok_url    = case when p_tiktok is null then tiktok_url when p_tiktok = '' then null else p_tiktok end,
         youtube_url   = case when p_youtube is null then youtube_url when p_youtube = '' then null else p_youtube end
   where id = uid;
  return format('links updated for %s', p_username);
end;
$$;

revoke all on function public.admin_set_creator_status(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_set_creator_links(text, text, text, text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.admin_set_creator_status(text, text, text, uuid) to service_role;
    grant execute on function public.admin_set_creator_links(text, text, text, text) to service_role;
  end if;
end $$;

-- Rollback (comment):
--   drop policy if exists "creator status gate (posts)" on public.posts;
--   drop trigger if exists enforce_creator_posting on public.posts;
--   drop trigger if exists profiles_protect_creator_fields on public.profiles;
--   drop trigger if exists profiles_audit_creator_status on public.profiles;
--   -- columns and the audit table are kept (no data loss).
