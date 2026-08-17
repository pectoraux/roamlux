import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/server-auth";
import { rejectWaitlistEntry } from "@/lib/services/waitlist-service";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePermission("waitlist.reject");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch {}
  const res = await rejectWaitlistEntry(id, ctx.userId, body.reason);
  if (!res.ok) return NextResponse.json(res, { status: 400 });
  return NextResponse.json({ ok: true });
}
