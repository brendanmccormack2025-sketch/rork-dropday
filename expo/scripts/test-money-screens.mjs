#!/usr/bin/env node
/**
 * Money screens, source-level guards for the rules that must hold whatever the layout looks like: no payments in the app, the tab hidden behind
 * the database flag, nothing before the walkthrough, Report and Block on every campaign, all writes through the database functions.
 *   node --experimental-strip-types --no-warnings scripts/test-money-screens.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("../", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const walk = (d) => readdirSync(join(root, d)).flatMap((f) => { const p = join(d, f); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; });
const MONEY_FILES = [...walk("app/money"), "app/(tabs)/money.tsx", ...walk("components/money"), "lib/moneyApi.ts", "lib/moneyCampaign.ts", "lib/moneyContent.ts", "lib/moneyGuides.ts", "lib/moneyFeatures.ts", "hooks/useMoney.ts"].filter((f) => /\.tsx?$/.test(f));
const src = Object.fromEntries(MONEY_FILES.map((f) => [f, read(f)]));
const all = Object.values(src).join("\n");

eq("the Money screens exist", ["app/(tabs)/money.tsx", "app/money/onboarding.tsx", "app/money/walkthrough.tsx", "app/money/faq.tsx", "app/money/create-campaign.tsx", "app/money/campaign/[id].tsx"].map((f) => existsSync(join(root, f))), Array(6).fill(true));

// ── no payments in the app ──
const pkg = JSON.parse(read("package.json"));
eq("no payment SDK is a dependency of the app", Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /stripe|paypal|braintree|square|adyen|razorpay|apple-pay|google-pay|react-native-iap|expo-in-app|purchases/i.test(d)), []);
eq("no Money file imports a payment library or calls a payment API", /from ["'][^"']*(stripe|paypal|braintree|iap|purchases|payment-request)[^"']*["']|api\.stripe|api\.paypal|venmo:\/\/|paypal\.me|cash\.app/i.test(all), false);
eq("Linking is used once, for the footage link, and never for a payment handle", [(all.match(/Linking\.openURL\(/g) ?? []).length, /Linking\.openURL\(c\.footage_url\)/.test(src["app/money/campaign/[id].tsx"])], [1, true]);
const detail = src["app/money/campaign/[id].tsx"];
eq("the payment handle is shown as plain text in a Text, never inside a Pressable or with an onPress", (() => { const i = detail.indexOf("pay.data.payment_handle"); const line = detail.slice(detail.lastIndexOf("\n", i), detail.indexOf("\n", i)); const before = detail.slice(0, i); const lastOpen = Math.max(before.lastIndexOf("<Pressable"), before.lastIndexOf("<View")); const lastClosePressable = before.lastIndexOf("</Pressable>"); return [/<UiText/.test(line), !/onPress|Linking|Pressable/.test(line), before.slice(lastOpen, lastOpen + 9) !== "<Pressable" || lastClosePressable > lastOpen]; })(), [true, true, true]);
eq("the card shows 'Pays via ...' as text and its only tap target is the card itself", [/payVia/.test(src["components/money/CampaignCard.tsx"]), (src["components/money/CampaignCard.tsx"].match(/onPress=/g) ?? []).length], [true, 1]);
eq("payment_handle is never selected in a list query (apps cannot read the column; members use campaign_payment_info)", [/CAMPAIGN_COLUMNS =\s*\n?\s*"[^"]*payment_handle/.test(src["lib/moneyApi.ts"]), /select\("\*"\)|select\(`\*`\)/.test(all)], [false, false]);

// ── hidden behind the flag, and nothing before the walkthrough ──
const layout = read("app/(tabs)/_layout.tsx");
eq("the tab bar only shows Money when the database says so (features.money), otherwise href: null", [/const showMoney = features\.money/.test(layout), /name="money"[\s\S]{0,200}showMoney \? \{[^}]*title: "Money"[\s\S]{0,200}: \{ href: null \}/.test(layout)], [true, true]);
eq("Feed, the center + and Me are unchanged and Money sits between Feed and the +", (() => { const order = [...layout.matchAll(/<Tabs\.Screen\s+name="(\w+)"/g)].map((m) => m[1]); return order; })(), ["index", "money", "explore", "drop", "friends", "profile"]);
const tab = src["app/(tabs)/money.tsx"];
eq("the Money screen checks the server's answer in order: loaded, features.money, birthdate, profile ready, then shows the tabs", (() => { const idx = ["!loaded", "!features.money", "features.needs_birthdate", "!profile.ready", "tab === \"browse\""].map((k) => tab.indexOf(k)); return idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1])); })(), true);
eq("the screens use the database's state, never a client-side guess (no local 'is adult' / flag logic)", /age_tier|birthdate\s*[<>]|OWNER_USER_ID|isDebugOwner/.test(all), false);
const walkthrough = src["app/money/walkthrough.tsx"];
eq("the agreement button is disabled until every rule is ticked, and sends the role's required rules", [/disabled=\{!allTicked\}/.test(walkthrough), /const allTicked = rules\.every/.test(walkthrough), /completeOnboarding\(role, rules\)/.test(walkthrough), /requiredRules\(role\)/.test(walkthrough)], [true, true, true, true]);
eq("the walkthrough is swipeable (paging list) and has the review mode behind the ? button", [/pagingEnabled/.test(walkthrough), /review=1|review: "1"/.test(tab), /params\.review === "1"/.test(walkthrough)], [true, true, true]);
eq("the ? button and the FAQ exist", [/accessibilityLabel="How it works"/.test(tab), /FAQ\.map/.test(src["app/money/faq.tsx"])], [true, true]);
eq("empty states teach: Browse and My Clips", [/No campaigns yet — be the first creator/.test(tab), /Join a campaign to start earning/.test(tab)], [true, true]);

// ── reports, blocks, writes ──
eq("every campaign has Report and Block (Block uses the app's shared block list)", [/reportMoney\(me, "campaign", c\.id, reason\)/.test(detail), />Report</.test(detail), /Block creator/.test(detail), /useUserBlocks/.test(detail), /blockUser\(c\.creator_id\)/.test(detail), /!d\.mine/.test(detail)], Array(6).fill(true));
eq("the only direct table write in the Money code is the report row; everything else is a database function (rpc)", (() => { const w = [...all.matchAll(/\.from\("(\w+)"\)\s*\.(insert|update|upsert|delete)\(/g)].map((m) => `${m[1]}.${m[2]}`); return w; })(), ["reports.insert"]);
eq("the writes are the database functions", ["money_complete_onboarding", "money_create_campaign", "money_join_campaign", "money_set_campaign_status", "campaign_payment_info", "my_money_profile"].map((fn) => src["lib/moneyApi.ts"].includes(`"${fn}"`)), Array(6).fill(true));
eq("joining needs the Clipper Agreement ticked (button disabled until then) and goes through joinCampaign", [/disabled=\{!agreed\}/.test(detail), /joinCampaign\(c\.id\)/.test(detail), /CLIPPER_AGREEMENT/.test(detail)], [true, true, true]);
eq("a joined clipper can message the creator from the campaign", /router\.push\(`\/messages\/\$\{c\.creator_id\}`/.test(detail), true);
eq("creating needs the Campaign Agreement ticked and shows it", [/CAMPAIGN_AGREEMENT/.test(src["app/money/create-campaign.tsx"]), /f\.agree/.test(src["app/money/create-campaign.tsx"]), /validateCampaign\(f\)/.test(src["app/money/create-campaign.tsx"])], [true, true, true]);
eq("coach marks: one per create field group and one for joining", [(src["app/money/create-campaign.tsx"].match(/<CoachMark id="create_/g) ?? []).length, /<CoachMark id="join"/.test(detail)], [4, true]);
eq("the form's inputs are not components created inside render (they would lose focus on every keystroke)", /\n\s{2}const (Field|Chips) = /.test(src["app/money/create-campaign.tsx"]), false);

// ── the live-database check lists exactly the functions these screens call ──
const called = [...new Set([...(src["lib/moneyApi.ts"] + src["lib/moneyFeatures.ts"] + read("providers/PostsProvider.tsx")).matchAll(/(?:rpc<[^>]*>|supabase\.rpc)\(\s*"(money_[a-z_]+|my_money_profile|my_features|my_birthdate|set_my_birthdate|campaign_payment_info)"/g)].map((m) => m[1]))].sort();
const checked = [...new Set([...read("supabase/check-money-step2-functions.sql").matchAll(/^\s*\('([a-z_]+)',\s+'/gm)].map((m) => m[1]))].sort();
eq("check-money-step2-functions.sql checks exactly the database functions the Money screens call (so it cannot go stale)", checked, called);

// ── the rest of the app is untouched ──
eq("no Money file touches the feed, the post lifecycle or the editor", /PostsProvider|get_feed|trialEngine|app\/edit/.test(all.replace(/get_feed_engine/g, "")), false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
