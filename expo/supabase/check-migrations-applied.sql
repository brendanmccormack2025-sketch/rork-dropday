-- READ-ONLY: changes nothing. Paste into the Supabase SQL editor and run. Shows which of the release's migration files are already in the
-- live database, by checking one object each file creates (a file is "applied" when its marker exists; it does not prove the file is the
-- latest version: for that use check-tryal-friends-live.sql). Order = the order to apply them in (scripts/apply-migrations.mjs FILES).
select step, file, marker, case when present then 'applied' else 'NOT applied' end as status
from (values
  (1,  'migration-live-snapshot.sql',     'function get_feed_engine exists',                       exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'get_feed_engine')),
  (2,  'migration-known-connections.sql', 'view known_connections',                                to_regclass('public.known_connections') is not null),
  (3,  'migration-stranger-only.sql',     'function trial_delete_failed_post(uuid)',               to_regprocedure('public.trial_delete_failed_post(uuid)') is not null),
  (4,  'migration-spotlight.sql',         'table spotlight_config',                                to_regclass('public.spotlight_config') is not null),
  (5,  'migration-harassment.sql',        'table word_filter_terms',                               to_regclass('public.word_filter_terms') is not null),
  (6,  'migration-recovery.sql',          'table recovery_offers',                                 to_regclass('public.recovery_offers') is not null),
  (7,  'migration-sanctions.sql',         'table account_sanctions',                               to_regclass('public.account_sanctions') is not null),
  (8,  'migration-tryal-friends.sql',     'function trial_fans_of(uuid)',                          to_regprocedure('public.trial_fans_of(uuid)') is not null),
  (9,  'migration-money.sql (step 1)',    'table app_flags + function money_allowed(uuid)',       to_regclass('public.app_flags') is not null and to_regprocedure('public.money_allowed(uuid)') is not null),
  (10, 'migration-money.sql (step 2)',    'function set_my_birthdate(date) + column birthdate_set_at',
        to_regprocedure('public.set_my_birthdate(date)') is not null
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'birthdate_set_at')),
  (11, 'migration-money-board.sql',       'table campaigns + function money_ready(uuid)',          to_regclass('public.campaigns') is not null and to_regprocedure('public.money_ready(uuid)') is not null)
) as t(step, file, marker, present)
union all
select 12, '(state, not a file)', 'birthdate lock-down: can signed-in apps still SELECT profiles.birthdate?',
       case when has_column_privilege('authenticated', 'public.profiles', 'birthdate', 'select')
            then 'lock-down NOT applied (apps can read birthdate: the current live build needs that)'
            else 'lock-down APPLIED (apps cannot read birthdate)' end
order by 1;
