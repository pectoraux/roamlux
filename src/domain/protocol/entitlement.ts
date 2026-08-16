// Entitlement contract — the consumer's RIGHT to consume connectivity.
// Entitlement ≠ Identity ≠ Payment. Entitlement may originate from purchase,
// subscription, allocation, transfer, promotion, sponsorship, or trial.
// The kernel VERIFIES entitlement; it does NOT create commercial authority.
export const ENTITLEMENT_CONTRACT_VERSION = "1.0.0" as const;

export type EntitlementOrigin =
  | "PURCHASE"
  | "SUBSCRIPTION"
  | "COMPANY_ALLOCATION"
  | "FAMILY_TRANSFER"
  | "PROMOTION"
  | "SPONSORSHIP"
  | "TRIAL";

export interface EntitlementQuota {
  dataGB?: number;
  seconds?: number;
  sessions?: number;
}

export interface EntitlementRef {
  id: string;
  subjectId: string;
  offerId?: string;
  origin: EntitlementOrigin;
  quota: EntitlementQuota;
  validFrom: string;
  validUntil?: string;
  active: boolean;
}

// A subject is entitled to an offer if they hold an active entitlement for it.
export function isEntitledTo(
  entitlements: EntitlementRef[],
  offerId?: string
): boolean {
  if (!offerId) return false;
  return entitlements.some((e) => e.active && e.offerId === offerId);
}
