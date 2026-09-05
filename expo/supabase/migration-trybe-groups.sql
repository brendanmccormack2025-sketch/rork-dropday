-- ============================================================================
-- Trybe: public group feeds + membership
-- Run this in the Supabase SQL editor (after migration-friend-groups.sql).
--
-- What this does:
--   1. groups        — adds avatar_url + created_by, makes groups publicly readable
--   2. group_members — adds status (invited/accepted/declined/left), invited_by,
--                      responded_at; enforces ONE accepted group per user and a
--                      10-member cap per group
--   3. posts         — adds group_id + view_count; like_count kept in sync with
--                      the likes table via trigger; group-post insert restricted
--                      to accepted members
--   4. RPC           — increment_post_view(post_id) for Trybe/Home view counting
--   5. Data migration— old group_posts / group_post_reactions rows are copied
--                      into posts / likes (ids preserved); the old tables stay
--                      in place but are no longer used by the app.
--
-- Safe to re-run: every step is idempotent.
-- ============================================================================

-- ============================================================================
-- 0. GRANTS
-- ============================================================================
grant select on public.groups to anon, authenticated;
grant select on public.group_members to anon, authenticated;

-- ============================================================================
-- 1. Groups — avatar + created_by, public reads
-- ============================================================================
alter table public.groups add column if not exists avatar_url text;
alter table public.groups add column if not exists created_by uuid references public.profiles(id) on delete cascade;

-- Backfill created_by from the legacy creator_id column
update public.groups set created_by = creator_id where created_by is null;

-- Keep creator_id and created_by in sync (new inserts may set either)
create or replace function sync_group_creator_columns()
returns trigger
language plpgsql
as $$
begin
  new.created_by := coalesce(new.created_by, new.creator_id);
  new.creator_id := coalesce(new.creator_id, new.created_by);
  return new;
end;
$$;

drop trigger if exists trg_sync_group_creator on public.groups;
create trigger trg_sync_group_creator
  before insert on public.groups
  for each row
  execute function sync_group_creator_columns();

create index if not exists groups_created_by_idx on public.groups (created_by);

-- Replace the member-only read policy with a public one
drop policy if exists "groups readable by members" on public.groups;
drop policy if exists "groups are publicly readable" on public.groups;
create policy "groups are publicly readable"
  on public.groups for select
  using (true);

drop policy if exists "users can create groups" on public.groups;
create policy "users can create groups"
  on public.groups for insert
  with check (auth.uid() = created_by);

drop policy if exists "creators can update their groups" on public.groups;
create policy "creators can update their groups"
  on public.groups for update
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

drop policy if exists "creators can delete their groups" on public.groups;
create policy "creators can delete their groups"
  on public.groups for delete
  using (auth.uid() = created_by);

-- ============================================================================
-- 2. Group members — status-based membership
-- ============================================================================
alter table public.group_members add column if not exists status text not null default 'invited'
  check (status in ('invited', 'accepted', 'declined', 'left'));
alter table public.group_members add column if not exists invited_by uuid references public.profiles(id) on delete set null;
alter table public.group_members add column if not exists responded_at timestamptz;

-- Backfill: every legacy member row is an accepted membership
update public.group_members
set status = 'accepted',
    responded_at = coalesce(responded_at, joined_at)
where status = 'invited'
  and role in ('member', 'admin')
  and invited_by is null;

-- ONE accepted group per user at a time
create unique index if not exists one_accepted_group_per_user
  on public.group_members (user_id)
  where status = 'accepted';

-- 10 accepted members max per group
create or replace function enforce_group_member_cap()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  accepted_count integer;
begin
  if new.status = 'accepted' then
    select count(*) into accepted_count
    from public.group_members gm
    where gm.group_id = new.group_id
      and gm.status = 'accepted'
      and gm.user_id <> new.user_id;

    if accepted_count >= 10 then
      raise exception 'This group is full (10 member maximum).';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_group_member_cap on public.group_members;
create trigger trg_group_member_cap
  before insert or update of status on public.group_members
  for each row
  execute function enforce_group_member_cap();

-- RLS: public roster reads; invites by accepted members/creator; self-accept
drop policy if exists "members readable by group members" on public.group_members;
drop policy if exists "member roster is publicly readable" on public.group_members;
create policy "member roster is publicly readable"
  on public.group_members for select
  using (true);

drop policy if exists "creator or admin can add members" on public.group_members;
create policy "accepted members can invite; users can join directly"
  on public.group_members for insert
  with check (
    -- A user can claim their own accepted membership (join flow)
    (auth.uid() = user_id and group_members.status = 'accepted')
    -- Accepted members (or the creator) can invite others
    or (
      group_members.status = 'invited'
      and exists (
        select 1 from public.groups g
        where g.id = group_members.group_id
          and (
            g.created_by = auth.uid()
            or exists (
              select 1 from public.group_members gm
              where gm.group_id = g.id
                and gm.user_id = auth.uid()
                and gm.status = 'accepted'
            )
          )
      )
    )
  );

drop policy if exists "members can leave groups" on public.group_members;
create policy "users manage their own membership; inviters manage invites"
  on public.group_members for update
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and (
          g.created_by = auth.uid()
          or exists (
            select 1 from public.group_members gm
            where gm.group_id = g.id
              and gm.user_id = auth.uid()
              and gm.status = 'accepted'
          )
        )
    )
  )
  with check (
    auth.uid() = user_id
    or exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and (
          g.created_by = auth.uid()
          or exists (
            select 1 from public.group_members gm
            where gm.group_id = g.id
              and gm.user_id = auth.uid()
              and gm.status = 'accepted'
          )
        )
    )
  );

drop policy if exists "members can remove themselves" on public.group_members;
create policy "members can remove themselves or be removed by creator"
  on public.group_members for delete
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.groups g
      where g.id = group_members.group_id and g.created_by = auth.uid()
    )
  );

-- Creator auto-join on group creation (updated for status columns)
create or replace function auto_add_creator_as_member()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.group_members (group_id, user_id, role, status, responded_at)
  values (new.id, new.creator_id, 'admin', 'accepted', now())
  on conflict (group_id, user_id) do update
    set status = 'accepted', responded_at = now();
  return new;
end;
$$;

-- ============================================================================
-- 3. Posts — group link + view counter
-- ============================================================================
alter table public.posts add column if not exists group_id uuid references public.groups(id) on delete cascade;
alter table public.posts add column if not exists view_count bigint not null default 0;

create index if not exists posts_group_id_created_idx on public.posts (group_id, created_at desc);
-- Trybe ranking: group posts by likes, then recency
create index if not exists posts_group_rank_idx on public.posts (group_id, like_count desc, created_at desc)
  where group_id is not null;
-- Home feed: personal posts by recency
create index if not exists posts_personal_created_idx on public.posts (created_at desc)
  where group_id is null;

-- ── Group-post insert enforcement: only accepted members can post ──────────
create or replace function enforce_group_post_membership()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.group_id is not null then
    if not exists (
      select 1 from public.group_members gm
      where gm.group_id = new.group_id
        and gm.user_id = new.user_id
        and gm.status = 'accepted'
    ) then
      raise exception 'You must be an accepted member of this group to post to it.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_group_post_membership on public.posts;
create trigger trg_group_post_membership
  before insert on public.posts
  for each row
  execute function enforce_group_post_membership();

-- ── like_count stays in sync with the likes table ──────────────────────────
create or replace function sync_post_like_count()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = coalesce(like_count, 0) + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update public.posts set like_count = greatest(coalesce(like_count, 0) - 1, 0) where id = old.post_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_like_count on public.likes;
create trigger trg_sync_like_count
  after insert or delete on public.likes
  for each row
  execute function sync_post_like_count();

-- Backfill like_count from actual likes rows
update public.posts p
set like_count = coalesce(sub.cnt, 0)
from (
  select post_id, count(*) as cnt from public.likes group by post_id
) sub
where p.id = sub.post_id;

-- ── Notify accepted members when someone posts into their group ────────────
create or replace function notify_trybe_members_on_post()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  member_record record;
begin
  if new.group_id is null then
    return new;
  end if;
  for member_record in
    select gm.user_id from public.group_members gm
    where gm.group_id = new.group_id
      and gm.status = 'accepted'
      and gm.user_id <> new.user_id
  loop
    insert into public.notifications (recipient_id, actor_id, type, post_id)
    values (
      member_record.user_id,
      new.user_id,
      'group_post',
      new.id
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_trybe_members on public.posts;
create trigger trg_notify_trybe_members
  after insert on public.posts
  for each row
  execute function notify_trybe_members_on_post();

-- ============================================================================
-- 4. RPC — view counting (called by the app when a video is watched)
-- ============================================================================
create or replace function increment_post_view(p_post_id uuid)
returns void
language sql
security definer set search_path = public
as $$
  update public.posts set view_count = view_count + 1 where id = p_post_id;
$$;

grant execute on function increment_post_view(uuid) to anon, authenticated;

-- ============================================================================
-- 5. Data migration — group_posts → posts, group_post_reactions → likes
--    (ids preserved so reactions map cleanly; old tables are left in place
--     but no longer used by the app)
-- ============================================================================

-- Copy group posts into the main posts table (photo → image to satisfy the
-- posts.media_type check constraint)
insert into public.posts (id, user_id, media_url, media_type, caption, group_id, created_at)
select
  gp.id,
  gp.user_id,
  gp.media_url,
  case gp.media_type when 'photo' then 'image' else gp.media_type end,
  gp.caption,
  gp.group_id,
  gp.created_at
from public.group_posts gp
on conflict (id) do nothing;

-- Copy group post reactions into the likes table (like_count trigger updates posts)
insert into public.likes (user_id, post_id, created_at)
select
  r.user_id,
  r.group_post_id,
  r.created_at
from public.group_post_reactions r
join public.posts p on p.id = r.group_post_id
on conflict (user_id, post_id) do nothing;

-- Retire the legacy notify trigger on the old table (app no longer writes there)
drop trigger if exists trg_notify_group_members on public.group_posts;
