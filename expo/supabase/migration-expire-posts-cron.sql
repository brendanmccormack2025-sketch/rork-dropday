-- Schedule expire_posts() (idempotent; run manually in the Supabase SQL editor).
--
-- Why: expire_posts() (defined in migration-lifecycle.sql) was never scheduled on this database. The cron job
-- 'expire-posts' is created by migration-lifecycle-expiry.sql, which was not run, so survived posts never moved to
-- 'expired' on time (they only left the feed through the distribution_expires_at filter). This file schedules just
-- that job, without that migration's other (optional) parts. Safe to re-run.
--
-- expire_posts() moves status='survived' posts whose distribution_expires_at has passed to 'expired' (and expires
-- their reactions). 'archived' (Trial ended) and 'incomplete' posts are not touched by it: they are not served in any
-- feed (see get_feed_engine) and stay visible to their creator with their message.

do $$
begin
  if to_regprocedure('public.expire_posts()') is null then
    raise exception 'public.expire_posts() is missing: run migration-lifecycle.sql first.';
  end if;
end $$;

select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'expire-posts';

select cron.schedule(
  'expire-posts',
  '*/5 * * * *',
  $cron$
    select public.expire_posts();
  $cron$
);
