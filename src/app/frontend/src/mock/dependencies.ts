import type { Dependency } from "../types/dependency"

export const mockDependencies: Dependency[] = [
  {
    id: "frontend-catalog",
    source: "frontend",
    target: "catalog",
    latency: 42,
    errorRate: 0.2,
    requestCount: 12400,
  },
  {
    id: "frontend-cart",
    source: "frontend",
    target: "cart",
    latency: 67,
    errorRate: 0.7,
    requestCount: 8700,
  },
  {
    id: "cart-payment",
    source: "cart",
    target: "payment",
    latency: 120,
    errorRate: 2.1,
    requestCount: 6200,
  },
  {
    id: "cart-inventory",
    source: "cart",
    target: "inventory",
    latency: 72,
    errorRate: 0.6,
    requestCount: 5100,
  },
]