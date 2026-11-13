/**
 * Birthdate entry for Money (18+ only) and sign-up. Pure and deterministic: the server (set_my_birthdate, handle_new_user) checks
 * everything again, this only gives people a clear message before the round trip.
 * The date is typed as month / day / year and sent as an ISO "YYYY-MM-DD" string; it is never formatted through the device
 * time zone (a Date built from local parts and read back could land on the previous day).
 */
export type AgeTier = "under_13" | "teen" | "adult";

export type BirthdateResult =
  | { ok: true; iso: string; tier: AgeTier }
  | { ok: false; error: string };

const MIN_YEAR = 1900;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** "YYYY-MM-DD" for a calendar date, or null when it does not exist (Feb 30, month 13 ...). */
export function toIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** The same rule as the server's age_tier(): under 13 / under 18 / 18 and over, counted in whole years to the day. */
export function ageTierOf(iso: string | null | undefined, today: Date = new Date()): AgeTier | "unknown" {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return "unknown";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < mo || (today.getMonth() + 1 === mo && today.getDate() < d)) age -= 1;
  if (age < 13) return "under_13";
  if (age < 18) return "teen";
  return "adult";
}

/** Validate what the three fields hold. Errors are short and say what to fix. */
export function parseBirthdate(monthText: string, dayText: string, yearText: string, today: Date = new Date()): BirthdateResult {
  const mt = monthText.trim(), dt = dayText.trim(), yt = yearText.trim();
  if (!mt || !dt || !yt) return { ok: false, error: "Enter your full birthdate." };
  if (!/^\d{1,2}$/.test(mt) || !/^\d{1,2}$/.test(dt) || !/^\d{4}$/.test(yt)) return { ok: false, error: "Use numbers: month, day and a 4-digit year." };
  const iso = toIso(Number(yt), Number(mt), Number(dt));
  if (!iso) return { ok: false, error: "That date doesn't exist. Check the month, day and year." };
  const todayIso = `${pad(today.getFullYear(), 4)}-${pad(today.getMonth() + 1, 2)}-${pad(today.getDate(), 2)}`;
  if (iso > todayIso) return { ok: false, error: "That date is in the future." };
  return { ok: true, iso, tier: ageTierOf(iso, today) as AgeTier };
}

/** Sign-up needs 13+; Money needs 18+. */
export function signUpAgeError(tier: AgeTier): string | null {
  return tier === "under_13" ? "You must be 13 or older to use Tryal." : null;
}

export const BIRTHDATE_WHY =
  "Money is for people 18 and over. Your birthdate stays private: it is never shown to anyone, and you can only set it once.";

/** Messages for the server's refusals from set_my_birthdate. */
export function birthdateServerError(message: string | undefined | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("already set")) return "Your birthdate is already saved.";
  if (m.includes("not available yet")) return "This isn't available yet. Try again later.";
  if (m.includes("invalid")) return "That date doesn't look right.";
  return "Couldn't save your birthdate. Check your connection and try again.";
}
