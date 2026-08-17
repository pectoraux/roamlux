// Connectivity session lifecycle service (APPLICATION layer) — v3.
//
// RELIABILITY INVARIANTS (v3 — audit fixes):
// - ATOMIC CAS (#1 v3): state mutation + transition + audit + outbox in ONE
//   transaction via atomicCompareAndSet(). No crash window between CAS and
//   the transition/audit/outbox writes.
// - API-LEVEL IDEMPOTENCY (#2 v3): ActivationRequest ties a client command
//   key to exactly one session. Duplicate POST /sessions observes the original.
// - BOUNDED TIMEOUT + CANCELLATION (#4 v3): withTimeoutAndAbort() passes an
//   AbortSignal to the adapter. On timeout, the signal is aborted (adapters
//   that support cancellation can stop). The request is never blocked.
// - ENTITLEMENT-EXPLICIT: kernel VERIFIES entitlement; never creates it.
import { db } from "@/lib/db";
import { audit, txAudit, txEmit } from "@/lib/audit";
import { adapterForProvider } from "@/domain/adapters/registry";
import { assertSessionTransition, IllegalTransitionError, type SessionState } from "@/domain/kernel/state-machines";
import { verifyEntitlement, claimTrialEntitlement, DEFAULT_TRIAL_POLICY } from "@/domain/entitlement/trial-policy";
import {
  claimOrCreateOperation, completeOperation, failOperation, timeOutOperation,
  atomicCompareAndSet, withTimeoutAndAbort, DEFAULT_ADAPTER_TIMEOUT_MS,
} from "@/lib/services/operation-service";
import { claimActivation, completeActivation, markActivationFailed, type TransactionClient } from "@/lib/services/activation-request-service";
import type { ActionType, MeasurementSnapshot } from "@/domain/protocol";

function idemKey(...parts: string[]) { return parts.join("::"); }

// createSessionFromDecision: full lifecycle for a SELECT decision.
// v8 FLOW (two-phase, no nested transactions):
//
//   Phase 1 — command acceptance (claimActivation)
//     Creates ActivationRequest(status=CLAIMED) or observes existing.
//     Conflicts are rejected HERE — before any commercial side effect.
//
//   Phase 2 — entitlement acquisition (isolated)
//     claimTrialEntitlement() in its own short transaction.
//     No nested transaction — happens BETWEEN phases.
//
//   Phase 3 — provisioning transaction (completeActivation)
//     Creates reservation + session + transition + links ActivationRequest.
//     All in ONE transaction. No callbacks that open nested transactions.
//
//   Then: adapter activation (bounded timeout + AbortSignal + atomicCompareAndSet)
//
// INVARIANT: Command acceptance → Entitlement authority → Provisioning.
// No nested transactions. A failed Phase 3 marks the request FAILED.
export async function createSessionFromDecision(opts: {
  subjectId: string;
  intentId: string;
  resourceId: string;
  providerId: string;
  offerId?: string;
  policy?: any;
  requestKey?: string;
}): Promise<{ ok: boolean; sessionId?: string; state?: string; measurement?: MeasurementSnapshot; error?: string; adapterState?: string; idempotent?: boolean }> {
  const { subjectId, intentId, resourceId, providerId } = opts;
  const requestKey = opts.requestKey ?? idemKey("actreq", subjectId, intentId, resourceId);

  // Phase 1: CLAIM ACTIVATION (command acceptance — no entitlement, no session).
  const claim = await claimActivation({
    requestKey, subjectId, intentId, resourceId, providerId, offerId: opts.offerId,
  });

  if (claim.status === "observed_existing") {
    const sess = await db.connectivitySession.findUnique({ where: { id: claim.sessionId } });
    return { ok: true, sessionId: sess?.id, state: sess?.state, idempotent: true };
  }
  if (claim.status === "conflict") {
    return { ok: false, error: `ACTIVATION_CONFLICT: field=${claim.field} expected=${claim.expected} actual=${claim.actual}` };
  }
  if (claim.status === "in_progress" || (claim as any).status === "observed_claimed") {
    return { ok: false, state: "PROVISIONING", error: "ACTIVATION_IN_PROGRESS", idempotent: true };
  }
  if (claim.status === "failed") {
    return { ok: false, error: "ACTIVATION_PREVIOUSLY_FAILED" };
  }
  if (claim.status !== "claimed") {
    return { ok: false, error: "ACTIVATION_CLAIM_FAILED" };
  }

  const claimToken = claim.claimToken;

  // Phase 2: ENTITLEMENT ACQUISITION (isolated, between phases — no nested tx).
  let entitlementId: string | null = null;
  try {
    if (opts.offerId && DEFAULT_TRIAL_POLICY.enabled) {
      const existing = await verifyEntitlement(subjectId, opts.offerId);
      if (existing) {
        entitlementId = existing.id;
      } else {
        const trial = await claimTrialEntitlement(subjectId, opts.offerId, resourceId);
        entitlementId = trial.id;
      }
    } else {
      const existing = await verifyEntitlement(subjectId, opts.offerId ?? null);
      if (!existing) {
        await markActivationFailed(requestKey, claimToken);
        await audit({ actorId: subjectId, action: "session.activate.denied", targetType: "session", result: "failure", reason: "ENTITLEMENT_REQUIRED", metadata: { offerId: opts.offerId, resourceId } });
        return { ok: false, state: "DENIED", error: "ENTITLEMENT_REQUIRED" };
      }
      entitlementId = existing.id;
    }
  } catch (e: any) {
    await markActivationFailed(requestKey, claimToken);
    throw e;
  }

  // Phase 3: PROVISIONING TRANSACTION (reservation + session + transition + link).
  // No nested transactions — createSession only uses tx.
  // Passes claimToken so completeActivation can verify ownership.
  let sessionId: string;
  try {
    const result = await completeActivation({
      requestKey,
      claimToken,
      createSession: async (tx: TransactionClient) => {
        const entitlement = await tx.entitlement.findUnique({ where: { id: entitlementId } });
        if (!entitlement || !entitlement.active) throw new Error("ENTITLEMENT_REQUIRED");

        const resKey = idemKey("reserve", subjectId, intentId, resourceId);
        let reservation = await tx.reservation.findUnique({ where: { idempotencyKey: resKey } });
        if (!reservation) {
          reservation = await tx.reservation.create({
            data: { intentId, resourceId, entitlementId: entitlement.id, state: "RESERVED", idempotencyKey: resKey, expiresAt: new Date(Date.now() + 1000 * 60 * 30) },
          });
        }
        const s = await tx.connectivitySession.create({
          data: { subjectId, resourceId, providerId, reservationId: reservation.id, intentId, state: "PROVISIONING", policy: opts.policy ?? {}, generation: 2 },
        });
        await tx.sessionTransition.create({ data: { sessionId: s.id, from: "REQUESTED", to: "PROVISIONING", reason: "provisioning_start", actor: subjectId } });
        return s.id;
      },
    });
    sessionId = result.sessionId;
  } catch (e: any) {
    await markActivationFailed(requestKey, claimToken);
    throw e;
  }

  // The session is created and linked. Proceed with adapter activation.
  const expectedGen = 2;

  // Claim operation (idempotencyKey scoped to sessionId).
  const opKey = idemKey("activate", sessionId);
  const opClaim = await claimOrCreateOperation({
    idempotencyKey: opKey, actionType: "ACTIVATE", subjectId, resourceId, providerId,
    sessionId, operationGen: expectedGen,
    requestPayload: { intentId, resourceId, providerId, offerId: opts.offerId },
  });

  if (!opClaim.shouldExecute) {
    const r = opClaim.result!;
    if (r.status === "observed_running") return { ok: false, sessionId, state: "PROVISIONING", error: "OPERATION_RUNNING", idempotent: true };
    if (r.status === "observed_success") return { ok: true, sessionId, idempotent: true };
    if (r.status === "observed_failure") return { ok: false, sessionId, state: "FAILED", error: r.error, idempotent: true };
    if (r.status === "payload_conflict") return { ok: false, sessionId, error: r.error };
  }

  // 4) Invoke adapter with BOUNDED TIMEOUT + ABORT SIGNAL.
  const adapter = await adapterForProvider(providerId);
  if (!adapter) {
    await failSessionAtomic(sessionId, subjectId, expectedGen, "NO_ADAPTER");
    await failOperation({ operationId: opClaim.operation.id, error: "NO_ADAPTER" });
    await markActivationFailed(requestKey, claimToken);
    return { ok: false, sessionId, state: "FAILED", error: "NO_ADAPTER" };
  }

  const resource = await db.resource.findUnique({ where: { id: resourceId } });
  const timed = await withTimeoutAndAbort(
    (signal, deadline) => adapter.execute("ACTIVATE", {
      providerResourceId: resource?.identifier ?? resourceId,
      idempotencyKey: opKey,
      signal,
      deadline,
    }),
    DEFAULT_ADAPTER_TIMEOUT_MS
  );

  if (!timed.ok) {
    await timeOutOperation({ operationId: opClaim.operation.id });
    await audit({ actorId: subjectId, action: "session.activate.timeout", targetType: "session", targetId: sessionId, result: "failure", reason: "ADAPTER_TIMEOUT", metadata: { operationId: opClaim.operation.id } });
    return { ok: false, sessionId, state: "PROVISIONING", error: "ADAPTER_TIMEOUT" };
  }

  const result = timed.value;
  if (!result.ok) {
    await failSessionAtomic(sessionId, subjectId, expectedGen, result.error ?? "ADAPTER_FAILURE");
    await failOperation({ operationId: opClaim.operation.id, error: result.error ?? "ADAPTER_FAILURE" });
    await markActivationFailed(requestKey, claimToken);
    return { ok: false, sessionId, state: "FAILED", error: result.error, adapterState: result.state };
  }

  // 5) ATOMIC CAS: state + transition + audit + outbox in ONE transaction.
  const entitlement = await verifyEntitlement(subjectId, opts.offerId ?? null);
  const cas = await atomicCompareAndSet(
    { sessionId, expectedGen, newState: "ACTIVE", fromState: "PROVISIONING", reason: "activated", actor: subjectId, extraData: { startedAt: new Date() } },
    async (tx) => {
      const resKey = idemKey("reserve", subjectId, intentId, resourceId);
      const reservation = await tx.reservation.findUnique({ where: { idempotencyKey: resKey } });
      if (reservation) {
        await tx.reservation.update({ where: { id: reservation.id }, data: { state: "ACTIVE" } });
      }
      await tx.resource.update({ where: { id: resourceId }, data: { state: "active" } });
      if (result.measurement) {
        await tx.measurement.create({ data: { sessionId, latencyMs: result.measurement.latencyMs, downlinkMbps: result.measurement.downlinkMbps, uplinkMbps: result.measurement.uplinkMbps, packetLossPct: result.measurement.packetLossPct, jitterMs: result.measurement.jitterMs, availabilityPct: result.measurement.availabilityPct, source: result.measurement.source } });
        await tx.connectivitySession.update({ where: { id: sessionId }, data: { currentQuality: result.measurement as any } });
      }
      await txEmit(tx, "SessionStarted", { sessionId, subjectId, providerId, resourceId }, { type: "session", id: sessionId });
      await txEmit(tx, "ActionCompleted", { sessionId, from: "PROVISIONING", to: "ACTIVE", reason: "activated" }, { type: "session", id: sessionId });
      await txAudit(tx, { actorId: subjectId, action: "session.activate", targetType: "session", targetId: sessionId, metadata: { providerId, resourceId, intentId, entitlementId: entitlement?.id } });
    }
  );

  if (!cas.applied) {
    await audit({ actorId: subjectId, action: "session.activate.stale", targetType: "session", targetId: sessionId, reason: "CAS_FENCING_REJECTED", metadata: { operationId: opClaim.operation.id, expectedGen } });
    await completeOperation({ operationId: opClaim.operation.id, response: result });
    return { ok: false, sessionId, state: "STALE", error: "CAS_FENCING_REJECTED" };
  }

  await completeOperation({ operationId: opClaim.operation.id, response: result });
  return { ok: true, sessionId, state: "ACTIVE", measurement: result.measurement };
}

// executeAction: generic action on a session (DEACTIVATE, MEASURE, SUSPEND, RESUME, RELEASE).
export async function executeAction(opts: {
  sessionId: string;
  action: ActionType;
  subjectId: string;
  role?: string;
}): Promise<{ ok: boolean; state?: string; measurement?: MeasurementSnapshot; error?: string; idempotent?: boolean }> {
  const session = await db.connectivitySession.findUnique({ where: { id: opts.sessionId }, include: { resource: true, reservation: true } });
  if (!session) return { ok: false, error: "NOT_FOUND" };

  const isOwner = session.subjectId === opts.subjectId;
  const isAdmin = opts.role === "PLATFORM_ADMIN" || opts.role === "OPERATIONS";
  if (!isOwner && !isAdmin) {
    await audit({ actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}.denied`, targetType: "session", targetId: session.id, result: "failure", reason: "NOT_OWNER", metadata: { ownerSubjectId: session.subjectId } });
    return { ok: false, error: "FORBIDDEN" };
  }

  const adapter = await adapterForProvider(session.providerId);
  if (!adapter) return { ok: false, error: "NO_ADAPTER" };
  if (!adapter.descriptor.supportedActions.includes(opts.action)) return { ok: false, error: "ACTION_NOT_SUPPORTED" };

  const expectedGen = session.generation;
  const opKey = idemKey(opts.action.toLowerCase(), opts.sessionId);
  const claim = await claimOrCreateOperation({
    idempotencyKey: opKey, actionType: opts.action, subjectId: opts.subjectId,
    resourceId: session.resourceId, providerId: session.providerId, sessionId: opts.sessionId,
    operationGen: expectedGen, requestPayload: { action: opts.action },
  });

  if (!claim.shouldExecute) {
    const r = claim.result!;
    if (r.status === "observed_running") return { ok: false, error: "OPERATION_RUNNING", idempotent: true };
    if (r.status === "observed_success") return { ok: true, state: r.response?.state, measurement: r.response?.measurement, idempotent: true };
    if (r.status === "observed_failure") return { ok: false, error: r.error, idempotent: true };
    if (r.status === "payload_conflict") return { ok: false, error: r.error };
  }

  const timed = await withTimeoutAndAbort(
    (signal, deadline) => adapter.execute(opts.action, { providerResourceId: session.resource.identifier, idempotencyKey: opKey, signal, deadline }),
    DEFAULT_ADAPTER_TIMEOUT_MS
  );
  if (!timed.ok) {
    await timeOutOperation({ operationId: claim.operation.id });
    return { ok: false, error: "ADAPTER_TIMEOUT", idempotent: false };
  }
  const result = timed.value;
  if (!result.ok) {
    await failOperation({ operationId: claim.operation.id, error: result.error ?? "ADAPTER_FAILURE" });
    return { ok: false, error: result.error, state: result.state };
  }

  const cur = session.state as SessionState;
  let newState: string | null = null;
  let extraData: any = {};
  try {
    if (opts.action === "DEACTIVATE" || opts.action === "RELEASE") {
      if (canGo(cur, "TERMINATED")) { newState = "TERMINATED"; extraData = { endedAt: new Date() }; }
    } else if (opts.action === "SUSPEND" && canGo(cur, "SUSPENDED")) { newState = "SUSPENDED"; }
    else if (opts.action === "RESUME" && canGo(cur, "ACTIVE")) { newState = "ACTIVE"; }
    else if (opts.action === "MEASURE" && result.measurement) {
      await db.measurement.create({ data: { sessionId: opts.sessionId, latencyMs: result.measurement.latencyMs, downlinkMbps: result.measurement.downlinkMbps, uplinkMbps: result.measurement.uplinkMbps, packetLossPct: result.measurement.packetLossPct, jitterMs: result.measurement.jitterMs, availabilityPct: result.measurement.availabilityPct, source: result.measurement.source } });
      await db.connectivitySession.update({ where: { id: opts.sessionId }, data: { currentQuality: result.measurement as any } });
    }
  } catch (e: any) {
    if (e instanceof IllegalTransitionError) {
      await audit({ actorId: opts.subjectId, action: "session.action.illegal", targetType: "session", targetId: opts.sessionId, result: "failure", reason: e.message });
    } else throw e;
  }

  if (newState) {
    // ATOMIC CAS: state + transition + audit + outbox in ONE tx (v3 #1).
    const cas = await atomicCompareAndSet(
      { sessionId: opts.sessionId, expectedGen, newState, fromState: cur, reason: opts.action, actor: opts.subjectId, extraData },
      async (tx) => {
        if (newState === "TERMINATED") {
          await tx.reservation.updateMany({ where: { id: session.reservationId ?? undefined }, data: { state: "RELEASED" } });
          await txEmit(tx, "SessionTerminated", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        } else if (newState === "SUSPENDED") {
          await txEmit(tx, "SessionSuspended", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        } else if (newState === "ACTIVE") {
          await txEmit(tx, "SessionResumed", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        }
        await txAudit(tx, { actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}`, targetType: "session", targetId: opts.sessionId });
      }
    );
    if (!cas.applied) {
      await audit({ actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}.stale`, targetType: "session", targetId: opts.sessionId, reason: "CAS_FENCING_REJECTED" });
    }
  }

  await completeOperation({ operationId: claim.operation.id, response: result });
  return { ok: result.ok, state: result.state, measurement: result.measurement, error: result.error };
}

function canGo(from: SessionState, to: SessionState): boolean {
  try { assertSessionTransition(from, to); return true; } catch { return false; }
}

// failSessionAtomic: transitions session to FAILED via atomic CAS (v3 #1).
async function failSessionAtomic(sessionId: string, actor: string, expectedGen: number, reason: string) {
  const cas = await atomicCompareAndSet(
    { sessionId, expectedGen, newState: "FAILED", fromState: "PROVISIONING", reason, actor, extraData: { failureReason: reason } },
    async (tx) => {
      await txEmit(tx, "ProvisioningFailed", { sessionId, reason }, { type: "session", id: sessionId });
      await txAudit(tx, { actorId: actor, action: "session.fail", targetType: "session", targetId: sessionId, result: "failure", reason });
    }
  );
  return cas.applied;
}
