import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

const FALLBACK_SUPABASE_URL = "https://tfdjymogbtfavdzgfqas.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRmZGp5bW9nYnRmYXZkemdmcWFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxNjQ1NTEsImV4cCI6MjA5NTc0MDU1MX0.aBDG-nTpiw8B_i0HPmfGuwk9OIeultAjngQrX9EHCmk";

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_URL.length > 0
    ? process.env.EXPO_PUBLIC_SUPABASE_URL
    : FALLBACK_SUPABASE_URL;
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY.length > 0
    ? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
    : FALLBACK_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[supabase] Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY env vars."
  );
}

export { supabaseUrl, supabaseAnonKey };

// Until migration-profile-links.sql is run, profiles has no youtube_url column and
// selects that name it fail. Retry such GETs once without the column.
const fetchWithoutMissingYoutube: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 400 || (init?.method && init.method !== "GET")) return res;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("youtube_url")) return res;
  const body = await res.clone().text().catch(() => "");
  if (!body.includes("youtube_url")) return res;
  const retryUrl = url.replace(/(%2C|,)?youtube_url(%2C|,)?/, (_m, a, b) => (a && b ? a : ""));
  return fetch(retryUrl, init);
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: fetchWithoutMissingYoutube },
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
  },
});

export const SUPABASE_READY = Boolean(supabaseUrl && supabaseAnonKey);
