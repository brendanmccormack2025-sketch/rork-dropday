#!/usr/bin/env node
/**
 * Source guards for campaign footage (MONEY_TAB_SPEC.md sections 3 and 4): the private bucket, signed URLs only, the numbers shown to people equal the
 * numbers the database enforces, the four creation steps, and that nothing still points at Drive / Dropbox links. (The behaviour itself is tested by
 * test-money-footage-sql.mjs, test-tus.mjs and test-footage-upload.mjs.)
 *   node --experimental-strip-types --no-warnings scripts/test-money-footage.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(join(root, f), "utf8");
const walk = (d) => readdirSync(join(root, d)).flatMap((n) => { const p = join(d, n); return statSync(join(root, p)).isDirectory() ? (n === "node_modules" ? [] : walk(p)) : [p]; });
const appFiles = ["app", "lib", "components", "hooks", "providers"].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));
const appSrc = appFiles.map((f) => [f, read(f)]);

const mig = read("supabase/migration-money-footage.sql");
const limits = read("lib/footageLimits.ts");
const content = read("lib/moneyContent.ts");

eq("the bucket is private, and no storage policy makes it public or lets apps change or delete files", [/'campaign-footage', 'campaign-footage', false/.test(mig), /on storage\.objects for (update|delete|all)/i.test(mig), /public = true|public := true/.test(mig)], [true, false, false]);
eq("the only storage policies are read (creator or a joined clipper) and add (an upload the database registered)", [...mig.matchAll(/create policy "([^"]+)" on storage\.objects for (\w+)/g)].map((m) => `${m[1]}:${m[2]}`), ["campaign footage read:select", "campaign footage add:insert"]);
eq("the app never builds a public URL for footage: only signed URLs (createSignedUrl), and no getPublicUrl anywhere in the app code", [appSrc.some(([, s]) => /getPublicUrl\([^)]*footage/i.test(s)), read("lib/mediaStore.ts").includes("createSignedUrl")], [false, true]);
eq("the media store is the one place that knows the bucket name and the storage provider", appSrc.filter(([f, s]) => /campaign-footage/.test(s) && !/mediaStore\.ts$/.test(f)).map(([f]) => f), []);
eq("the numbers people see equal the database defaults: 60 minutes total, 30 each, 2 GB, 14 days to deletion", [/MAX_TOTAL_SECONDS = 3600/.test(limits), /MAX_EACH_SECONDS = 1800/.test(limits), /2 \* 1024 \*\* 3/.test(limits), /max_footage_seconds_total integer not null default 3600/.test(mig), /max_footage_seconds_each  integer not null default 1800/.test(mig), /max_footage_bytes         bigint  not null default 2147483648/.test(mig), /footage_delete_days       integer not null default 14/.test(mig)], Array(7).fill(true));
eq("the creator card promises exactly that: 60 minutes in total, 30 minutes each, deleted 14 days after the campaign closes", /up to 60 minutes in total and 30 minutes each\. We delete them 14 days after your campaign closes/.test(content), true);
eq("uploads are queued in a saved list and resumable, in a 6 MiB chunk TUS upload, and the screen tells people to keep Tryal open", [/6 \* 1024 \* 1024/.test(read("lib/tus.ts")), /AsyncStorage/.test(read("lib/footageRuntime.ts")), /Keep Tryal open/.test(read("components/money/FootageStep.tsx"))], [true, true, true]);
eq("the wizard has four short steps, in the spec's order, and keeps the defaults under 'More options'", [/STEP_TITLES = \["Add footage", "What to clip", "Pay", "How you pay"\]/.test(read("app/money/create-campaign.tsx")), /More options/.test(read("app/money/create-campaign.tsx")), /Step \{step \+ 1\} of 4/.test(read("app/money/create-campaign.tsx"))], [true, true, true]);
eq("step 1 shows the minutes used of 60; step 3 has the $1 / $2 / $3 presets and the live example; step 4 the three payment apps and a handle", [/usedLabel/.test(read("components/money/FootageStep.tsx")), /PAY_PRESETS/.test(read("app/money/create-campaign.tsx")), /workedExample\(f\)/.test(read("app/money/create-campaign.tsx")), /PAYMENT_METHODS/.test(read("app/money/create-campaign.tsx")), /paymentHandle/.test(read("app/money/create-campaign.tsx"))], Array(5).fill(true));
eq("posting waits for every upload and sends only the ids of finished videos to the one database function", [/disabled=\{uploading\}/.test(read("app/money/create-campaign.tsx")), /money_create_campaign_with_footage/.test(read("lib/moneyApi.ts")), /rpc<string>\("money_create_campaign"/.test(read("lib/moneyApi.ts"))], [true, true, false]);
const fstep = read("components/money/FootageStep.tsx");
eq("Drive / Dropbox is only a secondary, clearly optional alternative: under the upload on screen 1, worded as such, and only the code that handles it mentions it", [fstep.indexOf("Add videos") < fstep.indexOf("Or paste a Google Drive / Dropbox link (optional)"), /Uploading is the main way/.test(fstep), /mainly for footage longer than the upload limit/.test(fstep), appSrc.filter(([f, s]) => /drive\.google|dropbox/i.test(s) && !/moneyContent|moneyGuides|moneyCampaign|FootageStep|campaign\/\[id\]|moneyApi/.test(f)).map(([f]) => f)], [true, true, true, []]);
eq("the link is not a readable column (only campaign_footage_link shows it, to the creator and joined clippers), and the app never selects it", [/revoke select \(footage_url\) on public\.campaigns from authenticated/.test(mig), /create or replace function public\.campaign_footage_link/.test(mig), /footage_url/.test(read("lib/moneyApi.ts").split("export const CAMPAIGN_COLUMNS")[1].split(";")[0])], [true, true, false]);
eq("Report on footage: the same reports table, reasons, 3-report threshold and owner queue; the screen reports a video (not the creator's own: only joined clippers see the button)", [/'footage'\)\)/.test(mig), /pending'\) >= 3/.test(mig), /reportMoney\(me, "footage"/.test(read("app/money/campaign/[id].tsx")), /d\.joined \? <Pressable onPress=\{\(\) => reportFootage/.test(read("app/money/campaign/[id].tsx")), /"spam"\], \["Harassment"|Spam or scam/.test(read("app/money/campaign/[id].tsx")), /admin_report_resolve/.test(mig)], Array(6).fill(true));
eq("the owner screen has a Storage tab with GB, number of files and the oldest file, from an owner-only function", [/admin_footage_storage/.test(read("lib/safety.ts")), /Oldest file/.test(read("app/moderation-admin.tsx")), /GB in/.test(read("app/moderation-admin.tsx")), /not allowed' using errcode = '42501'; end if;\s+return query\s+select count\(\*\), coalesce\(sum\(f\.size_bytes\)/.test(mig)], [true, true, true, true]);
eq("deleting an account removes footage and exports: a database function the app calls first, and a trigger on the profile row (so the delete-user function and any cascade do it too)", [/delete_my_footage/.test(read("providers/AuthProvider.tsx")), /create trigger profiles_footage_cleanup before delete on public\.profiles/.test(mig), /'campaign-footage', 'clip-exports'/.test(mig)], [true, true, true]);
eq("the old text (a share link) is gone from the cards and tips", [/Drive or Dropbox|share link/i.test(content), /Drive or Dropbox/.test(read("lib/moneyGuides.ts"))], [false, false]);
eq("the temporary chunk file is deleted after every chunk, and the thumbnail and compressed copies after a finished upload", [/deleteAsync\(CHUNK_FILE/.test(read("lib/footageRuntime.ts")), /deleteFile\(done\.compressedUri\)/.test(read("lib/footageUpload.ts"))], [true, true]);
eq("the footage migration is listed after the board file in MIGRATIONS_ORDER.txt and in apply-migrations", [(() => { const o = read("supabase/MIGRATIONS_ORDER.txt"); return o.indexOf("migration-money-board.sql") < o.indexOf("migration-money-footage.sql") && o.indexOf("migration-money-footage.sql") > 0; })(), /migration-money-footage\.sql/.test(read("scripts/apply-migrations.mjs"))], [true, true]);
eq("the migration raises the agreement version (everyone ticks the new footage rules) and closes the old Drive-link create function", [/update public\.money_config set agreement_version = greatest\(agreement_version, 2\)/.test(mig), /money_footage_register\(numeric, integer, integer, bigint\)/.test(read("supabase/migration-money-board.sql"))], [true, true]);
eq("footage is deleted through the existing queue (delete-media), and the purge job is scheduled daily", [/trial_media_delete_queue/.test(mig), /cron\.schedule\('money-footage-purge', '30 3 \* \* \*'/.test(mig)], [true, true]);

const wf = read(".eas/workflows/publish-money-preview.yml");
eq("the EAS workflow publishes only to money-preview, only for pushes to money-v1-board, iOS only, and never mentions production", [/^\s+- money-v1-board\s*$/m.test(wf), /branch: money-preview/.test(wf), /platform: ios/.test(wf), /branch: production|channel: production|--auto|submit/i.test(wf.replace(/^\s*#.*$/gm, ""))], [true, true, true, false]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
