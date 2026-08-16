import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { ensureEntitlement } from "@/lib/services/session-service";
// GET entitlements for the current user
export async function GET() {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await db.entitlement.findMany({ where: { subjectId: ctx.userId }, include: { offer: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ entitlements });
}
// POST { offerId?, resourceId } — explicitly grant a TRIAL entitlement (demo convenience)
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const ent = await ensureEntitlement(ctx.userId, body.offerId ?? null, body.resourceId);
  return NextResponse.json({ entitlement: ent });
}
