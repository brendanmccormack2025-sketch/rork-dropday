-- Schedules the delete-media Edge Function every 15 minutes (idempotent). Run it ONCE by hand, after a dry run:
--   curl -s -X POST "https://tfdjymogbtfavdzgfqas.supabase.co/functions/v1/delete-media" -H "Authorization: Bearer <service role key>"
-- Needs (a) pg_net, (b) pg_cron, (c) a Vault secret named service_role_key with the project's service role key:
--   select vault.create_secret('<service role key>', 'service_role_key');
-- ship.sh does NOT run this file (it deletes Storage files for real, so it is a deliberate step).
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key') then
    raise exception 'Vault secret service_role_key is missing: select vault.create_secret(''<service role key>'', ''service_role_key'');';
  end if;
end $$;

select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'delete-media';
select cron.schedule(
  'delete-media',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := 'https://tfdjymogbtfavdzgfqas.supabase.co/functions/v1/delete-media?run=1',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
      )
    );
  $cron$
);
