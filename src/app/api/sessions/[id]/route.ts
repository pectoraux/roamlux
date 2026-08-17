import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const session = await db.connectivitySession.findUnique({
    where: { id },
    include: { resource: { include: { capability: { include: { provider: true } }, offers: true } }, transitions: { orderBy: { at: "asc" } }, measurements: { orderBy: { observedAt: "desc" }, take: 20 } },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (session.subjectId !== ctx.userId && ctx.role !== "PLATFORM_ADMIN" && ctx.role !== "OPERATIONS") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ session });
}
