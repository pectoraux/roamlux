import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/server-auth";
import { approveWaitlistEntry, createUserFromWaitlist } from "@/lib/services/waitlist-service";
// POST /api/waitlist/:id/approve  { create?: boolean }
// - approve marks APPROVED. If create=true, also converts to a real user account.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission("waitlist.approve");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch {}
  const approveRes = await approveWaitlistEntry(id, ctx.userId);
  if (!approveRes.ok) return NextResponse.json(approveRes, { status: 400 });
  if (body.create) {
    const createRes = await createUserFromWaitlist(id, ctx.userId);
    return NextResponse.json({ ...createRes, approved: true });
  }
  return NextResponse.json({ ...approveRes });
}
