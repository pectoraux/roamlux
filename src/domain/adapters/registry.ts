// Adapter registry: resolves a provider (by code/type) to an adapter implementation.
// The kernel only ever speaks the generic action vocabulary; the adapter translates.
import type { ActionType, AdapterActionResult, AdapterDescriptor } from "@/domain/protocol";
import { db } from "@/lib/db";
import {
  MOCK_PROFILES, getMockProfile, describeMock, executeMockAction, type MockProviderProfile,
} from "./mock-providers";

export interface AdapterHandle {
  descriptor: AdapterDescriptor;
  execute(
    action: ActionType,
    opts: { providerResourceId: string; idempotencyKey: string }
  ): AdapterActionResult;
}

export function adapterFor(code: string, type: string): AdapterHandle | null {
  if (type === "MOCK") {
    const profile = getMockProfile(code);
    if (!profile) return null;
    return {
      descriptor: describeMock(profile),
      execute: (action, opts) => executeMockAction(profile, action, opts),
    };
  }
  // MIKROTIK / ESIM adapters are extension points (M9/M10). Not implemented in MVP.
  return null;
}

export async function adapterForProvider(providerId: string): Promise<AdapterHandle | null> {
  const provider = await db.provider.findUnique({ where: { id: providerId } });
  if (!provider) return null;
  return adapterFor(provider.code, provider.type);
}

export const MOCK_PROVIDER_PROFILES = MOCK_PROFILES;
export type { MockProviderProfile };
