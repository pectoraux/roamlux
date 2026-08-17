// Intent contract — what the consumer WANTS. Intent does NOT select a provider.
export const INTENT_CONTRACT_VERSION = "1.0.0" as const;

export interface LocationSpec {
  country: string;
  region?: string;
  lat?: number;
  lng?: number;
}

export interface TimeWindowSpec {
  start: string; // ISO 8601
  end?: string;
  tz?: string;
}

export interface UsageSpec {
  downlinkMbps?: number;
  uplinkMbps?: number;
  dataGB?: number;
}

export interface ConstraintSpec {
  maxLatencyMs?: number;
  minReliability?: number; // 0..1
  maxCostCents?: number;
  allowRoaming?: boolean;
}

export interface PreferenceSpec {
  prioritize?: "cost" | "quality" | "reliability";
  allowAutoSwitch?: boolean;
}

export interface PolicySpec extends ConstraintSpec {
  minimumThroughputMbps?: number;
  maximumInterruptionSeconds?: number;
}

export interface ConnectivityIntentPayload {
  capability: string; // see capability taxonomy
  location: LocationSpec;
  timeWindow: TimeWindowSpec;
  usage: UsageSpec;
  constraints: ConstraintSpec;
  preferences: PreferenceSpec;
  policy?: PolicySpec;
}

// INVARIANT: intent never contains a providerId or offerId.
export function validateIntent(i: ConnectivityIntentPayload): string[] {
  const errs: string[] = [];
  if (!i.capability) errs.push("capability required");
  if (!i.location?.country) errs.push("location.country required");
  if (!i.timeWindow?.start) errs.push("timeWindow.start required");
  return errs;
}
