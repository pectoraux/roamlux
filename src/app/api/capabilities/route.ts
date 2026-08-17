import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { capabilityMatches } from "@/domain/protocol";
// GET /api/capabilities?intentId=... — discover published capabilities (and matching resources/offers).
// Uses the explicit capability taxonomy (protocol/capability.ts) — no scattered string comparisons.
export async function GET(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const intentId = searchParams.get("intentId");
  let intentCapability: string | null = null;
  if (intentId) {
    const intent = await db.connectivityIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.subjectId !== ctx.userId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    intentCapability = intent.capability;
  }
  const allCapabilities = await db.capability.findMany({
    where: { published: true },
    include: {
      provider: true,
      resources: { where: { state: "available" } },
      offers: { where: { valid: true } },
    },
    orderBy: { validFrom: "desc" },
  });
  // Filter by taxonomy: "internet" matches all; "cellular" matches lte/esim_data; etc.
  const capabilities = intentCapability
    ? allCapabilities.filter((c) => capabilityMatches(intentCapability, c.type))
    : allCapabilities;
  return NextResponse.json({ capabilities });
}
