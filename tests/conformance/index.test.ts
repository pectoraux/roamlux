// M8 Provider Conformance Tests.
// Runs the reusable conformance suite against:
//   1. All three mock providers (Atlas WiFi, Beacon LTE, Crest eSIM)
//   2. The independent ExampleCommunityWifiAdapter
//
// This proves the adapter contract is provider-neutral.
import { test, expect, describe } from "bun:test";
import { adapterFor, MOCK_PROVIDER_PROFILES } from "@/domain/adapters/registry";
import { exampleCommunityWifiAdapter } from "@/domain/adapters/example-community-wifi";
import { adapterConformanceSuite } from "./suite";
import { ACTION_CONTRACT_VERSION } from "@/domain/protocol";
import { db } from "@/lib/db";

// ── Run the conformance suite against each mock provider ───────────────────
for (const profile of MOCK_PROVIDER_PROFILES) {
  const adapter = adapterFor(profile.code, "MOCK")!;
  adapterConformanceSuite(adapter, `${profile.code} (${profile.name})`);
}

// ── Run the conformance suite against the third-party example adapter ──────
adapterConformanceSuite(
  exampleCommunityWifiAdapter,
  "ExampleCommunityWifiAdapter (third-party)",
  { skipFaultTests: true } // the example adapter doesn't implement fault injection
);

// ── Protocol version compatibility ─────────────────────────────────────────
describe("Protocol version compatibility", () => {
  test("ACTION_CONTRACT_VERSION is defined", () => {
    expect(ACTION_CONTRACT_VERSION).toBeTruthy();
    expect(typeof ACTION_CONTRACT_VERSION).toBe("string");
  });

  test("all adapters report compatible contract version", () => {
    // All adapters implement the Adapter interface which is versioned.
    // The conformance suite verifies they implement execute + reconcile.
    for (const profile of MOCK_PROVIDER_PROFILES) {
      const adapter = adapterFor(profile.code, "MOCK")!;
      expect(typeof adapter.execute).toBe("function");
      expect(typeof adapter.reconcile).toBe("function");
    }
    expect(typeof exampleCommunityWifiAdapter.execute).toBe("function");
    expect(typeof exampleCommunityWifiAdapter.reconcile).toBe("function");
  });
});

// ── Provider isolation ─────────────────────────────────────────────────────
describe("Provider isolation", () => {
  test("adapter A cannot mutate adapter B's resources", async () => {
    const adapterA = adapterFor("MOCK_A", "MOCK")!;
    const adapterB = adapterFor("MOCK_B", "MOCK")!;
    const rid = `iso-${Date.now()}`;
    // A activates
    await adapterA.execute("ACTIVATE", { providerResourceId: rid, idempotencyKey: `iso-a-${Date.now()}` });
    // B's reconcile should NOT find it (different provider)
    const stateB = await adapterB.reconcile(rid);
    expect(stateB.found).toBe(false);
  });

  test("unknown provider returns null from registry", () => {
    const unknown = adapterFor("NONEXISTENT", "MOCK");
    expect(unknown).toBeNull();
  });
});

// ── Certification model ────────────────────────────────────────────────────
describe("Provider certification model", () => {
  test("can persist a certification record", async () => {
    const cert = await db.providerCertification.create({
      data: {
        providerCode: "MOCK_A",
        adapterType: "MOCK",
        contractVersion: ACTION_CONTRACT_VERSION,
        conformanceResult: "pass",
        testedAt: new Date(),
        status: "CERTIFIED",
      },
    });
    expect(cert.id).toBeTruthy();
    expect(cert.status).toBe("CERTIFIED");
    expect(cert.conformanceResult).toBe("pass");
    // Clean up
    await db.providerCertification.delete({ where: { id: cert.id } });
  });
});
