import type { Service } from "../types/service"

export const mockServices: Service[] = [
  {
    id: "frontend",
    name: "Frontend",
    status: "healthy",
    latency: 42,
    errorRate: 0.2,
    requestCount: 12400,
    dependencies: 3,
  },
  {
    id: "catalog",
    name: "Catalog",
    status: "healthy",
    latency: 51,
    errorRate: 0.5,
    requestCount: 21300,
    dependencies: 2,
  },
  {
    id: "cart",
    name: "Cart",
    status: "warning",
    latency: 120,
    errorRate: 2.1,
    requestCount: 8700,
    dependencies: 2,
  },
  {
    id: "payment",
    name: "Payment",
    status: "critical",
    latency: 245,
    errorRate: 8.4,
    requestCount: 12400,
    dependencies: 3,
  },
  {
    id: "inventory",
    name: "Inventory",
    status: "healthy",
    latency: 62,
    errorRate: 0.8,
    requestCount: 9800,
    dependencies: 2,
  },
]