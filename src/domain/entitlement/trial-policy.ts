// Trial Policy — explicit, auditable entitlement origin.
//
// ARCHITECTURAL INVARIANT:
//   Identity ≠ Entitlement ≠ Payment
//   Entitlement Source → Entitlement → Authorization to consume → ACTIVATE_RESOURCE
//
// The kernel VERIFIES entitlement. It does NOT invent commercial authority.
// Trial access is allowed but MUST be explicit: it goes through this service,
// which creates an audited Entitlement with origin=TRIAL before activation.
//
// The kernel's activation path calls verifyEntitlement() — it never creates
// entitlements itself. If no entitlement exists, ACTIVATE is DENIED.

import { db } from "@/lib/db";
import { audit, emitEvent } from "@/lib/audit";
import type { EntitlementRef, EntitlementOrigin } from "@/domain/protocol";

// ── Trial Policy Configuration ──────────────────────────────────────────────
// Explicit, visible, auditable. Not a hidden assumption in the kernel.
export interface TrialPolicyConfig {
  enabled: boolean;
  quotaDataGB: number;
  quotaSessions: number;
  note: string;
}

// The demo/dev trial policy. In production this would come from a Policy table
// or environment configuration, not be hardcoded in the domain.
export const DEFAULT_TRIAL_POLICY: TrialPolicyConfig = {
  enabled: true,
  quotaDataGB: 2,
  quotaSessions: 1,
  note: "demo control-plane trial entitlement",
};

// ── Entitlement Verification (used by the kernel) ───────────────────────────
// Returns the active entitlement for a subject+offer, or null if none.
// The kernel calls this; it NEVER creates entitlements.
export async function verifyEntitlement(
  subjectId: string,
  offerId: string | null
): Promise<EntitlementRef | null> {
  if (!offerId) return null;
  const ent = await db.entitlement.findFirst({
    where: { subjectId, offerId, active: true, validUntil: null },
  });
  if (!ent) return null;
  return {
    id: ent.id,
    subjectId: ent.subjectId,
    offerId: ent.offerId ?? undefined,
    origin: ent.origin as EntitlementOrigin,
    quota: (ent.quota as any) ?? {},
    validFrom: ent.validFrom.toISOString(),
    validUntil: ent.validUntil?.toISOString(),
    active: ent.active,
  };
}

// ── Explicit Trial Entitlement Creation ─────────────────────────────────────
// This is a COMMERCE/ENTITLEMENT service, NOT part of the kernel.
// It must be called BEFORE activation (e.g. by the entitlements API route or
// a commerce flow), never inside the kernel's activation path.
export async function createTrialEntitlement(
  subjectId: string,
  offerId: string | null,
  resourceId: string,
  policy: TrialPolicyConfig = DEFAULT_TRIAL_POLICY
): Promise<EntitlementRef> {
  if (!policy.enabled) {
    throw new Error("Trial policy is disabled; no entitlement can be created.");
  }
  // Idempotent: if an active trial entitlement already exists for this subject+offer, reuse it.
  if (offerId) {
    const existing = await verifyEntitlement(subjectId, offerId);
    if (existing) return existing;
  }
  const ent = await db.entitlement.create({
    data: {
      subjectId,
      offerId,
      origin: "TRIAL",
      quota: { dataGB: policy.quotaDataGB, sessions: policy.quotaSessions },
      validFrom: new Date(),
      active: true,
      metadata: { resourceId, note: policy.note, source: "trial_policy" },
    },
  });
  await audit({
    actorId: subjectId,
    actorType: "user",
    action: "entitlement.create",
    targetType: "entitlement",
    targetId: ent.id,
    metadata: { origin: "TRIAL", offerId, resourceId, policy: policy.note },
  });
  await emitEvent("EntitlementCreated", { entitlementId: ent.id, subjectId, origin: "TRIAL" });
  return {
    id: ent.id,
    subjectId: ent.subjectId,
    offerId: ent.offerId ?? undefined,
    origin: "TRIAL",
    quota: { dataGB: policy.quotaDataGB, sessions: policy.quotaSessions },
    validFrom: ent.validFrom.toISOString(),
    active: ent.active,
  };
}
