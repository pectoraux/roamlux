import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const intent = await db.connectivityIntent.findUnique({ where: { id }, include: { sessions: true, decisions: { orderBy: { createdAt: "desc" } } } });
  if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ intent });
}
