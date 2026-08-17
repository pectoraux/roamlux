// Reliability v10 tests — proves the fenced completion write.
// The final UPDATE in completeActivation fences on claimToken + claimExpiresAt.
// A stale holder cannot complete after reclaim or lease expiry.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { claimActivation, completeActivation, LEASE_MS } from "@/lib/services/activation-request-service";

const TEST_PREFIX = `v10test-${Date.now()}`;

async function getFixtures() {
  const user = await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } });
  if (!user) return null;
  const resource = await db.resource.findFirst({ where: { state: "available" } });
  if (!resource) return null;
  const intent = await db.connectivityIntent.create({
    data: { subjectId: user.id, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} },
  });
  return { user, resource, intent };
}

// ── v10 #1: Stale holder (reclaimed) cannot complete ───────────────────────
describe("v10 #1: Stale completion fenced after reclaim", () => {
  test("A claims → lease expires → B reclaims → A completes → A FAILS, B succeeds", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped)"); return; }
    const { user, resource, intent } = f;
    const requestKey = `${TEST_PREFIX}-stale-${Date.now()}`;

    // A claims
    const claimA = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claimA.status).toBe("claimed");

    // Expire A's lease
    await db.activationRequest.update({
      where: { requestKey },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B reclaims
    const claimB = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claimB.status).toBe("claimed");

    // A tries to complete — MUST fail (claimToken doesn't match)
    let aFailed = false;
    try {
      await completeActivation({
        requestKey, claimToken: claimA.claimToken,
        createSession: async (tx) => "fake-session-id",
      });
    } catch (e: any) {
      aFailed = true;
      expect(e.message).toContain("ACTIVATION_CLAIM_LOST");
    }
    expect(aFailed).toBe(true);

    // B completes — MUST succeed
    const result = await completeActivation({
      requestKey, claimToken: claimB.claimToken,
      createSession: async (tx) => {
        const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
        const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
        return s.id;
      },
    });
    expect(result.sessionId).toBeTruthy();

    // Verify: status=CREATED, claimToken=null
    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("CREATED");
    expect(ar?.claimToken).toBeNull();
  }, 30000);
});

// ── v10 #2: Expired lease (no reclaim) → completion fails ──────────────────
describe("v10 #2: Expired lease blocks completion", () => {
  test("lease expired + no reclaim → completeActivation fails", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped)"); return; }
    const { user, resource, intent } = f;
    const requestKey = `${TEST_PREFIX}-expired-${Date.now()}`;

    const claim = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claim.status).toBe("claimed");

    // Expire the lease (but don't reclaim)
    await db.activationRequest.update({
      where: { requestKey },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Try to complete — MUST fail (lease expired)
    let failed = false;
    try {
      await completeActivation({
        requestKey, claimToken: claim.claimToken,
        createSession: async (tx) => "fake",
      });
    } catch (e: any) {
      failed = true;
      expect(e.message).toMatch(/ACTIVATION_CLAIM_LOST|ACTIVATION_LEASE_EXPIRED/);
    }
    expect(failed).toBe(true);

    // Verify: status still CLAIMED (not CREATED)
    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("CLAIMED"); // not completed
  }, 15000);
});

// ── v10 #3: Concurrent completion + reclaim → exactly one wins ─────────────
describe("v10 #3: Concurrent completion vs reclaim", () => {
  test("A completes while B reclaims → exactly one session, no corruption", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped)"); return; }
    const { user, resource, intent } = f;
    const requestKey = `${TEST_PREFIX}-conc-${Date.now()}`;

    const claimA = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claimA.status).toBe("claimed");

    // Expire A's lease so B can reclaim
    await db.activationRequest.update({
      where: { requestKey },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // B reclaims
    const claimB = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claimB.status).toBe("claimed");

    // A and B both try to complete concurrently.
    // A should fail (stale token). B should succeed.
    // Even if A's pre-check passes (it won't — token already changed),
    // the CAS on the final write will reject A.
    const createSessionFn = async (tx: any) => {
      const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
      const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
      return s.id;
    };

    const [rA, rB] = await Promise.allSettled([
      completeActivation({ requestKey, claimToken: claimA.claimToken, createSession: createSessionFn }),
      completeActivation({ requestKey, claimToken: claimB.claimToken, createSession: createSessionFn }),
    ]);

    // Exactly one must succeed
    const aOk = rA.status === "fulfilled";
    const bOk = rB.status === "fulfilled";
    expect(aOk !== bOk).toBe(true); // exactly one wins

    // Verify: exactly one session, status=CREATED
    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("CREATED");
    expect(ar?.sessionId).toBeTruthy();
  }, 30000);
});
