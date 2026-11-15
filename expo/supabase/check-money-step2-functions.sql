-- READ-ONLY: changes nothing. Paste into the Supabase SQL editor and run.
-- Does the live database have everything the step 2 Money screens call? One row per function (status ok / MISSING / NO EXECUTE FOR APPS),
-- then three rows about the state of things the screens depend on (anything not 'ok' says what to run).
select check_name, used_by, status, arguments
from (
  select f.fn as check_name, f.used_by,
         case when p.oid is null then 'MISSING'
              when not has_function_privilege('authenticated', p.oid, 'execute') then 'NO EXECUTE FOR APPS'
              else 'ok' end as status,
         pg_get_function_identity_arguments(p.oid) as arguments,
         1 as grp
    from (values
      ('my_features',               'app launch: whether the tab shows, the birthdate prompt (migration-money.sql, replaced by migration-money-board.sql)'),
      ('my_money_profile',          'Money tab: role and walkthrough state (migration-money-board.sql)'),
      ('money_complete_onboarding', 'walkthrough: "I agree" (migration-money-board.sql)'),
      ('money_create_campaign',     'Post a campaign (migration-money-board.sql)'),
      ('money_join_campaign',       'campaign: "I''m in" (migration-money-board.sql)'),
      ('money_set_campaign_status', 'campaign: Close campaign (migration-money-board.sql)'),
      ('campaign_payment_info',     'campaign: how you get paid, for members (migration-money-board.sql)'),
      ('money_profile_stats',       'cards: rating and payment record (migration-money-board.sql)'),
      ('set_my_birthdate',          'the birthdate prompt (migration-money.sql)'),
      ('my_birthdate',              'profile query: your own birthdate (migration-money.sql)')
    ) as f(fn, used_by)
    left join pg_proc p on p.pronamespace = 'public'::regnamespace and p.proname = f.fn
  union all
  select 'money_join_campaign is the latest version', 'campaign: "I''m in" also opens the message thread with the creator',
         case when exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'money_join_campaign' and prosrc like '%I joined your campaign%')
              then 'ok' else 'OLD VERSION: run migration-money-board.sql again' end,
         null, 2
  union all
  select 'campaigns table + budget_left column', 'Browse and the cards',
         case when to_regclass('public.campaigns') is not null
                and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'campaigns' and column_name = 'budget_left')
              then 'ok' else 'MISSING: run migration-money-board.sql' end,
         null, 2
  union all
  select 'birthdate can be saved in the app', 'the birthdate prompt: set_my_birthdate refuses until the lock-down is applied',
         case when has_column_privilege('authenticated', 'public.profiles', 'birthdate', 'select')
              then 'NOT YET: the lock-down is not applied, so the app says "this isn''t available yet". For testing, set your own birthdate in SQL.'
              else 'ok (lock-down applied)' end,
         null, 3
) x
order by (status like 'ok%'), grp, check_name;
