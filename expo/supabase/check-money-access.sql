-- READ-ONLY: changes nothing. Why is (or isn't) the Money tab showing for a person? Change 'brendan' to the username to check.
-- tab_would_show is the same decision my_features() makes; flag_on_for_me false means they are not on the allow list (and the flag is off for everyone).
select p.id, p.username, u.email,
       p.id = 'aee21757-1ded-41a7-9392-bddbf0d657df'::uuid                         as is_owner_id,
       f.enabled                                                                    as flag_enabled,
       f.allow_user_ids                                                             as allow_list,
       coalesce(p.id = any (f.allow_user_ids), false)                               as on_allow_list,
       public.flag_on('money', p.id)                                                as flag_on_for_me,
       p.birthdate, public.age_tier(p.birthdate)                                    as age_tier,
       public.money_is_adult(p.id)                                                  as is_adult,
       p.money_banned,
       exists (select 1 from public.account_sanction_of(p.id))                      as sanctioned,
       public.money_allowed(p.id)                                                   as money_allowed,
       public.money_ready(p.id)                                                     as money_ready,
       (public.flag_on('money', p.id) and not p.money_banned
          and not exists (select 1 from public.account_sanction_of(p.id))
          and (p.birthdate is null or public.age_tier(p.birthdate) = 'adult'))      as tab_would_show,
       (public.flag_on('money', p.id) and not p.money_banned and p.birthdate is null) as would_ask_birthdate
from public.profiles p
left join auth.users u on u.id = p.id
left join public.app_flags f on f.key = 'money'
where p.username ilike 'brendan%'
order by p.username;
