# Tryal Money Tab — v1 Build Spec

Hand this to Claude Code. Read the existing codebase first (`expo/` app, Supabase schema, posting flow, editor, messaging, reports, blocks, `public.age_tier()`), and reuse what exists instead of rebuilding it.

## 0. What it is (one paragraph)
A marketplace inside Tryal where **creators** post paid clipping campaigns and **clippers** turn the creator's footage into short clips. The creator uploads the footage into Tryal (private; streamed, never handed out whole) and a clipper marks a section of it to clip. Every clip must be edited in Tryal and posted to the Tryal feed first, which is how it gets submitted. Clippers then finish the clip anywhere and post it on their own TikTok, Instagram, YouTube or X, and get paid by the creator for the views. **v1 moves no money in the app.** Tryal connects the two sides, does the math, tracks who paid, and enforces reputation.

## 1. Hard rules
- **18+ only.** Use `public.age_tier()`. The Money tab is hidden for under-18 accounts, and the RLS policies on every money table check it too, not just the UI.
- **No payments in the app.** No payment SDKs, no tappable PayPal/Venmo/Cash App links or buttons. The creator's payment method is shown as plain text (for example "Pays via PayPal").
- **No watermark** on saved clips.
- **Campaign terms freeze** once the first clipper joins. Enforce this in the DB (trigger), not just the UI.
- **Only clips posted on Tryal count.** There's no file-upload or link-only submission path.
- Every Money-tab object (campaign, submission, review, profile) has **Report**, and **Block** applies across the Money tab (a blocked user's campaigns and submissions are hidden, and they can't join).

## 2. Navigation
New **Money ($)** tab in the bottom nav (18+ only), with three sub-tabs:
1. **Browse:** campaign cards with the creator avatar/name, ★ rating (count), payment record ("Paid 14 of 14 · avg 1.2 days"), rate per 1k views, per-clip cap, guaranteed amount if set, budget left, platforms, and deadline. Sort by newest, highest rate, and best creator rating.
2. **My Campaigns** (creator): their campaigns, the submissions list per campaign, approvals due (with a countdown), payments due (with a countdown).
3. **My Clips** (clipper): campaigns joined, clips submitted, view proof due, amount owed / awaiting payment / paid.

Profile badge (shown on the Money tab and user profiles): `★ 4.8 (23) · Paid 14/14`.

## 3. Campaign creation (creator)
Fields:
| Field | Notes |
|---|---|
| title | required, ≤ 60 chars |
| description | what to clip, the vibe, do's and don'ts, ≤ 1000 chars |
| footage | required: at least one uploaded video **or** a Google Drive / Dropbox link (below). Videos are picked from the creator's camera roll: **up to 60 minutes in total per campaign, each video up to 30 minutes, and a per-file size cap of 2 GB** (all three are set in `money_config`, checked by the database). Compressed on the device before upload (720p, a streaming-friendly MP4 with the index at the front so it can play before it has fully downloaded). Uploads are resumable and continue in the background. Stored in a private bucket behind the MediaStore interface; signed URLs only for clippers who joined and for the campaign's creator. **Deleted 14 days after the campaign closes** (or 14 days after its deadline). Clippers who joined can **Report** a video (section 3.3). |
| footage_url | optional, secondary: "or paste a Google Drive / Dropbox link" under the upload on screen 1, mainly for footage longer than the upload limit. Google Drive and Dropbox share links only (https, validated on the server). Shown only to the creator and the clippers who joined (never a readable column). Uploading stays the main path. |
| full_video_url | optional "Full video" link: one https URL on youtube.com, youtu.be, tiktok.com, instagram.com, x.com (or twitter.com, www.twitter.com, mobile.twitter.com, shown as X), twitch.tv or open.spotify.com (validated on the server). **A frozen term once the first clipper joins.** Every clip from the campaign uses it automatically, each through its clipper's own tracked link (section 16) |
| rate_per_1k | required, in dollars (e.g. 1.50) |
| cap_per_clip | required, the max payout per clip |
| total_budget | required |
| guaranteed_per_clip | optional, paid on approval regardless of views (e.g. $3) |
| platforms | multi-select: tiktok, instagram, youtube, x |
| view_window_days | default 7 (allowed 3–14) |
| min_views | views needed before a clip earns the per-view rate (default 1000) |
| payment_method | enum paypal / venmo / cashapp + handle (plain text) |
| deadline | when submissions close |
| max_clips_per_clipper | default 5 |

The creator must accept the **Campaign Agreement** before posting:
- Only clips submitted through Tryal get paid.
- Terms freeze when the first clipper joins.
- 48-hour approval window, after which clips auto-approve.
- Pay within 3 days of approval.
- The creator uploads footage they own or have the rights to. Tryal stores it privately, shows it only to clippers who joined, and deletes it 14 days after the campaign closes.
- The creator allows their footage to be posted on Tryal, tagged as clipped for them.
- A "Full video" link is optional. It is frozen once a clipper joins, and every clip uses it through the clipper's own tracked link. Tryal counts taps, never who tapped.
- Tryal is not part of the payment.
- Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone.

### 3.1 Creating a campaign: four short screens
1. **Add footage:** pick videos from the camera roll; shows the total minutes used out of 60 (each video up to 30 minutes). Compression and upload start in the background straight away.
2. **What to clip:** title, the creator's notes, and the optional "Full video" link (section 16).
3. **Pay:** preset buttons (for example $1 / $2 / $3 per 1,000 views), an optional amount per clip (the guaranteed amount), the cap and the budget, with a live example line ("10,000 views = $23 per clip").
4. **How you pay:** Cash App / PayPal / Venmo and the handle (plain text).
Everything else (view window, views needed, clips each, deadline, platforms) uses defaults and is editable under "More options". The Campaign Agreement is accepted on the last screen.

### 3.2 The campaign screen (one glance)
- Creator row: avatar, @name, ★ rating · Paid X/Y.
- Title and the creator's notes.
- One big pay line, "Earn $3 per clip + $2 per 1,000 views", with small grey "Up to $250 a clip" under it (the per-clip amount plus the cap). Any part that is zero is left out.
- Three chips: budget left · closes in · pays via.
- A "Full video on YouTube" card, only if the campaign has a Full video link.
- Footage: thumbnails with their lengths; tap to preview (streamed).
- One primary red button: "I'm in" before joining, "Make a clip" after.
- "See all terms", collapsed: views needed, view window, platforms, clips each, the terms-freeze note.
- On the creator's own campaign, "Close campaign" lives in a ⋯ menu behind a confirm step.

Budget tracking: `budget_committed` = sum of owed amounts on approved clips. Close the campaign to new submissions automatically when committed ≥ total_budget.

### 3.3 Footage safety and housekeeping (required before any real creator uses uploads)
- **Limits:** each video ≤ 30 minutes, ≤ 60 minutes per campaign, ≤ 2 GB per file; refused with a plain message on the phone and again by the database.
- **Deletion:** campaign footage is deleted **14 days after the campaign closes** (or after its deadline), unattached uploads after 7 days. Files go through the existing delete queue.
- **Account deletion:** deleting an account removes that person's uploaded footage and any exported copies or sections (everything stored under their user id in the footage and export buckets). It happens in the database when the profile is deleted (so it also happens through the delete-user function and any cascade), and the app asks for it first (`delete_my_footage`). Exports must be stored under `<user id>/` in `campaign-footage` or `clip-exports`.
- **Report:** every uploaded video has a **Report** action for clippers who joined, through the existing reports table: the same reasons (spam, harassment, nudity, other), the same auto-hide threshold (3 reports hide it from clippers until the owner decides) and the same admin queue (dismiss puts it back, hide keeps it hidden, remove deletes it and its files).
- **Admin screen (owner only):** a Storage tab shows total footage storage (GB), the number of files and the oldest file.

## 4. Joining (clipper)
- An **"I'm in"** button shows the frozen terms and the **Clipper Agreement**:
  - only real views count
  - fake or bought views mean a ban
  - submit through Tryal
  - upload view proof by the deadline
  - footage is only for making clips for this campaign
  - your clips use the creator's Full video link through your own tracked link: Tryal counts taps, never who tapped
  - Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone.
- Footage is available only through signed URLs, and only to clippers who joined and the campaign's creator.
- Joining creates a `campaign_members` row and opens (or reuses) a message thread with the creator, starting with a message (sent as the clipper) that summarizes the terms. The creator and every clipper who has joined can always message each other about the campaign, whatever either has set in "Who can message me" (even `nobody`) and without being friends; blocks, the under-18 rule, the word filter, the unanswered-message limit and sanctions still apply, and it ends with the membership.
- The first join sets `campaigns.terms_frozen_at`.

## 5. Making and submitting a clip
1. From the campaign, the clipper taps **Make a clip**. The footage list opens; the clipper picks a video and **previews it streamed** (it is never downloaded whole).
2. The clipper scrubs and **marks a section of at most about 3 minutes**. Only that section is fetched and exported on the device (a time range exported from the remote asset), and the result is loaded into the Tryal editor with the campaign attached. If a time range cannot be exported from a remote asset with our native code, the trade-offs are reported before any full-download fallback is built. A hook is left for Pro's "find the best moments" to suggest sections later.
3. Normal AI edit (pause removal, um and slow-start trimming, captions, text overlays). **The finished clip must be 60 seconds or shorter.**
4. Posting creates a normal Tryal post with:
   - `campaign_id` and `clipped_for_user_id` (the creator) set
   - the label on the post **"clipped by @clipper for @creator"**
   - `edited_in_tryal = true` when the clip went through the editor session (set from the editor flow, not by the client claiming it)
5. Posting **automatically creates the submission** (`campaign_submissions` row, status `posted`).
6. **Queue:** reuse the existing rule of 2 posts live at once with the rest queued. A submission counts when its post is created, even if it's still queued.
7. After posting, **save the clean file to the camera roll** (`expo-media-library`), with no watermark.
8. The post goes through the normal stranger test. The submission shows its survive/fail status to the creator.

## 6. External posts and view proof
- On the submission, the clipper adds one or more **external links** (TikTok, Instagram, YouTube, X). Validate the URL domain against the campaign's platforms. The view-window clock starts at `external_posted_at` (when the link was added).
- When the window ends, the clipper uploads **view proof**: 1–3 screenshots of the post's analytics, plus the view count they're claiming. No video, which keeps storage and moderation cheap. Store it in a private Supabase storage bucket that only the clipper, the creator and admins can read.
- **Amount owed** (calculated server-side):
  `owed = guaranteed_per_clip + (views >= min_views ? min(views / 1000 * rate_per_1k, cap_per_clip) : 0)`, rounded to cents.
- If the view proof isn't uploaded within 3 days after the window ends, the submission only earns the guaranteed amount.

## 7. Approval
- After proof is uploaded, the creator has **48 hours** to **Approve** or **Dispute** (dispute needs a reason: `fake_views`, `wrong_content`, `not_my_campaign`, `proof_mismatch`, `other` + a note).
- **No response in 48 h → auto-approved** (scheduled job, see §11).
- A dispute goes into an **admin queue** (the founder resolves it by hand in v1). The admin can approve, adjust the views, or reject.

## 8. Payment tracking
- On approval, `payment_due_at = approved_at + 3 days`.
- The creator taps **"I paid"** (optional). The clipper taps **"Payment received"**, which is what counts.
- If a payment is overdue:
  - The creator's campaigns are paused (hidden from Browse, no new joins) and they can't create campaigns until it's resolved.
  - The clipper can tap **"Not paid"**, which opens an admin case.
- **Strikes:**
  - 2 late payments, or 1 non-payment confirmed by the admin → `money_banned = true` (the creator can't use the Money tab).
  - Confirmed fake views → the clipper is banned the same way.
- **Payment record** (public): paid count / approved count, average days to pay, late count.

## 9. Reviews (5 stars, both ways)
- Unlocked once a submission reaches `paid` or is resolved by the admin. One review per side per completed deal.
- **Clipper rates creator:** overall ★1–5, plus optional quick tags (clear instructions, good footage, fair approvals, paid on time) and a comment of up to 280 characters.
- **Creator rates clipper:** overall ★1–5, plus optional tags (great clips, on time, real views, good communication) and a comment.
- **Blind reveal:** both reviews stay hidden until both are in or 7 days pass, then both publish.
- Can't be edited after publishing. Can be reported.
- Profile shows the average ★ and the count (from published reviews only).

## 10. Fraud flags (clipper side)
Flag a submission for a closer look (not auto-reject) when:
- likes ÷ views < 0.5% on a claim over 10k views (have the clipper enter likes along with views)
- the external account was created recently (the clipper enters account age when linking; it's a manual check in v1)
- the views claimed jump far beyond the clipper's past average

Flagged clips get a ⚠️ for the creator and show up in the admin queue.

## 11. Data model (Supabase)
New tables (all with RLS; all money tables require 18+ and not `money_banned`):
- `campaigns` (id, creator_id, title, description, full_video_url, rate_per_1k, cap_per_clip, total_budget, guaranteed_per_clip, platforms text[], view_window_days, min_views, payment_method, payment_handle, deadline, max_clips_per_clipper, status [`open`,`paused`,`closed`], terms_frozen_at, budget_committed, created_at)
- `campaign_members` (campaign_id, clipper_id, joined_at, agreed_terms jsonb snapshot)
- `campaign_submissions` (id, campaign_id, clipper_id, post_id, status [`posted`,`awaiting_proof`,`awaiting_approval`,`disputed`,`approved`,`paid`,`unpaid`,`rejected`], views_claimed, likes_claimed, proof_path, amount_owed, approved_at, approval_source [`creator`,`auto`,`admin`], payment_due_at, paid_marked_at, received_at, flagged bool)
- `submission_links` (id, submission_id, platform, url, posted_at)
- `submission_disputes` (id, submission_id, reason, note, resolution, resolved_by, resolved_at)
- `money_reviews` (id, submission_id, reviewer_id, reviewee_id, role [`creator`,`clipper`], stars 1–5, tags text[], comment, published_at)
- `money_strikes` (id, user_id, kind [`late_payment`,`non_payment`,`fake_views`], submission_id, created_at)
- add to `profiles`: `money_banned bool`, plus a view or function for rating average, review count and payment record
- add to `posts`: `campaign_id`, `clipped_for_user_id`, `edited_in_tryal`, `link_code`, `link_platform` (section 16)
- `campaign_footage` (id, campaign_id, storage path, duration_seconds, width, height, size_bytes, thumbnail path, sort_order, status [`uploading`,`ready`,`failed`,`deleted`]) and `campaigns.full_video_url`, `campaigns.footage_delete_after`
- `post_links` (post_id, url, platform, code), `link_tap_days` (post_id, day, taps) and a short-lived `link_tap_seen` (see section 16)

DB rules (triggers/functions, enforced on the server):
- Block updates to campaign term columns once `terms_frozen_at` is set.
- Creating a submission requires a `campaign_members` row, an open campaign before its deadline, and the clipper under `max_clips_per_clipper`.
- `amount_owed` is calculated by a function. Clients can't write it.

Scheduled jobs (`pg_cron` or a scheduled Edge Function, every 15 min):
- auto-approve submissions 48 h after proof
- mark payments overdue → pause the creator's campaigns, add a strike
- publish blind reviews after 7 days
- move submissions to "awaiting proof" when the window ends, and settle at the guaranteed amount if proof is 3 days late
- close campaigns past their deadline or out of budget

Notifications (reuse the existing system): new submission, proof uploaded, approval due in 12 h, approved, payment due, payment received, review is live, dispute resolved.

## 12. Admin (founder only, minimal)
A simple admin screen (or Supabase dashboard views to start): disputes, "not paid" cases, fraud flags, reports on Money objects, and buttons to resolve, adjust views, add a strike, or ban/unban.

## 13. Legal and App Review prep
- Terms of Use: add a Money tab section (Tryal isn't a party to payments; users handle their own taxes; content ownership and permission to post clips; zero tolerance for fake views; disclosure of paid content where platforms require it).
- Update the App Privacy labels if new data is collected (view proof recordings, external links).
- App Review notes: explain that the Money tab is a job board between adults, that no payments happen in the app and Tryal takes no cut, and that report/block/filter cover campaigns, clips and reviews. Give the reviewer a demo account (18+) that already has a live campaign and a submission.

## 13b. Walkthroughs (required before anyone uses the Money tab)
**First open of the Money tab:**
1. **Age gate.** Under-18 accounts never see the tab. Adults see a short intro: "Creators hire clippers. Clippers get paid for views. Tryal keeps everyone honest. Payments happen outside the app."
2. **Role picker:** Creator, Clipper, or Both. Users can change it later.
3. **Role walkthrough:** a full-screen swipeable walkthrough (5–7 cards, each with one picture or animation, a title, and at most 2 short lines; the messaging and link sentences, where a card carries them, are small notes under those lines). The last card is the agreement. The user can't finish until they tick each key rule (one checkbox per rule) and tap Agree. Store `money_role`, `money_onboarded_at` and `money_agreement_version` in a closed `money_profiles` table, not on public `profiles`. If the agreement version changes, show it again.

**Creator walkthrough cards:**
1. How it works: post a campaign → clippers make clips in Tryal → strangers test them → clippers post on their own accounts → you pay for the views.
2. Your footage: upload videos from your camera roll, up to 60 minutes in total and 30 minutes each. We delete them 14 days after your campaign closes.
3. Setting pay: an optional amount per clip plus a rate per 1,000 views, with a cap and a budget. Example: $3 per clip + $2 per 1,000 views, so 10,000 views = $23 per clip.
4. Terms freeze once the first clipper joins. Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone. Your "Full video" link is frozen too, and every clip uses it with the clipper's own tracked link.
5. Approving: you have 48 hours to approve or dispute, or the clip auto-approves.
6. Paying: pay outside the app within 3 days. Your payment record is public, late payments pause your campaigns, and repeat late payments mean a ban.
7. Agreement checkboxes: pay on time · terms freeze · auto-approval after 48 h · Tryal isn't part of the payment · I own or have rights to my footage · campaign members can message me about the work, even if my messages are set to nobody (I can still block anyone).

**Clipper walkthrough cards:**
1. How it works: join a campaign → make the clip in Tryal → post to Tryal (that's your submission) → post on your own accounts → prove your views → get paid.
2. Pick your moment: scrub the footage and mark a section up to 3 minutes. Only that part is downloaded to edit.
3. Tryal first: only clips posted on Tryal count. The clean file saves to your camera roll, then finish it anywhere.
4. Proving views: add your post links, and when the window ends upload screenshots of your analytics. Put your link in your bio. Every tap is counted.
5. Getting paid: the app shows what you're owed, the creator pays you directly, and you tap "Payment received." Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone.
6. Real views only: fake or bought views mean a ban.
7. Agreement checkboxes: only real views · submit through Tryal · upload proof on time · footage is only for making clips for this campaign · Tryal isn't part of the payment · campaign members can message me about the work, even if my messages are set to nobody (I can still block anyone).

**"Both" role:** show the clipper cards, then the creator-only cards (2, 3, 4, 5, 6), then one combined agreement (the union of both checkbox lists; the messaging checkbox appears once).

**First-time guides (coach marks):** short tooltips the first time a user does each step: creating a campaign (one per field group), joining, Make a clip (pointing at the footage list), adding external links, uploading proof, approving, and marking payment. Each tip shows once and can be dismissed.

**Always available:** a **"How it works" (?)** button in the Money tab header reopens the walkthrough for the user's role, plus a short FAQ: what if I'm not paid · what if views look fake · how disputes work · how reviews work · is Tryal taking a cut (no).

**Empty states teach too:** for example, an empty Browse says "No campaigns yet — be the first creator" with a button, and an empty My Clips says "Join a campaign to start earning."

## 14. Out of scope for v1
In-app payments/escrow (v2: Stripe Connect after confirming with App Review), automatic view counting from platform APIs, fees/Pro (only the hook for Pro's "find the best moments" suggestions is left), Android. The "Import from Files" picker is gone: footage is uploaded into Tryal. A Google Drive / Dropbox link stays only as an optional secondary alternative under the upload (section 3).

## 15. Build order
Steps 1-2 below are built. The footage / links work (owner's order) comes next, one step at a time, each confirmed before the next:
- **a. Post links** (section 16, the non-Money part): standalone, shippable in the current app before Money.
- **b. Footage upload + campaign creation** (sections 3, 3.1 and 3.3): resumable upload, MediaStore, per-file size cap, 14-day deletion, account deletion removes footage and exports, Report on footage (existing report system), storage totals on the admin screen, optional Drive / Dropbox link. Required before any real creator uses uploads.
- **c. The campaign screen** (section 3.2).
- **d. The clipper's section-export flow** (section 5).
- **e. Money full-video tracked links** (the rest of section 16), then a `money-preview` TestFlight build.

Then, as before:
1. Schema + RLS + triggers (sections 11, 1) - built
2. Walkthroughs + role picker + agreements (13b), then campaign create + Browse + join (2-4) - built
3. Submit-on-post + camera roll save + post labels (5)
4. External links + view proof + owed math (6)
5. Approval + auto-approve + payment tracking + strikes (7-8, scheduled jobs)
6. Reviews with blind reveal (9)
7. Fraud flags + admin screen (10, 12)
8. Notifications, Terms update, App Review notes (11, 13)

After each step: show the SQL that actually ran and runtime logs proving it works. Don't just report it as done.

## 16. Links on posts (all posts, then Money)
**For every post, not just Money** (built first, on its own):
- The post composer gets a **Links** row: **My socials** (the default; shows the profile's existing social links, as today) or **A specific video** (one URL).
- Allowed domains only, validated on the server: `youtube.com`, `youtu.be`, `tiktok.com`, `instagram.com`, `x.com` (and `twitter.com`, `www.twitter.com`, `mobile.twitter.com`, all shown as X), `twitch.tv`, `open.spotify.com`.
- A post with a video link shows a **Watch on <platform>** button.
- Every outbound video link goes through a **tracked short link** (a Supabase edge function). Taps are counted per post. A tap from the same device/IP within 24 hours counts once, using the address the platform sets (never one the caller writes), and one link can collect at most a fixed number of counted taps per hour. Only counts are kept: the de-duplication uses a short-lived salted hash that is deleted within 48 hours, and nothing about the person who tapped is stored.
- The post's owner sees "This post sent X people to your video."
- Reuses the profile-links code (`lib/creatorLinks.ts`); there is no second link system.
- Link taps are added to the pitch metrics (weekly counts).

**Money campaigns:** the optional **Full video** link is a frozen term once a clipper joins. Every clip from the campaign uses it automatically, with each clipper's own tracked link (a clip is a post, so its count is that clipper's). The creator sees taps per clipper; a clipper sees their own on My Clips. Clipper walkthrough: "Put your link in your bio. Every tap is counted."
