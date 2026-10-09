/** The one-time "add your phone number" step after sign-up: shown once per account, skippable. */
export const phonePromptKey = (userId: string) => `phone_prompt_seen:${userId}`;
