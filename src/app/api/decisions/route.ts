import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { evaluate, type CandidateInput } from "@/domain/control-plane/decision-engine";
import type { AdvertisedCapability, MeasurementSnapshot } from "@/domain/protocol";

// POST /api/decisions { intentId }
// Deterministically evaluates candidate capabilities/resources/offers against the intent
// and the current session (if any), producing a Decision with reason codes + hysteresis.
export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.intentId) return NextResponse.json({ error: "intentId required" }, { status: 422 });

  const intent = await db.connectivityIntent.findUnique({ where: { id: body.intentId } });
  if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Discover candidate capabilities matching the intent's capability type.
  // "internet" is a generic intent — matches all published connectivity types.
  const capWhere = intent.capability === "internet"
    ? { published: true }
    : { published: true, type: intent.capability };
  const capabilities = await db.capability.findMany({
    where: capWhere,
    include: {
      provider: true,
      resources: { where: { state: { in: ["available", "active"] } }, include: { offers: { where: { valid: true } } } },
    },
  });

  // The user's active entitlements (determines entitlement-validity per candidate).
  const entitlements = await db.entitlement.findMany({
    where: { subjectId: ctx.userId, active: true },
    select: { offerId: true },
  });
  const entitledOfferIds = new Set(entitlements.map((e) => e.offerId).filter(Boolean) as string[]);

  // Current active session for this intent (for SWITCH vs RETAIN).
  const currentSession = await db.connectivitySession.findFirst({
    where: { intentId: intent.id, state: "ACTIVE" },
    include: { resource: { include: { offers: { where: { valid: true } } } } },
  });

  const candidates: CandidateInput[] = [];
  for (const cap of capabilities) {
    const advertised = cap.advertised as unknown as AdvertisedCapability;
    for (const res of cap.resources) {
      const offer = res.offers[0] ?? cap.offers?.[0];
      if (!offer) continue;
      // Observed measurement if a session exists on this resource.
      let measurement: MeasurementSnapshot | undefined;
      const sess = await db.connectivitySession.findFirst({
        where: { resourceId: res.id, state: "ACTIVE" },
        include: { measurements: { orderBy: { observedAt: "desc" }, take: 1 } },
      });
      if (sess?.measurements?.[0]) {
        const m = sess.measurements[0];
        measurement = {
          latencyMs: m.latencyMs ?? undefined, downlinkMbps: m.downlinkMbps ?? undefined,
          uplinkMbps: m.uplinkMbps ?? undefined, packetLossPct: m.packetLossPct ?? undefined,
          jitterMs: m.jitterMs ?? undefined, availabilityPct: m.availabilityPct ?? undefined,
          observedAt: m.observedAt.toISOString(), source: m.source,
        };
      }
      // Entitlement validity: an existing entitlement OR trial-eligibility (MVP policy:
      // active users may receive a TRIAL-entitlement at activation — see ensureEntitlement).
      const isEntitled = entitledOfferIds.has(offer.id) || true;
      candidates.push({
        resourceId: res.id,
        providerId: cap.providerId,
        providerCode: cap.provider.code,
        providerName: cap.provider.name,
        offerId: offer.id,
        advertised,
        priceCents: offer.priceCents,
        measurement,
        available: res.state === "available" || res.state === "active",
        entitlementValid: isEntitled,
      });
    }
  }

  let currentInput: CandidateInput | undefined;
  if (currentSession) {
    const cap = capabilities.find((c) => c.id === currentSession.resource.capabilityId);
    const advertised = (cap?.advertised ?? {}) as unknown as AdvertisedCapability;
    const offer = currentSession.resource.offers[0];
    currentInput = {
      resourceId: currentSession.resourceId,
      providerId: currentSession.providerId,
      providerCode: cap?.provider.code ?? "",
      providerName: cap?.provider.name ?? "",
      offerId: offer?.id,
      advertised,
      priceCents: offer?.priceCents ?? 0,
      measurement: undefined,
      available: true,
      entitlementValid: true,
    };
  }

  const intentPayload = {
    capability: intent.capability as any,
    location: intent.location as any,
    timeWindow: intent.timeWindow as any,
    usage: intent.usage as any,
    constraints: intent.constraints as any,
    preferences: intent.preferences as any,
    policy: (intent.policy ?? undefined) as any,
  };

  const decision = evaluate({
    intent: intentPayload,
    candidates,
    currentSession: currentInput
      ? {
          sessionId: currentSession.id,
          resourceId: currentInput.resourceId,
          providerId: currentInput.providerId,
          advertised: currentInput.advertised,
          priceCents: currentInput.priceCents,
          measurement: currentInput.measurement,
        }
      : undefined,
  });

  // Persist the decision.
  const created = await db.decision.create({
    data: {
      intentId: intent.id,
      decisionType: decision.decisionType,
      fromSessionId: decision.fromSessionId,
      targetResourceId: decision.targetResourceId,
      targetProviderId: decision.targetProviderId,
      scoreCurrent: decision.scoreCurrent,
      scoreTarget: decision.scoreTarget,
      switchingCost: decision.switchingCost,
      effectiveDelta: decision.effectiveDelta,
      reasonCodes: decision.reasonCodes,
      policyMet: decision.policyMet,
      decidedBy: ctx.userId,
    },
  });

  return NextResponse.json({ decision, decisionId: created.id, candidates: decision.candidates });
}
