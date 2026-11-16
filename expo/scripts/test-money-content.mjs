#!/usr/bin/env node
/**
 * Money walkthrough, agreements and FAQ (lib/moneyContent.ts) against the spec (MONEY_TAB_SPEC.md sections 3, 4, 13b) and the database
 * (the rules money_required_rules() demands in migration-money-board.sql).
 *   node --experimental-strip-types --no-warnings scripts/test-money-content.mjs
 */
import { readFileSync } from "node:fs";
import { CAMPAIGN_AGREEMENT, CARD_NOTES, CLIPPER_AGREEMENT, CLIPPER_CARDS, CREATOR_CARDS, FAQ, LINK_BIO_NOTE, LINK_FROZEN_NOTE, MESSAGING_NOTICE, MONEY_INTRO, RULE_LABELS, cardLines, cardsFor, requiredRules } from "../lib/moneyContent.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const spec = read("../../MONEY_TAB_SPEC.md");
const sql = read("../supabase/migration-money-board.sql");

// ── the cards are the spec's lines ──
const section = (heading) => { const i = spec.indexOf(heading); const rest = spec.slice(i + heading.length); const end = rest.search(/\n\n/); return rest.slice(0, end).split("\n").filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, "")); };
const creatorSpec = section("**Creator walkthrough cards:**\n");
const clipperSpec = section("**Clipper walkthrough cards:**\n");
eq("the creator has 6 cards + the agreement card in the spec (7)", creatorSpec.length, 7);
eq("the clipper has 6 cards + the agreement card in the spec (7)", clipperSpec.length, 7);
eq("creator card lines are the spec's lines, verbatim", CREATOR_CARDS.map((c) => c.line), creatorSpec.slice(0, 6));
eq("clipper card lines are the spec's lines, verbatim", CLIPPER_CARDS.map((c) => c.line), clipperSpec.slice(0, 6));
const checkboxLine = (spec7) => spec7.replace(/^Agreement checkboxes: /, "").replace(/\.$/, "").split(" · ");
const cap = (t) => t;
eq("the creator's agreement checkboxes are the spec's, in order", requiredRules("creator").map((r) => RULE_LABELS[r]), checkboxLine(creatorSpec[6]));
eq("the clipper's agreement checkboxes are the spec's, in order", requiredRules("clipper").map((r) => RULE_LABELS[r]), checkboxLine(clipperSpec[6]));
eq("the intro is the spec's", spec.includes(`"${MONEY_INTRO}"`), true);

// ── the shape the spec asks for ──
const all = [...CREATOR_CARDS, ...CLIPPER_CARDS];
eq("5 to 7 cards per role including the agreement", [cardsFor("creator").length + 1, cardsFor("clipper").length + 1].map((n) => n >= 5 && n <= 7), [true, true]);
eq("every card has a title, a picture and at most two short lines (the messaging and link sentences are small notes under them)", all.map((c) => { const { lines } = cardLines(c); return !!c.title && !!c.icon && lines.length >= 1 && lines.length <= 2; }), Array(all.length).fill(true));
eq("every card's text is short (under 200 characters without the notice)", all.every((c) => cardLines(c).lines.join(" ").length < 200), true);
eq("'both' = the clipper cards, then the creator cards 2-6 (the creator's 'how it works' skipped), then one combined agreement", [cardsFor("both").map((c) => c.id), cardsFor("both").length], [[...CLIPPER_CARDS.map((c) => c.id), ...CREATOR_CARDS.slice(1).map((c) => c.id)], 11]);
eq("the combined agreement has the union of the rules, each once", [new Set(requiredRules("both")).size === requiredRules("both").length, [...requiredRules("creator"), ...requiredRules("clipper")].every((r) => requiredRules("both").includes(r)), requiredRules("both").length], [true, true, 9]);

// ── the messaging line ──
eq("the sentence is exactly the one the owner approved", MESSAGING_NOTICE, "Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone.");
eq("the notes: messaging on the creator card 'Terms freeze' and the clipper card 'Getting paid'; the frozen Full video link on 'Terms freeze'; 'put your link in your bio' on the clipper card 'Proving views'", [CREATOR_CARDS.map((c) => [c.title, cardLines(c).notes.length]).filter(([, n]) => n), CLIPPER_CARDS.map((c) => [c.title, cardLines(c).notes.length]).filter(([, n]) => n), cardLines(CREATOR_CARDS[3]).notes, cardLines(CLIPPER_CARDS[3]).notes], [[["Terms freeze", 2]], [["Proving views", 1], ["Getting paid", 1]], [MESSAGING_NOTICE, LINK_FROZEN_NOTE], [LINK_BIO_NOTE]]);
eq("the two link sentences are exactly the owner's", [LINK_BIO_NOTE, LINK_FROZEN_NOTE, CARD_NOTES.length], ["Put your link in your bio. Every tap is counted.", "Your \"Full video\" link is frozen too, and every clip uses it with the clipper's own tracked link.", 3]);
eq("both agreements list it, and so do both agreement checkbox lines", [CAMPAIGN_AGREEMENT.includes(MESSAGING_NOTICE), CLIPPER_AGREEMENT.includes(MESSAGING_NOTICE), requiredRules("creator").includes("campaign_messaging"), requiredRules("clipper").includes("campaign_messaging")], [true, true, true, true]);
eq("the spec has the same sentence in sections 3, 4 and 13b", [(spec.match(new RegExp(MESSAGING_NOTICE.replace(/[.]/g, "\\."), "g")) ?? []).length >= 4], [true]);

// ── the agreements are the spec's lists ──
const bullets = (from, to, indent = "") => { const a = spec.indexOf(from); const b = spec.indexOf(to, a); return spec.slice(a, b).split("\n").filter((l) => new RegExp(`^${indent}- `).test(l)).map((l) => l.replace(/^\s*- /, "").trim()); };
eq("the Campaign Agreement is the spec's list (section 3)", CAMPAIGN_AGREEMENT, bullets("The creator must accept the **Campaign Agreement** before posting:", "### 3.1"));
eq("the Clipper Agreement is the spec's list (section 4), lower case as written", CLIPPER_AGREEMENT.map((l) => l.toLowerCase()), bullets("An **\"I'm in\"** button shows", "- Footage is available only", "  ").filter((l) => !l.startsWith("An ")).map((l) => l.toLowerCase()));

// ── the rules are exactly what the database requires ──
const sqlRules = (role) => { const m = new RegExp(`when '${role}'\\s+then array\\[([^\\]]*)\\]`).exec(sql); return m[1].match(/'([a-z_0-9]+)'/g).map((x) => x.slice(1, -1)); };
eq("creator rules = money_required_rules('creator')", [...requiredRules("creator")].sort(), [...sqlRules("creator")].sort());
eq("clipper rules = money_required_rules('clipper')", [...requiredRules("clipper")].sort(), [...sqlRules("clipper")].sort());
eq("both rules = money_required_rules('both')", [...requiredRules("both")].sort(), [...sqlRules("both")].sort());
eq("every rule has a label", requiredRules("both").every((r) => !!RULE_LABELS[r]), true);

// ── the FAQ the spec lists ──
eq("the FAQ answers the five questions the spec lists", FAQ.map((f) => f.q), ["What if I'm not paid?", "What if views look fake?", "How do disputes work?", "How do reviews work?", "Is Tryal taking a cut?"]);
eq("...and says Tryal takes no cut", /No\. Tryal doesn't touch the money/.test(FAQ[4].a), true);
eq("no card or FAQ text offers a payment link or in-app payment", [...all.map((c) => c.line), ...FAQ.map((f) => f.a)].some((t) => /https?:\/\/|paypal\.me|venmo\.com|cash\.app|pay now|checkout/i.test(t)), false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
