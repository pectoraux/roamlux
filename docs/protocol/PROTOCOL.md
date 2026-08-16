# RoamLink Protocol

**Status:** Authoritative
**Source of truth:** [`src/domain/protocol.ts`](../../src/domain/protocol.ts)

The protocol is the **public, typed contract** of the RoamLink Connectivity
Operating System. It defines what flows through the system; the Prisma schema
persists it but does not define it. Adapters, the control plane, the kernel, and
the API layer all import from `@/domain/protocol` and never from runtime Prisma
values.

This document is a navigable summary of that file. For the canonical definitions,
read the source. Every type below is exported from `src/domain/protocol.ts`.

---

## 1. Why a separate protocol module?

Three reasons (defended in [ADR-001](../adr/ADR-001-protocol-kernel-boundary.md)):

1. **Stability.** The protocol can be unit-tested without a database, without
   Prisma, without Next.js. Refactors of the schema do not ripple into callers
   that depend on the protocol.
2. **Portability.** The same protocol can be consumed by a future CLI, a
   standalone worker, or a different runtime — it has no Next.js imports.
3. **Clarity.** Ten distinct concepts (Intent, Capability, Resource, Offer,
   Entitlement, Reservation, ConnectivitySession, Measurement, Decision,
   Policy) are encoded as ten distinct types. They are never collapsed into a
   single "Product" or "Order".

---

## 2. Intent — what the user wants

The intent is the input to the entire pipeline. It never names a provider.

```ts
export type ConnectivityCapabilityType =
  | "internet" | "wifi" | "lte" | "esim_data"
  | "isp" | "satellite" | "shared_bandwidth";

export interface ConnectivityIntentPayload {
  capability: ConnectivityCapabilityType;
  location: LocationSpec;
  timeWindow: TimeWindowSpec;
  usage: UsageSpec;
  constraints: ConstraintSpec;
  preferences: PreferenceSpec;
  policy?: PolicySpec;
}
```

### 2.1 `LocationSpec`

```ts
export interface LocationSpec {
  country: string;   // ISO-3166 alpha-2 ("GH", "NG", "US")
  region?: string;   // free-form ("West Africa", "NA")
  lat?: number;
  lng?: number;
}
```

### 2.2 `TimeWindowSpec`

```ts
export interface TimeWindowSpec {
  start: string;     // ISO 8601
  end?: string;
  tz?: string;       // IANA name ("Africa/Accra")
}
```

### 2.3 `UsageSpec`

```ts
export interface UsageSpec {
  downlinkMbps?: number;
  uplinkMbps?: number;
  dataGB?: number;
}
```

### 2.4 `ConstraintSpec` (hard gates)

```ts
export interface ConstraintSpec {
  maxLatencyMs?: number;
  minReliability?: number;       // 0..1
  maxCostCents?: number;
  allowRoaming?: boolean;
}
```

### 2.5 `PreferenceSpec` (soft steering)

```ts
export interface PreferenceSpec {
  prioritize?: "cost" | "quality" | "reliability";
  allowAutoSwitch?: boolean;     // false ⇒ engine forbids switching (policyPenalty=1000)
}
```

### 2.6 `PolicySpec` (extends `ConstraintSpec`)

```ts
export interface PolicySpec extends ConstraintSpec {
  minimumThroughputMbps?: number;
  maximumInterruptionSeconds?: number;
}
```

When `intent.policy` is present, it overrides `intent.constraints` for policy
evaluation in the decision engine (see `meetsPolicy()` in
`src/domain/control-plane/decision-engine.ts`).

---

## 3. Capability — what a provider can technically provide

Distinct from commercial terms (Offer, see [ADR-002](../adr/ADR-002-capability-vs-offer.md)).

```ts
export interface AdvertisedCapability {
  maxDownlinkMbps: number;
  maxUplinkMbps: number;
  typicalLatencyMs: number;
  reliability: number;          // 0..1
  availabilityPct?: number;     // 0..100
}

export interface CoverageSpec {
  countries: string[];          // ISO-3166 alpha-2, or ["*"] for global
  regions?: string[];
}
```

The `Capability` Prisma model persists `advertised` and `coverage` as JSONB
columns matching these shapes.

---

## 4. Measurement — observed truth on the wire

Distinct from advertised values (see [ADR-006](../adr/ADR-006-measurement-model.md)).

```ts
export interface MeasurementSnapshot {
  latencyMs?: number;
  downlinkMbps?: number;
  uplinkMbps?: number;
  packetLossPct?: number;
  jitterMs?: number;
  availabilityPct?: number;
  observedAt: string;           // ISO 8601
  source: string;               // "mock_adapter_observed" | "advertised_fallback" | "client_speedtest" | ...
}
```

The `source` field is critical: it lets consumers distinguish a real observation
from an advertised-value fallback. The decision engine tags fallbacks with
`source: "advertised_fallback"` so downstream code knows the score is
provisional.

---

## 5. The Generic Action Vocabulary

The closed vocabulary the kernel speaks. Adapters translate; they do not extend
it. See [ADR-005](../adr/ADR-005-adapter-contract.md).

```ts
export type ActionType =
  | "DISCOVER"
  | "RESERVE"
  | "ACTIVATE"
  | "DEACTIVATE"
  | "SWITCH"
  | "RENEW"
  | "SUSPEND"
  | "RESUME"
  | "RELEASE"
  | "TRANSFER"
  | "MEASURE";

export const ALL_ACTIONS: ActionType[] = [
  "DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "SWITCH",
  "RENEW", "SUSPEND", "RESUME", "RELEASE", "TRANSFER", "MEASURE",
];
```

### 5.1 Action semantics

| Action | Effect | Typical pre-state | Typical post-state |
|---|---|---|---|
| `DISCOVER` | Query provider for currently available resources/capabilities. Read-only. | n/a | n/a |
| `RESERVE` | Hold a resource against an intent + entitlement for a bounded time. | `AVAILABLE` | `RESERVED` |
| `ACTIVATE` | Provision the resource for live connectivity. Returns a `MeasurementSnapshot`. | `PROVISIONING` | `ACTIVE` |
| `DEACTIVATE` | Tear down a live session. | `ACTIVE` | `TERMINATED` |
| `SWITCH` | Atomically swap one resource for another (provider-native only; not in MVP mock A). | `ACTIVE` | `ACTIVE` (different resource) |
| `RENEW` | Extend a reservation/subscription. | `ACTIVE` | `ACTIVE` (extended) |
| `SUSPEND` | Pause a live session without tearing it down. | `ACTIVE` | `SUSPENDED` |
| `RESUME` | Unpause a suspended session. | `SUSPENDED` | `ACTIVE` |
| `RELEASE` | Free a held resource (reserved but never activated, or after deactivation). | `RESERVED`/`ACTIVE` | `RELEASED` |
| `TRANSFER` | Move an entitlement to a different subject. | n/a | n/a |
| `MEASURE` | Take a fresh observation; append a `Measurement` row. | any | unchanged (data only) |

### 5.2 Adapter-declared support

Each `Provider` row carries `supportedActions: String[]`. The kernel **never
assumes all actions are supported**. The session-service's `executeAction`
checks `adapter.descriptor.supportedActions.includes(action)` before invoking
and returns `ACTION_NOT_SUPPORTED` otherwise.

The `/api/sessions/[id]/actions` route further restricts to a safe subset:
`["DEACTIVATE", "MEASURE", "SUSPEND", "RESUME", "RELEASE", "RENEW"]` — i.e. it
does not expose `ACTIVATE`, `SWITCH`, `DISCOVER`, `TRANSFER` via that endpoint
(those are initiated through the decision → session-creation flow).

### 5.3 Mock provider support matrix

| Code | Name | Supported actions |
|---|---|---|
| `MOCK_A` | Atlas WiFi Co-op | `DISCOVER, RESERVE, ACTIVATE, DEACTIVATE, MEASURE, RELEASE` |
| `MOCK_B` | Beacon Mobile (LTE) | adds `RENEW, SUSPEND, RESUME` |
| `MOCK_C` | Crest eSIM Premium | adds `SWITCH, RENEW` |

---

## 6. Adapter Contract

```ts
export interface AdapterDescriptor {
  providerCode: string;
  providerName: string;
  type: "MOCK" | "MIKROTIK" | "ESIM";
  supportedActions: ActionType[];
}

export interface AdapterActionResult {
  ok: boolean;
  providerResourceId?: string;
  state: string;              // provider-native state name
  measurement?: MeasurementSnapshot;
  error?: string;
  idempotent: boolean;        // true if the result was a dedup of an earlier call
  reconciled?: boolean;       // true if the adapter verified against provider-truth
}
```

The registry (`src/domain/adapters/registry.ts`) resolves a `Provider` to an
`AdapterHandle`:

```ts
export interface AdapterHandle {
  descriptor: AdapterDescriptor;
  execute(
    action: ActionType,
    opts: { providerResourceId: string; idempotencyKey: string }
  ): AdapterActionResult;
}
```

The `idempotencyKey` is the deduplication anchor (see
[ADR-011](../adr/ADR-011-reconciliation-model.md)). The mock adapter uses it to
return identical results for duplicate `ACTIVATE`/`RESERVE` calls.

---

## 7. Decision — output of the deterministic engine

```ts
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
  rawScore: number;             // 0..100, before switching cost
  switchingCost: number;        // points subtracted for non-current candidates
  effectiveScore: number;       // rawScore - switchingCost
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
  effectiveDelta?: number;      // scoreTarget - scoreCurrent
  reasonCodes: ReasonCode[];
  policyMet: boolean;
  candidates: ScoredCandidate[]; // ALL candidates, including non-viable, for transparency
}
```

The decision engine is a pure function `evaluate(input: EvaluationInput):
DecisionResult` (see [ADR-007](../adr/ADR-007-deterministic-decision-engine.md)).
The `/api/decisions` route persists a `Decision` row capturing
`decisionType`, `scoreCurrent`, `scoreTarget`, `switchingCost`,
`effectiveDelta`, `reasonCodes`, `policyMet`, `decidedBy`.

---

## 8. Reason Code Reference

| Code | Meaning |
|---|---|
| `LOWER_LATENCY` | Target has lower latency than current. |
| `HIGHER_THROUGHPUT` | Target has higher downlink than current. |
| `LOWER_COST` | Target has lower price than current. |
| `HIGHER_RELIABILITY` | Target has higher advertised reliability than current. |
| `MEETS_POLICY` | Candidate satisfies all `policy`/`constraints` gates. |
| `POLICY_VIOLATION` | Candidate violates at least one policy gate. |
| `BETTER_SCORE_AFTER_SWITCHING_COST` | Target's effective score beats current's by ≥ hysteresis. |
| `INSUFFICIENT_IMPROVEMENT` | Target's effective score does not beat current's by ≥ hysteresis (10). Decision is `RETAIN`. |
| `NO_CANDIDATES` | No viable candidates (available + entitled + meets policy). Decision is `RELEASE`. |
| `ENTITLEMENT_VALID` | Subject has an active entitlement for the candidate's offer. |
| `ENTITLEMENT_MISSING` | Subject lacks an entitlement for the candidate's offer. |
| `AVAILABILITY_OK` | Resource is in `available` or `active` state. |
| `AVAILABILITY_NONE` | Resource is not available. |

---

## 9. Versioning

The protocol is append-only. Adding an `ActionType` or a `ReasonCode` is a
backward-compatible change (closed unions grow at the edges). Removing or
renaming a member is a breaking change and requires a new ADR.

The Prisma schema may add fields to its JSONB columns without breaking the
protocol (JSONB is schemaless at the column level). Removing a JSONB field that
the protocol reads is a breaking change and must be coordinated with a protocol
version bump.
