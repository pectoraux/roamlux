import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/server-auth";
import { audit } from "@/lib/audit";
import type { Role } from "@prisma/client";
// GET /api/admin/users/:id — user detail
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission("user.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, status: true, isDemo: true, createdAt: true, updatedAt: true, disabledAt: true, disabledReason: true } });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ user });
}

// PATCH /api/admin/users/:id — change role or disable/enable
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch {}

  if (body.role !== undefined) {
    const ctx = await requirePermission("user.changerole");
    if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const validRoles: Role[] = ["PLATFORM_ADMIN", "CONSUMER", "FAMILY_ADMIN", "ENTERPRISE_ADMIN", "PROVIDER", "RESELLER", "OPERATIONS"];
    if (!validRoles.includes(body.role)) return NextResponse.json({ error: "Invalid role" }, { status: 422 });
    // Guard: never allow a demo identity to become PLATFORM_ADMIN.
    const target = await db.user.findUnique({ where: { id }, select: { isDemo: true, email: true } });
    if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (target.isDemo && body.role === "PLATFORM_ADMIN") {
      return NextResponse.json({ error: "Demo identities cannot become PLATFORM_ADMIN" }, { status: 422 });
    }
    await db.user.update({ where: { id }, data: { role: body.role } });
    await audit({ actorId: ctx.userId, action: "user.changerole", targetType: "user", targetId: id, metadata: { from: target, to: body.role } });
    return NextResponse.json({ ok: true });
  }

  if (body.status !== undefined) {
    const perm = body.status === "DISABLED" ? "user.disable" as const : "user.disable" as const;
    const ctx = await requirePermission(perm);
    if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (body.status === "DISABLED") {
      await db.user.update({ where: { id }, data: { status: "DISABLED", disabledAt: new Date(), disabledReason: body.reason ?? "disabled_by_admin" } });
      await audit({ actorId: ctx.userId, action: "user.disable", targetType: "user", targetId: id, reason: body.reason });
    } else if (body.status === "ACTIVE") {
      await db.user.update({ where: { id }, data: { status: "ACTIVE", disabledAt: null, disabledReason: null } });
      await audit({ actorId: ctx.userId, action: "user.enable", targetType: "user", targetId: id });
    }
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "No action" }, { status: 400 });
}
