// ExampleCommunityWifiAdapter — a deliberately simple third-party adapter.
//
// This adapter is NOT one of the three mock providers. It proves that a new
// provider can implement the adapter contract without modifying:
//   - protocol, kernel, decision engine, session service
//
// It uses in-memory state (sufficient for conformance testing). A real adapter
// would call a provider API (e.g. MikroTik RouterOS, an eSIM API, etc).
import type {
  Adapter, ActionType, AdapterActionResult, AdapterDescriptor,
  AdapterExecuteOptions, MeasurementSnapshot, ReconcileResult,
} from "@/domain/protocol";
import { ACTION_CONTRACT_VERSION, unsupportedActionResult } from "@/domain/protocol";

const ADAPTER_DESCRIPTOR: AdapterDescriptor = {
  providerCode: "COMMUNITY_WIFI",
  providerName: "Example Community WiFi",
  type: "COMMUNITY",
  supportedActions: ["DISCOVER", "DESCRIBE", "ACTIVATE", "DEACTIVATE", "MEASURE", "RELEASE", "RECONCILE"],
  contractVersion: ACTION_CONTRACT_VERSION,
};

// In-memory resource state.
const resourceState = new Map<string, "active" | "inactive">();
const commandLog = new Map<string, "success" | "failure">();

function generateMeasurement(rid: string): MeasurementSnapshot {
  const hash = rid.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    latencyMs: 30 + (hash % 50),
    downlinkMbps: 50 + (hash % 40),
    uplinkMbps: 10 + (hash % 10),
    packetLossPct: 0.5,
    jitterMs: 2,
    availabilityPct: 99.5,
    observedAt: new Date().toISOString(),
    source: "community_wifi_adapter",
  };
}

export const exampleCommunityWifiAdapter: Adapter = {
  descriptor: ADAPTER_DESCRIPTOR,

  async execute(
    action: ActionType,
    opts: AdapterExecuteOptions
  ): Promise<AdapterActionResult> {
    const { providerResourceId: rid, idempotencyKey: key } = opts;

    if (!ADAPTER_DESCRIPTOR.supportedActions.includes(action)) {
      return unsupportedActionResult(action, rid);
    }

    // Command-level idempotency.
    if (commandLog.has(key)) {
      return {
        ok: commandLog.get(key) === "success",
        providerResourceId: rid,
        state: resourceState.get(rid) ?? "inactive",
        measurement: action === "MEASURE" ? generateMeasurement(rid) : undefined,
        idempotent: true,
        reconciled: true,
      };
    }

    if (action === "ACTIVATE") {
      resourceState.set(rid, "active");
      commandLog.set(key, "success");
      return { ok: true, providerResourceId: rid, state: "active", measurement: generateMeasurement(rid), idempotent: false };
    }

    if (action === "DEACTIVATE" || action === "RELEASE") {
      resourceState.set(rid, "inactive");
      commandLog.set(key, "success");
      return { ok: true, providerResourceId: rid, state: "inactive", idempotent: true };
    }

    if (action === "MEASURE") {
      commandLog.set(key, "success");
      return { ok: true, providerResourceId: rid, state: resourceState.get(rid) ?? "inactive", measurement: generateMeasurement(rid), idempotent: true };
    }

    if (action === "DISCOVER") {
      commandLog.set(key, "success");
      return { ok: true, providerResourceId: rid, state: resourceState.get(rid) ?? "inactive", capabilities: [{ type: "wifi", advertised: { maxDownlinkMbps: 50, maxUplinkMbps: 10, typicalLatencyMs: 30, reliability: 0.99 } }], idempotent: true };
    }

    if (action === "DESCRIBE") {
      commandLog.set(key, "success");
      return { ok: true, providerResourceId: rid, state: resourceState.get(rid) ?? "inactive", description: { providerCode: "COMMUNITY_WIFI", capabilityType: "wifi", advertised: { maxDownlinkMbps: 50, maxUplinkMbps: 10, typicalLatencyMs: 30, reliability: 0.99 } }, idempotent: true };
    }

    if (action === "RECONCILE") {
      commandLog.set(key, "success");
      const state = resourceState.get(rid);
      return { ok: true, providerResourceId: rid, state: state ?? "unknown", idempotent: true, reconciled: true };
    }

    return unsupportedActionResult(action, rid);
  },

  async reconcile(providerResourceId: string): Promise<ReconcileResult> {
    const state = resourceState.get(providerResourceId);
    if (!state) return { state: "unknown", found: false };
    return { state, found: true };
  },
};
