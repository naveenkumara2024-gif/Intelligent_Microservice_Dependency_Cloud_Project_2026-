import { useState } from "react"

import {
  Boxes,
  Search,
  Server,
} from "lucide-react"

import ServiceTable from "../components/services/ServiceTable"
import ServiceDetailsPanel from "../components/services/ServiceDetailsPanel"

import { mockServices } from "../mock/services"

export default function Services() {
  const [searchTerm, setSearchTerm] = useState("")

  const [statusFilter, setStatusFilter] = useState("all")

  const [selectedService, setSelectedService] = useState<
    string | null
  >(null)

  const healthyCount = mockServices.filter(
    (service) => service.status === "healthy",
  ).length

  const warningCount = mockServices.filter(
    (service) => service.status === "warning",
  ).length

  const criticalCount = mockServices.filter(
    (service) => service.status === "critical",
  ).length

  return (
    <div className="space-y-6">

      {/* Heading */}
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">

        <div>

          <div className="flex items-center gap-3">

            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Boxes
                size={21}
                className="text-blue-400"
              />
            </div>

            <div>

              <h1 className="text-2xl font-semibold text-white">
                Services
              </h1>

              <p className="mt-1 text-sm text-slate-500">
                Monitor and analyze all microservices
              </p>

            </div>

          </div>

        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500">

          <Server size={15} />

          <span>
            {mockServices.length} services monitored
          </span>

        </div>

      </div>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-3">

        <button
          onClick={() => setStatusFilter("healthy")}
          className={`rounded-xl border p-4 text-left transition ${
            statusFilter === "healthy"
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-slate-800 bg-slate-900/60 hover:bg-slate-800/40"
          }`}
        >

          <div className="flex items-center justify-between">

            <span className="text-sm text-slate-400">
              Healthy
            </span>

            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />

          </div>

          <p className="mt-2 text-2xl font-semibold text-white">
            {healthyCount}
          </p>

        </button>

        <button
          onClick={() => setStatusFilter("warning")}
          className={`rounded-xl border p-4 text-left transition ${
            statusFilter === "warning"
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-slate-800 bg-slate-900/60 hover:bg-slate-800/40"
          }`}
        >

          <div className="flex items-center justify-between">

            <span className="text-sm text-slate-400">
              Warning
            </span>

            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />

          </div>

          <p className="mt-2 text-2xl font-semibold text-white">
            {warningCount}
          </p>

        </button>

        <button
          onClick={() => setStatusFilter("critical")}
          className={`rounded-xl border p-4 text-left transition ${
            statusFilter === "critical"
              ? "border-red-500/40 bg-red-500/10"
              : "border-slate-800 bg-slate-900/60 hover:bg-slate-800/40"
          }`}
        >

          <div className="flex items-center justify-between">

            <span className="text-sm text-slate-400">
              Critical
            </span>

            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />

          </div>

          <p className="mt-2 text-2xl font-semibold text-white">
            {criticalCount}
          </p>

        </button>

      </div>

      {/* Search and filter */}
      <div className="flex flex-col gap-3 sm:flex-row">

        <div className="relative flex-1">

          <Search
            size={17}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600"
          />

          <input
            type="text"
            value={searchTerm}
            onChange={(event) =>
              setSearchTerm(event.target.value)
            }
            placeholder="Search services..."
            className="w-full rounded-lg border border-slate-800 bg-slate-900 py-3 pl-10 pr-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-blue-500/50"
          />

        </div>

        <select
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value)
          }
          className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-300 outline-none focus:border-blue-500/50"
        >

          <option value="all">
            All statuses
          </option>

          <option value="healthy">
            Healthy
          </option>

          <option value="warning">
            Warning
          </option>

          <option value="critical">
            Critical
          </option>

        </select>

      </div>

      {/* Service table */}
      <ServiceTable
        searchTerm={searchTerm}
        statusFilter={statusFilter}
        onServiceSelect={setSelectedService}
      />

      {/* Selected service */}
      {selectedService && (
        <ServiceDetailsPanel
          serviceId={selectedService}
          onClose={() => setSelectedService(null)}
        />
      )}

    </div>
  )
}