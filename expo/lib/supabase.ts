import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

const FALLBACK_SUPABASE_URL = "https://abucipwkiifhzinpiiao.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFidWNpcHdraWlmaHppbnBpaWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzAzODYsImV4cCI6MjA5NTAwNjM4Nn0.JNdaRgSptdNrY9gbmw6akewLescEF6snkuE8SQG8sos";

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

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
  },
});

export const SUPABASE_READY = Boolean(supabaseUrl && supabaseAnonKey);
