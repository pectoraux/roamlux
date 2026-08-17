# ADR-002 — Capability vs Offer

**Status:** Accepted
**Date:** Architecture freeze

## Context

In telco and connectivity marketplaces the terms "capability", "plan", "product",
"offer", and "SKU" are routinely conflated. The result is that a price change gets
recorded as a coverage change, a coverage expansion silently invalidates historical
offers, and a single record ends up carrying technical + commercial + lifecycle
fields that change at different cadences.

RoamLink must support:
- A provider publishing a *technical* ability (e.g. "we operate LTE in Ghana and
  Nigeria, peak 45 Mbps down") independently of commercial terms.
- Multiple commercial terms over the same technical ability (a daily pass, a monthly
  plan, a per-GB plan).
- Time-bounded validity for both technical and commercial records, with non-overlapping
  historical provenance.

## Decision

`Capability` and `Offer` are separate Prisma models with a one-to-many relationship.
They are never collapsed.

- **`Capability`** = what a provider's resource can *technically* provide.
  Fields: `providerId`, `type` ("wifi"|"lte"|"esim_data"|"isp"|"satellite"|"shared_bw"),
  `coverage` JSONB, `advertised` JSONB (`maxDownlinkMbps`, `maxUplinkMbps`,
  `typicalLatencyMs`, `reliability`, `availabilityPct`), `validFrom`, `validUntil`,
  `published`.
- **`Offer`** = commercial terms over a capability/resource.
  Fields: `capabilityId`, `resourceId?`, `providerId`, `name`, `currency` (USD),
  `priceCents`, `unit` ("flat"|"per_gb"|"per_hour"|"per_day"), `billingModel`
  JSONB (`activationFeeCents?`, `overageCentsPerGb?`), `valid` boolean.
- One `Capability` may have many `Offer`s. An `Offer` may bind to a specific
  `Resource` (e.g. one particular SIM profile) or to the capability in general.
- The decision engine reads `Capability.advertised` for the technical profile and
  `Offer.priceCents` for the cost term; it never reads price from a capability nor
  latency from an offer.
- The decision result (`ScoredCandidate`) carries `providerCode`, `providerName`,
  `offerId`, `priceCents`, `latencyMs`, `downlinkMbps`, `reliability` — i.e. it
  merges the two at the *boundary*, not at the *source*.

## Consequences

**Positive**
- A provider can update commercial terms without touching technical records — and
  vice versa. Audit history stays clean.
- The same capability can back a per-hour pass for travellers and a flat monthly
  subscription for residents, with both surfaced as separate `Offer`s.
- The control plane's scoring is stable: a price change alters only the `cost`
  component (weight 0.20) without altering the technical scoring inputs.

**Negative**
- Two writes where one would suffice when introducing a new capability. Mitigated by
  `src/lib/bootstrap.ts`, which creates capability + resource + offer in a single
  idempotent sweep per mock provider.

**Risks**
- An `Offer` may be created with `resourceId=null` (capability-level offer) and later
  a specific resource may need binding. The schema allows this; downstream code that
  assumes `offer.resourceId` is non-null must guard. The decision route uses
  `res.offers[0] ?? cap.offers?.[0]` precisely to tolerate this.
