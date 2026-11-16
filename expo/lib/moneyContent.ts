/**
 * The words of the Money tab's walkthrough, agreements and FAQ (MONEY_TAB_SPEC.md sections 3, 4 and 13b). The card lines are the spec's lines
 * verbatim: scripts/test-money-content.mjs reads the spec and fails if they drift. The rule keys are the ones the database requires
 * (money_required_rules in migration-money-board.sql): the server refuses an agreement with any of them missing.
 */
export type MoneyRole = "creator" | "clipper" | "both";
export type CardIcon = "workflow" | "link" | "dollar" | "lock" | "check" | "wallet" | "film" | "phone" | "shield" | "list" | "chat";
export type Card = { id: string; title: string; line: string; icon: CardIcon };

export const MONEY_INTRO = "Creators hire clippers. Clippers get paid for views. Tryal keeps everyone honest. Payments happen outside the app.";

/** The sentence the owner approved for every walkthrough and both agreements. Shown as a small note under a card's lines. */
export const MESSAGING_NOTICE = "Campaign members can message each other about the work, even if your messages are set to nobody. You can still block anyone.";

/** The two link sentences, shown as small notes under a card's lines like the messaging one. */
export const LINK_FROZEN_NOTE = "Your \"Full video\" link is frozen too, and every clip uses it with the clipper's own tracked link.";
export const LINK_BIO_NOTE = "Put your link in your bio. Every tap is counted.";
export const CARD_NOTES = [MESSAGING_NOTICE, LINK_FROZEN_NOTE, LINK_BIO_NOTE];

export const RULE_LABELS: Record<string, string> = {
  pay_on_time: "pay on time",
  terms_freeze: "terms freeze",
  auto_approval_48h: "auto-approval after 48 h",
  not_part_of_payment: "Tryal isn't part of the payment",
  own_footage_rights: "I own or have rights to my footage",
  only_real_views: "only real views",
  submit_through_tryal: "submit through Tryal",
  upload_proof_on_time: "upload proof on time",
  footage_use: "footage is only for making clips for this campaign",
  campaign_messaging: "campaign members can message me about the work, even if my messages are set to nobody (I can still block anyone)",
};

const CREATOR_RULES = ["pay_on_time", "terms_freeze", "auto_approval_48h", "not_part_of_payment", "own_footage_rights", "campaign_messaging"];
const CLIPPER_RULES = ["only_real_views", "submit_through_tryal", "upload_proof_on_time", "footage_use", "not_part_of_payment", "campaign_messaging"];

/** One checkbox per rule, in the order the spec lists them. "both" = the clipper rules then the creator-only ones, each once. */
export function requiredRules(role: MoneyRole): string[] {
  if (role === "creator") return CREATOR_RULES;
  if (role === "clipper") return CLIPPER_RULES;
  return [...CLIPPER_RULES, ...CREATOR_RULES.filter((r) => !CLIPPER_RULES.includes(r))];
}

export const CREATOR_CARDS: Card[] = [
  { id: "c1", icon: "workflow", title: "How it works", line: "How it works: post a campaign → clippers make clips in Tryal → strangers test them → clippers post on their own accounts → you pay for the views." },
  { id: "c2", icon: "film", title: "Your footage", line: "Your footage: upload videos from your camera roll, up to 60 minutes in total and 30 minutes each. We delete them 30 days after your campaign closes." },
  { id: "c3", icon: "dollar", title: "Setting pay", line: "Setting pay: an optional amount per clip plus a rate per 1,000 views, with a cap and a budget. Example: $3 per clip + $2 per 1,000 views, so 10,000 views = $23 per clip." },
  { id: "c4", icon: "lock", title: "Terms freeze", line: `Terms freeze once the first clipper joins. ${MESSAGING_NOTICE} ${LINK_FROZEN_NOTE}` },
  { id: "c5", icon: "check", title: "Approving", line: "Approving: you have 48 hours to approve or dispute, or the clip auto-approves." },
  { id: "c6", icon: "wallet", title: "Paying", line: "Paying: pay outside the app within 3 days. Your payment record is public, late payments pause your campaigns, and repeat late payments mean a ban." },
];

export const CLIPPER_CARDS: Card[] = [
  { id: "k1", icon: "workflow", title: "How it works", line: "How it works: join a campaign → make the clip in Tryal → post to Tryal (that's your submission) → post on your own accounts → prove your views → get paid." },
  { id: "k2", icon: "film", title: "Pick your moment", line: "Pick your moment: scrub the footage and mark a section up to 3 minutes. Only that part is downloaded to edit." },
  { id: "k3", icon: "phone", title: "Tryal first", line: "Tryal first: only clips posted on Tryal count. The clean file saves to your camera roll, then finish it anywhere." },
  { id: "k4", icon: "list", title: "Proving views", line: `Proving views: add your post links, and when the window ends upload screenshots of your analytics. ${LINK_BIO_NOTE}` },
  { id: "k5", icon: "wallet", title: "Getting paid", line: `Getting paid: the app shows what you're owed, the creator pays you directly, and you tap "Payment received." ${MESSAGING_NOTICE}` },
  { id: "k6", icon: "shield", title: "Real views only", line: "Real views only: fake or bought views mean a ban." },
];

/** The cards for a role, ending with the agreement card (kind "agreement" in the screen: the checkboxes). "both": the clipper cards, the
 *  creator-only cards 2-6 (the creator's "how it works" is skipped), then one combined agreement. */
export function cardsFor(role: MoneyRole): Card[] {
  if (role === "creator") return CREATOR_CARDS;
  if (role === "clipper") return CLIPPER_CARDS;
  return [...CLIPPER_CARDS, ...CREATOR_CARDS.slice(1)];
}

/** Title is not repeated in the body: "Paying: pay outside ..." -> lines "pay outside ...". Sentences, at most two, then the small notes (messaging, links). */
export function cardLines(card: Card): { lines: string[]; notes: string[] } {
  let body = card.line.startsWith(`${card.title}: `) ? card.line.slice(card.title.length + 2) : card.line;
  const notes: string[] = [];
  for (const n of CARD_NOTES) {
    if (body.includes(n)) { notes.push(n); body = body.replace(n, "").replace(/\s+/g, " ").trim(); }
  }
  const lines = body.split(/(?<=[.!?]["”]?)\s+(?=[A-Z$])/).map((s) => s.trim()).filter(Boolean);
  return { lines, notes };
}

export const CAMPAIGN_AGREEMENT = [
  "Only clips submitted through Tryal get paid.",
  "Terms freeze when the first clipper joins.",
  "48-hour approval window, after which clips auto-approve.",
  "Pay within 3 days of approval.",
  "The creator uploads footage they own or have the rights to. Tryal stores it privately, shows it only to clippers who joined, and deletes it 30 days after the campaign closes.",
  "The creator allows their footage to be posted on Tryal, tagged as clipped for them.",
  "A \"Full video\" link is optional. It is frozen once a clipper joins, and every clip uses it through the clipper's own tracked link. Tryal counts taps, never who tapped.",
  "Tryal is not part of the payment.",
  MESSAGING_NOTICE,
];

export const CLIPPER_AGREEMENT = [
  "only real views count",
  "fake or bought views mean a ban",
  "submit through Tryal",
  "upload view proof by the deadline",
  "footage is only for making clips for this campaign",
  "your clips use the creator's Full video link through your own tracked link: Tryal counts taps, never who tapped",
  MESSAGING_NOTICE,
];

export const FAQ: Array<{ q: string; a: string }> = [
  { q: "What if I'm not paid?", a: "After the 3 days are up, tap \"Not paid\" on the clip. That opens a case for Tryal. The creator can add a screenshot of their payment, you can answer, and Tryal decides. Confirmed non-payment bans the creator from Money." },
  { q: "What if views look fake?", a: "Clips with unusual numbers are flagged for a closer look. The creator can dispute a clip (fake views, wrong content, not my campaign, proof doesn't match). Tryal decides, and confirmed fake or bought views mean a ban." },
  { q: "How do disputes work?", a: "After you upload proof the creator has 48 hours to approve or dispute. No answer means the clip is approved. A dispute goes to Tryal, who can approve it, adjust the views or reject it." },
  { q: "How do reviews work?", a: "Once a clip is paid (or Tryal has settled it) both of you can leave 1 to 5 stars. Reviews stay hidden until both are in, or 7 days pass, then both publish. They can't be edited." },
  { q: "Is Tryal taking a cut?", a: "No. Tryal doesn't touch the money: the creator pays the clipper directly, outside the app." },
];
