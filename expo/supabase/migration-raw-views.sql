-- ============================================================================
-- Raw view tracking: make posts.view_count real (was a dormant column)
-- ============================================================================
-- Investigation (live DB, 2026-09-29): NOTHING incremented posts.view_count —
-- zero functions reference it, no RPC exists, and every post's view_count is 0
-- even though post_qualified_views has 35 real rows. The column was added as
-- dormant in migration-survival-checkpoint.sql and stayed that way. The feed
-- displays it (eye icon) so it always showed 0.
--
-- Pattern: mirror the working qualified-view system
-- (post_qualified_views + sync_qualified_view_count trigger +
-- record_qualified_view RPC) but WITHOUT its two restrictions:
--   1. No 3-second watch requirement — fires on basic impression (the post
--      becomes the active, playing feed item).
--   2. No author exclusion — raw views include the author's own views.
--
-- DEDUPE DECISION (flagged in the report): raw views are deduped per
-- viewer/post via the primary key, same reusable dedupe pattern as qualified
-- views — scrolling back to a post never double-counts. If "every impression
-- counts" is wanted instead, drop the table/dedupe from this migration.
-- Idempotent: safe to re-run.
-- ============================================================================

-- 1. Per-viewer raw-view table (dedupe via primary key) ------------------------
create table if not exists public.post_raw_views (
  post_id    uuid not null references public.posts(id) on delete cascade,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);

alter table public.post_raw_views enable row level security;

drop policy if exists pv_raw_views_insert on public.post_raw_views;
create policy pv_raw_views_insert
  on public.post_raw_views
  for insert to authenticated
  with check (viewer_id = auth.uid());

-- 2. Denormalized counter maintenance --------------------------------------------
-- Fires only on real inserts; 'on conflict do nothing' never triggers it,
-- so a viewer can never double-count.
create or replace function public.sync_raw_view_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts
  set view_count = view_count + 1
  where id = new.post_id;
  return new;
end;
$$;

drop trigger if exists trg_sync_raw_view_count on public.post_raw_views;
create trigger trg_sync_raw_view_count
  after insert on public.post_raw_views
  for each row
  execute function public.sync_raw_view_count();

-- 3. RPC called by the client when the post becomes the active feed item ---------
-- Deliberately NO watch-duration gate and NO author exclusion (unlike
-- record_qualified_view): raw views are impressions, including the author's.
create or replace function public.record_raw_view(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  insert into public.post_raw_views (post_id, viewer_id)
  values (p_post_id, auth.uid())
  on conflict (post_id, viewer_id) do nothing;
end;
$$;

grant execute on function public.record_raw_view(uuid) to authenticated;
