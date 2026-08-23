export interface Dependency {
  id: string
  source: string
  target: string
  latency: number
  errorRate: number
  requestCount: number
}