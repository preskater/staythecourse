import type { NextAuthConfig } from "next-auth";

/**
 * Edge-safe part of the Auth.js configuration.
 *
 * The middleware runs in the edge runtime, where neither the database client nor
 * `node:crypto` is available. This file therefore holds only what the middleware
 * needs to decide whether a request may proceed; the credentials provider and the
 * database lookups live in `src/auth.ts`.
 */
export const PUBLIC_PATHS = ["/login", "/invitation"] as const;

/** Health endpoint used by the deployment check, and the Auth.js callbacks. */
export const PUBLIC_PREFIXES = ["/api/auth"] as const;

export function isPublicPath(pathname: string): boolean {
  const matches = (prefix: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);

  return PUBLIC_PATHS.some(matches) || PUBLIC_PREFIXES.some(matches);
}

export const authConfig = {
  pages: { signIn: "/login" },
  // A signed JWT session keeps the middleware free of any database access.
  session: { strategy: "jwt" },
  // Declared in src/auth.ts.
  providers: [],
  callbacks: {
    /**
     * This is a convenience redirect for the user experience, not a security
     * boundary. Every page, Route Handler and Server Action checks the session
     * again on the server through `requireUser()`.
     */
    authorized({ auth, request }) {
      if (isPublicPath(request.nextUrl.pathname)) {
        return true;
      }
      return Boolean(auth?.user);
    },
  },
} satisfies NextAuthConfig;
