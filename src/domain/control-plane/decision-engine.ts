// Deterministic Decision Engine.
// Inputs: Intent, Capabilities, Offers, Measurements, Current Session, Policy, Budget, Availability.
// Output: a single Decision. AI is NEVER the authority here.
//
// Scoring is deterministic and testable. A switching-cost/hysteresis term prevents
// flapping: a marginally better alternative is NOT worth switching to.

import type {
  ConnectivityIntentPayload, AdvertisedCapability, MeasurementSnapshot,
  DecisionResult, ScoredCandidate, ReasonCode, PolicySpec,
} from "@/domain/protocol";

export interface EvaluationInput {
  intent: ConnectivityIntentPayload;
  candidates: CandidateInput[];
  currentSession?: {
    sessionId: string;
    resourceId: string;
    providerId: string;
    measurement?: MeasurementSnapshot;
    advertised: AdvertisedCapability;
    priceCents: number;
  };
}

export interface CandidateInput {
  resourceId: string;
  providerId: string;
  providerCode: string;
  providerName: string;
  offerId?: string;
  advertised: AdvertisedCapability;
  priceCents: number;
  measurement?: MeasurementSnapshot; // observed truth preferred over advertised
  available: boolean;
  entitlementValid: boolean;
}

// Weights — deterministic, explicit, tunable. Not machine-learned.
const W = {
  latency: 0.30,
  throughput: 0.25,
  reliability: 0.25,
  cost: 0.20,
};

// Switching-cost model: activation + interruption risk + quality improvement margin.
export interface SwitchingCostModel {
  activationCostCents: number;
  interruptionRisk: number;   // 0..10 score penalty
  batteryPenalty: number;     // 0..3
  policyPenalty: number;      // added when policy forbids auto-switch
}

const DEFAULT_SWITCHING_COST: SwitchingCostModel = {
  activationCostCents: 50, // $0.50 activation equivalent
  interruptionRisk: 4,
  batteryPenalty: 1,
  policyPenalty: 0,
};

// Hysteresis threshold: an alternative must beat the current effective score by
// at least this many points to justify a switch.
export const HYSTERESIS_THRESHOLD = 10;

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// Normalize a metric to 0..100 where higher = better.
function scoreLatency(latencyMs: number): number {
  // 0ms -> 100, 300ms -> 0
  return clamp(100 - (latencyMs / 300) * 100);
}
function scoreThroughput(downlinkMbps: number, needMbps?: number): number {
  const base = clamp((downlinkMbps / 100) * 100);
  // If a need is expressed, penalize hard if not met.
  if (needMbps && downlinkMbps < needMbps) {
    return base * 0.4;
  }
  return base;
}
function scoreReliability(reliability: number): number {
  return clamp(reliability * 100);
}
function scoreCost(priceCents: number, budgetCents?: number): number {
  // $0 -> 100, $5 (500c) -> 0
  const base = clamp(100 - (priceCents / 500) * 100);
  if (budgetCents && priceCents > budgetCents) {
    return base * 0.3; // heavy penalty for exceeding budget
  }
  return base;
}

function effectiveMeasurement(c: CandidateInput): MeasurementSnapshot {
  // Observed measurement is truth; advertised is fallback only.
  return c.measurement ?? {
    latencyMs: c.advertised.typicalLatencyMs,
    downlinkMbps: c.advertised.maxDownlinkMbps,
    uplinkMbps: c.advertised.maxUplinkMbps,
    availabilityPct: c.advertised.availabilityPct,
    observedAt: new Date().toISOString(),
    source: "advertised_fallback",
  };
}

function meetsPolicy(intent: ConnectivityIntentPayload, m: MeasurementSnapshot, priceCents: number): boolean {
  const p: PolicySpec = intent.policy ?? intent.constraints;
  if (p.maxLatencyMs != null && (m.latencyMs ?? Infinity) > p.maxLatencyMs) return false;
  if (p.minReliability != null) {
    // Derive an approximate reliability from availability if no direct reliability.
    const rel = (m.availabilityPct ?? 100) / 100;
    if (rel < p.minReliability) return false;
  }
  if (p.maxCostCents != null && priceCents > p.maxCostCents) return false;
  if (p.minimumThroughputMbps != null && (m.downlinkMbps ?? 0) < p.minimumThroughputMbps) return false;
  return true;
}

function scoreCandidate(c: CandidateInput, intent: ConnectivityIntentPayload): ScoredCandidate {
  const m = effectiveMeasurement(c);
  const sLat = scoreLatency(m.latencyMs ?? c.advertised.typicalLatencyMs);
  const sThr = scoreThroughput(m.downlinkMbps ?? c.advertised.maxDownlinkMbps, intent.usage.downlinkMbps);
  const sRel = scoreReliability(c.advertised.reliability);
  const sCost = scoreCost(c.priceCents, intent.constraints.maxCostCents);

  const raw = clamp(
    W.latency * sLat + W.throughput * sThr + W.reliability * sRel + W.cost * sCost
  );

  const reasons: ReasonCode[] = [];
  if (!c.available) reasons.push("AVAILABILITY_NONE");
  if (!c.entitlementValid) reasons.push("ENTITLEMENT_MISSING");
  if (c.measurement && c.measurement.latencyMs != null) {
    // compare to advertised to flag observation
  }
  const policyOk = meetsPolicy(intent, m, c.priceCents);
  if (policyOk) reasons.push("MEETS_POLICY");
  else reasons.push("POLICY_VIOLATION");
  if (c.entitlementValid) reasons.push("ENTITLEMENT_VALID");
  if (c.available) reasons.push("AVAILABILITY_OK");

  return {
    resourceId: c.resourceId,
    providerId: c.providerId,
    providerCode: c.providerCode,
    providerName: c.providerName,
    offerId: c.offerId,
    rawScore: Math.round(raw * 10) / 10,
    switchingCost: 0,
    effectiveScore: Math.round(raw * 10) / 10,
    latencyMs: Math.round((m.latencyMs ?? c.advertised.typicalLatencyMs) * 10) / 10,
    downlinkMbps: Math.round((m.downlinkMbps ?? c.advertised.maxDownlinkMbps) * 10) / 10,
    reliability: Math.round(c.advertised.reliability * 1000) / 1000,
    priceCents: c.priceCents,
    meetsPolicy: policyOk,
    reasons,
  };
}

function switchingCostFor(candidate: ScoredCandidate, intent: ConnectivityIntentPayload): number {
  const model: SwitchingCostModel = { ...DEFAULT_SWITCHING_COST };
  if (intent.preferences.allowAutoSwitch === false) model.policyPenalty = 1000; // effectively forbid
  // Convert activation cost to score points (~ $0.50 => ~0.1 pts) plus fixed risk.
  const costPts = (model.activationCostCents / 500) * 100 * W.cost;
  const total = costPts + model.interruptionRisk + model.batteryPenalty + model.policyPenalty;
  return Math.round(total * 10) / 10;
}

export function evaluate(input: EvaluationInput): DecisionResult {
  const { intent, candidates, currentSession } = input;

  // Filter to viable candidates: available + entitled + policy-met (for selection).
  const scored: ScoredCandidate[] = candidates.map((c) => scoreCandidate(c, intent));

  // For candidates that are NOT the current session, apply switching cost.
  let currentScore: number | undefined;
  if (currentSession) {
    const cur = scored.find((s) => s.resourceId === currentSession.resourceId);
    currentScore = cur?.rawScore;
  }

  const alternatives = scored
    .filter((s) => s.resourceId !== currentSession?.resourceId)
    .map((s) => {
      const sc = switchingCostFor(s, intent);
      return { ...s, switchingCost: sc, effectiveScore: Math.round((s.rawScore - sc) * 10) / 10 };
    })
    .sort((a, b) => b.effectiveScore - a.effectiveScore);

  // Viable = available + entitled + meets policy.
  const viable = alternatives.filter(
    (s) => s.reasons.includes("AVAILABILITY_OK") && s.reasons.includes("ENTITLEMENT_VALID") && s.meetsPolicy
  );

  const reasonCodes: ReasonCode[] = [];
  if (viable.length === 0 && !currentSession) reasonCodes.push("NO_CANDIDATES");

  let decision: DecisionResult["decisionType"];

  if (!currentSession) {
    // Fresh selection — pick the best viable candidate by effective score.
    if (viable.length === 0) {
      decision = "RELEASE";
      return {
        decisionType: "RELEASE",
        reasonCodes: ["NO_CANDIDATES"],
        policyMet: false,
        candidates: scored,
      };
    }
    const best = viable[0];
    // Build precise reason set from candidate's reasons + selection note.
    const rc = new Set<ReasonCode>(best.reasons);
    rc.add("BETTER_SCORE_AFTER_SWITCHING_COST");
    return {
      decisionType: "SELECT",
      targetResourceId: best.resourceId,
      targetProviderId: best.providerId,
      targetOfferId: best.offerId,
      scoreTarget: best.effectiveScore,
      switchingCost: best.switchingCost,
      reasonCodes: Array.from(rc),
      policyMet: best.meetsPolicy,
      candidates: scored,
    };
  }

  // Has a current session → SWITCH vs RETAIN (hysteresis).
  const best = viable[0];
  if (!best || currentScore == null) {
    return {
      decisionType: "RETAIN",
      fromSessionId: currentSession?.sessionId,
      scoreCurrent: currentScore,
      reasonCodes: ["INSUFFICIENT_IMPROVEMENT", "MEETS_POLICY"],
      policyMet: true,
      candidates: scored,
    };
  }

  const delta = best.effectiveScore - currentScore;
  if (delta >= HYSTERESIS_THRESHOLD) {
    const rc = new Set<ReasonCode>(best.reasons);
    rc.add("BETTER_SCORE_AFTER_SWITCHING_COST");
    if (best.latencyMs < (currentSession.measurement?.latencyMs ?? currentSession.advertised.typicalLatencyMs)) rc.add("LOWER_LATENCY");
    if (best.downlinkMbps > (currentSession.measurement?.downlinkMbps ?? currentSession.advertised.maxDownlinkMbps)) rc.add("HIGHER_THROUGHPUT");
    if (best.reliability > currentSession.advertised.reliability) rc.add("HIGHER_RELIABILITY");
    if (best.priceCents < currentSession.priceCents) rc.add("LOWER_COST");
    return {
      decisionType: "SWITCH",
      fromSessionId: currentSession.sessionId,
      targetResourceId: best.resourceId,
      targetProviderId: best.providerId,
      targetOfferId: best.offerId,
      scoreCurrent: currentScore,
      scoreTarget: best.effectiveScore,
      switchingCost: best.switchingCost,
      effectiveDelta: Math.round(delta * 10) / 10,
      reasonCodes: Array.from(rc),
      policyMet: best.meetsPolicy,
      candidates: scored,
    };
  }

  // Not worth switching — hysteresis.
  return {
    decisionType: "RETAIN",
    fromSessionId: currentSession.sessionId,
    scoreCurrent: currentScore,
    scoreTarget: best.effectiveScore,
    effectiveDelta: Math.round(delta * 10) / 10,
    reasonCodes: ["INSUFFICIENT_IMPROVEMENT", "MEETS_POLICY"],
    policyMet: true,
    candidates: scored,
  };
}

export const __scoring = { scoreLatency, scoreThroughput, scoreReliability, scoreCost, W, HYSTERESIS_THRESHOLD };
