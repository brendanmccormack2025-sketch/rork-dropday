-- Tryal Money: SEGMENTED FOOTAGE. Idempotent; applied AFTER migration-money-footage.sql
-- (one paste: supabase/apply-money-preview.sql has all five Money-preview files in order).
--
-- A long video is uploaded as ~1-minute SEGMENTS (each its own small MP4), so:
--   * the phone cuts segment N+1 while segment N uploads (compression and upload overlap),
--   * a campaign can be posted as soon as every video has its FIRST segment uploaded (status 'partial'); the rest keeps uploading,
--   * a clipper previews by streaming segments and, for a marked section of up to ~3 minutes, downloads only the segments that cover it.
-- The segment table is the manifest (order, start and end time, size, state). The server decides the plan (how many segments, which times) so the
-- phone and the database always agree. Video status: uploading -> partial (>= 1 segment ready) -> ready (all ready). A video that stops getting
-- segments for 3 days is marked stalled and its creator is told (in-app). Deletion, reports, account deletion and the owner's totals cover segments.

-- ══ 1. config ═════════════════════════════════════════════════════════════════════════════════
alter table public.money_config add column if not exists segment_seconds integer not null default 60 check (segment_seconds between 10 and 300);
alter table public.money_config add column if not exists footage_stall_days integer not null default 3 check (footage_stall_days >= 1);

-- ══ 2. videos: segment counters, progress time, stalled flag, the 'partial' status ═══════════════
alter table public.campaign_footage add column if not exists segment_seconds integer;
alter table public.campaign_footage add column if not exists segment_count integer not null default 1;
alter table public.campaign_footage add column if not exists segments_ready integer not null default 0;
alter table public.campaign_footage add column if not exists last_progress_at timestamptz not null default now();
alter table public.campaign_footage add column if not exists stalled_at timestamptz;
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.campaign_footage'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table public.campaign_footage drop constraint %I', c.conname);
  end loop;
  alter table public.campaign_footage add constraint campaign_footage_status_check check (status in ('uploading', 'partial', 'ready', 'failed', 'deleted', 'hidden'));
end $$;
-- a video registered the old way (one whole file) is one segment that is already as ready as the video itself
update public.campaign_footage set segments_ready = 1 where segment_seconds is null and status in ('ready', 'hidden') and segments_ready = 0;

-- ══ 3. the segments (= the manifest) ══════════════════════════════════════════════════════════
create table if not exists public.campaign_footage_segments (
  footage_id   uuid not null references public.campaign_footage(id) on delete cascade,
  idx          integer not null check (idx >= 0),
  start_s      numeric(8,2) not null check (start_s >= 0),
  end_s        numeric(8,2) not null check (end_s > start_s),
  storage_path text not null unique,                    -- <creator id>/<video id>/seg-000.mp4
  size_bytes   bigint check (size_bytes is null or size_bytes > 0),
  status       text not null default 'uploading' check (status in ('uploading', 'ready')),
  ready_at     timestamptz,
  primary key (footage_id, idx)
);
alter table public.campaign_footage_segments enable row level security;
revoke all on table public.campaign_footage_segments from anon, authenticated;
grant select on public.campaign_footage_segments to authenticated;
drop policy if exists footage_segments_read on public.campaign_footage_segments;
create policy footage_segments_read on public.campaign_footage_segments for select to authenticated using (
  exists (select 1 from public.campaign_footage f where f.id = footage_id and (
    public.money_admin_me()
    or (public.money_ready_me() and f.status <> 'deleted' and (
          f.creator_id = auth.uid()
          or (f.campaign_id is not null and f.status in ('partial', 'ready') and public.money_is_member_me(f.campaign_id) and not public.money_blocked_with_me(f.creator_id)))))));

-- the video rows: members see partial videos too
drop policy if exists footage_read on public.campaign_footage;
create policy footage_read on public.campaign_footage for select to authenticated using (
  public.money_admin_me()
  or (public.money_ready_me() and status <> 'deleted' and (
        creator_id = auth.uid()
        or (campaign_id is not null and status in ('partial', 'ready') and public.money_is_member_me(campaign_id) and not public.money_blocked_with_me(creator_id)))));
grant select (segment_seconds, segment_count, segments_ready, last_progress_at, stalled_at) on public.campaign_footage to authenticated;

-- hidden / failed / deleted videos: every segment file goes to the delete queue (the delete-media function removes them), however the status was reached
create or replace function public.footage_enqueue_segments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare vid uuid := case when tg_op = 'DELETE' then old.id else new.id end;
begin
  insert into public.trial_media_delete_queue (post_id, bucket, path)
    select vid, 'campaign-footage', s.storage_path from public.campaign_footage_segments s where s.footage_id = vid on conflict do nothing;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
drop trigger if exists footage_enqueue_segments_status on public.campaign_footage;
create trigger footage_enqueue_segments_status after update of status on public.campaign_footage
  for each row when (new.status in ('deleted', 'failed') and old.status is distinct from new.status) execute function public.footage_enqueue_segments();
drop trigger if exists footage_enqueue_segments_delete on public.campaign_footage;
create trigger footage_enqueue_segments_delete before delete on public.campaign_footage
  for each row execute function public.footage_enqueue_segments();

-- minutes still count while a video is partial or hidden (the guard of migration-money-footage.sql, with 'partial' added)
create or replace function public.money_footage_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.money_config;
  c public.campaigns;
  used numeric;
  n integer;
begin
  select * into cfg from public.money_config;
  perform pg_advisory_xact_lock(hashtextextended('money_footage:' || new.creator_id::text, 0));
  if auth.uid() is not null then
    if not public.money_ready(new.creator_id) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
    if public.money_role_of(new.creator_id) not in ('creator', 'both') then raise exception 'pick the creator role to add footage' using errcode = '42501'; end if;
  end if;
  if new.duration_seconds > cfg.max_footage_seconds_each then
    raise exception 'each video can be at most % minutes', cfg.max_footage_seconds_each / 60 using errcode = '22023';
  end if;
  if new.size_bytes > cfg.max_footage_bytes then raise exception 'that video file is too large' using errcode = '22023'; end if;
  if new.campaign_id is not null then
    select * into c from public.campaigns where id = new.campaign_id;
    if not found or c.creator_id <> new.creator_id then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
    if c.terms_frozen_at is not null and auth.uid() is not null then raise exception 'footage is frozen once the first clipper has joined' using errcode = '42501'; end if;
  end if;
  select coalesce(sum(duration_seconds), 0), count(*) into used, n from public.campaign_footage
   where creator_id = new.creator_id and campaign_id is not distinct from new.campaign_id and status in ('uploading', 'partial', 'ready', 'hidden');
  if used + new.duration_seconds > cfg.max_footage_seconds_total then
    raise exception 'a campaign can have at most % minutes of footage', cfg.max_footage_seconds_total / 60 using errcode = '22023';
  end if;
  if new.campaign_id is null and n >= cfg.max_draft_footage then raise exception 'too many videos at once' using errcode = '22023'; end if;
  return new;
end;
$$;

-- ══ 4. what the app calls ═════════════════════════════════════════════════════════════════════
-- Register a video and get the PLAN: the thumbnail path and one row per segment (index, start, end, path). The phone cuts exactly these times.
create or replace function public.money_footage_register_segmented(p_duration_seconds numeric, p_width integer, p_height integer)
returns table (id uuid, thumb_path text, segment_seconds integer, idx integer, start_s numeric, end_s numeric, path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  fid uuid := gen_random_uuid();
  seg integer := (select c.segment_seconds from public.money_config c);
  dur numeric := round(p_duration_seconds, 2);
  n integer;
begin
  if dur is null or dur <= 0 then raise exception 'that video has no length' using errcode = '22023'; end if;
  n := ceil(dur / seg)::integer;
  insert into public.campaign_footage (id, creator_id, storage_path, thumb_path, duration_seconds, width, height, size_bytes, segment_seconds, segment_count)
  values (fid, me, me::text || '/' || fid::text || '/manifest', me::text || '/' || fid::text || '.jpg', dur, p_width, p_height, 1, seg, n);
  insert into public.campaign_footage_segments (footage_id, idx, start_s, end_s, storage_path)
    select fid, i, (i * seg)::numeric, least(((i + 1) * seg)::numeric, dur), me::text || '/' || fid::text || '/seg-' || lpad(i::text, 3, '0') || '.mp4'
      from generate_series(0, n - 1) i;
  return query select fid, f.thumb_path, seg, s.idx, s.start_s, s.end_s, s.storage_path
                 from public.campaign_footage f join public.campaign_footage_segments s on s.footage_id = f.id where f.id = fid order by s.idx;
end;
$$;

-- One segment finished uploading: check the object is really there at that size, mark it ready, move the video to 'partial' (first segment) or
-- 'ready' (last). Allowed after the terms froze: the segments of a registered video keep arriving.
create or replace function public.money_segment_complete(p_footage uuid, p_idx integer, p_size bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  f public.campaign_footage;
  s public.campaign_footage_segments;
  sz bigint;
  cfg public.money_config;
  ready_n integer;
  total_bytes bigint;
  new_status text;
begin
  select * into cfg from public.money_config;
  select * into f from public.campaign_footage where id = p_footage and creator_id = me for update;
  if not found then raise exception 'unknown video' using errcode = 'P0002'; end if;
  if f.status in ('failed', 'deleted') then raise exception 'this video cannot be completed' using errcode = '42501'; end if;
  select * into s from public.campaign_footage_segments where footage_id = p_footage and idx = p_idx for update;
  if not found then raise exception 'unknown segment' using errcode = 'P0002'; end if;
  if s.status = 'ready' then return f.status; end if;
  if p_size is null or p_size <= 0 or p_size > cfg.max_footage_bytes then raise exception 'that segment is too large' using errcode = '22023'; end if;
  select (o.metadata ->> 'size')::bigint into sz from storage.objects o where o.bucket_id = 'campaign-footage' and o.name = s.storage_path;
  if sz is null or sz <> p_size then raise exception 'the upload is not complete yet' using errcode = '55000'; end if;
  update public.campaign_footage_segments set status = 'ready', size_bytes = p_size, ready_at = now() where footage_id = p_footage and idx = p_idx;
  select count(*), coalesce(sum(size_bytes), 0) into ready_n, total_bytes from public.campaign_footage_segments where footage_id = p_footage and status = 'ready';
  new_status := case when f.status = 'hidden' then 'hidden' when ready_n >= f.segment_count then 'ready' else 'partial' end;
  perform set_config('tryal.footage_write', '1', true);
  update public.campaign_footage
     set segments_ready = ready_n, size_bytes = greatest(total_bytes, 1), last_progress_at = now(), stalled_at = null, status = new_status,
         ready_at = case when new_status = 'ready' then now() else ready_at end,
         thumb_ok = thumb_ok or exists (select 1 from storage.objects o where o.bucket_id = 'campaign-footage' and o.name = f.thumb_path)
   where id = p_footage;
  perform set_config('tryal.footage_write', '', true);
  return new_status;
end;
$$;

-- the thumbnail is uploaded before the first segment: tell the database it is there (best effort; the video does not depend on it)
-- (money_segment_complete also checks for it)

-- ══ 5. who may put a file in the bucket and who may read it: now with segments ═════════════════
create or replace function public.money_footage_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.money_ready(auth.uid())
     and (exists (select 1 from public.campaign_footage f
                   where f.creator_id = auth.uid() and f.status = 'uploading' and (f.storage_path = p_name or f.thumb_path = p_name))
          or exists (select 1 from public.campaign_footage_segments s join public.campaign_footage f on f.id = s.footage_id
                      where s.storage_path = p_name and s.status = 'uploading' and f.creator_id = auth.uid() and f.status in ('uploading', 'partial'))
          or exists (select 1 from public.campaign_footage f
                      where f.creator_id = auth.uid() and f.status in ('uploading', 'partial') and f.thumb_path = p_name))
$$;

create or replace function public.money_footage_read_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
    public.mod_is_admin()
    or (public.money_ready(auth.uid()) and (
         exists (select 1 from public.campaign_footage f
                  where (f.storage_path = p_name or f.thumb_path = p_name) and f.status in ('uploading', 'partial', 'ready')
                    and (f.creator_id = auth.uid()
                         or (f.status in ('partial', 'ready') and f.campaign_id is not null
                             and exists (select 1 from public.campaign_members m where m.campaign_id = f.campaign_id and m.clipper_id = auth.uid())
                             and not exists (select 1 from public.user_blocks b where (b.blocker_id = f.creator_id and b.blocked_id = auth.uid())
                                                                                   or (b.blocker_id = auth.uid() and b.blocked_id = f.creator_id)))))
         or exists (select 1 from public.campaign_footage_segments s join public.campaign_footage f on f.id = s.footage_id
                     where s.storage_path = p_name and f.status in ('uploading', 'partial', 'ready')
                       and (f.creator_id = auth.uid()
                            or (s.status = 'ready' and f.status in ('partial', 'ready') and f.campaign_id is not null
                                and exists (select 1 from public.campaign_members m where m.campaign_id = f.campaign_id and m.clipper_id = auth.uid())
                                and not exists (select 1 from public.user_blocks b where (b.blocker_id = f.creator_id and b.blocked_id = auth.uid())
                                                                                      or (b.blocker_id = auth.uid() and b.blocked_id = f.creator_id))))))))
$$;

-- ══ 6. posting a campaign: videos that have their first segment (partial) count ═════════════════
drop function if exists public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[], text);
create or replace function public.money_create_campaign_with_footage(
  p_title text, p_description text, p_full_video_url text, p_rate_per_1k numeric, p_cap_per_clip numeric, p_total_budget numeric,
  p_guaranteed_per_clip numeric, p_platforms text[], p_view_window_days integer, p_min_views integer, p_payment_method text,
  p_payment_handle text, p_deadline timestamptz, p_max_clips_per_clipper integer, p_agree boolean, p_footage_ids uuid[],
  p_footage_url text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  cid uuid;
  want uuid[] := (select array_agg(distinct x) from unnest(coalesce(p_footage_ids, '{}')) x);
  have integer;
  link text := nullif(btrim(coalesce(p_footage_url, '')), '');
begin
  if p_agree is not true then raise exception 'accept the Campaign Agreement to post' using errcode = '22023'; end if;
  if (want is null or cardinality(want) = 0) and link is null then raise exception 'add at least one video or a footage link' using errcode = '22023'; end if;
  if want is not null and cardinality(want) > 0 then
    perform 1 from public.campaign_footage where id = any (want) and creator_id = me for update;
    select count(*) into have from public.campaign_footage where id = any (want) and creator_id = me and campaign_id is null and status in ('partial', 'ready');
    if have <> cardinality(want) then raise exception 'some videos are missing or have not started uploading' using errcode = '55000'; end if;
  end if;
  insert into public.campaigns (creator_id, title, description, footage_url, full_video_url, rate_per_1k, cap_per_clip, total_budget, guaranteed_per_clip,
                                platforms, view_window_days, min_views, payment_method, payment_handle, deadline, max_clips_per_clipper, agreement_version)
  values (me, p_title, p_description, link, nullif(btrim(coalesce(p_full_video_url, '')), ''), p_rate_per_1k, p_cap_per_clip, p_total_budget, coalesce(p_guaranteed_per_clip, 0),
          p_platforms, coalesce(p_view_window_days, 7), coalesce(p_min_views, 1000), p_payment_method, p_payment_handle, p_deadline,
          coalesce(p_max_clips_per_clipper, 5), (select agreement_version from public.money_config))
  returning id into cid;
  if want is not null and cardinality(want) > 0 then
    update public.campaign_footage f set campaign_id = cid, sort_order = array_position(p_footage_ids, f.id) where f.id = any (want);
  end if;
  return cid;
end;
$$;

-- ══ 7. reports and the owner's totals know 'partial' ══════════════════════════════════════════════
create or replace function public.footage_report_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type <> 'footage' then return new; end if;
  if not public.money_ready(new.reporter_id) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if not exists (select 1 from public.campaign_footage f
                  where f.id = new.target_id and f.status in ('ready', 'partial') and f.campaign_id is not null and f.creator_id <> new.reporter_id
                    and exists (select 1 from public.campaign_members m where m.campaign_id = f.campaign_id and m.clipper_id = new.reporter_id)
                    and not exists (select 1 from public.user_blocks b where (b.blocker_id = f.creator_id and b.blocked_id = new.reporter_id)
                                                                          or (b.blocker_id = new.reporter_id and b.blocked_id = f.creator_id))) then
    raise exception 'you cannot report this' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.footage_report_autohide()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type <> 'footage' then return new; end if;
  if (select count(*) from public.reports where target_type = 'footage' and target_id = new.target_id and status = 'pending') >= 3 then
    perform set_config('tryal.footage_write', '1', true);
    update public.campaign_footage set status = 'hidden' where id = new.target_id and status in ('ready', 'partial');
    perform set_config('tryal.footage_write', '', true);
  end if;
  return new;
end;
$$;

-- (the resolve of migration-money-footage.sql, with one change: dismiss puts an auto-hidden video back as 'ready' or 'partial', whichever it was)
create or replace function public.admin_report_resolve(p_report uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.reports;
  a record;
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_action not in ('dismiss', 'reviewed', 'hide', 'remove') then raise exception 'unknown action'; end if;
  select * into r from public.reports where id = p_report;
  if not found then raise exception 'unknown report'; end if;
  if p_action in ('hide', 'remove') then
    -- the owner's confirmation first, while the message still carries the post it shared (that post is the incident)
    for a in select ra.creator, ra.offender, ra.incident_post from public.recovery_aims(p_report) ra loop
      perform public.recovery_offer(a.creator, a.offender, 'owner', case when a.incident_post is null then '{}'::uuid[] else array[a.incident_post] end);
    end loop;
    if r.target_type in ('post', 'reaction') then
      update public.posts set moderation_status = case when p_action = 'remove' then 'removed' else 'hidden' end where id = r.target_id;
    elsif r.target_type = 'message' then
      update public.chat_messages set deleted_at = coalesce(deleted_at, now()), body = null, post_id = null where id = r.target_id;
    elsif r.target_type = 'footage' then
      perform set_config('tryal.footage_write', '1', true);
      update public.campaign_footage set status = case when p_action = 'remove' then 'deleted' else 'hidden' end,
                                         deleted_at = case when p_action = 'remove' then now() else deleted_at end
       where id = r.target_id and status <> 'deleted';
      if p_action = 'remove' then
        insert into public.trial_media_delete_queue (post_id, bucket, path)
          select f.id, 'campaign-footage', x from public.campaign_footage f, unnest(array[f.storage_path, f.thumb_path]) x where f.id = r.target_id on conflict do nothing;
      end if;
      perform set_config('tryal.footage_write', '', true);
    end if;
  elsif p_action = 'dismiss' and r.target_type = 'footage' then
    perform set_config('tryal.footage_write', '1', true);
    update public.campaign_footage set status = case when segment_seconds is null or segments_ready >= segment_count then 'ready' else 'partial' end where id = r.target_id and status = 'hidden';
    perform set_config('tryal.footage_write', '', true);
  end if;
  update public.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'reviewed' end
   where target_type = r.target_type and target_id = r.target_id and status = 'pending';
end;
$$;

create or replace function public.admin_footage_storage()
returns table (files bigint, total_bytes bigint, oldest_at timestamptz, hidden_files bigint, campaigns_with_footage bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select count(*), coalesce(sum(f.size_bytes), 0)::bigint, min(f.created_at), count(*) filter (where f.status = 'hidden'),
         count(distinct f.campaign_id)
    from public.campaign_footage f where f.status in ('uploading', 'partial', 'ready', 'hidden');
end;
$$;

-- ══ 8. stalled uploads: no new segment for 3 days -> flagged, and the creator is told ══════════════
-- (the notification type is added to the existing check without disturbing the types other migrations added)
do $$
declare def text; types text[];
begin
  if to_regclass('public.notifications') is not null then
    select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
    if def is not null and def not like '%footage_stalled%' then
      types := array(select m[1] from regexp_matches(def, '''([a-z_]+)''', 'g') as m);
      alter table public.notifications drop constraint notifications_type_check;
      execute format('alter table public.notifications add constraint notifications_type_check check (type = any (%L::text[]))', array_append(types, 'footage_stalled'));
    end if;
  end if;
end $$;

create or replace function public.money_footage_stall_check()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  days integer := (select footage_stall_days from public.money_config);
  n integer := 0;
  r record;
begin
  for r in
    update public.campaign_footage f set stalled_at = now()
     where f.status in ('uploading', 'partial') and f.stalled_at is null and f.last_progress_at < now() - make_interval(days => days)
    returning f.id, f.creator_id
  loop
    n := n + 1;
    if to_regclass('public.notifications') is not null then
      begin
        insert into public.notifications (recipient_id, actor_id, type, post_id) values (r.creator_id, null, 'footage_stalled', null);
      exception when others then null;   -- the flag is what counts; a notification that cannot be written never blocks it
      end;
    end if;
  end loop;
  return n;
end;
$$;

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'money-footage-stall';
    perform cron.schedule('money-footage-stall', '12 * * * *', 'select public.money_footage_stall_check()');
  end if;
exception when others then
  raise notice 'could not schedule money-footage-stall (%): run select public.money_footage_stall_check() by hand now and then', sqlerrm;
end $$;

-- ══ 9. who may call what ═══════════════════════════════════════════════════════════════════════════
revoke all on function public.footage_enqueue_segments(), public.money_footage_stall_check() from public, anon, authenticated;
revoke all on function public.money_footage_register_segmented(numeric, integer, integer), public.money_segment_complete(uuid, integer, bigint),
  public.money_footage_upload_ok(text), public.money_footage_read_ok(text),
  public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[], text),
  public.admin_report_resolve(uuid, text), public.admin_footage_storage() from public, anon;
grant execute on function public.money_footage_register_segmented(numeric, integer, integer), public.money_segment_complete(uuid, integer, bigint),
  public.money_footage_upload_ok(text), public.money_footage_read_ok(text),
  public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[], text),
  public.admin_report_resolve(uuid, text), public.admin_footage_storage() to authenticated;
