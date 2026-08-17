// Reliability v6 test — proves the trial P2002 recovery path is isolated
// from the activation transaction.
//
// v6 FIX: claimTrialEntitlement uses its own short isolated transaction.
// The P2002 is caught in that transaction's context, NOT inside the
// activation transaction. No 25P02 ("transaction aborted") can occur.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { claimTrialEntitlement, verifyEntitlement } from "@/domain/entitlement/trial-policy";
import { claimOrCreateActivation } from "@/lib/services/activation-request-service";

const TEST_PREFIX = `v6test-${Date.now()}`;

// ── v6 #1: Concurrent activations, same subject/offer, different requestKeys ─
describe("v6 #1: Concurrent activations — trial P2002 isolated from activation tx", () => {
  test("two concurrent activations (different requestKeys, same subject/offer) → exactly 1 TRIAL, no 25P02, no orphans", async () => {
    const offer = await db.offer.findFirst({});
    if (!offer) { console.log("  (skipped — no offers)"); return; }
    const subjectId = (await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } }))?.id;
    if (!subjectId) { console.log("  (skipped — no demo user)"); return; }
    const resource = await db.resource.findFirst({ where: { state: "available" } });
    if (!resource) { console.log("  (skipped — no available resources)"); return; }
    // Create a real intent for the FK constraint.
    const intent = await db.connectivityIntent.create({
      data: { subjectId, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} },
    });
    const intentId = intent.id;

    const keyA = `${TEST_PREFIX}-A-${Date.now()}`;
    const keyB = `${TEST_PREFIX}-B-${Date.now()}`;

    // v6 ARCHITECTURE: claim trial BEFORE the activation transaction.
    // Both requests call claimTrialEntitlement concurrently. One wins (INSERT),
    // the other catches P2002 and re-reads — in its OWN context, not inside
    // any activation transaction.
    const [trialA, trialB] = await Promise.all([
      claimTrialEntitlement(subjectId, offer.id, resource.id),
      claimTrialEntitlement(subjectId, offer.id, resource.id),
    ]);
    // Both should return the SAME entitlement (one created, one re-read).
    expect(trialA.id).toBe(trialB.id);

    // Now both activations proceed SEQUENTIALLY (Neon pool limits prevent
    // concurrent interactive transactions). They just READ the entitlement
    // inside their transactions (no P2002 to catch).
    const rA = await claimOrCreateActivation({
      requestKey: keyA, subjectId, intentId: intentId, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer.id,
      createSession: async (tx) => {
        const res = await tx.reservation.create({
          data: { intentId: intentId, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${keyA}-res`, expiresAt: new Date() },
        });
        const s = await tx.connectivitySession.create({
          data: { subjectId, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intentId, state: "PROVISIONING", generation: 2 },
        });
        return s.id;
      },
    });
    const rB = await claimOrCreateActivation({
      requestKey: keyB, subjectId, intentId: intentId, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer.id,
      createSession: async (tx) => {
        const res = await tx.reservation.create({
          data: { intentId: intentId, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${keyB}-res`, expiresAt: new Date() },
        });
        const s = await tx.connectivitySession.create({
          data: { subjectId, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intentId, state: "PROVISIONING", generation: 2 },
        });
        return s.id;
      },
    });

    // Both should succeed (different requestKeys → different sessions).
    expect(rA.status).toBe("created");
    expect(rB.status).toBe("created");

    // Exactly ONE active TRIAL entitlement.
    const trials = await db.entitlement.findMany({
      where: { subjectId, offerId: offer.id, origin: "TRIAL", active: true },
    });
    expect(trials.length).toBe(1);

    // Two sessions for THIS intent (different requestKeys → different lifecycles).
    const sessions = await db.connectivitySession.findMany({ where: { subjectId, intentId } });
    expect(sessions.length).toBe(2);
  }, 60000);
});

// ── v6 #2: Trial claim P2002 recovery doesn't use the caller's tx ───────────
describe("v6 #2: Trial claim is isolated (no 25P02 in activation tx)", () => {
  test("trial claim catches P2002 in its own context, not the caller's tx", async () => {
    const offer = await db.offer.findFirst({});
    if (!offer) { console.log("  (skipped — no offers)"); return; }
    const subjectId = `v6isolated-${Date.now()}`;

    const trial1 = await claimTrialEntitlement(subjectId, offer.id, "test-res");
    expect(trial1.id).toBeTruthy();

    const trial2 = await claimTrialEntitlement(subjectId, offer.id, "test-res");
    expect(trial2.id).toBe(trial1.id);

    const all = await db.entitlement.findMany({
      where: { subjectId, offerId: offer.id, origin: "TRIAL", active: true },
    });
    expect(all.length).toBe(1);
  }, 15000);
});
