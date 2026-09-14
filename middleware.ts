import { NextResponse, type NextRequest } from "next/server";

import { isAuthPath } from "@/lib/auth/redirect";

/**
 * Optimistic route protection (Edge). Only checks that a session cookie is present; the
 * `(app)` layout resolves the session against the database and is the authoritative check.
 *
 * Signed-in users are deliberately NOT redirected away from auth pages here: a stale cookie
 * (e.g. after a password reset deleted the session) would otherwise loop between the two.
 */

const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/" || isAuthPath(pathname)) {
    return NextResponse.next();
  }
  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSessionCookie) {
    return NextResponse.next();
  }
  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
