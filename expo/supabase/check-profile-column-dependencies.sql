-- READ-ONLY: changes nothing. Paste into the Supabase SQL editor and run BEFORE the birthdate lock-down (money_apply_birthdate_lockdown()).
-- Lists everything in the live database that mentions profiles.birthdate, money_banned or birthdate_set_at: the columns apps lose read access to.
-- Those columns stop being readable by the signed-in role (authenticated) and by anon, so anything that reads them AS THE CALLER would break:
--   function, security_definer = true     fine (runs as its owner)
--   function, security_definer = false    CHECK: it runs as the caller and would fail after the lock-down
--   policy                                CHECK: policies run as the caller
--   view                                  fine unless it is a security_invoker view (shown in the 'note' column)
-- An empty "CHECK" list means nothing in the database depends on the caller reading those columns.
select kind, object, security_definer, note from (
  select 'function' as kind, n.nspname || '.' || p.proname as object, p.prosecdef as security_definer,
         case when p.prosecdef then 'ok' else 'CHECK' end as note
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~* '(birthdate_set_at|money_banned|birthdate)' and p.prosrc ~* 'profiles'   -- reading the column means querying profiles
  union all
  select 'policy', schemaname || '.' || tablename || ' / ' || policyname, null::boolean, 'CHECK'
    from pg_policies
   where coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '(birthdate_set_at|money_banned|birthdate)'
  union all
  select 'view', v.schemaname || '.' || v.viewname, null::boolean,
         case when coalesce((select 'security_invoker=true' = any (c.reloptions) from pg_class c where c.oid = (v.schemaname || '.' || v.viewname)::regclass), false) then 'CHECK (security_invoker view)' else 'ok (runs as its owner)' end
    from pg_views v
   where v.schemaname = 'public' and v.definition ~* '(birthdate_set_at|money_banned|birthdate)'
) x
order by (case when note like 'CHECK%' then 0 else 1 end), kind, object;
