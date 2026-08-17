// Reconciliation service — repairs divergence (v3: atomic CAS).
//
// Uses atomicCompareAndSet() so the state mutation + transition + audit + outbox
// commit in ONE transaction. No crash window.
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { adapterForProvider } from "@/domain/adapters/registry";
import { assertReconciliationTransition } from "@/domain/kernel/state-machines";
import { atomicCompareAndSet } from "@/lib/services/operation-service";
import { txAudit, txEmit } from "@/lib/audit";
import type { SessionState } from "@/domain/protocol";

export interface ReconciliationResult {
  sessionId: string;
  roamLinkState: string;
  providerState: string;
  action: "NO_ACTION" | "ACTIVATED_LATE" | "TERMINATED_MISSING" | "RETRY_FAILED" | "ERROR";
  detail: string;
}

export async function reconcileSession(sessionId: string): Promise<ReconciliationResult> {
  const session = await db.connectivitySession.findUnique({ where: { id: sessionId }, include: { resource: true } });
  if (!session) return { sessionId, roamLinkState: "MISSING", providerState: "unknown", action: "ERROR", detail: "session not found" };

  const adapter = await adapterForProvider(session.providerId);
  if (!adapter) return { sessionId, roamLinkState: session.state, providerState: "unknown", action: "ERROR", detail: "no adapter" };

  const providerState = await adapter.reconcile(session.resource.identifier);
  const roamLinkState = session.state as SessionState;
  const expectedGen = session.generation;

  // CASE 1: late success — FAILED/PROVISIONING + Provider ACTIVE → ACTIVE.
  if ((roamLinkState === "PROVISIONING" || roamLinkState === "FAILED") && providerState.state === "active") {
    try {
      assertReconciliationTransition(roamLinkState, "ACTIVE");
      const cas = await atomicCompareAndSet(
        { sessionId, expectedGen, newState: "ACTIVE", fromState: roamLinkState, reason: "reconciliation:late_success", actor: "system", extraData: { startedAt: new Date(), failureReason: null } },
        async (tx) => {
          await tx.reservation.updateMany({ where: { id: session.reservationId ?? undefined }, data: { state: "ACTIVE" } });
          await txEmit(tx, "SessionStarted", { sessionId, source: "reconciliation" }, { type: "session", id: sessionId });
          await txEmit(tx, "ReconciliationRequired", { sessionId, action: "ACTIVATED_LATE" }, { type: "session", id: sessionId });
          await txAudit(tx, { actorType: "system", action: "session.reconcile.late_success", targetType: "session", targetId: sessionId, metadata: { providerState: providerState.state, fromState: roamLinkState } });
        }
      );
      if (!cas.applied) return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "session advanced since read" };
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ACTIVATED_LATE", detail: "session activated via late-success reconciliation (atomic CAS)" };
    } catch (e: any) {
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ERROR", detail: e.message };
    }
  }

  // CASE 2: provider lost — ACTIVE + Provider INACTIVE → TERMINATED.
  if (roamLinkState === "ACTIVE" && (providerState.state === "inactive" || providerState.state === "unknown" || !providerState.found)) {
    try {
      assertReconciliationTransition("ACTIVE", "TERMINATED");
      const cas = await atomicCompareAndSet(
        { sessionId, expectedGen, newState: "TERMINATED", fromState: "ACTIVE", reason: "reconciliation:provider_lost", actor: "system", extraData: { endedAt: new Date() } },
        async (tx) => {
          await txEmit(tx, "SessionTerminated", { sessionId, source: "reconciliation" }, { type: "session", id: sessionId });
          await txEmit(tx, "ReconciliationRequired", { sessionId, action: "TERMINATED_MISSING" }, { type: "session", id: sessionId });
          await txAudit(tx, { actorType: "system", action: "session.reconcile.terminated", targetType: "session", targetId: sessionId, metadata: { providerState: providerState.state } });
        }
      );
      if (!cas.applied) return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "session advanced since read" };
      return { sessionId, roamLinkState, providerState: providerState.state, action: "TERMINATED_MISSING", detail: "session terminated — provider lost the resource" };
    } catch (e: any) {
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ERROR", detail: e.message };
    }
  }

  if ((roamLinkState === "PROVISIONING" || roamLinkState === "FAILED") && providerState.state === "inactive") {
    return { sessionId, roamLinkState, providerState: providerState.state, action: "RETRY_FAILED", detail: "provisioning failed; provider did not activate" };
  }

  return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "states agree" };
}

export async function reconcileAll(): Promise<ReconciliationResult[]> {
  const sessions = await db.connectivitySession.findMany({ where: { state: { in: ["PROVISIONING", "ACTIVE", "FAILED", "SUSPENDED"] } }, select: { id: true } });
  const results: ReconciliationResult[] = [];
  for (const s of sessions) { results.push(await reconcileSession(s.id)); }
  return results;
}
