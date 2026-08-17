import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/server-auth";
export async function GET() {
  const ctx = await requirePermission("audit.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const logs = await db.auditLog.findMany({ orderBy: { at: "desc" }, take: 100 });
  return NextResponse.json({ logs });
}
