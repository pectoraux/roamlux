import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/server-auth";
import { drainOutbox } from "@/lib/services/outbox-drainer";
// POST /api/outbox/drain — drain pending outbox events (admin only).
// In production, wire this to a cron job or external scheduler.
export async function POST() {
  const ctx = await requirePermission("audit.view");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const result = await drainOutbox({ batchSize: 50 });
  return NextResponse.json(result);
}
