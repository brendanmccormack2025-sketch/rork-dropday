-- DropDay Supabase schema (Native Supabase Auth mode — uses auth.uid())
-- Run this in the Supabase SQL editor.

-- ============================================================================
-- 0. GRANT table access to roles
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

-- ============================================================================
-- 1. Profiles — keyed to auth.users(id) (uuid)
-- ============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
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
  on public.profiles for insert with check (auth.uid() = id);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============================================================================
-- 2. Posts
-- ============================================================================
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image', 'video')),
  caption text,
  parent_post_id uuid references public.posts(id) on delete cascade,
  segments jsonb,
  audio_url text,
  trim_data jsonb,
  text_overlays jsonb,
  thumbnail_url text,
  poster_timezone text,
  like_count integer default 0,
  comment_count integer default 0,
  reaction_count integer not null default 0,
  original_duration_ms integer,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists posts_created_at_idx on public.posts (created_at desc);
create index if not exists posts_user_id_idx on public.posts (user_id);
create index if not exists posts_parent_post_id_idx on public.posts (parent_post_id);

alter table public.posts enable row level security;

drop policy if exists "posts are readable by everyone" on public.posts;
create policy "posts are readable by everyone"
  on public.posts for select using (true);

drop policy if exists "users can insert their own posts" on public.posts;
create policy "users can insert their own posts"
  on public.posts for insert with check (auth.uid() = user_id);

drop policy if exists "users can delete their own posts" on public.posts;
create policy "users can delete their own posts"
  on public.posts for delete using (auth.uid() = user_id);

-- ============================================================================
-- 3. Follows
-- ============================================================================
create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followee_id uuid not null references public.profiles(id) on delete cascade,
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
  on public.follows for insert with check (auth.uid() = follower_id);

drop policy if exists "users can delete their own follows" on public.follows;
create policy "users can delete their own follows"
  on public.follows for delete using (auth.uid() = follower_id);

-- ============================================================================
-- 4. Likes
-- ============================================================================
create table if not exists public.likes (
  user_id uuid not null references public.profiles(id) on delete cascade,
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
  on public.likes for insert with check (auth.uid() = user_id);

drop policy if exists "users can delete their own likes" on public.likes;
create policy "users can delete their own likes"
  on public.likes for delete using (auth.uid() = user_id);

-- ============================================================================
-- 5. Conversations — DM threads between two users
--    (Created on demand when the feature is enabled)
-- ============================================================================
-- create table if not exists public.conversations (
--   id uuid primary key default gen_random_uuid(),
--   participant_1_id uuid not null references public.profiles(id) on delete cascade,
--   participant_2_id uuid not null references public.profiles(id) on delete cascade,
--   created_at timestamptz default now(),
--   constraint conversations_unique_pair unique (participant_1_id, participant_2_id),
--   constraint conversations_no_self check (participant_1_id <> participant_2_id)
-- );

-- ============================================================================
-- 6. Messages
--    (Created on demand when the feature is enabled)
-- ============================================================================
-- create table if not exists public.messages (
--   id uuid primary key default gen_random_uuid(),
--   conversation_id uuid not null references public.conversations(id) on delete cascade,
--   sender_id uuid not null references public.profiles(id) on delete cascade,
--   text text,
--   post_id uuid references public.posts(id) on delete set null,
--   created_at timestamptz default now()
-- );

-- ============================================================================
-- 7. Drafts — saved draft projects per user
--    (Created on demand when the feature is enabled)
-- ============================================================================
-- create table if not exists public.drafts (
--   id uuid primary key default gen_random_uuid(),
--   user_id uuid not null references public.profiles(id) on delete cascade,
--   clips jsonb not null default '[]'::jsonb,
--   caption text default '',
--   text_overlays jsonb default '[]'::jsonb,
--   cover_thumbnail_uri text,
--   cover_thumbnail_ms integer,
--   created_at timestamptz default now(),
--   updated_at timestamptz default now()
-- );

-- ============================================================================
-- 8. Auto-create profile on signup (handle_new_user trigger)
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'dropper_' || left(new.id::text, 8)),
    coalesce(new.raw_user_meta_data->>'username', 'dropper_' || left(new.id::text, 8))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 9. Reaction count trigger
-- ============================================================================
create or replace function update_reaction_count()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.parent_post_id is not null then
      update public.posts set reaction_count = reaction_count + 1 where id = new.parent_post_id;
    end if;
  elsif tg_op = 'DELETE' then
    if old.parent_post_id is not null then
      update public.posts set reaction_count = greatest(reaction_count - 1, 0) where id = old.parent_post_id;
    end if;
  end if;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_reaction_count on public.posts;
create trigger trg_reaction_count
  after insert or delete on public.posts
  for each row
  when (new.parent_post_id is not null or old.parent_post_id is not null)
  execute function update_reaction_count();

-- ============================================================================
-- 10. Explore creators RPC
-- ============================================================================
create or replace function get_explore_creators()
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  total_engagement bigint
) as $$
begin
  return query
  select
    p.id,
    p.username,
    p.display_name,
    p.avatar_url,
    coalesce(like_counts.cnt, 0) + coalesce(reaction_counts.cnt, 0) as total_engagement
  from profiles p
  left join (
    select posts.user_id, count(*) as cnt
    from likes
    join posts on likes.post_id = posts.id
    group by posts.user_id
  ) like_counts on like_counts.user_id = p.id
  left join (
    select parent_posts.user_id, count(*) as cnt
    from posts as reactions
    join posts as parent_posts on reactions.parent_post_id = parent_posts.id
    group by parent_posts.user_id
  ) reaction_counts on reaction_counts.user_id = p.id
  order by total_engagement desc
  limit 20;
end;
$$ language plpgsql stable;

grant execute on function get_explore_creators() to anon, authenticated;

-- ============================================================================
-- 11. Storage bucket for media
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
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "drops owner update" on storage.objects;
create policy "drops owner update"
  on storage.objects for update
  using (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "drops owner delete" on storage.objects;
create policy "drops owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
