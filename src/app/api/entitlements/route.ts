import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { createTrialEntitlement, verifyEntitlement } from "@/domain/entitlement/trial-policy";
// GET entitlements for the current user
export async function GET() {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await db.entitlement.findMany({ where: { subjectId: ctx.userId }, include: { offer: true }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ entitlements });
}
// POST { offerId?, resourceId } — explicitly grant a TRIAL entitlement.
// This is the explicit trial path (Entitlement Source → Entitlement → Authorization).
// The kernel never calls this; it is called by the API/commerce layer.
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  // Idempotent: if an active entitlement already exists, return it.
  const existing = await verifyEntitlement(ctx.userId, body.offerId ?? null);
  if (existing) return NextResponse.json({ entitlement: existing });
  const ent = await createTrialEntitlement(ctx.userId, body.offerId ?? null, body.resourceId ?? "");
  return NextResponse.json({ entitlement: ent });
}
