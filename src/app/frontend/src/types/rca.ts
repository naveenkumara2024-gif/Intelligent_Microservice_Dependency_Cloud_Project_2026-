export interface RCAResult {
  incidentId: string
  rootCauseService: string
  confidence: number
  severity: "low" | "medium" | "high" | "critical"
  affectedServices: string[]
  propagationPath: string[]
  blastRadius: number
  explanation: string
}