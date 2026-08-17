// Connectivity Session contract — the active relationship between
// subject, device, resource, and provider. Explicit state machine.
export const SESSION_CONTRACT_VERSION = "1.0.0" as const;

export type SessionState =
  | "REQUESTED"
  | "PROVISIONING"
  | "ACTIVE"
  | "SUSPENDED"
  | "TERMINATED"
  | "FAILED";

// REQUESTED → PROVISIONING → ACTIVE → SUSPENDED → ACTIVE (resume)
//                       ↘ FAILED → PROVISIONING (retry)
// ACTIVE → TERMINATED
export const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  REQUESTED: ["PROVISIONING", "FAILED"],
  PROVISIONING: ["ACTIVE", "FAILED"],
  ACTIVE: ["SUSPENDED", "TERMINATED", "FAILED"],
  SUSPENDED: ["ACTIVE", "TERMINATED"],
  TERMINATED: [],
  FAILED: ["PROVISIONING"],
};

// RECONCILIATION-ONLY transitions.
// These are NOT part of the normal lifecycle. They repair divergence discovered
// by the reconciliation service (e.g. late provider success after a timeout).
// The normal state machine (above) stays strict; reconciliation uses a separate
// assertion (assertReconciliationTransition in kernel/state-machines.ts).
export const RECONCILIATION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  REQUESTED: [],
  PROVISIONING: ["ACTIVE", "FAILED", "TERMINATED"],
  ACTIVE: ["TERMINATED"],
  SUSPENDED: ["TERMINATED"],
  TERMINATED: [],
  FAILED: ["ACTIVE", "TERMINATED"], // late-success repair; provider-lost repair
};

export interface SessionTransitionRef {
  id: string;
  sessionId: string;
  from: string;
  to: string;
  reason: string;
  actor: string;
  at: string;
}

export interface ConnectivitySessionRef {
  id: string;
  subjectId: string;
  deviceId?: string;
  resourceId: string;
  providerId: string;
  reservationId?: string;
  intentId?: string;
  state: SessionState;
  startedAt?: string;
  endedAt?: string;
  currentQuality?: Record<string, unknown>;
  currentCostCents: number;
  policy: Record<string, unknown>;
  failureReason?: string;
}
