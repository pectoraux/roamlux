// NextAuth.js v4 — Credentials provider with role-aware JWT sessions.
// Authentication is separate from authorization (see permissions.ts).
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import type { Role } from "@/domain/protocol";

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/" },
  providers: [
    CredentialsProvider({
      name: "RoamLink",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = (credentials?.email ?? "").trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        const user = await db.user.findUnique({
          where: { email },
          select: {
            id: true, email: true, name: true, passwordHash: true,
            role: true, status: true, isDemo: true,
          },
        });

        // Prevent enumeration: do not reveal whether the email exists.
        // Always run a compare against a dummy hash to equalize timing.
        const DUMMY = "$2a$12$000000000000000000000000000000000000000000000000000000";
        const ok = user
          ? await verifyPassword(password, user.passwordHash || DUMMY)
          : await verifyPassword(password, DUMMY);

        if (!user || !ok) return null;

        // Waitlisted users have no account → cannot authenticate. Disabled too.
        if (user.status !== "ACTIVE") return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? user.email,
          role: user.role as Role,
          status: user.status,
          isDemo: user.isDemo,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as any;
        token.id = u.id;
        token.role = u.role;
        token.status = u.status;
        token.isDemo = u.isDemo;
      }
      // Re-validate the user is still active on each token use (defense in depth).
      if (token.id) {
        const fresh = await db.user.findUnique({
          where: { id: token.id as string },
          select: { status: true, role: true, isDemo: true },
        });
        if (!fresh || fresh.status !== "ACTIVE") {
          // Force logout by clearing identifying claims.
          token.id = undefined;
          token.email = undefined;
          token.role = undefined;
          token.status = "DISABLED";
          token.isDemo = false;
        } else {
          token.role = fresh.role;
          token.isDemo = fresh.isDemo;
          token.status = fresh.status;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).status = token.status;
        (session.user as any).isDemo = token.isDemo;
      }
      return session;
    },
  },
};

// Augment NextAuth types for role/status/isDemo on session.
declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      role?: import("@prisma/client").Role;
      status?: string;
      isDemo?: boolean;
    };
  }
}
declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: import("@prisma/client").Role;
    status?: string;
    isDemo?: boolean;
  }
}
