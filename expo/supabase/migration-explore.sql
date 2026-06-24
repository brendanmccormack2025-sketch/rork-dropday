-- DropDay: Explore tab — Suggested Creators ranked by total engagement
-- Run this in the Supabase SQL editor.

-- ============================================================================
-- get_explore_creators — returns top 20 users ranked by:
--   total likes received on their Drops + total reactions received on their Drops
-- ============================================================================
create or replace function get_explore_creators()
returns table (
  id text,
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
