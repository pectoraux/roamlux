// Measurement contract — OBSERVED truth. Distinct from advertised capability.
// A provider advertisement must NEVER overwrite observed truth.
export const MEASUREMENT_CONTRACT_VERSION = "1.0.0" as const;

export interface MeasurementSnapshot {
  latencyMs?: number;
  downlinkMbps?: number;
  uplinkMbps?: number;
  packetLossPct?: number;
  jitterMs?: number;
  availabilityPct?: number;
  observedAt: string;
  source: string; // "adapter" | "advertised_fallback" | "synthetic"
}

// INVARIANT: Measurement is a first-class record. It is never derived from
// Capability.advertised. The decision engine PREFERS observed over advertised
// but never mutates the capability record.
export function isObserved(m: MeasurementSnapshot): boolean {
  return m.source !== "advertised_fallback";
}
