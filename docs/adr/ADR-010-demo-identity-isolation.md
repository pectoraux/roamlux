# ADR-010 — Demo Identity Isolation

**Status:** Accepted
**Date:** Architecture freeze

## Context

A demo environment needs quick-login identities that showcase every role in the
platform (`CONSUMER`, `FAMILY_ADMIN`, `ENTERPRISE_ADMIN`, `PROVIDER`,
`RESELLER`, `OPERATIONS`). The temptation is to create special "demo login"
endpoints, hard-code backdoors, or grant demo accounts elevated privileges. Each
of these is a security incident waiting to happen: a backdoor that works in demo
often works in production, and a "demo admin" account with `PLATFORM_ADMIN` role
but a known password is a live attack vector.

We need demo identities that:
- Are trivially easy to use for legitimate evaluators.
- Authenticate through the **same** NextAuth credentials flow as real users — no
  parallel auth path.
- Can never become `PLATFORM_ADMIN` and can never be silently promoted to a
  privileged role.
- Are visibly distinct from real identities in audit logs and admin UIs.

## Decision

Demo identities are real `User` rows with `isDemo=true` and a known shared
password. They are seeded by `src/lib/bootstrap.ts` and authenticate through the
normal NextAuth flow.

### Seeding (`src/lib/bootstrap.ts`)

Six demo seeds:
```
demo.consumer@roamlink.dev       CONSUMER
demo.family@roamlink.dev         FAMILY_ADMIN
demo.enterprise@roamlink.dev     ENTERPRISE_ADMIN
demo.provider@roamlink.dev       PROVIDER
demo.reseller@roamlink.dev       RESELLER
demo.operations@roamlink.dev     OPERATIONS
```

- Shared password: `roamlink-demo` (bcrypt-hashed at 12 rounds).
- Each row has `isDemo: true`, `status: ACTIVE`.
- **Idempotent upsert with `update: {}`** — re-running bootstrap never silently
  changes an existing demo account's password, role, or status. If a demo account
  has been manually modified (e.g. role changed for testing), bootstrap leaves it
  alone.

### Authentication path

Demo accounts authenticate via `POST /api/auth/callback/credentials` like any
other user. There is no `/api/demo-login` POST that creates a session.

`GET /api/demo-login` is a **catalogue endpoint**: it returns the list of demo
identities + the shared password so the demo UI can prefill the login form. The
client must still POST through the normal NextAuth flow. The endpoint exists for
UX, not for auth.

### `isDemo` is a flag, never a privilege

- `isDemo` is a boolean on the `User` row, surfaced on the JWT and the session.
- **No permission check inspects `isDemo`.** `can(role, perm)` is role-only.
- A demo account has exactly the permissions of its role — no more, no less.
- Demo accounts have the same status lifecycle (`ACTIVE`, `DISABLED`,
  `SUSPENDED`) as real users. Disabling a demo account disables it.

### Demo accounts can never be `PLATFORM_ADMIN`

- Bootstrap does not seed a demo `PLATFORM_ADMIN`.
- The role-promotion path (`/api/admin/users/[id]` with `user.changerole`
  permission, which only `PLATFORM_ADMIN` has) could in principle promote a demo
  account to `PLATFORM_ADMIN`. To prevent this:
  - The real `PLATFORM_ADMIN` is seeded separately from env
    (`PLATFORM_ADMIN_EMAIL`, default `ekontetevi@gmail`) with `isDemo: false`.
  - Bootstrap is idempotent and create-only on the admin: it never overwrites the
    admin's password if the row exists, and if a non-admin user exists at the
    configured admin email, it is promoted to `PLATFORM_ADMIN` (so the configured
    email is always the admin).
  - Demo identities use a different email domain (`@roamlink.dev`) from the
    configured admin email, so there is no collision.

### Audit visibility

`AuditLog` rows carry `actorId` and the related `User.isDemo` is joinable. Audit
queries can filter "show only demo-actor events" or "exclude demo actors" via
this join. This keeps demo activity clearly separable from real activity.

## Consequences

**Positive**
- One auth codepath. Bugs in the real auth flow are found by demo users, not
  hidden by a parallel demo path.
- A leaked demo password grants at most `OPERATIONS`-level read access — never
  admin. Disabling demo accounts is a one-line DB update.
- Audit logs clearly show which actions were performed by demo identities, so
  demo activity never pollutes production metrics.
- Re-running bootstrap is safe and idempotent.

**Negative**
- The shared demo password is a known weak credential. Mitigation: demo accounts
  are explicitly read-mostly; the highest demo role is `OPERATIONS` (no
  user.create, no waitlist.approve). Production deployments should run bootstrap
  with `NODE_ENV=production` and either skip demo seeding or use environment-
  specific passwords — a future enhancement.

**Risks**
- If a real `PLATFORM_ADMIN` is foolishly seeded with the demo password, the
  isolation is void. Mitigation: the admin password comes ONLY from the
  `PLATFORM_ADMIN_PASSWORD` env var (never hardcoded in source) and is distinct
  from the demo password (`roamlink-demo`). The bootstrap code refuses to
  overwrite an existing admin's password.
- If `demo-login` GET endpoint is exposed in production, it advertises demo
  credentials. Mitigation: the credentials it returns are low-privilege and the
  endpoint could be feature-flagged off in production deployments.
