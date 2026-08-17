// Adapter Conformance Test Suite.
// Every adapter (MOCK now; MIKROTIK/ESIM later) must pass these tests.
// Tests the AdapterContract boundary — no provider-specific logic leaks through.
import { test, expect, describe } from "bun:test";
import { adapterFor, MOCK_PROVIDER_PROFILES } from "@/domain/adapters/registry";
import type { ActionType, Adapter } from "@/domain/protocol";
import { ALL_ACTIONS } from "@/domain/protocol";

describe("Adapter conformance — all mock providers", () => {
  for (const profile of MOCK_PROVIDER_PROFILES) {
    describe(`${profile.code} (${profile.name})`, () => {
      const adapter = adapterFor(profile.code, "MOCK")!;

      test("descriptor declares supported actions", () => {
        expect(adapter.descriptor.providerCode).toBe(profile.code);
        expect(adapter.descriptor.type).toBe("MOCK");
        expect(adapter.descriptor.supportedActions.length).toBeGreaterThan(0);
        // Every declared action must be in the protocol's action vocabulary.
        for (const a of adapter.descriptor.supportedActions) {
          expect(ALL_ACTIONS).toContain(a);
        }
      });

      test("unsupported action returns ACTION_NOT_SUPPORTED, not a crash", async () => {
        const unsupported = ALL_ACTIONS.filter(
          (a) => !adapter.descriptor.supportedActions.includes(a)
        ) as ActionType[];
        if (unsupported.length > 0) {
          const result = await adapter.execute(unsupported[0], {
            providerResourceId: "test-resource",
            idempotencyKey: `conf-unsupported-${profile.code}`,
          });
          expect(result.ok).toBe(false);
          expect(result.error).toContain("ACTION_NOT_SUPPORTED");
        }
      });

      test("ACTIVATE then duplicate ACTIVATE = idempotent (one logical operation)", async () => {
        const key = `conf-idem-${profile.code}-${Date.now()}`;
        const r1 = await adapter.execute("ACTIVATE", { providerResourceId: "res-1", idempotencyKey: key });
        if (r1.ok) {
          const r2 = await adapter.execute("ACTIVATE", { providerResourceId: "res-1", idempotencyKey: key });
          expect(r2.ok).toBe(true);
          expect(r2.idempotent).toBe(true);
        }
      });

      test("DEACTIVATE after ACTIVATE succeeds", async () => {
        const key = `conf-deact-${profile.code}-${Date.now()}`;
        const act = await adapter.execute("ACTIVATE", { providerResourceId: "res-2", idempotencyKey: key });
        if (act.ok && adapter.descriptor.supportedActions.includes("DEACTIVATE")) {
          const deact = await adapter.execute("DEACTIVATE", { providerResourceId: "res-2", idempotencyKey: `conf-deact-${profile.code}` });
          expect(deact.ok).toBe(true);
        }
      });

      test("MEASURE returns a measurement snapshot (observed truth)", async () => {
        if (adapter.descriptor.supportedActions.includes("MEASURE")) {
          const key = `conf-measure-${profile.code}-${Date.now()}`;
          await adapter.execute("ACTIVATE", { providerResourceId: "res-3", idempotencyKey: key });
          const m = await adapter.execute("MEASURE", { providerResourceId: "res-3", idempotencyKey: `conf-measure-${profile.code}` });
          expect(m.ok).toBe(true);
          expect(m.measurement).toBeDefined();
          expect(m.measurement!.latencyMs).toBeGreaterThan(0);
          expect(m.measurement!.source).toContain("mock");
        }
      });

      test("reconcile returns a state for an activated resource", async () => {
        const key = `conf-recon-${profile.code}-${Date.now()}`;
        await adapter.execute("ACTIVATE", { providerResourceId: "res-4", idempotencyKey: key });
        const state = await adapter.reconcile("res-4");
        expect(state.found).toBe(true);
        expect(state.state).toBe("active");
      });

      test("reconcile returns not-found for an unknown resource", async () => {
        const state = await adapter.reconcile(`nonexistent-${profile.code}-${Date.now()}`);
        expect(state.found).toBe(false);
      });
    });
  }
});

describe("Adapter failure modes", () => {
  const adapter = adapterFor("MOCK_A", "MOCK")!;

  test("FAIL_BEFORE_SIDE_EFFECT: activation fails, provider does not activate", async () => {
    const key = `fail-before-${Date.now()}`;
    const result = await adapter.execute("ACTIVATE", {
      providerResourceId: "res-fb",
      idempotencyKey: key,
      faultMode: "FAIL_BEFORE_SIDE_EFFECT",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("MOCK_FAIL_BEFORE_SIDE_EFFECT");
    // Provider should NOT have activated.
    const state = await adapter.reconcile("res-fb");
    // The activation record exists but state is inactive.
    if (state.found) expect(state.state).not.toBe("active");
  });

  test("FAIL_AFTER_SIDE_EFFECT: provider activates but returns failure (late success)", async () => {
    const key = `fail-after-${Date.now()}`;
    const result = await adapter.execute("ACTIVATE", {
      providerResourceId: "res-fa",
      idempotencyKey: key,
      faultMode: "FAIL_AFTER_SIDE_EFFECT",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("MOCK_FAIL_AFTER_SIDE_EFFECT");
    // Provider DID activate (late success) — reconciliation should discover this.
    const state = await adapter.reconcile("res-fa");
    expect(state.found).toBe(true);
    expect(state.state).toBe("active");
  });

  test("STALE_STATE: provider reports a different state than expected", async () => {
    const key = `stale-${Date.now()}`;
    const result = await adapter.execute("ACTIVATE", {
      providerResourceId: "res-stale",
      idempotencyKey: key,
      faultMode: "STALE_STATE",
    });
    expect(result.ok).toBe(true);
    expect(result.state).toBe("suspended"); // not "active" as expected
  });
});
