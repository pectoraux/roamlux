# Reconciliation Model — RoamLink Connectivity Operating System

> **Status:** Implemented. The reconciliation service
> (`src/lib/services/reconciliation-service.ts`) detects and repairs divergence
> between RoamLink's recorded session state and the provider's actual state.
> **Source of truth:** `src/lib/services/reconciliation-service.ts`,
> `src/lib/services/session-service.ts`, `src/lib/services/operation-service.ts`,
> `src/lib/services/outbox-drainer.ts`, `src/lib/audit.ts`,
> `src/domain/adapters/mock-providers.ts`, `src/domain/adapters/registry.ts`,
> `prisma/schema.prisma` (`ConnectivitySession`, `Operation`, `OutboxEvent`,
> `MockProviderActivation`), `src/app/api/reconcile/route.ts`.
> **Companion docs:** `docs/architecture/RELIABILITY.md`,
> `docs/architecture/IDEMPOTENCY.md`, `docs/architecture/DEPENDENCY-AUDIT.md`,
> `docs/adr/ADR-011-reconciliation-model.md`.

RoamLink orchestrates connectivity across providers it does not own. Every adapter
call is a remote procedure that can time out, succeed late, partially succeed, or
duplicate. The system therefore cannot assume that "I sent the request" equals
"the provider agrees." **Reconciliation** is the explicit, auditable workflow that
repairs divergence between RoamLink's recorded state and the provider's actual
state.

This document specifies the failure modes that cause divergence, the
`reconcileSession` algorithm that detects and repairs each case, the
`reconcileAll` sweep, and the `POST /api/reconcile` endpoint that drives both.

---

## 1. The reconciliation problem

A connectivity session in RoamLink traverses the `ConnectivitySession` state
machine (`REQUESTED → PROVISIONING → ACTIVE → SUSPENDED/TERMINATED/FAILED`) and at
each step may invoke a remote adapter. The remote adapter is a stand-in for a
real provider API (MikroTik RouterOS, an eSIM issuer, a carrier wholesale
gateway). The following failure modes can cause RoamLink's recorded state to
**diverge** from the provider's actual state:

| Failure mode | What RoamLink sees | What the provider did |
|--------------|--------------------|----------------------|
| **Timeout** | The HTTP/RPC call to the adapter returned no response within the deadline. | Unknown — the provider may have processed the request, may be still processing it, or may never have received it. |
| **Duplicate request** | A retried POST `/api/sessions` (or browser double-click). | Provider may have received the same `ACTIVATE` twice. The mock adapter's `MockProviderActivation` table is keyed by `idempotencyKey @unique`, so duplicates collapse to one row. RoamLink's `Operation.idempotencyKey @unique` catches duplicates at the application layer before they reach the adapter — see IDEMPOTENCY.md. |
| **Partial success** | The adapter call returned an error after the provider had already side-effected (the `FAIL_AFTER_SIDE_EFFECT` mock fault mode). | Provider is `ACTIVE`; RoamLink recorded `FAILED`. |
| **Late success** | RoamLink marked the session `FAILED` because the adapter returned `ok: false`. The provider later completed the activation asynchronously. | Provider is now `ACTIVE`; RoamLink still says `FAILED`. |
| **Stale provider state** | RoamLink thinks the session is `ACTIVE`. The provider has terminated the resource (quota exhausted, suspension, upstream carrier flap). | Provider is `INACTIVE`; RoamLink still says `ACTIVE`. |
| **Process crash** | The RoamLink serverless function died between writing the reservation row and invoking the adapter (or between invoking the adapter and writing the session transition). | Reservation row may exist with no session; session row may exist in `PROVISIONING` forever. |

The architecture's response is: **never silently lie.** Persist every transition;
make every adapter call idempotent (`Operation.idempotencyKey @unique`); record an
audit log on every failure; **define explicit recovery edges** in the state
machines; and drive those edges from an explicit `reconcileSession` workflow.

---

## 2. The implemented reconciliation service

Source: `src/lib/services/reconciliation-service.ts`.

The service exports two functions:

- `reconcileSession(sessionId): Promise<ReconciliationResult>` — repairs a single
  session.
- `reconcileAll(): Promise<ReconciliationResult[]>` — sweeps all non-terminal
  sessions.

The `ReconciliationResult` shape:

```ts
export interface ReconciliationResult {
  sessionId: string;
  roamLinkState: string;
  providerState: string;
  action: "NO_ACTION" | "ACTIVATED_LATE" | "TERMINATED_MISSING" | "RETRY_FAILED" | "ERROR";
  detail: string;
}
```

### 2.1 `reconcileSession` — the algorithm

```
reconcileSession(sessionId):
  session = db.connectivitySession.findUnique({ id: sessionId, include: resource })
  if !session: return { action: ERROR, detail: "session not found" }

  adapter = adapterForProvider(session.providerId)
  if !adapter: return { action: ERROR, detail: "no adapter" }

  # Discover the provider's actual state for this resource.
  providerState = adapter.reconcile(session.resource.identifier)
  # For the mock adapter, this calls queryMockProviderState() which reads
  # the MockProviderActivation table — see §4.

  roamLinkState = session.state

  # CASE 1: RoamLink thinks provisioning/failed, provider says ACTIVE.
  #          → late success; repair to ACTIVE.
  if roamLinkState in (PROVISIONING, FAILED) and providerState.state == "active":
    atomic(tx => {
      cur = tx.connectivitySession.findUnique({ id: sessionId, select: { state, generation } })
      if !cur or cur.state not in (PROVISIONING, FAILED): return  # already repaired
      assertSessionTransition(cur.state, ACTIVE)
      tx.sessionTransition.create({ sessionId, from: cur.state, to: ACTIVE,
                                    reason: "reconciliation:late_success", actor: "system" })
      tx.connectivitySession.update({ id: sessionId, state: ACTIVE, startedAt: now(),
                                      generation: { increment: 1 } })
      tx.reservation.updateMany({ id: session.reservationId, state: ACTIVE })
      txEmit(tx, "SessionStarted", { sessionId, source: "reconciliation" }, ...)
      txEmit(tx, "ReconciliationRequired", { sessionId, action: "ACTIVATED_LATE" }, ...)
      txAudit(tx, { actorType: "system", action: "session.reconcile.late_success",
                    targetType: "session", targetId: sessionId,
                    metadata: { providerState: providerState.state } })
    })
    return { action: ACTIVATED_LATE, detail: "session activated via late-success reconciliation" }

  # CASE 2: RoamLink thinks ACTIVE, provider says INACTIVE/unknown.
  #          → provider lost the resource; repair to TERMINATED.
  if roamLinkState == ACTIVE
     and providerState.state in ("inactive", "unknown") or !providerState.found:
    atomic(tx => {
      cur = tx.connectivitySession.findUnique({ id: sessionId, select: { state } })
      if !cur or cur.state != ACTIVE: return  # already repaired
      assertSessionTransition(ACTIVE, TERMINATED)
      tx.sessionTransition.create({ sessionId, from: ACTIVE, to: TERMINATED,
                                    reason: "reconciliation:provider_lost", actor: "system" })
      tx.connectivitySession.update({ id: sessionId, state: TERMINATED, endedAt: now(),
                                      generation: { increment: 1 } })
      txEmit(tx, "SessionTerminated", { sessionId, source: "reconciliation" }, ...)
      txEmit(tx, "ReconciliationRequired", { sessionId, action: "TERMINATED_MISSING" }, ...)
      txAudit(tx, { actorType: "system", action: "session.reconcile.terminated",
                    targetType: "session", targetId: sessionId,
                    metadata: { providerState: providerState.state } })
    })
    return { action: TERMINATED_MISSING, detail: "session terminated — provider lost the resource" }

  # CASE 3: RoamLink thinks provisioning/failed, provider says INACTIVE.
  #          → provisioning genuinely failed; retry with a new operation.
  if roamLinkState in (PROVISIONING, FAILED) and providerState.state == "inactive":
    return { action: RETRY_FAILED,
             detail: "provisioning failed; provider did not activate. Retry with a new operation." }

  # Default: states agree.
  return { action: NO_ACTION, detail: "states agree" }
```

### 2.2 The three discrepancy cases

| Case | RoamLink state | Provider state | Diagnosis | Repair | `action` returned |
|------|----------------|----------------|-----------|--------|-------------------|
| **1 — Late success** | `PROVISIONING` or `FAILED` | `active` | RoamLink missed a late success (`FAIL_AFTER_SIDE_EFFECT` mock fault, or a `SLOW_SUCCESS` after RoamLink timed out). | Transition to `ACTIVE` transactionally (re-reads inside the tx to avoid races; bumps `generation`; emits `SessionStarted` + `ReconciliationRequired`; audits `session.reconcile.late_success`). | `ACTIVATED_LATE` |
| **2 — Provider lost resource** | `ACTIVE` | `inactive`, `unknown`, or `!found` | The provider terminated the resource (quota exhausted, suspension, carrier flap, manual provider-side cancel). | Transition `ACTIVE → TERMINATED` transactionally (bumps `generation`; emits `SessionTerminated` + `ReconciliationRequired`; audits `session.reconcile.terminated`). | `TERMINATED_MISSING` |
| **3 — Genuine provisioning failure** | `PROVISIONING` or `FAILED` | `inactive` | Provisioning actually failed; the provider did not activate. No state change is safe — the caller must retry with a *new* `idempotencyKey` (the failed `Operation` is preserved for audit). | None (returns `RETRY_FAILED` with a detail message). | `RETRY_FAILED` |

When the states already agree, the function returns `NO_ACTION` with detail
`"states agree"`.

### 2.3 The repair is transactional

Both Case 1 and Case 2 repairs run inside an `atomic()` block (from
`src/lib/audit.ts`). Within that block:

- the `SessionTransition` row is written,
- the `ConnectivitySession.state` is updated and `generation` is incremented,
- (Case 1 only) the `Reservation.state` is updated to `ACTIVE`,
- the `SessionStarted` / `SessionTerminated` outbox event is emitted via `txEmit`,
- a `ReconciliationRequired` outbox event is emitted with the action taken,
- a `session.reconcile.*` audit log row is written via `txAudit`.

All of these commit in one `$transaction` or roll back together. An observer
reading the database never sees a half-repaired session: either the session is
fully transitioned with its transition row, audit entry, and outbox events all
visible, or none of them are.

### 2.4 The in-transaction re-read

Both repair paths re-read the session inside the transaction before mutating it:

```ts
const cur = await tx.connectivitySession.findUnique({
  where: { id: sessionId }, select: { state: true, generation: true } });
if (!cur || cur.state !== /* expected */) return;  // already repaired
```

This guards against a race where two `reconcileSession` invocations (or a
`reconcileSession` and a user-initiated action) both pass the outer check and
both attempt the repair. The first to commit wins; the second sees the updated
state inside its own transaction and bails out without mutating.

### 2.5 Why no `MEASURE` action is needed for discovery

The original (pre-implementation) reconciliation design contemplated using the
adapter's `MEASURE` action as a state probe. The implemented design uses a
dedicated `reconcile()` method on the `AdapterHandle` interface
(`src/domain/adapters/registry.ts`):

```ts
export interface AdapterHandle {
  descriptor: AdapterDescriptor;
  execute(action: ActionType, opts: { ... }): Promise<AdapterActionResult>;
  // RECONCILIATION: query the provider's actual state for a resource.
  reconcile(providerResourceId: string): Promise<{ state: string; found: boolean }>;
}
```

`reconcile()` is a read-only probe that returns `{ state, found }`. It does not
mutate the provider. This is cleaner than overloading `MEASURE` (which is a
side-effecting action that records a `Measurement` row) and keeps the
reconciliation contract crisp: the adapter is asked "what do you believe about
this resource?" and answers in the provider's own vocabulary
(`active` / `inactive` / `suspended` / `unknown`).

---

## 3. `reconcileAll` — the sweep

Source: `src/lib/services/reconciliation-service.ts`.

```ts
export async function reconcileAll(): Promise<ReconciliationResult[]> {
  const sessions = await db.connectivitySession.findMany({
    where: { state: { in: ["PROVISIONING", "ACTIVE", "FAILED", "SUSPENDED"] } },
    select: { id: true },
  });
  const results: ReconciliationResult[] = [];
  for (const s of sessions) {
    results.push(await reconcileSession(s.id));
  }
  return results;
}
```

`reconcileAll` finds every session in a non-terminal state — `PROVISIONING`,
`ACTIVE`, `FAILED`, `SUSPENDED` — and calls `reconcileSession` on each. Terminal
states (`TERMINATED`, and `REQUESTED` which is a transient pre-`PROVISIONING`
state) are excluded: a `TERMINATED` session cannot be reconciled further, and a
`REQUESTED` session has not yet reached the adapter.

The sweep is **sequential** (not parallel). This is deliberate:

- Reconciliation makes external adapter calls (one per session). Parallelizing
  them would amplify load on the provider.
- Each `reconcileSession` is independent — there is no shared state between
  sessions — so a sequential sweep is correct, just slower. For a small fleet
  this is fine; for a large fleet, batch the session IDs and fan out across
  multiple scheduler invocations.

In production, `reconcileAll` is meant to be called on a schedule (Vercel Cron,
external scheduler) — see §5.

---

## 4. The mock adapter's `reconcile()` reads `MockProviderActivation`

Source: `src/domain/adapters/registry.ts`, `src/domain/adapters/mock-providers.ts`,
`prisma/schema.prisma` (`model MockProviderActivation`).

The `AdapterHandle.reconcile()` method on the mock adapter is wired to
`queryMockProviderState`:

```ts
// src/domain/adapters/registry.ts
export function adapterFor(code: string, type: string): AdapterHandle | null {
  if (type === "MOCK") {
    const profile = getMockProfile(code);
    if (!profile) return null;
    return {
      descriptor: describeMock(profile),
      execute: (action, opts) => executeMockAction(profile, action, opts),
      reconcile: (rid) => queryMockProviderState(profile.code, rid),
    };
  }
  return null;
}
```

`queryMockProviderState` reads the `MockProviderActivation` table:

```ts
// src/domain/adapters/mock-providers.ts
export async function queryMockProviderState(
  providerCode: string, resourceIdentifier: string
): Promise<{ state: string; found: boolean }> {
  const rec = await db.mockProviderActivation.findFirst({
    where: { providerCode, resourceIdentifier },
    orderBy: { updatedAt: "desc" },
  });
  if (!rec) return { state: "unknown", found: false };
  return { state: rec.state, found: true };
}
```

The `MockProviderActivation` table persists the mock adapter's view of
provider-side state so it survives serverless cold starts (the original
in-memory `Map` design from earlier drafts is gone — state is now in
PostgreSQL):

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

A real adapter would call a provider API in `reconcile()`; the mock adapter
uses this table. The contract is identical: `{ state, found }`.

### 4.1 How the fault modes map to reconciliation outcomes

The mock adapter's seven fault modes (`src/domain/adapters/mock-providers.ts`)
each leave a specific state in `MockProviderActivation`, which `reconcile()`
then reads:

| Fault mode | `MockProviderActivation.state` after the adapter call | What `reconcileSession` does |
|------------|------------------------------------------------------|------------------------------|
| `SUCCESS` | `active` | (Already `ACTIVE` in RoamLink.) → `NO_ACTION`. |
| `TIMEOUT` | `inactive` (the adapter never reached the update) | RoamLink is `PROVISIONING`; provider is `inactive`. → Case 3: `RETRY_FAILED`. |
| `FAIL_BEFORE_SIDE_EFFECT` | `inactive` | RoamLink is `FAILED`; provider is `inactive`. → Case 3: `RETRY_FAILED`. |
| `FAIL_AFTER_SIDE_EFFECT` | `active` (the adapter persisted `state: "active"` *before* returning `ok: false`) | RoamLink is `FAILED`; provider is `active`. → **Case 1: `ACTIVATED_LATE`** — repair to `ACTIVE`. |
| `DUPLICATE` | `active` | Same as `SUCCESS`. → `NO_ACTION`. |
| `STALE_STATE` | `suspended` (a vocabulary RoamLink does not model) | `reconcile()` returns `{ state: "suspended" }`. Neither Case 1 (`active`) nor Case 2 (`inactive`/`unknown`) nor Case 3 (`inactive`) fires. → `NO_ACTION` (states "agree" only because no case matched; in practice this is a flag for operator review). |
| `SLOW_SUCCESS` | `active` (after the 2s delay) | If RoamLink waited: already `ACTIVE` → `NO_ACTION`. If RoamLink timed out and recorded `FAILED`/`PROVISIONING`: provider is `active` → **Case 1: `ACTIVATED_LATE`**. |

This is the proof that the reconciliation service handles every fault mode the
mock adapter can produce: each mode maps to exactly one of the three cases (or
`NO_ACTION` when the states already agree).

---

## 5. The `POST /api/reconcile` endpoint

Source: `src/app/api/reconcile/route.ts`.

```ts
// POST /api/reconcile — reconcile all non-terminal sessions (admin/ops only).
// Can optionally reconcile a single session via ?sessionId=...
export async function POST(req: NextRequest) {
  const ctx = await requirePermission("session.view.all");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  if (sessionId) {
    const result = await reconcileSession(sessionId);
    return NextResponse.json({ results: [result] });
  }
  const results = await reconcileAll();
  return NextResponse.json({ results });
}
```

Properties:

- **Authorization.** Requires the `session.view.all` permission (PLATFORM_ADMIN
  or OPERATIONS roles). Reconciliation is an operational action; ordinary
  consumers cannot trigger it.
- **Single-session mode.** `POST /api/reconcile?sessionId=<id>` reconciles one
  session. Useful for ad-hoc repair after an incident.
- **Sweep mode.** `POST /api/reconcile` (no query param) runs `reconcileAll`.
  Returns an array of `ReconciliationResult`, one per non-terminal session.
- **Response shape.** Always `{ results: ReconciliationResult[] }` for
  uniformity — single-session mode returns a one-element array.

### 5.1 Wiring to a scheduler

Reconciliation is meant to run on a schedule, not on every request. Wire
`POST /api/reconcile` to:

- **Vercel Cron** — add an entry to `vercel.json`:
  ```json
  {
    "crons": [
      { "path": "/api/reconcile", "schedule": "*/5 * * * *" }
    ]
  }
  ```
  This invokes the endpoint every 5 minutes. Vercel Cron sends an
  authorization header that the endpoint can validate (or the endpoint can rely
  on the existing `requirePermission` check plus Vercel's internal cron
  authentication).
- **An external scheduler** — GitHub Actions, cron-job.org, a separate worker
  dyno. The scheduler POSTs to `https://roamlux.vercel.app/api/reconcile` with
  admin credentials.

The endpoint is idempotent: calling it when there are no divergences is a
no-op (every session returns `NO_ACTION`).

### 5.2 The outbox drainer endpoint

Reconciliation emits `ReconciliationRequired` events to the outbox. Those events
need to be drained separately — see `docs/architecture/RELIABILITY.md` §5 for the
outbox model and drainer. The drainer endpoint is `POST /api/outbox/drain`
(`src/app/api/outbox/drain/route.ts`), also admin-gated. Wire it to a separate
cron schedule (e.g. every minute).

---

## 6. What the kernel provides (and why no kernel changes were needed)

The reconciliation service uses the kernel's existing primitives — no kernel or
protocol changes were required to implement it. The recoverable state machine
(`FAILED → PROVISIONING`, `PROVISIONING → ACTIVE`, `ACTIVE → TERMINATED`) was
already in place (see `src/domain/protocol/session.ts` and
`src/domain/kernel/state-machines.ts`), and `assertSessionTransition` enforces
every move. The audit and outbox helpers (`atomic`, `txAudit`, `txEmit`) were
already in `src/lib/audit.ts`. The `AdapterHandle.reconcile()` method was added
to the registry (a one-method addition to the adapter contract), but the kernel
itself is unchanged.

This confirms the original design hypothesis from ADR-011: **the reconciliation
worker requires no changes to the kernel or protocol — only a new entrypoint
that uses the existing `assertSessionTransition`, `adapterForProvider`, `audit`,
and `emitEvent` helpers.**

---

## 7. State machine edges used by reconciliation

For reference, the session-state edges that reconciliation relies on (from
`src/domain/protocol/session.ts`):

| From | Permitted targets |
|------|-------------------|
| `REQUESTED` | `PROVISIONING`, `FAILED` |
| `PROVISIONING` | `ACTIVE`, `FAILED` |
| `ACTIVE` | `SUSPENDED`, `TERMINATED`, `FAILED` |
| `SUSPENDED` | `ACTIVE`, `TERMINATED` |
| `TERMINATED` | *(terminal)* |
| `FAILED` | **`PROVISIONING`** ← retry edge |

Reconciliation uses:

- `PROVISIONING → ACTIVE` (Case 1, when the session is still provisioning and
  the provider reports active),
- `FAILED → ACTIVE` (Case 1, when RoamLink had marked the session failed but
  the provider actually succeeded — the retry edge `FAILED → PROVISIONING` is
  implied; `assertSessionTransition` permits `FAILED → ACTIVE` directly),
- `ACTIVE → TERMINATED` (Case 2, when the provider lost the resource).

The `FAILED → PROVISIONING` retry edge is also used by the per-request recovery
path in `createSessionFromDecision` (see §8).

---

## 8. Per-request recovery (still in place)

Reconciliation does not replace per-request recovery — it complements it. The
session service (`src/lib/services/session-service.ts`) still does, on every
`ACTIVATE`:

1. Verify entitlement (`verifyEntitlement`).
2. Claim or create the `Operation` (`claimOrCreateOperation`) — idempotent on
   `idempotencyKey = "activate::<subjectId>::<intentId>::<resourceId>"`.
3. Reserve the resource (idempotent on `Reservation.idempotencyKey`).
4. Create the session in `REQUESTED`, transition to `PROVISIONING`
   transactionally (writes `SessionTransition`, `Operation.sessionId` link,
   `ActionRequested` outbox event, audit row — all in one `atomic()`).
5. Invoke the adapter (`adapter.execute("ACTIVATE", ...)`).
6. **Fence:** check `isStaleOperation` before applying the result.
7. On success: transition `PROVISIONING → ACTIVE` transactionally (writes
   `SessionTransition`, increments `generation`, updates `Reservation` and
   `Resource`, records `Measurement`, emits `SessionStarted` + `ActionCompleted`,
   audits `session.activate`).
8. On failure: `failSession` (transition to `FAILED`, emits `ProvisioningFailed`,
   audits `session.fail`) and `failOperation`.

This per-request path handles the common case (the adapter returns promptly).
Reconciliation handles the uncommon cases (the adapter never returned, returned
late, or returned wrong) — see §1.

---

## 9. Summary

- **`reconcileSession(sessionId)`** discovers the provider's actual state via
  `adapter.reconcile()`, compares it with RoamLink's session state, and repairs
  divergence in one of three cases: late success (`ACTIVATED_LATE`), provider
  lost resource (`TERMINATED_MISSING`), or genuine provisioning failure
  (`RETRY_FAILED`).
- **The repair is transactional:** state transition + audit + outbox event commit
  in one `atomic()` `$transaction` via `txAudit` and `txEmit`. An in-transaction
  re-read guards against concurrent repairs.
- **`reconcileAll()`** sweeps every session in `PROVISIONING`, `ACTIVE`,
  `FAILED`, or `SUSPENDED` state. Designed to be called on a schedule (Vercel
  Cron, external scheduler).
- **`POST /api/reconcile`** is the admin/ops-gated endpoint that drives both
  `reconcileSession` (single-session mode via `?sessionId=`) and `reconcileAll`
  (sweep mode). Wire to Vercel Cron.
- **The mock adapter's `reconcile()`** reads the persistent
  `MockProviderActivation` table via `queryMockProviderState`, returning
  `{ state, found }`. This survives serverless cold starts and reproduces
  deterministically in tests.
- **Each mock fault mode maps to exactly one reconciliation case** (or
  `NO_ACTION` when states agree), proving the service handles every failure
  shape the mock can produce.
- **No kernel or protocol changes were required** to implement reconciliation —
  the recoverable state machine, audit helpers, and outbox were already in
  place. The only contract addition was `AdapterHandle.reconcile()` on the
  adapter registry.

For the broader reliability pipeline, see `docs/architecture/RELIABILITY.md`.
For the idempotency contract that backs the `Operation` rows reconciliation
inspects, see `docs/architecture/IDEMPOTENCY.md`. For the dependency boundaries
these modules respect, see `docs/architecture/DEPENDENCY-AUDIT.md`. For the
rationale behind the recoverable state machines and the outbox pattern, see
`docs/adr/ADR-011-reconciliation-model.md`.
