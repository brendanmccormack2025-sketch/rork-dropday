import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthUser {
  userId: string;
  email?: string;
}

export async function requireAuth(req: Request): Promise<AuthUser> {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) throw new Error("Missing Authorization header");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) throw new Error("Invalid or expired token");
    return { userId: user.id, email: user.email };
  } catch (err) {
    throw new AuthError(err instanceof Error ? err.message : "Authentication failed");
  }
}

export function createAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}
