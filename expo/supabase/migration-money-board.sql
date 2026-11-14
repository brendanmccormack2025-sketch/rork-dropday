-- Tryal Money tab v1 "job board" (MONEY_TAB_SPEC.md). Idempotent; applied AFTER migration-money.sql (the flag, the adult check, the birthdate
-- lock-down). v1 moves NO money in the app: creators post campaigns, clippers make clips, the creator pays outside the app, Tryal does
-- the math, tracks who paid and enforces reputation.
--
--   STEP 1  schema, RLS and triggers (spec sections 1, 11)
--
-- HOW IT IS CLOSED
--   * every money table has row level security and NO write grant for apps: all writes go through the SECURITY DEFINER functions below
--     (and, in later steps, the ones the spec lists: links, proof, approve, dispute, paid/received, reviews)
--   * every read policy requires money_ready(): the money flag, a known 18+ birthdate, not sanctioned, not money_banned, and the walkthrough
--     + agreement for the current version finished. Under-18s, banned and not-onboarded accounts read nothing, whatever the app shows.
--   * a block hides the other person's campaigns and submissions (either direction) and stops them from joining; a clipper keeps seeing
--     their OWN submissions even if the creator blocked them, because they may still be owed money
--   * the campaign's payment handle is a column apps cannot select (only members get it, through campaign_payment_info())
-- WHAT IS NOT HERE YET (later steps): the app screens, links / proof / approval / payment RPCs, the scheduled jobs, notifications, the
-- messaging thread on join, and the editor-session proof for edited_in_tryal (until then it is always false).

-- ══ 0. profiles.money_banned ════════════════════════════════════════════════════════════════
alter table public.profiles add column if not exists money_banned boolean not null default false;

-- only an admin / the SQL editor may change it (a user could otherwise lift their own ban)
create or replace function public.profiles_money_banned_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.money_banned and auth.uid() is not null and not public.mod_is_admin() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.money_banned is distinct from old.money_banned and auth.uid() is not null and not public.mod_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_money_banned_guard on public.profiles;
create trigger profiles_money_banned_guard before insert or update on public.profiles
  for each row execute function public.profiles_money_banned_guard();

-- ══ 1. configuration (closed; one row) ═════════════════════════════════════════════════════
create table if not exists public.money_config (
  id                  boolean primary key default true check (id),
  agreement_version   integer not null default 1,      -- bump to make everybody read and tick the agreement again
  approval_hours      integer not null default 48,     -- creator's window to approve / dispute before auto-approval
  payment_days        integer not null default 3,      -- pay within this many days of approval
  proof_grace_days    integer not null default 3,      -- proof due this long after the view window ends
  review_reveal_days  integer not null default 7,      -- blind reviews publish after this long
  max_proof_images    integer not null default 3,
  max_clip_seconds    integer not null default 60,
  late_strikes_to_ban integer not null default 2
);
insert into public.money_config (id) values (true) on conflict do nothing;
alter table public.money_config enable row level security;
revoke all on table public.money_config from anon, authenticated;

-- ══ 2. who may use Money: banned, onboarded, ready ═════════════════════════════════════════
-- money_allowed (migration-money.sql) now also requires "not money_banned".
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
     and not exists (select 1 from public.profiles p where p.id = p_user and p.money_banned)
     and not exists (select 1 from public.account_sanction_of(p_user))
$$;

-- the walkthrough and agreement, closed table (never on public profiles)
create table if not exists public.money_profiles (
  user_id                  uuid primary key references public.profiles(id) on delete cascade,
  money_role               text not null check (money_role in ('creator', 'clipper', 'both')),
  money_onboarded_at       timestamptz,
  money_agreement_version  integer,
  agreed_rules             jsonb not null default '[]'::jsonb,   -- the checkboxes ticked
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
alter table public.money_profiles enable row level security;
revoke all on table public.money_profiles from anon, authenticated;

-- allowed AND finished the walkthrough for the current agreement version. Every table policy and every RPC below uses this.
create or replace function public.money_ready(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.money_allowed(p_user)
     and exists (select 1 from public.money_profiles mp, public.money_config c
                 where mp.user_id = p_user and mp.money_onboarded_at is not null and mp.money_agreement_version = c.agreement_version)
$$;

create or replace function public.money_role_of(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$ select mp.money_role from public.money_profiles mp where mp.user_id = p_user $$;

-- the rules a person must tick, per role (one checkbox per rule)
create or replace function public.money_required_rules(p_role text)
returns text[]
language sql
immutable
as $$
  select case p_role
    when 'creator' then array['pay_on_time', 'terms_freeze', 'auto_approval_48h', 'not_part_of_payment', 'own_footage_rights']
    when 'clipper' then array['only_real_views', 'submit_through_tryal', 'upload_proof_on_time', 'not_part_of_payment']
    when 'both'    then array['pay_on_time', 'terms_freeze', 'auto_approval_48h', 'not_part_of_payment', 'own_footage_rights',
                              'only_real_views', 'submit_through_tryal', 'upload_proof_on_time']
  end
$$;

-- Finish (or redo) the walkthrough. Every required rule must be ticked: the server checks, not the screen.
create or replace function public.money_complete_onboarding(p_role text, p_rules text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  need text[];
  ver integer;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.money_allowed(me) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('creator', 'clipper', 'both') then raise exception 'pick creator, clipper or both' using errcode = '22023'; end if;
  need := public.money_required_rules(p_role);
  if not (coalesce(p_rules, '{}') @> need) then raise exception 'tick every rule to continue' using errcode = '22023'; end if;
  select agreement_version into ver from public.money_config;
  insert into public.money_profiles (user_id, money_role, money_onboarded_at, money_agreement_version, agreed_rules)
  values (me, p_role, now(), ver, to_jsonb(need))
  on conflict (user_id) do update
    set money_role = excluded.money_role, money_onboarded_at = now(), money_agreement_version = ver,
        agreed_rules = excluded.agreed_rules, updated_at = now();
  return public.my_money_profile();
end;
$$;

create or replace function public.my_money_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  mp public.money_profiles;
  cur integer;
begin
  if me is null then return jsonb_build_object('allowed', false, 'ready', false); end if;
  select agreement_version into cur from public.money_config;
  select * into mp from public.money_profiles where user_id = me;
  return jsonb_build_object(
    'allowed', public.money_allowed(me),
    'ready', public.money_ready(me),
    'role', mp.money_role,
    'onboarded_at', mp.money_onboarded_at,
    'agreement_version', mp.money_agreement_version,
    'current_agreement_version', cur,
    'needs_onboarding', public.money_allowed(me) and not public.money_ready(me)
  );
end;
$$;

-- what the app reads at launch (migration-money.sql's, plus banned / onboarding)
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
  banned boolean;
  on_flag boolean;
begin
  if me is null then
    return jsonb_build_object('money', false, 'needs_birthdate', false, 'allowed', false, 'ready', false, 'needs_onboarding', false);
  end if;
  select p.birthdate, true, p.money_banned into bd, has_profile, banned from public.profiles p where p.id = me;
  on_flag := public.flag_on('money', me);
  return jsonb_build_object(
    'money', coalesce(on_flag and has_profile and not banned and not exists (select 1 from public.account_sanction_of(me)) and (bd is null or public.age_tier(bd) = 'adult'), false),
    'needs_birthdate', coalesce(on_flag and has_profile and not banned and bd is null, false),
    'allowed', public.money_allowed(me),
    'ready', public.money_ready(me),
    'needs_onboarding', public.money_allowed(me) and not public.money_ready(me)
  );
end;
$$;

-- ══ 3. campaigns ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.campaigns (
  id                    uuid primary key default gen_random_uuid(),
  creator_id            uuid not null references public.profiles(id) on delete cascade,
  title                 text not null check (char_length(title) between 1 and 60),
  description           text not null check (char_length(description) between 1 and 1000),
  footage_url           text not null,
  rate_per_1k           numeric(10,2) not null check (rate_per_1k > 0 and rate_per_1k <= 1000),
  cap_per_clip          numeric(10,2) not null check (cap_per_clip > 0 and cap_per_clip <= 100000),
  total_budget          numeric(12,2) not null check (total_budget > 0 and total_budget <= 10000000),
  guaranteed_per_clip   numeric(10,2) not null default 0 check (guaranteed_per_clip >= 0 and guaranteed_per_clip <= 100000),
  platforms             text[] not null check (cardinality(platforms) between 1 and 4),
  view_window_days      integer not null default 7 check (view_window_days between 3 and 14),
  min_views             integer not null default 1000 check (min_views >= 0),
  payment_method        text not null check (payment_method in ('paypal', 'venmo', 'cashapp')),
  payment_handle        text not null,                          -- plain text only; apps cannot select this column (campaign_payment_info)
  deadline              timestamptz not null,
  max_clips_per_clipper integer not null default 5 check (max_clips_per_clipper between 1 and 50),
  status                text not null default 'open' check (status in ('open', 'paused', 'closed')),
  paused_reason         text check (paused_reason is null or paused_reason in ('overdue_payment', 'creator_banned', 'creator', 'admin')),
  closed_reason         text check (closed_reason is null or closed_reason in ('creator', 'deadline', 'budget', 'admin')),
  terms_frozen_at       timestamptz,
  budget_committed      numeric(12,2) not null default 0,
  agreement_version     integer not null,                       -- the Campaign Agreement the creator accepted
  creator_agreed_at     timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  check (guaranteed_per_clip + cap_per_clip <= total_budget)
);
create index if not exists campaigns_creator_idx on public.campaigns (creator_id);
create index if not exists campaigns_open_idx on public.campaigns (created_at desc) where status = 'open';

-- host of an https URL, lower case; null for anything else (http, a user@host trick, a port, no host)
create or replace function public.money_url_host(p_url text)
returns text
language sql
immutable
as $$ select substring(lower(btrim(p_url)) from '^https://([a-z0-9][a-z0-9.-]*)(?:[/?#]|$)') $$;

create or replace function public.money_is_footage_host(p_host text)
returns boolean
language sql
immutable
as $$ select p_host is not null and (p_host = 'drive.google.com' or p_host = 'dropbox.com' or p_host like '%.dropbox.com') $$;

-- a payment handle is plain text: an email, @name or $cashtag. No URL, no deep link, no "paypal.me/...", no spaces.
create or replace function public.money_handle_ok(p_handle text)
returns boolean
language sql
immutable
as $$
  select p_handle is not null
     and p_handle ~ '^[A-Za-z0-9@$._+-]{2,64}$'
     and p_handle ~ '[A-Za-z0-9]'
     and lower(p_handle) !~ '(paypal\.me|paypal\.com|venmo\.com|cash\.app|cash\.me|https?|www\.)'
$$;

create or replace function public.campaigns_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p text;
  role_ text;
  cfg public.money_config;
begin
  new.title := btrim(new.title);
  new.description := btrim(new.description);
  new.footage_url := btrim(new.footage_url);
  new.payment_handle := btrim(new.payment_handle);
  select array_agg(distinct lower(x) order by lower(x)) into new.platforms from unnest(new.platforms) x;
  foreach p in array new.platforms loop
    if p not in ('tiktok', 'instagram', 'youtube', 'x') then raise exception 'unknown platform' using errcode = '22023'; end if;
  end loop;
  if tg_op = 'INSERT' or new.footage_url is distinct from old.footage_url then
    if not public.money_is_footage_host(public.money_url_host(new.footage_url)) then
      raise exception 'footage must be a Google Drive or Dropbox share link' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'INSERT' or new.payment_handle is distinct from old.payment_handle then
    if not public.money_handle_ok(new.payment_handle) then
      raise exception 'the payment handle must be plain text (an email, @name or $cashtag), not a link' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'INSERT' or new.title is distinct from old.title then perform public.text_check(new.title); end if;
  if tg_op = 'INSERT' or new.description is distinct from old.description then perform public.text_check(new.description); end if;
  if tg_op = 'INSERT' then
    if new.deadline <= now() + interval '1 hour' or new.deadline > now() + interval '366 days' then
      raise exception 'the deadline must be between 1 hour and a year from now' using errcode = '22023';
    end if;
    -- the creator must be able to use Money, be a creator, and have nothing overdue (spec 8). The check applies to SQL-editor
    -- inserts as well; auth.uid() is null there, so only the rules that do not need a user are skipped.
    if auth.uid() is not null then
      if not public.money_ready(new.creator_id) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
      role_ := public.money_role_of(new.creator_id);
      if role_ not in ('creator', 'both') then raise exception 'pick the creator role to post campaigns' using errcode = '42501'; end if;
    end if;
    if exists (select 1 from public.campaigns c where c.creator_id = new.creator_id and c.status = 'paused' and c.paused_reason = 'overdue_payment') then
      raise exception 'you have an overdue payment: resolve it before posting a new campaign' using errcode = '42501';
    end if;
    select * into cfg from public.money_config;
    new.agreement_version := coalesce(new.agreement_version, cfg.agreement_version);
  end if;
  return new;
end;
$$;
drop trigger if exists campaigns_validate on public.campaigns;
create trigger campaigns_validate before insert or update on public.campaigns
  for each row execute function public.campaigns_validate();

-- The terms freeze when the first clipper joins (terms_frozen_at). From then on none of these columns can change, by anyone with an
-- account; the owner in the SQL editor (no signed-in user) can still correct something by hand. Status and the budget numbers are the
-- system's and stay editable.
create or replace function public.campaigns_freeze_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.creator_id is distinct from old.creator_id and auth.uid() is not null then
    raise exception 'a campaign cannot change hands' using errcode = '42501';
  end if;
  if old.terms_frozen_at is not null and auth.uid() is not null then
    if new.terms_frozen_at is distinct from old.terms_frozen_at then
      raise exception 'terms are frozen' using errcode = '42501';
    end if;
    if (new.title, new.description, new.footage_url, new.rate_per_1k, new.cap_per_clip, new.total_budget, new.guaranteed_per_clip,
        new.platforms, new.view_window_days, new.min_views, new.payment_method, new.payment_handle, new.deadline, new.max_clips_per_clipper)
       is distinct from
       (old.title, old.description, old.footage_url, old.rate_per_1k, old.cap_per_clip, old.total_budget, old.guaranteed_per_clip,
        old.platforms, old.view_window_days, old.min_views, old.payment_method, old.payment_handle, old.deadline, old.max_clips_per_clipper) then
      raise exception 'terms are frozen once the first clipper has joined' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists campaigns_freeze_guard on public.campaigns;
create trigger campaigns_freeze_guard before update on public.campaigns
  for each row execute function public.campaigns_freeze_guard();

-- ══ 4. members, submissions, links ═══════════════════════════════════════════════════════════
create table if not exists public.campaign_members (
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  clipper_id    uuid not null references public.profiles(id) on delete cascade,
  joined_at     timestamptz not null default now(),
  agreed_terms  jsonb not null,                          -- the terms and agreement version the clipper saw when joining
  primary key (campaign_id, clipper_id)
);
create index if not exists campaign_members_clipper_idx on public.campaign_members (clipper_id);

create table if not exists public.campaign_submissions (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.campaigns(id) on delete cascade,
  clipper_id         uuid not null references public.profiles(id) on delete cascade,
  post_id            uuid references public.posts(id) on delete set null,      -- the Tryal post; null once it is deleted
  post_outcome       text not null default 'testing' check (post_outcome in ('queued', 'testing', 'survived', 'unjudged', 'failed', 'removed', 'ended')),
  status             text not null default 'posted' check (status in ('posted', 'awaiting_proof', 'awaiting_approval', 'disputed', 'approved', 'paid', 'unpaid', 'rejected')),
  views_claimed      integer check (views_claimed is null or views_claimed >= 0),
  likes_claimed      integer check (likes_claimed is null or likes_claimed >= 0),
  proof_paths        text[] not null default '{}' check (cardinality(proof_paths) <= 3),   -- 1-3 screenshots (the spec's proof_path)
  proof_uploaded_at  timestamptz,
  proof_waived       boolean not null default false,        -- proof was 3 days late: only the guaranteed amount is earned
  external_posted_at timestamptz,                           -- the view window starts here (first external link)
  window_ends_at     timestamptz,
  amount_owed        numeric(12,2),                          -- computed by money_compute_owed; apps cannot write it
  approved_at        timestamptz,
  approval_source    text check (approval_source is null or approval_source in ('creator', 'auto', 'admin')),
  payment_due_at     timestamptz,
  paid_marked_at     timestamptz,                            -- the creator's "I paid"
  received_at        timestamptz,                            -- the clipper's "Payment received": this is what counts
  flagged            boolean not null default false,
  admin_resolved_at  timestamptz,                            -- an admin settled a dispute or a "not paid" case (unlocks reviews)
  created_at         timestamptz not null default now()
);
create unique index if not exists campaign_submissions_post_uidx on public.campaign_submissions (post_id) where post_id is not null;
create index if not exists campaign_submissions_campaign_idx on public.campaign_submissions (campaign_id, clipper_id);
create index if not exists campaign_submissions_clipper_idx on public.campaign_submissions (clipper_id);

create table if not exists public.submission_links (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references public.campaign_submissions(id) on delete cascade,
  platform        text not null check (platform in ('tiktok', 'instagram', 'youtube', 'x')),
  url             text not null check (char_length(url) <= 500),
  account_age_days integer check (account_age_days is null or account_age_days >= 0),   -- entered by the clipper (fraud flag input)
  posted_at       timestamptz not null default now(),
  unique (submission_id, url)
);

create table if not exists public.submission_disputes (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.campaign_submissions(id) on delete cascade,
  raised_by      uuid not null references public.profiles(id) on delete cascade,
  reason         text not null check (reason in ('fake_views', 'wrong_content', 'not_my_campaign', 'proof_mismatch', 'other')),
  note           text check (note is null or char_length(note) <= 500),
  resolution     text check (resolution is null or resolution in ('approved', 'adjusted', 'rejected')),
  resolved_by    uuid references public.profiles(id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists submission_disputes_open_uidx on public.submission_disputes (submission_id) where resolved_at is null;

-- "Not paid": opened by the clipper, the creator may add a payment receipt screenshot, the clipper responds, an admin decides.
create table if not exists public.payment_cases (
  id                 uuid primary key default gen_random_uuid(),
  submission_id      uuid not null references public.campaign_submissions(id) on delete cascade,
  opened_by          uuid not null references public.profiles(id) on delete cascade,
  clipper_note       text check (clipper_note is null or char_length(clipper_note) <= 500),
  creator_receipt_paths text[] not null default '{}' check (cardinality(creator_receipt_paths) <= 3),
  creator_note       text check (creator_note is null or char_length(creator_note) <= 500),
  clipper_response   text check (clipper_response is null or char_length(clipper_response) <= 500),
  resolution         text check (resolution is null or resolution in ('paid', 'non_payment_confirmed', 'dismissed')),
  resolved_by        uuid references public.profiles(id) on delete set null,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now()
);
create unique index if not exists payment_cases_open_uidx on public.payment_cases (submission_id) where resolved_at is null;

-- ══ 5. reviews and strikes ═══════════════════════════════════════════════════════════════════
create table if not exists public.money_reviews (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.campaign_submissions(id) on delete cascade,
  reviewer_id    uuid not null references public.profiles(id) on delete cascade,
  reviewee_id    uuid not null references public.profiles(id) on delete cascade,
  role           text not null check (role in ('creator', 'clipper')),      -- the REVIEWER's role in the deal
  stars          integer not null check (stars between 1 and 5),
  tags           text[] not null default '{}' check (cardinality(tags) <= 6),
  comment        text check (comment is null or char_length(comment) <= 280),
  published_at   timestamptz,                                               -- null until both are in or the reveal days pass
  created_at     timestamptz not null default now(),
  unique (submission_id, role),
  check (reviewer_id <> reviewee_id)
);
create index if not exists money_reviews_reviewee_idx on public.money_reviews (reviewee_id) where published_at is not null;

create table if not exists public.money_strikes (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  kind           text not null check (kind in ('late_payment', 'non_payment', 'fake_views')),
  submission_id  uuid references public.campaign_submissions(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now()
);
create index if not exists money_strikes_user_idx on public.money_strikes (user_id, kind);

-- 2 late payments, or 1 confirmed non-payment, or confirmed fake views: money_banned, and a banned creator's campaigns pause.
create or replace function public.money_strike_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.money_config;
  late integer;
  ban boolean := false;
begin
  select * into cfg from public.money_config;
  if new.kind in ('non_payment', 'fake_views') then
    ban := true;
  else
    select count(*) into late from public.money_strikes where user_id = new.user_id and kind = 'late_payment';
    ban := late >= cfg.late_strikes_to_ban;
  end if;
  if ban then
    update public.profiles set money_banned = true where id = new.user_id and not money_banned;
    if found then
      insert into public.moderation_log (actor, action, target_user, detail)
      values (null, 'money_ban', new.user_id, jsonb_build_object('strike', new.kind, 'strike_id', new.id));
    end if;
    update public.campaigns set status = 'paused', paused_reason = 'creator_banned'
     where creator_id = new.user_id and status = 'open';
  end if;
  return new;
end;
$$;
drop trigger if exists money_strike_apply on public.money_strikes;
create trigger money_strike_apply after insert on public.money_strikes
  for each row execute function public.money_strike_apply();

-- ══ 6. posts: campaign, clipped_for, edited_in_tryal ═════════════════════════════════════════
alter table public.posts add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
alter table public.posts add column if not exists clipped_for_user_id uuid references public.profiles(id) on delete set null;
alter table public.posts add column if not exists edited_in_tryal boolean not null default false;
create index if not exists posts_campaign_idx on public.posts (campaign_id) where campaign_id is not null;

-- ══ 7. helpers for the policies (bound to the signed-in user: an app can only ask about itself) ═══
-- Every function an RLS policy calls must be executable by apps, so these take the subject from auth.uid(), not from an argument.
create or replace function public.money_ready_me()
returns boolean language sql stable security definer set search_path = public
as $$ select public.money_ready(auth.uid()) $$;

create or replace function public.money_blocked_with_me(p_other uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select p_other is not null and exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = p_other) or (b.blocker_id = p_other and b.blocked_id = auth.uid()))
$$;

create or replace function public.money_is_creator_me(p_campaign uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.campaigns c where c.id = p_campaign and c.creator_id = auth.uid()) $$;

create or replace function public.money_is_member_me(p_campaign uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.campaign_members m where m.campaign_id = p_campaign and m.clipper_id = auth.uid()) $$;

-- Browse: open, before its deadline, the creator still allowed (adult, not banned, not sanctioned), and no block between us
create or replace function public.money_campaign_listable_me(p_campaign uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.money_ready(auth.uid()) and exists (
    select 1 from public.campaigns c
    where c.id = p_campaign and c.status = 'open' and c.deadline > now()
      and public.money_is_adult(c.creator_id)
      and not exists (select 1 from public.profiles p where p.id = c.creator_id and p.money_banned)
      and not exists (select 1 from public.account_sanction_of(c.creator_id))
      and not public.money_blocked_with_me(c.creator_id))
$$;

-- the creator's or the clipper's side of a submission, for the signed-in user (the other side is hidden when they blocked me / I blocked them)
create or replace function public.money_submission_visible_me(p_submission uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select public.money_ready(auth.uid()) and exists (
    select 1 from public.campaign_submissions s join public.campaigns c on c.id = s.campaign_id
    where s.id = p_submission
      and (s.clipper_id = auth.uid() or (c.creator_id = auth.uid() and not public.money_blocked_with_me(s.clipper_id))))
$$;

create or replace function public.money_admin_me()
returns boolean language sql stable security definer set search_path = public
as $$ select public.mod_is_admin() $$;

revoke all on function public.money_ready_me(), public.money_blocked_with_me(uuid), public.money_is_creator_me(uuid), public.money_is_member_me(uuid),
  public.money_campaign_listable_me(uuid), public.money_submission_visible_me(uuid), public.money_admin_me() from public, anon;
grant execute on function public.money_ready_me(), public.money_blocked_with_me(uuid), public.money_is_creator_me(uuid), public.money_is_member_me(uuid),
  public.money_campaign_listable_me(uuid), public.money_submission_visible_me(uuid), public.money_admin_me() to authenticated;

-- ══ 8. row level security: read-only for apps ════════════════════════════════════════════════
alter table public.campaigns            enable row level security;
alter table public.campaign_members     enable row level security;
alter table public.campaign_submissions enable row level security;
alter table public.submission_links     enable row level security;
alter table public.submission_disputes  enable row level security;
alter table public.payment_cases        enable row level security;
alter table public.money_reviews        enable row level security;
alter table public.money_strikes        enable row level security;

revoke all on table public.campaigns, public.campaign_members, public.campaign_submissions, public.submission_links,
  public.submission_disputes, public.payment_cases, public.money_reviews, public.money_strikes from anon, authenticated;

-- campaigns: every column except payment_handle (members read it through campaign_payment_info)
grant select (id, creator_id, title, description, footage_url, rate_per_1k, cap_per_clip, total_budget, guaranteed_per_clip, platforms,
  view_window_days, min_views, payment_method, deadline, max_clips_per_clipper, status, paused_reason, closed_reason, terms_frozen_at,
  budget_committed, agreement_version, creator_agreed_at, created_at) on public.campaigns to authenticated;
grant select on public.campaign_members, public.campaign_submissions, public.submission_links, public.submission_disputes,
  public.payment_cases, public.money_reviews, public.money_strikes to authenticated;

drop policy if exists campaigns_read on public.campaigns;
create policy campaigns_read on public.campaigns for select to authenticated using (
  public.money_admin_me()
  or (public.money_ready_me() and (creator_id = auth.uid() or public.money_is_member_me(id) or public.money_campaign_listable_me(id))));

drop policy if exists members_read on public.campaign_members;
create policy members_read on public.campaign_members for select to authenticated using (
  public.money_admin_me()
  or (public.money_ready_me() and (clipper_id = auth.uid() or (public.money_is_creator_me(campaign_id) and not public.money_blocked_with_me(clipper_id)))));

drop policy if exists submissions_read on public.campaign_submissions;
create policy submissions_read on public.campaign_submissions for select to authenticated using (
  public.money_admin_me() or public.money_submission_visible_me(id));

drop policy if exists links_read on public.submission_links;
create policy links_read on public.submission_links for select to authenticated using (
  public.money_admin_me() or public.money_submission_visible_me(submission_id));

drop policy if exists disputes_read on public.submission_disputes;
create policy disputes_read on public.submission_disputes for select to authenticated using (
  public.money_admin_me() or public.money_submission_visible_me(submission_id));

drop policy if exists payment_cases_read on public.payment_cases;
create policy payment_cases_read on public.payment_cases for select to authenticated using (
  public.money_admin_me() or public.money_submission_visible_me(submission_id));

-- reviews: published ones to any ready adult (not between blocked people); an unpublished one only to its writer, so reviews stay blind
drop policy if exists reviews_read on public.money_reviews;
create policy reviews_read on public.money_reviews for select to authenticated using (
  public.money_admin_me()
  or (public.money_ready_me() and (reviewer_id = auth.uid()
      or (published_at is not null and not public.money_blocked_with_me(reviewer_id) and not public.money_blocked_with_me(reviewee_id)))));

drop policy if exists strikes_read on public.money_strikes;
create policy strikes_read on public.money_strikes for select to authenticated using (
  public.money_admin_me() or (public.money_ready_me() and user_id = auth.uid()));

-- ══ 9. members: who may join, and the first join freezes the terms ═══════════════════════════
create or replace function public.money_member_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c public.campaigns;
begin
  select * into c from public.campaigns where id = new.campaign_id for update;
  if not found then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  if new.clipper_id = c.creator_id then raise exception 'you cannot join your own campaign' using errcode = '42501'; end if;
  if auth.uid() is not null then
    if not public.money_ready(new.clipper_id) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
    if public.money_role_of(new.clipper_id) not in ('clipper', 'both') then raise exception 'pick the clipper role to join campaigns' using errcode = '42501'; end if;
  end if;
  if exists (select 1 from public.user_blocks b where (b.blocker_id = c.creator_id and b.blocked_id = new.clipper_id)
                                                   or (b.blocker_id = new.clipper_id and b.blocked_id = c.creator_id)) then
    raise exception 'you cannot join this campaign' using errcode = '42501';
  end if;
  if c.status <> 'open' or c.deadline <= now() or c.budget_committed >= c.total_budget then
    raise exception 'this campaign is not open' using errcode = '42501';
  end if;
  if not public.money_is_adult(c.creator_id)
     or exists (select 1 from public.profiles p where p.id = c.creator_id and p.money_banned) then
    raise exception 'this campaign is not open' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists money_member_guard on public.campaign_members;
create trigger money_member_guard before insert on public.campaign_members
  for each row execute function public.money_member_guard();

create or replace function public.money_member_freeze()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.campaigns set terms_frozen_at = now() where id = new.campaign_id and terms_frozen_at is null;
  return new;
end;
$$;
drop trigger if exists money_member_freeze on public.campaign_members;
create trigger money_member_freeze after insert on public.campaign_members
  for each row execute function public.money_member_freeze();

-- ══ 10. submissions: what makes one allowed, the owed amount, the budget ═════════════════════
-- owed = guaranteed + (views >= min_views ? min(views / 1000 * rate, cap) : 0), rounded to cents. proof_waived (proof was 3 days late)
-- earns the guaranteed amount only. null until the views are known.
create or replace function public.money_compute_owed(p_campaign uuid, p_views integer, p_waived boolean)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_waived then round(c.guaranteed_per_clip, 2)
    when p_views is null then null
    else round(c.guaranteed_per_clip + case when p_views >= c.min_views then least((p_views::numeric / 1000) * c.rate_per_1k, c.cap_per_clip) else 0 end, 2)
  end
  from public.campaigns c where c.id = p_campaign
$$;

-- One check, used by the posts trigger (so a bad post is refused before it exists) and the submissions trigger (so no other path gets in):
-- a member, an open campaign before its deadline with budget left, and the clipper under max_clips_per_clipper. Submissions count from the
-- moment the post is created, queued or not. Serialised per campaign + clipper so two quick posts cannot both squeeze under the limit.
create or replace function public.money_check_can_submit(p_campaign uuid, p_clipper uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.campaigns;
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('money_submit:' || p_campaign::text || ':' || p_clipper::text, 0));
  select * into c from public.campaigns where id = p_campaign;
  if not found then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.campaign_members m where m.campaign_id = p_campaign and m.clipper_id = p_clipper) then
    raise exception 'join the campaign before submitting a clip' using errcode = '42501';
  end if;
  if not public.money_ready(p_clipper) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if c.status <> 'open' or c.deadline <= now() or c.budget_committed >= c.total_budget then
    raise exception 'this campaign is not accepting clips' using errcode = '42501';
  end if;
  select count(*) into n from public.campaign_submissions where campaign_id = p_campaign and clipper_id = p_clipper;
  if n >= c.max_clips_per_clipper then raise exception 'you have reached the clip limit for this campaign' using errcode = '42501'; end if;
end;
$$;

create or replace function public.money_submission_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.money_check_can_submit(new.campaign_id, new.clipper_id);
  return new;
end;
$$;
drop trigger if exists money_submission_guard on public.campaign_submissions;
create trigger money_submission_guard before insert on public.campaign_submissions
  for each row execute function public.money_submission_guard();

-- amount_owed is always recomputed: whatever a caller writes into it is replaced
create or replace function public.money_submission_calc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.amount_owed := public.money_compute_owed(new.campaign_id, new.views_claimed, new.proof_waived);
  return new;
end;
$$;
drop trigger if exists money_submission_calc on public.campaign_submissions;
create trigger money_submission_calc before insert or update on public.campaign_submissions
  for each row execute function public.money_submission_calc();

-- budget_committed = the owed amounts of approved clips (approved, paid, unpaid). A full budget closes the campaign to new clips.
create or replace function public.money_budget_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid := coalesce(new.campaign_id, old.campaign_id);
  total numeric;
begin
  select coalesce(sum(amount_owed), 0) into total from public.campaign_submissions
   where campaign_id = cid and status in ('approved', 'paid', 'unpaid');
  update public.campaigns
     set budget_committed = total,
         status = case when total >= total_budget and status = 'open' then 'closed' else status end,
         closed_reason = case when total >= total_budget and status = 'open' then 'budget' else closed_reason end
   where id = cid and (budget_committed is distinct from total or (total >= total_budget and status = 'open'));
  return null;
end;
$$;
drop trigger if exists money_budget_sync on public.campaign_submissions;
create trigger money_budget_sync after insert or update or delete on public.campaign_submissions
  for each row execute function public.money_budget_sync();

-- ══ 11. posts: a clip posted for a campaign becomes a submission ═════════════════════════════
-- BEFORE INSERT: the server decides clipped_for_user_id (never the client) and edited_in_tryal (false until step 3 adds the editor-session
-- proof), and refuses the post when the clipper could not submit. A campaign post is a root post (never a reaction).
create or replace function public.money_post_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare creator uuid;
begin
  if new.campaign_id is null then
    new.clipped_for_user_id := null;
    new.edited_in_tryal := false;
    return new;
  end if;
  if new.parent_post_id is not null then raise exception 'a reaction cannot be a campaign clip' using errcode = '22023'; end if;
  select c.creator_id into creator from public.campaigns c where c.id = new.campaign_id;
  if creator is null then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  perform public.money_check_can_submit(new.campaign_id, new.user_id);
  new.clipped_for_user_id := creator;
  new.edited_in_tryal := false;
  return new;
end;
$$;
drop trigger if exists zzzz_money_post_guard on public.posts;
create trigger zzzz_money_post_guard before insert on public.posts
  for each row execute function public.money_post_guard();

-- AFTER INSERT: the submission, status 'posted' (the post may still be queued behind the creator's two live posts: it counts anyway)
create or replace function public.money_post_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.campaign_id is null then return new; end if;
  insert into public.campaign_submissions (campaign_id, clipper_id, post_id, post_outcome)
  values (new.campaign_id, new.user_id, new.id, case when new.status = 'queued' then 'queued' else 'testing' end);
  return new;
end;
$$;
drop trigger if exists zzzz_money_post_submission on public.posts;
create trigger zzzz_money_post_submission after insert on public.posts
  for each row execute function public.money_post_submission();

-- the submission follows the post: queued -> testing -> survived / unjudged; a failed post is deleted (outcome 'failed'); anything else
-- that removes it is 'removed'. The submission itself stays and keeps counting toward the clip limit.
create or replace function public.money_post_outcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.campaign_submissions
     set post_outcome = case new.status when 'queued' then 'queued' when 'trial' then 'testing' when 'survived' then 'survived'
                                        when 'unjudged' then 'unjudged' else 'ended' end
   where post_id = new.id;
  return null;
end;
$$;
drop trigger if exists money_post_outcome on public.posts;
create trigger money_post_outcome after update of status on public.posts
  for each row when (new.campaign_id is not null and new.status is distinct from old.status)
  execute function public.money_post_outcome();

create or replace function public.money_post_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.campaign_submissions
     set post_outcome = case when exists (select 1 from public.trial_post_state s where s.post_id = old.id and s.decision = 'failed') then 'failed' else 'removed' end
   where post_id = old.id;
  return old;
end;
$$;
drop trigger if exists money_post_deleted on public.posts;
create trigger money_post_deleted before delete on public.posts
  for each row when (old.campaign_id is not null)
  execute function public.money_post_deleted();

-- ══ 12. text on Money objects goes through the same word filter as posts ═════════════════════
create or replace function public.money_text_filter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'submission_disputes' then
    perform public.text_check(new.note);
  elsif tg_table_name = 'payment_cases' then
    perform public.text_check(new.clipper_note); perform public.text_check(new.creator_note); perform public.text_check(new.clipper_response);
  elsif tg_table_name = 'money_reviews' then
    perform public.text_check(new.comment);
  end if;
  return new;
end;
$$;
drop trigger if exists money_text_filter on public.submission_disputes;
create trigger money_text_filter before insert or update on public.submission_disputes for each row execute function public.money_text_filter();
drop trigger if exists money_text_filter on public.payment_cases;
create trigger money_text_filter before insert or update on public.payment_cases for each row execute function public.money_text_filter();
drop trigger if exists money_text_filter on public.money_reviews;
create trigger money_text_filter before insert or update on public.money_reviews for each row execute function public.money_text_filter();

-- ══ 13. reviews: who may write one, and they never change ════════════════════════════════════
create or replace function public.money_review_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.campaign_submissions;
  creator uuid;
begin
  if tg_op = 'UPDATE' then
    -- immutable; only the publishing job (no signed-in user) or an admin may set published_at
    if (new.submission_id, new.reviewer_id, new.reviewee_id, new.role, new.stars, new.tags, new.comment)
       is distinct from (old.submission_id, old.reviewer_id, old.reviewee_id, old.role, old.stars, old.tags, old.comment) then
      raise exception 'reviews cannot be edited' using errcode = '42501';
    end if;
    if new.published_at is distinct from old.published_at and auth.uid() is not null and not public.mod_is_admin() then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    return new;
  end if;
  select * into s from public.campaign_submissions where id = new.submission_id;
  select creator_id into creator from public.campaigns where id = s.campaign_id;
  if new.role = 'creator' and not (new.reviewer_id = creator and new.reviewee_id = s.clipper_id) then
    raise exception 'a creator review is about the clipper' using errcode = '22023';
  end if;
  if new.role = 'clipper' and not (new.reviewer_id = s.clipper_id and new.reviewee_id = creator) then
    raise exception 'a clipper review is about the creator' using errcode = '22023';
  end if;
  if not (s.status = 'paid' or (s.status in ('unpaid', 'rejected') and s.admin_resolved_at is not null)) then
    raise exception 'reviews unlock once the clip is paid or an admin has settled it' using errcode = '42501';
  end if;
  new.published_at := null;     -- always blind at first
  return new;
end;
$$;
drop trigger if exists money_review_guard on public.money_reviews;
create trigger money_review_guard before insert or update on public.money_reviews
  for each row execute function public.money_review_guard();

-- ══ 14. reports: Money objects use the existing reports table ════════════════════════════════
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
      check (target_type in ('post', 'reaction', 'message', 'campaign', 'submission', 'money_review', 'money_user'));
  end if;
end $$;

-- a Money report needs a Money-ready reporter who can see the target, never under-18s
create or replace function public.money_report_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare ok boolean := false;
begin
  if new.target_type not in ('campaign', 'submission', 'money_review', 'money_user') then return new; end if;
  if not public.money_ready(new.reporter_id) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if new.target_type = 'campaign' then
    ok := exists (select 1 from public.campaigns c where c.id = new.target_id and c.creator_id <> new.reporter_id
                  and not exists (select 1 from public.user_blocks b where (b.blocker_id = c.creator_id and b.blocked_id = new.reporter_id)));
  elsif new.target_type = 'submission' then
    ok := exists (select 1 from public.campaign_submissions s join public.campaigns c on c.id = s.campaign_id
                  where s.id = new.target_id and (c.creator_id = new.reporter_id or s.clipper_id = new.reporter_id) and s.clipper_id <> c.creator_id);
  elsif new.target_type = 'money_review' then
    ok := exists (select 1 from public.money_reviews r where r.id = new.target_id and r.published_at is not null and r.reviewer_id <> new.reporter_id);
  else
    ok := exists (select 1 from public.profiles p where p.id = new.target_id) and new.target_id <> new.reporter_id;
  end if;
  if not ok then raise exception 'you cannot report this' using errcode = '42501'; end if;
  return new;
end;
$$;
drop trigger if exists money_report_guard on public.reports;
create trigger money_report_guard before insert on public.reports
  for each row execute function public.money_report_guard();

-- ══ 15. the client-facing functions (writes go through these) ═══════════════════════════════
create or replace function public.money_require_ready(p_role text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not public.money_ready(me) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if p_role = 'creator' and public.money_role_of(me) not in ('creator', 'both') then raise exception 'pick the creator role to do this' using errcode = '42501'; end if;
  if p_role = 'clipper' and public.money_role_of(me) not in ('clipper', 'both') then raise exception 'pick the clipper role to do this' using errcode = '42501'; end if;
  return me;
end;
$$;

create or replace function public.money_create_campaign(
  p_title text, p_description text, p_footage_url text, p_rate_per_1k numeric, p_cap_per_clip numeric, p_total_budget numeric,
  p_guaranteed_per_clip numeric, p_platforms text[], p_view_window_days integer, p_min_views integer, p_payment_method text,
  p_payment_handle text, p_deadline timestamptz, p_max_clips_per_clipper integer, p_agree boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  cid uuid;
begin
  if p_agree is not true then raise exception 'accept the Campaign Agreement to post' using errcode = '22023'; end if;
  insert into public.campaigns (creator_id, title, description, footage_url, rate_per_1k, cap_per_clip, total_budget, guaranteed_per_clip,
                                platforms, view_window_days, min_views, payment_method, payment_handle, deadline, max_clips_per_clipper, agreement_version)
  values (me, p_title, p_description, p_footage_url, p_rate_per_1k, p_cap_per_clip, p_total_budget, coalesce(p_guaranteed_per_clip, 0),
          p_platforms, coalesce(p_view_window_days, 7), coalesce(p_min_views, 1000), p_payment_method, p_payment_handle, p_deadline,
          coalesce(p_max_clips_per_clipper, 5), (select agreement_version from public.money_config))
  returning id into cid;
  return cid;
end;
$$;

-- edit a campaign BEFORE the first clipper joins (afterwards the freeze trigger refuses)
create or replace function public.money_update_campaign(p_campaign uuid, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  c public.campaigns;
  r public.campaigns;
  k text;
  allowed text[] := array['title', 'description', 'footage_url', 'rate_per_1k', 'cap_per_clip', 'total_budget', 'guaranteed_per_clip', 'platforms',
                          'view_window_days', 'min_views', 'payment_method', 'payment_handle', 'deadline', 'max_clips_per_clipper'];
begin
  select * into c from public.campaigns where id = p_campaign and creator_id = me for update;
  if not found then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  if c.terms_frozen_at is not null then raise exception 'terms are frozen once the first clipper has joined' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(coalesce(p_changes, '{}'::jsonb)) loop
    if not (k = any (allowed)) then raise exception 'cannot change %', k using errcode = '22023'; end if;
  end loop;
  r := jsonb_populate_record(c, p_changes);
  update public.campaigns set
    title = r.title, description = r.description, footage_url = r.footage_url, rate_per_1k = r.rate_per_1k, cap_per_clip = r.cap_per_clip,
    total_budget = r.total_budget, guaranteed_per_clip = r.guaranteed_per_clip, platforms = r.platforms, view_window_days = r.view_window_days,
    min_views = r.min_views, payment_method = r.payment_method, payment_handle = r.payment_handle, deadline = r.deadline,
    max_clips_per_clipper = r.max_clips_per_clipper
  where id = p_campaign;
end;
$$;

-- the creator closes (or pauses / reopens) their own campaign; the system's pauses (overdue payment, banned) are not theirs to lift
create or replace function public.money_set_campaign_status(p_campaign uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('creator');
  c public.campaigns;
begin
  if p_status not in ('open', 'paused', 'closed') then raise exception 'unknown status' using errcode = '22023'; end if;
  select * into c from public.campaigns where id = p_campaign and creator_id = me for update;
  if not found then raise exception 'unknown campaign' using errcode = 'P0002'; end if;
  if c.status = 'closed' then raise exception 'a closed campaign stays closed' using errcode = '42501'; end if;
  if c.status = 'paused' and c.paused_reason is distinct from 'creator' then raise exception 'this campaign is paused by Tryal' using errcode = '42501'; end if;
  if p_status = 'open' and (c.deadline <= now() or c.budget_committed >= c.total_budget) then raise exception 'this campaign cannot reopen' using errcode = '42501'; end if;
  update public.campaigns
     set status = p_status,
         paused_reason = case p_status when 'paused' then 'creator' else null end,
         closed_reason = case p_status when 'closed' then 'creator' else closed_reason end
   where id = p_campaign;
end;
$$;

-- join: the terms the clipper saw are stored with the membership; the first join freezes them (trigger)
create or replace function public.money_join_campaign(p_campaign uuid, p_agree boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.money_require_ready('clipper');
  c public.campaigns;
begin
  if p_agree is not true then raise exception 'accept the Clipper Agreement to join' using errcode = '22023'; end if;
  select * into c from public.campaigns where id = p_campaign;
  if not found or not public.money_campaign_listable_me(p_campaign) then raise exception 'this campaign is not open' using errcode = '42501'; end if;
  insert into public.campaign_members (campaign_id, clipper_id, agreed_terms)
  values (p_campaign, me, jsonb_build_object(
    'rate_per_1k', c.rate_per_1k, 'cap_per_clip', c.cap_per_clip, 'guaranteed_per_clip', c.guaranteed_per_clip, 'total_budget', c.total_budget,
    'min_views', c.min_views, 'view_window_days', c.view_window_days, 'platforms', c.platforms, 'deadline', c.deadline,
    'max_clips_per_clipper', c.max_clips_per_clipper, 'payment_method', c.payment_method, 'footage_url', c.footage_url,
    'clipper_agreement_version', (select agreement_version from public.money_config), 'agreed_at', now()))
  on conflict do nothing;
end;
$$;

-- the creator's payment handle (plain text, shown to members and the creator only)
create or replace function public.campaign_payment_info(p_campaign uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  c public.campaigns;
begin
  if me is null or not public.money_ready(me) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  select * into c from public.campaigns where id = p_campaign;
  if not found or not (c.creator_id = me or public.money_is_member_me(p_campaign)) then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('payment_method', c.payment_method, 'payment_handle', c.payment_handle);
end;
$$;

-- the owner bans / unbans an account's Money access (the review queue screen comes in a later step); logged like every moderation action
create or replace function public.admin_money_set_banned(p_user uuid, p_banned boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.profiles set money_banned = coalesce(p_banned, false) where id = p_user;
  if not found then raise exception 'unknown user' using errcode = 'P0002'; end if;
  if p_banned then
    update public.campaigns set status = 'paused', paused_reason = 'creator_banned' where creator_id = p_user and status = 'open';
  end if;
  insert into public.moderation_log (actor, action, target_user, detail)
  values (auth.uid(), case when p_banned then 'money_ban' else 'money_unban' end, p_user, jsonb_build_object('reason', p_reason));
end;
$$;

-- reputation: published reviews only, plus the creator's payment record (paid / approved, average days to pay, late count)
create or replace function public.money_profile_stats(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  stars numeric;
  n integer;
  approved integer;
  paid integer;
  days numeric;
  late integer;
begin
  if me is null or not public.money_ready(me) then raise exception 'Money is not available for this account' using errcode = '42501'; end if;
  if p_user is null or not public.money_is_adult(p_user) then return null; end if;
  select round(avg(r.stars)::numeric, 1), count(*) into stars, n from public.money_reviews r where r.reviewee_id = p_user and r.published_at is not null;
  select count(*) filter (where s.status in ('approved', 'paid', 'unpaid')),
         count(*) filter (where s.status = 'paid'),
         round((avg(extract(epoch from (coalesce(s.paid_marked_at, s.received_at) - s.approved_at)) / 86400)
               filter (where s.status = 'paid' and s.approved_at is not null and coalesce(s.paid_marked_at, s.received_at) is not null))::numeric, 1)
    into approved, paid, days
    from public.campaign_submissions s join public.campaigns c on c.id = s.campaign_id where c.creator_id = p_user;
  select count(*) into late from public.money_strikes where user_id = p_user and kind = 'late_payment';
  return jsonb_build_object('rating_avg', stars, 'rating_count', n, 'approved_count', approved, 'paid_count', paid, 'avg_days_to_pay', days, 'late_count', late);
end;
$$;

revoke all on function public.money_complete_onboarding(text, text[]), public.my_money_profile(), public.money_create_campaign(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean),
  public.money_update_campaign(uuid, jsonb), public.money_set_campaign_status(uuid, text), public.money_join_campaign(uuid, boolean),
  public.campaign_payment_info(uuid), public.money_profile_stats(uuid), public.admin_money_set_banned(uuid, boolean, text) from public, anon;
grant execute on function public.money_complete_onboarding(text, text[]), public.my_money_profile(), public.money_create_campaign(text, text, text, numeric, numeric, numeric, numeric, text[], integer, integer, text, text, timestamptz, integer, boolean),
  public.money_update_campaign(uuid, jsonb), public.money_set_campaign_status(uuid, text), public.money_join_campaign(uuid, boolean),
  public.campaign_payment_info(uuid), public.money_profile_stats(uuid), public.admin_money_set_banned(uuid, boolean, text) to authenticated;
revoke all on function public.my_features() from public, anon;
grant execute on function public.my_features() to authenticated;

-- internals: not callable by apps
revoke all on function public.money_allowed(uuid), public.money_ready(uuid), public.money_role_of(uuid), public.money_required_rules(text),
  public.money_url_host(text), public.money_is_footage_host(text), public.money_handle_ok(text), public.money_compute_owed(uuid, integer, boolean),
  public.money_check_can_submit(uuid, uuid), public.money_require_ready(text), public.campaigns_validate(), public.campaigns_freeze_guard(),
  public.money_member_guard(), public.money_member_freeze(), public.money_submission_guard(), public.money_submission_calc(), public.money_budget_sync(),
  public.money_post_guard(), public.money_post_submission(), public.money_post_outcome(), public.money_post_deleted(), public.money_text_filter(),
  public.money_review_guard(), public.money_report_guard(), public.money_strike_apply(), public.profiles_money_banned_guard() from public, anon, authenticated;

-- ══ 16. the private bucket for view proof and payment receipts ═══════════════════════════════
-- Path: <submission id>/proof/<file> (the clipper, 1-3 screenshots) or <submission id>/receipt/<file> (the creator). Readable by the clipper,
-- the creator and admins. Apps can add files but never change or delete them (evidence). Images only, small.
create or replace function public.money_proof_access(p_name text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  sid uuid;
  kind text := split_part(p_name, '/', 2);
  s public.campaign_submissions;
  creator uuid;
begin
  if me is null then return false; end if;
  begin sid := split_part(p_name, '/', 1)::uuid; exception when others then return false; end;
  if not p_write and public.mod_is_admin() then return true; end if;
  if not public.money_ready(me) then return false; end if;
  select * into s from public.campaign_submissions where id = sid;
  if not found then return false; end if;
  select creator_id into creator from public.campaigns where id = s.campaign_id;
  if p_write then
    return (kind = 'proof' and s.clipper_id = me) or (kind = 'receipt' and creator = me);
  end if;
  return s.clipper_id = me or (creator = me and not public.money_blocked_with_me(s.clipper_id));
end;
$$;
revoke all on function public.money_proof_access(text, boolean) from public, anon;
grant execute on function public.money_proof_access(text, boolean) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is not null and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('money-proof', 'money-proof', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
    on conflict (id) do update set public = false, file_size_limit = 8388608, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
    drop policy if exists "money proof read" on storage.objects;
    create policy "money proof read" on storage.objects for select to authenticated
      using (bucket_id = 'money-proof' and public.money_proof_access(name, false));
    drop policy if exists "money proof add" on storage.objects;
    create policy "money proof add" on storage.objects for insert to authenticated
      with check (bucket_id = 'money-proof' and public.money_proof_access(name, true));
  end if;
end $$;

-- ══ 17. the birthdate lock-down: new profile columns need a re-grant once it is on ═══════════
do $$
begin
  if exists (select 1 from public.app_flags where key = 'birthdate_lockdown' and enabled) then
    perform public.money_refresh_profile_grants();
  end if;
end $$;
