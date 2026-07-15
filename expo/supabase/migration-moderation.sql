-- DropDay: Content reporting & moderation
-- Run this in the Supabase SQL editor.
-- Required for App Store Guideline 1.2 (user-generated content moderation).

-- ============================================================================
-- 1. Add moderation_status column to posts (covers both Drops and reactions)
-- ============================================================================
alter table public.posts
  add column if not exists moderation_status text not null default 'active'
  check (moderation_status in ('active', 'hidden', 'removed'));

create index if not exists posts_moderation_status_idx
  on public.posts (moderation_status);

-- ============================================================================
-- 2. Reports table
-- ============================================================================
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post', 'reaction')),
  target_id uuid not null,
  reason text not null check (reason in ('spam', 'harassment', 'nudity', 'other')),
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'dismissed')),
  created_at timestamptz default now()
);

create index if not exists reports_target_idx
  on public.reports (target_type, target_id);
create index if not exists reports_status_idx
  on public.reports (status);
create index if not exists reports_reporter_idx
  on public.reports (reporter_id);

-- Prevent a user from submitting duplicate reports for the same target
create unique index if not exists reports_unique_report
  on public.reports (reporter_id, target_type, target_id);

alter table public.reports enable row level security;

-- Any authenticated user can report content
drop policy if exists "users can submit reports" on public.reports;
create policy "users can submit reports"
  on public.reports for insert
  with check (auth.uid() = reporter_id);

-- Users can see their own reports (for "already reported" UI state)
drop policy if exists "users can view own reports" on public.reports;
create policy "users can view own reports"
  on public.reports for select
  using (auth.uid() = reporter_id);

-- Users can delete their own reports (withdraw a report)
drop policy if exists "users can delete own reports" on public.reports;
create policy "users can delete own reports"
  on public.reports for delete
  using (auth.uid() = reporter_id);

-- ============================================================================
-- 3. Auto-hide trigger: when a post accumulates 3+ reports, set moderation_status to 'hidden'
-- ============================================================================
create or replace function auto_hide_reported_content()
returns trigger as $$
declare
  report_count integer;
  target_id_val uuid;
begin
  target_id_val := new.target_id;

  select count(*) into report_count
  from public.reports
  where target_id = target_id_val
    and status = 'pending';

  if report_count >= 3 then
    update public.posts
    set moderation_status = 'hidden'
    where id = target_id_val
      and moderation_status = 'active';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_auto_hide_reported on public.reports;
create trigger trg_auto_hide_reported
  after insert on public.reports
  for each row
  execute function auto_hide_reported_content();

-- ============================================================================
-- 4. Block users table (required by Apple as distinct from content reporting)
-- ============================================================================
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists user_blocks_blocker_idx on public.user_blocks (blocker_id);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

drop policy if exists "users can view own blocks" on public.user_blocks;
create policy "users can view own blocks"
  on public.user_blocks for select
  using (auth.uid() = blocker_id);

drop policy if exists "users can insert own blocks" on public.user_blocks;
create policy "users can insert own blocks"
  on public.user_blocks for insert
  with check (auth.uid() = blocker_id);

drop policy if exists "users can delete own blocks" on public.user_blocks;
create policy "users can delete own blocks"
  on public.user_blocks for delete
  using (auth.uid() = blocker_id);

-- ============================================================================
-- 5. Update RLS policies on posts to filter hidden/removed content
--    Replace the existing "posts are readable by everyone" policy so that
--    only active posts are visible to non-owners. Owners can still see
--    their own hidden posts (so they know their content was moderated).
-- ============================================================================
drop policy if exists "posts are readable by everyone" on public.posts;
create policy "posts are readable by everyone"
  on public.posts for select
  using (
    moderation_status = 'active'
    or auth.uid() = user_id
  );

-- ============================================================================
-- 6. Grant access to reports table
-- ============================================================================
grant usage on schema public to anon, authenticated;
grant select, insert, delete on public.reports to authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
