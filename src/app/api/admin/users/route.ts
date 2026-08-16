import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/server-auth";
// GET /api/admin/users — list users (admin/operations)
export async function GET() {
  const ctx = await requirePermission("user.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const users = await db.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, name: true, role: true, status: true, isDemo: true, createdAt: true, disabledAt: true },
  });
  return NextResponse.json({ users });
}
