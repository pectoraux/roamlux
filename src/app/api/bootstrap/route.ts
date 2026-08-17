import { NextResponse } from "next/server";
import { bootstrap } from "@/lib/bootstrap";
import { requirePermission } from "@/lib/server-auth";
import { audit } from "@/lib/audit";

// POST /api/bootstrap — idempotent seed. Requires platform.bootstrap permission.
// On a fresh database the FIRST bootstrap is allowed without auth (first-run),
// detected by absence of any PLATFORM_ADMIN user.
import { db } from "@/lib/db";

export async function POST() {
  const adminCount = await db.user.count({ where: { role: "PLATFORM_ADMIN" } });
  let ctx = null;
  if (adminCount > 0) {
    ctx = await requirePermission("platform.bootstrap");
    if (!ctx) {
      return NextResponse.json({ error: "Forbidden: bootstrap requires platform.bootstrap" }, { status: 403 });
    }
  }
  const result = await bootstrap();
  await audit({
    actorId: ctx?.userId ?? "system",
    action: "platform.bootstrap",
    targetType: "platform",
    result: "success",
    metadata: result,
  });
  return NextResponse.json({ ok: true, ...result });
}
