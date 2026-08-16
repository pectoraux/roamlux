// Connectivity session lifecycle service.
// Reserves → activates via adapter → records measurement → transitions session.
// Idempotent, reconciliation-safe, audited. Generic actions only (no provider coupling).
import { db } from "@/lib/db";
import { audit, emitEvent } from "@/lib/audit";
import { adapterForProvider } from "@/domain/adapters/registry";
import { assertSessionTransition, IllegalTransitionError } from "@/domain/kernel/state-machines";
import { randomUUID } from "crypto";
import type { ActionType, MeasurementSnapshot } from "@/domain/protocol";
import type { SessionState } from "@prisma/client";

function idemKey(...parts: string[]) {
  return parts.join("::");
}

// ensureEntitlement: entitlement is a precondition to activation.
// If none exists, grants a TRIAL entitlement (explicit origin, audited).
export async function ensureEntitlement(subjectId: string, offerId: string | null, resourceId: string) {
  if (offerId) {
    const existing = await db.entitlement.findFirst({
      where: { subjectId, offerId, active: true, validUntil: null },
    });
    if (existing) return existing;
  }
  const ent = await db.entitlement.create({
    data: {
      subjectId,
      offerId,
      origin: "TRIAL",
      quota: { dataGB: 2, sessions: 1 },
      validFrom: new Date(),
      active: true,
      metadata: { resourceId, note: "auto-trial for demo control-plane" },
    },
  });
  await audit({ actorId: subjectId, actorType: "user", action: "entitlement.create", targetType: "entitlement", targetId: ent.id, metadata: { origin: "TRIAL", offerId, resourceId } });
  await emitEvent("EntitlementCreated", { entitlementId: ent.id, subjectId, origin: "TRIAL" });
  return ent;
}

// createSessionFromDecision: full lifecycle for a SELECT decision.
export async function createSessionFromDecision(opts: {
  subjectId: string;
  intentId: string;
  resourceId: string;
  providerId: string;
  offerId?: string;
  policy?: any;
}): Promise<{ ok: boolean; sessionId?: string; state?: string; measurement?: MeasurementSnapshot; error?: string; adapterState?: string }> {
  const { subjectId, intentId, resourceId, providerId } = opts;

  // 1) Ensure entitlement (precondition).
  const offer = opts.offerId ? await db.offer.findUnique({ where: { id: opts.offerId } }) : null;
  const entitlement = await ensureEntitlement(subjectId, offer?.id ?? null, resourceId);

  // 2) Reserve the resource (idempotent).
  const ikey = idemKey("reserve", subjectId, intentId, resourceId);
  let reservation = await db.reservation.findUnique({ where: { idempotencyKey: ikey } });
  if (!reservation) {
    reservation = await db.reservation.create({
      data: {
        intentId,
        resourceId,
        entitlementId: entitlement.id,
        state: "RESERVED",
        idempotencyKey: ikey,
        expiresAt: new Date(Date.now() + 1000 * 60 * 30),
      },
    });
    await emitEvent("ResourceReserved", { reservationId: reservation.id, resourceId, subjectId });
  }

  // 3) Create session in REQUESTED state.
  let session = await db.connectivitySession.create({
    data: {
      subjectId,
      resourceId,
      providerId,
      reservationId: reservation.id,
      intentId,
      state: "REQUESTED",
      policy: opts.policy ?? {},
    },
  });

  // Transition REQUESTED → PROVISIONING
  await transition(session.id, "REQUESTED", "PROVISIONING", "provisioning_start", subjectId);

  // 4) Invoke adapter (generic ACTIVATE). Idempotent key ties duplicates together.
  const adapter = await adapterForProvider(providerId);
  if (!adapter) {
    await fail(session.id, subjectId, "NO_ADAPTER");
    return { ok: false, sessionId: session.id, state: "FAILED", error: "NO_ADAPTER" };
  }

  const resource = await db.resource.findUnique({ where: { id: resourceId } });
  const actKey = idemKey("activate", session.id);
  const result = adapter.execute("ACTIVATE", { providerResourceId: resource?.identifier ?? resourceId, idempotencyKey: actKey });

  if (!result.ok) {
    await fail(session.id, subjectId, result.error ?? "ADAPTER_FAILURE");
    // Mark reservation failed (recoverable).
    await db.reservation.update({ where: { id: reservation.id }, data: { state: "FAILED", failureReason: result.error } });
    return { ok: false, sessionId: session.id, state: "FAILED", error: result.error, adapterState: result.state };
  }

  // 5) Transition PROVISIONING → ACTIVE, record measurement.
  await transition(session.id, "PROVISIONING", "ACTIVE", "activated", subjectId);
  await db.reservation.update({ where: { id: reservation.id }, data: { state: "ACTIVE" } });
  await db.resource.update({ where: { id: resourceId }, data: { state: "active" } });

  let measurement: MeasurementSnapshot | undefined = result.measurement;
  if (measurement) {
    await db.measurement.create({
      data: {
        sessionId: session.id,
        latencyMs: measurement.latencyMs,
        downlinkMbps: measurement.downlinkMbps,
        uplinkMbps: measurement.uplinkMbps,
        packetLossPct: measurement.packetLossPct,
        jitterMs: measurement.jitterMs,
        availabilityPct: measurement.availabilityPct,
        source: measurement.source,
      },
    });
    await db.connectivitySession.update({ where: { id: session.id }, data: { startedAt: new Date(), currentQuality: measurement as any } });
    await emitEvent("MeasurementRecorded", { sessionId: session.id, measurement });
  } else {
    await db.connectivitySession.update({ where: { id: session.id }, data: { startedAt: new Date() } });
  }

  await emitEvent("SessionStarted", { sessionId: session.id, subjectId, providerId, resourceId });
  await audit({ actorId: subjectId, action: "session.activate", targetType: "session", targetId: session.id, metadata: { providerId, resourceId, intentId } });

  return { ok: true, sessionId: session.id, state: "ACTIVE", measurement };
}

// executeAction: generic action on a session (DEACTIVATE, MEASURE, SUSPEND, RESUME, RELEASE...).
export async function executeAction(opts: {
  sessionId: string;
  action: ActionType;
  subjectId: string;
}): Promise<{ ok: boolean; state?: string; measurement?: MeasurementSnapshot; error?: string }> {
  const session = await db.connectivitySession.findUnique({ where: { id: opts.sessionId }, include: { resource: true, reservation: true } });
  if (!session) return { ok: false, error: "NOT_FOUND" };

  const adapter = await adapterForProvider(session.providerId);
  if (!adapter) return { ok: false, error: "NO_ADAPTER" };
  if (!adapter.descriptor.supportedActions.includes(opts.action)) {
    return { ok: false, error: "ACTION_NOT_SUPPORTED" };
  }

  const actKey = idemKey(opts.action.toLowerCase(), session.id, randomUUID().slice(0, 8));
  const result = adapter.execute(opts.action, { providerResourceId: session.resource.identifier, idempotencyKey: actKey });

  // Apply state transitions based on action + result.
  const cur = session.state as SessionState;
  try {
    if (opts.action === "DEACTIVATE" || opts.action === "RELEASE") {
      if (canGo(cur, "TERMINATED")) {
        await transition(session.id, cur, "TERMINATED", opts.action, opts.subjectId);
        await db.reservation.updateMany({ where: { id: session.reservationId ?? undefined }, data: { state: "RELEASED" } });
        await db.connectivitySession.update({ where: { id: session.id }, data: { endedAt: new Date() } });
      }
    } else if (opts.action === "SUSPEND" && canGo(cur, "SUSPENDED")) {
      await transition(session.id, cur, "SUSPENDED", opts.action, opts.subjectId);
    } else if (opts.action === "RESUME" && canGo(cur, "ACTIVE")) {
      await transition(session.id, cur, "ACTIVE", opts.action, opts.subjectId);
    } else if (opts.action === "MEASURE" && result.measurement) {
      await db.measurement.create({
        data: {
          sessionId: session.id,
          latencyMs: result.measurement.latencyMs,
          downlinkMbps: result.measurement.downlinkMbps,
          uplinkMbps: result.measurement.uplinkMbps,
          packetLossPct: result.measurement.packetLossPct,
          jitterMs: result.measurement.jitterMs,
          availabilityPct: result.measurement.availabilityPct,
          source: result.measurement.source,
        },
      });
      await db.connectivitySession.update({ where: { id: session.id }, data: { currentQuality: result.measurement as any } });
    }
  } catch (e: any) {
    if (e instanceof IllegalTransitionError) {
      // Reconcile: log but don't crash.
      await audit({ actorId: opts.subjectId, action: "session.action.illegal", targetType: "session", targetId: session.id, result: "failure", reason: e.message });
    } else throw e;
  }

  await audit({ actorId: opts.subjectId, action: `session.${opts.action.toLowerCase()}`, targetType: "session", targetId: session.id, result: result.ok ? "success" : "failure", reason: result.error });
  return { ok: result.ok, state: result.state, measurement: result.measurement, error: result.error };
}

function canGo(from: SessionState, to: SessionState): boolean {
  try { assertSessionTransition(from, to); return true; } catch { return false; }
}

async function transition(sessionId: string, from: SessionState, to: SessionState, reason: string, actor: string) {
  assertSessionTransition(from, to);
  await db.$transaction([
    db.sessionTransition.create({ data: { sessionId, from, to, reason, actor } }),
    db.connectivitySession.update({ where: { id: sessionId }, data: { state: to } }),
  ]);
  await emitEvent("ActionCompleted", { sessionId, from, to, reason });
}

async function fail(sessionId: string, actor: string, reason: string) {
  const s = await db.connectivitySession.findUnique({ where: { id: sessionId } });
  if (!s) return;
  if (canGo(s.state as SessionState, "FAILED")) {
    await transition(sessionId, s.state as SessionState, "FAILED", reason, actor).catch(() => {});
  }
  await db.connectivitySession.update({ where: { id: sessionId }, data: { failureReason: reason } });
  await emitEvent("ProvisioningFailed", { sessionId, reason });
  await audit({ actorId: actor, action: "session.fail", targetType: "session", targetId: sessionId, result: "failure", reason });
}
