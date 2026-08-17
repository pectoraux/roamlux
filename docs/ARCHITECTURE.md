# RoamLink — Architecture Overview

**Status:** Authoritative
**Stack:** Next.js 16 (App Router) · TypeScript · Prisma 6 · PostgreSQL (Neon) · NextAuth v4 · Tailwind 4 · shadcn/ui · Zustand
**Deployment:** Vercel (serverless functions) + Neon Postgres (pooled + direct URLs)

---

## 1. Mission

RoamLink is a **Connectivity Operating System**: a multi-tenant platform that turns any
consumer, family, enterprise, provider, reseller, or operator intent for connectivity
into a deterministic, audited, provider-agnostic action against the best available
resource — and then keeps observing and re-deciding while the session is alive.

The platform deliberately separates *what a user wants* from *what providers can do*
from *what is being sold* from *what the user is allowed to consume* from *what is
actually observed on the wire*. None of these are conflated into a single "Product".

---

## 2. The Central Invariant

Every flow in the system obeys this pipeline. Anything that does not fit this shape is,
by definition, outside the system.

```
USER INTENT → PROTOCOL → DETERMINISTIC DECISION → GENERIC ACTION → ADAPTER → CONNECTIVITY
```

| Stage | What it is | What it is NOT |
|---|---|---|
| **USER INTENT** | A `ConnectivityIntent`: capability, location, time window, usage, constraints, preferences, optional policy | Not a product choice. The intent never names a provider. |
| **PROTOCOL** | The typed contract in `src/domain/protocol.ts` — `ConnectivityIntentPayload`, `AdvertisedCapability`, `MeasurementSnapshot`, `ActionType`, `DecisionResult`... | Not the database schema. Models persist the protocol; they do not define it. |
| **DETERMINISTIC DECISION** | A pure function `evaluate(input): DecisionResult` in `src/domain/control-plane/decision-engine.ts`. Same input ⇒ same output. | Never an LLM. AI may *propose* intents or summarize audit, never *choose* connectivity. |
| **GENERIC ACTION** | One of `DISCOVER`, `RESERVE`, `ACTIVATE`, `DEACTIVATE`, `SWITCH`, `RENEW`, `SUSPEND`, `RESUME`, `RELEASE`, `TRANSFER`, `MEASURE` | Not a provider-specific verb (no `mikrotikActivate`, no `esimSwapProfile`). |
| **ADAPTER** | A handle implementing `supportedActions` + `execute(action, opts)` for a given `Provider`. | Not the kernel. The kernel never imports provider specifics. |
| **CONNECTIVITY** | A `ConnectivitySession` transitioning through its state machine plus observed `Measurement`s. | Not a billing record. Payment truth and connectivity truth are separate. |

This pipeline is the spine. Every ADR is a clarification of one of these stages.

---

## 3. Architectural Layers

RoamLink is divided into eleven logical layers. Each layer has a single responsibility
and a stable contract with its neighbours.

| # | Layer | Responsibility | Lives in |
|---|---|---|---|
| 1 | **Identity** | Who is the actor? `User`, `Role`, `status`, `isDemo`. Authentication via NextAuth credentials + bcrypt. | `prisma/schema.prisma` (Identity section), `src/lib/auth.ts`, `src/lib/password.ts`, `src/lib/server-auth.ts` |
| 2 | **Protocol** | The typed domain contracts. The PUBLIC contract — database models persist it but do not define it. | `src/domain/protocol.ts` |
| 3 | **Connectivity Kernel** | State machines for `Reservation` and `ConnectivitySession`. Validated transitions; illegal transitions throw. | `src/domain/kernel/state-machines.ts`, `src/lib/services/session-service.ts` |
| 4 | **Control Plane** | Deterministic decision engine, scoring weights, hysteresis, reason codes, policy evaluation. | `src/domain/control-plane/decision-engine.ts` |
| 5 | **Adapters** | Generic-action translators to provider-native APIs. Mock ecosystem + extension points for MIKROTIK/ESIM. | `src/domain/adapters/registry.ts`, `src/domain/adapters/mock-providers.ts` |
| 6 | **Commerce** | `Offer` — commercial terms over a capability/resource. Currency, price, unit, billing model. | `prisma/schema.prisma` (Offer model) |
| 7 | **Finance** | `Entitlement` — the right to consume (origin: PURCHASE, SUBSCRIPTION, COMPANY_ALLOCATION, FAMILY_TRANSFER, PROMOTION, SPONSORSHIP, TRIAL). `Resource` consumption tracked separately from payment. | `prisma/schema.prisma` (Entitlement, Resource models) |
| 8 | **Trust** | Audit log + outbox events. Every important action is auditable; every state change emits an outbox event. | `src/lib/audit.ts`, `prisma/schema.prisma` (AuditLog, OutboxEvent) |
| 9 | **Agent** | Reserved for assistant/AI surfaces. Always advisory — never the decision authority. | (extension point) |
| 10 | **Client Applications** | Single-route SPA at `/`. View-based navigation via Zustand. Role-aware dashboard. | `src/app/page.tsx`, `src/components/app/*`, `src/lib/store.ts`, `src/lib/api-client.ts` |
| 11 | **Workers** | Future outbox drainers, reconciliation jobs, measurement pollers. Not in MVP. | (extension point) |

---

## 4. Domain Model

Ten distinct concepts. They are persisted as separate Prisma models and are never
collapsed into a single "Product" or "Order" aggregate. ADRs 002, 003, 004, 006 defend
each separation.

```
ConnectivityIntent ──┐
                     ├─▶ Decision ──▶ Reservation ──▶ ConnectivitySession ──▶ Measurement
Capability ──▶ Resource ──▶ Offer ──▶ Entitlement ─────────────────────────────────┘
                     │
                     └─▶ Provider (declares supportedActions; owns Capabilities)
```

| Concept | Definition | Key fields |
|---|---|---|
| **Intent** | What the consumer wants. Never names a provider. | `capability`, `location`, `timeWindow`, `usage`, `constraints`, `preferences`, `policy?` |
| **Capability** | What a provider can technically provide. Not a price. | `type`, `coverage`, `advertised {maxDownlink, typicalLatency, reliability, ...}` |
| **Resource** | The actual consumable thing (hotspot session, SIM profile, data package). | `identifier`, `state`, `attributes` |
| **Offer** | Commercial terms over a Capability/Resource. One capability → many offers. | `currency`, `priceCents`, `unit`, `billingModel` |
| **Entitlement** | The consumer's RIGHT to consume. May originate from purchase, allocation, trial... | `origin`, `quota`, `consumed`, `validUntil` |
| **Reservation** | A held Resource against an Intent + Entitlement. Has its own state machine. | `state`, `idempotencyKey`, `expiresAt` |
| **ConnectivitySession** | The live connectivity. Explicit state machine. | `state`, `startedAt`, `endedAt`, `currentQuality`, `currentCostCents` |
| **Measurement** | OBSERVED truth on the wire. Distinct from advertised. | `latencyMs`, `downlinkMbps`, `packetLossPct`, `jitterMs`, `availabilityPct`, `source` |
| **Decision** | Output of the deterministic engine. Has reason codes. | `decisionType`, `scoreCurrent`, `scoreTarget`, `switchingCost`, `effectiveDelta`, `reasonCodes[]` |
| **Policy** | Constraints that gate viability (latency, reliability, throughput, cost, interruption). | `maxLatencyMs`, `minReliability`, `minimumThroughputMbps`, `maximumInterruptionSeconds` |

---

## 5. Directory Structure

```
src/
├── app/
│   ├── api/                       # HTTP boundary — thin route handlers, no business logic
│   │   ├── auth/[...nextauth]/    # NextAuth credentials + JWT callbacks
│   │   ├── signup/                # Public → creates WaitlistEntry (NOT a User)
│   │   ├── bootstrap/             # Idempotent admin/demo/provider seeding
│   │   ├── demo-login/            # Returns demo identity catalog (still auths via /api/auth)
│   │   ├── me/                    # Current session snapshot
│   │   ├── waitlist/              # List + approve/reject (PLATFORM_ADMIN)
│   │   ├── admin/users/           # User CRUD (PLATFORM_ADMIN)
│   │   ├── intents/               # Intent create/list/get
│   │   ├── capabilities/          # Published capability catalog
│   │   ├── decisions/             # POST { intentId } → DecisionResult + persisted Decision
│   │   ├── sessions/              # Create session from decision; list/get
│   │   │   └── [id]/actions/      # POST { action } → generic adapter invocation
│   │   ├── measurements/          # Observed-truth feed
│   │   ├── providers/             # Provider catalog (with supportedActions)
│   │   ├── entitlements/          # Entitlement ledger
│   │   ├── audit/                 # Audit log query (PLATFORM_ADMIN, OPERATIONS)
│   │   └── health/                # Liveness probe
│   ├── layout.tsx
│   ├── page.tsx                   # Single-route SPA → AppRoot
│   └── providers.tsx
├── components/
│   ├── app/
│   │   ├── app-root.tsx           # Top-level view switch (landing/login/signup/demo/dashboard)
│   │   ├── landing-view.tsx
│   │   ├── dashboard-shell.tsx    # Role-aware tab navigation
│   │   ├── control-plane-demo.tsx # Intent → Decision → Session visualizer
│   │   ├── role-overview.tsx
│   │   └── admin/                 # waitlist-panel, users-panel, sessions-panel, etc.
│   └── ui/                        # shadcn/ui (New York)
├── domain/
│   ├── protocol.ts                # THE public contract
│   ├── kernel/
│   │   └── state-machines.ts      # Reservation + Session graphs; IllegalTransitionError
│   ├── control-plane/
│   │   └── decision-engine.ts     # evaluate(input) → DecisionResult (pure function)
│   └── adapters/
│       ├── registry.ts            # adapterFor(code,type) → AdapterHandle
│       └── mock-providers.ts      # MOCK_A / MOCK_B / MOCK_C profiles + executor
├── lib/
│   ├── db.ts                      # PrismaClient singleton (pooled)
│   ├── auth.ts                    # NextAuth options + JWT revalidation
│   ├── password.ts                # bcrypt 12 rounds
│   ├── permissions.ts             # Role → Permission matrix
│   ├── server-auth.ts             # getContext / requirePermission / requireActiveUser
│   ├── audit.ts                   # audit() + emitEvent() (outbox)
│   ├── bootstrap.ts               # Idempotent seeding
│   ├── api-client.ts              # Thin SPA fetch wrapper
│   ├── store.ts                   # Zustand UI state (view, dashTab, prefillEmail)
│   └── services/
│       ├── waitlist-service.ts    # approve → createUserFromWaitlist (transactional)
│       └── session-service.ts     # createSessionFromDecision + executeAction
├── hooks/
└── prisma/
    └── schema.prisma              # Domain-separated schema (see §6)
```

---

## 6. Database — PostgreSQL / Neon via Prisma

`prisma/schema.prisma` is the single source of truth. The datasource is PostgreSQL on
Neon, with two URLs: `DATABASE_URL` (pooled, via PgBouncer) for runtime queries and
`DIRECT_URL` for migrations.

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")    // pooled
  directUrl = env("DIRECT_URL")      // migrations
}
```

The schema is **structurally separated by domain** (see the banner comments in the file):

| Section | Models |
|---|---|
| **Identity** | `User`, `Account`, `Session`, `VerificationToken` |
| **Waitlist** | `WaitlistEntry` |
| **Protocol** | `ConnectivityIntent`, `Capability`, `Resource`, `Offer`, `Entitlement` |
| **Connectivity Kernel** | `Reservation`, `ConnectivitySession`, `SessionTransition`, `Measurement` |
| **Control Plane** | `Decision` |
| **Adapters / Providers** | `Provider` |
| **Audit** | `AuditLog` |
| **Events** | `OutboxEvent` |

Notable design choices:
- `User.isDemo` is a flag, never a privilege. The demo accounts authenticate through the
  same NextAuth flow as real users. See ADR-010.
- `WaitlistEntry` has its own lifecycle (`PENDING → INVITED → APPROVED → CONVERTED` or
  `REJECTED`). Public signup never creates a `User`. See ADR-008.
- `ConnectivitySession.reservationId` is `@unique` — a session has at most one
  reservation, but a reservation may exist without a session.
- `SessionTransition` is an append-only audit of every state change with `from`, `to`,
  `reason`, `actor`, `actionId`.
- `Measurement` is a separate append-only table, never overwriting the session's
  advertised values. The session's `currentQuality` JSONB holds the latest snapshot for
  convenience only.
- `Reservation.idempotencyKey` is `@unique` — duplicate reservation requests collapse.
- `OutboxEvent` carries `status PENDING|PUBLISHED|FAILED`, `attempts`, `lastError` —
  ready for a future drainer worker.

---

## 7. Authentication & Authorization

### 7.1 Authentication — NextAuth v4 credentials

`src/lib/auth.ts` configures NextAuth with:
- **Strategy:** JWT (stateless, Vercel-friendly).
- **Provider:** Credentials (email + password). No OAuth in MVP.
- **Hashing:** `bcryptjs` with **12 rounds** (`src/lib/password.ts`). Pure-JS, so it
  runs in Vercel serverless without native bindings.
- **Timing-equal compare:** when an unknown email is presented, a dummy hash is
  compared to equalize response time and prevent enumeration.
- **Status gate:** only `status === ACTIVE` users authenticate. Waitlisted entries are
  not users and cannot authenticate.
- **Revalidation:** the `jwt` callback re-fetches `status`, `role`, `isDemo` from the DB
  on each token use. A disabled user is force-logged-out by clearing claims.

### 7.2 Authorization — Role → Permission

`src/lib/permissions.ts` defines a `Permission` union (18 permissions) and a
`ROLE_PERMISSIONS` matrix:

| Role | Notable permissions |
|---|---|
| `PLATFORM_ADMIN` | All — including `waitlist.approve`, `user.create`, `user.changerole`, `provider.manage`, `audit.view`, `platform.bootstrap` |
| `OPERATIONS` | Read-mostly: `waitlist.view`, `user.view`, `session.view.all`, `audit.view`, `intent.view.all` |
| `CONSUMER` / `FAMILY_ADMIN` / `ENTERPRISE_ADMIN` | `intent.create`, `intent.view` (own), `session.view` (own), `session.action`, `decision.evaluate` |
| `PROVIDER` | `capability.view`, `session.view`, `provider.manage` |
| `RESELLER` | `capability.view`, `session.view` |

`src/lib/server-auth.ts` exposes three helpers:
- `getContext()` — returns `AuthContext | null` (always server-side).
- `requirePermission(perm)` — returns ctx if the session has the permission, else null.
- `requireActiveUser()` — re-fetches `status` from DB before authorizing (defense
  against stale JWT after disable).

Routes call `requirePermission`/`requireActiveUser` and construct their own
`NextResponse` (App Router has no `res` object). **No email-based checks**: a route
never decides permission by inspecting `ctx.email`; only `ctx.role` (and the
ownership checks the route itself implements).

### 7.3 Waitlist gating

Public signup → `POST /api/signup` creates a `WaitlistEntry` with `status=PENDING`.
No `User` row exists yet. The admin reviews via `/api/waitlist/[id]/approve` and then
`createUserFromWaitlist(entryId)` (transactional, idempotent) converts APPROVED →
`User` + `WaitlistEntry.CONVERTED` with `convertedUserId` set. See ADR-008.

---

## 8. The Deterministic Decision Engine

`src/domain/control-plane/decision-engine.ts` is a **pure function**:

```ts
evaluate(input: EvaluationInput): DecisionResult
```

`EvaluationInput` carries the `intent`, the candidate set (each with advertised +
observed measurements + availability + entitlement validity), and an optional
`currentSession`. The output is one of four `DecisionType`s: `SELECT`, `SWITCH`,
`RETAIN`, `RELEASE`.

### 8.1 Scoring weights (explicit, tunable, NOT learned)

```ts
const W = { latency: 0.30, throughput: 0.25, reliability: 0.25, cost: 0.20 };
```

Each metric is normalized to 0..100 where higher = better:
- **Latency:** `100 - (latencyMs/300)*100` (0ms→100, 300ms→0).
- **Throughput:** `(downlinkMbps/100)*100`, with a 0.4× penalty if below a stated need.
- **Reliability:** `reliability * 100` (0.86→86).
- **Cost:** `100 - (priceCents/500)*100` ($0→100, $5→0), with a 0.3× penalty if above
  a stated budget.

`rawScore = clamp(W.latency*sLat + W.thr*sThr + W.rel*sRel + W.cost*sCost, 0, 100)`.

### 8.2 Switching cost & hysteresis

A candidate that is not the current session pays a switching cost:

```ts
DEFAULT_SWITCHING_COST = {
  activationCostCents: 50,    // $0.50
  interruptionRisk: 4,        // points
  batteryPenalty: 1,          // point
  policyPenalty: 0,           // 1000 if intent.preferences.allowAutoSwitch === false
};
```

`effectiveScore = rawScore - switchingCost`.

**Hysteresis:** a switch only fires when
`best.effectiveScore - currentScore >= HYSTERESIS_THRESHOLD` where
`HYSTERESIS_THRESHOLD = 10`. Below that, the decision is `RETAIN` with reason code
`INSUFFICIENT_IMPROVEMENT`. This prevents flapping between marginally different
providers.

### 8.3 Reason codes

Every decision carries a `reasonCodes: ReasonCode[]` drawn from a closed enum:
`LOWER_LATENCY`, `HIGHER_THROUGHPUT`, `LOWER_COST`, `HIGHER_RELIABILITY`,
`MEETS_POLICY`, `POLICY_VIOLATION`, `BETTER_SCORE_AFTER_SWITCHING_COST`,
`INSUFFICIENT_IMPROVEMENT`, `NO_CANDIDATES`, `ENTITLEMENT_VALID`,
`ENTITLEMENT_MISSING`, `AVAILABILITY_OK`, `AVAILABILITY_NONE`.

### 8.4 AI never the authority

LLM surfaces (present or future) may *propose* intents, *summarize* audit logs, or
*explain* decisions in natural language. They never replace `evaluate()`. The decision
is always reconstructible from inputs. See ADR-007.

---

## 9. The Adapter Contract

Adapters implement a tiny surface (`src/domain/adapters/registry.ts`):

```ts
interface AdapterHandle {
  descriptor: AdapterDescriptor;              // providerCode, name, type, supportedActions
  execute(action: ActionType, opts: { providerResourceId, idempotencyKey }): AdapterActionResult;
}
```

`ActionType` is the closed vocabulary:
`DISCOVER | RESERVE | ACTIVATE | DEACTIVATE | SWITCH | RENEW | SUSPEND | RESUME | RELEASE | TRANSFER | MEASURE`
(see `src/domain/protocol.ts`, `ALL_ACTIONS`).

**The kernel never assumes all actions are supported.** Each `Provider.supportedActions`
is the authoritative list. `executeAction` (session-service) checks
`adapter.descriptor.supportedActions.includes(action)` before invoking and returns
`ACTION_NOT_SUPPORTED` otherwise. This is the contract that lets us add MIKROTIK and
ESIM adapters without rewriting the kernel. See ADR-005.

### 9.1 Mock provider ecosystem

Three deliberately different profiles live in `src/domain/adapters/mock-providers.ts`:

| Code | Name | Type | Latency | Downlink | Reliability | Failure rate | Supported actions |
|---|---|---|---|---|---|---|---|
| `MOCK_A` | Atlas WiFi Co-op | wifi | 120 ms | 18 Mbps | 0.86 | **8%** | DISCOVER, RESERVE, ACTIVATE, DEACTIVATE, MEASURE, RELEASE |
| `MOCK_B` | Beacon Mobile (LTE) | lte | 55 ms | 45 Mbps | 0.96 | 2% | + RENEW, SUSPEND, RESUME |
| `MOCK_C` | Crest eSIM Premium | esim_data | 28 ms | 120 Mbps | 0.99 | **0%** | + SWITCH, RENEW |

Failures are **deterministic** — a seeded hash of `(providerCode, idempotencyKey)`
decides whether ACTIVATE fails. The same retry will produce the same result, which
makes reconciliation testing tractable.

The activation store is in-memory per-process. In Vercel serverless each invocation is
fresh; the kernel relies on `idempotencyKey` + the persisted `Reservation`/`Session`
state to reconcile. See ADR-011.

---

## 10. Connectivity Kernel — State Machines

`src/domain/kernel/state-machines.ts` defines two graphs.

### 10.1 Reservation

```
AVAILABLE → RESERVED → ACTIVE → RELEASED
                  │       │
                  ├──→ RELEASED
                  ├──→ EXPIRED
                  └──→ FAILED → RESERVED (retry)
```

### 10.2 ConnectivitySession

```
REQUESTED → PROVISIONING → ACTIVE → SUSPENDED → ACTIVE
                  │           │       │
                  │           ├──→ TERMINATED (terminal)
                  │           └──→ FAILED → PROVISIONING (retry)
                  └──→ FAILED
```

Terminal states: `TERMINATED`. Recoverable: `FAILED` (may retry). Every transition is
appended to `SessionTransition` with `from`, `to`, `reason`, `actor`, `actionId`.

`assertSessionTransition(from, to)` throws `IllegalTransitionError` on illegal moves.
The session-service catches these and records them as
`session.action.illegal` audit failures rather than crashing the request.

---

## 11. Reconciliation, Idempotency, Outbox, Audit

Four guarantees the platform makes about side-effecting operations:

1. **Idempotency keys.** `Reservation.idempotencyKey` is `@unique`. The session service
   composes keys like `reserve::subjectId::intentId::resourceId` and
   `activate::sessionId`. Mock adapters dedupe ACTIVATE/RESERVE on the same key. A
   retried request returns the original successful state with `idempotent: true,
   reconciled: true`.

2. **Recoverable state machines.** Both Reservation and Session graphs allow
   `FAILED → RESERVED` / `FAILED → PROVISIONING` for retry. A failed activation marks
   the reservation `FAILED` (recoverable) rather than deleting it.

3. **Outbox events.** `emitEvent(type, payload)` (in `src/lib/audit.ts`) writes a row
   to `OutboxEvent` with `status=PENDING`. A future worker (Layer 11) drains the
   outbox, attempts publication, and marks `PUBLISHED` or `FAILED` with `attempts` and
   `lastError`. The MVP does not yet have a drainer; the table is the contract.

4. **Audit log.** `audit(params)` writes a row to `AuditLog` with `actorId`, `action`,
   `targetType`, `targetId`, `result`, `reason`, `correlationId`, `requestId`,
   `metadata`. Non-user actors ("system") are coerced to `actorId=null`. Audit writes
   are wrapped in try/catch — **they must never break the primary operation**.

External integrations (provider APIs, payment processors, future webhooks) are
**treated as unreliable**. The platform's source of truth is its own database; the
adapter is a translator, not an authority. See ADR-011.

---

## 12. Client Application

A single route `/` (`src/app/page.tsx` → `AppRoot`) renders the entire experience as a
view-based SPA. Navigation state lives in a Zustand store (`src/lib/store.ts`):

```ts
type View = "landing" | "login" | "signup" | "demo";
type DashTab = "overview" | "control-plane" | "waitlist" | "users" |
               "audit" | "sessions" | "providers" | "entitlements";
```

The client talks to the backend exclusively through `src/lib/api-client.ts`, a thin
`fetch` wrapper that uses relative paths (gateway-safe + Vercel-safe) and credentials
cookies. Role-aware tabs in `dashboard-shell.tsx` surface only the panels a role may
see — but **the server remains the authority**: every API route re-checks permissions
via `requirePermission`/`requireActiveUser`.

---

## 13. Deployment Target

- **Vercel** hosts the Next.js 16 app. Serverless functions back every
  `src/app/api/*` route. The single route `/` ships as a static + client-rendered
  shell.
- **Neon Postgres** hosts the database. `DATABASE_URL` (Pooled, via PgBouncer) is used
  by the runtime; `DIRECT_URL` is used by `prisma migrate`. Both are env vars.
- **Bootstrap** (`src/lib/bootstrap.ts`) is invoked through `/api/bootstrap` and is
  idempotent: it creates the configured `PLATFORM_ADMIN` once (env
  `PLATFORM_ADMIN_EMAIL`, default `ekontetevi@gmail`), six demo identities
  (`isDemo=true`), and the three mock providers with their capabilities/resources/
  offers. Re-invocation is a no-op for already-seeded entities.
- **Local dev** uses the same Neon instance (or a local Postgres) — the codepath is
  identical.

---

## 14. ADR Index

The following ADRs in `docs/adr/` are the authoritative record of each non-obvious
decision. They are referenced throughout this document.

| ADR | Title |
|---|---|
| [ADR-001](adr/ADR-001-protocol-kernel-boundary.md) | Protocol / Kernel Boundary |
| [ADR-002](adr/ADR-002-capability-vs-offer.md) | Capability vs Offer |
| [ADR-003](adr/ADR-003-resource-vs-entitlement.md) | Resource vs Entitlement |
| [ADR-004](adr/ADR-004-connectivity-session.md) | Connectivity Session state machine |
| [ADR-005](adr/ADR-005-adapter-contract.md) | Adapter Contract |
| [ADR-006](adr/ADR-006-measurement-model.md) | Measurement Model |
| [ADR-007](adr/ADR-007-deterministic-decision-engine.md) | Deterministic Decision Engine |
| [ADR-008](adr/ADR-008-waitlist-identity-lifecycle.md) | Waitlist / Identity Lifecycle |
| [ADR-009](adr/ADR-009-authentication-authorization.md) | Authentication / Authorization |
| [ADR-010](adr/ADR-010-demo-identity-isolation.md) | Demo Identity Isolation |
| [ADR-011](adr/ADR-011-reconciliation-model.md) | Reconciliation Model |

For the canonical protocol types and the full action vocabulary, see
[`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).
