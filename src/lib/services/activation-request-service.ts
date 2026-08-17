// Activation Request service — two-phase lifecycle with lease recovery (v9).
//
// v9 FIX: CLAIMED requests now have a lease with an expiry. If the holder
// crashes between phases, the lease expires and another caller can reclaim
// the request via compare-and-set. This prevents permanent tombstones.
//
// Phases (unchanged from v8, but with lease recovery):
//   Phase 1 — claimActivation: creates ActivationRequest(CLAIMED + lease)
//     If the requestKey already exists:
//       - CREATED → observe existing session
//       - CLAIMED + lease valid → return IN_PROGRESS (don't steal)
//       - CLAIMED + lease expired → RECLAIM via CAS, continue
//       - FAILED → return FAILED
//       - payload/subject mismatch → CONFLICT
//   Phase 2 — entitlement acquisition (isolated, by the caller)
//   Phase 3 — completeActivation: creates session, links, sets CREATED
//
// LEASE SEMANTICS:
//   - claimToken: random UUID per claim attempt (identifies the holder)
//   - claimExpiresAt: NOW + LEASE_MS (default 60s)
//   - Reclaim: UPDATE ... WHERE status='CLAIMED' AND claimExpiresAt < NOW()
//     If 0 rows updated, another caller holds a valid lease.
//
// INVARIANTS:
//   1. ONE requestKey = ONE ActivationRequest = ONE Session = ONE Operation
//   2. No permanent tombstones — expired CLAIMED requests are reclaimable
//   3. Two concurrent reclaimers → exactly one wins (CAS)
//   4. No nested transactions
import { db } from "@/lib/db";
import { createHash, randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export const LEASE_MS = 60_000; // 60 seconds — a crashed process's lease expires after this

export type ClaimResult =
  | { status: "claimed"; requestKey: string; claimToken: string }
  | { status: "observed_existing"; sessionId: string; requestKey: string }
  | { status: "in_progress"; requestKey: string }
  | { status: "failed"; requestKey: string }
  | { status: "conflict"; requestKey: string; field: string; expected: string; actual: string };

function payloadHash(opts: { subjectId: string; intentId: string; resourceId: string; providerId: string; offerId?: string }): string {
  const payload = JSON.stringify({
    subjectId: opts.subjectId, intentId: opts.intentId, resourceId: opts.resourceId,
    providerId: opts.providerId, offerId: opts.offerId ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// Phase 1: claimActivation — establishes command validity with a lease.
export async function claimActivation(opts: {
  requestKey: string;
  subjectId: string;
  intentId: string;
  resourceId: string;
  providerId: string;
  offerId?: string;
}): Promise<ClaimResult> {
  const hash = payloadHash(opts);
  const claimToken = randomUUID();
  const claimExpiresAt = new Date(Date.now() + LEASE_MS);

  // Try to INSERT a new ActivationRequest (status=CLAIMED + lease).
  try {
    await db.activationRequest.create({
      data: {
        requestKey: opts.requestKey,
        subjectId: opts.subjectId,
        intentId: opts.intentId,
        resourceId: opts.resourceId,
        providerId: opts.providerId,
        offerId: opts.offerId ?? null,
        sessionId: null,
        status: "CLAIMED",
        payloadHash: hash,
        claimToken,
        claimExpiresAt,
      },
    });
    return { status: "claimed", requestKey: opts.requestKey, claimToken };
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }

  // requestKey already exists — re-read and decide.
  const existing = await db.activationRequest.findUnique({ where: { requestKey: opts.requestKey } });
  if (!existing) {
    // Edge case: the row was deleted between our P2002 and re-read.
    // Retry the insert.
    try {
      await db.activationRequest.create({
        data: {
          requestKey: opts.requestKey, subjectId: opts.subjectId, intentId: opts.intentId,
          resourceId: opts.resourceId, providerId: opts.providerId, offerId: opts.offerId ?? null,
          sessionId: null, status: "CLAIMED", payloadHash: hash, claimToken, claimExpiresAt,
        },
      });
      return { status: "claimed", requestKey: opts.requestKey, claimToken };
    } catch { return { status: "in_progress", requestKey: opts.requestKey }; }
  }

  // OWNERSHIP CHECK
  if (existing.subjectId !== opts.subjectId) {
    return { status: "conflict", requestKey: opts.requestKey, field: "subjectId", expected: opts.subjectId, actual: existing.subjectId };
  }
  // PAYLOAD EQUIVALENCE
  if (existing.payloadHash !== hash) {
    const field = existing.intentId !== opts.intentId ? "intentId"
      : existing.resourceId !== opts.resourceId ? "resourceId"
      : existing.providerId !== opts.providerId ? "providerId"
      : existing.offerId !== (opts.offerId ?? null) ? "offerId" : "payload";
    return { status: "conflict", requestKey: opts.requestKey, field, expected: String((opts as any)[field] ?? opts.offerId ?? ""), actual: String((existing as any)[field] ?? existing.offerId ?? "") };
  }

  // Same payload — observe the existing lifecycle state.
  if (existing.status === "CREATED" && existing.sessionId) {
    return { status: "observed_existing", sessionId: existing.sessionId, requestKey: opts.requestKey };
  }
  if (existing.status === "FAILED") {
    return { status: "failed", requestKey: opts.requestKey };
  }

  // Status is CLAIMED — check the lease.
  const now = new Date();
  const leaseExpired = !existing.claimExpiresAt || existing.claimExpiresAt < now;

  if (!leaseExpired) {
    // Lease is still valid — another caller is in Phase 2/3.
    return { status: "in_progress", requestKey: opts.requestKey };
  }

  // LEASE EXPIRED — RECLAIM via compare-and-set.
  // Only one caller can win this CAS.
  const reclaimResult = await db.activationRequest.updateMany({
    where: {
      requestKey: opts.requestKey,
      status: "CLAIMED",
      claimExpiresAt: { lt: now },
    },
    data: {
      claimToken,
      claimExpiresAt,
    },
  });

  if (reclaimResult.count === 0) {
    // Another caller reclaimed first — they're in Phase 2/3 now.
    return { status: "in_progress", requestKey: opts.requestKey };
  }

  // We won the reclaim — proceed with this requestKey.
  return { status: "claimed", requestKey: opts.requestKey, claimToken };
}

// Phase 3: completeActivation — creates the session in a final transaction.
// v10 FIX: The final status update is a compare-and-set that fences on
// claimToken AND claimExpiresAt > NOW(). A stale holder whose lease was
// reclaimed (or merely expired) cannot complete.
//
// The CAS is:
//   UPDATE ActivationRequest
//   SET status='CREATED', sessionId=?, claimToken=NULL, claimExpiresAt=NULL
//   WHERE requestKey=? AND status='CLAIMED' AND claimToken=? AND claimExpiresAt > NOW()
//
// If affectedRows == 0, the claim was lost (reclaimed or expired).
// The entire transaction rolls back — no session, no reservation.
export async function completeActivation(opts: {
  requestKey: string;
  claimToken: string;
  createSession: (tx: Tx) => Promise<string>;
}): Promise<{ sessionId: string }> {
  const sessionId = await db.$transaction(async (tx) => {
    // Pre-check: verify we still hold the claim (fast-fail before doing work).
    const ar = await tx.activationRequest.findUnique({ where: { requestKey: opts.requestKey } });
    if (!ar || ar.status !== "CLAIMED" || ar.claimToken !== opts.claimToken) {
      throw new Error("ACTIVATION_CLAIM_LOST");
    }
    // Also check the lease hasn't expired (even if nobody reclaimed yet).
    if (ar.claimExpiresAt && ar.claimExpiresAt < new Date()) {
      throw new Error("ACTIVATION_LEASE_EXPIRED");
    }

    // Call createSession — ALL writes use tx (no nested transactions).
    const sid = await opts.createSession(tx);

    // FENCED COMPLETION: compare-and-set on claimToken + claimExpiresAt.
    // This is the critical v10 fix — the final write itself is fenced,
    // not just the earlier read. If another caller reclaimed between our
    // read and this write, the CAS fails (0 rows) and we roll back.
    const casResult = await tx.activationRequest.updateMany({
      where: {
        requestKey: opts.requestKey,
        status: "CLAIMED",
        claimToken: opts.claimToken,
        claimExpiresAt: { gt: new Date() }, // lease must still be valid
      },
      data: {
        sessionId: sid,
        status: "CREATED",
        claimToken: null,
        claimExpiresAt: null,
      },
    });

    if (casResult.count === 0) {
      // Our claim was lost (reclaimed or expired) between the read and the write.
      // The transaction will roll back — no session, no reservation.
      throw new Error("ACTIVATION_CLAIM_LOST");
    }

    return sid;
  }, { timeout: 15000 });
  return { sessionId };
}

// markActivationFailed: marks the request FAILED (terminal).
// Only succeeds if we still hold the claim.
export async function markActivationFailed(requestKey: string, claimToken?: string): Promise<void> {
  const where: any = { requestKey, status: "CLAIMED" };
  if (claimToken) where.claimToken = claimToken;
  await db.activationRequest.updateMany({
    where,
    data: { status: "FAILED", claimToken: null, claimExpiresAt: null },
  }).catch(() => {});
}

export async function getActivation(requestKey: string) {
  return db.activationRequest.findUnique({ where: { requestKey } });
}

// Backward-compatible wrapper: combines claimActivation + completeActivation.
// Used by tests that don't need to test the two-phase split.
export async function claimOrCreateActivation(opts: {
  requestKey: string;
  subjectId: string;
  intentId: string;
  resourceId: string;
  providerId: string;
  offerId?: string;
  createSession: (tx: Tx) => Promise<string>;
}): Promise<
  | { status: "created"; sessionId: string; requestKey: string }
  | { status: "observed_existing"; sessionId: string; requestKey: string }
  | { status: "in_progress"; requestKey: string }
  | { status: "failed"; requestKey: string }
  | { status: "conflict"; requestKey: string; field: string; expected: string; actual: string }
  | { status: "observed_claimed"; requestKey: string }
> {
  const claim = await claimActivation(opts);
  if (claim.status !== "claimed") {
    // Map "in_progress" to "observed_claimed" for backward compat with old tests.
    if (claim.status === "in_progress") return { status: "observed_claimed" as any, requestKey: opts.requestKey };
    return claim;
  }
  try {
    const result = await completeActivation({
      requestKey: opts.requestKey,
      claimToken: claim.claimToken,
      createSession: opts.createSession,
    });
    return { status: "created", sessionId: result.sessionId, requestKey: opts.requestKey };
  } catch (e: any) {
    await markActivationFailed(opts.requestKey, claim.claimToken);
    throw e;
  }
}

export type { Tx as TransactionClient };
