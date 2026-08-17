// Waitlist → User conversion domain service.
// Transactional + idempotent: converting an already-converted entry is a no-op.
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { audit, emitEvent } from "@/lib/audit";
import { randomBytes } from "crypto";

export interface ApproveResult {
  ok: boolean;
  userId?: string;
  entryId: string;
  status: string;
  onboardToken?: string; // a one-time onboarding credential (rotatable)
  alreadyConverted?: boolean;
  error?: string;
}

// approveWaitlistEntry: marks PENDING/REJECTED → APPROVED. Does not yet create the user.
export async function approveWaitlistEntry(entryId: string, approverId: string): Promise<ApproveResult> {
  const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry) return { ok: false, entryId, status: "missing", error: "NOT_FOUND" };
  if (entry.status === "CONVERTED") return { ok: true, entryId, status: entry.status, alreadyConverted: true, userId: entry.convertedUserId ?? undefined };
  if (entry.status === "APPROVED") return { ok: true, entryId, status: entry.status, alreadyConverted: !!entry.convertedUserId };

  await db.waitlistEntry.update({
    where: { id: entryId },
    data: { status: "APPROVED", decidedAt: new Date(), decidedBy: approverId },
  });
  await audit({ actorId: approverId, action: "waitlist.approve", targetType: "waitlist", targetId: entryId, metadata: { email: entry.email, requestedRole: entry.requestedRole } });
  await emitEvent("WaitlistEntryApproved", { entryId, email: entry.email });
  return { ok: true, entryId, status: "APPROVED" };
}

// createUserFromWaitlist: APPROVED → real User account. Transactional + idempotent.
export async function createUserFromWaitlist(entryId: string, approverId: string): Promise<ApproveResult> {
  const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry) return { ok: false, entryId, status: "missing", error: "NOT_FOUND" };

  if (entry.status === "CONVERTED" && entry.convertedUserId) {
    return { ok: true, entryId, status: "CONVERTED", alreadyConverted: true, userId: entry.convertedUserId };
  }
  if (entry.status !== "APPROVED" && entry.status !== "INVITED") {
    return { ok: false, entryId, status: entry.status, error: "MUST_APPROVE_FIRST" };
  }

  const onboardingPassword = randomBytes(12).toString("base64url");
  const hash = await hashPassword(onboardingPassword);

  const user = await db.$transaction(async (tx) => {
    const dup = await tx.user.findUnique({ where: { email: entry.email } });
    if (dup) {
      await tx.waitlistEntry.update({ where: { id: entryId }, data: { status: "CONVERTED", convertedUserId: dup.id, decidedAt: new Date(), decidedBy: approverId } });
      return dup;
    }
    const created = await tx.user.create({
      data: {
        email: entry.email,
        name: entry.name,
        passwordHash: hash,
        role: entry.requestedRole,
        status: "ACTIVE",
        isDemo: false,
      },
    });
    await tx.waitlistEntry.update({
      where: { id: entryId },
      data: { status: "CONVERTED", convertedUserId: created.id, decidedAt: new Date(), decidedBy: approverId },
    });
    return created;
  });

  await audit({ actorId: approverId, action: "user.create", targetType: "user", targetId: user.id, metadata: { email: user.email, role: user.role, source: "waitlist_conversion" } });
  await audit({ actorId: approverId, action: "waitlist.convert", targetType: "waitlist", targetId: entryId, metadata: { userId: user.id } });
  await emitEvent("UserCreated", { userId: user.id, email: user.email, role: user.role, source: "waitlist" });
  await emitEvent("WaitlistEntryConverted", { entryId, userId: user.id });

  return { ok: true, entryId, status: "CONVERTED", userId: user.id, onboardToken: onboardingPassword };
}

export async function rejectWaitlistEntry(entryId: string, approverId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry) return { ok: false, error: "NOT_FOUND" };
  if (entry.status === "CONVERTED") return { ok: false, error: "ALREADY_CONVERTED" };
  await db.waitlistEntry.update({ where: { id: entryId }, data: { status: "REJECTED", decidedAt: new Date(), decidedBy: approverId, notes: reason } });
  await audit({ actorId: approverId, action: "waitlist.reject", targetType: "waitlist", targetId: entryId, reason, metadata: { email: entry.email } });
  return { ok: true };
}
