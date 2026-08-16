# ADR-009 — Authentication / Authorization

**Status:** Accepted
**Date:** Architecture freeze

## Context

A multi-tenant platform with seven roles (`PLATFORM_ADMIN`, `CONSUMER`,
`FAMILY_ADMIN`, `ENTERPRISE_ADMIN`, `PROVIDER`, `RESELLER`, `OPERATIONS`) needs an
authorization model that is:
- **Server-authoritative.** Client-side tab hiding is UX, not security.
- **Role-based, not email-based.** Hard-coded `if (email === "admin@...")` checks
  are an anti-pattern that survives refactors badly and leaks through audits.
- **Stateless-friendly** for Vercel serverless, where a session DB lookup per
  request is expensive.
- **Resistant to stale credentials.** A disabled user must not keep accessing the
  API until their JWT expires.

## Decision

### Authentication — NextAuth v4 credentials + JWT

`src/lib/auth.ts`:
- **Strategy:** `jwt` (stateless). NextAuth's `Session` and `Account` Prisma models
  are kept for contract compatibility but the runtime uses signed JWTs.
- **Provider:** Credentials (email + password). No OAuth in MVP.
- **Hashing:** `bcryptjs` with **12 rounds** (`src/lib/password.ts`). Pure-JS so it
  runs in Vercel serverless without native bindings; 12 rounds is the OWASP-aligned
  baseline as of 2023+.
- **Anti-enumeration:** `authorize()` always runs a bcrypt compare, even against a
  dummy hash `$2a$12$000...` when the email is unknown. Response time is
  equalized.
- **Status gate:** only `status === ACTIVE` users authenticate. `DISABLED` and
  `SUSPENDED` users get `null` (auth failure).
- **JWT revalidation:** the `jwt` callback re-fetches `status`, `role`, `isDemo`
  from the DB on every token use. If the user has been disabled since the token
  was issued, the callback clears identifying claims (`id`, `email`, `role`) and
  sets `status = DISABLED`, force-logging-out the user on the next request.
- **Session augmentation:** the `session` callback exposes `id`, `role`, `status`,
  `isDemo` on `session.user` for client consumption.

### Authorization — Role → Permission matrix

`src/lib/permissions.ts`:
- **`Permission`** is a closed union of 18 permissions
  (`waitlist.view`, `waitlist.approve`, `waitlist.reject`, `user.view`,
  `user.create`, `user.disable`, `user.changerole`, `intent.create`, `intent.view`,
  `intent.view.all`, `capability.view`, `session.view`, `session.view.all`,
  `session.action`, `decision.evaluate`, `provider.manage`, `audit.view`,
  `platform.bootstrap`).
- **`ROLE_PERMISSIONS`** is a `Record<Role, Permission[]>`. `PLATFORM_ADMIN` has
  all permissions; `OPERATIONS` is read-mostly; `CONSUMER`/`FAMILY_ADMIN`/
  `ENTERPRISE_ADMIN` have intent + session + decision permissions on their own
  scope; `PROVIDER` and `RESELLER` are scoped to capabilities and sessions.
- **`can(role, perm)`** is the single check function. It accepts `undefined | null`
  for role and returns `false` — no implicit grants.

### Server helpers

`src/lib/server-auth.ts`:
- **`getContext()`** — returns `AuthContext | null`. Always server-side (uses
  `getServerSession`).
- **`requirePermission(perm)`** — returns ctx if the session has the permission,
  else null. Routes construct their own `NextResponse` (App Router has no `res`).
- **`requireActiveUser()`** — re-fetches the user's `status`, `role`, `isDemo`
  from the DB before authorizing. Defense against a stale JWT where the user was
  disabled between token issue and this request. Used for any state-mutating
  route (`/api/sessions/[id]/actions`, `/api/decisions`, `/api/waitlist/*`,
  `/api/admin/users/*`).

### No email-based checks

No route in `src/app/api/**` inspects `ctx.email` to decide permission. Ownership
checks (e.g. "this intent belongs to the requesting user") compare
`intent.subjectId === ctx.userId`, which is a UUID, not an email. This means an
admin can change a user's email without breaking any authorization rule.

## Consequences

**Positive**
- Disabling a user takes effect on the next request (JWT revalidation). No
  "wait for token expiry" window.
- Permission changes are a one-line edit in `ROLE_PERMISSIONS` with compile-checked
  fallthrough (TypeScript will complain about a role with no entry).
- Audit logs reference `actorId` (UUID) — they survive email changes.
- The same `requirePermission` helper works in every route handler, eliminating
  per-route auth boilerplate.

**Negative**
- Every authenticated request triggers one DB query in the `jwt` callback (for
  revalidation). On Vercel with Neon pooled Postgres this is ~5-15 ms and
  acceptable. If it becomes a bottleneck, the revalidation can be time-gated
  (e.g. only re-fetch if the token is older than 60 s).

**Risks**
- The dummy-hash anti-enumeration equalizes timing only approximately (bcrypt
  compare time depends on hash structure, which differs between real and dummy).
  A determined attacker could still distinguish "user exists" from "no user" via
  statistical timing. Mitigation: this is a low-sensitivity platform in MVP; a
  future hardening could use a constant-time dummy hash with the same cost factor
  and salt structure.
- JWTs are signed with `NEXTAUTH_SECRET`. If that secret leaks, all tokens are
  forgeable. Mitigation: secret rotation procedure (document, not implement in
  MVP); JWT revalidation limits the blast radius of a forged token to the
  disabled-user check.
