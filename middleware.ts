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

const REQUEST_ID = /^[\w-]{8,64}$/;

/** Gives every API request an id (kept from a proxy if well-formed), readable by handlers and returned to the client. */
function withRequestId(request: NextRequest): NextResponse {
  const incoming = request.headers.get("x-request-id");
  const id = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", id);
  return response;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return withRequestId(request);
  }
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
  // Pages (route protection) and API routes (request ids); not Next internals or static files.
  matcher: ["/api/:path*", "/((?!api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
