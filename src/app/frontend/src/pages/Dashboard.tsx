import {
  AlertCircle,
  CheckCircle2,
  Server,
  TriangleAlert,
} from "lucide-react"

import StatCard from "../components/dashboard/StatCard"
import ServiceHealth from "../components/dashboard/ServiceHealth"
import SystemStatus from "../components/dashboard/SystemStatus"
import RecentIncidents from "../components/dashboard/RecentIncidents"

import { mockServices } from "../mock/services"

export default function Dashboard() {
  const totalServices = mockServices.length

  const healthyServices = mockServices.filter(
    (service) => service.status === "healthy",
  ).length

  const warningServices = mockServices.filter(
    (service) => service.status === "warning",
  ).length

  const criticalServices = mockServices.filter(
    (service) => service.status === "critical",
  ).length

  return (
    <div className="space-y-6">

      {/* Page introduction */}
      <div>
        <h1 className="text-2xl font-semibold text-white">
          System Overview
        </h1>

        <p className="mt-1 text-sm text-slate-500">
          Monitor microservice health, dependencies, and
          active incidents.
        </p>
      </div>

      {/* Statistics */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">

        <StatCard
          title="Total Services"
          value={totalServices}
          description="Microservices being monitored"
          icon={Server}
          iconColor="bg-blue-500/10 text-blue-400"
        />

        <StatCard
          title="Healthy"
          value={healthyServices}
          description="Services operating normally"
          icon={CheckCircle2}
          iconColor="bg-emerald-500/10 text-emerald-400"
        />

        <StatCard
          title="Warning"
          value={warningServices}
          description="Services requiring attention"
          icon={TriangleAlert}
          iconColor="bg-amber-500/10 text-amber-400"
        />

        <StatCard
          title="Critical"
          value={criticalServices}
          description="Services with active issues"
          icon={AlertCircle}
          iconColor="bg-red-500/10 text-red-400"
        />

      </div>

      {/* Health + System Status */}
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <ServiceHealth />
        <SystemStatus />
      </div>

      {/* Incidents */}
      <RecentIncidents />

    </div>
  )
}