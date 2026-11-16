/** First-time tips (coach marks) for Money: each shows once per person and can be dismissed. The ids are the steps the spec lists. */
export const MONEY_TIPS = {
  create_footage: "Add the videos clippers will cut from, up to 60 minutes in total and 30 minutes each. Keep Tryal open while they upload.",
  create_basics: "Name it, say what to clip, and add a link to your full video if you have one. Clips must be 1 minute or less.",
  create_pay: "You pay per 1,000 views, up to a cap per clip. A guaranteed amount is optional and is paid on approval whatever the views.",
  create_where: "Pick where clippers will post. Your payment handle is plain text: you pay them directly, outside the app.",
  create_limits: "Terms freeze when the first clipper joins. You can only add budget after that, never lower it.",
  join: "Joining shows you the frozen terms. Tryal opens a message thread with the creator for questions about the work.",
} as const;
export type MoneyTipId = keyof typeof MONEY_TIPS;
export const tipKey = (userId: string, id: MoneyTipId): string => `money_tip_${id}_${userId}`;
