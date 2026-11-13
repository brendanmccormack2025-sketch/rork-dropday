# PLAN-CLIPS (revision 2): the "Money" tab

**Build status and the final v1 scope are in sections 11 and 12 (they supersede anything above that disagrees).**

Status: plan only. No code, SQL, config or dependency is changed by this file.
Written against branch `feature/stranger-only`. Revision 2 replaces the "no payments" version with your decisions:
real money (Stripe Checkout funding on the web, Stripe Connect Express payouts), footage in Cloudflare R2, and a later Pro subscription (Apple IAP via RevenueCat).

## 0. Summary and the blunt assessment

**The product.** A **Money** tab ($ icon) with five sections: **Jobs** (clipping campaigns), **Footage** (footage I have received), **My submissions**, **My campaigns**, **Wallet** (balance, history, cash out). Creators fund a campaign up front on a web page; flat pay per approved clip; Tryal takes a fee (config). Clippers cut the clip in the existing Tryal editor and submit; the creator approves and downloads approved clips; approved clips appear on the clipper's profile with credit. Cash-out needs Stripe identity/DOB verification. Phase B adds Pro ($9.99/mo, IAP).

**What is feasible vs. what is new risk.**

| Area | Verdict |
|---|---|
| Editor, render, submit flow | Mostly reuse. Same plan as revision 1 (a `campaignId` mode in `app/edit.tsx`, render required, no raw fallback). |
| Reports, blocks, word filter, sanctions, admin queue, notifications, push | Reuse and extend. |
| Real money (Stripe Connect, ledger, payouts, disputes) | **Entirely new, and the highest-risk part of the product.** Needs a business entity, Stripe platform approval, legal/tax review and an Apple 3.1 answer **before** engineering starts (section 6). |
| Footage in R2 with signed URLs | New infrastructure (new vendor, new secrets, no Supabase RLS). It removes the egress problem, but moves all access control into edge functions. |
| 18+ gate | Two layers: self-declared DOB (new, gates browsing) and Stripe-verified identity (gates cash-out). Neither exists today. |
| Pro (IAP + server-side AI) | Separate phase. Contradicts the current cost rules unless those rules are explicitly scoped to "core product" (section 8). |

**Three things in the existing code that gate this work** (carried over from revision 1, still true):
1. **No birthdate is collected.** Sign-up only has a "13 or older" checkbox and passes `birthdate = undefined` (`providers/AuthProvider.tsx`, `app/(auth)/sign-up.tsx`); `age_tier()` is `'unknown'` for nearly everyone. `profiles` is `select using (true)` with a table-wide select grant (`supabase/schema.sql`), so **collecting a DOB would publish everyone's birthday** unless the column is locked first. (Section 3.1.)
2. **No feature-flag system** (only the `FEATURES` constant and `isDebugOwner`). A client constant needs a build to change; you have ruled out EAS updates. Flags must live in the database, and money needs **independent kill switches** (browse, fund, approve, payouts).
3. **The `drops` bucket is public** (`"drops public read"`). Nothing from Money may be written there. (With R2 it will not be.)

---

## 1. What already exists and should be reused

| Need | Reuse | Where | Notes / gaps |
|---|---|---|---|
| Edit the clip | The whole editor: timeline, silence/um/hook cuts, captions, overlays, undo/redo, merge-first | `app/edit.tsx`, `lib/autoEdit/*`, `lib/transcription/*`, `lib/mergeClips.ts`, `lib/clipBounds.ts` | Entry params: `clips`, `draftId`, `reactingTo`, `rootDropId`, `edit`. Add `campaignId`; do not fork. |
| Render the final mp4 | `renderForPost`, native `video-render` | `lib/renderAtPost.ts`, `modules/video-render` | A submission **must** be a rendered single mp4. |
| Get footage into the editor | Camera-roll import, camera | `components/PostChoiceSheet.tsx`, `lib/pickerRetry.ts` | Drive/Dropbox footage is saved to Files/camera roll, then imported (no server-side link fetching). R2 footage is downloaded to the cache and opened. |
| Upload | `uploadToStorage` (XHR + FormData, retries, progress, cancel) | `providers/PostsProvider.tsx` ~l.432, hard-wired to Supabase + `drops` | Pattern reusable; the target changes to **presigned R2 PUT** (section 5). Clips (<=100 MB) can reuse the streaming-XHR approach almost unchanged. |
| Delete files later | `trial_media_delete_queue` + `delete-media` edge function | `migration-hide-ended.sql`, `supabase/functions/delete-media` | **Supabase-Storage only.** R2 needs its own queue + deleter (new). Same pattern, same cron style (`schedule-delete-media.sql`). |
| Auth, profiles, terms | Supabase auth, `profiles`, `terms_accepted_at` | `AuthProvider.tsx` | The web funding page needs the **same account** on the web (email OTP/magic link). |
| Age | `age_tier()`, teen mature filter | `migration-age-gating.sql` | Needs the strict adult check + DOB step (3.1). |
| Reporting & moderation | `reports`, `useReportContent`, queue, hide/remove, suspend/ban, log, owner alert | `migration-moderation/harassment/recovery/sanctions.sql`, `app/moderation-admin.tsx` | Extend `reports.target_type` with `campaign`, `clip`, `payout_dispute`. Sanctioned accounts: freeze payouts and hide campaigns. |
| Known connections | `known_connections` view | `migration-known-connections.sql` | **New use:** a collusion/laundering signal. Flag payouts where the clipper is a known connection of the funding creator (friends/contacts approving each other's clips). Flag only; do not block. |
| Blocks | `user_blocks`, `friends_blocked()` | | Blocked pairs cannot see/submit to each other's campaigns. |
| Word filter | `text_check`, `word_filter_terms` | `migration-harassment.sql` | On campaign title/description/requirements. |
| Notifications & push | `notifications` type check, `NotificationItem`, `push_claim_batch`, `send-push` | `migration-push.sql`, `supabase/functions/send-push` | New types: `clip_submitted`, `clip_approved`, `clip_rejected`, `payout_paid`, `payout_failed`, `campaign_funded`. |
| Edge-function patterns | Service-key auth check, `--no-verify-jwt` + own verification, pg_cron + pg_net schedule, dry-run-first | `functions/delete-media`, `functions/send-push`, `FUNCTIONS.txt`, `schedule-*.sql` | Copy the pattern for every new function. |
| Pure-logic tests | Erasable TS shared by the function and Node tests | `functions/send-push/map.ts` + `scripts/test-push.mjs` | **Put all money math/state machines in `supabase/functions/_shared/money.ts` the same way** (fee split, funding amounts, ledger postings, state transitions), tested in Node without Stripe or Deno. |
| SQL tests | Scratch-Postgres harness | `scripts/test-*-sql.mjs` | Ledger invariants, RLS, rotation of states. |
| Config tables | Singleton config rows | `spotlight_config`, `harassment_config`, `recovery_config` | `money_config`, `pro_config`. |
| Legal text | Generated Terms/Privacy | `constants/legal.ts`, `scripts/build-legal-html.mjs` | Marketplace/payments/Stripe/AI terms (section 6). |
| Release process | Ordered idempotent migrations applied by script | `apply-migrations.mjs`, `MIGRATIONS_ORDER.txt` | Add `migration-money.sql` (and later `migration-pro.sql`). |

**Do not reuse:** `posts` for submissions (they would enter the trial engine/feed); DMs for creator<->clipper talk; Supabase Storage for Money media (R2 instead, by decision); the public `drops` bucket.

---

## 2. What must not change (invariants; their tests stay green every step)

1. **Strangers-only feed.** Money never enters `get_feed_engine`, Explore, search, Spotlight or Recovery Boost. Untouched: `known_connections`, `trial_creators_who_know`, `posts_testing_not_for_known`, `spotlight_eligible`, `recovery_*`. `test-stranger-only-sql`, `test-spotlight-sql`, `test-recovery-sql` pass unchanged.
2. **Survive/72h/unjudged lifecycle.** Submissions are not posts: no `posts` row, no `trial_post_state`, no verdict, no feed.
3. **Messaging rules.** No new DM path. Creator<->clipper communication is **structured only** (status, fixed reject reasons, dispute categories). `CLAUDE.md`: "no text comments".
4. **Money invariants (new, absolute):**
   - The **ledger is append-only, in cents, USD only in v1**, and every transaction sums to zero.
   - **Stripe webhooks are the source of truth** for every movement of real money (funding, refunds, chargebacks, transfers, payouts). Internal reallocations (approve, release hold) are posted by edge functions with idempotency keys.
   - **The client never moves money.** No client-callable function can insert into the ledger, approve a payout, or change a balance. Money RPCs are `service_role`-only; the app calls edge functions that authenticate the user and call them.
   - Every Stripe API call carries an idempotency key derived from our own ids.
   - Secrets (Stripe, R2, RevenueCat) live only in `supabase secrets`; never in the repo or the app.
5. **Profiles stay public by design**, but Money content on profiles is shown only to Money-eligible (18+, flag) viewers, and birthdates become unreadable by others.
6. **Existing safety stack keeps working** (reports, blocks, filter, sanctions, 24h review promise).
7. **Release rules:** no `eas update` from this branch; SQL via `apply-migrations.mjs`; edge functions deployed by command; one native build per phase (Money v1; later Pro).
8. **Older builds (48/49) must not break.** Everything is additive except the `profiles.birthdate` column revoke (3.1): ship that only when the old direct read is gone or fails soft.

---

## 3. New tables, RLS and functions (exact schemas)

One migration for Phase A: `expo/supabase/migration-money.sql`, after `migration-sanctions.sql`. Idempotent. Convention from Phases 2-4: **every table closed** (`enable row level security; revoke all ... from anon, authenticated`); apps read through `security definer` RPCs; **write RPCs for money are `grant execute ... to service_role` only.**

### 3.1 Flags, adult gate, birthdate (prerequisite)

```sql
create table public.app_flags (
  key text primary key, enabled boolean not null default false,
  allow_user_ids uuid[] not null default '{}',          -- testers / App Review demo account, on while enabled = false
  updated_at timestamptz not null default now());
-- keys: 'money' (the tab and browsing), 'money_fund', 'money_approve', 'money_payouts' (independent kill switches), later 'pro'
create function public.flag_on(p_key text, p_user uuid) returns boolean ...      -- enabled or allow-listed
create function public.money_is_adult(p_user uuid) returns boolean ...           -- birthdate NOT NULL and age_tier = 'adult' (strict: 'unknown' is not adult)
create function public.money_allowed(p_user uuid) returns boolean ...            -- flag_on('money') and money_is_adult and not sanctioned
create function public.my_features() returns jsonb ...                           -- { money, needs_birthdate, pro }

-- Birthdate: nobody can read another person's; set once; admin-only change
revoke select on public.profiles from anon, authenticated;
grant select (/* every non-sensitive column, generated explicitly */) on public.profiles to anon, authenticated;
create trigger profiles_birthdate_lock before update of birthdate on public.profiles ... ;  -- raises unless old is null or mod_is_admin()
create function public.set_my_birthdate(date) returns text ...                   -- once; 13..110 years; returns age tier
create function public.my_age_tier() returns text ...                            -- replaces the app's direct birthdate select (PostsProvider ~l.1226)
```
Entering a teen DOB also enables the existing teen mature filter (visible behaviour change, intended). The self-declared DOB gates **browsing only**; the real gate is Stripe verification at cash-out (3.5).

### 3.2 Config

```sql
create table public.money_config (
  id boolean primary key default true check (id),
  currency text not null default 'usd' check (currency = 'usd'),
  fee_bps integer not null default 1000 check (fee_bps between 0 and 5000),   -- Tryal fee, % in basis points (10.00 %)
  fee_min_cents integer not null default 100,
  fee_payer text not null default 'creator' check (fee_payer in ('creator', 'clipper')),
  min_pay_cents_per_clip integer not null default 100,
  max_pay_cents_per_clip integer not null default 50000,
  min_budget_cents integer not null default 1000,
  max_budget_cents_new_creator integer not null default 5000,   -- first campaigns are capped (fraud brake)
  max_budget_cents integer not null default 500000,
  new_creator_days integer not null default 30,
  hold_days_after_approval integer not null default 14,         -- pending -> available (chargeback exposure window)
  review_reminder_days integer not null default 3,              -- days after a clip is submitted with no decision: remind the creator
  review_escalate_days integer not null default 5,              -- ...and escalate to the owner's dispute queue (never auto-approve / auto-reject)
  payout_batch_weekday integer not null default 1,              -- 1 = Monday: the owner approves payouts in one weekly batch
  dispute_sla_business_days integer not null default 3,
  min_payout_cents integer not null default 1000,
  unverified_accrual_cap_cents integer not null default 10000,  -- earnings an unverified clipper may accrue
  payout_manual_approval boolean not null default true,         -- v1: the owner approves every payout, in the Monday batch
  payouts_enabled boolean not null default false,               -- master kill switch
  funding_enabled boolean not null default false,
  allowed_countries text[] not null default '{US}',
  unclaimed_days integer not null default 180,
  max_footage_bytes bigint not null default 2147483648,         -- 2 GB (R2 single object cap is far higher)
  max_footage_seconds integer not null default 3600,
  max_clip_bytes bigint not null default 104857600,
  max_clip_seconds integer not null default 180,
  footage_keep_days_after_close integer not null default 14,
  signed_url_seconds integer not null default 600,
  max_footage_downloads_per_campaign integer not null default 300);
```

### 3.3 Campaigns, joins, submissions, media, downloads

```sql
create table public.money_campaigns (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 80),
  description text not null default '' check (char_length(description) <= 1000),
  requirements text not null default '' check (char_length(requirements) <= 1000),
  min_seconds integer not null default 5, max_seconds integer not null default 60, check (max_seconds >= min_seconds),
  aspect text not null default 'vertical' check (aspect in ('vertical', 'any')),
  -- pay: REAL or absent. A paid campaign cannot be open until funded.
  pay_kind text not null default 'flat' check (pay_kind in ('free', 'flat')),
  pay_cents integer,                          -- per approved clip
  max_approved integer,                       -- number of paid slots; budget = pay_cents * max_approved
  budget_cents bigint, fee_cents bigint,      -- computed server-side by create function (never from the client)
  funded_cents bigint not null default 0,
  payment_status text not null default 'none'
    check (payment_status in ('none', 'unfunded', 'checkout_open', 'funded', 'disputed', 'refund_pending', 'refunded')),
  stripe_checkout_session_id text unique, stripe_payment_intent_id text unique, stripe_charge_id text,
  -- footage: upload (R2) or a direct link; never YouTube/Twitch
  footage_kind text not null check (footage_kind in ('upload', 'link')),
  footage_url text,                           -- link: https, host allow-list below
  footage_object_id uuid references public.media_objects (id),   -- upload
  rights_attested boolean not null default false,
  max_per_clipper integer not null default 3 check (max_per_clipper between 1 and 10),
  deadline timestamptz not null,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed', 'removed')),
  moderation_status text not null default 'active' check (moderation_status in ('active', 'hidden', 'removed')),
  created_at timestamptz not null default now(), closed_at timestamptz, footage_deleted_at timestamptz,
  check ((pay_kind = 'free' and pay_cents is null and max_approved is null)
      or (pay_kind = 'flat' and pay_cents > 0 and max_approved between 1 and 1000)),
  check (rights_attested),
  check (footage_kind = 'upload' or footage_url ~* '^https://(drive\.google\.com|docs\.google\.com|www\.dropbox\.com|dropbox\.com|dl\.dropboxusercontent\.com)/[^ ]+$'),
  check (footage_url is null or footage_url !~* '(youtube\.com|youtu\.be|twitch\.tv)'));
-- status 'open' requires pay_kind = 'free' or payment_status = 'funded' (enforced by trigger, also checked in the functions)

create table public.money_media_objects (            -- every R2 object we know about (footage, clips, thumbs)
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('footage', 'clip', 'thumb', 'cover')),
  r2_key text not null unique,                       -- footage/<campaign>/<uuid>, clips/<campaign>/<submission>/<uuid>.mp4, ...
  content_type text not null, size_bytes bigint, duration_ms integer,
  status text not null default 'uploading' check (status in ('uploading', 'ready', 'deleted')),
  upload_id text,                                    -- R2 multipart upload id while uploading
  created_at timestamptz not null default now(), ready_at timestamptz, deleted_at timestamptz);

create table public.money_joins (                    -- "received footage": a clipper takes a job (accepts its terms) and gets footage access
  campaign_id uuid not null references public.money_campaigns (id) on delete cascade,
  clipper_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(), primary key (campaign_id, clipper_id));

create table public.money_submissions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.money_campaigns (id) on delete cascade,
  clipper_id uuid not null references public.profiles (id) on delete cascade,
  clip_object_id uuid not null references public.money_media_objects (id),
  thumb_object_id uuid references public.money_media_objects (id),
  duration_ms integer not null check (duration_ms between 500 and 180000),
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'withdrawn', 'disputed', 'auto_expired')),
  reject_reason text check (reject_reason is null or reject_reason in ('off_brief', 'too_long', 'quality', 'rights', 'other')),
  pay_cents integer,                                -- snapshot at approval
  show_on_profile boolean not null default true,
  moderation_status text not null default 'active' check (moderation_status in ('active', 'hidden', 'removed')),
  created_at timestamptz not null default now(), decided_at timestamptz);

create table public.money_downloads (id bigint generated always as identity primary key,
  kind text not null check (kind in ('footage', 'clip')), campaign_id uuid not null, submission_id uuid,
  user_id uuid not null, created_at timestamptz not null default now());   -- audit + egress/abuse brake
```

### 3.4 The ledger (append-only, cents)

```sql
create table public.ledger_txns (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('campaign_funded', 'clip_approved', 'clip_released', 'payout_requested', 'payout_canceled',
        'payout_paid', 'payout_failed', 'campaign_refund', 'fee_refund', 'stripe_fee', 'chargeback_hold', 'chargeback_won',
        'chargeback_lost', 'adjustment', 'unclaimed_return')),
  campaign_id uuid, submission_id uuid, payout_id uuid, user_id uuid,
  idempotency_key text not null unique,             -- 'stripe:<event id>', 'approve:<submission id>', 'release:<submission id>', 'payout:<id>:requested'
  stripe_event_id text, memo text, created_by uuid, created_at timestamptz not null default now());

create table public.ledger_entries (
  id bigint generated always as identity primary key,
  txn_id uuid not null references public.ledger_txns (id),
  acct_kind text not null check (acct_kind in ('stripe_clearing', 'escrow', 'tryal_fees', 'stripe_fees',
        'wallet_pending', 'wallet_available', 'payout_hold', 'stripe_out', 'tryal_loss')),
  acct_ref uuid,                                    -- campaign (escrow) or user (wallet_*, payout_hold); null for platform accounts
  amount_cents bigint not null check (amount_cents <> 0),     -- positive increases the account
  currency text not null default 'usd' check (currency = 'usd'),
  created_at timestamptz not null default now(),
  check ((acct_kind in ('escrow', 'wallet_pending', 'wallet_available', 'payout_hold')) = (acct_ref is not null)));
create index on public.ledger_entries (acct_kind, acct_ref);
-- INVARIANTS, enforced in the database (each with a test):
--  1. deferred constraint trigger: sum(amount_cents) per txn_id = 0
--  2. BEFORE UPDATE/DELETE/TRUNCATE triggers raise; privileges revoked from every role except the insert path
--  3. deferred check: escrow:<campaign>, wallet_pending:<user>, wallet_available:<user>, payout_hold:<user> never go below 0
--  4. insert only through money_post(...) (service_role), which takes the idempotency key and is a no-op on a repeat
create view public.wallet_balances as ...           -- per user: pending, available, in payout (sums of the entries)
```

Postings (sign: + increases that account; each row sums to 0):

| kind | entries |
|---|---|
| `campaign_funded` (webhook) | `stripe_clearing -(B+F)`, `escrow:campaign +B`, `tryal_fees +F` |
| `stripe_fee` (webhook, from the balance transaction) | `tryal_fees -s`, `stripe_fees +s` (our cost of collecting) |
| `clip_approved` (approve function) | `escrow:campaign -P`, `wallet_pending:clipper +P` (+ `-fee`/`tryal_fees` if `fee_payer = clipper`) |
| `clip_released` (cron, after `hold_days_after_approval`) | `wallet_pending -P`, `wallet_available +P` |
| `payout_requested` | `wallet_available -A`, `payout_hold +A` |
| `payout_paid` (Stripe `transfer.created` webhook) | `payout_hold -A`, `stripe_out +A` |
| `payout_failed` / `payout_canceled` | `payout_hold -A`, `wallet_available +A` |
| `campaign_refund` (Stripe `charge.refunded` webhook) | `escrow:campaign -R`, `stripe_clearing +R` (+ `fee_refund`: `tryal_fees -Fr`, `stripe_clearing +Fr`) |
| `chargeback_*` (Stripe dispute webhooks) | hold/release/loss postings; a loss on already-paid-out money goes to `tryal_loss` |

Stripe-originated postings are written **only** by the webhook handler; everything else by the function that performs the action. Nightly `money-reconcile` compares ledger sums with the Stripe platform balance and raises a flag on drift.

### 3.5 Stripe linkage, payouts, disputes, events

```sql
create table public.stripe_customers (user_id uuid primary key references public.profiles (id), customer_id text not null unique);
create table public.connect_accounts (
  user_id uuid primary key references public.profiles (id) on delete restrict,
  stripe_account_id text not null unique, country text,
  details_submitted boolean not null default false, charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false, requirements_due jsonb not null default '[]',
  identity_verified_at timestamptz,
  stripe_adult boolean,                                -- derived from the DOB Stripe holds (>= 18), never trusted from the client
  dob_mismatch boolean not null default false,         -- Stripe DOB vs the self-declared birthdate: freezes payouts, goes to the admin queue
  updated_at timestamptz not null default now());
create table public.payout_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles (id),
  amount_cents bigint not null check (amount_cents >= 100),
  status text not null default 'requested' check (status in ('requested', 'approved', 'processing', 'paid', 'failed', 'rejected', 'canceled')),
  flags text[] not null default '{}',                  -- 'new_account', 'known_connection_of_funder', 'dob_mismatch', 'large', 'velocity'
  requested_at timestamptz not null default now(), reviewed_by uuid, reviewed_at timestamptz, review_note text,
  stripe_transfer_id text unique, stripe_payout_id text, failure text, idempotency_key text not null unique);
create table public.money_disputes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('clip_rejection', 'clip_quality', 'payment', 'chargeback')),
  campaign_id uuid, submission_id uuid, opened_by uuid, status text not null default 'open'
    check (status in ('open', 'resolved_for_clipper', 'resolved_for_creator', 'dismissed')),
  reason text check (char_length(reason) <= 500), resolution_note text, resolved_by uuid,
  created_at timestamptz not null default now(), resolved_at timestamptz);
create table public.stripe_events (id text primary key, type text not null, account text, received_at timestamptz not null default now(),
  processed_at timestamptz, error text);                -- insert-first dedupe: a replayed event is a no-op
```

**Cash-out gate:** `money_can_cash_out(user)` = `payouts_enabled` (config) and Connect `payouts_enabled` and `identity_verified_at` set and `stripe_adult` and not `dob_mismatch` and not sanctioned and country allowed. Earnings accrue meanwhile up to `unverified_accrual_cap_cents`.

### 3.6 Read RPCs (apps may call; all `money_allowed`-gated)

`list_money_jobs`, `get_money_job`, `my_money_joins` (received footage), `my_money_submissions`, `my_money_campaigns`, `money_campaign_submissions` (creator only), `my_wallet` (balances + last 100 ledger rows for me, **no** other users), `my_payouts`, `profile_money_clips(user)` (approved, shown only to Money-eligible viewers, with credit = creator username), `set_clip_on_profile`. **There are no write RPCs for money**; writes go through edge functions (section 4).

### 3.7 Hooks into existing systems

Reports target types `campaign`, `clip`; queue previews; hide/remove sets `moderation_status`. Sanction guard (plain `IF`s, as before) on both tables plus freezing that user's payout requests and hiding their campaigns/clips (restored on lift). Word-filter trigger on text fields. Notification types extended; `push_claim_batch` mapping; `lib/pushCore.ts` route allow-list. **Account deletion** must refuse (or settle) while the user has a wallet balance, an open payout, an open campaign with escrow, or a Connect account with pending obligations (also an App Store 5.1.1(v) requirement that deletion works in-app); otherwise cascades must queue R2 deletions.

---

## 4. Edge functions (new) and where money logic lives

All money logic is in edge functions using the service role; the app and the web page only authenticate the user and call them. Pure logic is in `_shared/money.ts` (Node-tested). New secrets (set with `supabase secrets set`, never committed): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `APP_WEB_URL`; Pro adds `REVENUECAT_WEBHOOK_AUTH` and AI provider keys.

| Function | Auth | Does |
|---|---|---|
| `money-create-campaign` | user JWT | validates; computes `budget`/`fee` with `money.ts` (never from the client); checks quotas, `max_budget_cents_new_creator`, adult, flags, `text_check`; creates the draft row |
| `money-create-funding-session` | user JWT (from the web page) | creates a **Stripe Checkout Session** (mode `payment`, card + wallets only, no delayed methods; line item budget + fee; `metadata.campaign_id`; `transfer_group = campaign:<id>`; Idempotency-Key `fund:<campaign>:<attempt>`); returns the URL |
| `stripe-webhook` (platform events) | Stripe signature, `--no-verify-jwt` | insert-first into `stripe_events`; handles `checkout.session.completed`/`expired`, `payment_intent.*`, `charge.refunded`, `charge.dispute.created/closed`, balance-transaction fees; posts the ledger; opens the campaign when funded |
| `stripe-connect-webhook` (connected-account events) | Stripe signature | `account.updated` (verification state, DOB -> `stripe_adult`/`dob_mismatch`), `transfer.*`, `payout.paid/failed`, `capability.updated` |
| `money-connect-onboarding` | user JWT | creates/gets the **Express** account (US only), returns an Account Link; `money-connect-login` returns the Express dashboard link |
| `money-approve-clip` | user JWT (creator) | locks the campaign row, checks escrow >= pay, posts `clip_approved`, sets the submission approved, closes the campaign at the cap, notifies the clipper. Idempotency key `approve:<submission>` |
| `money-reject-clip` | user JWT (creator) | fixed reasons only |
| `money-request-payout` | user JWT | enforces the cash-out gate, minimum, flags; posts `payout_requested`; creates the request |
| `money-admin` | user JWT, must be in `spotlight_admins` | approve/reject payouts (calls Stripe Transfer, Idempotency-Key `payout:<id>`), resolve disputes (force-approve pays from escrow; or refund), refund a campaign, freeze/unfreeze a user, post an `adjustment` (reason mandatory, logged) |
| `money-cron` | service key, pg_cron + pg_net like `schedule-send-push.sql` | releases holds (`clip_released`), closes expired campaigns, issues refunds of unspent escrow after the review window, sends the day-3 review reminder to creators and the day-5 escalation to the owner's queue, builds the Monday payout batch, retries failed transfers, queues R2 deletions, clears abandoned uploads |
| `money-reconcile` | service key, nightly | ledger vs Stripe balance; writes a flag, never "fixes" |
| `r2-upload-init` / `r2-upload-parts` / `r2-upload-complete` | user JWT | R2 S3 multipart: create, presign part URLs (short TTL), complete + verify size/content-type against limits, mark `ready` |
| `r2-get-url` | user JWT | decides access in SQL (`money_can_read(object)`: creator of the campaign; joined and eligible clipper for footage; clipper/creator/approved-and-eligible viewer for clips), logs `money_downloads`, enforces the per-campaign cap, returns a presigned GET (TTL `signed_url_seconds`) |
| `r2-delete` | service key | drains an `r2_delete_queue` (the existing `delete-media` is Supabase-Storage only) |
| `send-push` (modified) | existing | new money notification types |

Web page (not in-app): a small static site (Cloudflare Pages or the DropDay-Legal GitHub Pages repo is enough because all logic is in functions) with Supabase email-OTP/magic-link login, "campaigns waiting for funding", fee breakdown, `Fund $X` -> Checkout, receipts, refund status. Hosting must be HTTPS with a Terms/Privacy/refund-policy footer (Stripe requires them).

---

## 5. Footage in Cloudflare R2 (and the resumable-upload evaluation)

- **Bucket:** one private bucket, no public access, no custom domain. Keys: `footage/<campaign>/<uuid>`, `clips/<campaign>/<submission>/<uuid>.mp4`, `thumbs/...`. Access only via **presigned S3 URLs** from edge functions (SigV4 with `aws4fetch`), because R2 has no Supabase-style RLS: **all authorisation is one SQL function, `money_can_read(...)`, called by `r2-get-url`.** Add a test that no client code path uses an R2 URL it did not get from that function.
- **Why R2:** no egress fees, which removes the dominant cost of revision 1 (footage x clippers). Verify current pricing before committing: storage per GB-month and per-operation (Class A/B) charges still apply. Bytes go client <-> R2 directly, so Supabase edge limits (time, memory) do not constrain uploads.
- **Lifecycle:** `money-cron` queues deletion `footage_keep_days_after_close` after a campaign closes; R2 bucket lifecycle rules are the backstop (abort incomplete multipart uploads after 2 days; delete `footage/` older than 90 days). Approved clips are kept until the clipper deletes them or the account is deleted.
- **Resumable upload client: evaluate with a spike on a real device before building** (success criteria: 500 MB on LTE, airplane-mode toggle mid-upload, app backgrounded, relaunch, memory ceiling):
  1. **S3 multipart with presigned part URLs** (8-16 MB parts, retry per part, resume = list uploaded parts). Needs reading a file slice without loading the whole file. First check whether the new `expo-file-system` `File`/`FileHandle` API (read bytes at an offset) in the installed SDK can do this; if yes there is no extra native dependency. Otherwise a native blob/slicing library (`react-native-blob-util`) means a new native module (fine inside the Phase A build, verify SDK 57 compatibility).
  2. **Single presigned PUT** streamed from disk with the existing XHR pattern (`PostsProvider.uploadToStorage`). No resume; a retry restarts. Acceptable for clips (<=100 MB), weak for 2 GB footage on cellular.
  3. **iOS background URLSession upload** (`expo-file-system` background uploads): survives suspension, but the repo already records `-997` "lost connection to background transfer service" problems with it (comment in `uploadToStorage`).
  4. **tus:** not applicable (R2 has no tus endpoint).
  Recommendation: ship clips with option 2; ship footage upload with option 1 if the spike passes, otherwise cap footage at ~500 MB with option 2 and push large footage to Drive/Dropbox links.
- **Links:** `footage_url` host allow-list is enforced by a DB check (Google Drive, Dropbox only; YouTube/Twitch explicitly denied). **Never fetched server-side** (SSRF, quota and ToS reasons). The clipper opens the link in the system browser or the Drive/Dropbox app and saves to Files/camera roll, then imports. Dropbox `dl=1` links may be downloaded client-side; Google Drive large files hit interstitials, so treat Drive as "open and save" only. Terms: the creator attests rights, the link must be reachable "anyone with the link".

---

## 6. Apple, legal and money-compliance questions (answer before engineering)

**Apple App Review (guideline 3.1 and neighbours).** Verify the current guideline text; the points below are risks, not rulings.
1. **3.1.1 (IAP for digital goods/services).** Creators paying to commission clips is a payment for a service whose deliverable is a digital file. Candidate exemptions: **3.1.3(e) goods and services consumed outside the app** (the clips are downloaded and posted elsewhere) is the most plausible; **3.1.3(d) person-to-person services** requires real-time one-to-one, which this is not. Reviewers may nonetheless read it as in-app digital content and require IAP (15-30%) for funding. **Ask App Review in advance** (App Review "request a call" or a pre-submission query) and design for the possibility of a rejection.
2. **Linking out.** Funding "on a web page, not in-app" still raises the question of whether the app may show a button/link/call-to-action to it. Outside the US storefront, external purchase links generally need a special entitlement and disclosure; in the US they are currently allowed under a court order that can change. Options: (a) **no link and no price/CTA in the app at all** - the app shows only "Funded / Not funded", and the creator funds from the website using the same account; (b) a link only in the US with the entitlement/disclosure Apple requires. Recommendation: (a) for v1, with the website reachable from the Terms and the creator's email; confirm with Apple.
3. **Payouts.** Paying people for work is not an IAP matter, but the app facilitates peer-to-peer payments; confirm there is no licensing issue under guidelines on financial services and money transmission (3.2.x and state rules).
4. **2.3.1 hidden features.** Do not ship Money flagged off and enable it later without telling Apple. Put the App Review account in `app_flags.allow_user_ids`, describe the feature and test credentials in the review notes, and keep Stripe in test mode for that account if possible.
5. **5.1.1(v) account deletion** must still work in-app (section 3.7), and **1.2 UGC safeguards** apply to campaigns and clips.
6. **Age rating questionnaire** (UGC, financial transactions) may move the rating; decide before submission.

**Stripe and legal.**
1. **Business entity (DECIDED: launch as a sole proprietor, form an LLC when investors arrive).** The Terms say the app is "operated by Brendan McCormack". A Stripe Connect platform holds other people's money and takes disputes and negative balances on the platform; as a sole proprietor that exposure is **personal**. Not legally required, but it sets the guardrails in 6.2.
2. **Stripe platform approval** for a marketplace; Express accounts mean Stripe handles onboarding/KYC and (for US) tax-form support is an add-on to verify. Confirm Express vs Standard liability and pricing (per-active-account and per-payout fees) at current rates.
3. **Money transmission.** Holding funds in escrow for third parties can trigger state money-transmitter rules; Connect's "separate charges and transfers" is designed for platforms but long holds and refunds need counsel's view. Keep holds short and funds on Stripe.
4. **Tax:** US 1099 reporting for clippers' earnings, sales tax treatment of the Tryal fee, and your own income reporting. Ask an accountant.
5. **Contracts:** Marketplace Terms (who is paid, when, what counts as approved), refund/dispute policy, clipper and creator terms, Stripe Connected Account Agreement link, privacy policy (payment processors, identity verification by Stripe), footage rights/DMCA flow.
6. **US-only at launch** (`allowed_countries = {US}`) to limit tax/KYC/licensing scope.

---

## 6.2 Launching as a sole proprietor (decided), and moving to an LLC later

Guardrails that make personal liability tolerable (all are config values or process, none change the architecture):
- **Tiny live caps at first:** `max_budget_cents_new_creator` $50, `max_budget_cents` $200 during the allow-list phase, a handful of testers, US only.
- **Long hold, manual approval:** `hold_days_after_approval` 14, `payout_manual_approval = true` for every payout, chargeback freeze (steps 11 and 13).
- **Keep money separate:** an EIN (free) so your SSN is not on Stripe, a separate bank account for Tryal and Stripe payouts, and never pay personal expenses from it. Expect to report the income on Schedule C and a Stripe 1099-K.
- **Insurance:** ask a broker about general liability/cyber cover that accepts a sole proprietor.
- **A paid lawyer/accountant hour** before live mode: sole-proprietor marketplace, sales tax on the fee, money-transmission exposure, the Terms' marketplace/refund/dispute clauses.
- **Public name:** the App Store and Terms show your personal name and address as the seller; use a P.O. box or virtual address if you do not want your home address public.

Designing for the later LLC move (investors will want one):
- Keep every Stripe id behind our own tables (`stripe_customers`, `connect_accounts`, `money_campaigns.stripe_*`) and never hard-code the account in code; it lives in secrets.
- **Ask Stripe early** whether a sole-proprietor platform account can be converted to an LLC in place (business-type change with re-verification) or whether a new platform account is needed. If a new account is needed, **Connect Express accounts do not move between platforms**, so every clipper would have to re-onboard and open payouts would have to be settled first. This is the main migration cost of starting without an LLC; weigh it against waiting.
- Apple: converting an individual developer account to an organisation (or transferring the app) is a supported but slow process that needs a D-U-N-S number for the LLC; start it before the investor deadline.
- Contracts: the Terms' operator name changes; users must be notified under the Terms' change clause.
- Investors will do diligence on money flows: keep the append-only ledger, reconciliation reports and the dispute log tidy from day one.

## 6.1 Fee economics (worked examples; verify Stripe's current pricing before relying on any number)

Assumptions for the arithmetic only: card processing about 2.9% + 30 cents of the amount charged (not returned on refunds); Connect adds per-active-account and per-payout fees (not modelled here); Tryal fee = `fee_bps` of the budget with a floor of `fee_min_cents`; the creator pays budget + fee.

| Budget | Fee at 10% (floor $1) | Charged to creator | Stripe processing (approx.) | Left for Tryal before Connect fees |
|---|---|---|---|---|
| $10 | $1.00 | $11.00 | $0.62 | $0.38 |
| $20 | $2.00 | $22.00 | $0.94 | $1.06 |
| $50 | $5.00 | $55.00 | $1.90 | $3.10 |
| $200 | $20.00 | $220.00 | $6.68 | $13.32 |

Consequences to build in:
- Below about $20 a campaign earns almost nothing, so keep `min_budget_cents` at $10-$20 and `fee_min_cents` at $1+.
- One chargeback on a $50 campaign costs the $50 plus a dispute fee (about $15 at current rates): roughly 13-15 fully-paid $50 campaigns of fees to recover it. This is why the plan has the first-campaign cap, the hold period, manual payout approval and dispute freeze.
- Taking a percentage makes Tryal the marketplace operator: fee income is taxable, sales-tax treatment of the fee must be checked with an accountant, and the fee does not reduce liability (sole proprietor or LLC).
- Collect the fee through Stripe's application-fee mechanism (and mirror it in the ledger as `tryal_fees`) so Stripe and the ledger agree and `money-reconcile` can verify it.
- Refund policy decision (section 10, item 7) matters here: processing fees are not returned by Stripe, so each refunded campaign costs real money unless the policy charges for it.

## 7. Build order, Phase A: Money v1 (each step = one commit, own tests; all flags off until step 24)

**Gate 0 - decisions and non-engineering (no code):** answer section 10; open Stripe (test mode first) and Cloudflare R2; ask App Review the 3.1 question; counsel/accountant review of 6. **Entity decision made: sole proprietor first (6.2). Test-mode work (steps 1-14) can start now; going live (step 24) waits for the Apple answer, a lawyer/accountant check of the sole-proprietor setup, and the 6.2 guardrails.**

1. **Flags + adult gate (SQL).** `app_flags`, `flag_on`, `money_is_adult`, `money_allowed`, `my_features`. *Test:* off -> false; allow-list true; unknown/teen/under-13 false; sanctioned false.
2. **Birthdate lock-down + collection.** Column privileges, lock trigger, `set_my_birthdate`, `my_age_tier`; `app/onboarding-birthdate.tsx`; sign-up DOB field; move `PostsProvider`'s direct birthdate select to the RPC. *Test (SQL):* others cannot read a birthdate; user cannot change it once set; admin can. *Test (JS):* no direct `birthdate` select remains.
3. **`money_config`, `money_campaigns` (free + draft), joins, submissions (schema only) + read RPCs + filters/blocks.** *Test:* constraints (pay/budget, host allow-list incl. YouTube/Twitch denial), blocked pairs hidden, flag off refuses.
4. **Pure money logic `_shared/money.ts`** (fee calc, budget, posting builders, state machines, payout flags) + `scripts/test-money.mjs`. *Test:* rounding, fee min, fee_payer both ways, every posting sums to zero, illegal transitions rejected.
5. **Ledger tables + invariants + `money_post` + wallet view.** *Test (SQL):* zero-sum enforced, append-only (update/delete/truncate fail), negative balances refused, idempotent repeat is a no-op, concurrency (two approvals of the last slot).
6. **R2 plumbing:** bucket, `money_media_objects`, `r2-upload-*`, `r2-get-url`, `r2-delete`, `money_can_read`. *Test:* SQL for `money_can_read` (creator, joined clipper, un-joined, blocked, teen, flag off, closed campaign, download cap); manual R2 round trip.
7. **Resumable-upload spike (section 5)** on device; pick the client; document the result in this file.
8. **Stripe test-mode funding:** `money-create-campaign`, `money-create-funding-session`, `stripe-webhook` (`campaign_funded`, `stripe_fee`, `checkout.session.expired`), the web page. *Test:* fixtures via Stripe CLI (`stripe trigger`), **replay the same event twice** (one ledger txn), out-of-order and missing events, session expired, amount mismatch rejected.
9. **Approve/reject:** `money-approve-clip`/`money-reject-clip`, `clip_approved` posting, escrow checks, cap-closes-campaign. *Test:* double-approve, approve with insufficient escrow, creator-only, concurrent last slot.
10. **Connect onboarding:** `money-connect-onboarding`, `stripe-connect-webhook` (`account.updated` -> verification, `stripe_adult`, `dob_mismatch`). *Test:* under-18 DOB from Stripe blocks cash-out; mismatch freezes and flags.
11. **Holds + payouts:** `money-cron` (`clip_released`), `money-request-payout`, payout flags (new account, known connection of funder, velocity), `money-admin` approve -> Stripe Transfer, `transfer.created` -> `payout_paid`, failures -> `payout_failed`. *Test:* gate, minimum, double request, replayed webhook, failed transfer returns funds.
12. **Refunds + review reminders:** unspent escrow refund after close and once no submission is waiting (decided or escalated), `charge.refunded` -> postings, fee refund rule; day-3 creator reminder and day-5 escalation (`review_reminder_days`, `review_escalate_days`, counted from the submission time). *Test:* partial/full refunds, refund while submissions are pending.
13. **Disputes/chargebacks:** `money_disputes`, `charge.dispute.*`, freeze/release, loss posting; admin resolve. *Test:* dispute before/after payout, escrow frozen, no double loss.
14. **Reconciliation + owner alerts:** `money-reconcile`; **an alert (in-app + push via `send-push`; email through a mail provider, see 10.A) whenever anything enters the admin queue**: a report, a payout request (and the Monday batch summary), a dispute or chargeback, a day-5 escalation, a flag (`dob_mismatch`, known-connection payout), or reconciliation drift. One `owner_alerts` function/trigger family, one dedupe key per item.
15. **Client scaffold:** `FeaturesProvider`, "Money" tab ($ icon, `DollarSign`) shown only when `features.money`; five-section shell; deep-link guards. *Test:* tab absent when flag off or birthdate missing.
16. **Jobs + Footage sections:** browse, join (accepts terms), received-footage list, download via `r2-get-url`, Drive/Dropbox link flow.
17. **Creator: create a campaign:** title/requirements/deadline, pay and slots, rights attestation, footage upload (client from step 7) or link, fee breakdown, "Fund on the web" state (no in-app payment UI; Apple option (a)).
18. **Clipper: edit and submit:** `campaignId` editor mode (duration bounds, render required, no raw fallback), `lib/moneySubmit.ts` (render -> R2 clip upload -> `submit_clip`). *Test:* JS guards; SQL caps/deadline/size/path spoofing.
19. **My submissions + My campaigns (review, approve/reject, download approved clips to the camera roll via the existing `saveToRoll`).**
20. **Wallet:** balances, history, cash-out flow (onboarding, request, statuses).
21. **Profile credit:** `profile_money_clips`, `set_clip_on_profile`, credit line, hidden from teens/non-eligible.
22. **Moderation + admin:** report targets, queue previews, sanction hooks, `app/money-admin.tsx` (payout approvals with flags, disputes, refunds, ledger search, freeze, adjustment with mandatory reason, everything logged to `moderation_log`).
23. **Notifications + push + legal:** types, `send-push` redeploy, Terms/Privacy/refund policy, `CLAUDE.md` (navigation: Feed, Money, +, Me; invariants), review notes with the demo account.
24. **Staged rollout:** test mode end-to-end with real Stripe test cards and a real Express test account -> allow-list (you + a few testers, **live mode, tiny amounts**) -> raise caps -> `money = true`. Kill switches: `money_fund`, `money_approve`, `money_payouts`, `money`.

Order notes: the ledger, pure logic and webhook tests (4-5, 8-13) precede every UI because correctness of money cannot be bolted on; step 7 (spike) can run in parallel with 4-5; steps 15-21 can start once 3 and 6 exist, using test-mode data.

---

## 8. Phase B: Pro ($9.99/mo, Apple IAP via RevenueCat) - separate phase after Money v1

**Scope:** server-side **moment finder**, **AI hooks**, **saved caption styles**, **reframing**, **batch of 5**, with a **monthly footage-hours cap**.

**Product rules to settle first**
- Pro is a **digital subscription unlocked in-app: Apple IAP is mandatory** (guideline 3.1.1/3.1.2); the web can also sell it but must not be the only way. Price shown, auto-renew disclosure, "Restore Purchases", "Manage Subscription" link, and Terms/Privacy links on the paywall (3.1.2).
- Do **not** paywall what already ships free (on-device silence cuts, ums, captions, hook trim): Pro adds new capabilities only.
- **Cost rules.** `CLAUDE.md` currently says "No paid AI API in the core product" and "the editor works on-device". Pro uses paid server compute/AI by design; update the rule to scope it explicitly: *paid APIs only behind a Pro entitlement, with a hard per-user cap and spend alarm; the free product stays on-device.*
- **Third-party AI disclosure.** Sending users' footage/transcripts to an AI provider requires explicit disclosure and consent in-app (Apple 5.1.1/5.1.2 on third-party data sharing and AI) and a privacy-policy update; footage that belongs to a creator (campaign footage) needs the creator's consent in the campaign terms before a clipper's Pro tools process it.

**New tables (migration-pro.sql)**
```sql
create table public.entitlements (                    -- written only by the RevenueCat webhook (service role)
  user_id uuid not null references public.profiles (id) on delete cascade, entitlement text not null,   -- 'pro'
  product_id text, expires_at timestamptz, is_active boolean not null default false,
  store text not null default 'app_store', original_transaction_id text,
  rc_event_id text, updated_at timestamptz not null default now(), primary key (user_id, entitlement));
create table public.pro_config (id boolean primary key default true check (id),
  footage_hours_per_month numeric not null default 10, batch_size integer not null default 5,
  moments_per_job integer not null default 12, hooks_per_job integer not null default 5,
  max_footage_hours_per_job numeric not null default 2, transcript_keep_days integer not null default 7);
create table public.pro_usage (                        -- append-only; reserve-then-settle so the cap cannot be raced
  id bigint generated always as identity primary key, user_id uuid not null, period date not null,   -- first day of the month
  kind text not null check (kind in ('moment_finder', 'hooks', 'reframe')), seconds_reserved integer not null default 0,
  seconds_settled integer, job_id uuid, created_at timestamptz not null default now());
create table public.moment_jobs (id uuid primary key default gen_random_uuid(), user_id uuid not null, campaign_id uuid,
  media_object_id uuid references public.money_media_objects (id), status text not null default 'queued'
  check (status in ('queued', 'running', 'done', 'failed', 'canceled')), error text, created_at timestamptz default now(), finished_at timestamptz);
create table public.moments (id uuid primary key default gen_random_uuid(), job_id uuid references public.moment_jobs (id) on delete cascade,
  start_ms integer not null, end_ms integer not null, score real, label text, hook_text text);
create table public.caption_style_presets (id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) <= 40), style jsonb not null, created_at timestamptz default now());   -- style = existing CaptionStyle (lib/editModel.ts); free users keep 1, Pro unlimited
```
`pro_active(user)` (SQL) is the one entitlement check used by every Pro function; the client only reads `my_features().pro` to show UI.

**Edge functions (new):** `revenuecat-webhook` (own auth header; verify, upsert `entitlements`, idempotent on `rc_event_id`), `pro-moment-job-create` (checks entitlement, reserves hours in `pro_usage`, enqueues), `pro-hooks` (LLM call over the transcript, capped), `pro-job-callback` (worker result, settles usage, returns unused reserve). **Compute:** a transcription + moment-scoring pass over hours of footage does not fit a Supabase edge function; use an external worker (Cloudflare Workers + Queues calling a hosted ASR/LLM, or a small queue worker on a container host) that reads the R2 object with a short-lived presigned URL and posts results back. Decide the provider by cost per audio-hour. **Reframing** is better on-device (Apple Vision face/person tracking in a new native module) than server-side: zero marginal cost, consistent with the cost rules, but it is new native Swift (compile risk, as with `video-render`). **Batch of 5** is orchestrated on-device by the existing editor/render pipeline (`acquireNative` serialises renders): it turns the top moments into 5 trimmed drafts, then each is edited/submitted normally.

**Client:** `react-native-purchases` (RevenueCat SDK; native module, so a second EAS build), paywall screen, entitlement hook, Pro badge, usage meter ("6.5 of 10 footage hours left"), moment-finder UI in the editor that returns `trim_data`-style ranges the existing editor already understands.

**Build order, Phase B (each testable; flag `pro` allow-list first):**
- P1 App Store Connect subscription group + product, RevenueCat project, sandbox testers (no code).
- P2 `entitlements` + `revenuecat-webhook` + tests (replayed events, expiry, refund/grace, family sharing).
- P3 SDK + paywall + restore + entitlement-gated UI shell; second native build.
- P4 `caption_style_presets` (smallest feature, validates entitlement plumbing end to end).
- P5 `pro_usage` reserve/settle + cap tests (race: two jobs at the cap).
- P6 Worker infra + `pro-moment-job-create`/callback + moment finder UI.
- P7 `pro-hooks`.
- P8 Batch of 5 (on-device orchestration, no new server).
- P9 Reframing spike (Vision vs server) then build.
- P10 Cost alarms, caps tuned, Terms/Privacy/App Store updates, staged rollout.

---

## 9. Risks (updated)

**Money (highest).**
- **Chargebacks and stolen cards.** Creators fund with cards; a dispute can land up to ~120 days later, after clippers were paid. The platform eats the loss. Mitigations in the plan: first-campaign budget cap, new-creator limit, `hold_days_after_approval`, manual payout approval in v1, Radar/3-D Secure, payout flags, dispute freeze, `tryal_loss` accounting. Residual risk is real; start with tiny caps.
- **Laundering/collusion:** a creator and an alias clipper approve each other to move stolen money out. Hold period, verification at cash-out, known-connection flag, velocity flags, manual approval.
- **Fees on small amounts.** Stripe's processing fee on a $10 budget plus Connect per-account/per-payout fees can exceed a 10% Tryal fee; `fee_min_cents`, `min_budget_cents`, `min_payout_cents` exist for this. Processing fees are generally not returned on refunds, so a refund policy must say who absorbs them.
- **Correctness:** a ledger bug is a money bug. Append-only, zero-sum, non-negative-balance and idempotency are enforced in the database and tested; replayed/out-of-order webhooks are tested; nightly reconciliation; adjustments are admin-only and logged.
- **Unreviewed submissions and disputes:** creators who never decide. `review_window_days` then escalate to the admin dispute queue (do not auto-approve: a creator could be charged for off-brief clips; do not auto-reject: clippers lose unpaid work).
- **Regulatory/tax/entity** (section 6), **Stripe account risk** (marketplace review, holds on your own account if disputes spike), **account deletion with money outstanding** (section 3.7).
- **Verification mismatches:** Stripe DOB under 18 or different from the self-declared birthdate: payouts freeze and queue for review; policy needed for what happens to earned funds.

**Apple.** 3.1.1/3.1.3 classification of funding (rejection or forced IAP), link-out rules, hidden-feature rule, financial-service licensing questions, subscription disclosure rules for Pro, age-rating changes. Treat the review as a gate with a fallback: if funding must go through IAP, the economics (15-30%) change the fee model.

**R2 and access control.**
- No RLS: authorisation is one SQL function behind `r2-get-url`; a bug there leaks footage. Presigned URLs are bearer tokens for `signed_url_seconds`. Keep the bucket private, short TTL, per-campaign download cap, audit table.
- Secrets (R2 keys) in edge-function secrets only; rotate; scope the token to one bucket.
- Cost: no egress fees, but storage at rest and per-operation charges grow with footage and multipart uploads; lifecycle rules and `footage_keep_days_after_close` are the controls.
- Two storage systems now exist (Supabase for posts, R2 for Money); deletion on account removal must cover both.

**Footage and content abuse.** Creator-uploaded footage is arbitrary video on your infrastructure; copyright (clippers make derivative works that become public on profiles), and illegal content. Controls: rights attestation, DMCA path (Terms 13), report button on campaign and clip, 3-report auto-hide extended, admin queue preview, owner alert, a written takedown/CSAM procedure and the 24-hour review promise (who reviews?). No automated scanning exists (and none is planned in the free product).

**Links.** Drive/Dropbox link rot, permission errors, interstitials and quotas are the creator's problem but will generate support. Never fetch server-side. Keep the host allow-list and the YouTube/Twitch denial in the database, not only the UI.

**Birthdate and 18+.** Self-declared DOB is easy to lie about; it gates browsing only. Stripe verification at cash-out is the real gate; clippers may do unpaid work before discovering they cannot cash out if unverified (hence the accrual cap and an up-front warning).

**Pro.** AI cost runaway (caps, reserve-then-settle, spend alarm), third-party data sharing/consent, footage belonging to creators processed by a clipper's tools, App Store subscription rules, a second native build, worker infrastructure you have to operate, and the `CLAUDE.md` cost-rule conflict.

**Engineering.** `app/edit.tsx` (6.1k lines) and `PostsProvider.tsx` (3k lines) are fragile: keep the `campaignId` branch small. More migrations and functions mean more to apply/deploy in order (`apply-migrations.mjs`, `FUNCTIONS.txt`, secrets) - script a checklist. Money correctness needs Stripe test-mode fixtures and a staging project; the current harness cannot run Stripe or R2.

---

## 10. Decisions

### 10.A Decided (your answers, recorded)
- **Entity:** sole proprietor now, LLC when investors arrive (6.2).
- **Rows 4-9 and 11-16 of the previous list: my recommendations accepted**, with one change:
  - **Fee:** creator pays the Tryal fee on top (default 10%, floor $1).
  - **Hold:** 14 days; **first-campaign cap:** $50; minimums per 3.2 ($1 pay per clip, $10 budget, $10 payout).
  - **Unreviewed clips (changed):** reminder to the creator at **day 3**, escalation to the owner's dispute queue at **day 5**; never auto-approve or auto-reject. (Assumed: days are counted from when the clip was submitted. Tell me if you meant from the campaign deadline.)
  - **Refunds:** unspent budget and its proportional Tryal fee are refunded; Stripe's processing fee is absorbed by Tryal.
  - **Unverified earnings:** $100 accrual cap before Stripe verification; the `unclaimed_days` rule needs counsel (see 6).
  - **Free campaigns:** kept alongside paid ones. **Clip media in R2** as well as footage. **Profile clips:** shown only to Money-eligible (18+) viewers. **Known-connection payouts:** flag only.
- **Birthdate:** collected at **sign-up for new users**; **existing users are asked the first time they open Money** (the tab stays hidden/locked until they answer). Browsing is gated by this; cash-out by Stripe verification.
- **Received footage** = footage from jobs the clipper has joined. **Direct-to-one-clipper is v2: not built, no tables, no UI.**
- **Operations:** the owner reviews everything: **reports within 24 hours; payouts in one weekly batch on Mondays; disputes within 3 business days** (`payout_batch_weekday`, `dispute_sla_business_days`). Alerts to the owner for every item entering the admin queue (step 14).
- **Funding page:** a **new repository under the Tryal name** (not DropDay-Legal), static site + Supabase auth + calls to `money-create-funding-session`; hosting on GitHub Pages or Cloudflare Pages.
- **Order of work:** finish and submit the current release first; start steps 1-14 once the build is in review; **nothing goes live until step 24.**

### 10.B Still waiting on you
- **Support email for money** (new address): goes into Terms/Privacy, Stripe's business profile, the funding page footer and the app's money screens.
- **Demo account for App Review** (to be sent separately): goes into `app_flags.allow_user_ids` and the review notes; do not paste credentials in chat or commit them.
- **Email alerts:** push is already in the stack; email needs a mail provider (e.g. Resend/Postmark), a verified sending domain, an API key set with `supabase secrets set`, and one edge function. Pick the provider, or say "push only for now".
- **New repo name** for the funding page and who owns it on GitHub (it must be added to the session before I can create files in it).
- Items still open from the earlier list: who is the Stripe account holder (you, with an EIN) and whether a separate bank account is opened; the Apple 3.1 funding strategy (2) and the country-enforcement method (3); Pro items 17-20.

### 10.C Earlier list (kept for reference; the answers are in 10.A, so items 1, 4-9, 10-12, 14-16 and 21 are settled)

**Blocking before any money code**
1. ~~Business entity~~ **Decided: sole proprietor now, LLC when investors arrive** (6.2). Still open: who the Stripe account holder is (you, personally, with an EIN), and whether you will open a separate bank account.
2. **Apple 3.1 funding strategy:** (a) funding only on the web with **no** link/price/CTA in the app (recommended), (b) a US-only link with Apple's entitlement, or (c) accept IAP for funding if Apple insists? Will you ask App Review before building?
3. **Countries:** US-only at launch (recommended)? How do you want to enforce it (Stripe account country, user-declared country, or both)?

**Money rules**
4. **Who pays the fee:** creator on top of the budget (recommended, "flat pay per approved clip" stays exact) or deducted from the clipper? Default `fee_bps`/`fee_min_cents`?
5. **Hold period** before earnings are withdrawable (recommended 14 days) and **first-campaign cap** (recommended $50). Starting minimums: pay per clip, budget, payout ($10)?
6. **Review window rule:** after the deadline plus 7 days with no decision: escalate to you (recommended), auto-approve, or auto-reject?
7. **Refund policy for unspent budget:** refund the unspent amount and the proportional Tryal fee, with Stripe's processing fee absorbed by you (recommended) or by the creator?
8. **Unclaimed/unverified earnings:** accrual cap before verification ($100 recommended) and what happens after `unclaimed_days` (return to creator vs escheat rules - needs counsel).
9. **Manual payout approval** in v1 for every payout (planned): any auto-approve threshold later?

**Product**
10. **"Received footage"** - I modelled it as footage from jobs a clipper has joined. Do you also want **direct sends** (a creator sends footage to a specific clipper outside any open job)? That adds invites and a messaging-adjacent surface.
11. **Free campaigns:** keep `free` campaigns (no money path) alongside paid ones?
12. **Clip media in R2 too** (recommended: one access path, free egress for downloads) or keep clips in Supabase Storage?
13. **Footage upload in v1** if the resumable spike passes, or links only until later? Max footage size/duration (2 GB / 60 min proposed)?
14. **Profile visibility of approved clips:** only to Money-eligible (18+) viewers (planned) or everyone?
15. **Known-connection rule for payouts:** flag only (planned), or block approvals between known connections?
16. **DOB collection scope:** at sign-up for everyone (also fixes the teen filter) or only on first Money visit?

**Pro (Phase B)**
17. **Worker/AI provider** for the moment finder and hooks (cost per audio-hour decides) and who operates the worker?
18. **Reframing:** on-device (Vision, new native module; recommended) or server?
19. **Pro scope:** confirm that current free on-device AI stays free, and the monthly footage-hours cap (10 h proposed) and whether it applies to creator-uploaded campaign footage.
20. **AI consent text** and whether campaign footage may be processed by a clipper's Pro tools without the creator's opt-in (recommended: creator opt-in per campaign).

**Operations**
21. **Who reviews payouts, disputes and reports** and within what time (the Terms promise 24 hours for reports)?
22. **Support channel** for money problems (email address in Terms) and a documented dispute procedure before launch.

---

## 11. Final v1 scope: additions and changes since this plan was written

**Setup (decided)**
- Branch: **`money-v1`**, created from `feature/stranger-only` (the branch the current release builds from). `main` and `release/1.0.6` are not touched.
- **Test mode only:** Stripe **test** keys, Cloudflare R2 free tier, no live keys anywhere. The owner sets every secret with `supabase secrets set`; keys are never pasted in chat or committed.
- **Everything behind the database flag `money`** (`app_flags`): off for everyone except the allow-listed owner until the owner says otherwise. Kill switches for funding, approving and payouts live in `money_config` (`funding_enabled`, `payouts_enabled`, and an approvals switch), not as extra `app_flags` rows (this replaces the extra flag keys listed in 3.1).
- `my_features()` returns three booleans: `money` (show the tab: flag on, not a known minor, not sanctioned, profile exists), `needs_birthdate` (flag on and no birthdate yet: ask before anything else), `allowed` (flag on, strict adult, not sanctioned). Teens and under-13s never see the tab; a user with no birthdate sees it and is asked for one on first visit.

**Navigation (proposal, awaiting the owner's choice; no nav change until then)**
Visible tabs today: Feed, center "+", Me (Explore and Friends exist but are hidden with `href: null`). Four visible destinations cannot keep "+" centered, so:
- **A (recommended): five slots when Money is on:** `Feed · Money · [+] · Friends · Me`. "+" stays exactly centered; uses the existing hidden Friends screen (a visible product change).
- **B: four slots, "+" off-center:** `Feed · Money · [+] · Me`. Cheapest; "+" is the third of four.
- **C: five slots with the hidden Explore shown:** `Feed · Explore · [+] · Money · Me`. Breaks "Explore stays hidden".
- **D: floating "+":** three tabs `Feed · Money · Me` and the "+" as a centered button floating above the bar. Larger visual change.
Either way, the tab bar is unchanged for everyone while the flag is off (three slots), so nothing visible changes for other users.

**Approval requires a rating**
- Approving a submission **requires a 1-5 star rating** and allows an optional note. Rejecting does not rate. Columns: `money_submissions.rating smallint check (rating between 1 and 5)`, `rating_note text check (char_length(rating_note) <= 280)` (word-filtered; shown to the clipper only), a check that `status = 'approved'` implies rating not null. `money-approve-clip` refuses without a rating. The notification to the clipper includes the stars.

**Reputation (v1 = data only; tiers later)**
Per clipper, computed from **paid** approvals only (free campaigns count for nothing, so ratings cannot be farmed with free jobs):
- `approved_paid`, `submitted_paid`, `distinct_paying_creators`, `repeat_hires` (creators with 2+ paid approvals), `avg_rating`, `on_time_rate` (submissions delivered before the campaign deadline / submissions), `disputes_lost`.
- **Per-creator cap:** at most `reputation_cap_per_creator` (default 5) approved clips from the same creator count toward the totals and the rating average, so one creator cannot inflate a clipper.
- Profile line: **"X approved clips · 4.8★"** (shown only to Money-eligible viewers; hidden until the first paid approval).
- Implementation: a view/materialised summary fed by `money_submissions`; no tier logic or perks in v1.

**Daily solvency check (replaces "nightly reconcile")**
`money-reconcile` runs **daily** and checks that **payouts + holds + refunds never exceed funds in**:
1. Ledger identity: for every campaign, `escrow >= 0`; globally `sum(funded gross) >= escrow + wallet_pending + wallet_available + payout_hold + stripe_out + refunds + (fees kept net of Stripe fees)`.
2. Against Stripe: the platform's Stripe balance (available + pending) must cover the ledger's obligations (`escrow + wallet_* + payout_hold`).
On any violation: alert the owner (push) and **automatically set `money_config.payouts_enabled = false`** (and `funding_enabled = false` if funds-in cannot be proven) until the owner clears it. It never "repairs" the ledger.

**Unchanged and confirmed:** US only; Monday payout batch approved by the owner; 14-day hold; $50 first-campaign cap; fee on top; birthdate at sign-up for new users and on first Money visit for existing ones (birthdate column locked down; Stripe identity verification gates cash-out); submissions are not posts (feed, survive/expire lifecycle and messaging rules untouched); owner push alerts for anything entering the admin queue; reminder to the creator at day 3 and escalation to the owner at day 5, never auto-approve.

---

## 11.1 Changes since section 11 (supersede earlier text where they disagree)

**Storage: a private Supabase bucket behind a storage interface; Cloudflare R2 becomes a later switch, not a v1 dependency.**
- Wherever sections 4-6 say "R2", read **"the MediaStore interface"**. v1 ships the **Supabase provider**; the **R2 provider** is written and switched on before launch only if the owner wants it (one config value, no rewrite).
- Interface (TypeScript, in `supabase/functions/_shared/mediaStore.ts`, mirrored by a thin client in `lib/moneyMedia.ts`): `initUpload(key, contentType, size) -> { method, url, headers, completeToken }`, `completeUpload(key, expectedSize)` (verifies size and type server-side), `signedGetUrl(key, ttlSeconds)`, `head(key)`, `delete(key)`. Provider-neutral descriptors mean the client never knows which store it talks to.
- **Supabase provider:** one **private** bucket `money-media` with **no client storage policies at all** (closed to apps, like the tables). Every upload and download goes through the edge functions `media-upload-init`, `media-upload-complete` and `media-get-url`, which check access in SQL (`money_can_read`, `money_can_upload`), then use the service role: signed upload URLs for uploads, signed GET URLs for downloads. Because access control already lives in the functions, switching to R2 later changes only the provider, not who may read what.
- `money_media_objects` gains `provider text not null default 'supabase' check (provider in ('supabase', 'r2'))` and `bucket text`; deletions go through the existing `trial_media_delete_queue` + `delete-media` for the Supabase provider (an `r2-delete` function only if R2 is switched on).
- **Free-plan consequence:** Supabase's global per-object limit on the free plan is small (about 50 MB; verify in the dashboard). Until the plan is upgraded: `money_config.max_footage_bytes` and `max_clip_bytes` are set to that limit (clips fit: 26 MB per minute at the editor's bitrate, so ~1.9 minutes), **footage upload is effectively "short footage only" and Drive/Dropbox links are the real path for long footage**, and the resumable-upload spike (step 7) is deferred until the limit is raised. Egress on the free plan is also limited, so the per-campaign download cap stays low in test.

**Update (owner, after step 1): Supabase Pro, ~2 GB uploads; navigation.**
- The project is on Supabase **Pro**. The owner raises the global file-size limit in Storage settings to about **2 GB**, so v1 plans **direct footage upload up to that limit** (`max_footage_bytes` = 2 GB, `max_clip_bytes` sized to the editor's output). Drive/Dropbox links remain the path for anything bigger. The free-plan consequence above no longer applies. **The resumable-upload spike (step 7) can come back** if uploads near 2 GB fail on real devices.
- **Navigation (decided):** `Feed · Money · [+] · Inbox · Me`, where Inbox is the existing `app/dm/inbox.tsx`. Friends and Explore stay hidden (the Friends screen has follow UI that contradicts the no-followers rule). The nav change is shown to the owner at step 15, before it is applied; nothing changes before that.
- **Birthdate (step 2):** the column is written only by `set_my_birthdate` / the sign-up trigger, once; unreadable by other people only after the owner runs `select public.money_apply_birthdate_lockdown();` (deliberately manual: builds 48/49 select `birthdate` from `profiles` and would fail to load a profile). After it, any migration that adds a `profiles` column must be followed by `select public.money_refresh_profile_grants();`.

**Pitch metrics (built in from the start, extended by every step)**
- **Test vs live is labelled everywhere:** `livemode boolean not null` on `ledger_txns`, `money_campaigns`, `payout_requests` and on the Stripe linkage rows (taken from the Stripe event/object `livemode`; every non-Stripe row inherits it from the campaign it belongs to). All metric views group by `livemode` and the admin screen shows **"TEST" and "LIVE" as separate sections**, never summed.
- **Event data needed:** `money_opens (user_id, opened_at)` written by the client on each Money tab open (a service-role RPC with a once-per-hour dedupe), so "users who opened Money" is real data. Everything else is derived from tables the features already create (profiles, submissions, campaigns, ledger, payouts).
- **View `money_weekly_metrics`**, one row per `(week_start, livemode)`, weeks start Monday UTC (the same Monday as payout batches):
  | Column | Definition |
  |---|---|
  | `new_users` | profiles created that week (not livemode-split; repeated on both rows) |
  | `users_opened_money` | distinct users with a `money_opens` row that week |
  | `clippers_first_submission` | clippers whose first-ever submission was that week |
  | `clippers_second_submission` | clippers whose second-ever submission was that week |
  | `approval_rate` | approved / (approved + rejected) among decisions made that week |
  | `avg_rating` | mean rating of approvals decided that week |
  | `creators_first_funded` | creators whose first funded campaign was that week |
  | `creators_second_funded` | creators whose second funded campaign was that week |
  | `funded_cents` | sum of budget (without fee) of campaigns funded that week |
  | `paid_out_cents` | sum of `payout_paid` that week |
  | `fee_earned_cents` | Tryal fee kept (gross), plus `fee_net_cents` after Stripe processing fees |
  | `median_submit_to_approval_hours` | `percentile_cont(0.5)` of `decided_at - created_at` for approvals decided that week |
- Access: the view is closed to apps; `admin_money_metrics(p_weeks int default 12)` (owner only, `mod_is_admin()`) returns the rows; the admin screen (`app/money-metrics.tsx`, added in the moderation/admin area) shows a table per week with a TEST/LIVE switch and a "copy as CSV" button for investor decks.
- Build order: the view is created in step 3 as a skeleton returning the columns that exist (new users, opens) and **gains columns in the step that creates their data** (submissions in 18, approvals/ratings in 9, funding in 8, payouts in 11); each such step's test asserts its metric against hand-computed fixtures. The admin screen is built in step 22.

**Build log additions:** step 3 also creates `money_opens`, the `livemode` columns and the metrics skeleton; step 6 becomes "MediaStore interface + Supabase provider + functions"; step 7 (spike) is deferred; step 22 includes the metrics screen.

---

## 12. Build log (one step at a time; the owner confirms each before the next)

| Step | What | Status |
|---|---|---|
| 1 | Feature flag + strict adult check (`migration-money.sql`, `test-money-sql.mjs`) | **Confirmed** |
| 2 | Birthdate lock-down + collection (`migration-money.sql` step 2, `lib/birthdate.ts`, `lib/moneyFeatures.ts`, `app/onboarding-birthdate.tsx`, sign-up fields, `test-birthdate.mjs`) | **Built, awaiting confirmation** |
| 3 | Config + campaigns/joins/submissions schema + read RPCs + `money_opens`, `livemode`, metrics skeleton | not started |
| 4 | Pure money logic `_shared/money.ts` + tests | not started |
| 5 | Ledger + invariants | not started |
| 6 | MediaStore interface + Supabase provider (R2 later) | not started |
| 7 | Resumable-upload spike | deferred (free-plan file-size limit) |
| 8-14 | Stripe funding, approve/reject (with rating), Connect, payouts, refunds, disputes, daily solvency + alerts | not started |
| 15-24 | Client, moderation, legal, rollout | not started |
