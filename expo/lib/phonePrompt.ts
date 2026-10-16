/** The one-time "add your phone number" step after sign-up: shown once per account, skippable. */
export const phonePromptKey = (userId: string) => `phone_prompt_seen:${userId}`;
/** The one-time contacts step (after the phone step; also shown once to accounts made before it existed). */
export const contactsPromptKey = (userId: string) => `contacts_prompt_seen:${userId}`;
