import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit, emitEvent } from "@/lib/audit";
import type { Role } from "@prisma/client";
import { z } from "zod";

const ALLOWED_ROLES: Role[] = ["CONSUMER", "FAMILY_ADMIN", "ENTERPRISE_ADMIN", "PROVIDER", "RESELLER", "OPERATIONS"];

const schema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  name: z.string().min(1).max(120).optional(),
  requestedRole: z.enum(["CONSUMER", "FAMILY_ADMIN", "ENTERPRISE_ADMIN", "PROVIDER", "RESELLER", "OPERATIONS"]).default("CONSUMER"),
  source: z.string().max(60).optional(),
});

// POST /api/signup — creates a WaitlistEntry. Does NOT create a user account.
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  const { email, name, requestedRole, source } = parsed.data;

  // Prevent duplicate waitlist entries / duplicate identity.
  const existingWait = await db.waitlistEntry.findUnique({ where: { email } });
  if (existingWait) {
    return NextResponse.json({
      ok: true,
      message: "You are already on the waitlist. We will contact you when approved.",
      status: existingWait.status,
      id: existingWait.id,
    });
  }
  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: "An account with this email already exists. Please log in." }, { status: 409 });
  }

  const entry = await db.waitlistEntry.create({
    data: { email, name, requestedRole: requestedRole as Role, source: source ?? "public_signup" },
  });
  await emitEvent("WaitlistEntryCreated", { entryId: entry.id, email, requestedRole });
  await audit({ actorType: "anonymous", action: "waitlist.create", targetType: "waitlist", targetId: entry.id, metadata: { email, requestedRole } });
  return NextResponse.json({ ok: true, id: entry.id, status: entry.status, message: "You are on the waitlist. An administrator will review your request." }, { status: 201 });
}
