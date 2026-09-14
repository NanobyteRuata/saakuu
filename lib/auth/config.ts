import { randomUUID } from "node:crypto";

import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { CredentialsSignin } from "next-auth";
import { encode as encodeJwt } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";

import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";

import { decideGoogleSignIn } from "./linking";
import { verifyPassword } from "./password";
import { signInSchema } from "./schemas";

/**
 * Auth.js configuration (docs/01 §4).
 *
 * Sessions are database-backed with a 30-day rolling expiry. Auth.js always issues a JWT for
 * Credentials sign-ins, so `jwt.encode` is overridden to create a Session row instead and
 * return its token as the cookie value. With `strategy: "database"`, every later request
 * resolves that cookie through the adapter, exactly like an OAuth session.
 *
 * Note: the Credentials + database combination is only accepted by Auth.js while a
 * non-credentials provider is registered, so Google is always in the provider list; the UI
 * hides its button when it is not configured.
 */

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Signed-in password matched, but the email has not been verified yet. */
class EmailUnverifiedError extends CredentialsSignin {
  override code = "email_unverified";
}

const adapter = PrismaAdapter(prisma);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter,
  session: { strategy: "database", maxAge: SESSION_MAX_AGE_SECONDS, updateAge: 24 * 60 * 60 },
  pages: { signIn: "/sign-in", error: "/sign-in" },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID ?? "google-not-configured",
      clientSecret: process.env.AUTH_GOOGLE_SECRET ?? "google-not-configured",
      // Safe only together with the signIn callback below, which requires both sides verified.
      allowDangerousEmailAccountLinking: true,
      profile(profile) {
        return { id: profile.sub, name: profile.name, email: profile.email.toLowerCase(), image: profile.picture };
      },
    }),
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(raw) {
        const parsed = signInSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, image: true, emailVerified: true, passwordHash: true },
        });
        if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
          return null;
        }
        if (!user.emailVerified) {
          throw new EmailUnverifiedError();
        }
        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider !== "google") return true;

      const email = typeof profile?.email === "string" ? profile.email.toLowerCase() : null;
      if (!email) return false;
      const existingUser = await prisma.user.findUnique({ where: { email }, select: { emailVerified: true } });
      const decision = decideGoogleSignIn({ googleEmailVerified: profile?.email_verified === true, existingUser });
      if (decision.kind === "allow") return true;

      log.info("google sign-in blocked", { reason: decision.reason });
      return `/sign-in?error=${decision.reason}`;
    },
    jwt({ token, account }) {
      if (account?.provider === "credentials") {
        token.credentials = true;
      }
      return token;
    },
    session({ session, user }) {
      return { ...session, user: { ...session.user, id: user.id } };
    },
  },
  jwt: {
    async encode(params) {
      if (params.token?.credentials) {
        const userId = params.token.sub;
        if (!userId) throw new Error("credentials sign-in produced a token without a user id");
        const sessionToken = randomUUID();
        await prisma.session.create({
          data: { sessionToken, userId, expires: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000) },
        });
        return sessionToken;
      }
      return encodeJwt(params);
    },
  },
  events: {
    async linkAccount({ user, account }) {
      // Auth.js creates OAuth users with emailVerified = null. The signIn callback has already
      // required Google to report the address as verified, so record that.
      if (account.provider === "google" && user.id) {
        await prisma.user.updateMany({ where: { id: user.id, emailVerified: null }, data: { emailVerified: new Date() } });
      }
    },
  },
});

export function isGoogleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}
