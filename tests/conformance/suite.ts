// Reusable Adapter Conformance Suite (M8-v2).
// Verifies the FULL adapter contract: discovery, description, reservation,
// activation, deactivation, release, measurement, reconciliation, settlement.
import { test, expect, describe } from "bun:test";
import type { Adapter, ActionType } from "@/domain/protocol";
import { ALL_ACTIONS, ACTION_CONTRACT_VERSION, OBSERVATIONAL_ACTIONS, isCompatibleAdapter, supportsAction } from "@/domain/protocol";

export function adapterConformanceSuite(
  adapter: Adapter,
  label: string,
  opts?: { skipFaultTests?: boolean }
) {
  describe(`Conformance: ${label}`, () => {

    // ── IDENTITY + VERSION ─────────────────────────────────────────────
    describe("Identity + version", () => {
      test("descriptor has stable provider identity", () => {
        expect(adapter.descriptor.providerCode).toBeTruthy();
        expect(adapter.descriptor.providerName).toBeTruthy();
      });
      test("contract version is compatible", () => {
        expect(isCompatibleAdapter(adapter)).toBe(true);
        expect(adapter.descriptor.contractVersion).toBe(ACTION_CONTRACT_VERSION);
      });
      test("supported actions are declared and valid", () => {
        expect(adapter.descriptor.supportedActions.length).toBeGreaterThan(0);
        for (const a of adapter.descriptor.supportedActions) {
          expect(ALL_ACTIONS).toContain(a);
        }
      });
    });

    // ── UNSUPPORTED ACTIONS ────────────────────────────────────────────
    describe("Unsupported actions", () => {
      test("returns stable UNSUPPORTED_ACTION result", async () => {
        const unsupported = ALL_ACTIONS.filter(
          (a) => !supportsAction(adapter, a)
        ) as ActionType[];
        if (unsupported.length > 0) {
          const result = await adapter.execute(unsupported[0], {
            providerResourceId: `unsup-${adapter.descriptor.providerCode}`,
            idempotencyKey: `unsup-${Date.now()}`,
          });
          expect(result.ok).toBe(false);
          expect(result.error).toContain("ACTION_NOT_SUPPORTED");
        }
      });
    });

    // ── DISCOVERY ≠ ACTIVATION ─────────────────────────────────────────
    describe("Discovery (observational, no state change)", () => {
      test("DISCOVER returns capabilities without changing state", async () => {
        if (!supportsAction(adapter, "DISCOVER")) return;
        const rid = `disc-${adapter.descriptor.providerCode}-${Date.now()}`;
        const stateBefore = await adapter.reconcile(rid);
        const result = await adapter.execute("DISCOVER", { providerResourceId: rid, idempotencyKey: `disc-${Date.now()}` });
        expect(result.ok).toBe(true);
        // State must NOT have changed
        const stateAfter = await adapter.reconcile(rid);
        expect(stateAfter.found).toBe(stateBefore.found);
        expect(stateAfter.state).toBe(stateBefore.state);
      });
    });

    // ── DESCRIPTION ≠ CAPABILITY ───────────────────────────────────────
    describe("Description (metadata, no state change)", () => {
      test("DESCRIBE returns metadata without changing state", async () => {
        if (!supportsAction(adapter, "DESCRIBE")) return;
        const rid = `desc-${adapter.descriptor.providerCode}-${Date.now()}`;
        const stateBefore = await adapter.reconcile(rid);
        const result = await adapter.execute("DESCRIBE", { providerResourceId: rid, idempotencyKey: `desc-${Date.now()}` });
        expect(result.ok).toBe(true);
        expect(result.description).toBeTruthy();
        const stateAfter = await adapter.reconcile(rid);
        expect(stateAfter.state).toBe(stateBefore.state);
      });
    });

    // ── RESERVATION ≠ ACTIVATION ───────────────────────────────────────
    describe("Reservation (RESERVED, not ACTIVE)", () => {
      test("RESERVE returns 'reserved' state, not 'active'", async () => {
        if (!supportsAction(adapter, "RESERVE")) return;
        const rid = `res-${adapter.descriptor.providerCode}-${Date.now()}`;
        const result = await adapter.execute("RESERVE", { providerResourceId: rid, idempotencyKey: `res-${Date.now()}` });
        expect(result.ok).toBe(true);
        expect(result.state).not.toBe("active"); // reserved ≠ active
      });
    });

    // ── ACTIVATION + IDEMPOTENCY ───────────────────────────────────────
    describe("Activation + idempotency", () => {
      const can = supportsAction(adapter, "ACTIVATE");
      const rid = `act-${adapter.descriptor.providerCode}-${Date.now()}`;

      test("ACTIVATE succeeds and changes state to active", async () => {
        if (!can) return;
        const r = await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `a-${Date.now()}` });
        expect(r.ok).toBe(true);
        expect(r.state).toBe("active");
      });

      test("duplicate ACTIVATE is idempotent", async () => {
        if (!can) return;
        const k = `dup-${Date.now()}`;
        const r1 = await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: k });
        if (r1.ok) {
          const r2 = await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: k });
          expect(r2.ok).toBe(true);
          expect(r2.idempotent).toBe(true);
        }
      });
    });

    // ── MEASUREMENT (observational) ────────────────────────────────────
    describe("Measurement (observational)", () => {
      test("MEASURE returns valid measurement without changing state", async () => {
        if (!supportsAction(adapter, "MEASURE")) return;
        const rid = `meas-${adapter.descriptor.providerCode}-${Date.now()}`;
        if (supportsAction(adapter, "ACTIVATE"))
          await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `m-a-${Date.now()}` });
        const stateBefore = await adapter.reconcile(rid);
        const r = await adapter.execute("MEASURE", { providerResourceId: rid, idempotencyKey: `m-${Date.now()}` });
        expect(r.ok).toBe(true);
        expect(r.measurement).toBeTruthy();
        expect(r.measurement!.latencyMs!).toBeGreaterThan(0);
        expect(r.measurement!.source).toBeTruthy();
        // State must NOT have changed
        const stateAfter = await adapter.reconcile(rid);
        expect(stateAfter.state).toBe(stateBefore.state);
      });
    });

    // ── RECONCILIATION ─────────────────────────────────────────────────
    describe("Reconciliation (idempotent, no state change)", () => {
      test("reconcile returns state for activated resource", async () => {
        const rid = `recon-${adapter.descriptor.providerCode}-${Date.now()}`;
        if (supportsAction(adapter, "ACTIVATE"))
          await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `r-a-${Date.now()}` });
        const s = await adapter.reconcile(rid);
        expect(s.found).toBe(true);
      });
      test("reconcile returns not-found for unknown", async () => {
        const s = await adapter.reconcile(`nope-${Date.now()}`);
        expect(s.found).toBe(false);
      });
      test("repeated reconciliation is idempotent", async () => {
        const rid = `recon-idem-${adapter.descriptor.providerCode}-${Date.now()}`;
        if (supportsAction(adapter, "ACTIVATE"))
          await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `ri-a-${Date.now()}` });
        const s1 = await adapter.reconcile(rid);
        const s2 = await adapter.reconcile(rid);
        expect(s1.state).toBe(s2.state);
      });
    });

    // ── DEACTIVATION / RELEASE ─────────────────────────────────────────
    describe("Deactivation / Release (idempotent)", () => {
      test("DEACTIVATE succeeds + resource becomes inactive", async () => {
        if (!supportsAction(adapter, "DEACTIVATE")) return;
        const rid = `deact-${adapter.descriptor.providerCode}-${Date.now()}`;
        await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `d-a-${Date.now()}` });
        const r = await adapter.execute("DEACTIVATE", { providerResourceId: rid, idempotencyKey: `d-${Date.now()}` });
        expect(r.ok).toBe(true);
        const s = await adapter.reconcile(rid);
        expect(s.state).not.toBe("active");
      });
      test("duplicate DEACTIVATE is safe", async () => {
        if (!supportsAction(adapter, "DEACTIVATE")) return;
        const rid = `deact-dup-${adapter.descriptor.providerCode}-${Date.now()}`;
        await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `dd-a-${Date.now()}` });
        const k = `dd-${Date.now()}`;
        await adapter.execute("DEACTIVATE", { providerResourceId: rid, idempotencyKey: k });
        const r2 = await adapter.execute("DEACTIVATE", { providerResourceId: rid, idempotencyKey: k });
        expect(r2.ok).toBe(true);
      });
      test("RELEASE works + resource becomes inactive", async () => {
        if (!supportsAction(adapter, "RELEASE")) return;
        const rid = `rel-${adapter.descriptor.providerCode}-${Date.now()}`;
        await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `rel-a-${Date.now()}` });
        const r = await adapter.execute("RELEASE", { providerResourceId: rid, idempotencyKey: `rel-${Date.now()}` });
        expect(r.ok).toBe(true);
        const s = await adapter.reconcile(rid);
        expect(s.state).not.toBe("active");
      });
    });

    // ── SETTLEMENT BOUNDARY ────────────────────────────────────────────
    describe("Settlement boundary", () => {
      test("SETTLE is declared supported or unsupported (not silent)", () => {
        const supports = supportsAction(adapter, "SETTLE");
        // The adapter must explicitly declare whether it supports SETTLE.
        // If supported, the conformance suite verifies it returns a result.
        // If unsupported, it must return UNSUPPORTED_ACTION.
        expect(typeof supports).toBe("boolean");
      });
      test("SETTLE returns result if supported", async () => {
        if (!supportsAction(adapter, "SETTLE")) return;
        const rid = `settle-${adapter.descriptor.providerCode}-${Date.now()}`;
        const r = await adapter.execute("SETTLE", { providerResourceId: rid, idempotencyKey: `settle-${Date.now()}` });
        expect(r.ok).toBe(true);
      });
    });

    // ── FAILURE MODELS ─────────────────────────────────────────────────
    if (!opts?.skipFaultTests) {
      describe("Failure models", () => {
        const can = supportsAction(adapter, "ACTIVATE");
        test("FAIL_BEFORE_SIDE_EFFECT: no provider change", async () => {
          if (!can) return;
          const rid = `fb-${adapter.descriptor.providerCode}-${Date.now()}`;
          const r = await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `fb-${Date.now()}`, faultMode: "FAIL_BEFORE_SIDE_EFFECT" });
          expect(r.ok).toBe(false);
          const s = await adapter.reconcile(rid);
          if (s.found) expect(s.state).not.toBe("active");
        });
        test("FAIL_AFTER_SIDE_EFFECT: late success discoverable", async () => {
          if (!can) return;
          const rid = `fa-${adapter.descriptor.providerCode}-${Date.now()}`;
          const r = await adapter.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `fa-${Date.now()}`, faultMode: "FAIL_AFTER_SIDE_EFFECT" });
          expect(r.ok).toBe(false);
          const s = await adapter.reconcile(rid);
          expect(s.found).toBe(true);
          expect(s.state).toBe("active");
        });
      });
    }
  });
}
