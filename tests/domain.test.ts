// RoamLink Domain Invariant Tests.
// These test the PURE domain logic (no DB, no network): protocol contracts,
// decision engine determinism, state machines, capability taxonomy, entitlement.
// Run with: bun test

import { test, expect, describe } from "bun:test";
import {
  capabilityMatches, isAbstractCapability, CAPABILITY_TAXONOMY,
  validateIntent, isValidIdentity,
  isEntitledTo, type EntitlementRef,
  SESSION_TRANSITIONS, RESERVATION_TRANSITIONS, RECONCILIATION_TRANSITIONS,
  PROTOCOL_VERSION,
} from "@/domain/protocol";
import {
  canTransitionSession, canTransitionReservation,
  assertSessionTransition, assertReservationTransition,
  assertReconciliationTransition, canReconcileTransition,
  IllegalTransitionError,
} from "@/domain/kernel/state-machines";
import { evaluate, HYSTERESIS_THRESHOLD, __scoring } from "@/domain/control-plane/decision-engine";
const EVAL_TIME = "2026-01-01T00:00:00.000Z";
import type {
  ConnectivityIntentPayload, AdvertisedCapability, CandidateInput,
} from "@/domain/protocol";

// ── Protocol Contracts ──────────────────────────────────────────────────────
describe("Protocol contracts", () => {
  test("protocol is versioned", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("identity invariant: demo can never be PLATFORM_ADMIN", () => {
    expect(isValidIdentity({ role: "PLATFORM_ADMIN", isDemo: false })).toBe(true);
    expect(isValidIdentity({ role: "PLATFORM_ADMIN", isDemo: true })).toBe(false);
    expect(isValidIdentity({ role: "CONSUMER", isDemo: true })).toBe(true);
  });

  test("intent validation rejects missing fields", () => {
    const errs = validateIntent({ capability: "", location: {} as any, timeWindow: {} as any, usage: {}, constraints: {}, preferences: {} });
    expect(errs.length).toBeGreaterThan(0);
    const ok = validateIntent({
      capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" },
      usage: {}, constraints: {}, preferences: {},
    });
    expect(ok.length).toBe(0);
  });
});

// ── Capability Taxonomy ─────────────────────────────────────────────────────
describe("Capability taxonomy", () => {
  test('"internet" matches all concrete types', () => {
    expect(capabilityMatches("internet", "wifi")).toBe(true);
    expect(capabilityMatches("internet", "lte")).toBe(true);
    expect(capabilityMatches("internet", "esim_data")).toBe(true);
    expect(capabilityMatches("internet", "isp")).toBe(true);
    expect(capabilityMatches("internet", "satellite")).toBe(true);
  });

  test('"cellular" matches lte, esim_data, 5g only', () => {
    expect(capabilityMatches("cellular", "lte")).toBe(true);
    expect(capabilityMatches("cellular", "esim_data")).toBe(true);
    expect(capabilityMatches("cellular", "wifi")).toBe(false);
    expect(capabilityMatches("cellular", "isp")).toBe(false);
  });

  test("exact match works", () => {
    expect(capabilityMatches("lte", "lte")).toBe(true);
    expect(capabilityMatches("lte", "wifi")).toBe(false);
  });

  test("abstract types are identified", () => {
    expect(isAbstractCapability("internet")).toBe(true);
    expect(isAbstractCapability("cellular")).toBe(true);
    expect(isAbstractCapability("lte")).toBe(false);
  });
});

// ── State Machines ──────────────────────────────────────────────────────────
describe("Session state machine", () => {
  test("REQUESTED → PROVISIONING is legal", () => {
    expect(canTransitionSession("REQUESTED", "PROVISIONING")).toBe(true);
  });
  test("PROVISIONING → ACTIVE is legal", () => {
    expect(canTransitionSession("PROVISIONING", "ACTIVE")).toBe(true);
  });
  test("ACTIVE → SUSPENDED → ACTIVE is legal", () => {
    expect(canTransitionSession("ACTIVE", "SUSPENDED")).toBe(true);
    expect(canTransitionSession("SUSPENDED", "ACTIVE")).toBe(true);
  });
  test("TERMINATED is terminal", () => {
    expect(canTransitionSession("TERMINATED", "ACTIVE")).toBe(false);
    expect(canTransitionSession("TERMINATED", "PROVISIONING")).toBe(false);
  });
  test("FAILED → PROVISIONING (retry) is legal", () => {
    expect(canTransitionSession("FAILED", "PROVISIONING")).toBe(true);
  });
  test("illegal transition throws", () => {
    expect(() => assertSessionTransition("TERMINATED", "ACTIVE")).toThrow(IllegalTransitionError);
  });
});

describe("Reservation state machine", () => {
  test("AVAILABLE → RESERVED → ACTIVE → RELEASED", () => {
    expect(canTransitionReservation("AVAILABLE", "RESERVED")).toBe(true);
    expect(canTransitionReservation("RESERVED", "ACTIVE")).toBe(true);
    expect(canTransitionReservation("ACTIVE", "RELEASED")).toBe(true);
  });
  test("RELEASED is terminal", () => {
    expect(canTransitionReservation("RELEASED", "RESERVED")).toBe(false);
  });
  test("FAILED → RESERVED (retry) is legal", () => {
    expect(canTransitionReservation("FAILED", "RESERVED")).toBe(true);
  });
});

// ── Entitlement ─────────────────────────────────────────────────────────────
describe("Entitlement verification", () => {
  const ents = (offerIds: string[]): EntitlementRef[] =>
    offerIds.map((id) => ({
      id: `ent-${id}`, subjectId: "u1", offerId: id, origin: "PURCHASE" as const,
      quota: {}, validFrom: "2026-01-01T00:00:00Z", active: true,
    }));

  test("no entitlements → not entitled", () => {
    expect(isEntitledTo([], "offer1")).toBe(false);
  });
  test("matching active entitlement → entitled", () => {
    expect(isEntitledTo(ents(["offer1"]), "offer1")).toBe(true);
  });
  test("non-matching entitlement → not entitled", () => {
    expect(isEntitledTo(ents(["offer1"]), "offer2")).toBe(false);
  });
  test("no offerId → not entitled", () => {
    expect(isEntitledTo(ents(["offer1"]), undefined)).toBe(false);
  });
});

// ── Reconciliation Transitions (audit issue #2) ─────────────────────────────
describe("Reconciliation-only transitions", () => {
  test("FAILED → ACTIVE is allowed ONLY via reconciliation (not normal lifecycle)", () => {
    // Normal state machine does NOT allow FAILED→ACTIVE
    expect(canTransitionSession("FAILED", "ACTIVE")).toBe(false);
    // Reconciliation state machine DOES allow it
    expect(canReconcileTransition("FAILED", "ACTIVE")).toBe(true);
    assertReconciliationTransition("FAILED", "ACTIVE"); // does not throw
  });

  test("normal lifecycle transitions are NOT weakened", () => {
    // The normal state machine still rejects FAILED→ACTIVE
    expect(() => assertSessionTransition("FAILED", "ACTIVE")).toThrow(IllegalTransitionError);
  });

  test("FAILED → TERMINATED is allowed via reconciliation (provider lost)", () => {
    expect(canReconcileTransition("FAILED", "TERMINATED")).toBe(true);
  });

  test("PROVISIONING → ACTIVE is allowed via reconciliation (late success)", () => {
    expect(canReconcileTransition("PROVISIONING", "ACTIVE")).toBe(true);
  });

  test("TERMINATED is terminal even in reconciliation", () => {
    expect(canReconcileTransition("TERMINATED", "ACTIVE")).toBe(false);
    expect(canReconcileTransition("TERMINATED", "PROVISIONING")).toBe(false);
  });
});

// ── Decision Engine: Determinism ────────────────────────────────────────────
function makeIntent(overrides: Partial<ConnectivityIntentPayload> = {}): ConnectivityIntentPayload {
  return {
    capability: "internet",
    location: { country: "GH" },
    timeWindow: { start: "2026-01-01T00:00:00Z" },
    usage: { downlinkMbps: 10 },
    constraints: { maxLatencyMs: 150 },
    preferences: { prioritize: "cost" },
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    resourceId: "r1", providerId: "p1", providerCode: "MOCK_A", providerName: "Atlas",
    offerId: "o1",
    advertised: { maxDownlinkMbps: 20, maxUplinkMbps: 5, typicalLatencyMs: 80, reliability: 0.9 },
    priceCents: 50, available: true, entitlementValid: true,
    ...overrides,
  };
}

describe("Decision engine determinism", () => {
  test("identical inputs produce identical decisions", () => {
    const intent = makeIntent();
    const candidates = [
      makeCandidate({ resourceId: "r1", providerName: "A", priceCents: 50, advertised: { maxDownlinkMbps: 20, maxUplinkMbps: 5, typicalLatencyMs: 80, reliability: 0.9 } }),
      makeCandidate({ resourceId: "r2", providerName: "B", priceCents: 200, advertised: { maxDownlinkMbps: 50, maxUplinkMbps: 15, typicalLatencyMs: 50, reliability: 0.95 } }),
    ];
    const d1 = evaluate({ intent, candidates, evaluationTime: EVAL_TIME });
    const d2 = evaluate({ intent, candidates, evaluationTime: EVAL_TIME });
    expect(d1.decisionType).toBe(d2.decisionType);
    expect(d1.targetResourceId).toBe(d2.targetResourceId);
    expect(d1.scoreTarget).toBe(d2.scoreTarget);
    expect(d1.reasonCodes).toEqual(d2.reasonCodes);
  });

  test("no candidates → RELEASE", () => {
    const d = evaluate({ intent: makeIntent(), candidates: [], evaluationTime: EVAL_TIME });
    expect(d.decisionType).toBe("RELEASE");
    expect(d.reasonCodes).toContain("NO_CANDIDATES");
  });

  test("candidate with no entitlement → not selected", () => {
    const d = evaluate({
      intent: makeIntent(),
      candidates: [makeCandidate({ entitlementValid: false })],
      evaluationTime: EVAL_TIME,
    });
    expect(d.decisionType).toBe("RELEASE");
  });

  test("candidate with entitlement → SELECT", () => {
    const d = evaluate({
      intent: makeIntent(),
      candidates: [makeCandidate({ entitlementValid: true })],
      evaluationTime: EVAL_TIME,
    });
    expect(d.decisionType).toBe("SELECT");
    expect(d.reasonCodes).toContain("ENTITLEMENT_VALID");
    expect(d.reasonCodes).toContain("MEETS_POLICY");
  });

  test("scoring is normalized 0..100", () => {
    const s = __scoring;
    expect(s.scoreLatency(0)).toBe(100);
    expect(s.scoreLatency(300)).toBe(0);
    expect(s.scoreReliability(1)).toBe(100);
    expect(s.scoreReliability(0)).toBe(0);
  });
});

// ── Decision Engine: Hysteresis ─────────────────────────────────────────────
describe("Decision engine hysteresis", () => {
  test("hysteresis threshold is 10", () => {
    expect(HYSTERESIS_THRESHOLD).toBe(10);
  });

  test("marginal improvement → RETAIN (not SWITCH)", () => {
    // Current session on r1 (score ~63), alternative r2 only slightly better.
    const intent = makeIntent();
    const cur = makeCandidate({
      resourceId: "r1", providerName: "Current",
      advertised: { maxDownlinkMbps: 20, maxUplinkMbps: 5, typicalLatencyMs: 80, reliability: 0.9 },
      priceCents: 50,
    });
    const alt = makeCandidate({
      resourceId: "r2", providerName: "Alt",
      advertised: { maxDownlinkMbps: 22, maxUplinkMbps: 5, typicalLatencyMs: 78, reliability: 0.91 },
      priceCents: 50,
    });
    const d = evaluate({
      intent,
      candidates: [cur, alt],
      evaluationTime: EVAL_TIME,
      currentSession: {
        sessionId: "s1", resourceId: "r1", providerId: "p1",
        advertised: cur.advertised, priceCents: 50,
      },
    });
    // The delta is small → should RETAIN, not SWITCH.
    expect(d.decisionType).toBe("RETAIN");
    expect(d.reasonCodes).toContain("INSUFFICIENT_IMPROVEMENT");
  });

  test("large improvement → SWITCH", () => {
    const intent = makeIntent();
    const cur = makeCandidate({
      resourceId: "r1", providerName: "Current",
      advertised: { maxDownlinkMbps: 10, maxUplinkMbps: 2, typicalLatencyMs: 200, reliability: 0.7 },
      priceCents: 100,
    });
    const alt = makeCandidate({
      resourceId: "r2", providerName: "Alt",
      advertised: { maxDownlinkMbps: 100, maxUplinkMbps: 30, typicalLatencyMs: 25, reliability: 0.99 },
      priceCents: 50,
    });
    const d = evaluate({
      intent,
      candidates: [cur, alt],
      evaluationTime: EVAL_TIME,
      currentSession: {
        sessionId: "s1", resourceId: "r1", providerId: "p1",
        advertised: cur.advertised, priceCents: 100,
      },
    });
    expect(d.decisionType).toBe("SWITCH");
    expect(d.reasonCodes).toContain("BETTER_SCORE_AFTER_SWITCHING_COST");
  });
});

// ── Measurement: advertised ≠ observed ──────────────────────────────────────
describe("Measurement separation", () => {
  test("advertised is never confused with observed", () => {
    const advertised: AdvertisedCapability = {
      maxDownlinkMbps: 500, maxUplinkMbps: 100, typicalLatencyMs: 10, reliability: 0.99,
    };
    const observed = {
      latencyMs: 45, downlinkMbps: 120, observedAt: "2026-01-01T00:00:00Z", source: "adapter",
    };
    // The decision engine PREFERS observed over advertised.
    const d = evaluate({
      intent: makeIntent(),
      candidates: [makeCandidate({ advertised, measurement: observed })],
      evaluationTime: EVAL_TIME,
    });
    // The candidate's reported latency/downlink should be the OBSERVED values, not advertised.
    const c = d.candidates[0];
    expect(c.latencyMs).toBe(45);
    expect(c.downlinkMbps).toBe(120);
    // Advertised 500Mbps must NOT appear as the candidate's downlink.
    expect(c.downlinkMbps).not.toBe(500);
  });
});
