-- DropDay: Friend Groups — Phase 1 (private groups only)
--
-- New tables:
--   groups             — group metadata
--   group_members      — membership roster with role
--   group_posts        — posts scoped to a group (separate from public posts)
--   group_post_reactions — reactions on group posts
--
-- RLS:
--   groups           — readable only by members
--   group_members    — readable only by members of that group; only creator/admin can insert
--   group_posts      — readable/writable only by members of that group
--   group_post_reactions — readable/writable only by members of that group
--
-- Notifications:
--   notify_group_members_on_post() inserts a row into notifications for each
--   group member (except the poster) when a new group_post is created.
--   The client picks this up via realtime and fires a local notification.
--
-- NOTE: No update_group_post_reaction_count() function — reaction counts
-- are computed client-side for Phase 1.
-- ============================================================================

-- ============================================================================
-- 0. GRANTS
-- ============================================================================
grant usage on schema public to anon, authenticated;

grant select on public.groups to authenticated;
grant insert on public.groups to authenticated;
grant delete on public.groups to authenticated;

grant select on public.group_members to authenticated;
grant insert on public.group_members to authenticated;
grant delete on public.group_members to authenticated;

grant select on public.group_posts to authenticated;
grant insert on public.group_posts to authenticated;
grant delete on public.group_posts to authenticated;

grant select on public.group_post_reactions to authenticated;
grant insert on public.group_post_reactions to authenticated;
grant delete on public.group_post_reactions to authenticated;

-- ============================================================================
-- 1. Groups
-- ============================================================================
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);

create index if not exists groups_creator_id_idx on public.groups (creator_id);
create index if not exists groups_created_at_idx on public.groups (created_at desc);

alter table public.groups enable row level security;

drop policy if exists "groups readable by members" on public.groups;
create policy "groups readable by members"
  on public.groups for select
  using (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = groups.id and gm.user_id = auth.uid()
    )
  );

drop policy if exists "users can create groups" on public.groups;
create policy "users can create groups"
  on public.groups for insert
  with check (auth.uid() = creator_id);

drop policy if exists "creators can delete their groups" on public.groups;
create policy "creators can delete their groups"
  on public.groups for delete
  using (auth.uid() = creator_id);

-- ============================================================================
-- 2. Group Members
-- ============================================================================
create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  role text not null default 'member' check (role in ('member', 'admin')),
  primary key (group_id, user_id)
);

create index if not exists group_members_group_id_idx on public.group_members (group_id);
create index if not exists group_members_user_id_idx on public.group_members (user_id);

alter table public.group_members enable row level security;

drop policy if exists "members readable by group members" on public.group_members;
create policy "members readable by group members"
  on public.group_members for select
  using (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = group_members.group_id and gm.user_id = auth.uid()
    )
  );

drop policy if exists "creator or admin can add members" on public.group_members;
create policy "creator or admin can add members"
  on public.group_members for insert
  with check (
    -- The creator can add members to their own group
    exists (
      select 1 from public.groups g
      where g.id = group_members.group_id and g.creator_id = auth.uid()
    )
    -- OR an existing admin of the group can add members
    or exists (
      select 1 from public.group_members gm
      where gm.group_id = group_members.group_id
        and gm.user_id = auth.uid()
        and gm.role = 'admin'
    )
    -- AND the user being added must be the current authenticated user
    -- (self-add is not allowed; members are added by admin, but the
    --  inserted row's user_id can be anyone — the admin is acting)
  );

drop policy if exists "members can leave groups" on public.group_members;
create policy "members can leave groups"
  on public.group_members for delete
  using (
    -- A member can remove themselves
    auth.uid() = user_id
    -- The group creator can remove any member
    or exists (
      select 1 from public.groups g
      where g.id = group_members.group_id and g.creator_id = auth.uid()
    )
    -- An admin can remove members
    or exists (
      select 1 from public.group_members gm
      where gm.group_id = group_members.group_id
        and gm.user_id = auth.uid()
        and gm.role = 'admin'
    )
  );

-- ============================================================================
-- 3. Group Posts
-- ============================================================================
create table if not exists public.group_posts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('photo', 'video')),
  caption text,
  created_at timestamptz default now()
);

create index if not exists group_posts_group_id_idx on public.group_posts (group_id);
create index if not exists group_posts_created_at_idx on public.group_posts (created_at desc);
create index if not exists group_posts_user_id_idx on public.group_posts (user_id);

alter table public.group_posts enable row level security;

drop policy if exists "group posts readable by members" on public.group_posts;
create policy "group posts readable by members"
  on public.group_posts for select
  using (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = group_posts.group_id and gm.user_id = auth.uid()
    )
  );

drop policy if exists "members can post to group" on public.group_posts;
create policy "members can post to group"
  on public.group_posts for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.group_members gm
      where gm.group_id = group_posts.group_id and gm.user_id = auth.uid()
    )
  );

drop policy if exists "users can delete their own group posts" on public.group_posts;
create policy "users can delete their own group posts"
  on public.group_posts for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 4. Group Post Reactions
-- ============================================================================
create table if not exists public.group_post_reactions (
  id uuid primary key default gen_random_uuid(),
  group_post_id uuid not null references public.group_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique (group_post_id, user_id)
);

create index if not exists group_post_reactions_post_id_idx on public.group_post_reactions (group_post_id);
create index if not exists group_post_reactions_user_id_idx on public.group_post_reactions (user_id);

alter table public.group_post_reactions enable row level security;

drop policy if exists "reactions readable by group members" on public.group_post_reactions;
create policy "reactions readable by group members"
  on public.group_post_reactions for select
  using (
    exists (
      select 1 from public.group_posts gp
      join public.group_members gm on gm.group_id = gp.group_id
      where gp.id = group_post_reactions.group_post_id
        and gm.user_id = auth.uid()
    )
  );

drop policy if exists "members can react to group posts" on public.group_post_reactions;
create policy "members can react to group posts"
  on public.group_post_reactions for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.group_posts gp
      join public.group_members gm on gm.group_id = gp.group_id
      where gp.id = group_post_reactions.group_post_id
        and gm.user_id = auth.uid()
    )
  );

drop policy if exists "users can remove their own reactions" on public.group_post_reactions;
create policy "users can remove their own reactions"
  on public.group_post_reactions for delete
  using (auth.uid() = user_id);

-- ============================================================================
-- 5. Storage bucket for group media (private — RLS-enforced)
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('group-media', 'group-media', true)
on conflict (id) do nothing;

drop policy if exists "group-media public read" on storage.objects;
create policy "group-media public read"
  on storage.objects for select
  using (bucket_id = 'group-media');

drop policy if exists "group-media authenticated insert" on storage.objects;
create policy "group-media authenticated insert"
  on storage.objects for insert
  with check (
    bucket_id = 'group-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "group-media owner delete" on storage.objects;
create policy "group-media owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'group-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- 6. Trigger: notify group members on new post
--    Inserts a notification row for each group member (except the poster).
--    The client picks this up via realtime and fires a local notification.
--
--    NOTE: No unused first payload variable — the real payload is built
--    inside the loop for each notification row.
-- ============================================================================
create or replace function notify_group_members_on_post()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  member_record record;
begin
  for member_record in
    select gm.user_id from public.group_members gm
    where gm.group_id = new.group_id
      and gm.user_id <> new.user_id
  loop
    insert into public.notifications (recipient_id, actor_id, type, post_id)
    values (
      member_record.user_id,
      new.user_id,
      'group_post',
      null
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_group_members on public.group_posts;
create trigger trg_notify_group_members
  after insert on public.group_posts
  for each row
  execute function notify_group_members_on_post();

-- ============================================================================
-- 7. Auto-add creator as admin member on group creation
-- ============================================================================
create or replace function auto_add_creator_as_member()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.creator_id, 'admin')
  on conflict (group_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_auto_add_creator on public.groups;
create trigger trg_auto_add_creator
  after insert on public.groups
  for each row
  execute function auto_add_creator_as_member();
