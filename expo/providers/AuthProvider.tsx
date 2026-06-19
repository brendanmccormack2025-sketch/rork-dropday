import createContextHook from "@nkzw/create-context-hook";
import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { supabase, SUPABASE_READY } from "@/lib/supabase";

/**
 * Ensures a profile row exists for the given user. Safe to call multiple times —
 * it checks for an existing profile first and handles duplicate-key errors gracefully.
 * Exported so createPost and other mutations can self-heal when a profile is missing.
 */
export async function ensureProfile(user: User, displayNameOverride?: string) {
  console.log("[auth:ensureProfile] checking profile for", user.id.slice(0, 12));
  const { data: existing, error: selErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (selErr) {
    console.warn("[auth] ensureProfile select error", selErr.message, selErr);
  }
  if (existing) {
    console.log("[auth:ensureProfile] profile already exists, skipping insert");
    return;
  }
  console.log("[auth:ensureProfile] no profile found, creating one");
  const metaUsername = (user.user_metadata?.username as string | undefined)?.trim();
  const fallback = `dropper_${user.id.slice(0, 8)}`;
  const username = metaUsername && metaUsername.length > 0 ? metaUsername : fallback;
  const display_name = displayNameOverride?.trim() || username;
  console.log("[auth:ensureProfile] inserting", { username, display_name });
  const { error: insErr } = await supabase
    .from("profiles")
    .insert({ id: user.id, username, display_name });
  if (insErr && insErr.code !== "23505") {
    console.warn("[auth] ensureProfile insert error", insErr.message);
  } else if (insErr) {
    console.log("[auth:ensureProfile] duplicate key (23505) — profile already exists");
  } else {
    console.log("[auth:ensureProfile] profile created successfully");
  }
}

/**
 * Lightweight version that only needs a user ID (no full User object).
 * Used by createPost for self-healing when the full User object isn't available.
 */
export async function ensureProfileById(userId: string) {
  console.log("[auth:ensureProfileById] checking profile for", userId.slice(0, 12));
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (existing) {
    console.log("[auth:ensureProfileById] profile already exists");
    return;
  }
  const fallback = `dropper_${userId.slice(0, 8)}`;
  console.log("[auth:ensureProfileById] creating profile with fallback username", fallback);
  const { error: insErr } = await supabase
    .from("profiles")
    .insert({ id: userId, username: fallback, display_name: fallback });
  if (insErr && insErr.code !== "23505") {
    console.warn("[auth] ensureProfileById insert error", insErr.message, insErr);
  } else {
    console.log("[auth:ensureProfileById] profile created or already exists");
  }
}

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  ready: boolean;
};

export const [AuthProvider, useAuth] = createContextHook(() => {
  const [state, setState] = useState<AuthState>({
    session: null,
    user: null,
    loading: true,
    ready: SUPABASE_READY,
  });
  const inFlight = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!SUPABASE_READY) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    let mounted = true;
    console.log("[auth:init] getSession starting");
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        console.log("[auth:init] getSession result", {
          hasSession: !!data.session,
          userId: data.session?.user?.id?.slice(0, 12),
          email: data.session?.user?.email,
        });
        setState({
          session: data.session,
          user: data.session?.user ?? null,
          loading: false,
          ready: true,
        });
      })
      .catch((err) => {
        console.warn("[auth] getSession failed", err?.message ?? err);
        if (!mounted) return;
        setState((s) => ({ ...s, loading: false }));
      });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("[auth:event]", event, {
        hasSession: !!session,
        userId: session?.user?.id?.slice(0, 12),
        email: session?.user?.email,
        now: new Date().toISOString(),
      });
      setState((prev) => ({
        ...prev,
        session,
        user: session?.user ?? null,
        loading: false,
      }));
      // Call ensureProfile on ANY event that provides a user, not just SIGNED_IN.
      // INITIAL_SESSION fires when the session is restored from AsyncStorage (app
      // restart / refresh) and SIGNED_IN won't fire again, so without this the
      // profile is never created and posts fail with FK violations.
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") {
        if (session?.user) {
          console.log("[auth:event]", event, "— calling ensureProfile");
          ensureProfile(session.user).catch((err) => {
            console.warn("[auth] ensureProfile failed", err?.message ?? err);
          });
        }
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      if (inFlight.current.signIn) return;
      inFlight.current.signIn = true;
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (error) throw error;
      } finally {
        inFlight.current.signIn = false;
      }
    },
    []
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string, username: string) => {
      if (inFlight.current.signUp) {
        console.log("[auth] signUp already in flight, ignoring duplicate");
        return;
      }
      inFlight.current.signUp = true;
      try {
        console.log("[auth] signUp ->", email.trim().toLowerCase());
        const { error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: { username: username.trim() },
          },
        });
        if (error) throw error;
        // Profile row is created by ensureProfile() on the auth state change
        // event (SIGNED_IN, INITIAL_SESSION, or TOKEN_REFRESHED).
        // If email confirmation is enabled, no session is returned here —
        // ensureProfile() will run when the session becomes active.
      } finally {
        inFlight.current.signUp = false;
      }
    },
    []
  );

  const signInWithApple = useCallback(async () => {
    if (Platform.OS !== "ios") {
      throw new Error("Apple Sign-In is only available on iOS.");
    }
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) {
      throw new Error("Apple sign-in failed: no identity token.");
    }
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
    });
    if (error) throw error;
    if (data.user) {
      const fullName =
        [credential.fullName?.givenName, credential.fullName?.familyName]
          .filter(Boolean)
          .join(" ") || undefined;
      await ensureProfile(data.user, fullName);
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const redirectTo = Linking.createURL("/auth/callback");
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });
    if (error) throw error;
    if (!data?.url) throw new Error("No OAuth URL returned.");
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== "success" || !result.url) {
      throw new Error("Google sign-in cancelled.");
    }
    const url = new URL(result.url);
    const params = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.search
    );
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (!access_token || !refresh_token) {
      const code = params.get("code");
      if (code) {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(
          code
        );
        if (exErr) throw exErr;
        return;
      }
      throw new Error("Google sign-in: missing tokens.");
    }
    const { error: setErr } = await supabase.auth.setSession({
      access_token,
      refresh_token,
    });
    if (setErr) throw setErr;
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return useMemo(
    () => ({
      ...state,
      signInWithEmail,
      signUpWithEmail,
      signInWithApple,
      signInWithGoogle,
      signOut,
    }),
    [state, signInWithEmail, signUpWithEmail, signInWithApple, signInWithGoogle, signOut]
  );
});
