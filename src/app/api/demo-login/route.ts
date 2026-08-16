import { NextResponse } from "next/server";
import { DEMO_IDENTITIES, DEMO_LOGIN_PASSWORD } from "@/lib/bootstrap";
// GET /api/demo-login — returns demo identity metadata + the shared demo password.
// This is NOT a backdoor: the client must still POST /api/auth/callback/credentials
// through the normal NextAuth credentials flow. Demo accounts are isDemo=true.
export async function GET() {
  return NextResponse.json({
    password: DEMO_LOGIN_PASSWORD,
    identities: DEMO_IDENTITIES.map((d) => ({ email: d.email, name: d.name, role: d.role })),
  });
}
