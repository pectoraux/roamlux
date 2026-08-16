// Connectivity Kernel — explicit state machines for Reservation & Session.
// No scattered booleans. Transitions are validated; illegal transitions throw.
//
// ARCHITECTURAL INVARIANT: The kernel depends ONLY on the protocol. It does NOT
// import Prisma, Next.js, or any provider SDK. The protocol owns the state types;
// the DB layer maps Prisma enums to these protocol types (they share string values).
import type { ReservationState, SessionState } from "@/domain/protocol";
import { RESERVATION_TRANSITIONS, SESSION_TRANSITIONS, RECONCILIATION_TRANSITIONS } from "@/domain/protocol";

export function canTransitionReservation(from: ReservationState, to: ReservationState): boolean {
  return RESERVATION_TRANSITIONS[from]?.includes(to) ?? false;
}
export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false;
}

// Reconciliation-only transitions: repairs divergence (late success, provider lost).
// These do NOT weaken the normal lifecycle — they are a separate, explicit path.
export function canReconcileTransition(from: SessionState, to: SessionState): boolean {
  return RECONCILIATION_TRANSITIONS[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(kind: "Reservation" | "Session" | "Reconciliation", from: string, to: string) {
    super(`Illegal ${kind} transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertReservationTransition(from: ReservationState, to: ReservationState) {
  if (!canTransitionReservation(from, to)) throw new IllegalTransitionError("Reservation", from, to);
}
export function assertSessionTransition(from: SessionState, to: SessionState) {
  if (!canTransitionSession(from, to)) throw new IllegalTransitionError("Session", from, to);
}
export function assertReconciliationTransition(from: SessionState, to: SessionState) {
  if (!canReconcileTransition(from, to)) throw new IllegalTransitionError("Reconciliation", from, to);
}

// Re-export the state types so kernel consumers import from the kernel, not Prisma.
export type { ReservationState, SessionState } from "@/domain/protocol";
