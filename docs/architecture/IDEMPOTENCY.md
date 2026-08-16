# Idempotency Model — RoamLink Connectivity Operating System

> **Status:** Verified against `src/lib/services/operation-service.ts`,
> `src/lib/services/session-service.ts`, `prisma/schema.prisma` (`model Operation`,
> `model ConnectivitySession`).
> **Companion docs:** `docs/architecture/RELIABILITY.md`,
> `docs/architecture/RECONCILIATION.md`, `docs/adr/ADR-011-reconciliation-model.md`.

Every externally-visible action in RoamLink is idempotent. A retried POST, a
browser double-click, a network timeout followed by a retry — all of these must
produce the **same** observable outcome as a single request. This document
specifies the contract, the algorithm that enforces it, the behavior for every
duplicate scenario, and the fencing that keeps late-arriving results from
overwriting newer state.

---

## 1. The idempotency contract

> **Same `idempotencyKey` → one logical `Operation`.**

The contract is enforced by a `@unique` constraint on
`Operation.idempotencyKey` in `prisma/schema.prisma`:

```prisma
model Operation {
  id              String         @id @default(cuid())
  idempotencyKey  String         @unique
  actionType      String
  ...
  state           OperationState @default(PENDING)
  requestPayload  Json           @default("{}")
  responsePayload Json?
  error           String?
  ...
}
```

Because `idempotencyKey` is unique at the database level, the same key can ever
be associated with at most one `Operation` row. The first request creates the
row; every subsequent request with the same key *observes* the existing row
rather than creating a new one. The row's `state` (`PENDING → RUNNING →
SUCCEEDED | FAILED`) determines what the observer sees.

**Consequences:**

- A duplicate request never re-executes the adapter call. The provider is never
  asked to do the same work twice on RoamLink's behalf.
- A duplicate request always receives a stable answer: the same response (if the
  original succeeded), the same error (if the original failed), or
  `observed_running` (if the original is still in flight).
- The system can be safely retried at the HTTP layer. A client that gets a
  network timeout can retry the exact same request (same `idempotencyKey`) and
  receive a deterministic result.

---

## 2. The `claimOrCreateOperation` algorithm

Source: `src/lib/services/operation-service.ts`.

`claimOrCreateOperation(opts)` is the single entrypoint through which every
externally-visible action begins. Its job is to atomically claim an existing
operation or create a new one, and to tell the caller whether *this* invocation
is the one that should execute.

### 2.1 Pseudocode

```
claimOrCreateOperation(opts):
  existing = db.operation.findUnique({ idempotencyKey: opts.idempotencyKey })

  if existing:
    # Payload conflict: same key MUST have the same payload.
    if existing.requestPayload is not null
       and stringify(existing.requestPayload) != stringify(opts.requestPayload or {}):
      return { operation: existing, shouldExecute: false,
               result: { status: "payload_conflict", error: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" } }

    if existing.state in (PENDING, RUNNING):
      return { operation: existing, shouldExecute: false,
               result: { status: "observed_running" } }

    if existing.state == SUCCEEDED:
      return { operation: existing, shouldExecute: false,
               result: { status: "observed_success", response: existing.responsePayload } }

    if existing.state == FAILED:
      return { operation: existing, shouldExecute: false,
               result: { status: "observed_failure", error: existing.error } }

  # No existing operation — create one. The @unique constraint prevents races.
  try:
    op = db.operation.create({
      idempotencyKey: opts.idempotencyKey,
      actionType: opts.actionType,
      subjectId: opts.subjectId,
      resourceId: opts.resourceId,
      providerId: opts.providerId,
      sessionId: opts.sessionId,
      operationGen: opts.operationGen or 1,
      state: RUNNING,
      startedAt: now(),
      requestPayload: opts.requestPayload or {},
    })
    return { operation: op, shouldExecute: true }

  except UniqueConstraintViolation:
    # Race: another caller created the row between our findUnique and create.
    raced = db.operation.findUnique({ idempotencyKey: opts.idempotencyKey })
    if raced and raced.state in (PENDING, RUNNING):
      return { operation: raced, shouldExecute: false,
               result: { status: "observed_running" } }
    raise  # Unexpected — let the caller surface it.
```

### 2.2 Why this is correct

- **Existing-row path.** If a row already exists for the key, the function
  *never* creates a second row. It returns the existing row plus a `result`
  describing what to observe (`observed_running`, `observed_success`,
  `observed_failure`, or `payload_conflict`). `shouldExecute` is `false`.
- **Create path.** If no row exists, the function creates one directly in state
  `RUNNING` (not `PENDING` — there is no separate "claim" step; the create
  *is* the claim). `shouldExecute` is `true`. The caller proceeds to invoke the
  adapter.
- **Race path.** If two callers race to create the same key, the database's
  unique constraint lets exactly one succeed. The other gets a
  `UniqueConstraintViolation` from Prisma, which `claimOrCreateOperation` catches
  and converts to `observed_running` (re-reading the row the winner created).
  Neither caller re-executes; the loser observes.

### 2.3 The payload conflict check

The idempotency contract is not just "same key → one operation." It is "same
key + same payload → one operation." If a caller reuses a key with a *different*
payload, `claimOrCreateOperation` rejects the request with
`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`. This catches programming errors (a caller
that derives the key from one set of fields but sends a different payload) before
they produce a silent wrong result.

The check is:

```ts
// src/lib/services/operation-service.ts
const existingPayload = JSON.stringify(existing.requestPayload);
const newPayload = JSON.stringify(opts.requestPayload ?? {});
if (existingPayload !== newPayload && existing.requestPayload !== null) {
  return { operation: existing, shouldExecute: false,
           result: { status: "payload_conflict", operation: existing,
                     error: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH" } };
}
```

The `existing.requestPayload !== null` guard means a row with a null
`requestPayload` (which should not happen given the `@default("{}")`) is treated
leniently; in practice every created row has a non-null payload.

---

## 3. Behavior table

For every scenario, the table below specifies exactly what
`claimOrCreateOperation` returns and what the caller does next. The caller in
practice is `createSessionFromDecision` or `executeAction` in
`src/lib/services/session-service.ts`.

| Scenario | Behavior |
|----------|----------|
| **First request** | `claimOrCreateOperation` creates `Operation(state=RUNNING)` with `startedAt = now()` and `operationGen = session.generation` (or 1). Returns `shouldExecute = true`. Caller invokes the adapter; on success calls `completeOperation`; on failure calls `failOperation`. |
| **Duplicate while running** | `claimOrCreateOperation` finds `existing.state ∈ {PENDING, RUNNING}` and returns `shouldExecute = false, result.status = "observed_running"`. Caller does NOT re-execute; returns the observed state to its own caller. In `createSessionFromDecision` this surfaces as `{ ok: false, state: "PROVISIONING", error: "OPERATION_RUNNING", idempotent: true }`. |
| **Duplicate after success** | `claimOrCreateOperation` finds `existing.state = SUCCEEDED` and returns `shouldExecute = false, result.status = "observed_success"` with `response = existing.responsePayload`. Caller does NOT re-execute; returns the stored response. In `createSessionFromDecision` this returns the previously-linked session if `op.sessionId` is set. |
| **Duplicate after failure** | `claimOrCreateOperation` finds `existing.state = FAILED` and returns `shouldExecute = false, result.status = "observed_failure"` with `error = existing.error`. Caller does NOT re-execute; returns the stored error. **The caller may retry with a NEW `idempotencyKey`** — the failed operation is never silently re-run. |
| **Same key + different payload** | `claimOrCreateOperation` returns `shouldExecute = false, result.status = "payload_conflict"` with `error = "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"`. The request is rejected. The caller must use a different key or the same payload. |
| **Timeout + retry (same key)** | The original `Operation` remains in state `RUNNING` (the adapter never returned). A retry with the same key returns `observed_running`. The retry does NOT re-execute. A `reconcileSession` pass will see the session in `PROVISIONING` and decide whether to retry with a *new* key (see RECONCILIATION.md Case 3). |
| **Late success after timeout** | The original adapter call eventually returns `ok: true`, but by then the session may have advanced (e.g. a retry with a new key succeeded and bumped the generation). **Fencing** prevents the stale operation from overwriting the newer state — see §4. The stale result is recorded on the operation row (`completeOperation` returns `{ applied: false, stale: true }`) and an audit entry `session.activate.stale` with `reason: "STALE_OPERATION_FENCED"` is written, but the session's state is NOT mutated. |

---

## 4. Fencing

Fencing is what makes the "late success after timeout" row of the table above
safe. Without it, a slow-but-successful operation could overwrite state that a
newer operation had already established.

### 4.1 The two counters

- `ConnectivitySession.generation` — `Int @default(1)`, monotonically increasing.
  Bumped on every successful state transition inside an `atomic()` transaction.
- `Operation.operationGen` — `Int @default(1)`, captured from
  `session.generation` at operation creation time. Never changes for the life of
  the row.

### 4.2 The invariant

> If `session.generation > operation.operationGen`, the operation is **stale**.
> Its result may be recorded on the operation row (for completeness of the audit
> trail) but must NOT be applied to the session.

### 4.3 The check

`isStaleOperation(operationId, sessionId)` in
`src/lib/services/operation-service.ts`:

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

### 4.4 Where fencing is enforced

The session service calls `isStaleOperation` *after* the adapter returns and
*before* applying the result. The pattern (from `createSessionFromDecision`):

```ts
// 6) FENCING CHECK: is this operation stale? (session advanced past it)
const stale = await isStaleOperation(claim.operation.id, session.id);
if (stale) {
  await audit({ actorId: subjectId, action: "session.activate.stale",
                targetType: "session", targetId: session.id,
                reason: "STALE_OPERATION_FENCED",
                metadata: { operationId: claim.operation.id } });
  await completeOperation({ operationId: claim.operation.id,
                            response: result, sessionId: session.id });
  return { ok: false, sessionId: session.id, state: "STALE",
           error: "STALE_OPERATION_FENCED" };
}
```

The same pattern is used in `executeAction` for the generic-action path
(`DEACTIVATE`, `SUSPEND`, `RESUME`, `MEASURE`, `RELEASE`).

### 4.5 `completeOperation` also fences

Even if a caller forgets to check staleness, `completeOperation` performs the
same check internally and returns `{ applied: false, stale: true }` when the
operation is stale. The operation row is still updated to `SUCCEEDED` (so the
audit trail records that the adapter call did eventually succeed), but the
caller can see from the return value that the result was *not* applied to the
session.

### 4.6 `advanceGeneration`

`advanceGeneration(sessionId)` is the explicit generation-bump helper:

```ts
export async function advanceGeneration(sessionId: string): Promise<number> {
  const updated = await db.connectivitySession.update({
    where: { id: sessionId },
    data: { generation: { increment: 1 } },
    select: { generation: true },
  });
  return updated.generation;
}
```

For normal state transitions, the session service uses the in-transaction form
`generation: { increment: 1 }` inside `atomic()` — this is equivalent to calling
`advanceGeneration` but commits atomically with the state change, audit, and
outbox event. `advanceGeneration` is the right tool for callers that need to bump
the generation without a full state transition (e.g. a "logical invalidation"
that should fence off in-flight operations even though the session's state
hasn't changed).

---

## 5. The `idempotencyKey` derivation

The idempotency contract requires the key to be **deterministic** — derived from
the request's identifying fields, not randomly generated. A random key would
make every retry a new operation, defeating the entire purpose.

The session service (`src/lib/services/session-service.ts`) uses a single helper:

```ts
function idemKey(...parts: string[]) {
  return parts.join("::");
}
```

### 5.1 Activation key

For `createSessionFromDecision` (the `ACTIVATE` path that creates a new session
from a decision):

```ts
const opKey = idemKey("activate", subjectId, intentId, resourceId);
// opKey = "activate::<subjectId>::<intentId>::<resourceId>"
```

The key is derived from the triple `(subjectId, intentId, resourceId)` plus a
verb prefix. Any caller asking to activate the same resource for the same
intent for the same subject produces the same key — and therefore observes the
same operation.

### 5.2 Action key

For `executeAction` (the generic-action path on an existing session):

```ts
const opKey = idemKey(opts.action.toLowerCase(), opts.sessionId);
// opKey = "deactivate::<sessionId>" | "suspend::<sessionId>" | ...
```

The key is derived from `(action, sessionId)`. A duplicate `DEACTIVATE` on the
same session observes the existing operation.

### 5.3 Reservation key (separate, also DB-backed)

The reservation step has its own idempotency, on a separate key namespace:

```ts
const resKey = idemKey("reserve", subjectId, intentId, resourceId);
// resKey = "reserve::<subjectId>::<intentId>::<resourceId>"
```

This is enforced by `Reservation.idempotencyKey @unique` (see
`prisma/schema.prisma`). The reservation key is distinct from the activation
key, so a reservation retry is not confused with an activation retry.

### 5.4 Why deterministic, not random

- **Reproducibility.** The same logical request always maps to the same
  operation row. A client that times out and retries with the same input fields
  produces the same key.
- **Auditability.** The key is human-readable (`activate::abc123::def456::ghi789`)
  and self-documenting in the `Operation` table.
- **No coordination.** Two callers don't need to exchange a key out-of-band;
  they each derive it from the request.
- **Failed retries are explicit.** A caller that wants to retry a *failed*
  operation MUST change one of the identifying fields (e.g. issue a new intent
  or pick a different resource) — this produces a new key, which is the correct
  behavior (the failed operation's row is preserved for audit, and the new
  attempt gets its own row).

---

## 6. Summary

- **The contract:** same `idempotencyKey` → one logical `Operation`, enforced by
  `Operation.idempotencyKey @unique` in `prisma/schema.prisma`.
- **The algorithm:** `claimOrCreateOperation` either observes an existing row
  (returning `observed_running` / `observed_success` / `observed_failure` /
  `payload_conflict`) or creates a new row in state `RUNNING` (returning
  `shouldExecute = true`). Races are caught by the unique constraint and
  converted to `observed_running`.
- **The behavior table** specifies, for each of seven scenarios, exactly what
  the caller observes and what it does next. No scenario re-executes the
  adapter on a duplicate key.
- **Fencing** uses `ConnectivitySession.generation` (monotonically increasing)
  vs `Operation.operationGen` (captured at creation). `isStaleOperation()`
  returns true when the session has advanced past the operation;
  `completeOperation` records the result on the operation row but does not apply
  it to the session. `advanceGeneration()` is the explicit bump helper; normal
  transitions use the in-transaction `generation: { increment: 1 }` form.
- **The `idempotencyKey` derivation** is deterministic: `"activate::<subjectId>::<intentId>::<resourceId>"`
  for activations, `"<action>::<sessionId>"` for generic actions,
  `"reserve::<subjectId>::<intentId>::<resourceId>"` for reservations. Never
  random.

For the broader reliability pipeline that this idempotency contract fits into,
see `docs/architecture/RELIABILITY.md`. For how reconciliation handles stuck or
late-succeeding operations, see `docs/architecture/RECONCILIATION.md`.
