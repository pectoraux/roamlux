// Reconciliation service — repairs divergence between RoamLink state and provider state.
//
// RECONCILIATION-ONLY TRANSITIONS (audit issue #2):
//   The normal session state machine does NOT allow FAILED→ACTIVE. Reconciliation
//   uses a SEPARATE transition table (RECONCILIATION_TRANSITIONS) with an explicit
//   assertReconciliationTransition(). This does NOT weaken the normal lifecycle —
//   it is a distinct, auditable repair path.
//
// TWO DISCREPANCY CASES:
//   1. RoamLink=PROVISIONING/FAILED, Provider=ACTIVE → late success → repair to ACTIVE
//   2. RoamLink=ACTIVE, Provider=INACTIVE/unknown → provider lost → repair to TERMINATED
//
// All repairs use compare-and-set fencing (audit issue #3) and are transactional.
import { db } from "@/lib/db";
import { audit, atomic, txAudit, txEmit } from "@/lib/audit";
import { adapterForProvider } from "@/domain/adapters/registry";
import { assertReconciliationTransition } from "@/domain/kernel/state-machines";
import { compareAndSetSessionState } from "@/lib/services/operation-service";
import type { SessionState } from "@/domain/protocol";

export interface ReconciliationResult {
  sessionId: string;
  roamLinkState: string;
  providerState: string;
  action: "NO_ACTION" | "ACTIVATED_LATE" | "TERMINATED_MISSING" | "RETRY_FAILED" | "ERROR";
  detail: string;
}

// reconcileSession: compares RoamLink's session state with the provider's actual state.
export async function reconcileSession(sessionId: string): Promise<ReconciliationResult> {
  const session = await db.connectivitySession.findUnique({ where: { id: sessionId }, include: { resource: true } });
  if (!session) return { sessionId, roamLinkState: "MISSING", providerState: "unknown", action: "ERROR", detail: "session not found" };

  const adapter = await adapterForProvider(session.providerId);
  if (!adapter) return { sessionId, roamLinkState: session.state, providerState: "unknown", action: "ERROR", detail: "no adapter" };

  const providerState = await adapter.reconcile(session.resource.identifier);
  const roamLinkState = session.state as SessionState;
  const expectedGen = session.generation;

  // CASE 1: RoamLink=PROVISIONING/FAILED, Provider=ACTIVE → late success.
  // Uses RECONCILIATION transition (FAILED→ACTIVE is NOT in the normal state machine).
  if ((roamLinkState === "PROVISIONING" || roamLinkState === "FAILED") && providerState.state === "active") {
    try {
      assertReconciliationTransition(roamLinkState, "ACTIVE");
      const cas = await compareAndSetSessionState({ sessionId, expectedGen, newState: "ACTIVE", extraData: { startedAt: new Date(), failureReason: null } });
      if (!cas.applied) {
        return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "session advanced since read; another operation won" };
      }
      await atomic(async (tx) => {
        await tx.sessionTransition.create({ data: { sessionId, from: roamLinkState, to: "ACTIVE", reason: "reconciliation:late_success", actor: "system" } });
        await tx.reservation.updateMany({ where: { id: session.reservationId ?? undefined }, data: { state: "ACTIVE" } });
        await txEmit(tx, "SessionStarted", { sessionId, source: "reconciliation" }, { type: "session", id: sessionId });
        await txEmit(tx, "ReconciliationRequired", { sessionId, action: "ACTIVATED_LATE" }, { type: "session", id: sessionId });
        await txAudit(tx, { actorType: "system", action: "session.reconcile.late_success", targetType: "session", targetId: sessionId, metadata: { providerState: providerState.state, fromState: roamLinkState } });
      });
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ACTIVATED_LATE", detail: "session activated via late-success reconciliation (FAILED→ACTIVE repair)" };
    } catch (e: any) {
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ERROR", detail: e.message };
    }
  }

  // CASE 2: RoamLink=ACTIVE, Provider=INACTIVE/unknown → provider lost.
  if (roamLinkState === "ACTIVE" && (providerState.state === "inactive" || providerState.state === "unknown" || !providerState.found)) {
    try {
      assertReconciliationTransition("ACTIVE", "TERMINATED");
      const cas = await compareAndSetSessionState({ sessionId, expectedGen, newState: "TERMINATED", extraData: { endedAt: new Date() } });
      if (!cas.applied) {
        return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "session advanced since read" };
      }
      await atomic(async (tx) => {
        await tx.sessionTransition.create({ data: { sessionId, from: "ACTIVE", to: "TERMINATED", reason: "reconciliation:provider_lost", actor: "system" } });
        await txEmit(tx, "SessionTerminated", { sessionId, source: "reconciliation" }, { type: "session", id: sessionId });
        await txEmit(tx, "ReconciliationRequired", { sessionId, action: "TERMINATED_MISSING" }, { type: "session", id: sessionId });
        await txAudit(tx, { actorType: "system", action: "session.reconcile.terminated", targetType: "session", targetId: sessionId, metadata: { providerState: providerState.state } });
      });
      return { sessionId, roamLinkState, providerState: providerState.state, action: "TERMINATED_MISSING", detail: "session terminated — provider lost the resource" };
    } catch (e: any) {
      return { sessionId, roamLinkState, providerState: providerState.state, action: "ERROR", detail: e.message };
    }
  }

  // CASE 3: RoamLink=PROVISIONING/FAILED, Provider=INACTIVE — retry needed.
  if ((roamLinkState === "PROVISIONING" || roamLinkState === "FAILED") && providerState.state === "inactive") {
    return { sessionId, roamLinkState, providerState: providerState.state, action: "RETRY_FAILED", detail: "provisioning failed; provider did not activate. Retry with a new operation." };
  }

  return { sessionId, roamLinkState, providerState: providerState.state, action: "NO_ACTION", detail: "states agree" };
}

export async function reconcileAll(): Promise<ReconciliationResult[]> {
  const sessions = await db.connectivitySession.findMany({ where: { state: { in: ["PROVISIONING", "ACTIVE", "FAILED", "SUSPENDED"] } }, select: { id: true } });
  const results: ReconciliationResult[] = [];
  for (const s of sessions) { results.push(await reconcileSession(s.id)); }
  return results;
}
