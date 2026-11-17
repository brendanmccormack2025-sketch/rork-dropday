-- Tryal Money: CAMPAIGN FOOTAGE (MONEY_TAB_SPEC.md sections 3, 3.1, 4). Idempotent; applied AFTER migration-post-links.sql and migration-money-board.sql
-- (apply with: node scripts/apply-migrations.mjs --only=migration-post-links.sql,migration-money.sql,migration-money-board.sql,migration-money-footage.sql
-- on a database that has none of them, or just this file once the others are in).
--
-- Creators upload videos from their camera roll into a PRIVATE bucket (campaign-footage): up to 60 minutes in total per campaign, each video up to
-- 30 minutes. The phone compresses first and uploads in resumable chunks (TUS, straight to Storage as the signed-in creator). Nobody reads a file
-- except the creator and the clippers who joined that campaign: reading goes through Storage's signed URLs, and Storage only signs for people the
-- policy below allows (there is no public URL, no list, no policy for anyone else, and apps can never update or delete a file).
-- Footage is deleted 14 days after the campaign closes (or 14 days after its deadline), and unattached uploads after 7 days: the files go through
-- the existing delete queue (trial_media_delete_queue + the delete-media function), the rows are marked 'deleted'.
-- Also here: a Report action on footage (the existing reports table, reasons, 3-report auto-hide and admin queue), account deletion removes a
-- person's footage and exports, the owner's storage totals, and an optional Google Drive / Dropbox link as a secondary way to share footage.

-- ══ 1. limits live in money_config ═══════════════════════════════════════════════════════════
alter table public.money_config add column if not exists max_footage_seconds_total integer not null default 3600;     -- 60 minutes per campaign
alter table public.money_config add column if not exists max_footage_seconds_each  integer not null default 1800;     -- 30 minutes per video
alter table public.money_config add column if not exists max_footage_bytes         bigint  not null default 2147483648;   -- 2 GB per video
alter table public.money_config add column if not exists footage_delete_days       integer not null default 14;
alter table public.money_config add column if not exists orphan_footage_days       integer not null default 7;
alter table public.money_config add column if not exists max_draft_footage         integer not null default 30;
-- the Campaign Agreement and the Clipper Agreement changed (uploaded footage, footage use, tracked links): everybody reads and ticks again
alter table public.money_config alter column footage_delete_days set default 14;
update public.money_config set footage_delete_days = 14 where footage_delete_days = 30;   -- was 30: footage is now deleted 14 days after the campaign closes
update public.money_config set agreement_version = greatest(agreement_version, 2);

-- ══ 2. the footage table ═════════════════════════════════════════════════════════════════════
create table if not exists public.campaign_footage (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references public.profiles(id) on delete cascade,
  campaign_id      uuid references public.campaigns(id) on delete cascade,       -- null until the campaign is created (a draft upload)
  storage_path     text not null unique,                                         -- <creator id>/<id>.mp4
  thumb_path       text not null unique,                                         -- <creator id>/<id>.jpg
  duration_seconds numeric(8,2) not null check (duration_seconds > 0),
  width            integer not null check (width > 0 and width <= 8192),
  height           integer not null check (height > 0 and height <= 8192),
  size_bytes       bigint not null check (size_bytes > 0),
  sort_order       integer not null default 0,
  status           text not null default 'uploading' check (status in ('uploading', 'ready', 'failed', 'deleted')),
  thumb_ok         boolean not null default false,
  created_at       timestamptz not null default now(),
  ready_at         timestamptz,
  deleted_at       timestamptz
);
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.campaign_footage'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' loop
    execute format('alter table public.campaign_footage drop constraint %I', c.conname);
  end loop;
  alter table public.campaign_footage add constraint campaign_footage_status_check check (status in ('uploading', 'ready', 'failed', 'deleted', 'hidden'));
end $$;
create index if not exists campaign_footage_creator_idx on public.campaign_footage (creator_id, campaign_id);
create index if not exists campaign_footage_campaign_idx on public.campaign_footage (campaign_id) where campaign_id is not null;
alter table public.campaign_footage enable row level security;
revoke all on table public.campaign_footage from anon, authenticated;
grant select on public.campaign_footage to authenticated;
drop policy if exists footage_read on public.campaign_footage;
create policy footage_read on public.campaign_footage for select to authenticated using (
  public.money_admin_me()
  or (public.money_ready_me() and status <> 'deleted' and (
        creator_id = auth.uid()
        or (campaign_id is not null and status = 'ready' and public.money_is_member_me(campaign_id) and not public.money_blocked_with_me(creator_id)))));

-- Who may add a video, and how much: checked on every insert, whoever inserts. Serialised per creator so two quick uploads cannot both squeeze in.
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
   where creator_id = new.creator_id and campaign_id is not distinct from new.campaign_id and status in ('uploading', 'ready', 'hidden');
  if used + new.duration_seconds > cfg.max_footage_seconds_total then
    raise exception 'a campaign can have at most % minutes of footage', cfg.max_footage_seconds_total / 60 using errcode = '22023';
  end if;
  if new.campaign_id is null and n >= cfg.max_draft_footage then raise exception 'too many videos at once' using errcode = '22023'; end if;
  return new;
end;
$$;
drop trigger if exists money_footage_guard on public.campaign_footage;
create trigger money_footage_guard before insert on public.campaign_footage
  for each row execute function public.money_footage_guard();

-- once a campaign has a clipper its footage is frozen with the other terms: nobody with an account can change or remove it (the purge, which has
-- no signed-in user, can)
create or replace function public.money_footage_change_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare frozen boolean;
begin
  if auth.uid() is null or coalesce(nullif(current_setting('tryal.footage_write', true), ''), '') = '1' then return coalesce(new, old); end if;
  select (terms_frozen_at is not null) into frozen from public.campaigns where id = old.campaign_id;
  if coalesce(frozen, false) then raise exception 'footage is frozen once the first clipper has joined' using errcode = '42501'; end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists money_footage_change_guard on public.campaign_footage;
create trigger money_footage_change_guard before update or delete on public.campaign_footage
  for each row when (old.campaign_id is not null) execute function public.money_footage_change_guard();

-- ══ 3. what the app calls ════════════════════════════════════════════════════════════════════
-- Register a video before uploading it (after the phone has compressed it, so the size is the real one). Returns where to upload.
create or replace function public.money_footage_register(p_duration_seconds numeric, p_width integer, p_height integer, p_size_bytes bigint)
returns table (id uuid, storage_path text, thumb_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  fid uuid := gen_random_uuid();
begin
  insert into public.campaign_footage (id, creator_id, storage_path, thumb_path, duration_seconds, width, height, size_bytes)
  values (fid, me, me::text || '/' || fid::text || '.mp4', me::text || '/' || fid::text || '.jpg', round(p_duration_seconds, 2), p_width, p_height, p_size_bytes);
  return query select f.id, f.storage_path, f.thumb_path from public.campaign_footage f where f.id = fid;
end;
$$;

-- The upload finished: check the file really is in Storage at the registered size, then the video is ready (the thumbnail is a bonus).
create or replace function public.money_footage_complete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  f public.campaign_footage;
  sz bigint;
begin
  select * into f from public.campaign_footage where id = p_id and creator_id = me for update;
  if not found then raise exception 'unknown video' using errcode = 'P0002'; end if;
  if f.status = 'ready' then return; end if;
  if f.status <> 'uploading' then raise exception 'this video cannot be completed' using errcode = '42501'; end if;
  select (o.metadata ->> 'size')::bigint into sz from storage.objects o where o.bucket_id = 'campaign-footage' and o.name = f.storage_path;
  if sz is null or sz <> f.size_bytes then raise exception 'the upload is not complete yet' using errcode = '55000'; end if;
  update public.campaign_footage
     set status = 'ready', ready_at = now(),
         thumb_ok = exists (select 1 from storage.objects o where o.bucket_id = 'campaign-footage' and o.name = f.thumb_path)
   where id = p_id;
end;
$$;

-- a failed upload the app gave up on, so its slot (minutes) is free again
create or replace function public.money_footage_fail(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := public.money_require_ready('creator');
begin
  update public.campaign_footage set status = 'failed' where id = p_id and creator_id = me and status = 'uploading';
  insert into public.trial_media_delete_queue (post_id, bucket, path)
    select f.id, 'campaign-footage', p from public.campaign_footage f, unnest(array[f.storage_path, f.thumb_path]) p
     where f.id = p_id and f.creator_id = me and f.status = 'failed' on conflict do nothing;
end;
$$;

-- remove a video I added (not once the campaign has a clipper): its files are queued for deletion
create or replace function public.money_footage_remove(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := public.money_require_ready('creator');
begin
  if not exists (select 1 from public.campaign_footage where id = p_id and creator_id = me and status <> 'deleted') then raise exception 'unknown video' using errcode = 'P0002'; end if;
  update public.campaign_footage set status = 'deleted', deleted_at = now() where id = p_id and creator_id = me;
  insert into public.trial_media_delete_queue (post_id, bucket, path)
    select f.id, 'campaign-footage', p from public.campaign_footage f, unnest(array[f.storage_path, f.thumb_path]) p where f.id = p_id on conflict do nothing;
end;
$$;

-- Post the campaign with its uploaded footage and/or an optional Google Drive / Dropbox link (for footage longer than the upload limit).
-- Every uploaded video must be mine, ready and not yet used; the minutes were checked when each was added.
drop function if exists public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[]);
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
    select count(*) into have from public.campaign_footage where id = any (want) and creator_id = me and campaign_id is null and status = 'ready';
    if have <> cardinality(want) then raise exception 'some videos are missing or still uploading' using errcode = '55000'; end if;
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

-- ══ 4. who may put a file in the bucket and who may read it (Storage policies; signed URLs follow the read policy) ══
create or replace function public.money_footage_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.money_ready(auth.uid())
     and exists (select 1 from public.campaign_footage f
                  where f.creator_id = auth.uid() and f.status = 'uploading' and (f.storage_path = p_name or f.thumb_path = p_name))
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
    or (public.money_ready(auth.uid()) and exists (
         select 1 from public.campaign_footage f
          where (f.storage_path = p_name or f.thumb_path = p_name) and f.status in ('uploading', 'ready')
            and (f.creator_id = auth.uid()
                 or (f.status = 'ready' and f.campaign_id is not null
                     and exists (select 1 from public.campaign_members m where m.campaign_id = f.campaign_id and m.clipper_id = auth.uid())
                     and not exists (select 1 from public.user_blocks b where (b.blocker_id = f.creator_id and b.blocked_id = auth.uid())
                                                                           or (b.blocker_id = auth.uid() and b.blocked_id = f.creator_id)))))))
$$;

do $$
begin
  if to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('campaign-footage', 'campaign-footage', false, 2147483648, array['video/mp4', 'video/quicktime', 'image/jpeg'])
    on conflict (id) do update set public = false, file_size_limit = 2147483648, allowed_mime_types = array['video/mp4', 'video/quicktime', 'image/jpeg'];
    drop policy if exists "campaign footage read" on storage.objects;
    create policy "campaign footage read" on storage.objects for select to authenticated
      using (bucket_id = 'campaign-footage' and public.money_footage_read_ok(name));
    drop policy if exists "campaign footage add" on storage.objects;
    create policy "campaign footage add" on storage.objects for insert to authenticated
      with check (bucket_id = 'campaign-footage' and public.money_footage_upload_ok(name));
  end if;
end $$;

-- ══ 5. deletion: 14 days after the campaign closes, 7 days for an upload nobody used ═══════════════
-- Marks the rows 'deleted' and queues the files; the delete-media function removes them from Storage (it is scheduled by ship.sh).
create or replace function public.money_footage_purge()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.money_config;
  n integer;
begin
  select * into cfg from public.money_config;
  with gone as (
    update public.campaign_footage f set status = 'deleted', deleted_at = now()
     where f.status <> 'deleted' and (
           (f.campaign_id is null and f.created_at < now() - make_interval(days => cfg.orphan_footage_days))
        or (f.campaign_id is not null and exists (
              select 1 from public.campaigns c
               where c.id = f.campaign_id
                 and ((c.status = 'closed' and c.closed_at < now() - make_interval(days => cfg.footage_delete_days))
                      or c.deadline < now() - make_interval(days => cfg.footage_delete_days)))))
    returning f.id, f.storage_path, f.thumb_path)
  , queued as (
    insert into public.trial_media_delete_queue (post_id, bucket, path)
      select g.id, 'campaign-footage', p from gone g, unnest(array[g.storage_path, g.thumb_path]) p on conflict do nothing
      returning 1)
  select count(*) into n from gone;
  return n;
end;
$$;

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'money-footage-purge';
    perform cron.schedule('money-footage-purge', '30 3 * * *', 'select public.money_footage_purge()');
  end if;
exception when others then
  raise notice 'could not schedule money-footage-purge (%): run select public.money_footage_purge() by hand now and then', sqlerrm;
end $$;

-- ══ 6. who may call what ═════════════════════════════════════════════════════════════════════
revoke all on function public.money_footage_guard(), public.money_footage_change_guard(), public.money_footage_purge() from public, anon, authenticated;
revoke all on function public.money_footage_register(numeric, integer, integer, bigint), public.money_footage_complete(uuid), public.money_footage_fail(uuid),
  public.money_footage_remove(uuid), public.money_footage_upload_ok(text), public.money_footage_read_ok(text),
  public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[], text)
  from public, anon;
grant execute on function public.money_footage_register(numeric, integer, integer, bigint), public.money_footage_complete(uuid), public.money_footage_fail(uuid),
  public.money_footage_remove(uuid), public.money_footage_upload_ok(text), public.money_footage_read_ok(text),
  public.money_create_campaign_with_footage(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean, uuid[], text)
  to authenticated;

-- ══ 7. the Drive / Dropbox link is private to the creator and the clippers who joined ═══════════════
-- (the column used to be readable with the rest of the campaign: now only this function shows it)
revoke select (footage_url) on public.campaigns from authenticated;
create or replace function public.campaign_footage_link(p_campaign uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select c.footage_url from public.campaigns c
   where c.id = p_campaign and auth.uid() is not null and public.money_ready(auth.uid())
     and (c.creator_id = auth.uid()
          or (exists (select 1 from public.campaign_members m where m.campaign_id = c.id and m.clipper_id = auth.uid())
              and not exists (select 1 from public.user_blocks b where (b.blocker_id = c.creator_id and b.blocked_id = auth.uid())
                                                                    or (b.blocker_id = auth.uid() and b.blocked_id = c.creator_id))))
$$;

-- ══ 8. Report on footage: the existing reports table, reasons, 3-report auto-hide and owner queue ════════
do $$
declare c record;
begin
  if to_regclass('public.reports') is not null then
    for c in select conname from pg_constraint
             where conrelid = 'public.reports'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target_type%'
    loop
      execute format('alter table public.reports drop constraint %I', c.conname);
    end loop;
    alter table public.reports add constraint reports_target_type_check
      check (target_type in ('post', 'reaction', 'message', 'campaign', 'submission', 'money_review', 'money_user', 'footage'));
  end if;
end $$;

-- only a clipper who joined the campaign can report one of its ready videos (not the creator's own, not across a block)
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
                  where f.id = new.target_id and f.status = 'ready' and f.campaign_id is not null and f.creator_id <> new.reporter_id
                    and exists (select 1 from public.campaign_members m where m.campaign_id = f.campaign_id and m.clipper_id = new.reporter_id)
                    and not exists (select 1 from public.user_blocks b where (b.blocker_id = f.creator_id and b.blocked_id = new.reporter_id)
                                                                          or (b.blocker_id = new.reporter_id and b.blocked_id = f.creator_id))) then
    raise exception 'you cannot report this' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists footage_report_guard on public.reports;
create trigger footage_report_guard before insert on public.reports
  for each row execute function public.footage_report_guard();

-- the same threshold as posts (migration-moderation.sql): 3 pending reports hide it from everyone but its creator, until the owner decides
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
    update public.campaign_footage set status = 'hidden' where id = new.target_id and status = 'ready';
    perform set_config('tryal.footage_write', '', true);
  end if;
  return new;
end;
$$;
drop trigger if exists zz_footage_report_autohide on public.reports;
create trigger zz_footage_report_autohide after insert on public.reports
  for each row execute function public.footage_report_autohide();

-- the owner's queue (migration-harassment.sql) with footage reports shown: which campaign, how long, and whose
create or replace function public.admin_reports_queue(p_status text default 'pending', p_limit integer default 50)
returns table (report_id uuid, target_type text, target_id uuid, reason text, status text, created_at timestamptz,
               reporter_username text, reported_user_id uuid, reported_username text, preview text, thumbnail_url text, report_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select r.id, r.target_type::text, r.target_id, r.reason::text, r.status::text, r.created_at,
         rp.username::text,
         coalesce(p.user_id, m.sender_id, f.creator_id),
         up.username::text,
         case when f.id is not null then left('Footage in "' || coalesce(fc.title, '?') || '" (' || (f.duration_seconds::integer / 60) || ' min, ' || f.status || ')', 300)
              else left(coalesce(p.caption, m.body, ''), 300) end,
         p.thumbnail_url::text,
         (select count(*)::integer from public.reports x where x.target_type = r.target_type and x.target_id = r.target_id)
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts p on r.target_type in ('post', 'reaction') and p.id = r.target_id
  left join public.chat_messages m on r.target_type = 'message' and m.id = r.target_id
  left join public.campaign_footage f on r.target_type = 'footage' and f.id = r.target_id
  left join public.campaigns fc on fc.id = f.campaign_id
  left join public.profiles up on up.id = coalesce(p.user_id, m.sender_id, f.creator_id)
  where r.status = coalesce(nullif(p_status, ''), 'pending')
  order by r.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- the resolve of migration-recovery.sql with footage added: hide keeps the row hidden, remove deletes the video (its files are queued),
-- dismiss puts an auto-hidden video back
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
    update public.campaign_footage set status = 'ready' where id = r.target_id and status = 'hidden';
    perform set_config('tryal.footage_write', '', true);
  end if;
  update public.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'reviewed' end
   where target_type = r.target_type and target_id = r.target_id and status = 'pending';
end;
$$;

-- ══ 9. the owner's storage totals (GB, number of files, oldest file) ═════════════════════════════
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
    from public.campaign_footage f where f.status in ('uploading', 'ready', 'hidden');
end;
$$;

-- ══ 10. deleting an account removes that person's footage and exported copies ══════════════════════
-- Queues every file (the video and thumbnail of each row, and anything else stored under <user id>/ in the footage and export buckets) for the
-- delete-media function, and marks the rows deleted. Runs from delete_my_footage() (the app calls it before the delete-user function) AND from a
-- trigger on the profile row, so it also happens when the account is removed any other way (the edge function, the dashboard, a cascade).
create or replace function public.money_footage_queue_user_files(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  perform set_config('tryal.footage_write', '1', true);
  insert into public.trial_media_delete_queue (post_id, bucket, path)
    select f.id, 'campaign-footage', x from public.campaign_footage f, unnest(array[f.storage_path, f.thumb_path]) x
     where f.creator_id = p_user and f.status <> 'deleted' on conflict do nothing;
  get diagnostics n = row_count;
  if to_regclass('storage.objects') is not null then
    execute format($q$insert into public.trial_media_delete_queue (post_id, bucket, path)
                      select %L::uuid, o.bucket_id, o.name from storage.objects o
                       where o.bucket_id in ('campaign-footage', 'clip-exports') and o.name like %L on conflict do nothing$q$, p_user, p_user::text || '/%');
  end if;
  update public.campaign_footage set status = 'deleted', deleted_at = coalesce(deleted_at, now()) where creator_id = p_user and status <> 'deleted';
  perform set_config('tryal.footage_write', '', true);
  return n;
end;
$$;

create or replace function public.delete_my_footage()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  return public.money_footage_queue_user_files(auth.uid());
end;
$$;

create or replace function public.profiles_footage_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.money_footage_queue_user_files(old.id);
  return old;
end;
$$;
drop trigger if exists profiles_footage_cleanup on public.profiles;
create trigger profiles_footage_cleanup before delete on public.profiles
  for each row execute function public.profiles_footage_cleanup();

-- ══ 11. who may call what (this part) ═══════════════════════════════════════════════════════════
revoke all on function public.footage_report_guard(), public.footage_report_autohide(), public.money_footage_queue_user_files(uuid), public.profiles_footage_cleanup()
  from public, anon, authenticated;
revoke all on function public.campaign_footage_link(uuid), public.admin_footage_storage(), public.delete_my_footage(), public.admin_reports_queue(text, integer),
  public.admin_report_resolve(uuid, text) from public, anon;
grant execute on function public.campaign_footage_link(uuid), public.admin_footage_storage(), public.delete_my_footage(), public.admin_reports_queue(text, integer),
  public.admin_report_resolve(uuid, text) to authenticated;
