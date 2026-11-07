#!/usr/bin/env node
/**
 * Spotlight (feed lead + label, profile badge, admin, offer), client side: the fixed lists and wording, and that every surface goes through the database functions that enforce
 * who may see what (the rules themselves are tested in test-spotlight-sql.mjs).
 *   node --experimental-strip-types --no-warnings scripts/test-spotlight.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { SPOTLIGHT_CATEGORIES, SPOTLIGHT_CHOICES, badgeText, categoryLabel, spotlightLabel } from "../lib/spotlightText.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

eq("the six categories, in the order asked for", SPOTLIGHT_CATEGORIES.map((c) => c.label), ["Creator of the Day", "Rising Creators", "Most Creative", "Best Storytelling", "Most Improved", "Community Favorite"]);
eq("the category keys match the database check constraint", SPOTLIGHT_CATEGORIES.map((c) => c.key), (read("../supabase/migration-spotlight.sql").match(/category in \(([^)]*)\)\)/)[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.slice(1, -1)));
eq("labels and the badge text", [categoryLabel("most_creative"), categoryLabel("nope"), badgeText("most_creative", true), badgeText("most_creative", false)], ["Most Creative", "Spotlight", "Most Creative", "Most Creative · featured"]);
eq("three choices: full, strangers-only, decline; the choice keys are what the database accepts", [SPOTLIGHT_CHOICES.map((c) => c.key), /when 'full' then 'full' when 'strangers' then 'strangers' when 'decline'/.test(read("../supabase/migration-spotlight.sql"))], [["full", "strangers", "decline"], true]);
eq("the wording says who sees what: full includes friends and contacts but never the hide list; strangers-only excludes them", [/friends and people who have you in their contacts/.test(SPOTLIGHT_CHOICES[0].body), /hide list/.test(SPOTLIGHT_CHOICES[0].body), /Friends and contacts won't get it/.test(SPOTLIGHT_CHOICES[1].body)], [true, true, true]);

const lib = read("../lib/spotlight.ts");
eq("every call is a database function (no table reads, no client-side filtering)", [["profile_spotlight", "my_spotlight_offers", "respond_spotlight_offer", "admin_spotlight_creators", "admin_spotlight_posts", "admin_spotlight_list", "admin_spotlight_offer", "admin_spotlight_withdraw"].every((f) => lib.includes(`"${f}"`)), /\.from\("spotlight/.test(lib)], [true, false]);
eq("the badge and the offer screen use them; there is no Explore section any more (component, import, function and wrapper are gone)", [/profileSpotlight\(/.test(read("../components/SpotlightBadge.tsx")), /respondToOffer\(/.test(read("../app/spotlight-offer.tsx")), /myOffers/.test(read("../app/spotlight-offer.tsx")), existsSync(new URL("../components/SpotlightSection.tsx", import.meta.url)), /Spotlight/.test(read("../app/(tabs)/explore.tsx")), /get_spotlight|getSpotlight/.test(lib) || /create (or replace )?function public\.get_spotlight/.test(read("../supabase/migration-spotlight.sql"))], [true, true, true, false, false, false]);
eq("the label on a Spotlight post: 'Spotlight · Most Creative', fed by the feed rows' spotlight_category", [spotlightLabel("most_creative"), /spotlight_category/.test(read("../lib/trialEngine.ts")), /spotlightLabel\(post\.spotlight_category\)/.test(read("../components/FeedItem.tsx")), /spotlight_category: r\.spotlight_category/.test(read("../providers/PostsProvider.tsx")), /returns table \(post_id uuid, "position" integer, page_rows integer, spotlight_category text\)/.test(read("../supabase/migration-spotlight.sql"))], ["Spotlight · Most Creative", true, true, true, true]);
eq("the admin screen is owner only and calls the admin functions", [/isDebugOwner\(user\?\.id\)\) return <Redirect/.test(read("../app/spotlight-admin.tsx")), /adminOffer\(/.test(read("../app/spotlight-admin.tsx")), /adminWithdraw\(/.test(read("../app/spotlight-admin.tsx")), /isDebugOwner\(user\?\.id\) && \(/.test(read("../app/settings.tsx"))], [true, true, true, true]);
eq("both profiles show the badge", [/<SpotlightBadge userId=\{id\} \/>/.test(read("../app/user/[id].tsx")), /<SpotlightBadge userId=\{profile\?\.id\} \/>/.test(read("../app/(tabs)/profile.tsx"))], [true, true]);
eq("the notification type exists in the app and opens the offer screen", [/"spotlight_offer"/.test(read("../providers/NotificationsProvider.tsx")), /"spotlight_offer"/.test(read("../components/NotificationItem.tsx")), /router\.push\("\/spotlight-offer"/.test(read("../app/notifications.tsx"))], [true, true, true]);
eq("no payments anywhere in Spotlight", [lib, read("../app/spotlight-admin.tsx"), read("../app/spotlight-offer.tsx"), read("../supabase/migration-spotlight.sql").replace(/--.*$/gm, "")].some((t) => /payment|purchase|price|stripe|\biap\b/i.test(t)), false);

const sql = read("../supabase/migration-spotlight.sql");
eq("the migration: consent first (offers show nothing), one eligibility rule used by the feed and the badge", [/spotlight_eligible\(sp\.creator_id, sp\.status, me\)/.test(sql), /spotlight_eligible\(p_user_id,/.test(sql)], [true, true]);
eq("the migration is in the order (before harassment and recovery) and in the apply script", [read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")).slice(-3, -1), /"migration-spotlight\.sql"/.test(read("../scripts/apply-migrations.mjs"))], [["migration-spotlight.sql", "migration-harassment.sql"], true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
