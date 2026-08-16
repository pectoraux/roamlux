// RoamLink Protocol — explicit domain contracts.
// These types are the PUBLIC protocol contract. Database models are NOT the contract.
// Each concept is distinct: Intent ≠ Capability ≠ Resource ≠ Offer ≠ Entitlement ≠ Session.

export type ConnectivityCapabilityType =
  | "internet"
  | "wifi"
  | "lte"
  | "esim_data"
  | "isp"
  | "satellite"
  | "shared_bandwidth";

export interface LocationSpec {
  country: string;
  region?: string;
  lat?: number;
  lng?: number;
}

export interface TimeWindowSpec {
  start: string;
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
  minReliability?: number;
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
  capability: ConnectivityCapabilityType;
  location: LocationSpec;
  timeWindow: TimeWindowSpec;
  usage: UsageSpec;
  constraints: ConstraintSpec;
  preferences: PreferenceSpec;
  policy?: PolicySpec;
}

export interface AdvertisedCapability {
  maxDownlinkMbps: number;
  maxUplinkMbps: number;
  typicalLatencyMs: number;
  reliability: number;
  availabilityPct?: number;
}

export interface CoverageSpec {
  countries: string[];
  regions?: string[];
}

export interface MeasurementSnapshot {
  latencyMs?: number;
  downlinkMbps?: number;
  uplinkMbps?: number;
  packetLossPct?: number;
  jitterMs?: number;
  availabilityPct?: number;
  observedAt: string;
  source: string;
}

export type ActionType =
  | "DISCOVER" | "RESERVE" | "ACTIVATE" | "DEACTIVATE" | "SWITCH"
  | "RENEW" | "SUSPEND" | "RESUME" | "RELEASE" | "TRANSFER" | "MEASURE";

export const ALL_ACTIONS: ActionType[] = [
  "DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "SWITCH",
  "RENEW", "SUSPEND", "RESUME", "RELEASE", "TRANSFER", "MEASURE",
];

export type DecisionType = "SELECT" | "SWITCH" | "RETAIN" | "RELEASE";

export type ReasonCode =
  | "LOWER_LATENCY" | "HIGHER_THROUGHPUT" | "LOWER_COST" | "HIGHER_RELIABILITY"
  | "MEETS_POLICY" | "POLICY_VIOLATION" | "BETTER_SCORE_AFTER_SWITCHING_COST"
  | "INSUFFICIENT_IMPROVEMENT" | "NO_CANDIDATES" | "ENTITLEMENT_VALID"
  | "ENTITLEMENT_MISSING" | "AVAILABILITY_OK" | "AVAILABILITY_NONE";

export interface ScoredCandidate {
  resourceId: string;
  providerId: string;
  providerCode: string;
  providerName: string;
  offerId?: string;
  rawScore: number;
  switchingCost: number;
  effectiveScore: number;
  latencyMs: number;
  downlinkMbps: number;
  reliability: number;
  priceCents: number;
  meetsPolicy: boolean;
  reasons: ReasonCode[];
}

export interface DecisionResult {
  decisionType: DecisionType;
  fromSessionId?: string;
  targetResourceId?: string;
  targetProviderId?: string;
  targetOfferId?: string;
  scoreCurrent?: number;
  scoreTarget?: number;
  switchingCost?: number;
  effectiveDelta?: number;
  reasonCodes: ReasonCode[];
  policyMet: boolean;
  candidates: ScoredCandidate[];
}

export interface AdapterDescriptor {
  providerCode: string;
  providerName: string;
  type: "MOCK" | "MIKROTIK" | "ESIM";
  supportedActions: ActionType[];
}

export interface AdapterActionResult {
  ok: boolean;
  providerResourceId?: string;
  state: string;
  measurement?: MeasurementSnapshot;
  error?: string;
  idempotent: boolean;
  reconciled?: boolean;
}
