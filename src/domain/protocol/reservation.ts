// Reservation contract — explicit lifecycle/state.
// Idempotent via idempotencyKey. Recoverable. Auditable.
export const RESERVATION_CONTRACT_VERSION = "1.0.0" as const;

export type ReservationState =
  | "AVAILABLE"
  | "RESERVED"
  | "ACTIVE"
  | "RELEASED"
  | "EXPIRED"
  | "FAILED";

// State machine (defined authoritatively in kernel/state-machines.ts).
// AVAILABLE → RESERVED → ACTIVE → RELEASED
//                    ↘ FAILED → RESERVED (retry)
// RESERVED → EXPIRED
export const RESERVATION_TRANSITIONS: Record<ReservationState, ReservationState[]> = {
  AVAILABLE: ["RESERVED", "EXPIRED"],
  RESERVED: ["ACTIVE", "RELEASED", "EXPIRED", "FAILED"],
  ACTIVE: ["RELEASED", "EXPIRED"],
  RELEASED: [],
  EXPIRED: [],
  FAILED: ["RESERVED"],
};

export interface ReservationRef {
  id: string;
  intentId: string;
  resourceId: string;
  entitlementId?: string;
  state: ReservationState;
  idempotencyKey?: string;
  expiresAt?: string;
  failureReason?: string;
}
