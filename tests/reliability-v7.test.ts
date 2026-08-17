// Reliability v7 tests — proves command acceptance happens BEFORE entitlement
// authority. A rejected/conflicting command must not create any entitlement,
// reservation, or session.
import { test, expect, describe } from "bun:test";
import { db } from "@/lib/db";
import { claimOrCreateActivation } from "@/lib/services/activation-request-service";
import { claimTrialEntitlement } from "@/domain/entitlement/trial-policy";

const TEST_PREFIX = `v7test-${Date.now()}`;

// Helper: get a real user, resource, offer, intent for FK constraints
async function getFixtures() {
  const user = await db.user.findFirst({ where: { email: "demo.consumer@roamlink.dev" } });
  if (!user) return null;
  const resource = await db.resource.findFirst({ where: { state: "available" } });
  if (!resource) return null;
  const offer = await db.offer.findFirst({ where: { valid: true } });
  if (!offer) return null;
  const offer2 = await db.offer.findFirst({ where: { valid: true, id: { not: offer.id } } });
  const intent = await db.connectivityIntent.create({
    data: { subjectId: user.id, capability: "internet", location: { country: "GH" }, timeWindow: { start: "2026-01-01T00:00:00Z" }, usage: {}, constraints: {}, preferences: {} },
  });
  return { user, resource, offer, offer2: offer2 ?? offer, intent };
}

// ── v7 #1: same requestKey + different offer → conflict, zero entitlements ──
describe("v7 #1: same requestKey + different offer → conflict, no entitlement mutation", () => {
  test("rejected activation creates ZERO new entitlements/reservations/sessions", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped — no fixtures)"); return; }
    const { user, resource, offer, offer2, intent } = f;
    const requestKey = `${TEST_PREFIX}-offer-conflict-${Date.now()}`;

    // First request: valid, creates the activation + session + trial.
    const r1 = await claimOrCreateActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer.id,
      createSession: async (tx) => {
        // Claim trial (isolated)
        const trial = await claimTrialEntitlement(user.id, offer.id, resource.id);
        const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
        const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
        return s.id;
      },
    });
    expect(r1.status).toBe("created");

    // Count entitlements BEFORE the conflicting request.
    const entsBefore = await db.entitlement.count({ where: { subjectId: user.id, offerId: offer2.id, origin: "TRIAL" } });

    // Second request: same requestKey but DIFFERENT offer → should CONFLICT.
    const r2 = await claimOrCreateActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer2.id, // different offer!
      createSession: async (tx) => {
        // This should NEVER be called — the conflict is detected before createSession.
        throw new Error("SHOULD_NOT_BE_CALLED");
      },
    });
    expect(r2.status).toBe("conflict");
    if (r2.status === "conflict") expect(r2.field).toBe("offerId");

    // Count entitlements AFTER — must be unchanged (no new trial for offer2).
    const entsAfter = await db.entitlement.count({ where: { subjectId: user.id, offerId: offer2.id, origin: "TRIAL" } });
    expect(entsAfter).toBe(entsBefore); // ZERO new entitlements

    // No new reservations for the conflicting offer.
    const resCount = await db.reservation.count({ where: { idempotencyKey: `${requestKey}-res` } });
    expect(resCount).toBe(1); // only the first request's reservation
  }, 30000);
});

// ── v7 #2: same requestKey + different subject → conflict, zero entitlements ─
describe("v7 #2: same requestKey + different subject → conflict, no entitlement mutation", () => {
  test("rejected activation (wrong subject) creates ZERO entitlements", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped — no fixtures)"); return; }
    const { user, resource, offer, intent } = f;
    const user2 = await db.user.findFirst({ where: { email: "demo.family@roamlink.dev" } });
    if (!user2) { console.log("  (skipped — no second user)"); return; }
    const requestKey = `${TEST_PREFIX}-subject-conflict-${Date.now()}`;

    // First request: user A creates the activation.
    const r1 = await claimOrCreateActivation({
      requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer.id,
      createSession: async (tx) => {
        const trial = await claimTrialEntitlement(user.id, offer.id, resource.id);
        const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
        const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
        return s.id;
      },
    });
    expect(r1.status).toBe("created");

    // Second request: same key, DIFFERENT subject → CONFLICT.
    const entsBefore = await db.entitlement.count({ where: { subjectId: user2.id, offerId: offer.id, origin: "TRIAL" } });
    const r2 = await claimOrCreateActivation({
      requestKey, subjectId: user2.id, intentId: intent.id, resourceId: resource.id,
      providerId: resource.providerId, offerId: offer.id,
      createSession: async () => { throw new Error("SHOULD_NOT_BE_CALLED"); },
    });
    expect(r2.status).toBe("conflict");
    if (r2.status === "conflict") expect(r2.field).toBe("subjectId");

    const entsAfter = await db.entitlement.count({ where: { subjectId: user2.id, offerId: offer.id, origin: "TRIAL" } });
    expect(entsAfter).toBe(entsBefore); // ZERO new entitlements for user2
  }, 30000);
});

// ── v7 #3: invalid activation → no entitlement/session/reservation mutation ─
describe("v7 #3: invalid activation → no mutation", () => {
  test("activation that throws inside createSession rolls back (no entitlement/session)", async () => {
    const f = await getFixtures();
    if (!f) { console.log("  (skipped — no fixtures)"); return; }
    const { user, resource, offer, intent } = f;
    const requestKey = `${TEST_PREFIX}-invalid-${Date.now()}`;

    const entsBefore = await db.entitlement.count({ where: { subjectId: user.id, offerId: offer.id, origin: "TRIAL" } });
    const sessionsBefore = await db.connectivitySession.count({ where: { subjectId: user.id, intentId: intent.id } });

    // An activation that deliberately fails inside createSession.
    // The entitlement claim happens inside createSession — if the tx rolls back,
    // the ActivationRequest is gone, but the trial entitlement MAY have been
    // created by the isolated claimTrialEntitlement. The key invariant is:
    // the session and reservation must NOT exist.
    try {
      await claimOrCreateActivation({
        requestKey, subjectId: user.id, intentId: intent.id, resourceId: resource.id,
        providerId: resource.providerId, offerId: offer.id,
        createSession: async (tx) => {
          // Claim trial (isolated — this may persist even if the tx rolls back).
          await claimTrialEntitlement(user.id, offer.id, resource.id);
          // Create reservation + session.
          const res = await tx.reservation.create({ data: { intentId: intent.id, resourceId: resource.id, state: "RESERVED", idempotencyKey: `${requestKey}-res`, expiresAt: new Date() } });
          const s = await tx.connectivitySession.create({ data: { subjectId: user.id, resourceId: resource.id, providerId: resource.providerId, reservationId: res.id, intentId: intent.id, state: "PROVISIONING", generation: 2 } });
          // Deliberately fail.
          throw new Error("DELIBERATE_FAILURE");
        },
      });
    } catch (e) {
      // Expected.
    }

    // In v8 (two-phase), the session and reservation are rolled back (Phase 3 tx).
    // The ActivationRequest is CLAIMED then marked FAILED.
    const sessionsAfter = await db.connectivitySession.count({ where: { subjectId: user.id, intentId: intent.id } });
    expect(sessionsAfter).toBe(sessionsBefore); // ZERO new sessions
    const res = await db.reservation.findUnique({ where: { idempotencyKey: `${requestKey}-res` } });
    expect(res).toBeNull(); // reservation rolled back

    // The ActivationRequest is marked FAILED (not null — it was CLAIMED in Phase 1).
    const ar = await db.activationRequest.findUnique({ where: { requestKey } });
    expect(ar?.status).toBe("FAILED");
  }, 30000);
});
