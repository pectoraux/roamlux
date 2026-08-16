import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
// GET /api/capabilities?intentId=... — discover published capabilities (and matching resources/offers).
export async function GET(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const intentId = searchParams.get("intentId");
  let intent: any = null;
  if (intentId) {
    intent = await db.connectivityIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const where = { published: true, ...((intent && intent.capability !== "internet") ? { type: intent.capability } : {}) };
  const capabilities = await db.capability.findMany({
    where,
    include: {
      provider: true,
      resources: { where: { state: "available" } },
      offers: { where: { valid: true } },
    },
    orderBy: { validFrom: "desc" },
  });
  return NextResponse.json({ capabilities });
}
