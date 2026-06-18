-- ============================================================================
-- MIGRATION: Fix Rork Auth + GRANTs for existing DropDay database
-- Run this in Supabase SQL Editor: https://abucipwkiifhzinpiiao.supabase.co
-- ============================================================================

-- 0. Grant table access (fixes 42501 immediately) ---------------------------
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

-- 1. Fix profiles: drop auth.uid() policies, use user_id() ------------------
-- (Also drop the broken auth.users trigger since auth.users is empty)
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

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- 2. Fix posts: drop auth.uid() policies, use user_id() ---------------------
drop policy if exists "posts are readable by everyone" on public.posts;
create policy "posts are readable by everyone"
  on public.posts for select using (true);

drop policy if exists "users can insert their own posts" on public.posts;
create policy "users can insert their own posts"
  on public.posts for insert with check (user_id() = user_id);

drop policy if exists "users can delete their own posts" on public.posts;
create policy "users can delete their own posts"
  on public.posts for delete using (user_id() = user_id);

-- 3. Fix follows: drop auth.uid() policies, use user_id() -------------------
drop policy if exists "follows are readable by everyone" on public.follows;
create policy "follows are readable by everyone"
  on public.follows for select using (true);

drop policy if exists "users can insert their own follows" on public.follows;
create policy "users can insert their own follows"
  on public.follows for insert with check (user_id() = follower_id);

drop policy if exists "users can delete their own follows" on public.follows;
create policy "users can delete their own follows"
  on public.follows for delete using (user_id() = follower_id);

-- 4. Fix storage policies: replace auth.uid()/auth.role() with user_id() ----
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
