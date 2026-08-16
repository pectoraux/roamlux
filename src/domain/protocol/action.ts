// Generic Action vocabulary — provider-neutral kernel actions.
// The kernel never speaks provider-specific operations (e.g. CREATE_MIKROTIK_USER).
// The adapter translates generic actions into provider-specific API calls.
import type { MeasurementSnapshot } from "./measurement";

export const ACTION_CONTRACT_VERSION = "1.0.0" as const;

export type ActionType =
  | "DISCOVER"
  | "RESERVE"
  | "ACTIVATE"
  | "DEACTIVATE"
  | "SWITCH"
  | "RENEW"
  | "SUSPEND"
  | "RESUME"
  | "RELEASE"
  | "TRANSFER"
  | "MEASURE";

export const ALL_ACTIONS: ActionType[] = [
  "DISCOVER", "RESERVE", "ACTIVATE", "DEACTIVATE", "SWITCH",
  "RENEW", "SUSPEND", "RESUME", "RELEASE", "TRANSFER", "MEASURE",
];

// Adapter contract — the boundary where concrete provider implementations enter.
export interface AdapterDescriptor {
  providerCode: string;
  providerName: string;
  type: "MOCK" | "MIKROTIK" | "ESIM";
  supportedActions: ActionType[];
}

export interface AdapterActionResult {
  ok: boolean;
  providerResourceId?: string;
  state: string;
  measurement?: MeasurementSnapshot;
  error?: string;
  idempotent: boolean;
  reconciled?: boolean;
}

// Adapter interface — the contract every adapter must implement.
export interface Adapter {
  descriptor: AdapterDescriptor;
  execute(
    action: ActionType,
    opts: { providerResourceId: string; idempotencyKey: string }
  ): AdapterActionResult;
}
