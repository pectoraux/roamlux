// Capability contract + taxonomy.
// Capability = what a provider/resource can TECHNICALLY provide. NOT a commercial offer.
// Capability.advertised ≠ Measurement (observed). Advertised never overwrites observed.
export const CAPABILITY_CONTRACT_VERSION = "1.0.0" as const;

export interface AdvertisedCapability {
  maxDownlinkMbps: number;
  maxUplinkMbps: number;
  typicalLatencyMs: number;
  reliability: number; // 0..1
  availabilityPct?: number;
}

export interface CoverageSpec {
  countries: string[];
  regions?: string[];
}

// ── Capability Taxonomy ────────────────────────────────────────────────────
// "internet" is an ABSTRACT root that matches all concrete connectivity types.
// This is an explicit, documented taxonomy — not a scattered string comparison.
export const CAPABILITY_TAXONOMY = {
  internet: ["wifi", "cellular", "broadband", "satellite", "shared_bandwidth"],
  cellular: ["lte", "esim_data", "5g"],
  broadband: ["isp"],
} as const;

export type CapabilityType =
  | "internet"          // abstract root
  | "wifi"
  | "cellular"          // abstract
  | "lte"
  | "esim_data"
  | "5g"
  | "broadband"         // abstract
  | "isp"
  | "satellite"
  | "shared_bandwidth";

// Does an intent's requested capability match a provider's concrete capability type?
// intent "internet"  matches "wifi", "lte", "esim_data", "isp", "satellite", ...
// intent "cellular"  matches "lte", "esim_data", "5g"
// intent "lte"       matches "lte" only
export function capabilityMatches(intentType: string, capType: string): boolean {
  if (intentType === capType) return true;
  const children = (CAPABILITY_TAXONOMY as Record<string, readonly string[]>)[intentType];
  if (children) {
    for (const child of children) {
      if (capabilityMatches(child, capType)) return true;
    }
  }
  return false;
}

export function isAbstractCapability(type: string): boolean {
  return type in CAPABILITY_TAXONOMY;
}
