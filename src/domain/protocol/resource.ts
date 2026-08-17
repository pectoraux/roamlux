// Resource contract — the actual consumable/controllable thing.
// Resource ≠ Capability ≠ Offer. A resource is an instance a session binds to.
export const RESOURCE_CONTRACT_VERSION = "1.0.0" as const;

export type ResourceState =
  | "available"
  | "reserved"
  | "active"
  | "released"
  | "expired"
  | "failed";

export interface ResourceAttributes {
  quotaGB?: number;
  maxConcurrent?: number;
  geoLock?: string;
  [k: string]: unknown;
}

export interface ResourceRef {
  id: string;
  providerId: string;
  capabilityId: string;
  identifier: string; // provider-native resource id
  state: ResourceState;
  attributes: ResourceAttributes;
}
