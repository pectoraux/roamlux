# ADR-004 — Connectivity Session

**Status:** Accepted
**Date:** Architecture freeze

## Context

A connectivity session is a long-lived, observable, stateful object. Without an
explicit state machine it degenerates into a row of booleans (`isActive`,
`isSuspended`, `isProvisioning`, `isTerminated`, `hasFailed`) that can represent
illegal states (e.g. `isActive=true && isTerminated=true`) and that no two engineers
will transition consistently.

Compounding this, connectivity sessions have a real-world side: a provider API call
has been made (or attempted), packets may be flowing, money is being spent. The
database row must be a faithful model of that real-world state, and transitions must
be auditable and recoverable.

## Decision

`ConnectivitySession` has an explicit `SessionState` enum and a transition graph
defined in `src/domain/kernel/state-machines.ts`. No boolean status fields exist.

```
REQUESTED → PROVISIONING → ACTIVE → SUSPENDED → ACTIVE (resume)
                  │           │       │
                  │           ├──→ TERMINATED (terminal)
                  │           └──→ FAILED → PROVISIONING (retry)
                  └──→ FAILED
```

- **States:**
  - `REQUESTED` — session row created, no provider call yet.
  - `PROVISIONING` — adapter `ACTIVATE` invoked, awaiting result.
  - `ACTIVE` — adapter returned success; measurement snapshot recorded.
  - `SUSPENDED` — `SUSPEND` action invoked (provider-supported only).
  - `TERMINATED` — terminal. `DEACTIVATE`/`RELEASE` was invoked.
  - `FAILED` — recoverable. Adapter returned an error or an illegal transition was
    detected. May retry via `PROVISIONING`.

- **Enforcement:** every state change goes through
  `assertSessionTransition(from, to)` (throws `IllegalTransitionError`). The
  session-service wraps each transition in a Prisma transaction that appends a
  `SessionTransition` row (`from`, `to`, `reason`, `actor`, `actionId`) and updates
  the session's `state`. Direct `db.connectivitySession.update({ state: ... })`
  calls are forbidden outside this path.

- **Snapshot fields** on the session row: `startedAt`, `endedAt`,
  `currentQuality` (JSONB; latest `MeasurementSnapshot` for convenience only),
  `currentCostCents` (running tally), `policy` JSONB, `failureReason`.

- **Recovery:** a `FAILED` session may be re-provisioned. The session-service's
  `createSessionFromDecision` creates a fresh `REQUESTED → PROVISIONING → ACTIVE`
  sequence; a `FAILED` reservation may transition `FAILED → RESERVED` to retry.

## Consequences

**Positive**
- Illegal states are unrepresentable. `isActive && isTerminated` cannot be persisted.
- Every state change is auditable via `SessionTransition` (append-only).
- Recovery is a first-class concept (`FAILED → PROVISIONING`), not an exception
  path.
- The mock adapter's deterministic failure rate (8% for Atlas, 2% for Beacon, 0%
  for Crest) exercises this path naturally; the system must handle `FAILED` as a
  normal outcome.

**Negative**
- Two writes per transition (audit row + state update). Mitigated by a single
  `db.$transaction([...])`.
- The retry edge `FAILED → PROVISIONING` requires a fresh `idempotencyKey` so the
  adapter doesn't deduplicate the retry as a no-op. The session-service generates
  keys like `activate::sessionId` for the first attempt; retries use a fresh
  `randomUUID`-suffix, which is intentional (the previous attempt genuinely failed).

**Risks**
- If the adapter returns success but the network drops before the kernel can
  transition `PROVISIONING → ACTIVE`, the session is left in `PROVISIONING`. A
  future reconciliation worker (Layer 11) will need to probe and either complete
  or fail the session. The schema supports this: `currentQuality` is null until
  the first measurement is recorded.
