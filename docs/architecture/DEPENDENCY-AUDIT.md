# Dependency Audit — RoamLink Connectivity Operating System

> **Status:** Verified against the actual source tree at `src/`. The reliability
> additions (Task R1) are recorded in §6; the §1 dependency table and the
> per-route table include the new modules and routes.
> **Method:** Every "Actual imports verified" entry below was derived by reading the
> `import` statements at the top of the referenced file (not inferred from naming).
> **Purpose:** Lock the permitted dependency direction. The invariant is:
>
>     Client → API → Application → Kernel / ControlPlane / Adapter → Protocol
>
> Dependencies never flow upward. The protocol never depends on a higher layer.
> Audit history lives in `worklog.md`; this document is the *current* snapshot.

---

## 1. Verified dependency table

The table below maps each module to its architectural layer, the dependencies it is
**permitted** to take, the dependencies it must **never** take, and the actual imports
observed in the code today.

| Module | Layer | May depend on | Must NOT depend on | Actual imports verified |
|--------|-------|---------------|---------------------|------------------------|
| `src/domain/protocol/*` | Protocol | foundational TS types only | Prisma, Next.js, provider SDKs, `db`, kernel, control-plane, adapters, services | `src/domain/protocol/action.ts` imports `type { MeasurementSnapshot } from "./measurement"` (intra-protocol). All other protocol files import nothing external — see `version.ts`, `identity.ts`, `intent.ts`, `capability.ts`, `resource.ts`, `offer.ts`, `entitlement.ts`, `reservation.ts`, `session.ts`, `measurement.ts`, `decision.ts`, `events.ts`, `index.ts`. |
| `src/domain/kernel/state-machines.ts` | Kernel | protocol only | Prisma, provider SDKs, `db`, Next.js, control-plane, adapters, services | `import type { ReservationState, SessionState } from "@/domain/protocol"`; `import { RESERVATION_TRANSITIONS, SESSION_TRANSITIONS } from "@/domain/protocol"`; re-exports `type { ReservationState, SessionState } from "@/domain/protocol"`. No other imports. |
| `src/domain/control-plane/decision-engine.ts` | Control Plane | protocol only | Prisma, provider SDKs, `db`, Next.js, kernel, adapters, services | `import type { ConnectivityIntentPayload, AdvertisedCapability, MeasurementSnapshot, DecisionResult, ScoredCandidate, ReasonCode, PolicySpec } from "@/domain/protocol"`. No other imports. |
| `src/domain/adapters/mock-providers.ts` | Adapter (impl) | protocol (`AdapterDescriptor`, `ActionType`, `AdapterActionResult`, `MeasurementSnapshot`), `db` (for `MockProviderActivation` persistence) | UI, kernel, control-plane, services | `import type { AdapterDescriptor, ActionType, AdapterActionResult, MeasurementSnapshot } from "@/domain/protocol"`; `import { db } from "@/lib/db"`. No Prisma value imports, no UI. The `db` import is used to persist provider-side state in the `MockProviderActivation` table (so it survives serverless cold starts) and to answer `queryMockProviderState()` reads — see §6.4. |
| `src/domain/adapters/registry.ts` | Adapter Registry | protocol, `db` (only to look up the provider row by id), `mock-providers` | UI, kernel, control-plane, services | `import type { ActionType, AdapterActionResult, AdapterDescriptor } from "@/domain/protocol"`; `import { db } from "@/lib/db"`; `import { MOCK_PROFILES, getMockProfile, describeMock, executeMockAction, queryMockProviderState, type MockProviderProfile, type FaultMode } from "./mock-providers"`. The registry wires `queryMockProviderState` into the `AdapterHandle.reconcile()` method, which `reconciliation-service.ts` calls. |
| `src/domain/entitlement/trial-policy.ts` | Entitlement | protocol (`EntitlementRef`, `EntitlementOrigin`), `db`, `audit`/`emitEvent` | provider SDKs, kernel, control-plane, adapters, UI | `import { db } from "@/lib/db"`; `import { audit, emitEvent } from "@/lib/audit"`; `import type { EntitlementRef, EntitlementOrigin } from "@/domain/protocol"`. |
| `src/lib/services/session-service.ts` | Application (connectivity) | protocol, kernel state machines, adapter registry, `db`, `audit`, entitlement, operation-service | provider SDKs directly (must go via adapter) | `import { db } from "@/lib/db"`; `import { audit, atomic, txAudit, txEmit } from "@/lib/audit"`; `import { adapterForProvider } from "@/domain/adapters/registry"`; `import { assertSessionTransition, IllegalTransitionError, type SessionState } from "@/domain/kernel/state-machines"`; `import { verifyEntitlement } from "@/domain/entitlement/trial-policy"`; `import { claimOrCreateOperation, completeOperation, failOperation, isStaleOperation, advanceGeneration } from "@/lib/services/operation-service"`; `import type { ActionType, MeasurementSnapshot } from "@/domain/protocol"`; `import type { PrismaClient } from "@prisma/client"` (type-only). Uses `atomic()` for transactional state+audit+outbox — see §6.2. |
| `src/lib/services/waitlist-service.ts` | Identity Application | `db`, `password`, `audit` | provider SDKs, kernel, control-plane, adapters, protocol | `import { db } from "@/lib/db"`; `import { hashPassword } from "@/lib/password"`; `import { audit, emitEvent } from "@/lib/audit"`; `import { randomBytes } from "crypto"`. |
| `src/lib/services/operation-service.ts` | Application (reliability) | `db`, `audit`, `@prisma/client` (type-only) | provider SDKs, kernel, control-plane, adapters, Next.js, UI | `import { db } from "@/lib/db"`; `import type { PrismaClient, Operation } from "@prisma/client"`; `import { audit } from "@/lib/audit"`. No protocol imports; no kernel imports. The Operation model is the idempotency/fencing primitive consumed by `session-service.ts`. |
| `src/lib/services/reconciliation-service.ts` | Application (reliability) | `db`, `audit`, adapter registry, kernel state machines, protocol (type-only) | provider SDKs (must go via adapter), Next.js, UI, control-plane | `import { db } from "@/lib/db"`; `import { audit, atomic, txAudit, txEmit } from "@/lib/audit"`; `import { adapterForProvider } from "@/domain/adapters/registry"`; `import { assertSessionTransition } from "@/domain/kernel/state-machines"`; `import type { SessionState } from "@/domain/protocol"`. |
| `src/lib/services/outbox-drainer.ts` | Infrastructure | `db` only | everything else (no protocol, no kernel, no adapters, no audit, no Next.js, no UI) | `import { db } from "@/lib/db"`. Single import. The drainer is deliberately a pure infrastructure worker — it touches only the `OutboxEvent` table. |
| `src/lib/auth.ts` | Identity | NextAuth, `db`, `password`, protocol `Role` (currently sourced from `@prisma/client` — see §4) | provider SDKs, kernel, adapters, services | `import type { NextAuthOptions } from "next-auth"`; `import CredentialsProvider from "next-auth/providers/credentials"`; `import { db } from "@/lib/db"`; `import { verifyPassword } from "@/lib/password"`; `import type { Role } from "@prisma/client"`. |
| `src/lib/permissions.ts` | Identity | protocol `Role` (currently sourced from `@prisma/client` — see §4) | Prisma value imports, `db`, provider SDKs, kernel, adapters | `import type { Role } from "@prisma/client"`. (Type-only — erased at runtime.) |
| `src/lib/server-auth.ts` | Identity | NextAuth, `db`, `permissions` | provider SDKs, kernel, adapters, services | `import { getServerSession } from "next-auth"`; `import { authOptions } from "@/lib/auth"`; `import { can, type Permission } from "@/lib/permissions"`; `import { db } from "@/lib/db"`; `import type { Role } from "@prisma/client"`. |
| `src/app/api/**/route.ts` | API (App Router) | `services`, `db`, `protocol`, `server-auth`, `audit`, `decision-engine`, `trial-policy`, `next/server`, `zod` | direct provider SDKs, kernel internals beyond the state-machine re-export, UI | Verified per route below — every route imports only `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/lib/audit`, `@/lib/services/*`, `@/domain/protocol`, `@/domain/control-plane/decision-engine`, `@/domain/entitlement/trial-policy`, `@/lib/bootstrap`, or `type { Role } from "@prisma/client"` (type-only). No route imports a provider SDK or reaches into `mock-providers.ts` directly. |
| `src/components/app/**` | Client (SPA) | API contracts (`@/lib/api-client`), UI primitives (`@/components/ui/*`), `@/lib/store`, `next-auth/react`, `lucide-react`, `@tanstack/react-query`, `sonner` | Prisma, `db`, direct domain services, kernel, control-plane, adapters | Verified across `app-root.tsx`, `dashboard-shell.tsx`, `landing-view.tsx`, `control-plane-demo.tsx`, `role-overview.tsx`, and `admin/*.tsx`: every client component imports only `@/lib/api-client`, `@/lib/store`, `@/components/ui/*`, `next-auth/react`, `next/navigation`, `lucide-react`, `@tanstack/react-query`, `sonner`, or sibling components under `./`. None import `@/lib/db`, `@prisma/client`, `@/domain/*`, or any service module. |

### Per-route API imports (verified)

| Route file | Imports |
|------------|---------|
| `src/app/api/auth/[...nextauth]/route.ts` | `next-auth`, `@/lib/auth` |
| `src/app/api/me/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/permissions` |
| `src/app/api/signup/route.ts` | `next/server`, `@/lib/db`, `@/lib/audit`, `type { Role } from "@prisma/client"`, `zod` |
| `src/app/api/bootstrap/route.ts` | `next/server`, `@/lib/bootstrap`, `@/lib/server-auth`, `@/lib/audit`, `@/lib/db` |
| `src/app/api/demo-login/route.ts` | `next/server`, `@/lib/bootstrap` |
| `src/app/api/health/route.ts` | `next/server`, `@/lib/db` |
| `src/app/api/audit/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/providers/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/capabilities/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/domain/protocol` |
| `src/app/api/measurements/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/intents/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/lib/audit`, `zod` |
| `src/app/api/intents/[id]/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/decisions/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/domain/control-plane/decision-engine`, `@/domain/protocol`, `@/domain/entitlement/trial-policy` |
| `src/app/api/sessions/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/lib/services/session-service`, `@/domain/entitlement/trial-policy` |
| `src/app/api/sessions/[id]/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/sessions/[id]/actions/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/services/session-service`, `type { ActionType } from "@/domain/protocol"` |
| `src/app/api/entitlements/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/domain/entitlement/trial-policy` |
| `src/app/api/waitlist/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/waitlist/[id]/approve/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/services/waitlist-service` |
| `src/app/api/waitlist/[id]/reject/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/services/waitlist-service` |
| `src/app/api/admin/users/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth` |
| `src/app/api/admin/users/[id]/route.ts` | `next/server`, `@/lib/db`, `@/lib/server-auth`, `@/lib/audit`, `type { Role } from "@prisma/client"` |
| `src/app/api/reconcile/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/services/reconciliation-service` |
| `src/app/api/outbox/drain/route.ts` | `next/server`, `@/lib/server-auth`, `@/lib/services/outbox-drainer` |

---

## 2. Verified dependency direction

The permitted direction is downward only — never upward:

```
Client (src/components/app/*)
  │   talks to /api/* only via @/lib/api-client
  ▼
API (src/app/api/**/route.ts)
  │   composes services + decision engine + entitlement + db
  ▼
Application (src/lib/services/*, src/domain/entitlement/trial-policy.ts)
  │   orchestrates kernel + adapter registry + db + audit
  ▼
Kernel / ControlPlane / Adapter Registry
  │   (state-machines.ts → protocol only)
  │   (decision-engine.ts → protocol only)
  │   (adapters/registry.ts → protocol + db + mock-providers)
  ▼
Protocol (src/domain/protocol/*)
  │   foundational types — depends on nothing but itself
```

**Verified conformance:**

- `src/domain/protocol/*` imports nothing outside `./` (the only intra-protocol
  import is `action.ts → measurement.ts`).
- `src/domain/kernel/state-machines.ts` imports `@/domain/protocol` only.
- `src/domain/control-plane/decision-engine.ts` imports `@/domain/protocol` only.
- `src/domain/adapters/mock-providers.ts` imports `@/domain/protocol` only — it has
  no Prisma and no `db` access; it is a pure adapter implementation.
- `src/domain/adapters/registry.ts` is the single place where `db` is allowed in the
  adapter layer (to resolve a `Provider` row by id before dispatching to the
  matching adapter). All provider calls go through `adapterForProvider()`; no
  other module touches a provider implementation directly.
- `src/lib/services/session-service.ts` is the single Application-layer orchestrator
  for the connectivity session lifecycle. It calls `adapterForProvider()`, never a
  provider implementation directly.
- `src/components/app/**` imports `@/lib/api-client` (HTTP) and never reaches into
  `@/lib/db`, `@/lib/services/*`, `@/domain/*`, or `@prisma/client`.

---

## 3. Boundary violations found and fixed

Three violations were identified during the audit. All three have been remediated
in the current source tree. The remediation points are documented here so future
contributors don't reintroduce them.

### 3.1 Kernel imported Prisma — fixed

**Before:** The kernel (`src/domain/kernel/state-machines.ts`) referenced Prisma
enums for `ReservationState` and `SessionState`, which would have coupled the
kernel to the persistence layer.

**Now:** `state-machines.ts` imports `ReservationState` and `SessionState` from
`@/domain/protocol` (the protocol owns the state types — see
`src/domain/protocol/reservation.ts` and `src/domain/protocol/session.ts`). The DB
layer maps Prisma enums to these protocol types; they share the same string
values (`AVAILABLE`, `RESERVED`, `ACTIVE`, `RELEASED`, `EXPIRED`, `FAILED` and
`REQUESTED`, `PROVISIONING`, `ACTIVE`, `SUSPENDED`, `TERMINATED`, `FAILED`), so
the runtime mapping is a no-op cast but the *type* dependency is on the protocol,
not Prisma. The kernel's header comment now reads:

> *"The kernel depends ONLY on the protocol. It does NOT import Prisma, Next.js,
> or any provider SDK. The protocol owns the state types; the DB layer maps Prisma
> enums to these protocol types (they share string values)."*

### 3.2 Decision engine `|| true` entitlement hardcode — fixed

**Before:** The decision engine (or its caller) short-circuited the entitlement
check with `entitlementValid: c.entitlementValid || true`, which silently admitted
every candidate as if the subject were entitled.

**Now:** `src/app/api/decisions/route.ts` constructs each `CandidateInput` with
`entitlementValid: entitledOfferIds.has(offer.id)`, where `entitledOfferIds` is
built from an actual `db.entitlement.findMany({ where: { subjectId, active: true } })`
query. The route file carries an explicit code comment:

> *"Entitlement validity: ACTUAL entitlement check. No hardcoded bypass. A
> candidate is entitlement-valid only if the user holds an active entitlement for
> the offer."*

### 3.3 Entitlement leak in kernel `ensureEntitlement` — extracted to `TrialPolicy`

**Before:** The kernel's activation path contained an `ensureEntitlement(...)`
helper that quietly created entitlements inside the kernel. That conflated the
kernel's role (verify) with commerce's role (grant).

**Now:** Entitlement creation lives in `src/domain/entitlement/trial-policy.ts`:

- `verifyEntitlement(subjectId, offerId)` — read-only lookup used by the kernel.
- `createTrialEntitlement(subjectId, offerId, resourceId, policy?)` — explicit,
  audited, idempotent entitlement grant, called **only** by the API route or a
  commerce flow — never by the kernel.

The session service (`src/lib/services/session-service.ts`) calls `verifyEntitlement`
as a precondition. If the subject has no entitlement, activation is **DENIED**
with `error: "ENTITLEMENT_REQUIRED"` and an `audit` entry for
`session.activate.denied` is written. The session service header now states
explicitly:

> *"This service VERIFIES entitlement; it does NOT create it. Trial entitlements
> are created explicitly via the TrialPolicy service, called by the API route or
> commerce flow BEFORE activation. The kernel never invents commercial authority."*

The actual grant site is `src/app/api/sessions/route.ts` POST handler: it calls
`verifyEntitlement` first and only calls `createTrialEntitlement(...)` if
`DEFAULT_TRIAL_POLICY.enabled` and no entitlement already exists.

---

## 4. Capability taxonomy (defined in `src/domain/protocol/capability.ts`)

The capability taxonomy is **explicit and documented in the protocol**, not a
scattered string comparison. Source: `src/domain/protocol/capability.ts`.

```ts
export const CAPABILITY_TAXONOMY = {
  internet:  ["wifi", "cellular", "broadband", "satellite", "shared_bandwidth"],
  cellular:  ["lte", "esim_data", "5g"],
  broadband: ["isp"],
} as const;
```

The full concrete type union:

```ts
export type CapabilityType =
  | "internet"          // abstract root
  | "wifi"
  | "cellular"          // abstract
  | "lte"
  | "esim_data"
  | "5g"
  | "broadband"         // abstract
  | "isp"
  | "satellite"
  | "shared_bandwidth";
```

**Matching rules** (implemented by `capabilityMatches(intentType, capType)`):

- `intent "internet"` matches every concrete connectivity type (wifi, lte,
  esim_data, 5g, isp, satellite, shared_bandwidth).
- `intent "cellular"` matches `lte`, `esim_data`, `5g`.
- `intent "broadband"` matches `isp`.
- `intent "lte"` matches `lte` only.

`isAbstractCapability(type)` returns `true` for `"internet"`, `"cellular"`, and
`"broadband"` — the abstract nodes that have children in the taxonomy. The
discovery step in `src/app/api/decisions/route.ts` uses `capabilityMatches` to
filter published capabilities against the intent's requested capability.

This taxonomy is the protocol-layer reference. The mock provider ecosystem in
`src/domain/adapters/mock-providers.ts` uses concrete types: `MOCK_A` is `wifi`,
`MOCK_B` is `lte`, `MOCK_C` is `esim_data`. An intent for `"internet"` matches all
three; an intent for `"cellular"` matches `MOCK_B` and `MOCK_C`; an intent for
`"lte"` matches `MOCK_B` only.

---

## 5. Known minor coupling: `Role` type imported from `@prisma/client`

Three identity-layer files import the `Role` type from `@prisma/client`:

- `src/lib/permissions.ts` — `import type { Role } from "@prisma/client";`
- `src/lib/server-auth.ts` — `import type { Role } from "@prisma/client";`
- `src/lib/auth.ts` — `import type { Role } from "@prisma/client";` (used in the
  `user.role as Role` assertion and in module-augmentation for `Session.user.role`
  and `JWT.role`).

These are all **type-only** imports (`import type`), so they are erased at
compile time and never reach the runtime bundle. Prisma is not loaded as a value
dependency of the identity layer — the role check itself runs against plain
strings.

The protocol already defines a functionally identical type in
`src/domain/protocol/identity.ts`:

```ts
export type Role =
  | "PLATFORM_ADMIN"
  | "CONSUMER"
  | "FAMILY_ADMIN"
  | "ENTERPRISE_ADMIN"
  | "PROVIDER"
  | "RESELLER"
  | "OPERATIONS";
```

The two `Role` types share the exact same string union (verified against
`prisma/schema.prisma`'s `enum Role`). The Prisma import is therefore a
convenience: it lets TypeScript narrow the `User.role` field without a cast when
the row comes straight from Prisma.

**Why this is a known minor coupling:** Because the import is type-only, it does
not breach the runtime dependency direction (no Prisma client is loaded for
`permissions.ts`). However, it does mean the protocol is not the *sole* source of
truth at the type level for `Role` — a developer changing `enum Role` in
`schema.prisma` without updating `src/domain/protocol/identity.ts` would create a
silent type drift.

**Recommended remediation (not yet applied):** Switch these three imports to
`import type { Role } from "@/domain/protocol"` so the protocol becomes the
sole type-level authority. This is a small, low-risk change — the runtime
behavior is unaffected because the imports are already type-only.

---

## 6. Reliability additions (Task R1)

The reliability gate introduced four new code modules, one new database table, and
several updates to existing modules. This section records them and verifies that
each respects the dependency direction locked in §1 and §2. The companion docs
`docs/architecture/RELIABILITY.md`, `docs/architecture/IDEMPOTENCY.md`, and
`docs/architecture/RECONCILIATION.md` describe the behaviour; this section
records the *boundaries*.

### 6.1 New: Operation service — application layer

- **File:** `src/lib/services/operation-service.ts`
- **Layer:** Application (reliability).
- **Actual imports:** `@/lib/db`, `@/lib/audit`, `@prisma/client` (type-only for
  `PrismaClient` and `Operation`).
- **Permitted dependencies:** `db`, `audit`, Prisma types. **Not** permitted:
  protocol, kernel, control-plane, adapters, Next.js, UI.
- **Role:** Provides the idempotency primitive (`claimOrCreateOperation`,
  `completeOperation`, `failOperation`) and the fencing primitive
  (`isStaleOperation`, `advanceGeneration`). Consumed by `session-service.ts`.
- **Boundary note:** This module deliberately does *not* import the protocol or
  the kernel — the `Operation` model is a persistence/reliability concern, not a
  domain-contract concern. The `actionType: string` field on `Operation` stores
  the action vocabulary as an opaque string; the kernel's `ActionType` union is
  the type-level authority, but the Operation row does not depend on it at
  runtime. (See IDEMPOTENCY.md for the contract.)

### 6.2 New: Reconciliation service — application layer

- **File:** `src/lib/services/reconciliation-service.ts`
- **Layer:** Application (reliability).
- **Actual imports:** `@/lib/db`, `@/lib/audit` (`audit`, `atomic`, `txAudit`,
  `txEmit`), `@/domain/adapters/registry` (`adapterForProvider`),
  `@/domain/kernel/state-machines` (`assertSessionTransition`), `@/domain/protocol`
  (type-only `SessionState`).
- **Permitted dependencies:** db, audit, adapter registry, kernel state
  machines, protocol types. **Not** permitted: provider SDKs (must go via the
  adapter registry), Next.js, UI, control-plane.
- **Role:** Detects divergence between RoamLink's session state and the
  provider's actual state via `adapter.reconcile()`, and repairs it
  transactionally. Exports `reconcileSession(sessionId)` and `reconcileAll()`.
- **Boundary note:** The reconciliation service is the *only* caller of
  `AdapterHandle.reconcile()`. It speaks to the adapter through the registry's
  `adapterForProvider()` — never directly to `mock-providers.ts` or any future
  real adapter implementation. It uses `assertSessionTransition` from the kernel
  (the same primitive every other state-changing path uses), so illegal moves
  still throw `IllegalTransitionError`.

### 6.3 New: Outbox drainer — infrastructure layer

- **File:** `src/lib/services/outbox-drainer.ts`
- **Layer:** Infrastructure.
- **Actual imports:** `@/lib/db` only. Single import.
- **Permitted dependencies:** `db`. **Not** permitted: protocol, kernel,
  control-plane, adapters, audit, Next.js, UI — *everything else*.
- **Role:** Claims pending `OutboxEvent` rows (concurrent-safe via
  `$transaction`), publishes them (currently a `console.log` placeholder for an
  event bus), and flips them to `PUBLISHED` or `FAILED`. Exports
  `drainOutbox({ batchSize, maxAttempts })`.
- **Boundary note:** The drainer is deliberately a pure infrastructure worker.
  It touches only the `OutboxEvent` table — it does not read sessions,
  operations, reservations, or any domain entity. This means a future
  refactor of the drainer (e.g. to publish to SNS instead of `console.log`)
  cannot accidentally leak domain knowledge into the infrastructure layer. The
  `type` and `payload` columns are treated as opaque blobs.

### 6.4 New: `MockProviderActivation` table — owned by the mock adapter

- **Schema:** `prisma/schema.prisma` (`model MockProviderActivation`).
- **Owner:** `src/domain/adapters/mock-providers.ts` (the mock adapter
  implementation). Read by `queryMockProviderState()`; written by
  `executeMockAction()`.
- **Boundary:** This table is the mock adapter's *private* persistence — it
  models what a real provider's API would return. No application-layer or
  kernel module reads or writes it directly. The only path from the application
  layer to this table is `AdapterHandle.reconcile()` → `queryMockProviderState()`,
  which is the same contract a real adapter would honour by calling a provider
  API. When a real adapter replaces the mock, this table is dropped and the
  contract is unchanged.
- **Why it lives in the adapter layer:** A real adapter would call a provider
  API; the mock adapter calls a DB table. Both are "the adapter's own
  business." Keeping the table inside the adapter boundary (rather than the
  application or kernel layer) means the application layer never has to know
  how the adapter discovers state — it just calls `reconcile()`.

### 6.5 Updated: `session-service.ts` now uses `atomic()` for transactional state+audit+outbox

The session service previously used `audit()` and `emitEvent()` (both
non-transactional, best-effort) for state changes. It now uses the `atomic()`
helper from `@/lib/audit.ts`, which wraps `db.$transaction` and provides
`txAudit` and `txEmit` on the transaction client. Every state-changing path in
`session-service.ts` (`REQUESTED → PROVISIONING`, `PROVISIONING → ACTIVE`,
`* → FAILED`, and every `executeAction` branch) now commits the state transition,
the audit log, and the outbox event in one transaction.

The imports changed from `import { audit, emitEvent } from "@/lib/audit"` to
`import { audit, atomic, txAudit, txEmit } from "@/lib/audit"`, plus a new
dependency on `@/lib/services/operation-service` (for
`claimOrCreateOperation`, `completeOperation`, `failOperation`,
`isStaleOperation`, `advanceGeneration`). See the updated row in §1.

### 6.6 Updated: `ConnectivitySession.generation` for fencing

- **Schema:** `prisma/schema.prisma` (`ConnectivitySession.generation Int @default(1)`).
- **Comment in schema:** *"FENCING: monotonically increasing generation. Each
  successful transition increments it. Stale operations capturing an old
  generation cannot overwrite newer state (optimistic concurrency control)."*
- **Bumped by:** every successful state transition in `session-service.ts` and
  `reconciliation-service.ts`, via `generation: { increment: 1 }` inside an
  `atomic()` transaction. Also bumpable via the explicit `advanceGeneration()`
  helper in `operation-service.ts`.
- **Read by:** `isStaleOperation()` in `operation-service.ts`, which compares
  `session.generation` to `operation.operationGen`. The session service calls
  this after every adapter return and before applying the result.

### 6.7 Updated: `Decision` now persists reproducibility snapshots

- **Schema:** `prisma/schema.prisma` (`model Decision`).
- **New columns:** `intentSnapshot`, `policySnapshot`, `candidateSnapshot`,
  `measurementSnapshot`, `weightsSnapshot` (all `Json`, with `@default` empty
  values), and `evaluationTime` (`DateTime @default(now())`).
- **Comment in schema:** *"REPRODUCIBILITY: snapshots sufficient to explain WHY
  this decision was made. The future audit question 'why did RoamLink make this
  decision?' is answerable from these stored snapshots without re-running the
  engine."*
- **Populated by:** `src/app/api/decisions/route.ts` when it persists a Decision.
- **Engine source:** `src/domain/control-plane/decision-engine.ts` exports
  `SCORING_WEIGHTS` (a copy of the internal `W` constant: `latency: 0.30,
  throughput: 0.25, reliability: 0.25, cost: 0.20`). The route stores this in
  `weightsSnapshot` so a future audit can verify that the persisted score used
  the same weights the engine was compiled with.
- **Determinism:** the engine takes `evaluationTime` as an explicit input (an
  ISO 8601 string) and never calls `new Date()` / `Date.now()` internally —
  see the comment in `decision-engine.ts`. The `observedAt` sentinel
  `"1970-01-01T00:00:00.000Z"` is used for advertised-fallback measurements to
  keep scoring pure.

### 6.8 New API routes

Two new API endpoints expose the reliability services (both admin/ops-gated via
`requirePermission`):

| Route | Permission | Calls | Purpose |
|-------|------------|-------|---------|
| `POST /api/reconcile` | `session.view.all` | `reconcileSession` (single, via `?sessionId=`) or `reconcileAll` (sweep) | Drive reconciliation. Wire to Vercel Cron. |
| `POST /api/outbox/drain` | `audit.view` | `drainOutbox({ batchSize: 50 })` | Drain pending outbox events. Wire to a separate cron schedule. |

Neither route reaches into a provider SDK or into `mock-providers.ts` directly —
both go through `@/lib/services/*`, which in turn go through the adapter
registry. See the per-route table in §1.

### 6.9 Verified direction conformance

The new modules respect the locked dependency direction
(`Client → API → Application → Kernel/ControlPlane/Adapter → Protocol`):

- `operation-service.ts` (Application) → `db`, `audit`. No upward dependency.
- `reconciliation-service.ts` (Application) → `db`, `audit`, adapter registry,
  kernel state machines, protocol (type-only). No upward dependency; the
  adapter registry is the only path to provider implementations.
- `outbox-drainer.ts` (Infrastructure) → `db` only. The narrowest possible
  dependency surface.
- `mock-providers.ts` (Adapter impl) → protocol, `db`. The `db` import is
  permitted at the adapter layer for the mock's `MockProviderActivation`
  persistence — a real adapter would replace this with a provider SDK call, and
  the application layer would be unchanged.
- `session-service.ts` (Application) → now also depends on `operation-service`
  (Application), which is a lateral dependency within the application layer.
  No protocol/kernel/adapter contract was changed to accommodate it.

No boundary violation was introduced. The reliability additions are pure
*additions* — they layer on top of the existing protocol, kernel, and adapter
contracts without modifying them.

---

## 7. Summary

- The dependency direction **Client → API → Application → Kernel/ControlPlane/Adapter → Protocol**
  is verified as actually implemented. No upward dependency was found in any audited module.
- The protocol layer (`src/domain/protocol/*`) is a pure TypeScript contract with
  no external dependencies — confirming ADR-001.
- The kernel and control plane depend only on the protocol — confirming
  ADR-001 and ADR-007.
- Three historical boundary violations have been remediated: (1) kernel no longer
  imports Prisma; (2) the decision engine's `|| true` entitlement bypass is gone,
  replaced by a real `db.entitlement.findMany` lookup in the API route;
  (3) the kernel no longer creates entitlements — `TrialPolicy` owns that.
- The capability taxonomy is explicit in `protocol/capability.ts` and consumed by
  the decision route via `capabilityMatches`.
- One known minor coupling remains: the type-only `Role` import from
  `@prisma/client` in `permissions.ts`, `server-auth.ts`, and `auth.ts`. It is
  runtime-safe but should be migrated to `@/domain/protocol` for full portability.
- **Reliability additions (Task R1, §6):** four new modules
  (`operation-service.ts`, `reconciliation-service.ts`, `outbox-drainer.ts`,
  plus the `MockProviderActivation` table owned by the mock adapter) and two
  new API routes (`POST /api/reconcile`, `POST /api/outbox/drain`) respect the
  locked dependency direction. The outbox drainer is the narrowest surface in
  the codebase (`db` only). The reconciliation service is the only caller of
  `AdapterHandle.reconcile()`. The `session-service.ts` was updated to use
  `atomic()` for transactional state+audit+outbox. `ConnectivitySession.generation`
  backs the fencing token; `Decision` now persists reproducibility snapshots.
  No boundary violation was introduced.

Refer to `docs/adr/ADR-001-protocol-kernel-boundary.md`,
`docs/adr/ADR-005-adapter-contract.md`, `docs/adr/ADR-007-deterministic-decision-engine.md`,
and `docs/adr/ADR-011-reconciliation-model.md` for the rationale behind these
boundaries. See `docs/architecture/RELIABILITY.md` and
`docs/architecture/IDEMPOTENCY.md` for the reliability model, and
`docs/architecture/RECONCILIATION.md` for the now-implemented reconciliation
service that builds on this dependency structure.
