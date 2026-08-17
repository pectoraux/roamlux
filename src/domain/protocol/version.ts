// RoamLink Protocol — versioned domain contracts.
// The protocol is the PUBLIC contract. It is portable: no Prisma, no Next.js,
// no provider SDKs, no database access. Persistence models are NOT the protocol.
//
// Each concept is a distinct contract: Intent ≠ Capability ≠ Resource ≠ Offer ≠
// Entitlement ≠ Reservation ≠ Session ≠ Measurement ≠ Decision.
export const PROTOCOL_VERSION = "1.0.0" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
