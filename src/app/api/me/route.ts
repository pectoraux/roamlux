import { NextResponse } from "next/server";
import { getContext } from "@/lib/server-auth";
import { rolePermissions } from "@/lib/permissions";
export async function GET() {
  const ctx = await getContext();
  if (!ctx) return NextResponse.json({ user: null });
  return NextResponse.json({ user: { ...ctx }, permissions: rolePermissions(ctx.role) });
}
