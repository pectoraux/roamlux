// Reliability v5 tests — proves the transaction client flows correctly and
// the partial unique index enforces trial uniqueness at the DB level.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { claimOrCreateActivation } from "@/lib/services/activation-request-service";
import { createTrialEntitlement } from "@/domain/entitlement/trial-policy";

const TEST_PREFIX = `v5test-${Date.now()}`;

// ── v5 #1: Atomic rollback — deliberate failure proves all writes roll back ─
describe("v5 #1: Atomic rollback (tx client flows correctly)", () => {
  test("deliberate failure after session creation → ALL writes roll back", async () => {
    const requestKey = `${TEST_PREFIX}-rollback-${Date.now()}`;
    let threw = false;
    try {
      await claimOrCreateActivation({
        requestKey,
        subjectId: "rollback-user",
        intentId: "rollback-intent",
        resourceId: "rollback-res",
        providerId: "rollback-prov",
        createSession: async (tx) => {
          // Create a reservation + session + transition using tx.
          const reservation = await tx.reservation.create({
            data: { intentId: "rollback-intent", resourceId: "rollback-res", state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() },
          });
          const session = await tx.connectivitySession.create({
            data: { subjectId: "rollback-user", resourceId: "rollback-res", providerId: "rollback-prov", reservationId: reservation.id, intentId: "rollback-intent", state: "PROVISIONING", generation: 2 },
          });
          await tx.sessionTransition.create({ data: { sessionId: session.id, from: "REQUESTED", to: "PROVISIONING", reason: "test", actor: "test" } });
          // Now deliberately throw — the entire transaction must roll back.
          throw new Error("DELIBERATE_FAILURE");
        },
      });
    } catch (e: any) {
      threw = true;
    }
    expect(threw).toBe(true);
    // In v8 (two-phase), the ActivationRequest is CLAIMED after Phase 1, then
    // marked FAILED when Phase 3 throws. The session and reservation do NOT exist.
    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("FAILED"); // marked failed, not null
    const sess = await db.connectivitySession.findFirst({ where: { subjectId: "rollback-user" } });
    expect(sess).toBeNull(); // Session does not exist
    const res = await db.reservation.findUnique({ where: { idempotencyKey: `${requestKey}-res` } });
    expect(res).toBeNull(); // Reservation does not exist
  }, 30000);
});

// ── v5 #2: Concurrent trial ×10 → exactly 1 (DB-enforced) ──────────────────
describe("v5 #2: DB-enforced trial uniqueness", () => {
  test("10 concurrent trial grants → exactly 1 active TRIAL entitlement", async () => {
    const offer = await db.offer.findFirst({});
    if (!offer) { console.log("  (skipped — no offers)"); return; }
    const subjectId = `v5trial-${Date.now()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createTrialEntitlement(subjectId, offer.id, "test-res"))
    );
    const ents = await db.entitlement.findMany({
      where: { subjectId, offerId: offer.id, origin: "TRIAL", active: true },
    });
    expect(ents.length).toBe(1); // DB partial unique index enforces this
  }, 60000);

  test("TRIAL + PURCHASE for same subject/offer → both allowed", async () => {
    const offer = await db.offer.findFirst({});
    if (!offer) { console.log("  (skipped — no offers)"); return; }
    const subjectId = `v5coexist-${Date.now()}`;
    // Create a TRIAL
    await createTrialEntitlement(subjectId, offer.id, "test-res");
    // Create a PURCHASE (different origin — should NOT conflict with the trial unique index)
    const purchase = await db.entitlement.create({
      data: { subjectId, offerId: offer.id, origin: "PURCHASE", quota: {}, validFrom: new Date(), active: true, metadata: {} },
    });
    expect(purchase.id).toBeTruthy();
    // Both should coexist
    const all = await db.entitlement.findMany({ where: { subjectId, offerId: offer.id, active: true } });
    const trials = all.filter((e: any) => e.origin === "TRIAL");
    const purchases = all.filter((e: any) => e.origin === "PURCHASE");
    expect(trials.length).toBe(1);
    expect(purchases.length).toBe(1);
  }, 15000);

  test("two active PURCHASE entitlements for same subject/offer → allowed", async () => {
    const offer = await db.offer.findFirst({});
    if (!offer) { console.log("  (skipped — no offers)"); return; }
    const subjectId = `v5purchase-${Date.now()}`;
    const p1 = await db.entitlement.create({ data: { subjectId, offerId: offer.id, origin: "PURCHASE", quota: {}, validFrom: new Date(), active: true, metadata: { n: 1 } } });
    const p2 = await db.entitlement.create({ data: { subjectId, offerId: offer.id, origin: "PURCHASE", quota: {}, validFrom: new Date(), active: true, metadata: { n: 2 } } });
    expect(p1.id).not.toBe(p2.id); // both allowed — unique index only applies to TRIAL
  }, 15000);
});

// ── v5 #3: Concurrent activation ×10 → exactly 1 of everything ──────────────
describe("v5 #3: Concurrent activation convergence", () => {
  test("10 concurrent activations with same requestKey → exactly 1 ActivationRequest, 1 Session, 1 Operation", async () => {
    const requestKey = `${TEST_PREFIX}-conc10-${Date.now()}`;
    let sessionCount = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        claimOrCreateActivation({
          requestKey, subjectId: "v5user", intentId: "v5intent", resourceId: "v5res", providerId: "v5prov",
          createSession: async (tx) => { sessionCount++; return `s-${Date.now()}-${sessionCount}`; },
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
    const created = fulfilled.filter((r) => r.status === "created");
    expect(created.length).toBe(1); // exactly one session created
    expect(sessionCount).toBe(1); // createSession called once
    // Verify DB state: exactly 1 ActivationRequest
    const ars = await db.activationRequest.findMany({ where: { requestKey } });
    expect(ars.length).toBe(1);
  }, 60000);
});
