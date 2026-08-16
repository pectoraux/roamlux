// Mock provider ecosystem — three providers with deliberately different profiles
// and DETERMINISTIC failure injection for reliability testing.
//
// CONCEPT SEPARATION (audit issue #6):
//   - ProviderResourceState: represents the PROVIDER RESOURCE (active/inactive).
//     Keyed by (providerCode, resourceIdentifier). This is what reconcile() queries.
//   - MockProviderCommand: records a COMMAND attempt (idempotency key, fault mode, result).
//     Keyed by idempotencyKey. This is adapter-level command idempotency.
//   These two concepts are NOT conflated.
//
// FAULT MODELS:
//   SUCCESS                — happy path
//   TIMEOUT                — never returns (caller MUST time out via bounded wrapper)
//   FAIL_BEFORE_SIDE_EFFECT — returns failure, no provider-side change
//   FAIL_AFTER_SIDE_EFFECT  — provider ACTIVATES, then returns failure to RoamLink
//                             (RoamLink must reconcile to discover the late success)
//   DUPLICATE               — returns success; duplicate requests return the same
//   STALE_STATE             — provider reports a state different from RoamLink's
//   SLOW_SUCCESS            — succeeds after a delay (models latency)
import type { AdapterDescriptor, ActionType, AdapterActionResult, MeasurementSnapshot } from "@/domain/protocol";
import { db } from "@/lib/db";

export type FaultMode =
  | "SUCCESS"
  | "TIMEOUT"
  | "FAIL_BEFORE_SIDE_EFFECT"
  | "FAIL_AFTER_SIDE_EFFECT"
  | "DUPLICATE"
  | "STALE_STATE"
  | "SLOW_SUCCESS";

export interface MockProviderProfile {
  code: string;
  name: string;
  type: "MOCK";
  supportedActions: ActionType[];
  coverage: { countries: string[]; regions: string[] };
  capabilityType: string;
  advertised: {
    maxDownlinkMbps: number;
    maxUplinkMbps: number;
    typicalLatencyMs: number;
    reliability: number;
    availabilityPct: number;
  };
  offers: Array<{
    name: string;
    priceCents: number;
    unit: string;
    billingModel?: any;
  }>;
  failureRate: number;
  latencyJitterMs: number;
  throughputVariancePct: number;
}

export const MOCK_PROFILES: MockProviderProfile[] = [
  {
    code: "MOCK_A",
    name: "Atlas WiFi Co-op",
    type: "MOCK",
    supportedActions: ["DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "MEASURE", "RELEASE"],
    coverage: { countries: ["GH", "NG", "KE", "US"], regions: ["West Africa", "East Africa", "NA"] },
    capabilityType: "wifi",
    advertised: { maxDownlinkMbps: 18, maxUplinkMbps: 6, typicalLatencyMs: 120, reliability: 0.86, availabilityPct: 92 },
    offers: [
      { name: "Atlas Daily", priceCents: 80, unit: "per_day", billingModel: { activationFeeCents: 25 } },
      { name: "Atlas Hourly", priceCents: 20, unit: "per_hour" },
    ],
    failureRate: 0.08,
    latencyJitterMs: 40,
    throughputVariancePct: 0.25,
  },
  {
    code: "MOCK_B",
    name: "Beacon Mobile (LTE)",
    type: "MOCK",
    supportedActions: ["DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "MEASURE", "RELEASE", "RENEW", "SUSPEND", "RESUME"],
    coverage: { countries: ["GH", "NG", "KE", "ZA", "US", "GB"], regions: ["Africa", "NA", "EU"] },
    capabilityType: "lte",
    advertised: { maxDownlinkMbps: 45, maxUplinkMbps: 15, typicalLatencyMs: 55, reliability: 0.96, availabilityPct: 98.5 },
    offers: [
      { name: "Beacon 5GB", priceCents: 350, unit: "per_gb", billingModel: { overageCentsPerGb: 70 } },
      { name: "Beacon Monthly", priceCents: 2400, unit: "flat" },
    ],
    failureRate: 0.02,
    latencyJitterMs: 12,
    throughputVariancePct: 0.12,
  },
  {
    code: "MOCK_C",
    name: "Crest eSIM Premium",
    type: "MOCK",
    supportedActions: ["DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "MEASURE", "RELEASE", "SWITCH", "RENEW"],
    coverage: { countries: ["*"], regions: ["Global"] },
    capabilityType: "esim_data",
    advertised: { maxDownlinkMbps: 120, maxUplinkMbps: 40, typicalLatencyMs: 28, reliability: 0.99, availabilityPct: 99.8 },
    offers: [
      { name: "Crest 10GB Global", priceCents: 1500, unit: "per_gb" },
      { name: "Crest Travel Pass", priceCents: 4200, unit: "flat" },
    ],
    failureRate: 0.0,
    latencyJitterMs: 6,
    throughputVariancePct: 0.06,
  },
];

export function getMockProfile(code: string): MockProviderProfile | undefined {
  return MOCK_PROFILES.find((p) => p.code === code);
}

export function describeMock(profile: MockProviderProfile): AdapterDescriptor {
  return {
    providerCode: profile.code,
    providerName: profile.name,
    type: profile.type,
    supportedActions: profile.supportedActions,
  };
}

function seededRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function observedMeasurement(profile: MockProviderProfile, key: string): MeasurementSnapshot {
  const r = seededRandom(profile.code + key);
  const jitter = (r - 0.5) * 2 * profile.latencyJitterMs;
  const latency = Math.max(5, profile.advertised.typicalLatencyMs + jitter);
  const tVar = (r - 0.5) * 2 * profile.throughputVariancePct;
  const downlink = Math.max(1, profile.advertised.maxDownlinkMbps * (1 - Math.abs(tVar)));
  return {
    latencyMs: Math.round(latency * 10) / 10,
    downlinkMbps: Math.round(downlink * 10) / 10,
    uplinkMbps: Math.round(profile.advertised.maxUplinkMbps * (1 - Math.abs(tVar)) * 10) / 10,
    packetLossPct: Math.round((1 - profile.advertised.reliability) * 100 * 100) / 100,
    jitterMs: Math.round(Math.abs(jitter / 2) * 10) / 10,
    availabilityPct: profile.advertised.availabilityPct,
    observedAt: new Date().toISOString(),
    source: "mock_adapter_observed",
  };
}

// Get or create the PROVIDER RESOURCE STATE (represents the resource, not a command).
async function getOrCreateResourceState(providerCode: string, resourceIdentifier: string) {
  let state = await db.providerResourceState.findUnique({
    where: { providerCode_resourceIdentifier: { providerCode, resourceIdentifier } },
  });
  if (!state) {
    state = await db.providerResourceState.create({
      data: { providerCode, resourceIdentifier, state: "inactive" },
    });
  }
  return state;
}

// Get or create the COMMAND LOG entry (records the attempt, not the resource state).
async function getOrCreateCommand(idempotencyKey: string, providerCode: string, resourceIdentifier: string, faultMode: FaultMode) {
  let cmd = await db.mockProviderCommand.findUnique({ where: { idempotencyKey } });
  if (!cmd) {
    cmd = await db.mockProviderCommand.create({
      data: { idempotencyKey, providerCode, resourceIdentifier, faultMode, result: "pending" },
    });
  }
  return cmd;
}

// Execute a mock action with persistent state and fault injection.
export async function executeMockAction(
  profile: MockProviderProfile,
  action: ActionType,
  opts: { providerResourceId: string; idempotencyKey: string; faultMode?: FaultMode }
): Promise<AdapterActionResult> {
  const key = opts.idempotencyKey;
  const fault = opts.faultMode ?? "SUCCESS";
  const rid = opts.providerResourceId;

  // Get/create the two separated records.
  const resourceState = await getOrCreateResourceState(profile.code, rid);
  const command = await getOrCreateCommand(key, profile.code, rid, fault);

  // Command-level idempotency: if this command already completed, return its result.
  if (command.result === "success") {
    return {
      ok: true, providerResourceId: rid, state: resourceState.state,
      measurement: action === "ACTIVATE" ? observedMeasurement(profile, key) : undefined,
      idempotent: true, reconciled: true,
    };
  }
  if (command.result === "failure") {
    return { ok: false, providerResourceId: rid, state: "failed", error: "MOCK_COMMAND_PREVIOUSLY_FAILED", idempotent: true };
  }

  if (action === "ACTIVATE") {
    switch (command.faultMode) {
      case "TIMEOUT":
        // Never returns. The caller MUST use a bounded timeout wrapper.
        // The provider did NOT activate (no side effect).
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "timeout" } });
        return new Promise(() => {}); // hangs forever — caller must time out
      case "FAIL_BEFORE_SIDE_EFFECT":
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "failure", completedAt: new Date() } });
        return { ok: false, providerResourceId: rid, state: "failed", error: "MOCK_FAIL_BEFORE_SIDE_EFFECT", idempotent: false };
      case "FAIL_AFTER_SIDE_EFFECT":
        // Provider ACTIVATES the resource (side effect happens), then returns failure.
        // RoamLink thinks it failed, but the provider resource is actually active.
        // Reconciliation will discover this late success.
        await db.providerResourceState.update({
          where: { id: resourceState.id },
          data: { state: "active", activatedAt: new Date(), lastCommandKey: key },
        });
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "failure", completedAt: new Date() } });
        return { ok: false, providerResourceId: rid, state: "failed", error: "MOCK_FAIL_AFTER_SIDE_EFFECT", idempotent: false };
      case "STALE_STATE":
        await db.providerResourceState.update({
          where: { id: resourceState.id },
          data: { state: "suspended", activatedAt: new Date(), lastCommandKey: key },
        });
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "success", completedAt: new Date() } });
        return { ok: true, providerResourceId: rid, state: "suspended", measurement: observedMeasurement(profile, key), idempotent: false };
      case "SLOW_SUCCESS":
        await new Promise((r) => setTimeout(r, 2000));
        await db.providerResourceState.update({
          where: { id: resourceState.id },
          data: { state: "active", activatedAt: new Date(), lastCommandKey: key },
        });
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "success", completedAt: new Date() } });
        return { ok: true, providerResourceId: rid, state: "active", measurement: observedMeasurement(profile, key), idempotent: false };
      case "DUPLICATE":
        await db.providerResourceState.update({
          where: { id: resourceState.id },
          data: { state: "active", activatedAt: new Date(), lastCommandKey: key },
        });
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "success", completedAt: new Date() } });
        return { ok: true, providerResourceId: rid, state: "active", measurement: observedMeasurement(profile, key), idempotent: false };
      case "SUCCESS":
      default:
        await db.providerResourceState.update({
          where: { id: resourceState.id },
          data: { state: "active", activatedAt: new Date(), lastCommandKey: key },
        });
        await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "success", completedAt: new Date() } });
        return { ok: true, providerResourceId: rid, state: "active", measurement: observedMeasurement(profile, key), idempotent: false };
    }
  }

  if (action === "DEACTIVATE" || action === "RELEASE") {
    await db.providerResourceState.update({
      where: { id: resourceState.id },
      data: { state: "inactive", lastCommandKey: key },
    });
    await db.mockProviderCommand.update({ where: { id: command.id }, data: { result: "success", completedAt: new Date() } });
    return { ok: true, providerResourceId: rid, state: "inactive", idempotent: true };
  }

  if (action === "MEASURE") {
    return {
      ok: true, providerResourceId: rid,
      state: resourceState.state,
      measurement: observedMeasurement(profile, key),
      idempotent: true,
    };
  }

  if (action === "RESERVE") {
    return { ok: true, providerResourceId: rid, state: "reserved", idempotent: false };
  }

  return { ok: false, providerResourceId: rid, state: "unknown", error: `ACTION_NOT_SUPPORTED:${action}`, idempotent: false };
}

// RECONCILIATION: query the provider's actual RESOURCE STATE (not command state).
export async function queryMockProviderState(providerCode: string, resourceIdentifier: string): Promise<{ state: string; found: boolean }> {
  const state = await db.providerResourceState.findUnique({
    where: { providerCode_resourceIdentifier: { providerCode, resourceIdentifier } },
  });
  if (!state) return { state: "unknown", found: false };
  return { state: state.state, found: true };
}
