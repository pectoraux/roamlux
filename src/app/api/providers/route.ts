import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
export async function GET() {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const providers = await db.provider.findMany({ where: { active: true }, include: { _count: { select: { capabilities: true, resources: true, offers: true } } } });
  return NextResponse.json({ providers });
}
