// Transactional audit + outbox helpers.
// IMPORTANT: audit() and emitEvent() write in SEPARATE transactions by default.
// For atomicity (state + audit + event in ONE transaction), use txAudit() and
// txEmit() with a Prisma transaction client, OR use the atomic() helper below.
import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";

type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

// Non-transactional audit (best-effort, never breaks the primary operation).
// Use ONLY when the audit is not critical to atomicity.
export async function audit(params: {
  actorId?: string;
  actorType?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  result?: "success" | "failure";
  reason?: string;
  correlationId?: string;
  requestId?: string;
  metadata?: any;
}) {
  try {
    const rawActor = params.actorId;
    const actorId =
      rawActor && rawActor !== "system" && /^[a-z0-9]{20,}$/i.test(rawActor) ? rawActor : null;
    await db.auditLog.create({
      data: {
        actorId,
        actorType: params.actorType ?? (actorId ? "user" : "system"),
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        result: params.result ?? "success",
        reason: params.reason,
        correlationId: params.correlationId,
        requestId: params.requestId,
        metadata: params.metadata ?? {},
      },
    });
  } catch (e) {
    console.error("[audit] failed to write audit log:", e);
  }
}

// Transactional audit — call inside a $transaction callback.
export async function txAudit(tx: TxClient, params: {
  actorId?: string;
  actorType?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  result?: "success" | "failure";
  reason?: string;
  correlationId?: string;
  requestId?: string;
  metadata?: any;
}) {
  const rawActor = params.actorId;
  const actorId =
    rawActor && rawActor !== "system" && /^[a-z0-9]{20,}$/i.test(rawActor) ? rawActor : null;
  await tx.auditLog.create({
    data: {
      actorId,
      actorType: params.actorType ?? (actorId ? "user" : "system"),
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      result: params.result ?? "success",
      reason: params.reason,
      correlationId: params.correlationId,
      requestId: params.requestId,
      metadata: params.metadata ?? {},
    },
  });
}

// Transactional outbox emit — call inside a $transaction callback.
// This GUARANTEES the event is written iff the state change commits.
export async function txEmit(tx: TxClient, type: string, payload: any, aggregate?: { type: string; id: string }) {
  await tx.outboxEvent.create({
    data: {
      type,
      payload: payload as any,
      aggregateType: aggregate?.type,
      aggregateId: aggregate?.id,
    },
  });
}

// Non-transactional emit (best-effort). Prefer txEmit inside transactions.
export async function emitEvent(type: string, payload: any, aggregate?: { type: string; id: string }) {
  try {
    await db.outboxEvent.create({
      data: {
        type,
        payload: payload as any,
        aggregateType: aggregate?.type,
        aggregateId: aggregate?.id,
      },
    });
  } catch (e) {
    console.error("[outbox] failed to enqueue event:", e);
  }
}

// atomic: run a function inside a transaction, providing a tx client that has
// txAudit + txEmit available. State changes, audit, and events all commit together
// or all roll back together.
export async function atomic<T>(
  fn: (tx: TxClient & { txAudit: typeof txAudit; txEmit: typeof txEmit }) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    const augmented = tx as TxClient & { txAudit: typeof txAudit; txEmit: typeof txEmit };
    augmented.txAudit = txAudit;
    augmented.txEmit = txEmit;
    return fn(augmented);
  });
}
