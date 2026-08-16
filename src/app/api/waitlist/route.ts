import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/server-auth";
// GET /api/waitlist — list waitlist entries (admin only)
export async function GET() {
  const ctx = await requirePermission("waitlist.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const entries = await db.waitlistEntry.findMany({ orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, email: true, role: true, status: true } } } });
  return NextResponse.json({ entries });
}
