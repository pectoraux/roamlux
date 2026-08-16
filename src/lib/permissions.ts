// Role → Permission authorization model. Server-side enforced. Never email-based.
import type { Role } from "@prisma/client";

export type Permission =
  | "waitlist.view"
  | "waitlist.approve"
  | "waitlist.reject"
  | "user.view"
  | "user.create"
  | "user.disable"
  | "user.changerole"
  | "intent.create"
  | "intent.view"
  | "intent.view.all"
  | "capability.view"
  | "session.view"
  | "session.view.all"
  | "session.action"
  | "decision.evaluate"
  | "provider.manage"
  | "audit.view"
  | "platform.bootstrap";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  PLATFORM_ADMIN: [
    "waitlist.view", "waitlist.approve", "waitlist.reject",
    "user.view", "user.create", "user.disable", "user.changerole",
    "intent.view.all", "capability.view",
    "session.view.all", "session.action",
    "decision.evaluate", "provider.manage", "audit.view", "platform.bootstrap",
  ],
  OPERATIONS: [
    "waitlist.view", "user.view", "capability.view",
    "session.view.all", "audit.view", "intent.view.all",
  ],
  CONSUMER: [
    "intent.create", "intent.view", "capability.view",
    "session.view", "session.action", "decision.evaluate",
  ],
  FAMILY_ADMIN: [
    "intent.create", "intent.view", "capability.view",
    "session.view", "session.action", "decision.evaluate",
  ],
  ENTERPRISE_ADMIN: [
    "intent.create", "intent.view", "capability.view",
    "session.view", "session.action", "decision.evaluate",
  ],
  PROVIDER: [
    "capability.view", "session.view", "provider.manage",
  ],
  RESELLER: [
    "capability.view", "session.view",
  ],
};

export function can(role: Role | undefined | null, perm: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

export function rolePermissions(role: Role): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}
