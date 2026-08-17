// RoamLink Protocol — barrel re-export of all versioned contracts.
// Import from "@/domain/protocol" resolves here.
// Each concept is distinct: Intent ≠ Capability ≠ Resource ≠ Offer ≠
// Entitlement ≠ Reservation ≠ Session ≠ Measurement ≠ Decision ≠ Action.
export { PROTOCOL_VERSION, type ProtocolVersion } from "./version";
export { IDENTITY_CONTRACT_VERSION, type Role, type UserStatus, type IdentityRef, isValidIdentity } from "./identity";
export { INTENT_CONTRACT_VERSION, type LocationSpec, type TimeWindowSpec, type UsageSpec, type ConstraintSpec, type PreferenceSpec, type PolicySpec, type ConnectivityIntentPayload, validateIntent } from "./intent";
export { CAPABILITY_CONTRACT_VERSION, type CapabilityType, type AdvertisedCapability, type CoverageSpec, CAPABILITY_TAXONOMY, capabilityMatches, isAbstractCapability } from "./capability";
export { RESOURCE_CONTRACT_VERSION, type ResourceState, type ResourceAttributes, type ResourceRef } from "./resource";
export { OFFER_CONTRACT_VERSION, type BillingUnit, type BillingModel, type OfferRef } from "./offer";
export { ENTITLEMENT_CONTRACT_VERSION, type EntitlementOrigin, type EntitlementQuota, type EntitlementRef, isEntitledTo } from "./entitlement";
export { RESERVATION_CONTRACT_VERSION, type ReservationState, RESERVATION_TRANSITIONS, type ReservationRef } from "./reservation";
export { SESSION_CONTRACT_VERSION, type SessionState, SESSION_TRANSITIONS, RECONCILIATION_TRANSITIONS, type SessionTransitionRef, type ConnectivitySessionRef } from "./session";
export { MEASUREMENT_CONTRACT_VERSION, type MeasurementSnapshot, isObserved } from "./measurement";
export { ACTION_CONTRACT_VERSION, type ActionType, ALL_ACTIONS, OBSERVATIONAL_ACTIONS, MUTATING_ACTIONS, type AdapterDescriptor, type AdapterExecuteOptions, type AdapterActionResult, type ReconcileResult, type Adapter, supportsAction, isCompatibleAdapter, unsupportedActionResult } from "./action";
export { DECISION_CONTRACT_VERSION, type DecisionType, type ReasonCode, type ScoredCandidate, type DecisionResult } from "./decision";
export { EVENTS_CONTRACT_VERSION, type DomainEventType, type DomainEvent } from "./events";
