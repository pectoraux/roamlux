# ADR-006 — Measurement Model

**Status:** Accepted
**Date:** Architecture freeze

## Context

Every connectivity provider advertises a profile: "up to 45 Mbps down", "typical
latency 55 ms", "99% availability". These numbers are marketing-shaped, measured
under conditions the provider chooses, and routinely diverge from observed reality
on the wire. If the decision engine scores against advertised numbers only, it will
systematically over-select providers that misrepresent their capabilities and never
benefit from real-world feedback.

The opposite failure is also real: if observations *overwrite* advertised values, we
lose the ability to detect providers that are temporarily underperforming versus
providers that systematically misrepresent. And we lose the audit trail of "what did
the provider claim when we signed up?"

## Decision

`Measurement` is a separate Prisma model, append-only, distinct from
`Capability.advertised`. **Provider claims are never automatically truth.**

- **`Capability.advertised`** (JSONB on the Capability row): the provider's claimed
  profile — `maxDownlinkMbps`, `maxUplinkMbps`, `typicalLatencyMs`, `reliability`,
  `availabilityPct`. Set at capability publication time; updated only by the
  provider.

- **`Measurement`** (append-only table): each row is one observed snapshot:
  `sessionId`, `latencyMs`, `downlinkMbps`, `uplinkMbps`, `packetLossPct`,
  `jitterMs`, `availabilityPct`, `observedAt`, `source`. The `source` field
  distinguishes `mock_adapter_observed`, `advertised_fallback`, real adapter
  sources, and future client-side speedtest sources.

- **`ConnectivitySession.currentQuality`** (JSONB): a denormalized copy of the
  *latest* measurement, for cheap reads. Convenience only — the audit trail lives
  in the `Measurement` table.

- **The decision engine prefers observed truth.** In `effectiveMeasurement()`:
  ```ts
  return c.measurement ?? {
    latencyMs: c.advertised.typicalLatencyMs,
    downlinkMbps: c.advertised.maxDownlinkMbps,
    ...
    source: "advertised_fallback",
  };
  ```
  When a recent measurement exists for a candidate resource, it is used for scoring.
  When none exists, the advertised values are used as a *fallback* and the snapshot
  is tagged `source: "advertised_fallback"` so downstream consumers know the score
  is provisional.

- **The `/api/decisions` route** queries the most recent measurement for any active
  session on the candidate resource and passes it as `measurement` in the
  `CandidateInput`. The engine does not fetch measurements itself; the API layer is
  responsible for assembling the input.

- **`MEASURE` is a generic action.** The adapter contract includes `MEASURE`; the
  session-service invokes it on demand to refresh `currentQuality` and append a new
  `Measurement` row.

## Consequences

**Positive**
- A provider that systematically underperforms will see its observed scores drop
  below competitors' advertised fallback scores, and the decision engine will
  switch away — without anyone editing the advertised profile.
- The advertised/observed distinction is auditable: we can always show "the provider
  claimed X; we observed Y" without losing either record.
- Future client-side speedtests (Layer 9/11) can write `Measurement` rows with
  `source: "client_speedtest"` and the engine will automatically incorporate them.

**Negative**
- Storage grows with measurement volume. Mitigation: a future worker can roll up
  old measurements into daily/weekly aggregates. The schema doesn't need to change.
- Decision inputs are larger (advertised + observed). Mitigated by the API layer
  assembling a single `CandidateInput` per resource.

**Risks**
- Stale measurements could mislead the engine. Mitigation: a future worker can
  down-weight measurements older than a TTL by including `observedAt` in the
  candidate input; the engine currently uses the most recent, but the
  `source: "advertised_fallback"` tag makes it explicit when no observation is
  available.
