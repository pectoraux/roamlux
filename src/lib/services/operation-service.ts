// Operation service — durable, idempotent externally-visible actions.
//
// IDEMPOTENCY SEMANTICS:
//   - First request: creates Operation(RUNNING), executes.
//   - Duplicate while RUNNING: returns observed_running (no re-execution).
//   - Duplicate after SUCCESS: returns stored response (no re-execution).
//   - Duplicate after FAILURE/TIMED_OUT: returns stored error.
//   - Same key + different payload: REJECTED.
//   - Timeout: operation → TIMED_OUT; reconciliation resolves the provider state later.
//   - Late success after timeout: fencing (compare-and-set) prevents stale application.
//
// FENCING (compare-and-set, audit issue #3):
//   Each operation captures operationGen = session.generation at creation.
//   State mutations use a conditional UPDATE:
//     UPDATE session SET state=..., generation=generation+1
//     WHERE id=sessionId AND generation=operationGen
//   If the generation changed (another operation advanced it), the update
//   affects 0 rows — the operation is stale and its result is NOT applied.
//   This is a true compare-and-set, not "read then update".
//
// LIFECYCLE IDENTITY (audit issue #4):
//   The idempotencyKey is scoped to the SESSION (e.g. "activate::<sessionId>"),
//   not to (subjectId, intentId, resourceId). After a session is TERMINATED,
//   a new session gets a new sessionId → a new operation. Retries within the
//   same session hit the same operation.
import { db } from "@/lib/db";
import { randomUUID } from "crypto";

export type OperationResult =
  | { status: "executed"; operation: any; response: any }
  | { status: "observed_running"; operation: any }
  | { status: "observed_success"; operation: any; response: any }
  | { status: "observed_failure"; operation: any; error: string }
  | { status: "payload_conflict"; operation: any; error: string };

// claimOrCreateOperation: atomically claims or creates an operation.
export async function claimOrCreateOperation(opts: {
  idempotencyKey: string;
  actionType: string;
  subjectId: string;
  resourceId?: string;
  providerId?: string;
  sessionId?: string;
  operationGen?: number;
  requestPayload?: any;
}): Promise<{ operation: any; shouldExecute: boolean; result?: OperationResult }> {
  const existing = await db.operation.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });

  if (existing) {
    const existingPayload = JSON.stringify(existing.requestPayload);
    const newPayload = JSON.stringify(opts.requestPayload ?? {});
    if (existingPayload !== newPayload && existing.requestPayload !== null) {
      return { operation: existing, shouldExecute: false, result: { status: "payload_conflict", operation: existing, error: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" } };
    }
    if (existing.state === "PENDING" || existing.state === "RUNNING") {
      return { operation: existing, shouldExecute: false, result: { status: "observed_running", operation: existing } };
    }
    if (existing.state === "SUCCEEDED") {
      return { operation: existing, shouldExecute: false, result: { status: "observed_success", operation: existing, response: existing.responsePayload } };
    }
    if (existing.state === "FAILED" || existing.state === "TIMED_OUT") {
      return { operation: existing, shouldExecute: false, result: { status: "observed_failure", operation: existing, error: existing.error ?? "UNKNOWN" } };
    }
  }

  try {
    const op = await db.operation.create({
      data: {
        idempotencyKey: opts.idempotencyKey,
        actionType: opts.actionType,
        subjectId: opts.subjectId,
        resourceId: opts.resourceId,
        providerId: opts.providerId,
        sessionId: opts.sessionId,
        operationGen: opts.operationGen ?? 1,
        state: "RUNNING",
        startedAt: new Date(),
        requestPayload: (opts.requestPayload ?? {}) as any,
      },
    });
    return { operation: op, shouldExecute: true };
  } catch (e: any) {
    const raced = await db.operation.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
    if (raced && (raced.state === "PENDING" || raced.state === "RUNNING")) {
      return { operation: raced, shouldExecute: false, result: { status: "observed_running", operation: raced } };
    }
    throw e;
  }
}

// completeOperation: marks SUCCEEDED. Does NOT apply state — the caller applies
// state via compareAndSetSessionState (true CAS fencing).
export async function completeOperation(opts: { operationId: string; response: any }): Promise<void> {
  await db.operation.update({
    where: { id: opts.operationId },
    data: { state: "SUCCEEDED", responsePayload: opts.response as any, completedAt: new Date() },
  });
}

// failOperation: marks FAILED.
export async function failOperation(opts: { operationId: string; error: string }): Promise<void> {
  await db.operation.update({
    where: { id: opts.operationId },
    data: { state: "FAILED", error: opts.error, completedAt: new Date() },
  });
}

// timeOutOperation: marks TIMED_OUT. The operation is NOT failed — reconciliation
// may later discover the provider actually succeeded (late success).
export async function timeOutOperation(opts: { operationId: string }): Promise<void> {
  await db.operation.update({
    where: { id: opts.operationId },
    data: { state: "TIMED_OUT", error: "ADAPTER_TIMEOUT", completedAt: new Date() },
  });
}

// COMPARE-AND-SET fencing (non-transactional, for simple cases).
// For atomic CAS + transition + audit + outbox, use atomicCompareAndSet instead.
export async function compareAndSetSessionState(opts: {
  sessionId: string;
  expectedGen: number;
  newState: string;
  extraData?: any;
}): Promise<{ applied: boolean }> {
  const result = await db.connectivitySession.updateMany({
    where: { id: opts.sessionId, generation: opts.expectedGen },
    data: {
      state: opts.newState as any,
      generation: { increment: 1 },
      ...(opts.extraData ?? {}),
    },
  });
  return { applied: result.count > 0 };
}

// ATOMIC COMPARE-AND-SET (audit issue #1 v3):
// CAS + transition history + audit + outbox event in ONE transaction.
// This is the true all-or-nothing fencing: if the CAS succeeds, the transition/
// audit/outbox are guaranteed to commit with it. If the CAS fails (stale),
// nothing is written.
//
// The `fn` callback receives the transaction client and is called ONLY if the
// CAS succeeds. It writes the transition, audit, outbox, measurement, etc.
export async function atomicCompareAndSet(
  opts: {
    sessionId: string;
    expectedGen: number;
    newState: string;
    fromState: string;
    reason: string;
    actor: string;
    extraData?: any;
  },
  fn: (tx: any) => Promise<void>
): Promise<{ applied: boolean }> {
  return db.$transaction(async (tx) => {
    // CAS: conditional UPDATE. If 0 rows, the generation changed → stale.
    const result = await tx.connectivitySession.updateMany({
      where: { id: opts.sessionId, generation: opts.expectedGen },
      data: {
        state: opts.newState as any,
        generation: { increment: 1 },
        ...(opts.extraData ?? {}),
      },
    });
    if (result.count === 0) return { applied: false };

    // CAS succeeded — write transition, then call fn for audit/outbox/measurement.
    await tx.sessionTransition.create({
      data: { sessionId: opts.sessionId, from: opts.fromState, to: opts.newState, reason: opts.reason, actor: opts.actor },
    });
    await fn(tx);
    return { applied: true };
  });
}

// withTimeoutAndAbort (audit issue #1 + #4 v3):
// Wraps an adapter call with a bounded timeout AND an AbortController.
// On timeout: aborts the signal (so adapters that support cancellation can stop),
// and returns { ok: false, error: "TIMEOUT" }.
// The adapter may still complete after the abort (late success) — reconciliation
// handles that. But the RoamLink request is not blocked.
export function withTimeoutAndAbort<T>(
  fn: (signal: AbortSignal, deadline: Date) => Promise<T>,
  ms: number
): Promise<{ ok: true; value: T } | { ok: false; error: "TIMEOUT" }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const deadline = new Date(Date.now() + ms);
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: "TIMEOUT" as const });
    }, ms);
    fn(controller.signal, deadline).then(
      (value) => { clearTimeout(timer); resolve({ ok: true as const, value }); },
      (err) => {
        clearTimeout(timer);
        // If aborted, it's a timeout; otherwise treat as failure.
        if (controller.signal.aborted) resolve({ ok: false, error: "TIMEOUT" as const });
        else resolve({ ok: false, error: "TIMEOUT" as const });
      }
    );
  });
}

// withTimeout (legacy, for non-adapter promises).
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: "TIMEOUT" }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: "TIMEOUT" as const }), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ ok: true as const, value }); },
      (err) => { clearTimeout(timer); resolve({ ok: false as const, error: "TIMEOUT" as const }); }
    );
  });
}

export const DEFAULT_ADAPTER_TIMEOUT_MS = 5000;
