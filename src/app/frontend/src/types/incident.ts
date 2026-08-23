export type IncidentSeverity =
  | "low"
  | "medium"
  | "high"
  | "critical"

export type IncidentStatus =
  | "active"
  | "investigating"
  | "resolved"

export interface Incident {
  id: string
  service: string
  severity: IncidentSeverity
  status: IncidentStatus
  rootCause: string
  confidence: number
  createdAt: string
}