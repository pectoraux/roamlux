// Domain events contract. These are the event types written to the OutboxEvent table.
// The outbox is a table, NOT a bus. A future worker drains it. We are precise:
// we do not claim to have an event bus if we only have an outbox table.
export const EVENTS_CONTRACT_VERSION = "1.0.0" as const;

export type DomainEventType =
  | "WaitlistEntryCreated"
  | "WaitlistEntryApproved"
  | "WaitlistEntryRejected"
  | "WaitlistEntryConverted"
  | "UserCreated"
  | "UserDisabled"
  | "UserEnabled"
  | "RoleChanged"
  | "IntentCreated"
  | "CapabilityPublished"
  | "CapabilityExpired"
  | "ResourceReserved"
  | "EntitlementCreated"
  | "DecisionCreated"
  | "ActionRequested"
  | "ActionCompleted"
  | "ActionFailed"
  | "SessionStarted"
  | "SessionSuspended"
  | "SessionResumed"
  | "SessionTerminated"
  | "SessionSwitched"
  | "MeasurementRecorded"
  | "ProvisioningFailed"
  | "ReconciliationRequired";

export interface DomainEvent<T = unknown> {
  type: DomainEventType;
  payload: T;
}
