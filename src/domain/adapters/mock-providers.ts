// Mock provider ecosystem — three providers with deliberately different profiles.
// Provider A: cheap, high latency. Provider B: medium price, high reliability.
// Provider C: expensive, excellent performance.
// Deterministic simulated failures are supported via a failureRate knob.

import type { AdapterDescriptor, ActionType, AdapterActionResult, MeasurementSnapshot } from "@/domain/protocol";

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
  // Deterministic simulated failure injection.
  failureRate: number; // 0..1 probability that an ACTIVATE fails
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
    advertised: {
      maxDownlinkMbps: 18,
      maxUplinkMbps: 6,
      typicalLatencyMs: 120,
      reliability: 0.86,
      availabilityPct: 92,
    },
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
    advertised: {
      maxDownlinkMbps: 45,
      maxUplinkMbps: 15,
      typicalLatencyMs: 55,
      reliability: 0.96,
      availabilityPct: 98.5,
    },
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
    advertised: {
      maxDownlinkMbps: 120,
      maxUplinkMbps: 40,
      typicalLatencyMs: 28,
      reliability: 0.99,
      availabilityPct: 99.8,
    },
    offers: [
      { name: "Crest 10GB Global", priceCents: 1500, unit: "per_gb" },
      { name: "Crest Travel Pass", priceCents: 4200, unit: "flat" },
    ],
    failureRate: 0.0,
    latencyJitterMs: 6,
    throughputVariancePct: 0.06,
  },
];

// In-memory state of mock activations (idempotency keyed by idempotencyKey).
// This stands in for a real provider's API. It is per-process; in serverless
// each invocation is fresh — reconciliation logic in the kernel handles that.
const activationStore = new Map<string, { providerResourceId: string; active: boolean; createdAt: number }>();

// Deterministic pseudo-random from a string seed (stable per key).
function seededRandom(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // normalize to 0..1
  return ((h >>> 0) % 100000) / 100000;
}

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

export function executeMockAction(
  profile: MockProviderProfile,
  action: ActionType,
  opts: { providerResourceId: string; idempotencyKey: string }
): AdapterActionResult {
  const key = opts.idempotencyKey;
  const existing = activationStore.get(key);

  // Idempotency: duplicate ACTIVATE returns the same successful state.
  if (existing && (action === "ACTIVATE" || action === "RESERVE")) {
    return {
      ok: true,
      providerResourceId: existing.providerResourceId,
      state: existing.active ? "active" : "reserved",
      measurement: action === "ACTIVATE" ? observedMeasurement(profile, key) : undefined,
      idempotent: true,
      reconciled: true,
    };
  }

  if (action === "ACTIVATE") {
    const r = seededRandom(profile.code + key + "act");
    if (r < profile.failureRate) {
      // Simulated deterministic failure.
      return {
        ok: false,
        providerResourceId: opts.providerResourceId,
        state: "failed",
        error: "MOCK_PROVIDER_ACTIVATION_FAILURE",
        idempotent: false,
      };
    }
    activationStore.set(key, { providerResourceId: opts.providerResourceId, active: true, createdAt: Date.now() });
    return {
      ok: true,
      providerResourceId: opts.providerResourceId,
      state: "active",
      measurement: observedMeasurement(profile, key),
      idempotent: false,
    };
  }

  if (action === "DEACTIVATE" || action === "RELEASE") {
    if (existing) {
      existing.active = false;
      activationStore.set(key, existing);
    }
    return { ok: true, providerResourceId: opts.providerResourceId, state: "released", idempotent: true };
  }

  if (action === "MEASURE") {
    return {
      ok: true,
      providerResourceId: opts.providerResourceId,
      state: existing?.active ? "active" : "available",
      measurement: observedMeasurement(profile, key),
      idempotent: true,
    };
  }

  if (action === "RESERVE") {
    activationStore.set(key, { providerResourceId: opts.providerResourceId, active: false, createdAt: Date.now() });
    return { ok: true, providerResourceId: opts.providerResourceId, state: "reserved", idempotent: false };
  }

  // Unsupported action for this mock.
  return {
    ok: false,
    providerResourceId: opts.providerResourceId,
    state: "unknown",
    error: `ACTION_NOT_SUPPORTED:${action}`,
    idempotent: false,
  };
}
