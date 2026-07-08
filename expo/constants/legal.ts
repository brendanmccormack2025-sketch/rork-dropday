/**
 * Legal text content for DropDay.
 *
 * Each document is an ordered list of sections. A section has a heading and a
 * body (one or more paragraphs separated by a blank line). The legal screen
 * renders these as styled text — no markdown parser needed.
 *
 * Replace the text below with your final reviewed copy at any time; the screen
 * picks up changes automatically.
 */

export interface LegalSection {
  heading: string;
  /** Paragraphs. Each string is rendered as its own paragraph. */
  paragraphs: string[];
}

export interface LegalDocument {
  title: string;
  /** ISO date string shown as "Last updated: <date>". */
  lastUpdated: string;
  /** Short intro shown above the first section. */
  intro: string;
  sections: LegalSection[];
}

export const TERMS_OF_USE: LegalDocument = {
  title: "Terms of Use",
  lastUpdated: "2026-07-08",
  intro:
    "These Terms of Use govern your use of the DropDay app. By creating an account or using DropDay, you agree to these terms. Please read them carefully.",
  sections: [
    {
      heading: "1. Eligibility",
      paragraphs: [
        "You must be at least 13 years old to use DropDay. By creating an account, you confirm that you meet this age requirement and are legally able to enter into a binding agreement in your jurisdiction.",
        "If you are under 18, you also confirm that you have the permission of a parent or legal guardian to use DropDay and to agree to these terms on their behalf.",
      ],
    },
    {
      heading: "2. Your Account",
      paragraphs: [
        "You are responsible for keeping your account credentials secure and for all activity that happens under your account. You agree to provide accurate information at signup (including your birthdate) and to keep it up to date.",
        "You may not create an account for anyone other than yourself, and you may not share your account with others.",
      ],
    },
    {
      heading: "3. Content You Post",
      paragraphs: [
        "You retain ownership of the content you post to DropDay. By posting, you grant DropDay a worldwide, non-exclusive, royalty-free license to host, store, display, and distribute that content within the service.",
        "You are solely responsible for your content. You agree not to post anything that is unlawful, infringes someone else's rights, is sexually explicit involving minors, promotes hate or violence, harasses others, or otherwise violates these terms.",
        "DropDay may remove content or suspend accounts that violate these terms, with or without notice.",
      ],
    },
    {
      heading: "4. Acceptable Use",
      paragraphs: [
        "You agree not to misuse DropDay. This includes attempting to access another user's account, automating or scraping the service, interfering with the service's operation, or using DropDay for any illegal or unauthorized purpose.",
        "Reverse engineering, decompiling, or attempting to extract the source of the app is prohibited except to the extent permitted by law.",
      ],
    },
    {
      heading: "5. Mature Content",
      paragraphs: [
        "DropDay allows users to mark content as mature. Mature content is filtered from the feeds of users under 18. Marking non-mature content as mature, or failing to mark mature content, may result in removal of the content or suspension of your account.",
      ],
    },
    {
      heading: "6. Termination",
      paragraphs: [
        "You can delete your account at any time. DropDay may suspend or terminate your account and access to the service if you violate these terms or if we believe your conduct is harmful to other users or to the service.",
      ],
    },
    {
      heading: "7. Disclaimers",
      paragraphs: [
        "DropDay is provided \"as is\" and \"as available\" without warranties of any kind, whether express or implied. We do not guarantee that the service will be uninterrupted, secure, or error-free.",
      ],
    },
    {
      heading: "8. Limitation of Liability",
      paragraphs: [
        "To the maximum extent permitted by law, DropDay and its operators shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of or inability to use the service.",
      ],
    },
    {
      heading: "9. Changes to These Terms",
      paragraphs: [
        "We may update these terms from time to time. When we do, we will change the \"Last updated\" date above. Continued use of DropDay after changes take effect means you agree to the updated terms.",
      ],
    },
    {
      heading: "10. Contact",
      paragraphs: [
        "If you have questions about these terms, contact us through the app or at the email provided in the Privacy Policy.",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "2026-07-08",
  intro:
    "This Privacy Policy explains what information DropDay collects, how we use it, and the choices you have. By using DropDay, you agree to the practices described here.",
  sections: [
    {
      heading: "1. Information We Collect",
      paragraphs: [
        "Account information: the username, email, and birthdate you provide at signup. Your birthdate is used to determine your age tier and to filter mature content from your feed — it is not shown to other users.",
        "Content you post: videos, images, text overlays, and other content you create or upload.",
        "Usage information: how you interact with the app, such as the posts you like, accounts you follow, and technical data like device type and app version.",
      ],
    },
    {
      heading: "2. How We Use Your Information",
      paragraphs: [
        "To provide and maintain the service — creating your account, showing your feed, and letting you post and interact.",
        "To enforce age-gating and mature-content filtering so that users under 18 do not see mature content.",
        "To communicate with you about your account, policy changes, and support requests.",
        "To detect, prevent, and address fraud, abuse, and violations of our Terms of Use.",
      ],
    },
    {
      heading: "3. What Others Can See",
      paragraphs: [
        "Your username, display name, profile photo, and the content you post are visible to other users according to the feed and profile features of the app. Your email and birthdate are never shown to other users.",
      ],
    },
    {
      heading: "4. Data Retention",
      paragraphs: [
        "We keep your account information for as long as your account is active. Content you post is retained until you delete it or your account is deleted. When you delete your account, we remove your profile and associated content within a reasonable period.",
      ],
    },
    {
      heading: "5. Sharing of Your Information",
      paragraphs: [
        "We do not sell your personal information. We may share information with service providers who help us operate the app (such as hosting and authentication providers) under agreements that require them to protect your information.",
        "We may disclose information when required by law or to protect the rights, property, or safety of DropDay, our users, or others.",
      ],
    },
    {
      heading: "6. Your Choices",
      paragraphs: [
        "You can edit your profile information in the app. You can delete your account at any time, which removes your profile and content as described above.",
        "You can control whether your posts are marked as mature when you create or edit them.",
      ],
    },
    {
      heading: "7. Children's Privacy",
      paragraphs: [
        "DropDay is not directed to children under 13. We do not knowingly allow users under 13 to create accounts. If we learn that a user under 13 has created an account, we will delete it.",
        "Users between 13 and 17 are subject to age-appropriate content filtering: mature content is excluded from their feeds.",
      ],
    },
    {
      heading: "8. Security",
      paragraphs: [
        "We use reasonable measures to protect your information, including encrypted authentication and access controls. No method of transmission or storage is fully secure, and we cannot guarantee absolute security.",
      ],
    },
    {
      heading: "9. Changes to This Policy",
      paragraphs: [
        "We may update this Privacy Policy from time to time. When we do, we will change the \"Last updated\" date above. Continued use of DropDay after changes take effect means you agree to the updated policy.",
      ],
    },
    {
      heading: "10. Contact",
      paragraphs: [
        "If you have questions about this Privacy Policy or your personal information, contact us at support@dropday.app.",
      ],
    },
  ],
};
