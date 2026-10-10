-- Review recent progressive-testing decisions (read-only; run in the Supabase SQL editor).
-- One row per decision (and per change in viewers while testing), newest first.
select l.created_at,
       l.post_id,
       l.stage,
       l.n               as viewers_scored,
       round(l.score_mean::numeric, 3)  as mean_score,
       round(l.p_above_bar::numeric, 3) as p_above_bar,
       round(l.bar::numeric, 3)         as bar,
       l.pool,
       l.decision, l.reason,                      -- testing | expand | survived | failed | incomplete
       p.status          as post_status
from public.trial_engine_log l
left join public.posts p on p.id = l.post_id
order by l.created_at desc
limit 200;

-- Only final decisions of the last 24 hours:
-- select * from public.trial_engine_log where decision in ('survived','failed','incomplete') and created_at > now() - interval '24 hours' order by created_at desc;
-- Engine on/off:  select engine_mode from public.trial_engine_config;
-- Switch back to the old logic:  update public.trial_engine_config set engine_mode = 'legacy';
