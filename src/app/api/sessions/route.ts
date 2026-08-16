import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { createSessionFromDecision } from "@/lib/services/session-service";
import { createTrialEntitlement, verifyEntitlement, DEFAULT_TRIAL_POLICY } from "@/domain/entitlement/trial-policy";

// GET /api/sessions — list current user's sessions
export async function GET() {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sessions = await db.connectivitySession.findMany({
    where: ctx.role === "PLATFORM_ADMIN" || ctx.role === "OPERATIONS" ? {} : { subjectId: ctx.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { resource: { include: { capability: { include: { provider: true } } } }, measurements: { orderBy: { observedAt: "desc" }, take: 1 } },
  });
  return NextResponse.json({ sessions });
}

// POST /api/sessions { intentId, resourceId, providerId, offerId? } — create from a decision
// The kernel VERIFIES entitlement. If none exists, the API route EXPLICITLY grants
// a trial entitlement via TrialPolicy (a commerce/entitlement decision, NOT a kernel one)
// before calling the kernel's activation path.
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { intentId, resourceId, providerId, offerId } = body;
  if (!intentId || !resourceId || !providerId) return NextResponse.json({ error: "intentId, resourceId, providerId required" }, { status: 422 });
  const intent = await db.connectivityIntent.findUnique({ where: { id: intentId } });
  if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Intent not found" }, { status: 404 });

  // EXPLICIT trial entitlement grant (application/commerce layer, not kernel).
  // If the user has no entitlement for this offer, grant a trial via TrialPolicy.
  // This is audited and visible — not a silent kernel assumption.
  if (offerId) {
    const existing = await verifyEntitlement(ctx.userId, offerId);
    if (!existing && DEFAULT_TRIAL_POLICY.enabled) {
      await createTrialEntitlement(ctx.userId, offerId, resourceId);
    }
  }

  const res = await createSessionFromDecision({ subjectId: ctx.userId, intentId, resourceId, providerId, offerId, policy: intent.policy });
  return NextResponse.json(res, { status: res.ok ? 201 : 500 });
}
