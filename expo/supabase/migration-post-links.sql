-- Tryal: LINKS ON POSTS (all posts, not only Money). Idempotent. Standalone: it needs only the base schema (posts), so it can ship before Money.
--
-- A post can carry ONE video link ("A specific video" in the composer). The post shows a "Watch on <platform>" button; the button never opens
-- the raw address, it opens a tracked short link (the `go` edge function, supabase/functions/go) that counts the tap and redirects.
--   * the address is validated here, on the server: https only, and only these sites: youtube.com, youtu.be, tiktok.com, instagram.com, x.com,
--     twitch.tv, open.spotify.com (subdomains of the first five are fine, e.g. www.youtube.com, vm.tiktok.com; not look-alikes)
--   * viewers see only the platform and the short code (columns on posts); the address itself is in post_links, readable by the post's owner only
--   * taps are counted per post per day (post_link_tap_days). The same device within 24 hours counts once. To do that the edge function sends
--     a salted hash of the caller (never the address, never the device); it sits in link_tap_seen for at most 48 hours and is then deleted.
--     Nothing about the person who tapped is kept: the counts are all that stays.
--   * the owner reads their own total with my_post_link_taps(post); apps cannot write any of these tables, and cannot call the two functions
--     the edge function uses (link_target, record_link_tap: service role only)
--   * a hidden or removed post's link stops working (link_target returns nothing)

-- ── 1. columns on posts (what a viewer needs) ─────────────────────────────────────────────────
alter table public.posts add column if not exists link_code text;
alter table public.posts add column if not exists link_platform text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'posts_link_platform_check') then
    alter table public.posts add constraint posts_link_platform_check
      check (link_platform is null or link_platform in ('youtube', 'tiktok', 'instagram', 'x', 'twitch', 'spotify'));
  end if;
end $$;
create unique index if not exists posts_link_code_uidx on public.posts (link_code) where link_code is not null;

-- ── 2. the address, the counts, the short-lived de-duplication ───────────────────────────────
create table if not exists public.post_links (
  post_id    uuid primary key references public.posts(id) on delete cascade,
  url        text not null check (char_length(url) <= 500),
  platform   text not null check (platform in ('youtube', 'tiktok', 'instagram', 'x', 'twitch', 'spotify')),
  code       text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.post_link_tap_days (
  post_id uuid not null references public.posts(id) on delete cascade,
  day     date not null,
  taps    integer not null default 0 check (taps >= 0),
  primary key (post_id, day)
);
create table if not exists public.link_tap_seen (
  code    text not null,
  fp      text not null check (char_length(fp) between 16 and 64),   -- a salted hash made by the edge function; nothing else
  seen_at timestamptz not null default now(),
  primary key (code, fp)
);
create index if not exists link_tap_seen_seen_at_idx on public.link_tap_seen (seen_at);

alter table public.post_links enable row level security;
alter table public.post_link_tap_days enable row level security;
alter table public.link_tap_seen enable row level security;
revoke all on table public.post_links, public.post_link_tap_days, public.link_tap_seen from anon, authenticated;
grant select on public.post_links to authenticated;
drop policy if exists post_links_owner_read on public.post_links;
create policy post_links_owner_read on public.post_links for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_links.post_id and p.user_id = auth.uid()));

-- ── 3. which sites, and which platform an address belongs to ──────────────────────────────────
-- null when the address is not allowed: not https, a user@host trick, a port, a look-alike host, whitespace, too long.
create or replace function public.link_platform_of(p_url text)
returns text
language plpgsql
immutable
as $$
declare
  u text := lower(btrim(coalesce(p_url, '')));
  h text;
begin
  if u = '' or char_length(u) > 500 or u ~ '\s' then return null; end if;
  h := substring(u from '^https://([a-z0-9][a-z0-9.-]*)(?:[/?#]|$)');
  if h is null then return null; end if;
  if h = 'youtube.com' or h like '%.youtube.com' or h = 'youtu.be' then return 'youtube'; end if;
  if h = 'tiktok.com' or h like '%.tiktok.com' then return 'tiktok'; end if;
  if h = 'instagram.com' or h like '%.instagram.com' then return 'instagram'; end if;
  if h = 'x.com' or h like '%.x.com' then return 'x'; end if;
  if h = 'twitch.tv' or h like '%.twitch.tv' then return 'twitch'; end if;
  if h = 'open.spotify.com' then return 'spotify'; end if;
  return null;
end;
$$;

-- only the functions below may change link_code / link_platform (the SQL editor and the service role may too)
create or replace function public.posts_link_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  trusted boolean := coalesce(nullif(current_setting('tryal.post_link_write', true), ''), '') = '1' or auth.uid() is null;
begin
  if tg_op = 'INSERT' then
    if (new.link_code is not null or new.link_platform is not null) and not trusted then
      raise exception 'a video link is added with set_post_video_link' using errcode = '42501';
    end if;
  elsif (new.link_code is distinct from old.link_code or new.link_platform is distinct from old.link_platform) and not trusted then
    raise exception 'a video link is changed with set_post_video_link' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists posts_link_guard on public.posts;
create trigger posts_link_guard before insert or update of link_code, link_platform on public.posts
  for each row execute function public.posts_link_guard();

-- ── 4. what the app calls ─────────────────────────────────────────────────────────────────────
-- Add or change the video link on my own post. The code (the tracked short link) stays the same when the address changes.
create or replace function public.set_post_video_link(p_post uuid, p_url text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  pr public.posts;
  pl text := public.link_platform_of(p_url);
  c text;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into pr from public.posts where id = p_post and user_id = me;
  if not found then raise exception 'unknown post' using errcode = 'P0002'; end if;
  if pr.parent_post_id is not null then raise exception 'a reaction cannot carry a video link' using errcode = '22023'; end if;
  if pl is null then raise exception 'that link is not allowed: use YouTube, TikTok, Instagram, X, Twitch or Spotify' using errcode = '22023'; end if;
  select code into c from public.post_links where post_id = p_post;
  if c is null then
    loop
      c := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
      exit when not exists (select 1 from public.post_links where code = c);
    end loop;
  end if;
  insert into public.post_links (post_id, url, platform, code) values (p_post, btrim(p_url), pl, c)
  on conflict (post_id) do update set url = excluded.url, platform = excluded.platform;
  perform set_config('tryal.post_link_write', '1', true);
  update public.posts set link_code = c, link_platform = pl where id = p_post;
  perform set_config('tryal.post_link_write', '', true);
  return c;
end;
$$;

create or replace function public.clear_post_video_link(p_post uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.posts where id = p_post and user_id = me) then raise exception 'unknown post' using errcode = 'P0002'; end if;
  delete from public.post_links where post_id = p_post;
  perform set_config('tryal.post_link_write', '1', true);
  update public.posts set link_code = null, link_platform = null where id = p_post;
  perform set_config('tryal.post_link_write', '', true);
end;
$$;

-- "This post sent X people to your video": the total, to the post's owner only (anyone else gets 0)
create or replace function public.my_post_link_taps(p_post uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select sum(d.taps)::integer from public.post_link_tap_days d join public.posts p on p.id = d.post_id
                    where d.post_id = p_post and p.user_id = auth.uid()), 0)
$$;

-- ── 5. what only the edge function calls (service role) ──────────────────────────────────────
-- the address behind a code, for a post that is still showing (not hidden or removed); nothing otherwise
create or replace function public.link_target(p_code text)
returns table (url text, post_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select l.url, l.post_id from public.post_links l join public.posts p on p.id = l.post_id
   where l.code = p_code and p.moderation_status = 'active'
$$;

-- Count one tap unless the same fingerprint already counted for this code in the last 24 hours. true = counted.
create or replace function public.record_link_tap(p_code text, p_fp text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  counted integer;
begin
  select l.post_id into pid from public.post_links l where l.code = p_code;
  if pid is null or p_fp is null or char_length(p_fp) not between 16 and 64 then return false; end if;
  insert into public.link_tap_seen (code, fp, seen_at) values (p_code, p_fp, now())
  on conflict (code, fp) do update set seen_at = now()
    where public.link_tap_seen.seen_at < now() - interval '24 hours'
  returning 1 into counted;
  if counted is null then return false; end if;
  insert into public.post_link_tap_days (post_id, day, taps) values (pid, (now() at time zone 'utc')::date, 1)
  on conflict (post_id, day) do update set taps = public.post_link_tap_days.taps + 1;
  return true;
end;
$$;

-- the de-duplication hashes are kept for 48 hours at most
create or replace function public.link_taps_purge()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from public.link_tap_seen where seen_at < now() - interval '48 hours';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- weekly counts for the pitch metrics (weeks start on Monday, UTC); closed to apps
create or replace view public.link_taps_weekly as
  select date_trunc('week', day::timestamp)::date as week_start, sum(taps)::bigint as taps, count(distinct post_id)::bigint as posts_with_taps
    from public.post_link_tap_days group by 1;
revoke all on public.link_taps_weekly from anon, authenticated;

-- ── 6. who may call what ──────────────────────────────────────────────────────────────────────
revoke all on function public.link_platform_of(text), public.posts_link_guard(), public.set_post_video_link(uuid, text), public.clear_post_video_link(uuid),
  public.my_post_link_taps(uuid), public.link_target(text), public.record_link_tap(text, text), public.link_taps_purge() from public, anon, authenticated;
grant execute on function public.set_post_video_link(uuid, text), public.clear_post_video_link(uuid), public.my_post_link_taps(uuid) to authenticated;
grant execute on function public.link_target(text), public.record_link_tap(text, text), public.link_taps_purge() to service_role;

-- ── 7. the hourly purge ───────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'link-taps-purge';
    perform cron.schedule('link-taps-purge', '17 * * * *', 'select public.link_taps_purge()');
  end if;
exception when others then
  raise notice 'could not schedule link-taps-purge (%): run select public.link_taps_purge() by hand now and then', sqlerrm;
end $$;
