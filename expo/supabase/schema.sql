-- DropDay Supabase schema
-- Run this in the Supabase SQL editor for a fresh project.

-- 1. Profiles ---------------------------------------------------------------
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
  on public.profiles for update using (auth.uid() = id);

-- 1b. Auto-create profile when a new auth user signs up -------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  desired text;
  base text;
  candidate text;
  n int := 0;
begin
  desired := nullif(trim(coalesce(new.raw_user_meta_data->>'username', '')), '');
  base := coalesce(desired, 'dropper_' || substr(new.id::text, 1, 8));
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) loop
    n := n + 1;
    candidate := base || '_' || n::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, coalesce(desired, candidate))
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Posts — safe for fresh, partial, and fully-migrated databases ---------
-- Step 1: create the table if it doesn't exist yet (fresh database)
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
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

-- Step 2: add any columns that are missing from a partially-migrated table
-- Each of these is a no-op if the column already exists

alter table public.posts
  add column if not exists parent_post_id uuid references public.posts(id) on delete set null;

alter table public.posts
  add column if not exists segments text[];

alter table public.posts
  add column if not exists audio_url text;

alter table public.posts
  add column if not exists trim_data jsonb;

alter table public.posts
  add column if not exists text_overlays jsonb;

alter table public.posts
  add column if not exists thumbnail_url text;

-- Step 2.5: repair FK — if posts.user_id still points at auth.users, fix it so
-- PostgREST can resolve profiles(*) joins. Safe to run on any database state.
do $$
declare
  _con text;
begin
  select con.conname into _con
  from pg_constraint con
  join pg_class rel on con.conrelid = rel.oid
  join pg_namespace nsp on rel.relnamespace = nsp.oid
  where nsp.nspname = 'public'
    and rel.relname = 'posts'
    and con.contype = 'f'
    and con.conkey = (select array_agg(a.attnum order by a.attnum)
                      from pg_attribute a
                      where a.attrelid = rel.oid and a.attname = 'user_id');
  if _con is not null then
    execute format('alter table public.posts drop constraint %I', _con);
  end if;
end $$;

alter table public.posts
  add constraint posts_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade
  not valid;

-- Step 3: create indexes (safe because columns are guaranteed to exist now)
create index if not exists posts_created_at_idx
  on public.posts (created_at desc);

create index if not exists posts_user_id_idx
  on public.posts (user_id);

create index if not exists posts_parent_post_id_idx
  on public.posts (parent_post_id);

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

-- 3. Follows ---------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (follower_id, followee_id)
);

create index if not exists follows_follower_idx
  on public.follows (follower_id);

create index if not exists follows_followee_idx
  on public.follows (followee_id);

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

-- 4. Storage bucket for media ----------------------------------------------
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
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "drops owner update" on storage.objects;
create policy "drops owner update"
  on storage.objects for update
  using (
    bucket_id = 'drops'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "drops owner delete" on storage.objects;
create policy "drops owner delete"
  on storage.objects for delete
  using (
    bucket_id = 'drops'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
