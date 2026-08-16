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

// POST /api/sessions { intentId, resourceId, providerId, offerId? } — create from a decision
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { intentId, resourceId, providerId, offerId } = body;
  if (!intentId || !resourceId || !providerId) return NextResponse.json({ error: "intentId, resourceId, providerId required" }, { status: 422 });
  const intent = await db.connectivityIntent.findUnique({ where: { id: intentId } });
  if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Intent not found" }, { status: 404 });
  const res = await createSessionFromDecision({ subjectId: ctx.userId, intentId, resourceId, providerId, offerId, policy: intent.policy });
  return NextResponse.json(res, { status: res.ok ? 201 : 500 });
}
