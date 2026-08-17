# ADR-011 — Reconciliation Model

**Status:** Accepted
**Date:** Architecture freeze

## Context

RoamLink integrates with external systems — provider APIs (MikroTik, eSIM
aggregators), payment processors, future webhooks — that are unreliable in
well-understood ways: network timeouts, partial failures, eventual consistency,
out-of-order delivery, and silent state drift. If the platform treats these as
reliable, it will:

- Double-charge users on retried activation requests.
- Leave sessions in `PROVISIONING` forever when the adapter returns success but
  the response is lost.
- Lose audit events when a downstream webhook is unreachable.
- Drift between provider-truth and RoamLink-truth over time, with no detection.

The platform's source of truth must be its own database. External systems are
translators, not authorities.

## Decision

Four interlocking mechanisms: idempotency keys, recoverable state machines,
outbox events, and audit. Together they make every side-effecting operation
safe to retry and safe to inspect.

### 1. Idempotency keys

- `Reservation.idempotencyKey` is `@unique`. The session-service composes keys
  like `reserve::subjectId::intentId::resourceId`. A retried reservation request
  finds the existing row and returns it rather than creating a duplicate.
- Adapter invocations use keys like `activate::sessionId` (first attempt) or
  `<action>::sessionId::randomUUID-suffix` (retries after failure). The mock
  adapter dedupes ACTIVATE/RESERVE on the same key — duplicate calls return the
  original successful state with `idempotent: true, reconciled: true`.
- `OutboxEvent` rows are keyed by their `id` (cuid) and deduplicated at the
  application layer by `type` + `payload` hashing if needed in future.

### 2. Recoverable state machines

Both `Reservation` and `ConnectivitySession` graphs include explicit retry edges
(see ADR-004):

```
Reservation:  FAILED → RESERVED (retry)
Session:      FAILED → PROVISIONING (retry)
```

- A failed activation marks the reservation `FAILED` with `failureReason` set —
  it does not delete it.
- A `FAILED` session is a normal state, not an exception. The UI can offer
  "retry" which re-enters `PROVISIONING` with a fresh idempotency key.
- Terminal states (`TERMINATED`, `RELEASED`, `EXPIRED`) have no outgoing edges —
  these are the reconciliation anchors. Once a session is `TERMINATED`, no
  future reconciliation will move it.

### 3. Outbox events

`emitEvent(type, payload)` in `src/lib/audit.ts` writes a row to `OutboxEvent`
with `status=PENDING`. The outbox table is the durable handoff to any
downstream consumer (webhook dispatcher, analytics pipeline, notification
service).

Schema:
```prisma
model OutboxEvent {
  id           String       @id @default(cuid())
  type         String       // "WaitlistEntryApproved" | "SessionStarted" | ...
  payload      Json
  status       EventStatus  @default(PENDING)   // PENDING | PUBLISHED | FAILED
  attempts     Int          @default(0)
  lastError    String?
  createdAt    DateTime     @default(now())
  publishedAt  DateTime?
}
```

- Events emitted today: `WaitlistEntryCreated`, `WaitlistEntryApproved`,
  `WaitlistEntryConverted`, `UserCreated`, `EntitlementCreated`,
  `ResourceReserved`, `SessionStarted`, `MeasurementRecorded`,
  `ActionCompleted`, `ProvisioningFailed`.
- **A drainer worker (Layer 11, not in MVP)** will poll `status=PENDING`,
  attempt publication, increment `attempts`, set `lastError` on failure, and
  mark `PUBLISHED` with `publishedAt` on success. Events that exceed a max
  attempt count are marked `FAILED` for manual inspection.
- The outbox is written in the same logical operation as the state change (e.g.
  the session-service calls `emitEvent` immediately after the transition). In
  the MVP this is two queries, not a transaction; a future enhancement could
  wrap them in `db.$transaction` to guarantee atomicity.

### 4. Audit

`audit(params)` writes a row to `AuditLog` with `actorId`, `actorType`,
`action`, `targetType`, `targetId`, `result` ("success"|"failure"), `reason`,
`correlationId`, `requestId`, `metadata`.

- Every important action is audited: `waitlist.approve`, `waitlist.reject`,
  `waitlist.convert`, `user.create`, `session.activate`, `session.suspend`,
  `session.resume`, `session.release`, `session.measure`,
  `session.action.illegal`, `session.fail`, `entitlement.create`.
- Non-user actors ("system") are coerced to `actorId=null` with
  `actorType="system"`.
- **Audit writes are wrapped in try/catch and never throw to the caller.**
  Audit must not break the primary operation. Failures are logged to console
  for the MVP; a future enhancement could enqueue them to a dead-letter table.
- `AuditLog` has indexes on `(action, at)` and `(actorId, at)` for fast query
  from the admin UI.

### External integrations are unreliable

This is the overarching principle. Concretely:
- The mock adapter's per-process in-memory activation store does not survive a
  Vercel cold start. The kernel relies on `idempotencyKey` + the persisted
  `Reservation`/`Session` state to reconcile — a retried activation finds the
  existing reservation and either reuses its session or starts a new one.
- Real adapters (MikroTik, eSIM) will be even less reliable. The contract
  (`AdapterActionResult.reconciled`) lets an adapter signal "I checked the
  provider; the state I'm returning is reconciled with provider-truth".
- A future reconciliation worker will periodically probe sessions stuck in
  `PROVISIONING` for too long, query the adapter for true state, and either
  complete or fail them.

## Consequences

**Positive**
- Every side-effecting operation is safe to retry. The `/api/decisions` and
  `/api/sessions/[id]/actions` routes can be called multiple times without
  corrupting state.
- Audit + outbox together provide a complete activity trail: audit for
  "what happened in RoamLink", outbox for "what RoamLink told the outside
  world".
- A failed external call leaves the system in a known state (`FAILED`,
  recoverable) rather than an inconsistent one.
- Future workers can be added without schema changes — the outbox and audit
  tables are already the contract.

**Negative**
- Two writes per state change (audit row + outbox row + state update). On
  Vercel serverless with Neon pooled Postgres this is ~10-30 ms total. Acceptable
  for MVP.
- The MVP does not yet have a drainer worker, so outbox events accumulate in
  `PENDING`. They are queryable and the schema supports the future worker
  without migration.

**Risks**
- If `emitEvent` and the state update are not in a transaction, a crash between
  them leaves the system in a state where the event was not emitted but the
  state changed (or vice versa). Mitigation: the audit/outbox writes are
  designed to be idempotent and re-derivable from state; a future reconciliation
  worker can detect mismatches by comparing `SessionTransition` rows to
  `OutboxEvent` rows of type `ActionCompleted`.
- Without a drainer, downstream consumers don't receive events. The MVP
  surface (the SPA) reads state directly from the API; outbox is a forward
  contract, not a runtime dependency.
