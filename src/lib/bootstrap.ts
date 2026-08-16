// Idempotent bootstrap.
// - Creates the real PLATFORM_ADMIN once (never overwrites password if it exists).
// - Creates clearly-marked DEMO identities (isDemo=true) for quick-login.
// - Seeds the mock provider ecosystem (capabilities, resources, offers).
// Idempotent: safe to call repeatedly; uses create-only upserts / no-ops.

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { MOCK_PROFILES } from "@/domain/adapters/mock-providers";
import type { Role } from "@prisma/client";

let bootstrapped = false;

const DEMO_PASSWORD = "roamlink-demo";

interface DemoSeed { email: string; name: string; role: Role; }

const DEMO_SEEDS: DemoSeed[] = [
  { email: "demo.consumer@roamlink.dev",     name: "Demo Consumer",          role: "CONSUMER" },
  { email: "demo.family@roamlink.dev",       name: "Demo Family Admin",      role: "FAMILY_ADMIN" },
  { email: "demo.enterprise@roamlink.dev",   name: "Demo Enterprise Admin",  role: "ENTERPRISE_ADMIN" },
  { email: "demo.provider@roamlink.dev",     name: "Demo Provider",          role: "PROVIDER" },
  { email: "demo.reseller@roamlink.dev",     name: "Demo Reseller",          role: "RESELLER" },
  { email: "demo.operations@roamlink.dev",   name: "Demo Operations",        role: "OPERATIONS" },
];

export async function bootstrap(): Promise<{ adminCreated: boolean; demos: number; providers: number }> {
  if (bootstrapped) return { adminCreated: false, demos: 0, providers: 0 };
  bootstrapped = true;

  // 1) Real platform administrator (create-only; never overwrite).
  // The real admin credential is supplied ONLY via environment variables.
  // It is never hardcoded in source. See .env (gitignored) / Vercel env vars.
  const adminEmail = (process.env.PLATFORM_ADMIN_EMAIL || "").trim().toLowerCase();
  const adminPassword = process.env.PLATFORM_ADMIN_PASSWORD || "";
  if (!adminEmail || !adminPassword) {
    throw new Error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD env vars are required for bootstrap.");
  }
  let adminCreated = false;
  const existingAdmin = await db.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await db.user.create({
      data: {
        email: adminEmail,
        name: "Platform Administrator",
        passwordHash: await hashPassword(adminPassword),
        role: "PLATFORM_ADMIN",
        status: "ACTIVE",
        isDemo: false,
      },
    });
    adminCreated = true;
  } else if (existingAdmin.role !== "PLATFORM_ADMIN") {
    // Ensure the configured admin email is actually a platform admin (idempotent promotion).
    await db.user.update({ where: { id: existingAdmin.id }, data: { role: "PLATFORM_ADMIN" } });
  }

  // 2) Demo identities (clearly marked isDemo=true; normal auth path).
  let demoCount = 0;
  const demoHash = await hashPassword(DEMO_PASSWORD);
  for (const d of DEMO_SEEDS) {
    await db.user.upsert({
      where: { email: d.email },
      create: { email: d.email, name: d.name, role: d.role, passwordHash: demoHash, status: "ACTIVE", isDemo: true },
      update: {}, // no-op: never silently change an existing demo account
    });
    demoCount++;
  }

  // 3) Mock provider ecosystem.
  let providerCount = 0;
  for (const p of MOCK_PROFILES) {
    const provider = await db.provider.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        name: p.name,
        type: "MOCK",
        supportedActions: p.supportedActions,
        config: { failureRate: p.failureRate, latencyJitterMs: p.latencyJitterMs },
        active: true,
      },
      update: {
        // Keep supportedActions/config in sync, but do not touch relations.
        supportedActions: p.supportedActions,
        config: { failureRate: p.failureRate, latencyJitterMs: p.latencyJitterMs },
      },
    });

    // Capability (advertised) — upsert by providerId+type.
    let cap = await db.capability.findFirst({ where: { providerId: provider.id, type: p.capabilityType } });
    if (!cap) {
      cap = await db.capability.create({
        data: {
          providerId: provider.id,
          type: p.capabilityType,
          coverage: p.coverage as any,
          advertised: p.advertised as any,
          published: true,
        },
      });
    } else {
      cap = await db.capability.update({
        where: { id: cap.id },
        data: { coverage: p.coverage as any, advertised: p.advertised as any, published: true },
      });
    }

    // Resource — one per offer.
    for (const o of p.offers) {
      const resourceId = `${p.code}::${o.name}`.replace(/\s+/g, "_").toLowerCase();
      let resource = await db.resource.findFirst({ where: { providerId: provider.id, identifier: resourceId } });
      if (!resource) {
        resource = await db.resource.create({
          data: {
            providerId: provider.id,
            capabilityId: cap.id,
            identifier: resourceId,
            state: "available",
            attributes: { unit: o.unit, billingModel: o.billingModel ?? {} } as any,
          },
        });
      }
      // Offer (idempotent by providerId + name)
      let offer = await db.offer.findFirst({ where: { providerId: provider.id, name: o.name } });
      if (!offer) {
        offer = await db.offer.create({
          data: {
            providerId: provider.id,
            capabilityId: cap.id,
            resourceId: resource.id,
            name: o.name,
            priceCents: o.priceCents,
            unit: o.unit,
            billingModel: (o.billingModel ?? {}) as any,
            valid: true,
          },
        });
      } else {
        offer = await db.offer.update({
          where: { id: offer.id },
          data: { priceCents: o.priceCents, unit: o.unit, billingModel: (o.billingModel ?? {}) as any, valid: true },
        });
      }
    }
    providerCount++;
  }

  return { adminCreated, demos: demoCount, providers: providerCount };
}

export const DEMO_IDENTITIES = DEMO_SEEDS;
export const DEMO_LOGIN_PASSWORD = DEMO_PASSWORD;
