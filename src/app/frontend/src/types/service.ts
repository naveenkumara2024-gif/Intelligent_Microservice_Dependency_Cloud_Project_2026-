export type ServiceStatus = "healthy" | "warning" | "critical"

export interface Service {
  id: string
  name: string
  status: ServiceStatus
  latency: number
  errorRate: number
  requestCount: number
  dependencies: number
}