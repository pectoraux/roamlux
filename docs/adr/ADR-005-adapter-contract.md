# ADR-005 — Adapter Contract

**Status:** Accepted
**Date:** Architecture freeze

## Context

RoamLink must integrate with providers that have wildly different APIs: a MikroTik
router speaks RouterOS; an eSIM aggregator speaks REST with bundle IDs; a wifi
co-op may speak RADIUS. If the kernel ever imports a provider-specific verb
(`mikrotikActivateProfile`, `esimSwapBundle`), then (a) every new provider is a
kernel change, (b) tests must mock provider specifics, and (c) the decision engine
becomes coupled to API shapes it should not know about.

We need a small, stable, generic action vocabulary that the kernel speaks and that
each adapter translates to its provider-native equivalent.

## Decision

The adapter contract is defined in `src/domain/protocol.ts` and implemented by
`src/domain/adapters/registry.ts`.

- **Action vocabulary** (closed union, `ActionType`):
  ```
  DISCOVER | RESERVE | ACTIVATE | DEACTIVATE | SWITCH |
  RENEW | SUSPEND | RESUME | RELEASE | TRANSFER | MEASURE
  ```
  `ALL_ACTIONS` is the array form.

- **Adapter handle interface:**
  ```ts
  interface AdapterHandle {
    descriptor: AdapterDescriptor;  // providerCode, name, type, supportedActions
    execute(
      action: ActionType,
      opts: { providerResourceId: string; idempotencyKey: string }
    ): AdapterActionResult;
  }
  ```

- **Adapter result:**
  ```ts
  interface AdapterActionResult {
    ok: boolean;
    providerResourceId?: string;
    state: string;
    measurement?: MeasurementSnapshot;
    error?: string;
    idempotent: boolean;
    reconciled?: boolean;
  }
  ```

- **The kernel never assumes all actions are supported.** Each `Provider` row
  carries a `supportedActions: String[]` array (persisted on the Provider model,
  populated from the mock profile at bootstrap). The session-service's
  `executeAction` checks `adapter.descriptor.supportedActions.includes(action)`
  *before* invoking and returns `ACTION_NOT_SUPPORTED` otherwise. The
  `/api/sessions/[id]/actions` route further restricts to a subset of safe actions
  (`DEACTIVATE`, `MEASURE`, `SUSPEND`, `RESUME`, `RELEASE`, `RENEW`).

- **Registry resolution.** `adapterFor(code, type)` returns an `AdapterHandle` or
  `null`. `adapterForProvider(providerId)` resolves the provider row from the DB
  and delegates. Today only `type === "MOCK"` is implemented; `MIKROTIK` and
  `ESIM` are explicit extension points that return `null` until implemented.

- **Mock profiles declare their own `supportedActions`.** This is the contract that
  makes the mock ecosystem behave like real providers:
  - `MOCK_A` (Atlas WiFi): DISCOVER, RESERVE, ACTIVATE, DEACTIVATE, MEASURE, RELEASE.
  - `MOCK_B` (Beacon LTE): adds RENEW, SUSPEND, RESUME.
  - `MOCK_C` (Crest eSIM): adds SWITCH, RENEW.

## Consequences

**Positive**
- A new provider is a new file in `src/domain/adapters/` and a new entry in the
  registry — zero kernel changes.
- Tests can mock the adapter contract with a single object literal.
- The action vocabulary is small enough to reason about exhaustively but rich
  enough to express suspension, renewal, switching, and measurement.
- The `Provider.supportedActions` array lets the UI surface capability-aware
  controls (e.g. hide "Suspend" if the current session's provider doesn't list
  `SUSPEND`).

**Negative**
- The vocabulary is fixed; adding an action is a protocol change that touches every
  adapter. This is intentional — vocabulary additions are rare and should be
  expensive.
- Some adapters will need to emulate an action that their provider doesn't natively
  support (e.g. `RELEASE` on a stateless API). The mock returns `state: "released"`
  idempotently. Real adapters must document their emulation.

**Risks**
- An adapter could lie about `supportedActions` (declare `SUSPEND` but fail at
  runtime). Mitigation: audit logs capture every `session.<action>` result; a
  mismatch is visible and recoverable via the `FAILED → PROVISIONING` retry edge.
