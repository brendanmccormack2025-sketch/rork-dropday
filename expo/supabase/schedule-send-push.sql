-- Schedules the send-push Edge Function every minute (idempotent). ship.sh applies it after deploying the function (after
-- storing the service role key in Vault as service_role_key, like delete-media). To check by hand:
--   curl -s -X POST "https://tfdjymogbtfavdzgfqas.supabase.co/functions/v1/send-push" -H "Authorization: Bearer <service role key>"
-- (without ?run=1 it only says how many notifications are waiting). Needs pg_net, pg_cron and the Vault secret service_role_key.
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'service_role_key') then
    raise exception 'Vault secret service_role_key is missing: select vault.create_secret(''<service role key>'', ''service_role_key'');';
  end if;
end $$;

select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'send-push';
select cron.schedule(
  'send-push',
  '* * * * *',
  $cron$
    select net.http_post(
      url := 'https://tfdjymogbtfavdzgfqas.supabase.co/functions/v1/send-push?run=1',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
      ),
      timeout_milliseconds := 55000
    );
  $cron$
);
