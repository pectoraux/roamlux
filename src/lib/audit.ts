// Audit + Outbox helpers. Important actions are auditable; events use the outbox pattern.
import { db } from "@/lib/db";

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
    // AuditLog.actorId is a FK to User. Coerce non-user actors (system/anonymous) to null.
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
    // Audit must never break the primary operation.
    console.error("[audit] failed to write audit log:", e);
  }
}

export async function emitEvent(type: string, payload: any) {
  try {
    await db.outboxEvent.create({
      data: { type, payload: payload as any },
    });
  } catch (e) {
    console.error("[outbox] failed to enqueue event:", e);
  }
}
