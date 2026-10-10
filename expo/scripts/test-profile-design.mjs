#!/usr/bin/env node
/** The redesigned profile screens: tokens, grid metrics, tabs, wiring (no counts, no SURVIVED badge on tiles, light tab bar). */
import { readFileSync } from "node:fs";
import { AVATAR_SIZE, SIDE_MARGIN, colors, radius, space } from "../constants/design.ts";
import { AVATAR_TINTS } from "../constants/design.ts";
import { GRID_COLUMNS, GRID_GAP, OWN_TABS, avatarInitial, avatarTint, gridTileSize, initialOwnTab, postsForTab } from "../lib/profileUi.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

eq("design tokens: radius 10 / 14 / 999, spacing 4-8-12-16-24-32, 16 pt side margins", [radius, Object.values(space), SIDE_MARGIN], [{ tile: 10, button: 14, pill: 999 }, [4, 8, 12, 16, 24, 32], 16]);
eq("avatar ~88 pt; soft fills instead of borders", [AVATAR_SIZE, colors.fill, colors.primary], [88, "#ECEAE4", "#E8291C"]);
for (const w of [375, 390, 430]) {
  const t = gridTileSize(w);
  eq(`grid at ${w} pt: 3 columns + 2 pt gaps fit between the 16 pt margins, 9:16 tiles`, [GRID_COLUMNS, GRID_GAP, t.width * 3 + GRID_GAP * 2 <= w - 2 * SIDE_MARGIN, Math.abs(t.height / t.width - 16 / 9) < 0.01], [3, 2, true, true]);
}
eq("375 pt phone: tiles are 113 x 201", gridTileSize(375), { width: 113, height: 201 });
eq("avatar without a photo: the initial on a soft tint, the same every time", [avatarInitial(" brendan"), avatarTint("brendan") === avatarTint("brendan"), AVATAR_TINTS.includes(avatarTint("tester"))], ["B", true, true]);
eq("own tabs: Survived, On Trial, Drafts", OWN_TABS.map((t) => t.label), ["Survived", "On Trial", "Drafts"]);

const posts = [
  { id: "s", status: "survived", survived_at: "2026-10-01" }, { id: "e", status: "expired", survived_at: "2026-09-01" },
  { id: "t", status: "trial" }, { id: "q", status: "queued" }, { id: "gone", status: "survived", survived_at: "2026-10-01", media_deleted_at: "2026-10-02" },
];
eq("Survived tab: survived posts, also after their window; On Trial: testing + queued only", [postsForTab(posts, "survived").map((p) => p.id), postsForTab(posts, "trial").map((p) => p.id), postsForTab(posts, "drafts")], [["s", "e"], ["t", "q"], []]);
eq("opens on Survived; on On Trial when nothing survived yet but something is testing", [initialOwnTab(posts), initialOwnTab([{ status: "trial" }]), initialOwnTab([])], ["survived", "trial", "survived"]);

const own = read("../app/(tabs)/profile.tsx"), other = read("../app/user/[id].tsx"), parts = read("../components/profile/ProfileParts.tsx"), tabs = read("../app/(tabs)/_layout.tsx"), drops = read("../app/profile-drops.tsx");
eq("no stats anywhere: no counts of survived posts, likes, followers or failures in either header", [/followers|following|survived count|totalLikes|posts count/i.test(own + other), /\.length\} (posts|survived)/i.test(own + other)], [false, false]);
eq("no SURVIVED badge on tiles (the tile has the like count and, for queued posts, a small Queued label)", [/TrialStatusBadge/.test(parts + own + other), /Queued/.test(parts), /Heart/.test(parts)], [false, true, true]);
eq("own profile: Edit profile as one soft button, Settings as a small round icon button, tabs with an animated underline", [/label="Edit profile"/.test(own), /RoundIconButton label="Settings"/.test(own), /Animated\.timing/.test(parts) && /ProfileTabs/.test(own)], [true, true, true]);
eq("other users' profile: Survived grid only, no tabs, no Edit / Settings", [/ProfileTabs/.test(other), /Edit profile/.test(other), /Settings/.test(other), /isOnOtherProfile/.test(other)], [false, false, false, true]);
eq("empty states: own and others'", [/Your wins live here\./.test(read("../lib/profileUi.ts")), /Put something on Trial\./.test(read("../lib/profileUi.ts")), /No survived posts yet/.test(read("../lib/profileUi.ts")), /router\.push\("\/camera"\)/.test(own)], [true, true, true, true]);
eq("3-column grid on both screens", [/numColumns=\{GRID_COLUMNS\}/.test(own), /numColumns=\{GRID_COLUMNS\}/.test(other)], [true, true]);
eq("the profile viewer opens the same list as the tapped tab", [/tab,? \} as never|initialIndex: String\(index\), tab/.test(own), /params\.tab/.test(drops)], [true, true]);
eq("verified badge stays next to the name (compact)", [/VerifiedCreatorBadge compact/.test(own), /VerifiedCreatorBadge compact/.test(other)], [true, true]);
eq("links: round icon buttons through the shared helper (only the ones set)", [/getCreatorLinks/.test(parts), /openCreatorLink/.test(parts), /size=\{36\}/.test(parts)], [true, true, true]);
eq("tab bar: light blur + hairline border, no dark gradient", [/BlurView/.test(tabs), /tint="light"/.test(tabs), /hairlineWidth/.test(tabs), /LinearGradient|rgba\(0,0,0,0\.75\)|rgba\(255,255,255,0\.75\)/.test(tabs)], [true, true, true, false]);
eq("app.json version untouched", JSON.parse(read("../app.json")).expo.version, "1.0.4");
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
