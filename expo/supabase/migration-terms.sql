-- Trial: Terms-of-use acceptance timestamp
-- Run this in the Supabase SQL editor.

-- ============================================================================
-- profiles.terms_accepted_at
--   Records the moment a user agreed to the Terms of Use & Privacy Policy at
--   signup. NULL for existing rows that predate the field (they never had an
--   explicit acceptance flow). New signups write the current timestamp.
-- ============================================================================
alter table public.profiles
  add column if not exists terms_accepted_at timestamptz;
