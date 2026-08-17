# ADR-003 — Resource vs Entitlement

**Status:** Accepted
**Date:** Architecture freeze

## Context

A common pattern in commerce systems is to conflate "the thing being consumed" with
"the right to consume it". A subscription record holds both the SKU and the remaining
quota; a purchase record both decrements inventory and grants access. This conflation
breaks down badly in connectivity:

- A SIM profile (the Resource) is provisioned once but may be re-entitled to a
  different consumer (family transfer, sponsorship, company allocation).
- A consumer may have multiple entitlements (a trial, a purchased plan, a family
  transfer) that all draw against different Resources at different times.
- Payment truth ("the customer paid") and connectivity truth ("the customer is
  online") change at different times and for different reasons. A payment may
  succeed while activation fails; an entitlement may be granted without payment
  (trial, promotion, sponsorship).

If we collapse Resource and Entitlement, we are forced to choose whether payment or
connectivity is authoritative, and either answer is wrong in some flow.

## Decision

`Resource` and `Entitlement` are separate Prisma models with different lifecycles.
**Payment is never connectivity truth.**

- **`Resource`** = the actual consumable/controllable thing — a hotspot session, a
  SIM profile, a data package, a router. Fields: `providerId`, `capabilityId`,
  `identifier` (provider-native id), `state`
  ("available"|"reserved"|"active"|"released"|"expired"|"failed"), `attributes`
  JSONB (`quotaGB?`, `maxConcurrent?`, `geoLock?`).
- **`Entitlement`** = the consumer's RIGHT to consume a resource, parameterised by
  an `EntitlementOrigin` enum: `PURCHASE`, `SUBSCRIPTION`, `COMPANY_ALLOCATION`,
  `FAMILY_TRANSFER`, `PROMOTION`, `SPONSORSHIP`, `TRIAL`. Fields: `subjectId`,
  `offerId?`, `origin`, `quota` JSONB (`dataGB?`, `seconds?`, `sessions?`),
  `validFrom`, `validUntil?`, `consumed` JSONB, `active`.
- A `Reservation` may reference an `Entitlement` (the entitlement under which it was
  made). This is the *only* structural link between the two.
- The decision engine treats `entitlementValid` as a candidate filter, not as a
  score input. A candidate without entitlement validity is non-viable, regardless of
  how good its latency or price looks.
- For the MVP demo flow, `ensureEntitlement()` in `src/lib/services/session-service.ts`
  grants a `TRIAL` entitlement (2 GB, 1 session) if none exists. The TRIAL origin is
  explicit and audited — it is never silently treated as a purchase.

## Consequences

**Positive**
- Family/enterprise transfer, sponsorship, and trial flows are first-class — they
  are different `origin` values, not different code paths.
- A failed payment does not corrupt the resource state; the entitlement simply
  doesn't exist yet.
- A refund or revocation sets `entitlement.active = false`; the resource may remain
  `active` until the next decision cycle, at which point the engine will `RELEASE`
  with reason `ENTITLEMENT_MISSING`. This is correct behaviour.
- Audit can answer "who had the right to use this resource at time T?" without
  parsing payment logs.

**Negative**
- Two writes per activation (resource state + entitlement consumed). Mitigated by
  the session-service, which does both in a single transaction where applicable.
- Engineers must learn that "the user paid" is not the same as "the user has an
  entitlement". Code that fetches `Offer` records to determine access is wrong; it
  must fetch `Entitlement` records.

**Risks**
- `Entitlement.consumed` is mutable JSONB. Concurrent updates could race. Mitigation:
  in MVP, sessions are single-writer per subject; a future worker would use
  conditional updates on the JSONB.
