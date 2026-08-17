// Identity contract — participant types and roles.
// Identity ≠ Entitlement ≠ Payment. A role grants permissions; it does NOT
// grant connectivity. Entitlement is a separate, explicit concept.
export const IDENTITY_CONTRACT_VERSION = "1.0.0" as const;

export type Role =
  | "PLATFORM_ADMIN"
  | "CONSUMER"
  | "FAMILY_ADMIN"
  | "ENTERPRISE_ADMIN"
  | "PROVIDER"
  | "RESELLER"
  | "OPERATIONS";

export type UserStatus = "ACTIVE" | "DISABLED" | "SUSPENDED";

export interface IdentityRef {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  isDemo: boolean;
}

// INVARIANT: isDemo=true can never coexist with role=PLATFORM_ADMIN.
// This is enforced server-side (see permissions + bootstrap).
export function isValidIdentity(i: { role: Role; isDemo: boolean }): boolean {
  if (i.isDemo && i.role === "PLATFORM_ADMIN") return false;
  return true;
}
