/**
 * Phone number normalisation to E.164 (+<country code><number>). Pure; erasable TypeScript only so the Node tests can
 * run it. The number only ever leaves the phone to be hashed on the server (see migration-known-connections.sql).
 */

/** Calling codes for the regions people are most likely to be in; anything else must be typed with a leading +. */
const DIAL_CODES: Record<string, string> = {
  US: "1", CA: "1", GB: "44", IE: "353", AU: "61", NZ: "64", IN: "91", PK: "92", BD: "880", PH: "63", ID: "62",
  MY: "60", SG: "65", HK: "852", JP: "81", KR: "82", CN: "86", TW: "886", TH: "66", VN: "84", AE: "971", SA: "966",
  IL: "972", TR: "90", EG: "20", ZA: "27", NG: "234", KE: "254", GH: "233", DE: "49", FR: "33", ES: "34", IT: "39",
  NL: "31", BE: "32", CH: "41", AT: "43", SE: "46", NO: "47", DK: "45", FI: "358", PL: "48", PT: "351", GR: "30",
  CZ: "420", RO: "40", UA: "380", BR: "55", MX: "52", AR: "54", CL: "56", CO: "57", PE: "51",
};

const NANP = new Set(["US", "CA"]);

/** Digits of the text before any extension marker. */
function digitsOf(raw: string): { plus: boolean; digits: string } {
  const cut = raw.split(/[xX;,#]/)[0] ?? "";
  const trimmed = cut.trim();
  const plus = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);
  return { plus, digits };
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/** "(415) 555-2671" + "US" -> "+14155552671". Returns null when it cannot be a real number. */
export function normalizeE164(raw: string | null | undefined, region?: string | null): string | null {
  if (!raw) return null;
  const { plus, digits } = digitsOf(raw);
  if (!digits) return null;
  let candidate: string | null = null;
  if (plus) {
    candidate = `+${digits}`;
  } else {
    const code = region ? DIAL_CODES[region.toUpperCase()] : undefined;
    if (!code) return null;
    if (NANP.has((region as string).toUpperCase())) {
      if (digits.length === 10) candidate = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
    } else {
      const national = digits.replace(/^0+/, "");   // trunk prefix
      candidate = `+${code}${national}`;
    }
  }
  return candidate && E164.test(candidate) ? candidate : null;
}

/** The region of the phone's locale ("en-US" -> "US"), or null. */
export function regionFromLocale(locale: string | null | undefined): string | null {
  const m = /[-_]([A-Za-z]{2})\b/.exec(locale ?? "");
  return m ? m[1].toUpperCase() : null;
}
