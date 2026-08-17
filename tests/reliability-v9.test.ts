// Reliability v9 tests — proves lease/recovery for stranded CLAIMED requests.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { claimActivation, completeActivation, markActivationFailed, LEASE_MS } from "@/lib/services/activation-request-service";

const TEST_PREFIX = `v9test-${Date.now()}`;

// ── v9 #1: Stranded CLAIMED (crash after Phase 1) → reclaim on retry ────────
describe("v9 #1: Stranded CLAIMED recovery", () => {
  test("crash after CLAIMED → lease expires → second request reclaims → session created", async () => {
    const user = await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } });
    if (!user) { console.log("  (skipped)"); return; }
    const resource = await db.resource.findFirst({ where: { state: "available" } });
    if (!resource) { console.log("  (skipped)"); return; }
    const intent = await db.connectivityIntent.create({
      data: { subjectId: user.id, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} },
    });
    const requestKey = `${TEST_PREFIX}-stranded-${Date.now()}`;

    // Phase 1: claim
    const claim1 = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claim1.status).toBe("claimed");

    // Simulate crash: expire the lease manually.
    await db.activationRequest.update({
      where: { requestKey },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Second request reclaims.
    const claim2 = await claimActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id, providerId: resource.providerId,
    });
    expect(claim2.status).toBe("claimed");

    // Phase 3: complete.
    const result = await completeActivation({
      requestKey, claimToken: claim2.claimToken,
      createSession: async (tx) => {
        const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
        const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
        return s.id;
      },
    });
    expect(result.sessionId).toBeTruthy();

    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("CREATED");
    expect(ar?.sessionId).toBe(result.sessionId);
  }, 30000);
});

// ── v9 #2: Active CLAIMED → second caller gets IN_PROGRESS (no stealing) ────
describe("v9 #2: Active lease not stolen", () => {
  test("active CLAIMED → second caller gets IN_PROGRESS", async () => {
    const requestKey = `${TEST_PREFIX}-active-${Date.now()}`;

    const claim1 = await claimActivation({
      requestKey, subjectId: "v9user", intentId: "v9intent", resourceId: "v9res", providerId: "v9prov",
    });
    expect(claim1.status).toBe("claimed");

    // Second caller while lease is still valid.
    const claim2 = await claimActivation({
      requestKey, subjectId: "v9user", intentId: "v9intent", resourceId: "v9res", providerId: "v9prov",
    });
    expect(claim2.status).toBe("in_progress"); // don't steal

    // Clean up.
    await markActivationFailed(requestKey, claim1.claimToken);
  }, 15000);
});

// ── v9 #3: Concurrent reclaim — exactly one wins ───────────────────────────
describe("v9 #3: Concurrent reclaim CAS", () => {
  test("two callers observe expired CLAIMED → exactly one reclaims", async () => {
    const requestKey = `${TEST_PREFIX}-concurrent-${Date.now()}`;

    // Phase 1: claim
    const claim1 = await claimActivation({
      requestKey, subjectId: "v9user", intentId: "v9intent", resourceId: "v9res", providerId: "v9prov",
    });
    expect(claim1.status).toBe("claimed");

    // Expire the lease.
    await db.activationRequest.update({
      where: { requestKey },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });

    // Two concurrent reclaim attempts.
    const [r1, r2] = await Promise.all([
      claimActivation({ requestKey, subjectId: "v9user", intentId: "v9intent", resourceId: "v9res", providerId: "v9prov" }),
      claimActivation({ requestKey, subjectId: "v9user", intentId: "v9intent", resourceId: "v9res", providerId: "v9prov" }),
    ]);

    const claimedCount = [r1, r2].filter((r) => r.status === "claimed").length;
    const inProgressCount = [r1, r2].filter((r) => r.status === "in_progress").length;
    expect(claimedCount).toBe(1); // exactly one reclaimed
    expect(inProgressCount).toBe(1); // the other observed in_progress
  }, 15000);
});
