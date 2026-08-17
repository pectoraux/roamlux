import { NextRequest, NextResponse } from "next/server";
import { requireActiveUser } from "@/lib/server-auth";
import { executeAction } from "@/lib/services/session-service";
import type { ActionType } from "@/domain/protocol";
const ALLOWED: ActionType[] = ["DEACTIVATE","MEASURE","SUSPEND","RESUME","RELEASE","RENEW"];
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  let body: any = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action ?? "").toUpperCase() as ActionType;
  if (!ALLOWED.includes(action)) return NextResponse.json({ error: "Unsupported action" }, { status: 422 });
  // Pass role so executeAction can enforce horizontal isolation (owner-or-admin).
  const res = await executeAction({ sessionId: id, action, subjectId: ctx.userId, role: ctx.role });
  if (res.error === "FORBIDDEN") return NextResponse.json(res, { status: 403 });
  return NextResponse.json(res, { status: res.ok ? 200 : 500 });
}
