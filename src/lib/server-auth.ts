// Server-side authorization helper. Always enforced on the server.
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { can, type Permission } from "@/lib/permissions";
import { db } from "@/lib/db";
import type { Role } from "@prisma/client";

export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  isDemo: boolean;
}

export async function getContext(): Promise<AuthContext | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session.user.role) return null;
  return {
    userId: session.user.id,
    email: session.user.email ?? "",
    role: session.user.role,
    isDemo: session.user.isDemo ?? false,
  };
}

// requirePermission: returns AuthContext if authorized, else null.
// Routes construct the appropriate NextResponse themselves (App Router has no res object).
export async function requirePermission(perm: Permission): Promise<AuthContext | null> {
  const ctx = await getContext();
  if (!ctx) return null;
  if (!can(ctx.role, perm)) return null;
  return ctx;
}

// Re-fetch the user's current status from DB (defense against stale JWT).
export async function requireActiveUser(): Promise<AuthContext | null> {
  const ctx = await getContext();
  if (!ctx) return null;
  const u = await db.user.findUnique({ where: { id: ctx.userId }, select: { status: true, role: true, isDemo: true } });
  if (!u || u.status !== "ACTIVE") return null;
  return { ...ctx, role: u.role, isDemo: u.isDemo };
}
