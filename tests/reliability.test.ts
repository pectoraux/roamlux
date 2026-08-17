// Reliability integration tests — exercises each invariant from the audit.
// These tests hit the database (Neon) and the mock adapter, proving the
// invariants hold under realistic conditions.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { adapterFor, MOCK_PROVIDER_PROFILES } from "@/domain/adapters/registry";
import { drainOutbox } from "@/lib/services/outbox-drainer";
import { reconcileSession } from "@/lib/services/reconciliation-service";
import { compareAndSetSessionState, claimOrCreateOperation, withTimeout } from "@/lib/services/operation-service";
import type { FaultMode } from "@/domain/adapters/mock-providers";

const TEST_PREFIX = `reltest-${Date.now()}`;

// Helper: create a minimal session directly in the DB for testing.
async function createTestSession(state: string = "PROVISIONING", gen: number = 1) {
  let provider = await db.provider.findFirst({ where: { code: "MOCK_A" } });
  if (!provider) throw new Error("MOCK_A provider not seeded");
  let cap = await db.capability.findFirst({ where: { providerId: provider.id } });
  if (!cap) throw new Error("no capability for MOCK_A");
  let res = await db.resource.create({ data: { providerId: provider.id, capabilityId: cap.id, identifier: `${TEST_PREFIX}-res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, state: "available" } });
  let user = await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } });
  if (!user) throw new Error("demo consumer not seeded");
  let intent = await db.connectivityIntent.create({ data: { subjectId: user.id, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} } });
  const session = await db.connectivitySession.create({ data: { subjectId: user.id, resourceId: res.id, providerId: provider.id, intentId: intent.id, state: state as any, generation: gen, policy: {} } });
  return { session, provider, resource: res, user, intent };
}

// ── #1: Bounded Timeout ─────────────────────────────────────────────────────
describe("#1 Bounded adapter timeout", () => {
  test("TIMEOUT fault is bounded by withTimeout — never hangs", async () => {
    const profile = MOCK_PROVIDER_PROFILES[0];
    const adapter = adapterFor(profile.code, "MOCK")!;
    const key = `${TEST_PREFIX}-timeout-${Date.now()}`;
    const promise = adapter.execute("ACTIVATE", { providerResourceId: `${TEST_PREFIX}-timeout-res`, idempotencyKey: key, faultMode: "TIMEOUT" as FaultMode });
    const result = await withTimeout(promise, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("TIMEOUT");
  }, 10000);

  test("withTimeout returns the value on success", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result.ok).toBe(true);
    expect((result as any).value).toBe(42);
  });
});

// ── #2: FAIL_AFTER_SIDE_EFFECT → reconciliation ────────────────────────────
describe("#2 Late success via reconciliation", () => {
  test("FAIL_AFTER_SIDE_EFFECT: session FAILED, provider ACTIVE → reconcile → ACTIVE", async () => {
    const { session, resource, provider } = await createTestSession("PROVISIONING", 1);
    const adapter = adapterFor(provider.code, "MOCK")!;
    const key = `${TEST_PREFIX}-late-${session.id}`;
    const result = await adapter.execute("ACTIVATE", { providerResourceId: resource.identifier, idempotencyKey: key, faultMode: "FAIL_AFTER_SIDE_EFFECT" as FaultMode });
    expect(result.ok).toBe(false);

    await db.connectivitySession.update({ where: { id: session.id }, data: { state: "FAILED", generation: 2 } });

    const providerState = await adapter.reconcile(resource.identifier);
    expect(providerState.state).toBe("active");

    const recon = await reconcileSession(session.id);
    expect(recon.action).toBe("ACTIVATED_LATE");

    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("ACTIVE");
  }, 30000);
});

// ── #3: Compare-and-Set Fencing ─────────────────────────────────────────────
describe("#3 Compare-and-set fencing", () => {
  test("CAS succeeds when generation matches", async () => {
    const { session } = await createTestSession("PROVISIONING", 5);
    const cas = await compareAndSetSessionState({ sessionId: session.id, expectedGen: 5, newState: "ACTIVE" });
    expect(cas.applied).toBe(true);
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("ACTIVE");
    expect(updated?.generation).toBe(6);
  }, 15000);

  test("CAS FAILS when generation changed (stale operation)", async () => {
    const { session } = await createTestSession("PROVISIONING", 5);
    await db.connectivitySession.update({ where: { id: session.id }, data: { generation: 10 } });
    const cas = await compareAndSetSessionState({ sessionId: session.id, expectedGen: 5, newState: "ACTIVE" });
    expect(cas.applied).toBe(false);
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("PROVISIONING");
    expect(updated?.generation).toBe(10);
  }, 15000);
});

// ── #4: Lifecycle-Scoped Operation Identity ────────────────────────────────
// NOTE: sessionId is NOT passed to claimOrCreateOperation here because it's a FK.
// The idempotency key already encodes lifecycle identity.
describe("#4 Operation identity across lifecycles", () => {
  test("same idempotency key → same operation (idempotent)", async () => {
    const key = `${TEST_PREFIX}-idem-${Date.now()}`;
    const c1 = await claimOrCreateOperation({ idempotencyKey: key, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1, requestPayload: { a: 1 } });
    expect(c1.shouldExecute).toBe(true);
    const c2 = await claimOrCreateOperation({ idempotencyKey: key, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1, requestPayload: { a: 1 } });
    expect(c2.shouldExecute).toBe(false);
    expect(c2.result?.status).toBe("observed_running");
  }, 15000);

  test("different lifecycle (different key) → different operation", async () => {
    const key1 = `${TEST_PREFIX}-life1-${Date.now()}`;
    const key2 = `${TEST_PREFIX}-life2-${Date.now()}`;
    const c1 = await claimOrCreateOperation({ idempotencyKey: key1, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1 });
    const c2 = await claimOrCreateOperation({ idempotencyKey: key2, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1 });
    expect(c1.shouldExecute).toBe(true);
    expect(c2.shouldExecute).toBe(true);
    expect(c1.operation.id).not.toBe(c2.operation.id);
  }, 15000);

  test("same key + different payload → REJECTED", async () => {
    const key = `${TEST_PREFIX}-conflict-${Date.now()}`;
    await claimOrCreateOperation({ idempotencyKey: key, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1, requestPayload: { a: 1 } });
    const c2 = await claimOrCreateOperation({ idempotencyKey: key, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1, requestPayload: { a: 2 } });
    expect(c2.shouldExecute).toBe(false);
    expect(c2.result?.status).toBe("payload_conflict");
  }, 15000);

  test("terminated → new activation creates NEW operation (different sessionId → different key)", async () => {
    // Simulate: session1 is TERMINATED, session2 is a new lifecycle.
    // The idempotency keys are "activate::<sessionId1>" and "activate::<sessionId2>".
    // Different sessionIds → different keys → different operations.
    const sid1 = `session-${Date.now()}-1`;
    const sid2 = `session-${Date.now()}-2`;
    const key1 = `activate::${sid1}`;
    const key2 = `activate::${sid2}`;
    const c1 = await claimOrCreateOperation({ idempotencyKey: key1, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1 });
    const c2 = await claimOrCreateOperation({ idempotencyKey: key2, actionType: "ACTIVATE", subjectId: "test-user", operationGen: 1 });
    expect(c1.operation.id).not.toBe(c2.operation.id);
    expect(c1.shouldExecute).toBe(true);
    expect(c2.shouldExecute).toBe(true);
  }, 15000);
});

// ── #5: Concurrent Outbox Drainers ──────────────────────────────────────────
describe("#5 Concurrent outbox drainer safety", () => {
  test("two simultaneous drainers never both publish the same event", async () => {
    // Create test events with a unique aggregateId prefix so we can track them.
    const testAggPrefix = `${TEST_PREFIX}-drain`;
    const createdIds = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const e = await db.outboxEvent.create({ data: { type: "TestEvent", payload: { i }, aggregateType: "test", aggregateId: `${testAggPrefix}-${i}` } });
      createdIds.add(e.id);
    }
    const [d1, d2] = await Promise.all([
      drainOutbox({ batchSize: 50 }),
      drainOutbox({ batchSize: 50 }),
    ]);
    // Filter to only OUR events (the drainer may also publish events from other tests).
    const ourPublished = [...d1.details, ...d2.details].filter(d => createdIds.has(d.id) && d.status === "published");
    const publishedIds = ourPublished.map(d => d.id);
    // No event published twice (the core invariant).
    const uniqueIds = new Set(publishedIds);
    expect(uniqueIds.size).toBe(publishedIds.length);
    // All 5 of our events were published exactly once.
    expect(publishedIds.length).toBe(5);
  }, 30000);
});

// ── #6: Provider Resource State vs Command Separation ─────────────────────
describe("#6 ProviderResourceState vs MockProviderCommand separation", () => {
  test("ProviderResourceState represents the resource (keyed by provider+resource)", async () => {
    const rid = `${TEST_PREFIX}-state-${Date.now()}`;
    await db.providerResourceState.upsert({
      where: { providerCode_resourceIdentifier: { providerCode: "MOCK_A", resourceIdentifier: rid } },
      create: { providerCode: "MOCK_A", resourceIdentifier: rid, state: "inactive" },
      update: {},
    });
    const state = await db.providerResourceState.findUnique({
      where: { providerCode_resourceIdentifier: { providerCode: "MOCK_A", resourceIdentifier: rid } },
    });
    expect(state).toBeTruthy();
    expect(state?.state).toBe("inactive");
  }, 15000);

  test("MockProviderCommand represents a command (keyed by idempotencyKey)", async () => {
    const key = `${TEST_PREFIX}-cmd-${Date.now()}`;
    await db.mockProviderCommand.create({
      data: { idempotencyKey: key, providerCode: "MOCK_A", resourceIdentifier: "test-res", faultMode: "SUCCESS", result: "success" },
    });
    const cmd = await db.mockProviderCommand.findUnique({ where: { idempotencyKey: key } });
    expect(cmd).toBeTruthy();
    expect(cmd?.faultMode).toBe("SUCCESS");
    expect(cmd?.result).toBe("success");
  }, 15000);
});

// ── #7: Provider Lost While ACTIVE ──────────────────────────────────────────
describe("#7 Provider lost while ACTIVE", () => {
  test("RoamLink=ACTIVE, Provider=INACTIVE → reconcile → TERMINATED", async () => {
    const { session, resource, provider } = await createTestSession("ACTIVE", 1);
    await db.providerResourceState.upsert({
      where: { providerCode_resourceIdentifier: { providerCode: provider.code, resourceIdentifier: resource.identifier } },
      create: { providerCode: provider.code, resourceIdentifier: resource.identifier, state: "inactive" },
      update: { state: "inactive" },
    });
    const recon = await reconcileSession(session.id);
    expect(recon.action).toBe("TERMINATED_MISSING");
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("TERMINATED");
  }, 30000);
});

// ── #8: Provider ACTIVE while RoamLink FAILED ───────────────────────────────
describe("#8 Provider ACTIVE while RoamLink FAILED", () => {
  test("RoamLink=FAILED, Provider=ACTIVE → reconcile → ACTIVE", async () => {
    const { session, resource, provider } = await createTestSession("FAILED", 1);
    await db.providerResourceState.upsert({
      where: { providerCode_resourceIdentifier: { providerCode: provider.code, resourceIdentifier: resource.identifier } },
      create: { providerCode: provider.code, resourceIdentifier: resource.identifier, state: "active", activatedAt: new Date() },
      update: { state: "active", activatedAt: new Date() },
    });
    const recon = await reconcileSession(session.id);
    expect(recon.action).toBe("ACTIVATED_LATE");
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("ACTIVE");
  }, 30000);
});

// ── Fencing Race: concurrent operations ─────────────────────────────────────
describe("Fencing race condition", () => {
  test("concurrent CAS: only one operation applies, the other is fenced", async () => {
    const { session } = await createTestSession("PROVISIONING", 5);
    // Two concurrent CAS with the same expectedGen — only one can succeed.
    const [r1, r2] = await Promise.all([
      compareAndSetSessionState({ sessionId: session.id, expectedGen: 5, newState: "ACTIVE" }),
      compareAndSetSessionState({ sessionId: session.id, expectedGen: 5, newState: "TERMINATED" }),
    ]);
    // Exactly one must succeed
    expect(r1.applied ? 1 : 0 + r2.applied ? 1 : 0).toBe(1);
    expect(r1.applied !== r2.applied).toBe(true); // exactly one
    // The session's generation is now 6 (one increment)
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.generation).toBe(6);
  }, 15000);
});
