-- client_errors: fatal and unhandled JavaScript errors (and caught Post failures) reported by the app.
-- Run in the Supabase SQL editor. Idempotent: safe to run more than once.
--
-- Clients can only INSERT their own rows. Nothing can read them from the app (no select policy and no select
-- grant); read them here in the dashboard or with the service role.

create table if not exists public.client_errors (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid references auth.users (id) on delete set null,
  message    text not null,
  stack      text,
  context    jsonb not null default '{}'::jsonb
);

create index if not exists client_errors_created_at_idx on public.client_errors (created_at desc);
create index if not exists client_errors_user_id_idx on public.client_errors (user_id);

alter table public.client_errors enable row level security;

-- Authenticated users insert rows for themselves only.
drop policy if exists "client_errors_insert_own" on public.client_errors;
create policy "client_errors_insert_own"
  on public.client_errors
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- No select / update / delete policy: with RLS on, clients can do none of those.
revoke all on public.client_errors from anon, authenticated;
grant insert on public.client_errors to authenticated;
