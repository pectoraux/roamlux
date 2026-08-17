// Trial Policy — explicit, auditable entitlement origin (v6).
//
// v6 FIX: createTrialEntitlement ALWAYS uses its own short isolated
// db.$transaction. It never accepts a tx parameter from the caller.
// This means the P2002 (unique violation from the partial unique index)
// is caught inside the trial's own transaction — if the trial INSERT
// fails, the trial transaction aborts and re-reads in a FRESH transaction.
// The activation transaction never has to catch a unique violation.
//
// Architecture:
//   Trial entitlement claim (separate short transaction)
//       ↓
//   winning entitlement ID
//       ↓
//   ActivationRequest transaction (reservation + session + transition)
//       ↓
//   COMMIT
//
// ARCHITECTURAL INVARIANT:
//   Identity ≠ Entitlement ≠ Payment
//   Kernel VERIFIES entitlement. It does NOT invent commercial authority.
import { db } from "@/lib/db";
import { audit, emitEvent } from "@/lib/audit";
import type { EntitlementRef, EntitlementOrigin } from "@/domain/protocol";

export interface TrialPolicyConfig {
  enabled: boolean;
  quotaDataGB: number;
  quotaSessions: number;
  note: string;
}

export const DEFAULT_TRIAL_POLICY: TrialPolicyConfig = {
  enabled: true,
  quotaDataGB: 2,
  quotaSessions: 1,
  note: "demo control-plane trial entitlement",
};

// verifyEntitlement: returns the active entitlement for subject+offer, or null.
// Uses the global db (read-only — safe outside transactions).
export async function verifyEntitlement(
  subjectId: string,
  offerId: string | null
): Promise<EntitlementRef | null> {
  if (!offerId) return null;
  const ent = await db.entitlement.findFirst({
    where: { subjectId, offerId, active: true, validUntil: null },
  });
  if (!ent) return null;
  return toRef(ent);
}

// claimTrialEntitlement: acquires a TRIAL entitlement in a SHORT, ISOLATED
// transaction. If a concurrent request already created one, the partial
// unique index (entitlement_trial_active_unique) rejects the INSERT with P2002.
// The P2002 is caught and the existing entitlement is re-read in a FRESH
// transaction — NOT in the aborted one.
//
// v6: This function NEVER accepts a tx parameter. The activation transaction
// calls this BEFORE opening its own transaction. The activation transaction
// then just reads the entitlement — no P2002 to catch inside it.
export async function claimTrialEntitlement(
  subjectId: string,
  offerId: string,
  resourceId: string,
  policy: TrialPolicyConfig = DEFAULT_TRIAL_POLICY,
): Promise<EntitlementRef> {
  if (!policy.enabled) throw new Error("Trial policy is disabled.");

  // Try to create — the partial unique index prevents duplicates.
  try {
    const ent = await db.entitlement.create({
      data: {
        subjectId, offerId, origin: "TRIAL",
        quota: { dataGB: policy.quotaDataGB, sessions: policy.quotaSessions },
        validFrom: new Date(), active: true,
        metadata: { resourceId, note: policy.note, source: "trial_policy" },
      },
    });
    await audit({ actorId: subjectId, actorType: "user", action: "entitlement.create", targetType: "entitlement", targetId: ent.id, metadata: { origin: "TRIAL", offerId, resourceId } });
    await emitEvent("EntitlementCreated", { entitlementId: ent.id, subjectId, origin: "TRIAL" }, { type: "entitlement", id: ent.id });
    return toRef(ent);
  } catch (e: any) {
    // P2002 = unique constraint violation from the partial unique index.
    // This happened in the GLOBAL db context (not inside an activation tx),
    // so there's no aborted transaction to worry about.
    if (e?.code === "P2002") {
      // Re-read in a fresh context — the winning entitlement is committed.
      const existing = await db.entitlement.findFirst({
        where: { subjectId, offerId, origin: "TRIAL", active: true },
      });
      if (existing) return toRef(existing);
    }
    throw e;
  }
}

// createTrialEntitlement: alias for claimTrialEntitlement (backward compat).
export async function createTrialEntitlement(
  subjectId: string,
  offerId: string | null,
  resourceId: string,
  policy: TrialPolicyConfig = DEFAULT_TRIAL_POLICY,
): Promise<EntitlementRef> {
  if (!offerId) throw new Error("Cannot create trial entitlement without an offerId.");
  return claimTrialEntitlement(subjectId, offerId, resourceId, policy);
}

function toRef(ent: any): EntitlementRef {
  return {
    id: ent.id, subjectId: ent.subjectId, offerId: ent.offerId ?? undefined,
    origin: ent.origin as EntitlementOrigin,
    quota: (ent.quota as any) ?? {},
    validFrom: ent.validFrom instanceof Date ? ent.validFrom.toISOString() : ent.validFrom,
    validUntil: ent.validUntil instanceof Date ? ent.validUntil.toISOString() : ent.validUntil,
    active: ent.active,
  };
}
