// Adapter registry: resolves a provider (by code/type) to an adapter implementation.
// The kernel only ever speaks the generic action vocabulary; the adapter translates.
// CONCERN BOUNDARY: this is the ONLY place where concrete adapter implementations
// are imported. The kernel/control-plane/protocol never import adapters directly.
import type { ActionType, AdapterActionResult, AdapterDescriptor, AdapterExecuteOptions } from "@/domain/protocol";
import { db } from "@/lib/db";
import {
  MOCK_PROFILES, getMockProfile, describeMock, executeMockAction, queryMockProviderState,
  type MockProviderProfile, type FaultMode,
} from "./mock-providers";

export interface AdapterHandle {
  descriptor: AdapterDescriptor;
  execute(
    action: ActionType,
    opts: AdapterExecuteOptions
  ): Promise<AdapterActionResult>;
  // RECONCILIATION: query the provider's actual state for a resource.
  reconcile(providerResourceId: string): Promise<{ state: string; found: boolean }>;
}

export function adapterFor(code: string, type: string): AdapterHandle | null {
  if (type === "MOCK") {
    const profile = getMockProfile(code);
    if (!profile) return null;
    return {
      descriptor: describeMock(profile),
      execute: (action, opts) => executeMockAction(profile, action, opts),
      reconcile: (rid) => queryMockProviderState(profile.code, rid),
    };
  }
  // MIKROTIK / ESIM adapters are extension points. Not implemented until reliability gate passes.
  return null;
}

export async function adapterForProvider(providerId: string): Promise<AdapterHandle | null> {
  const provider = await db.provider.findUnique({ where: { id: providerId } });
  if (!provider) return null;
  return adapterFor(provider.code, provider.type);
}

export const MOCK_PROVIDER_PROFILES = MOCK_PROFILES;
export type { MockProviderProfile, FaultMode };
