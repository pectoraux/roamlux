# ADR-008 — Waitlist / Identity Lifecycle

**Status:** Accepted
**Date:** Architecture freeze

## Context

A public signup form that directly creates a `User` row has two problems: (1) it
lets anyone self-provision an account on a platform that may need gating (early
access, region rollout, KYC); (2) it conflates "someone expressed interest" with
"someone is a user", which corrupts every user-count metric, every auth flow, and
every audit query.

We need a lifecycle where:
- Public signup creates a *request*, not an account.
- A platform admin reviews and approves the request.
- Approval converts the request into a real `User` with a one-time onboarding
  credential.
- The whole flow is transactional and idempotent — a duplicate approval must not
  create two users, and a network retry must not corrupt state.

## Decision

`WaitlistEntry` is a separate Prisma model with its own state machine. Public
signup never creates a `User`.

### Lifecycle

```
PENDING ──approve──▶ APPROVED ──convert──▶ CONVERTED
   │                    │
   │                    └──reject (forbidden once APPROVED)──▶ REJECTED
   │
   └──reject──▶ REJECTED

INVITED is an intermediate state reserved for future email-based invitation flows.
```

- **Public signup** (`POST /api/signup`) creates a `WaitlistEntry` with
  `status=PENDING`, `requestedRole` (default `CONSUMER`), `source="public_signup"`.
  No `User` row exists. The signup endpoint cannot grant elevated roles.

- **Admin approval** (`POST /api/waitlist/[id]/approve`, requires
  `waitlist.approve` permission):
  - `approveWaitlistEntry(entryId, approverId)` marks `PENDING|REJECTED → APPROVED`
    and records `decidedAt` + `decidedBy`. Emits `WaitlistEntryApproved` outbox
    event and an audit `waitlist.approve` row.
  - Idempotent: approving an already-`APPROVED` entry is a no-op. Approving a
    `CONVERTED` entry returns `alreadyConverted: true` with the existing
    `convertedUserId`.

- **Conversion to User** (`createUserFromWaitlist(entryId, approverId)` in
  `src/lib/services/waitlist-service.ts`):
  - Precondition: entry status must be `APPROVED` or `INVITED`. Otherwise returns
    `MUST_APPROVE_FIRST`.
  - Generates a random one-time onboarding password (`randomBytes(12).toString("base64url")`),
    hashes it with bcrypt (12 rounds).
  - Runs in a `db.$transaction`:
    1. Checks for an existing `User` with the same email (handles the race where
       someone signed up directly after approval). If found, links the entry to
       the existing user and marks `CONVERTED`.
    2. Otherwise creates the `User` with `role = entry.requestedRole`,
       `status = ACTIVE`, `isDemo = false`.
    3. Updates the `WaitlistEntry`: `status = CONVERTED`, `convertedUserId = user.id`,
       `decidedAt`, `decidedBy`.
  - Emits outbox events `UserCreated` and `WaitlistEntryConverted`.
  - Audit rows: `user.create` (with `source: "waitlist_conversion"`) and
    `waitlist.convert`.
  - Returns `onboardToken` (the plaintext onboarding password) to the caller —
    the admin must deliver it to the user out-of-band. The plaintext is never
    persisted.

- **Rejection** (`rejectWaitlistEntry`): marks `REJECTED`, refuses if already
  `CONVERTED`, records reason and audit.

### Schema support

- `WaitlistEntry.convertedUserId` is `@unique` — one entry maps to at most one user.
- `WaitlistEntry.email` is `@unique` — one entry per email.
- `User.waitlistEntry` is an optional back-relation.

## Consequences

**Positive**
- Every real `User` row has a known provenance: either bootstrapped (admin/demo) or
  converted from a `WaitlistEntry`. There is no "ghost user" path.
- The audit trail answers "who approved this user, when, and from what requested
  role?" without parsing auth logs.
- Retrying an approval or conversion is safe — the functions are idempotent and
  return the existing user when already converted.
- Email enumeration is bounded: a `POST /api/signup` with a duplicate email
  returns success (idempotent) rather than revealing that the email is known.

**Negative**
- Two-step approval flow (approve → convert) where one step might suffice. This is
  intentional: it lets an admin approve a batch and convert on a schedule, and it
  gives a clean audit seam between "decision to admit" and "account creation".

**Risks**
- The `onboardToken` (plaintext password) is returned to the admin caller. If the
  admin's session is compromised before delivery, an attacker gets a one-time
  login. Mitigation: the password is single-use in spirit (the user must rotate it
  after first login — a future enhancement); bcrypt-hashing limits offline attack
  if it leaks from logs (it must not be logged).
- A future "self-serve signup" mode would bypass waitlist. That would be a new ADR;
  this one explicitly chooses gating.
