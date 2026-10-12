-- ============================================================================
-- Views = everyone except the creator
-- ============================================================================
-- posts.view_count (raw views) used to include the author's own views (migration-raw-views.sql). The profile grid and the
-- post viewer's eye counter show this number, so it must be the viewers' views only. Idempotent.
-- Needs migration-raw-views.sql / migration-trial-engine.sql (post_raw_views, record_raw_view) to exist.

-- 1. The counter ignores the author, whatever path inserts the row ---------------------------------------------------
create or replace function public.sync_raw_view_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts
  set view_count = view_count + 1
  where id = new.post_id and user_id <> new.viewer_id;
  return new;
end;
$$;

-- 2. The impression RPC does not even store the author's view -----------------------------------------------------------
create or replace function public.record_raw_view(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then return; end if;
  insert into public.post_raw_views (post_id, viewer_id)
  values (p_post_id, auth.uid())
  on conflict (post_id, viewer_id) do nothing;
end;
$$;

grant execute on function public.record_raw_view(uuid) to authenticated;

-- 3. Backfill: drop the authors' rows, then recount from the rows (one row per viewer and post) ------------------------
delete from public.post_raw_views r
using public.posts p
where p.id = r.post_id and p.user_id = r.viewer_id;

update public.posts p
set view_count = c.n
from (
  select p2.id, (select count(*) from public.post_raw_views r where r.post_id = p2.id) as n
  from public.posts p2
) c
where c.id = p.id and p.view_count is distinct from c.n;
