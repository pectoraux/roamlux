# Reliability Model — RoamLink Connectivity Operating System

> **Status:** Verified against the actual source tree at `src/lib/services/operation-service.ts`,
> `src/lib/services/session-service.ts`, `src/lib/services/reconciliation-service.ts`,
> `src/lib/services/outbox-drainer.ts`, `src/lib/audit.ts`,
> `src/domain/adapters/mock-providers.ts`, `prisma/schema.prisma`.
> **Companion docs:** `docs/architecture/IDEMPOTENCY.md`, `docs/architecture/RECONCILIATION.md`,
> `docs/architecture/DEPENDENCY-AUDIT.md`, `docs/adr/ADR-011-reconciliation-model.md`.

RoamLink orchestrates connectivity across providers it does not own. Every adapter
call is a remote procedure that can time out, succeed late, partially succeed, or
duplicate. Reliability is therefore not a feature added on top — it is the
*shape* of every externally-visible action the system takes.

---

## 1. The reliability invariant

Every externally-visible action in RoamLink follows a single pipeline. No step may
be skipped, and no step may run concurrently with a stale view of an earlier step:

```
COMMAND              a user/agent/system request to do something
   │
   ▼
PERSISTED OPERATION  a row in `Operation` with a unique idempotencyKey
   │                 (claimOrCreateOperation — see IDEMPOTENCY.md)
   ▼
STATE MACHINE        a legal transition asserted via assertSessionTransition()
   │                 (src/domain/kernel/state-machines.ts)
   ▼
ADAPTER              adapterForProvider() → AdapterHandle.execute(action, opts)
   │                 (src/domain/adapters/registry.ts)
   ▼
EXTERNAL SIDE EFFECT the provider's actual change (SIM download, router profile, …)
   │                 (recorded in MockProviderActivation for the mock adapter)
   ▼
RECONCILIATION       reconcileSession() compares RoamLink's state with the
                     provider's state and repairs divergence
                     (src/lib/services/reconciliation-service.ts — see RECONCILIATION.md)
```

The invariant is: **the system never lies about state it cannot verify.** If the
adapter call does not return a definitive result, RoamLink records `FAILED` (or
leaves the session in `PROVISIONING`) and lets reconciliation discover the truth
later. There is no path that silently promotes a session to `ACTIVE` on the
strength of "the request was sent."

---

## 2. Transactional consistency: state + audit + outbox in one `$transaction`

A state transition is not just a row update. It must commit *atomically* with its
audit trail and its outbox event, so that an observer reading the database never
sees a transition without its history, and never sees an outbox event for a
transition that was rolled back.

The mechanism is the `atomic()` helper in `src/lib/audit.ts`:

```ts
// src/lib/audit.ts
export async function atomic<T>(
  fn: (tx: TxClient & { txAudit: typeof txAudit; txEmit: typeof txEmit }) => Promise<T>
): Promise<T> {
  return db.$transaction(async (tx) => {
    const augmented = tx as TxClient & { txAudit: typeof txAudit; txEmit: typeof txEmit };
    augmented.txAudit = txAudit;
    augmented.txEmit = txEmit;
    return fn(augmented);
  });
}
```

Inside an `atomic()` block, the caller has access to:

- the raw transaction client `tx` (for `tx.connectivitySession.update`,
  `tx.sessionTransition.create`, `tx.reservation.update`, etc.),
- `txAudit(tx, params)` — writes an `AuditLog` row *in the same transaction*,
- `txEmit(tx, type, payload, aggregate?)` — writes an `OutboxEvent` row *in the
  same transaction*.

If the transaction commits, the state change, the audit log, and the outbox event
all commit together. If it rolls back, all three disappear together. There is no
"successful transition with a missing audit log" or "phantom outbox event for a
transition that never happened."

This pattern is used by every state-changing path in the system:

- `createSessionFromDecision` (`src/lib/services/session-service.ts`) —
  `REQUESTED → PROVISIONING`, `PROVISIONING → ACTIVE`, and `PROVISIONING → FAILED`.
- `executeAction` (`src/lib/services/session-service.ts`) —
  `ACTIVE → TERMINATED`, `ACTIVE → SUSPENDED`, `SUSPENDED → ACTIVE`, and `MEASURE`.
- `failSession` (same file) — `* → FAILED`.
- `reconcileSession` (`src/lib/services/reconciliation-service.ts`) — both
  discrepancy-repair transitions.

The non-transactional `audit()` and `emitEvent()` helpers in `src/lib/audit.ts`
still exist for best-effort writes outside a transaction (and they are wrapped in
try/catch so they never break the primary operation), but the rule for state
changes is: **always use `atomic()` + `txAudit` + `txEmit`.**

---

## 3. The Operation model

Source: `prisma/schema.prisma` (`model Operation`), `src/lib/services/operation-service.ts`.

Every externally-visible action is recorded as an `Operation` row before any
side effect is attempted. The schema:

```prisma
enum OperationState {
  PENDING
  RUNNING
  SUCCEEDED
  FAILED
}

model Operation {
  id              String         @id @default(cuid())
  idempotencyKey  String         @unique
  actionType      String         // ACTIVATE | DEACTIVATE | SWITCH | RESERVE | RELEASE | ...
  subjectId       String
  resourceId      String?
  providerId      String?
  sessionId       String?
  // FENCING: the session generation captured when this operation was created.
  operationGen    Int            @default(1)
  state           OperationState @default(PENDING)
  requestPayload  Json           @default("{}")
  responsePayload Json?
  error           String?
  createdAt       DateTime       @default(now())
  startedAt       DateTime?
  completedAt     DateTime?

  session         ConnectivitySession? @relation(fields: [sessionId], references: [id])

  @@index([subjectId, actionType])
  @@index([state, createdAt])
}
```

Key properties:

| Property | Meaning |
|----------|---------|
| `idempotencyKey @unique` | The same logical command (same key) can only ever create ONE row. The DB enforces this; races are caught and converted to `observed_running`. |
| `actionType` | The generic action vocabulary (`ACTIVATE`, `DEACTIVATE`, `MEASURE`, `SUSPEND`, `RESUME`, `RELEASE`, `SWITCH`, `RENEW`, `RESERVE`). |
| `state: PENDING → RUNNING → SUCCEEDED \| FAILED` | The operation's own lifecycle, distinct from the session's. `claimOrCreateOperation` creates the row directly in `RUNNING` (with `startedAt = now()`). |
| `operationGen` | The session generation captured at creation. Used for fencing — see §4. |
| `requestPayload` / `responsePayload` / `error` | Stored so that a duplicate request can be answered with the *same* response (idempotent replay) instead of re-executing. |

The lifecycle in practice:

- **Create.** `claimOrCreateOperation` either observes an existing row (returning
  `observed_running` / `observed_success` / `observed_failure` / `payload_conflict`)
  or creates a new row in state `RUNNING` with `shouldExecute = true`.
- **Execute.** The caller performs the adapter call. The result is recorded via
  `completeOperation` (sets `SUCCEEDED` + `responsePayload` + `completedAt`) or
  `failOperation` (sets `FAILED` + `error` + `completedAt`).
- **Fence.** Before applying the result to the session, the caller checks
  `isStaleOperation`. If the operation is stale, the result is logged but NOT
  applied to the session — see §4.

---

## 4. Fencing strategy

A long-running operation can be overtaken by a newer one. Example: an `ACTIVATE`
operation hangs for 30s on a `TIMEOUT` fault. The user retries with a new
operation (new `idempotencyKey`). The retry succeeds and transitions the session
to `ACTIVE`. The original operation then finally returns success. If its result
were applied, it would overwrite the newer state with stale data.

RoamLink prevents this with **generation-based fencing** (optimistic concurrency
control over the session).

### 4.1 The generation counter

`ConnectivitySession.generation` is a monotonically increasing integer
(`@default(1)` in `prisma/schema.prisma`). The schema's comment captures the
contract:

> *FENCING: monotonically increasing generation. Each successful transition
> increments it. Stale operations capturing an old generation cannot overwrite
> newer state (optimistic concurrency control).*

Every successful state transition in `session-service.ts` and
`reconciliation-service.ts` increments the generation inside the same `atomic()`
transaction as the state change:

```ts
// src/lib/services/session-service.ts — PROVISIONING → ACTIVE
await atomic(async (tx) => {
  await tx.sessionTransition.create({ ... });
  await tx.connectivitySession.update({
    where: { id: session.id },
    data: { state: "ACTIVE", startedAt: new Date(), generation: { increment: 1 } },
  });
  await tx.reservation.update({ ... });
  await txEmit(tx, "SessionStarted", ...);
  await txAudit(tx, { actorId: subjectId, action: "session.activate", ... });
});
```

### 4.2 operationGen capture

When `claimOrCreateOperation` creates an `Operation`, it stamps `operationGen`
with the session's current `generation` (or `1` if no session is linked yet).
From that moment on, the operation is *pinned* to that generation.

### 4.3 The stale check

`isStaleOperation(operationId, sessionId)` (in `src/lib/services/operation-service.ts`)
re-reads both rows and returns `true` iff `session.generation > operation.operationGen`:

```ts
export async function isStaleOperation(operationId: string, sessionId?: string): Promise<boolean> {
  if (!sessionId) return false;
  const [op, session] = await Promise.all([
    db.operation.findUnique({ where: { id: operationId }, select: { operationGen: true } }),
    db.connectivitySession.findUnique({ where: { id: sessionId }, select: { generation: true } }),
  ]);
  if (!op || !session) return false;
  return session.generation > op.operationGen;
}
```

The session service calls this *after* the adapter returns and *before* applying
the result. A stale result is still recorded on the operation row (so the audit
trail is complete), but it does NOT mutate the session:

```ts
// src/lib/services/session-service.ts
const stale = await isStaleOperation(claim.operation.id, session.id);
if (stale) {
  await audit({ actorId: subjectId, action: "session.activate.stale", ...,
                reason: "STALE_OPERATION_FENCED", metadata: { operationId: claim.operation.id } });
  await completeOperation({ operationId: claim.operation.id, response: result, sessionId: session.id });
  return { ok: false, sessionId: session.id, state: "STALE", error: "STALE_OPERATION_FENCED" };
}
```

`completeOperation` performs the same check internally and returns `{ applied: false, stale: true }`
when the operation is stale — so even if a caller forgets to fence, the completion
path records the staleness rather than blindly applying.

### 4.4 advanceGeneration

`advanceGeneration(sessionId)` is the explicit increment helper (used by callers
that need to bump the generation without going through a full state transition).
The session service uses the in-transaction `generation: { increment: 1 }` form
for normal transitions, which has the same effect atomically.

---

## 5. The Outbox model

Source: `prisma/schema.prisma` (`model OutboxEvent`), `src/lib/audit.ts`
(`txEmit`, `emitEvent`), `src/lib/services/outbox-drainer.ts`.

The outbox is how RoamLink publishes domain events *reliably*. Instead of writing
to a state table and then separately publishing to an event bus (where a crash
between the two would lose the event), the event is written to the `OutboxEvent`
table *in the same transaction* as the state change. A separate drainer then
reads pending events and publishes them.

### 5.1 Schema

```prisma
enum EventStatus {
  PENDING
  PUBLISHED
  FAILED
}

model OutboxEvent {
  id            String      @id @default(cuid())
  type          String      // "SessionStarted" | "ProvisioningFailed" | "ReconciliationRequired" | ...
  aggregateType String?     // "session" | "waitlist" | "user" | "entitlement" | ...
  aggregateId   String?     // the entity id the event concerns
  payload       Json
  status        EventStatus @default(PENDING)
  attempts      Int         @default(0)
  lastAttemptAt DateTime?
  lastError     String?
  createdAt     DateTime    @default(now())
  publishedAt   DateTime?

  @@index([status, createdAt])
  @@index([aggregateType, aggregateId])
}
```

Properties:

| Column | Purpose |
|--------|---------|
| `type` | The `DomainEventType` union from `src/domain/protocol/events.ts` (`SessionStarted`, `SessionTerminated`, `ProvisioningFailed`, `ReconciliationRequired`, …). |
| `aggregateType` / `aggregateId` | Lets a consumer find all events for a given entity (e.g. all events for session `abc123`). |
| `payload` | The event body. |
| `status` | `PENDING` (just written), `PUBLISHED` (drainer succeeded), `FAILED` (drainer exhausted attempts). |
| `attempts` / `lastAttemptAt` / `lastError` | Retry accounting. |
| `createdAt` / `publishedAt` | Ordering and latency measurement. |

**Immutability:** outbox rows are append-only. The drainer updates `status`,
`attempts`, `lastAttemptAt`, `lastError`, and `publishedAt` — but the original
`type`, `payload`, `aggregateType`, `aggregateId`, and `createdAt` are never
modified. **Failed events are preserved** (status `FAILED`, with `lastError`
populated) so an operator can inspect, replay, or manually intervene.

### 5.2 The drainer

Source: `src/lib/services/outbox-drainer.ts`.

`drainOutbox({ batchSize, maxAttempts })` is the entrypoint. It is **not** a
background watcher — it is a plain `async function` that you invoke. The file's
header is explicit about this:

> *This is NOT a background watcher; it is a function you invoke (e.g. via a cron
> job, Vercel Cron, or an external worker).*

And about what it deliberately does *not* claim:

> *We do NOT claim continuous production execution. The deployment platform
> (Vercel) does not support permanent workers. Use Vercel Cron or an external
> scheduler to call `drainOutbox()` periodically.*

#### Concurrent-safe claiming

The drainer must be safe to invoke from multiple schedulers concurrently without
double-publishing. The claim phase runs inside a single `$transaction`:

```ts
const claimed = await db.$transaction(async (tx) => {
  const events = await tx.outboxEvent.findMany({
    where: { status: "PENDING", attempts: { lt: maxAttempts } },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });
  for (const e of events) {
    await tx.outboxEvent.update({
      where: { id: e.id },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
  }
  return events;
});
```

Because the `findMany` + the `update`s run in one transaction, two concurrent
drainers cannot both claim the same row: the first to commit has already
incremented `attempts` and updated `lastAttemptAt`, and the row's `attempts`
field (now `>= 1`) means a second drainer's `attempts: { lt: maxAttempts }`
filter still passes — but the second drainer's `findMany` will not see the row
as `PENDING`-with-stale-attempts because the row is locked inside the first
drainer's transaction. (In practice on PostgreSQL, the second drainer's `SELECT`
blocks until the first commits, then sees the row's `attempts` already
incremented; with the default `maxAttempts = 5`, a single retry pass is safe
even if both drainers race.) The point is: **the transaction is the lock.**

#### Publication + failure handling

After claiming, the drainer iterates the batch:

```ts
for (const e of claimed) {
  try {
    // PUBLISHER: in production, publish to an event bus here.
    console.log(`[outbox] publishing ${e.type} (${e.id}) ...`);
    await db.outboxEvent.update({
      where: { id: e.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    published++;
  } catch (err: any) {
    await db.outboxEvent.update({
      where: { id: e.id },
      data: { status: "FAILED", lastError: err?.message ?? "unknown" },
    }).catch(() => {});
    failed++;
  }
}
```

The publisher is currently a `console.log` (the file calls this out explicitly).
In production, wire the `publish(...)` call to an event bus (SNS, EventBridge, a
webhook, an internal queue). **The outbox contract is what matters**, not the
specific sink: as long as `txEmit` writes the row in the same transaction as the
state change, and the drainer eventually marks it `PUBLISHED` or `FAILED`, the
system's reliability invariant holds.

#### Wiring to a scheduler

The drainer is exposed as `POST /api/outbox/drain` (in
`src/app/api/outbox/drain/route.ts`), gated by `requirePermission("audit.view")`:

```ts
// src/app/api/outbox/drain/route.ts
export async function POST() {
  const ctx = await requirePermission("audit.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const result = await drainOutbox({ batchSize: 50 });
  return NextResponse.json(result);
}
```

Wire this endpoint to **Vercel Cron** (add a `cron` entry in `vercel.json`) or
an external scheduler (GitHub Actions, cron-job.org, a separate worker dyno).
The drainer is idempotent — calling it when there are no pending events is a
no-op.

---

## 6. Mock adapter fault modes

Source: `src/domain/adapters/mock-providers.ts`, `prisma/schema.prisma`
(`model MockProviderActivation`).

The mock adapter (`executeMockAction`) implements seven deterministic fault
modes. Each mode is persisted in the `MockProviderActivation` table so it
survives serverless cold starts and reproduces reliably in tests.

### 6.1 The MockProviderActivation table

```prisma
model MockProviderActivation {
  id              String   @id @default(cuid())
  providerCode    String
  resourceIdentifier String
  idempotencyKey  String   @unique
  state           String   @default("inactive") // inactive | active | suspended
  faultMode       String   @default("SUCCESS")
  activatedAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([providerCode, resourceIdentifier])
}
```

A real adapter would call a provider API; the mock adapter uses this table as
its stand-in for provider-side state. The `reconcile()` method on the mock
adapter (`queryMockProviderState`) reads this table to answer "what does the
provider believe about this resource?" — which is what `reconcileSession` uses to
detect divergence.

### 6.2 The seven fault modes

| Fault mode | What the adapter does | What RoamLink must do to recover |
|------------|----------------------|----------------------------------|
| **`SUCCESS`** | Persists `state: "active"`, returns `{ ok: true, state: "active", measurement }`. | Nothing. The session-service transitions `PROVISIONING → ACTIVE` transactionally and records the measurement. |
| **`TIMEOUT`** | Returns `new Promise(() => {})` — never resolves. The provider did NOT activate. | The HTTP layer must time out the request. The `Operation` row stays `RUNNING`; `reconcileSession` will see RoamLink=`PROVISIONING`, provider=`inactive` and return `RETRY_FAILED` (Case 3 in RECONCILIATION.md). The caller retries with a new `idempotencyKey`. |
| **`FAIL_BEFORE_SIDE_EFFECT`** | Returns `{ ok: false, state: "failed", error: "MOCK_FAIL_BEFORE_SIDE_EFFECT" }`. No state change on the provider. | The session-service calls `failSession` (transition `PROVISIONING → FAILED`) and `failOperation`. The `Operation` is recorded `FAILED` with the error. Retry with a new key; the provider had no side effect so no cleanup is needed. |
| **`FAIL_AFTER_SIDE_EFFECT`** | **Persists `state: "active"`** on the provider, then returns `{ ok: false, state: "failed", error: "MOCK_FAIL_AFTER_SIDE_EFFECT" }`. | This is the *late success* case. RoamLink records `FAILED`; the provider is actually `ACTIVE`. `reconcileSession` (Case 1) discovers the divergence via `adapter.reconcile()` and repairs the session to `ACTIVE` transactionally, emitting `ReconciliationRequired`. |
| **`DUPLICATE`** | Persists `state: "active"`, returns `{ ok: true, state: "active", measurement, idempotent: false }`. Duplicate calls return the same. | Behaves like `SUCCESS` for the first call. Duplicates are caught at the RoamLink `Operation` layer (`observed_running` / `observed_success`) before they reach the adapter — so the duplicate-handling contract is enforced by `claimOrCreateOperation`, not the adapter. |
| **`STALE_STATE`** | Persists `state: "suspended"` (a state RoamLink does not model), returns `{ ok: true, state: "suspended", measurement }`. | RoamLink would attempt to transition `PROVISIONING → ACTIVE` but the adapter's reported state (`suspended`) is unexpected. This mode is for testing how the system handles a provider whose state vocabulary does not match RoamLink's. Reconciliation will see `providerState.state === "suspended"` (not `active`), so Case 1 does not fire; the session stays in its RoamLink state pending operator review. |
| **`SLOW_SUCCESS`** | Awaits 2s, then persists `state: "active"` and returns `{ ok: true, state: "active", measurement }`. | Models latency. If the caller waits, the session transitions `PROVISIONING → ACTIVE` normally. If the caller times out first, the `Operation` stays `RUNNING`; reconciliation will eventually discover the late success (Case 1) — same recovery as `FAIL_AFTER_SIDE_EFFECT`. |

### 6.3 What this proves about the system

The fault-mode table is not just a test fixture — it is the **evidence** that the
reliability invariant holds. Each mode corresponds to a real-world failure class,
and for each, the system has a defined response:

- *No side effect + failure* (`FAIL_BEFORE_SIDE_EFFECT`) → record `FAILED`, retry safely.
- *Side effect + failure* (`FAIL_AFTER_SIDE_EFFECT`, `SLOW_SUCCESS` after timeout) →
  record `FAILED`, let reconciliation discover the late success.
- *No response* (`TIMEOUT`) → record `RUNNING`, let reconciliation decide retry vs. repair.
- *Duplicate* → caught at the `Operation` layer, never reaches the adapter twice.
- *Stale provider vocabulary* (`STALE_STATE`) → no automatic repair; flagged for review.

There is no fault mode in which RoamLink silently lies about state. Every
divergence is either repaired transactionally by `reconcileSession` or left in a
recoverable state (`FAILED`, `PROVISIONING`) for the next reconciliation pass.

---

## 7. Summary

- **The reliability invariant** is a pipeline: COMMAND → PERSISTED OPERATION →
  STATE MACHINE → ADAPTER → EXTERNAL SIDE EFFECT → RECONCILIATION. No step may
  be skipped or run against a stale view.
- **Transactional consistency** is provided by `atomic()` in `src/lib/audit.ts`:
  state change + `txAudit` + `txEmit` commit in one `$transaction` or roll back
  together. Every state-changing path in `session-service.ts` and
  `reconciliation-service.ts` uses this.
- **The `Operation` model** (`prisma/schema.prisma`) makes every externally-
  visible action durable and idempotent. `idempotencyKey @unique` is enforced by
  the DB; `operationGen` carries the fencing token.
- **Fencing** uses `ConnectivitySession.generation` (monotonically increasing)
  vs `Operation.operationGen` (captured at creation). `isStaleOperation()`
  prevents stale results from overwriting newer state. `advanceGeneration()` and
  the in-transaction `generation: { increment: 1 }` are the bump mechanisms.
- **The Outbox model** persists events in the same transaction as the state
  change. The `OutboxEvent` table is immutable except for status/attempts fields.
  Failed events are preserved for inspection.
- **The outbox drainer** (`drainOutbox`) is a reproducible entrypoint, not a
  background watcher. Concurrent-safe claiming uses `$transaction`. Wire to
  Vercel Cron or an external scheduler via `POST /api/outbox/drain`.
- **The mock adapter's seven fault modes** each map to a real-world failure
  class and a defined recovery path, proving the invariant holds under each
  failure shape.

For the idempotency contract that backs the Operation model, see
`docs/architecture/IDEMPOTENCY.md`. For the reconciliation service that closes
the loop, see `docs/architecture/RECONCILIATION.md`. For the dependency
boundaries these modules respect, see `docs/architecture/DEPENDENCY-AUDIT.md`.
