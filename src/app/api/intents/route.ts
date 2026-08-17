import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireActiveUser } from "@/lib/server-auth";
import { audit, emitEvent } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  capability: z.string(),
  location: z.object({ country: z.string(), region: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }),
  timeWindow: z.object({ start: z.string(), end: z.string().optional(), tz: z.string().optional() }),
  usage: z.any().default({}),
  constraints: z.any().default({}),
  preferences: z.any().default({}),
  policy: z.any().optional(),
});

export async function GET() {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const intents = await db.connectivityIntent.findMany({
    where: { subjectId: ctx.userId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ intents });
}

export async function POST(req: NextRequest) {
  const ctx = await requireActiveUser();
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Validation", issues: parsed.error.issues }, { status: 422 });
  const d = parsed.data;
  const intent = await db.connectivityIntent.create({
    data: {
      subjectId: ctx.userId,
      capability: d.capability,
      location: d.location as any,
      timeWindow: d.timeWindow as any,
      usage: d.usage as any,
      constraints: d.constraints as any,
      preferences: d.preferences as any,
      policy: (d.policy ?? null) as any,
    },
  });
  await emitEvent("IntentCreated", { intentId: intent.id, subjectId: ctx.userId, capability: d.capability });
  await audit({ actorId: ctx.userId, action: "intent.create", targetType: "intent", targetId: intent.id, metadata: { capability: d.capability } });
  return NextResponse.json({ intent }, { status: 201 });
}
