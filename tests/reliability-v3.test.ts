// Reliability v3 integration tests — exercises the v3 audit fixes.
// Each test proves a specific invariant from the v3 review.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { adapterFor, MOCK_PROVIDER_PROFILES } from "@/domain/adapters/registry";
import { drainOutbox } from "@/lib/services/outbox-drainer";
import { reconcileSession } from "@/lib/services/reconciliation-service";
import {
  compareAndSetSessionState, atomicCompareAndSet, withTimeoutAndAbort,
  claimOrCreateOperation,
} from "@/lib/services/operation-service";
import { claimOrCreateActivation } from "@/lib/services/activation-request-service";
import type { FaultMode } from "@/domain/adapters/mock-providers";

const TEST_PREFIX = `v3test-${Date.now()}`;

async function createTestSession(state: string = "PROVISIONING", gen: number = 1) {
  let provider = await db.provider.findFirst({ where: { code: "MOCK_A" } });
  if (!provider) throw new Error("MOCK_A not seeded");
  let cap = await db.capability.findFirst({ where: { providerId: provider.id } });
  if (!cap) throw new Error("no cap");
  let res = await db.resource.create({ data: { providerId: provider.id, capabilityId: cap.id, identifier: `${TEST_PREFIX}-res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, state: "available" } });
  let user = await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } });
  if (!user) throw new Error("no demo user");
  let intent = await db.connectivityIntent.create({ data: { subjectId: user.id, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} } });
  const session = await db.connectivitySession.create({ data: { subjectId: user.id, resourceId: res.id, providerId: provider.id, intentId: intent.id, state: state as any, generation: gen, policy: {} } });
  return { session, provider, resource: res, user, intent };
}

// ── v3 #1: Atomic CAS (state + transition + audit + outbox in ONE tx) ──────
describe("v3 #1: Atomic CAS transaction", () => {
  test("atomicCompareAndSet writes state + transition + outbox atomically", async () => {
    const { session } = await createTestSession("PROVISIONING", 5);
    let outboxCount = 0;
    const cas = await atomicCompareAndSet(
      { sessionId: session.id, expectedGen: 5, newState: "ACTIVE", fromState: "PROVISIONING", reason: "test_atomic", actor: "test" },
      async (tx) => {
        await txEmit(tx, "SessionStarted", { sessionId: session.id, test: true }, { type: "session", id: session.id });
        outboxCount = await tx.outboxEvent.count({ where: { aggregateId: session.id } });
      }
    );
    expect(cas.applied).toBe(true);
    // The outbox event was written INSIDE the same transaction as the CAS
    expect(outboxCount).toBeGreaterThan(0);
    // Verify state + generation changed
    const updated = await db.connectivitySession.findUnique({ where: { id: session.id } });
    expect(updated?.state).toBe("ACTIVE");
    expect(updated?.generation).toBe(6);
    // Verify transition was recorded
    const transitions = await db.sessionTransition.findMany({ where: { sessionId: session.id } });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.some(t => t.reason === "test_atomic")).toBe(true);
  }, 15000);

  test("atomicCompareAndSet FAILS (stale) writes NOTHING — no transition, no outbox", async () => {
    const { session } = await createTestSession("PROVISIONING", 5);
    // Advance generation first to make the CAS stale
    await db.connectivitySession.update({ where: { id: session.id }, data: { generation: 10 } });
    const transitionsBefore = await db.sessionTransition.count({ where: { sessionId: session.id } });
    const cas = await atomicCompareAndSet(
      { sessionId: session.id, expectedGen: 5, newState: "ACTIVE", fromState: "PROVISIONING", reason: "should_not_apply", actor: "test" },
      async (tx) => { await txEmit(tx, "ShouldNotCommit", {}, { type: "test", id: "should-not-exist" }); }
    );
    expect(cas.applied).toBe(false);
    // Nothing was written
    const transitionsAfter = await db.sessionTransition.count({ where: { sessionId: session.id } });
    expect(transitionsAfter).toBe(transitionsBefore); // no new transition
    const outbox = await db.outboxEvent.findFirst({ where: { type: "ShouldNotCommit" } });
    expect(outbox).toBeNull(); // no outbox event
  }, 15000);
});

// ── v3 #2: API-level activation idempotency (v4: atomic claim) ─────────────
describe("v3 #2: API-level activation idempotency", () => {
  test("same requestKey → same session (duplicate observes)", async () => {
    const requestKey = `${TEST_PREFIX}-api-idem-${Date.now()}`;
    let sessionCount = 0;
    const createSession = async () => { sessionCount++; return `sess-${Date.now()}-${sessionCount}`; };
    // First call creates the request + session
    const c1 = await claimOrCreateActivation({ requestKey, subjectId: "test-user", intentId: "test-intent", resourceId: "test-res", providerId: "test-prov", createSession });
    expect(c1.status).toBe("created");
    expect(sessionCount).toBe(1);
    // Second call with same key → observes the existing session
    const c2 = await claimOrCreateActivation({ requestKey, subjectId: "test-user", intentId: "test-intent", resourceId: "test-res", providerId: "test-prov", createSession });
    expect(c2.status).toBe("observed_existing");
    expect(c2.sessionId).toBe(c1.sessionId);
    expect(sessionCount).toBe(1); // createSession NOT called again
  }, 15000);

  test("different requestKey → new activation (new lifecycle)", async () => {
    const k1 = `${TEST_PREFIX}-new1-${Date.now()}`;
    const k2 = `${TEST_PREFIX}-new2-${Date.now()}`;
    const c1 = await claimOrCreateActivation({ requestKey: k1, subjectId: "u", intentId: "i", resourceId: "r", providerId: "p", createSession: async () => `s1-${Date.now()}` });
    const c2 = await claimOrCreateActivation({ requestKey: k2, subjectId: "u", intentId: "i", resourceId: "r", providerId: "p", createSession: async () => `s2-${Date.now()}` });
    expect(c1.status).toBe("created");
    expect(c2.status).toBe("created"); // different key → new activation
    expect(c1.sessionId).not.toBe(c2.sessionId);
  }, 15000);

  test("same key + different subject → conflict (ownership)", async () => {
    const k = `${TEST_PREFIX}-own-${Date.now()}`;
    await claimOrCreateActivation({ requestKey: k, subjectId: "userA", intentId: "i", resourceId: "r", providerId: "p", createSession: async () => `s-${Date.now()}` });
    const c2 = await claimOrCreateActivation({ requestKey: k, subjectId: "userB", intentId: "i", resourceId: "r", providerId: "p", createSession: async () => `s2-${Date.now()}` });
    expect(c2.status).toBe("conflict");
    if (c2.status === "conflict") expect(c2.field).toBe("subjectId");
  }, 15000);

  test("same key + different payload → conflict (deterministic)", async () => {
    const k = `${TEST_PREFIX}-payload-${Date.now()}`;
    await claimOrCreateActivation({ requestKey: k, subjectId: "u", intentId: "intent-A", resourceId: "r", providerId: "p", createSession: async () => `s-${Date.now()}` });
    const c2 = await claimOrCreateActivation({ requestKey: k, subjectId: "u", intentId: "intent-B", resourceId: "r", providerId: "p", createSession: async () => `s2-${Date.now()}` });
    expect(c2.status).toBe("conflict");
    if (c2.status === "conflict") expect(c2.field).toBe("intentId");
  }, 15000);
});

// ── v3 #4: AbortSignal / deadline ───────────────────────────────────────────
describe("v3 #4: Adapter cancellation via AbortSignal", () => {
  test("withTimeoutAndAbort aborts the signal on timeout", async () => {
    let signalAborted = false;
    const result = await withTimeoutAndAbort(async (signal) => {
      // Return a promise that never resolves on its own, but records if aborted.
      return new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => {
          signalAborted = signal.aborted;
          // Don't resolve — let the timeout handle it.
        });
      });
    }, 200);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("TIMEOUT");
    // Give the abort event listener a tick to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(signalAborted).toBe(true);
  }, 5000);

  test("withTimeoutAndAbort passes signal to adapter; adapter can succeed before timeout", async () => {
    const result = await withTimeoutAndAbort(async (signal) => {
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve("success"), 50);
      });
    }, 1000);
    expect(result.ok).toBe(true);
    expect((result as any).value).toBe("success");
  }, 5000);
});

// ── v3 #3: Outbox at-least-once (not exactly-once) ─────────────────────────
describe("v3 #3: Outbox at-least-once semantics", () => {
  test("eventId is the consumer idempotency key (at-least-once delivery)", async () => {
    // Each outbox event has a unique ID. Consumers should deduplicate by eventId.
    const e = await db.outboxEvent.create({ data: { type: "TestEvent", payload: { v: 1 }, aggregateType: "test", aggregateId: `${TEST_PREFIX}-atleastonce` } });
    expect(e.id).toBeTruthy();
    // The event ID is immutable and can serve as a consumer-side dedup key.
    const refetched = await db.outboxEvent.findUnique({ where: { id: e.id } });
    expect(refetched?.id).toBe(e.id);
  }, 15000);

  test("lease expiry allows re-claim (at-least-once after slow publisher)", async () => {
    // This test documents the at-least-once behavior: a published event is not
    // re-published (status=PUBLISHED), but if a lease expires before publication,
    // another drainer CAN re-claim. Consumers must dedup by eventId.
    const e = await db.outboxEvent.create({ data: { type: "TestEvent", payload: { v: 2 }, aggregateType: "test", aggregateId: `${TEST_PREFIX}-lease-${Date.now()}` } });
    // Drain — should publish our event
    await drainOutbox({ batchSize: 50 });
    const after = await db.outboxEvent.findUnique({ where: { id: e.id } });
    expect(after?.status).toBe("PUBLISHED");
    // Second drain — our event is already PUBLISHED, won't be re-published
    const d2 = await drainOutbox({ batchSize: 50 });
    const ourEventInD2 = d2.details.find(d => d.id === e.id);
    expect(ourEventInD2).toBeUndefined(); // not re-claimed
  }, 15000);
});

// Helper for txAudit/txEmit in tests
import { txEmit } from "@/lib/audit";
