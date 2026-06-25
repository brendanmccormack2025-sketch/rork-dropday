-- DropDay Supabase schema (Rork Auth mode — uses user_id(), NOT auth.uid())
-- Run this in the Supabase SQL editor.

-- ============================================================================
-- 0. GRANT table access to roles (REQUIRED — tables are not auto-exposed)
-- ============================================================================
grant usage on schema public to anon, authenticated;

grant select on public.profiles to anon, authenticated;
grant insert on public.profiles to authenticated;
grant update on public.profiles to authenticated;

grant select on public.posts to anon, authenticated;
grant insert on public.posts to authenticated;
grant delete on public.posts to authenticated;

grant select on public.follows to anon, authenticated;
grant insert on public.follows to authenticated;
grant delete on public.follows to authenticated;

grant select on public.likes to anon, authenticated;
grant insert on public.likes to authenticated;
grant delete on public.likes to authenticated;

grant select on public.conversations to authenticated;
grant insert on public.conversations to authenticated;

grant select on public.messages to authenticated;
grant insert on public.messages to authenticated;

-- ============================================================================
-- 1. Profiles — keyed to Rork user IDs (text, NOT uuid)
-- ============================================================================
create table if not exists public.profiles (
  id text primary key,
  username text unique not null,
  display_name text,
  avatar_url text,
  bio text,
  website text,
  instagram_handle text,
  tiktok_handle text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are readable by everyone" on public.profiles;
create policy "profiles are readable by everyone"
  on public.profiles for select using (true);

drop policy if exists "users can insert their own profile" on public.profiles;
create policy "users can insert their own profile"
  on public.profiles for insert with check (user_id() = id);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update using (user_id() = id)
  with check (user_id() = id);

-- ============================================================================
-- 2. Posts
-- ============================================================================
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image', 'video')),
  caption text,
  parent_post_id uuid references public.posts(id) on delete set null,
  segments text[],
  audio_url text,
  trim_data jsonb,
  text_overlays jsonb,
  thumbnail_url text,
  created_at timestamptz default now()
);

-- Add columns that may be missing from partial migrations
alter table public.posts add column if not exists parent_post_id uuid references public.posts(id) on delete set null;
alter table public.posts add column if not exists segments text[];
alter table public.posts add column if not exists audio_url text;
alter table public.posts add column if not exists trim_data jsonb;
alter table public.posts add column if not exists text_overlays jsonb;
alter table public.posts add column if not exists thumbnail_url text;
alter table public.posts add column if not exists original_duration_ms integer;

-- Indexes
create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists posts_user_id_idx on public.posts (user_id);
create index if not exists posts_parent_post_id_idx on public.posts (parent_post_id);
create index if not exists posts_original_duration_ms_idx on public.posts (original_duration_ms);

alter table public.posts enable row level security;

drop policy if exists "posts are readable by everyone" on public.posts;
create policy "posts are readable by everyone"
  on public.posts for select using (true);

drop policy if exists "users can insert their own posts" on public.posts;
create policy "users can insert their own posts"
  on public.posts for insert with check (user_id() = user_id);

drop policy if exists "users can delete their own posts" on public.posts;
create policy "users can delete their own posts"
  on public.posts for delete using (user_id() = user_id);

-- ============================================================================
-- 3. Follows — references profiles (Rork user IDs), NOT auth.users
-- ============================================================================
create table if not exists public.follows (
  follower_id text not null references public.profiles(id) on delete cascade,
  followee_id text not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower_id, followee_id)
);

create index if not exists follows_follower_idx on public.follows (follower_id);
create index if not exists follows_followee_idx on public.follows (followee_id);

alter table public.follows enable row level security;

drop policy if exists "follows are readable by everyone" on public.follows;
create policy "follows are readable by everyone"
  on public.follows for select using (true);

drop policy if exists "users can insert their own follows" on public.follows;
create policy "users can insert their own follows"
  on public.follows for insert with check (user_id() = follower_id);

drop policy if exists "users can delete their own follows" on public.follows;
create policy "users can delete their own follows"
  on public.follows for delete using (user_id() = follower_id);

-- ============================================================================
-- 4. Likes — tracks which posts a user has liked
-- ============================================================================
create table if not exists public.likes (
  user_id text not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, post_id)
);

create index if not exists likes_user_id_idx on public.likes (user_id);
create index if not exists likes_post_id_idx on public.likes (post_id);

alter table public.likes enable row level security;

drop policy if exists "likes are readable by everyone" on public.likes;
create policy "likes are readable by everyone"
  on public.likes for select using (true);

drop policy if exists "users can insert their own likes" on public.likes;
create policy "users can insert their own likes"
  on public.likes for insert with check (user_id() = user_id);

drop policy if exists "users can delete their own likes" on public.likes;
create policy "users can delete their own likes"
  on public.likes for delete using (user_id() = user_id);

-- ============================================================================
-- 5. Conversations — DM threads between two users
-- ============================================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  participant_1_id text not null references public.profiles(id) on delete cascade,
  participant_2_id text not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  constraint conversations_unique_pair unique (participant_1_id, participant_2_id),
  constraint conversations_no_self check (participant_1_id <> participant_2_id)
);

create index if not exists conversations_p1_idx on public.conversations (participant_1_id);
create index if not exists conversations_p2_idx on public.conversations (participant_2_id);

alter table public.conversations enable row level security;

drop policy if exists "conversations readable by participants" on public.conversations;
create policy "conversations readable by participants"
  on public.conversations for select
  using (user_id() = participant_1_id or user_id() = participant_2_id);

drop policy if exists "conversations insertable by participants" on public.conversations;
create policy "conversations insertable by participants"
  on public.conversations for insert
  with check (user_id() = participant_1_id or user_id() = participant_2_id);

-- ============================================================================
-- 6. Messages — individual messages within a DM conversation
-- ============================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id text not null references public.profiles(id) on delete cascade,
  text text,
  post_id uuid references public.posts(id) on delete set null,
  created_at timestamptz default now(),
  constraint messages_text_or_post check (
    (text is not null and post_id is null) or (text is null and post_id is not null)
  )
);

create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at desc);
create index if not exists messages_sender_idx on public.messages (sender_id);

alter table public.messages enable row level security;

drop policy if exists "messages readable by conversation participants" on public.messages;
create policy "messages readable by conversation participants"
  on public.messages for select
  using (
    exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and (user_id() = c.participant_1_id or user_id() = c.participant_2_id)
    )
  );

drop policy if exists "messages insertable by sender" on public.messages;
create policy "messages insertable by sender"
  on public.messages for insert
  with check (
    user_id() = sender_id
    and exists (
      select 1 from public.conversations c
      where c.id = messages.conversation_id
        and (user_id() = c.participant_1_id or user_id() = c.participant_2_id)
    )
  );

-- ============================================================================
-- 7. Drafts — saved draft projects per user
-- ============================================================================
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  clips jsonb not null default '[]'::jsonb,
  caption text default '',
  text_overlays jsonb default '[]'::jsonb,
  cover_thumbnail_uri text,
  cover_thumbnail_ms integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists drafts_user_id_idx on public.drafts (user_id);
create index if not exists drafts_updated_at_idx on public.drafts (updated_at desc);

alter table public.drafts enable row level security;

drop policy if exists "users can read only their own drafts" on public.drafts;
create policy "users can read only their own drafts"
  on public.drafts for select
  using (user_id() = user_id);

drop policy if exists "users can insert their own drafts" on public.drafts;
create policy "users can insert their own drafts"
  on public.drafts for insert
  with check (user_id() = user_id);

drop policy if exists "users can update their own drafts" on public.drafts;
create policy "users can update their own drafts"
  on public.drafts for update
  using (user_id() = user_id)
  with check (user_id() = user_id);

drop policy if exists "users can delete their own drafts" on public.drafts;
create policy "users can delete their own drafts"
  on public.drafts for delete
  using (user_id() = user_id);

grant select, insert, update, delete on public.drafts to authenticated;

-- ============================================================================
-- 8. Cascade-delete reactions when parent post is deleted
--    (replaces the inline on-delete-set-null from the CREATE TABLE)
-- ============================================================================
do $$
declare
  fk_name text;
begin
  select c.conname into fk_name
  from pg_constraint c
  join pg_attribute a on a.attnum = any(c.conkey) and a.attrelid = c.conrelid
  where c.conrelid = 'public.posts'::regclass
    and c.confrelid = 'public.posts'::regclass
    and c.contype = 'f'
    and a.attname = 'parent_post_id';

  if fk_name is not null then
    execute format('alter table public.posts drop constraint %I', fk_name);
  end if;
end;
$$;

alter table public.posts
  add foreign key (parent_post_id)
  references public.posts(id)
  on delete cascade;

-- ============================================================================
-- 9. Storage bucket for media
-- ============================================================================
insert into storage.buckets (id, name, public)
values ('drops', 'drops', true)
on conflict (id) do nothing;

drop policy if exists "drops public read" on storage.objects;
create policy "drops public read"
  on storage.objects for select
  using (bucket_id = 'drops');

drop policy if exists "drops authenticated insert" on storage.objects;
create policy "drops authenticated insert"
  on storage.objects for insert
  with check (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = user_id()::text
  );

drop policy if exists "drops owner update" on storage.objects;
create policy "drops owner update"
  on storage.objects for update
  using (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = user_id()::text
  );

drop policy if exists "drops owner delete" on storage.objects;
create policy "drops owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = user_id()::text
  );
