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
  lastUpdated: "[Insert Date]",
  intro:
    "These Terms of Use govern your use of DropDay. By accessing or using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service. These Terms should be read alongside our Privacy Policy, which explains how we collect and use your information.",
  sections: [
    {
      heading: "1. Agreement to Terms",
      paragraphs: [
        "By accessing or using DropDay (the \"Service\"), you agree to be bound by these Terms of Use (\"Terms\"). If you do not agree, do not use the Service. These Terms should be read alongside our Privacy Policy, which explains how we collect and use your information.",
      ],
    },
    {
      heading: "2. Eligibility",
      paragraphs: [
        "You must be at least 13 years old to use DropDay. By using the Service, you represent that you meet this age requirement. Users between 13 and 17 may be subject to additional content restrictions as described in our Privacy Policy.",
        "If you are using DropDay on behalf of a minor as a parent or guardian, you are responsible for that minor's compliance with these Terms.",
      ],
    },
    {
      heading: "3. Your Account",
      paragraphs: [
        "You are responsible for maintaining the confidentiality of your account credentials and for all activity under your account. You must provide accurate information when creating an account. We reserve the right to suspend or terminate accounts that violate these Terms.",
      ],
    },
    {
      heading: "4. User Content",
      paragraphs: [
        "Ownership. You retain ownership of the videos, images, text, and other content you create and post to DropDay (\"User Content\").",
        "License to DropDay. By posting User Content, you grant DropDay a worldwide, non-exclusive, royalty-free, sublicensable license to host, store, reproduce, distribute, display, and perform your User Content solely for the purpose of operating, providing, and improving the Service. This license ends when you delete your content or your account, except where your content has been shared with or reposted by other users, or where retention is required for legal purposes.",
        "Your responsibility for content. You are solely responsible for the content you post. You represent that you have all necessary rights to post it, and that it does not violate any law or the rights of any third party.",
        "Prohibited content. You may not post content that:",
        "• Is illegal, harassing, hateful, or threatening",
        "• Infringes on another person's intellectual property, privacy, or other rights",
        "• Depicts or promotes child sexual abuse material (CSAM) — such content will be removed immediately and reported to the National Center for Missing & Exploited Children (NCMEC) and/or law enforcement as required by law",
        "• Constitutes spam, impersonation, or fraud",
        "• Violates any applicable law or regulation",
        "We reserve the right, but not the obligation, to remove any content and/or terminate accounts that violate these Terms.",
      ],
    },
    {
      heading: "5. Mature Content",
      paragraphs: [
        "DropDay allows users to flag their own content as \"mature.\" Content flagged as mature is restricted from being shown to users identified as being under 18. Users are responsible for accurately flagging their content; misuse of this feature may result in content removal or account suspension.",
      ],
    },
    {
      heading: "6. Intellectual Property",
      paragraphs: [
        "DropDay, the DropDay logo, and associated branding are trademarks of [Your Name / LLC Name Once Formed]. You may not use our trademarks without our prior written permission. All other trademarks referenced are the property of their respective owners.",
        "The Service itself (excluding User Content) — including its design, software, and features — is owned by DropDay and protected by intellectual property laws. These Terms do not grant you any rights to our intellectual property beyond what's necessary to use the Service as intended.",
      ],
    },
    {
      heading: "7. Copyright Complaints (DMCA)",
      paragraphs: [
        "If you believe content on DropDay infringes your copyright, please send a notice to our designated agent at [Insert DMCA Contact Email], including:",
        "• Identification of the copyrighted work claimed to be infringed",
        "• Identification of the material you claim is infringing, with enough detail for us to locate it",
        "• Your contact information",
        "• A statement that you have a good-faith belief the use is not authorized",
        "• A statement, under penalty of perjury, that the information is accurate and you are authorized to act on behalf of the copyright owner",
        "• Your physical or electronic signature",
        "We will respond to valid notices in accordance with the Digital Millennium Copyright Act, which may include removing the reported content and, for repeat infringers, terminating accounts.",
      ],
    },
    {
      heading: "8. Termination",
      paragraphs: [
        "You may delete your account at any time. We may suspend or terminate your access to the Service at our discretion, with or without notice, for conduct that violates these Terms or is otherwise harmful to the Service, other users, or third parties.",
      ],
    },
    {
      heading: "9. Disclaimers",
      paragraphs: [
        "THE SERVICE IS PROVIDED \"AS IS\" AND \"AS AVAILABLE,\" WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE.",
        "WE ARE NOT RESPONSIBLE FOR USER CONTENT AND DO NOT ENDORSE ANY OPINIONS OR INFORMATION EXPRESSED BY USERS.",
      ],
    },
    {
      heading: "10. Limitation of Liability",
      paragraphs: [
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, DROPDAY AND ITS OWNERS, EMPLOYEES, AND AFFILIATES SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE SERVICE, INCLUDING BUT NOT LIMITED TO LOSS OF DATA, LOSS OF PROFITS, OR DAMAGES RESULTING FROM USER CONTENT OR CONDUCT OF ANY THIRD PARTY.",
        "OUR TOTAL LIABILITY FOR ANY CLAIM ARISING FROM THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE PAST 12 MONTHS, OR (B) $100.",
      ],
    },
    {
      heading: "11. Indemnification",
      paragraphs: [
        "You agree to indemnify and hold harmless DropDay and its owners, employees, and affiliates from any claims, damages, losses, or expenses (including reasonable attorneys' fees) arising from your use of the Service, your User Content, or your violation of these Terms.",
      ],
    },
    {
      heading: "12. Dispute Resolution",
      paragraphs: [
        "[Placeholder — to be finalized with an attorney before publishing.]",
      ],
    },
    {
      heading: "13. Changes to These Terms",
      paragraphs: [
        "We may modify these Terms at any time. We will notify users of material changes through the app or other reasonable means. Continued use of the Service after changes take effect constitutes acceptance of the revised Terms.",
      ],
    },
    {
      heading: "14. Contact",
      paragraphs: [
        "Questions about these Terms should be directed to:",
        "[Insert business name]",
        "[Insert contact email]",
        "[Insert mailing address, if applicable]",
      ],
    },
  ],
};

export const PRIVACY_POLICY: LegalDocument = {
  title: "Privacy Policy",
  lastUpdated: "[Insert Date]",
  intro:
    "This Privacy Policy explains how DropDay collects, uses, and protects information when you use the app. By using DropDay, you agree to the collection and use of information as described in this policy.",
  sections: [
    {
      heading: "1. Introduction",
      paragraphs: [
        "DropDay (\"we,\" \"us,\" or \"our\") operates a mobile application that allows users to capture, edit, and share short-form video content (\"Drops\"). This Privacy Policy explains how we collect, use, and protect information when you use the DropDay app (the \"Service\").",
        "By using DropDay, you agree to the collection and use of information as described in this policy.",
      ],
    },
    {
      heading: "2. Age Requirements",
      paragraphs: [
        "DropDay is intended for users who are 13 years of age or older. We do not knowingly collect personal information from children under 13. If we become aware that a user under 13 has created an account, we will take steps to delete that account and any associated information.",
        "Parents or guardians who believe their child under 13 has created an account should contact us at [insert contact email] so we can investigate and remove the account.",
        "Teen Accounts (Ages 13–17). Users between the ages of 13 and 17 are subject to additional content protections:",
        "• Content flagged as mature by its creator is automatically filtered from teen users' feeds.",
        "• [Insert any additional teen-specific protections you implement.]",
      ],
    },
    {
      heading: "3. Information We Collect",
      paragraphs: [
        "Information you provide directly:",
        "• Account information: username, email address, password, birthdate",
        "• Profile information: display name, bio, avatar, website, and social media handles you choose to add",
        "• Content: videos, captions, text overlays, and other content you create and post",
        "• Communications: messages you send through the app, if applicable",
        "Information collected automatically:",
        "• Device information (device type, operating system)",
        "• Usage data (features used, content viewed, interactions such as likes and follows)",
        "• Log data (IP address, access times, app crashes)",
        "Information from your use of camera and media features:",
        "• Camera and microphone access, used solely to allow you to record content, with your permission granted through your device's operating system",
      ],
    },
    {
      heading: "4. How We Use Information",
      paragraphs: [
        "We use collected information to:",
        "• Provide, operate, and maintain the Service",
        "• Create and manage your account",
        "• Enable content posting, viewing, likes, follows, and other social features",
        "• Filter content appropriately based on age tier (e.g., restricting mature content from teen accounts)",
        "• Improve and personalize the Service, including content ranking in feeds",
        "• Communicate with you about your account or the Service",
        "• Detect, prevent, and address technical issues, fraud, or violations of our Terms of Service",
      ],
    },
    {
      heading: "5. How We Share Information",
      paragraphs: [
        "We do not sell your personal information. We may share information:",
        "• With other users, as a normal part of the Service's social functionality",
        "• With service providers who perform services on our behalf (e.g., cloud hosting and storage providers)",
        "• For legal reasons, if required by law, subpoena, or other legal process",
        "• In connection with a business transaction, such as a merger, acquisition, or sale of assets",
      ],
    },
    {
      heading: "6. Children's Privacy (COPPA Compliance)",
      paragraphs: [
        "DropDay does not permit users under the age of 13 to create accounts, and we do not knowingly collect personal information from children under 13. Our sign-up process requires users to confirm their date of birth, and accounts are not created for users who indicate they are under 13.",
        "If we learn that we have inadvertently collected personal information from a child under 13, we will delete that information as quickly as possible. Parents who believe we may have collected information from their child under 13 should contact us at [insert contact email].",
      ],
    },
    {
      heading: "7. Your Rights and Choices",
      paragraphs: [
        "Depending on your location, you may have rights to:",
        "• Access the personal information we hold about you",
        "• Request correction of inaccurate information",
        "• Request deletion of your account and associated data",
        "• Object to or restrict certain processing of your information",
        "To exercise these rights, contact us at [insert contact email].",
      ],
    },
    {
      heading: "8. Data Retention",
      paragraphs: [
        "We retain your information for as long as your account is active or as needed to provide the Service. If you delete your account, we will delete or anonymize your personal information within [insert timeframe], except where retention is required for legal or legitimate business purposes.",
      ],
    },
    {
      heading: "9. Data Security",
      paragraphs: [
        "We use reasonable administrative, technical, and physical safeguards to protect your information. However, no method of transmission or storage is 100% secure, and we cannot guarantee absolute security.",
      ],
    },
    {
      heading: "10. Changes to This Policy",
      paragraphs: [
        "We may update this Privacy Policy from time to time. We will notify users of material changes through the app or by other means before the changes take effect.",
      ],
    },
    {
      heading: "11. Contact Us",
      paragraphs: [
        "If you have questions about this Privacy Policy, please contact us at:",
        "[Insert business name]",
        "[Insert contact email]",
        "[Insert mailing address, if applicable]",
      ],
    },
  ],
};
