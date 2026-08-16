import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/server-auth";
import { reconcileAll, reconcileSession } from "@/lib/services/reconciliation-service";
import { NextRequest } from "next/server";
// POST /api/reconcile — reconcile all non-terminal sessions (admin/ops only).
// Can optionally reconcile a single session via ?sessionId=...
export async function POST(req: NextRequest) {
  const ctx = await requirePermission("session.view.all");
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  if (sessionId) {
    const result = await reconcileSession(sessionId);
    return NextResponse.json({ results: [result] });
  }
  const results = await reconcileAll();
  return NextResponse.json({ results });
}
