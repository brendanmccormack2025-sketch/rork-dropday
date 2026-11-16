-- READ-ONLY: changes nothing. Paste into the Supabase SQL editor and run after migration-money-footage.sql.
-- One row per thing footage upload needs (status ok, or what to run). Nothing here shows anyone's files or names.
select check_name, status, detail
from (
  select 'bucket campaign-footage exists and is private' as check_name,
         case when b.id is null then 'MISSING: run migration-money-footage.sql'
              when b.public then 'NOT PRIVATE: the bucket is public, fix it now' else 'ok' end as status,
         coalesce('limit ' || b.file_size_limit || ' bytes; types ' || array_to_string(b.allowed_mime_types, ','), '-') as detail, 1 as grp
    from (select 1) one left join storage.buckets b on b.id = 'campaign-footage'
  union all
  select 'storage policies on the bucket (read + add, nothing else)',
         case when (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('campaign footage read', 'campaign footage add')) = 2 then 'ok' else 'MISSING: run migration-money-footage.sql' end,
         (select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'campaign footage%'), 1
  union all
  select 'no policy lets apps change or remove files in the bucket',
         case when exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and (qual like '%campaign-footage%' or with_check like '%campaign-footage%') and policyname not in ('campaign footage read', 'campaign footage add')) then 'EXTRA POLICY: remove it' else 'ok' end,
         null, 1
  union all
  select 'limits in money_config',
         case when c.max_footage_seconds_total = 3600 and c.max_footage_seconds_each = 1800 then 'ok' else 'CHANGED from 60 / 30 minutes (fine if on purpose)' end,
         'total ' || c.max_footage_seconds_total || ' s, each ' || c.max_footage_seconds_each || ' s, ' || c.max_footage_bytes || ' bytes, removed ' || c.footage_delete_days || ' days after close, unused uploads ' || c.orphan_footage_days || ' days, agreement version ' || c.agreement_version, 2
    from public.money_config c
  union all
  select 'the database functions the footage screens call',
         case when (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('money_footage_register', 'money_footage_complete', 'money_footage_fail', 'money_footage_remove', 'money_create_campaign_with_footage')
                      and has_function_privilege('authenticated', p.oid, 'execute')) = 5 then 'ok' else 'MISSING or not executable: run migration-money-footage.sql' end,
         null, 2
  union all
  select 'the daily purge is scheduled',
         case when exists (select 1 from cron.job where jobname = 'money-footage-purge') then 'ok' else 'NOT SCHEDULED: run select public.money_footage_purge() by hand now and then' end,
         (select schedule from cron.job where jobname = 'money-footage-purge'), 2
  union all
  select 'the old Drive-link way of posting a campaign is closed',
         case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'money_create_campaign' and prosrc like '%footage is uploaded now%') then 'ok'
              else 'OLD VERSION: run migration-money-board.sql again, then migration-money-footage.sql' end,
         null, 2
  union all
  select 'footage rows by status (counts only)', 'info',
         coalesce((select string_agg(status || ': ' || n, ', ' order by status) from (select status, count(*) n from public.campaign_footage group by status) t), 'none yet'), 3
  union all
  select 'files waiting for the removal job (media removal)', 'info',
         (select count(*) from public.trial_media_delete_queue where bucket = 'campaign-footage' and deleted_at is null)::text, 3
) x
order by (status in ('ok', 'info')), grp, check_name;
