import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
export async function GET(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const where = sessionId ? { sessionId } : {};
  // Restrict to sessions owned by the user (unless operations/admin).
  const owned = ctx.role === "OPERATIONS" || ctx.role === "PLATFORM_ADMIN" ? {} : { session: { subjectId: ctx.userId } };
  const measurements = await db.measurement.findMany({ where: { ...where, ...owned }, orderBy: { observedAt: "desc" }, take: 100 });
  return NextResponse.json({ measurements });
}
