// Offer contract — commercial terms over a capability/resource.
// One capability may have many offers. Offer ≠ Capability ≠ Resource.
// Payment creates/verifies Entitlement; payment is NOT connectivity truth.
export const OFFER_CONTRACT_VERSION = "1.0.0" as const;

export type BillingUnit = "flat" | "per_gb" | "per_hour" | "per_day";

export interface BillingModel {
  activationFeeCents?: number;
  overageCentsPerGb?: number;
}

export interface OfferRef {
  id: string;
  capabilityId: string;
  resourceId?: string;
  providerId: string;
  name: string;
  currency: string;
  priceCents: number;
  unit: BillingUnit;
  billingModel: BillingModel;
  valid: boolean;
}
