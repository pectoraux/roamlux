// Generic Action vocabulary — provider-neutral kernel actions (v2.0).
//
// ADR-004: Design B — generic execute(action, opts) with explicit capability model.
//
// The kernel calls a single entry point: adapter.execute(action, opts).
// The adapter declares which capabilities it supports via descriptor.supportedActions.
// Unsupported actions return a stable UNSUPPORTED_ACTION result.
//
// Each action has formally specified semantics:
//   DISCOVER    — query advertised capabilities/resources (no state change)
//   DESCRIBE    — query resource description/metadata (no state change)
//   RESERVE     — reserve a resource (RESERVED, not ACTIVE)
//   ACTIVATE    — activate connectivity (state → ACTIVE)
//   DEACTIVATE  — deactivate connectivity (state → INACTIVE)
//   RELEASE     — release a reserved/active resource (terminal)
//   MEASURE     — observe current quality (observational, no state change)
//   RECONCILE   — query provider's actual state for a resource (no state change)
//   SETTLE      — settle commercial terms for usage (deferred — adapter declares support)
//   SWITCH      — switch to a different resource (provider-specific translation)
//   RENEW       — renew an expiring resource
//   SUSPEND     — temporarily suspend connectivity
//   RESUME      — resume suspended connectivity
//   TRANSFER    — transfer resource ownership
import type { MeasurementSnapshot } from "./measurement";

export const ACTION_CONTRACT_VERSION = "2.0.0" as const;

export type ActionType =
  | "DISCOVER"
  | "DESCRIBE"
  | "RESERVE"
  | "ACTIVATE"
  | "DEACTIVATE"
  | "RELEASE"
  | "MEASURE"
  | "RECONCILE"
  | "SETTLE"
  | "SWITCH"
  | "RENEW"
  | "SUSPEND"
  | "RESUME"
  | "TRANSFER";

export const ALL_ACTIONS: ActionType[] = [
  "DISCOVER", "DESCRIBE", "RESERVE", "ACTIVATE", "DEACTIVATE", "RELEASE",
  "MEASURE", "RECONCILE", "SETTLE", "SWITCH", "RENEW", "SUSPEND", "RESUME", "TRANSFER",
];

// Actions that MUST NOT change provider-side resource state (observational).
export const OBSERVATIONAL_ACTIONS: ActionType[] = ["DISCOVER", "DESCRIBE", "MEASURE", "RECONCILE"];
// Actions that change provider-side resource state (mutating).
export const MUTATING_ACTIONS: ActionType[] = ["RESERVE", "ACTIVATE", "DEACTIVATE", "RELEASE", "SWITCH", "RENEW", "SUSPEND", "RESUME", "TRANSFER", "SETTLE"];

// Adapter descriptor — declares identity + supported capabilities.
export interface AdapterDescriptor {
  providerCode: string;
  providerName: string;
  type: "MOCK" | "MIKROTIK" | "ESIM" | "COMMUNITY";
  supportedActions: ActionType[];
  contractVersion: string; // must match ACTION_CONTRACT_VERSION
}

// Generic execution options.
export interface AdapterExecuteOptions {
  providerResourceId: string;
  idempotencyKey: string;
  faultMode?: string;
  signal?: AbortSignal;
  deadline?: Date;
}

// Generic action result.
export interface AdapterActionResult {
  ok: boolean;
  providerResourceId?: string;
  state: string;
  measurement?: MeasurementSnapshot;
  // For DESCRIBE: returns generic resource metadata (non-authoritative).
  description?: Record<string, unknown>;
  // For DISCOVER: returns advertised capabilities.
  capabilities?: Array<{ type: string; advertised: Record<string, unknown> }>;
  error?: string;
  idempotent: boolean;
  reconciled?: boolean;
}

// Reconciliation result (separate type for clarity).
export interface ReconcileResult {
  state: string;
  found: boolean;
}

// Adapter interface — the contract every adapter must implement.
// Design B: single execute() entry point with formally specified action semantics.
// Reconcile is available both as execute("RECONCILE", ...) and as a dedicated
// method for direct use by the reconciliation service.
export interface Adapter {
  descriptor: AdapterDescriptor;
  execute(
    action: ActionType,
    opts: AdapterExecuteOptions
  ): Promise<AdapterActionResult>;
  reconcile(providerResourceId: string): Promise<ReconcileResult>;
}

// Helper: check if an adapter supports an action.
export function supportsAction(adapter: Adapter, action: ActionType): boolean {
  return adapter.descriptor.supportedActions.includes(action);
}

// Helper: check adapter contract version compatibility.
export function isCompatibleAdapter(adapter: Adapter): boolean {
  return adapter.descriptor.contractVersion === ACTION_CONTRACT_VERSION;
}

// Helper: create the standard UNSUPPORTED_ACTION result.
export function unsupportedActionResult(action: ActionType, rid: string): AdapterActionResult {
  return {
    ok: false,
    providerResourceId: rid,
    state: "unknown",
    error: `ACTION_NOT_SUPPORTED:${action}`,
    idempotent: false,
  };
}
