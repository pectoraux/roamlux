// Connectivity Kernel — explicit state machines for Reservation & Session.
// No scattered booleans. Transitions are validated; illegal transitions throw.

import type { ReservationState, SessionState } from "@prisma/client";

const RESERVATION_GRAPH: Record<ReservationState, ReservationState[]> = {
  AVAILABLE: ["RESERVED", "EXPIRED"],
  RESERVED: ["ACTIVE", "RELEASED", "EXPIRED", "FAILED"],
  ACTIVE: ["RELEASED", "EXPIRED"],
  RELEASED: [],
  EXPIRED: [],
  FAILED: ["RESERVED"], // retry from failed
};

const SESSION_GRAPH: Record<SessionState, SessionState[]> = {
  REQUESTED: ["PROVISIONING", "FAILED"],
  PROVISIONING: ["ACTIVE", "FAILED"],
  ACTIVE: ["SUSPENDED", "TERMINATED", "FAILED"],
  SUSPENDED: ["ACTIVE", "TERMINATED"],
  TERMINATED: [],
  FAILED: ["PROVISIONING"], // retry
};

export function canTransitionReservation(from: ReservationState, to: ReservationState): boolean {
  return RESERVATION_GRAPH[from]?.includes(to) ?? false;
}
export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_GRAPH[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  constructor(kind: "Reservation" | "Session", from: string, to: string) {
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
