import createContextHook from "@nkzw/create-context-hook";
import type { Session, User } from "@supabase/supabase-js";
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Platform } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
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
  const { data: existing, error: selErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (selErr) {
    console.warn("[auth] ensureProfile select error", selErr.message, selErr);
  }
  if (existing) {
    return;
  }
  const metaUsername = (user.user_metadata?.username as string | undefined)?.trim();
  const fallback = `dropper_${user.id.slice(0, 8)}`;
  const username = metaUsername && metaUsername.length > 0 ? metaUsername : fallback;
  const display_name = displayNameOverride?.trim() || username;
  const { error: insErr } = await supabase
    .from("profiles")
    .insert({ id: user.id, username, display_name });
  if (insErr && insErr.code !== "23505") {
    console.warn("[auth] ensureProfile insert error", insErr.message);
  }
}

/**
 * Lightweight version that only needs a user ID (no full User object).
 * Used by createPost for self-healing when the full User object isn't available.
 */
export async function ensureProfileById(userId: string) {
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  if (existing) {
    return;
  }
  const fallback = `dropper_${userId.slice(0, 8)}`;
  const { error: insErr } = await supabase
    .from("profiles")
    .insert({ id: userId, username: fallback, display_name: fallback });
  if (insErr && insErr.code !== "23505") {
    console.warn("[auth] ensureProfileById insert error", insErr.message, insErr);
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

  // TEMP DEBUG — render-body log (fires on every render, survives HMR)
  console.log("[auth:render]", {
    userId: state.user?.id ?? null,
    hasSession: !!state.session,
    loading: state.loading,
  });
  const inFlight = useRef<Record<string, boolean>>({});
  const queryClient = useQueryClient();

  useEffect(() => {
    console.log("[auth] effect running, SUPABASE_READY=", SUPABASE_READY);
    if (!SUPABASE_READY) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    let mounted = true;
    console.log("[auth] calling getSession()...");
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        console.log("[auth] getSession resolved — session=", data.session ? "present" : "null", "user=", data.session?.user?.id ?? "null", "error=", error?.message ?? "none");
        if (!mounted) return;
        setState({
          session: data.session,
          user: data.session?.user ?? null,
          loading: false,
          ready: true,
        });
      })
      .catch(async (err) => {
        console.warn("[auth] getSession failed", err?.message ?? err);
        // Stale/expired refresh token — clear session storage to stop
        // the Supabase client from retrying the failed token refresh.
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch (_) {
          // signOut may also fail if storage is corrupted; that's fine
        }
        if (!mounted) return;
        setState((s) => ({ ...s, loading: false }));
      });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      console.log("[auth] onAuthStateChange event=", event, "session=", session ? "present" : "null", "user=", session?.user?.id ?? "null");
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
    async (
      email: string,
      password: string,
      username: string,
      birthdate?: string,
      agreedToTerms?: boolean,
    ) => {
      if (inFlight.current.signUp) {
        return;
      }
      inFlight.current.signUp = true;
      try {
        const normalizedEmail = email.trim().toLowerCase();
        const { data, error: signUpErr } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: {
              username: username.trim(),
              birthdate: birthdate ?? undefined,
              terms_accepted_at: agreedToTerms
                ? new Date().toISOString()
                : undefined,
            },
          },
        });
        if (signUpErr) throw signUpErr;
        // Persist birthdate to the profile row. The handle_new_user DB
        // trigger creates the profile from raw_user_meta_data, but it
        // doesn't currently copy birthdate — so we upsert it here as a
        // belt-and-braces step. This runs AFTER the auth user exists,
        // so for under-13 users we abort BEFORE this point (the caller
        // gates on age before invoking this function).
        const uid = data.user?.id;
        if (uid && (birthdate || agreedToTerms)) {
          const update: Record<string, unknown> = {};
          if (birthdate) update.birthdate = birthdate;
          if (agreedToTerms) update.terms_accepted_at = new Date().toISOString();
          try {
            await supabase.from("profiles").update(update).eq("id", uid);
          } catch (e) {
            console.warn("[auth] profile update failed", (e as Error)?.message);
          }
        }
        if (data.session) {
          return;
        }
        // No session returned — sign in explicitly so the user lands in
        // the app immediately. This handles the case where email
        // confirmation is disabled but signUp still doesn't return a
        // session (observed in some Supabase project configurations).
        const { error: signInErr } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (signInErr) throw signInErr;
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
    queryClient.clear();
  }, [queryClient]);

  const deleteAccount = useCallback(async (): Promise<void> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) throw new Error("Not signed in.");

    const supabaseUrl =
      process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_URL.length > 0
        ? process.env.EXPO_PUBLIC_SUPABASE_URL
        : "https://tfdjymogbtfavdzgfqas.supabase.co";

    const res = await fetch(`${supabaseUrl}/functions/v1/delete-user`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || "Failed to delete account.");
    }

    // Sign out locally and clear all cached queries.
    await supabase.auth.signOut();
    queryClient.clear();
  }, [queryClient]);

  return useMemo(
    () => ({
      ...state,
      signInWithEmail,
      signUpWithEmail,
      signInWithApple,
      signInWithGoogle,
      signOut,
      deleteAccount,
    }),
    [state, signInWithEmail, signUpWithEmail, signInWithApple, signInWithGoogle, signOut, deleteAccount]
  );
});
