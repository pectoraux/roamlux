// Connectivity session lifecycle service (APPLICATION layer).
//
// RELIABILITY INVARIANTS (v2 — audit fixes):
// - BOUNDED TIMEOUT (#1): adapter calls are wrapped in withTimeout(). A hanging
//   adapter never blocks the request. On timeout, operation → TIMED_OUT, session
//   stays in PROVISIONING for reconciliation to resolve.
// - COMPARE-AND-SET FENCING (#3): state mutations use compareAndSetSessionState()
//   — a conditional UPDATE WHERE generation=expectedGen. A stale operation
//   (session advanced past it) updates 0 rows and cannot mutate state.
// - LIFECYCLE-SCOPED IDENTITY (#4): the session is created FIRST, then the
//   activation operation is claimed with idempotencyKey="activate::<sessionId>".
//   After TERMINATED, a new session → new sessionId → new operation.
// - TRANSACTIONAL: state + audit + outbox commit atomically via atomic().
// - ENTITLEMENT-EXPLICIT: kernel VERIFIES entitlement; never creates it.
import { db } from "@/lib/db";
import { audit, atomic, txAudit, txEmit } from "@/lib/audit";
import { adapterForProvider } from "@/domain/adapters/registry";
import { assertSessionTransition, assertReconciliationTransition, IllegalTransitionError, type SessionState } from "@/domain/kernel/state-machines";
import { verifyEntitlement } from "@/domain/entitlement/trial-policy";
import {
  claimOrCreateOperation, completeOperation, failOperation, timeOutOperation,
  compareAndSetSessionState, withTimeout, DEFAULT_ADAPTER_TIMEOUT_MS,
} from "@/lib/services/operation-service";
import type { ActionType, MeasurementSnapshot } from "@/domain/protocol";
import type { PrismaClient } from "@prisma/client";

function idemKey(...parts: string[]) { return parts.join("::"); }

// createSessionFromDecision: full lifecycle for a SELECT decision.
// FLOW (audit issue #4 — session-first):
//   1. Verify entitlement (kernel does NOT create entitlements)
//   2. Create session (REQUESTED → PROVISIONING) — this gives us a sessionId
//   3. Claim operation with idempotencyKey="activate::<sessionId>"
//   4. Call adapter with bounded timeout (#1)
//   5. Apply result via compare-and-set fencing (#3)
export async function createSessionFromDecision(opts: {
  subjectId: string;
  intentId: string;
  resourceId: string;
  providerId: string;
  offerId?: string;
  policy?: any;
}): Promise<{ ok: boolean; sessionId?: string; state?: string; measurement?: MeasurementSnapshot; error?: string; adapterState?: string; idempotent?: boolean }> {
  const { subjectId, intentId, resourceId, providerId } = opts;

  // 1) VERIFY entitlement (precondition). Kernel does NOT create entitlements.
  const entitlement = await verifyEntitlement(subjectId, opts.offerId ?? null);
  if (!entitlement) {
    await audit({ actorId: subjectId, action: "session.activate.denied", targetType: "session", result: "failure", reason: "ENTITLEMENT_REQUIRED", metadata: { offerId: opts.offerId, resourceId } });
    return { ok: false, state: "DENIED", error: "ENTITLEMENT_REQUIRED" };
  }

  // 2) Reserve the resource (idempotent via DB-backed idempotencyKey).
  const resKey = idemKey("reserve", subjectId, intentId, resourceId);
  let reservation = await db.reservation.findUnique({ where: { idempotencyKey: resKey } });
  if (!reservation) {
    reservation = await db.reservation.create({
      data: { intentId, resourceId, entitlementId: entitlement.id, state: "RESERVED", idempotencyKey: resKey, expiresAt: new Date(Date.now() + 1000 * 60 * 30) },
    });
  }

  // 3) Create session FIRST (audit issue #4 — session-first flow).
  //    The session is created in REQUESTED, then transitioned to PROVISIONING.
  //    The activation operation's idempotencyKey is scoped to this sessionId,
  //    so a new lifecycle (new session) gets a new operation.
  const session = await atomic(async (tx) => {
    const s = await tx.connectivitySession.create({
      data: { subjectId, resourceId, providerId, reservationId: reservation!.id, intentId, state: "REQUESTED", policy: opts.policy ?? {}, generation: 1 },
    });
    await tx.sessionTransition.create({ data: { sessionId: s.id, from: "REQUESTED", to: "PROVISIONING", reason: "provisioning_start", actor: subjectId } });
    await tx.connectivitySession.update({ where: { id: s.id, generation: 1 }, data: { state: "PROVISIONING", generation: 2 } });
    await txEmit(tx, "ActionRequested", { sessionId: s.id, action: "ACTIVATE" }, { type: "session", id: s.id });
    await txAudit(tx, { actorId: subjectId, action: "session.provisioning_start", targetType: "session", targetId: s.id });
    return s;
  });

  const sessionId = session.id;
  const expectedGen = 2; // generation after the REQUESTED→PROVISIONING transition

  // 4) Claim operation — idempotencyKey scoped to sessionId (#4).
  const opKey = idemKey("activate", sessionId);
  const claim = await claimOrCreateOperation({
    idempotencyKey: opKey,
    actionType: "ACTIVATE",
    subjectId,
    resourceId,
    providerId,
    sessionId,
    operationGen: expectedGen,
    requestPayload: { intentId, resourceId, providerId, offerId: opts.offerId },
  });

  if (!claim.shouldExecute) {
    const r = claim.result!;
    if (r.status === "observed_running") return { ok: false, sessionId, state: "PROVISIONING", error: "OPERATION_RUNNING", idempotent: true };
    if (r.status === "observed_success") {
      const sess = await db.connectivitySession.findUnique({ where: { id: sessionId } });
      return { ok: true, sessionId, state: sess?.state, idempotent: true };
    }
    if (r.status === "observed_failure") return { ok: false, sessionId, state: "FAILED", error: r.error, idempotent: true };
    if (r.status === "payload_conflict") return { ok: false, sessionId, error: r.error };
  }

  // 5) Invoke adapter with BOUNDED TIMEOUT (#1).
  const adapter = await adapterForProvider(providerId);
  if (!adapter) {
    await failSessionCAS(sessionId, subjectId, expectedGen, "NO_ADAPTER");
    await failOperation({ operationId: claim.operation.id, error: "NO_ADAPTER" });
    return { ok: false, sessionId, state: "FAILED", error: "NO_ADAPTER" };
  }

  const resource = await db.resource.findUnique({ where: { id: resourceId } });
  const adapterPromise = adapter.execute("ACTIVATE", { providerResourceId: resource?.identifier ?? resourceId, idempotencyKey: opKey });
  const timed = await withTimeout(adapterPromise, DEFAULT_ADAPTER_TIMEOUT_MS);

  if (!timed.ok) {
    // TIMEOUT (#1): operation → TIMED_OUT, session stays in PROVISIONING.
    // Reconciliation will later discover whether the provider actually activated.
    await timeOutOperation({ operationId: claim.operation.id });
    await audit({ actorId: subjectId, action: "session.activate.timeout", targetType: "session", targetId: sessionId, result: "failure", reason: "ADAPTER_TIMEOUT", metadata: { operationId: claim.operation.id } });
    return { ok: false, sessionId, state: "PROVISIONING", error: "ADAPTER_TIMEOUT" };
  }

  const result = timed.value;
  if (!result.ok) {
    // Adapter failure (e.g. FAIL_AFTER_SIDE_EFFECT — provider activated but returned failure).
    // Session → FAILED. Reconciliation can later repair via FAILED→ACTIVE (#2).
    await failSessionCAS(sessionId, subjectId, expectedGen, result.error ?? "ADAPTER_FAILURE");
    await failOperation({ operationId: claim.operation.id, error: result.error ?? "ADAPTER_FAILURE" });
    return { ok: false, sessionId, state: "FAILED", error: result.error, adapterState: result.state };
  }

  // 6) Apply result via COMPARE-AND-SET fencing (#3).
  const cas = await compareAndSetSessionState({
    sessionId, expectedGen, newState: "ACTIVE",
    extraData: { startedAt: new Date() },
  });
  if (!cas.applied) {
    // Stale: another operation advanced the generation. Log but do NOT apply.
    await audit({ actorId: subjectId, action: "session.activate.stale", targetType: "session", targetId: sessionId, reason: "CAS_FENCING_REJECTED", metadata: { operationId: claim.operation.id, expectedGen } });
    await completeOperation({ operationId: claim.operation.id, response: result });
    return { ok: false, sessionId, state: "STALE", error: "CAS_FENCING_REJECTED" };
  }

  // CAS succeeded — record the transition, measurement, and events transactionally.
  await atomic(async (tx) => {
    await tx.sessionTransition.create({ data: { sessionId, from: "PROVISIONING", to: "ACTIVE", reason: "activated", actor: subjectId } });
    await tx.reservation.update({ where: { id: reservation!.id }, data: { state: "ACTIVE" } });
    await tx.resource.update({ where: { id: resourceId }, data: { state: "active" } });
    if (result.measurement) {
      await tx.measurement.create({ data: { sessionId, latencyMs: result.measurement.latencyMs, downlinkMbps: result.measurement.downlinkMbps, uplinkMbps: result.measurement.uplinkMbps, packetLossPct: result.measurement.packetLossPct, jitterMs: result.measurement.jitterMs, availabilityPct: result.measurement.availabilityPct, source: result.measurement.source } });
      await tx.connectivitySession.update({ where: { id: sessionId }, data: { currentQuality: result.measurement as any } });
    }
    await txEmit(tx, "SessionStarted", { sessionId, subjectId, providerId, resourceId }, { type: "session", id: sessionId });
    await txEmit(tx, "ActionCompleted", { sessionId, from: "PROVISIONING", to: "ACTIVE", reason: "activated" }, { type: "session", id: sessionId });
    await txAudit(tx, { actorId: subjectId, action: "session.activate", targetType: "session", targetId: sessionId, metadata: { providerId, resourceId, intentId, entitlementId: entitlement.id } });
  });

  await completeOperation({ operationId: claim.operation.id, response: result });
  return { ok: true, sessionId, state: "ACTIVE", measurement: result.measurement };
}

// executeAction: generic action on a session (DEACTIVATE, MEASURE, SUSPEND, RESUME, RELEASE).
// HORIZONTAL ISOLATION + IDEMPOTENCY + COMPARE-AND-SET FENCING.
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

  const adapterPromise = adapter.execute(opts.action, { providerResourceId: session.resource.identifier, idempotencyKey: opKey });
  const timed = await withTimeout(adapterPromise, DEFAULT_ADAPTER_TIMEOUT_MS);
  if (!timed.ok) {
    await timeOutOperation({ operationId: claim.operation.id });
    return { ok: false, error: "ADAPTER_TIMEOUT", idempotent: false };
  }
  const result = timed.value;
  if (!result.ok) {
    await failOperation({ operationId: claim.operation.id, error: result.error ?? "ADAPTER_FAILURE" });
    return { ok: false, error: result.error, state: result.state };
  }

  // Apply via COMPARE-AND-SET fencing (#3).
  const cur = session.state as SessionState;
  let newState: string | null = null;
  let extraData: any = {};
  try {
    if (opts.action === "DEACTIVATE" || opts.action === "RELEASE") {
      if (canGo(cur, "TERMINATED")) { newState = "TERMINATED"; extraData = { endedAt: new Date() }; }
    } else if (opts.action === "SUSPEND" && canGo(cur, "SUSPENDED")) {
      newState = "SUSPENDED";
    } else if (opts.action === "RESUME" && canGo(cur, "ACTIVE")) {
      newState = "ACTIVE";
    } else if (opts.action === "MEASURE" && result.measurement) {
      // MEASURE doesn't change state, just records measurement.
      await db.measurement.create({ data: { sessionId: opts.sessionId, latencyMs: result.measurement.latencyMs, downlinkMbps: result.measurement.downlinkMbps, uplinkMbps: result.measurement.uplinkMbps, packetLossPct: result.measurement.packetLossPct, jitterMs: result.measurement.jitterMs, availabilityPct: result.measurement.availabilityPct, source: result.measurement.source } });
      await db.connectivitySession.update({ where: { id: opts.sessionId }, data: { currentQuality: result.measurement as any } });
    }
  } catch (e: any) {
    if (e instanceof IllegalTransitionError) {
      await audit({ actorId: opts.subjectId, action: "session.action.illegal", targetType: "session", targetId: opts.sessionId, result: "failure", reason: e.message });
    } else throw e;
  }

  if (newState) {
    const cas = await compareAndSetSessionState({ sessionId: opts.sessionId, expectedGen, newState, extraData });
    if (cas.applied) {
      await atomic(async (tx) => {
        await tx.sessionTransition.create({ data: { sessionId: opts.sessionId, from: cur, to: newState!, reason: opts.action, actor: opts.subjectId } });
        if (newState === "TERMINATED") {
          await tx.reservation.updateMany({ where: { id: session.reservationId ?? undefined }, data: { state: "RELEASED" } });
          await txEmit(tx, "SessionTerminated", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        } else if (newState === "SUSPENDED") {
          await txEmit(tx, "SessionSuspended", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        } else if (newState === "ACTIVE") {
          await txEmit(tx, "SessionResumed", { sessionId: opts.sessionId }, { type: "session", id: opts.sessionId });
        }
        await txAudit(tx, { actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}`, targetType: "session", targetId: opts.sessionId });
      });
    } else {
      await audit({ actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}.stale`, targetType: "session", targetId: opts.sessionId, reason: "CAS_FENCING_REJECTED" });
    }
  }

  await completeOperation({ operationId: claim.operation.id, response: result });
  return { ok: result.ok, state: result.state, measurement: result.measurement, error: result.error };
}

function canGo(from: SessionState, to: SessionState): boolean {
  try { assertSessionTransition(from, to); return true; } catch { return false; }
}

// failSessionCAS: transitions session to FAILED via compare-and-set.
async function failSessionCAS(sessionId: string, actor: string, expectedGen: number, reason: string) {
  const cas = await compareAndSetSessionState({ sessionId, expectedGen, newState: "FAILED", extraData: { failureReason: reason } });
  if (cas.applied) {
    await atomic(async (tx) => {
      await tx.sessionTransition.create({ data: { sessionId, from: "PROVISIONING", to: "FAILED", reason, actor } });
      await txEmit(tx, "ProvisioningFailed", { sessionId, reason }, { type: "session", id: sessionId });
      await txAudit(tx, { actorId: actor, action: "session.fail", targetType: "session", targetId: sessionId, result: "failure", reason });
    });
  }
}
