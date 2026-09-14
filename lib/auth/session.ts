import { auth } from "./config";
import { requireUserId } from "./guards";

export type SessionUser = { id: string; email: string; name: string | null; image: string | null };

/** The signed-in user, or null. Authoritative: resolves the session row in the database. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return { id: user.id, email: user.email, name: user.name ?? null, image: user.image ?? null };
}

/** For Server Actions and Route Handlers: the user id, or throws `UNAUTHORIZED`. */
export async function requireSessionUserId(): Promise<string> {
  const session = await auth();
  return requireUserId(session?.user?.id);
}
