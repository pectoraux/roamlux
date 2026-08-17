// Decision contract — deterministic control-plane output.
// The decision engine is deterministic: identical inputs → identical decision.
// AI is NEVER the authority. AI may compile natural language into Intent,
// but the structured Intent is consumed by this deterministic engine.
export const DECISION_CONTRACT_VERSION = "1.0.0" as const;

export type DecisionType = "SELECT" | "SWITCH" | "RETAIN" | "RELEASE";

export type ReasonCode =
  | "LOWER_LATENCY"
  | "HIGHER_THROUGHPUT"
  | "LOWER_COST"
  | "HIGHER_RELIABILITY"
  | "MEETS_POLICY"
  | "POLICY_VIOLATION"
  | "BETTER_SCORE_AFTER_SWITCHING_COST"
  | "INSUFFICIENT_IMPROVEMENT"
  | "NO_CANDIDATES"
  | "ENTITLEMENT_VALID"
  | "ENTITLEMENT_MISSING"
  | "AVAILABILITY_OK"
  | "AVAILABILITY_NONE";

export interface ScoredCandidate {
  resourceId: string;
  providerId: string;
  providerCode: string;
  providerName: string;
  offerId?: string;
  rawScore: number;       // 0..100 before switching cost
  switchingCost: number;
  effectiveScore: number; // rawScore - switchingCost
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
