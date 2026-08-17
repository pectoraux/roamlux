import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { createSessionFromDecision } from "@/lib/services/session-service";

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

// POST /api/sessions { intentId, resourceId, providerId, offerId?, requestKey? }
// v5: The trial entitlement is created INSIDE the activation transaction (not
// in the API route). The kernel verifies entitlement; if none exists, the
// createSession callback (inside the tx) creates a trial via TrialPolicy.
// This makes the trial grant atomic with the session creation.
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { intentId, resourceId, providerId, offerId, requestKey } = body;
  if (!intentId || !resourceId || !providerId) return NextResponse.json({ error: "intentId, resourceId, providerId required" }, { status: 422 });
  const intent = await db.connectivityIntent.findUnique({ where: { id: intentId } });
  if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Intent not found" }, { status: 404 });

  // v5: pass requestKey for API-level idempotency. The trial entitlement
  // is created INSIDE the activation transaction (in the createSession callback).
  const derivedKey = requestKey ?? `actreq::${ctx.userId}::${intentId}::${resourceId}`;
  try {
    const res = await createSessionFromDecision({ subjectId: ctx.userId, intentId, resourceId, providerId, offerId, policy: intent.policy, requestKey: derivedKey });
    return NextResponse.json(res, { status: res.ok ? 201 : 500 });
  } catch (e: any) {
    if (e?.message === "ENTITLEMENT_REQUIRED") {
      return NextResponse.json({ ok: false, error: "ENTITLEMENT_REQUIRED" }, { status: 403 });
    }
    throw e;
  }
}
