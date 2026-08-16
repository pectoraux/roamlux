# ADR-007 — Deterministic Decision Engine

**Status:** Accepted
**Date:** Architecture freeze

## Context

A connectivity platform that automatically selects and switches providers must be
auditable, testable, and free of "the algorithm decided" black boxes. If the
decision function is non-deterministic (e.g. an LLM call, a random tiebreak, a
time-of-day heuristic with hidden state), then:

- The same intent at two different times may produce two different decisions with
  no explainable reason, eroding user trust.
- A bad decision cannot be reproduced in a test, so it cannot be fixed.
- Regulators and partners cannot be shown *why* a switch happened.

At the same time, naive "pick the highest score" is wrong: switching providers has
a real cost (activation fee, brief interruption, battery drain, user-visible
reconnect). The engine must resist flapping between marginally different candidates.

## Decision

The decision engine is a pure function:

```ts
// src/domain/control-plane/decision-engine.ts
export function evaluate(input: EvaluationInput): DecisionResult
```

Same input ⇒ same output. No I/O, no `Date.now()` in scoring, no randomness.

### Scoring weights (explicit, tunable, NOT learned)

```ts
const W = { latency: 0.30, throughput: 0.25, reliability: 0.25, cost: 0.20 };
```

Each metric is normalized to 0..100 (higher = better):
- **Latency:** `100 - (latencyMs/300)*100`. 0 ms → 100, 300 ms → 0.
- **Throughput:** `(downlinkMbps/100)*100`, with a 0.4× penalty if below a stated
  need.
- **Reliability:** `reliability * 100` (e.g. 0.86 → 86).
- **Cost:** `100 - (priceCents/500)*100`. $0 → 100, $5 → 0. 0.3× penalty above
  budget.

`rawScore = clamp(W.latency*sLat + W.thr*sThr + W.rel*sRel + W.cost*sCost, 0, 100)`.

### Switching cost and hysteresis

Candidates that are not the current session pay a switching cost:

```ts
const DEFAULT_SWITCHING_COST: SwitchingCostModel = {
  activationCostCents: 50,   // $0.50
  interruptionRisk: 4,       // points
  batteryPenalty: 1,         // point
  policyPenalty: 0,          // 1000 if intent.preferences.allowAutoSwitch === false
};
```

`effectiveScore = rawScore - switchingCost`.

**Hysteresis threshold = 10.** A switch only fires when
`best.effectiveScore - currentScore >= HYSTERESIS_THRESHOLD`. Below that, the
decision is `RETAIN` with reason code `INSUFFICIENT_IMPROVEMENT`.

### Decision types and reason codes

`DecisionType ∈ { SELECT, SWITCH, RETAIN, RELEASE }`. Every decision carries
`reasonCodes: ReasonCode[]` from a closed enum:

```
LOWER_LATENCY | HIGHER_THROUGHPUT | LOWER_COST | HIGHER_RELIABILITY |
MEETS_POLICY | POLICY_VIOLATION | BETTER_SCORE_AFTER_SWITCHING_COST |
INSUFFICIENT_IMPROVEMENT | NO_CANDIDATES | ENTITLEMENT_VALID |
ENTITLEMENT_MISSING | AVAILABILITY_OK | AVAILABILITY_NONE
```

### AI never the authority

LLM surfaces (present or future) may *propose* intents, *summarize* audit logs, or
*narrate* decisions in natural language. They never replace `evaluate()`. The
decision is always reconstructible from inputs: `intent + candidates +
currentSession → DecisionResult`. This is enforced by the fact that `evaluate` is a
pure function with no LLM imports.

### Viability filter

A candidate is viable for selection only if it satisfies all three:
`reasons.includes("AVAILABILITY_OK") && reasons.includes("ENTITLEMENT_VALID") &&
meetsPolicy`. Non-viable candidates are still returned in the `candidates` array
for transparency but cannot be selected.

## Consequences

**Positive**
- Every decision is reproducible: persist the `Decision` row (which the
  `/api/decisions` route does) and the inputs are reconstructible from the
  intent + candidate state at that time.
- Reason codes give a closed vocabulary for explanation, audit, and UI surfacing.
- Hysteresis prevents flapping between MOCK_A (cheap, 8% failure) and MOCK_B
  (reliable, 2% failure) under normal conditions.
- Tuning weights is a one-line change with predictable blast radius.

**Negative**
- The weights are global, not per-tenant. An enterprise that prioritises reliability
  above all cannot override the weights today; it can only express that via
  `intent.policy.minReliability` and `intent.preferences.prioritize`, which the
  engine honours as hard gates rather than score multipliers. A future enhancement
  could load weights from a `Policy` table.

**Risks**
- If the candidate set is small (one provider), the engine will `SELECT` it even
  if it violates policy (because `viable` could be empty and the engine returns
  `RELEASE` with `NO_CANDIDATES`). This is correct — the platform should not
  activate a non-viable resource — but the UX must explain it.
- The hysteresis threshold is a magic number (10). It is exported as
  `HYSTERESIS_THRESHOLD` and could be moved to a per-tenant policy in future
  without changing the engine signature.
