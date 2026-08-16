# ADR-001 — Protocol / Kernel Boundary

**Status:** Accepted
**Date:** Architecture freeze

## Context

RoamLink must persist domain state in a relational database (PostgreSQL via Neon,
modeled in `prisma/schema.prisma`) while simultaneously exposing a typed domain
contract that is stable across implementations. Two failure modes were observed in
early sketches:

1. Treating Prisma models as *the* domain contract — every refactor of a column
   rippled into API callers and adapters.
2. Treating state transitions as scattered booleans on the session row
   (`isActive`, `isSuspended`, `isProvisioning`, ...) which made illegal states
   representable and produced silent data corruption.

We need a clean separation between (a) the **protocol**: the typed contract of what
flows through the system, and (b) the **kernel**: the state-machine enforcement of
which transitions are legal.

## Decision

The protocol and the kernel live in `src/domain/` and depend on **nothing** outside
that directory except TypeScript types and the `@prisma/client` enum types. They are
the public contract; everything else depends on them, never the reverse.

- `src/domain/protocol.ts` defines the typed contracts:
  `ConnectivityIntentPayload`, `AdvertisedCapability`, `MeasurementSnapshot`,
  `ActionType` (closed vocabulary of 11 actions), `DecisionResult`,
  `ScoredCandidate`, `ReasonCode`, `AdapterDescriptor`, `AdapterActionResult`.
- `src/domain/kernel/state-machines.ts` defines the `Reservation` and
  `ConnectivitySession` transition graphs as `Record<State, State[]>` and exports
  `assertReservationTransition` / `assertSessionTransition` that throw
  `IllegalTransitionError` on illegal moves.
- The Prisma schema *persists* these concepts (e.g. `ConnectivitySession.state` is
  the `SessionState` enum) but does not *define* them. The schema may store
  additional denormalized fields (`currentQuality` JSONB) for convenience; the
  protocol remains the source of truth.
- The kernel is invoked only through `src/lib/services/session-service.ts`, which
  wraps each transition in a transaction with a `SessionTransition` audit row.

## Consequences

**Positive**
- The protocol can be unit-tested with no database, no Prisma, no Next.js — it is a
  pure TypeScript module.
- The kernel's state graphs are tiny data structures; adding a state (e.g.
  `THROTTLED`) is a one-line change with a compile-checked fallthrough.
- Adapters and the control plane import from `@/domain/protocol` only, never from
  `@prisma/client` runtime values. They are reusable outside Next.js.

**Negative**
- Some duplication between Prisma enums (`SessionState`) and protocol types
  (`SessionState` is re-exported via `@prisma/client`). This is intentional: the
  protocol avoids runtime imports of Prisma.
- Engineers must learn that `assertSessionTransition` is the only legitimate way to
  move a session forward. Direct `db.connectivitySession.update` on `state` is a
  code-review smell.

**Risks**
- If a future feature needs an ORM-side trigger (e.g. Postgres-level constraint), it
  will need to be reconciled with the kernel's view of legal transitions. Mitigation:
  keep the kernel as the sole writer of `state` fields.
