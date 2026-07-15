/**
 * Legal text content for DropDay.
 *
 * Each document is an ordered list of sections. A section has a heading and a
 * body (one or more paragraphs separated by a blank line). The legal screen
 * renders these as styled text — no markdown parser needed.
 *
 * This text mirrors the published HTML versions at:
 *   https://brendanmccormack2025-sketch.github.io/DropDay-Legal/privacy.html
 *   https://brendanmccormack2025-sketch.github.io/DropDay-Legal/terms.html
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
  lastUpdated: "July 15, 2026",
  intro:
    "Welcome to DropDay. These Terms of Use (\"Terms\") govern your access to and use of the DropDay mobile application (the \"App\"), operated by DropDay (\"we,\" \"us,\" or \"our\"). By creating an account or using the App, you agree to these Terms.",
  sections: [
    {
      heading: "1. Eligibility",
      paragraphs: [
        "You must be at least 13 years old to use DropDay. By using the App, you represent that you meet this requirement and that the birth date you provide is accurate.",
      ],
    },
    {
      heading: "2. Your Account",
      paragraphs: [
        "You are responsible for maintaining the security of your account and for all activity that occurs under it. You must provide accurate information when creating your account.",
      ],
    },
    {
      heading: "3. Content Ownership and License",
      paragraphs: [
        "You retain ownership of all content you create and post on DropDay (\"User Content\"). By posting User Content, you grant DropDay a non-exclusive, worldwide, royalty-free license to host, store, display, reproduce, and distribute your User Content solely for the purpose of operating and providing the App's features to you and other users. This license ends when you delete your content or your account, except to the extent your content has been shared with or saved by other users through normal use of the App prior to deletion.",
      ],
    },
    {
      heading: "4. Acceptable Use",
      paragraphs: [
        "You agree not to post content that:",
        "• Is illegal, harassing, hateful, or threatens violence",
        "• Sexually exploits or endangers minors in any way",
        "• Infringes on another person's intellectual property or privacy rights",
        "• Impersonates another person or entity",
        "• Is spam or intended to deceive other users",
        "We reserve the right to remove any content that violates these Terms and to suspend or terminate accounts that repeatedly or seriously violate them.",
      ],
    },
    {
      heading: "5. Reporting and Moderation",
      paragraphs: [
        "DropDay provides tools for users to report content or block other users. We review reports and may remove content or restrict accounts found to violate these Terms. Content that receives multiple reports may be automatically hidden pending review.",
      ],
    },
    {
      heading: "6. Account Termination",
      paragraphs: [
        "You may delete your account at any time. We may suspend or terminate your account if you violate these Terms, engage in harmful conduct, or if required by law.",
      ],
    },
    {
      heading: "7. Age-Appropriate Content",
      paragraphs: [
        "Users aged 13–17 will not be shown content that creators have marked as \"mature.\" Users are responsible for accurately marking their own content as mature where appropriate.",
      ],
    },
    {
      heading: "8. Disclaimers",
      paragraphs: [
        "The App is provided \"as is\" without warranties of any kind, express or implied. We do not guarantee the App will be uninterrupted, secure, or error-free.",
      ],
    },
    {
      heading: "9. Limitation of Liability",
      paragraphs: [
        "To the maximum extent permitted by law, DropDay shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the App.",
      ],
    },
    {
      heading: "10. Changes to These Terms",
      paragraphs: [
        "We may update these Terms from time to time. Continued use of the App after changes take effect constitutes acceptance of the updated Terms.",
      ],
    },
    {
      heading: "11. Governing Law",
      paragraphs: [
        "These Terms are governed by the laws of the State of California, USA, without regard to conflict of law principles.",
      ],
    },
    {
      heading: "12. Dispute Resolution",
      paragraphs: [
        "Any dispute arising from these Terms or your use of the App will first be attempted to be resolved informally by contacting us at DropDayApp@yahoo.com. If a dispute cannot be resolved informally, it will be resolved through binding arbitration on an individual basis, and you waive any right to participate in a class action.",
      ],
    },
    {
      heading: "13. DMCA / Copyright Complaints",
      paragraphs: [
        "If you believe content on DropDay infringes your copyright, contact us at DropDayApp@yahoo.com with a description of the material and your contact information.",
      ],
    },
    {
      heading: "14. Contact Us",
      paragraphs: [
        "Questions about these Terms? Contact us at DropDayApp@yahoo.com",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "July 15, 2026",
  intro:
    "DropDay (\"we,\" \"us,\" or \"our\") operates the DropDay mobile application (the \"App\"). This Privacy Policy explains what information we collect, how we use it, and your rights regarding that information.",
  sections: [
    {
      heading: "1. Information We Collect",
      paragraphs: [
        "• Account information: email address, date of birth (used only to verify age eligibility), and username.",
        "• Content you create: videos, images, captions, and reactions you post to the App.",
        "• Usage data: basic app interaction data (e.g., likes, follows, views) needed to operate core features.",
        "• Device information: general device and app version information for crash reporting and compatibility.",
        "We do not collect more personal information than is necessary to operate DropDay's core features.",
      ],
    },
    {
      heading: "2. How We Use Your Information",
      paragraphs: [
        "• To create and maintain your account",
        "• To operate core app features (feed, reactions, follows, notifications)",
        "• To enforce our age requirements and content moderation policies",
        "• To respond to support requests",
        "• To comply with legal obligations",
        "We do not sell your personal information to third parties.",
      ],
    },
    {
      heading: "3. Teen Users (Ages 13–17)",
      paragraphs: [
        "DropDay requires all users to be at least 13 years old. Users who indicate they are between 13 and 17 years old have additional protections:",
        "• Content marked as \"mature\" by its creator is automatically filtered out of their feed and is not shown to them.",
        "• We do not knowingly allow targeted advertising based on the personal information of users under 18.",
      ],
    },
    {
      heading: "4. Third-Party Services",
      paragraphs: [
        "DropDay uses the following third-party services to operate:",
        "• Supabase (database, authentication, and file storage) — your account data, posted content, and media files are stored on Supabase's infrastructure.",
        "These providers only process your data to the extent necessary to provide their services to us and are not permitted to use your data for their own purposes.",
      ],
    },
    {
      heading: "5. Data Retention and Deletion",
      paragraphs: [
        "You may permanently delete your account at any time from Settings → Delete Account. When you do:",
        "• Your profile, posts, reactions, likes, and follow relationships are permanently deleted from our database immediately.",
        "• Associated media files (videos/images) are permanently deleted from our storage within 30 days.",
        "• This action cannot be undone.",
      ],
    },
    {
      heading: "6. Your Rights",
      paragraphs: [
        "Depending on your location, you may have the right to access, correct, or request deletion of your personal information. To exercise these rights, contact us at DropDayApp@yahoo.com.",
      ],
    },
    {
      heading: "7. Children's Privacy",
      paragraphs: [
        "DropDay is not directed at children under 13, and we do not knowingly collect personal information from anyone under 13. If we learn that we have collected personal information from a child under 13, we will delete it promptly.",
      ],
    },
    {
      heading: "8. Changes to This Policy",
      paragraphs: [
        "We may update this Privacy Policy from time to time. We will notify users of material changes through the App.",
      ],
    },
    {
      heading: "9. Contact Us",
      paragraphs: [
        "If you have questions about this Privacy Policy, contact us at: DropDayApp@yahoo.com",
      ],
    },
  ],
};
