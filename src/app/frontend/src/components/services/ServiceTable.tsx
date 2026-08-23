import {
  Activity,
  AlertCircle,
  ChevronRight,
  Server,
} from "lucide-react"

import { mockServices } from "../../mock/services"

interface ServiceTableProps {
  searchTerm: string
  statusFilter: string
  onServiceSelect: (serviceId: string) => void
}

function getStatusColor(status: string) {
  switch (status) {
    case "healthy":
      return "bg-emerald-400"

    case "warning":
      return "bg-amber-400"

    case "critical":
      return "bg-red-400"

    default:
      return "bg-slate-400"
  }
}

function getStatusTextColor(status: string) {
  switch (status) {
    case "healthy":
      return "text-emerald-400"

    case "warning":
      return "text-amber-400"

    case "critical":
      return "text-red-400"

    default:
      return "text-slate-400"
  }
}

export default function ServiceTable({
  searchTerm,
  statusFilter,
  onServiceSelect,
}: ServiceTableProps) {
  const filteredServices = mockServices.filter((service) => {
    const matchesSearch = service.name
      .toLowerCase()
      .includes(searchTerm.toLowerCase())

    const matchesStatus =
      statusFilter === "all" ||
      service.status === statusFilter

    return matchesSearch && matchesStatus
  })

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">

      {/* Table header */}
      <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] gap-4 border-b border-slate-800 px-5 py-3 text-xs font-medium uppercase tracking-wide text-slate-500 md:grid">

        <span>Service</span>
        <span>Status</span>
        <span>Latency</span>
        <span>Error Rate</span>
        <span>Dependencies</span>
        <span />
      </div>

      {/* Rows */}
      {filteredServices.map((service) => (
        <button
          key={service.id}
          onClick={() => onServiceSelect(service.id)}
          className="grid w-full grid-cols-1 gap-3 border-b border-slate-800 px-5 py-4 text-left transition last:border-b-0 hover:bg-slate-800/40 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_40px] md:items-center md:gap-4"
        >

          {/* Service */}
          <div className="flex items-center gap-3">

            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">
              <Server
                size={17}
                className="text-blue-400"
              />
            </div>

            <div>
              <p className="text-sm font-medium text-white">
                {service.name}
              </p>

              <p className="mt-1 text-xs text-slate-500">
                {service.id}
              </p>
            </div>

          </div>

          {/* Status */}
          <div className="flex items-center gap-2">

            <span
              className={`h-2 w-2 rounded-full ${getStatusColor(
                service.status,
              )}`}
            />

            <span
              className={`text-xs font-medium capitalize ${getStatusTextColor(
                service.status,
              )}`}
            >
              {service.status}
            </span>

          </div>

          {/* Latency */}
          <div className="flex items-center gap-2">

            <Activity
              size={14}
              className="text-slate-600"
            />

            <span className="text-sm text-slate-300">
              {service.latency} ms
            </span>

          </div>

          {/* Error rate */}
          <div className="flex items-center gap-2">

            <AlertCircle
              size={14}
              className="text-slate-600"
            />

            <span className="text-sm text-slate-300">
              {service.errorRate}%
            </span>

          </div>

          {/* Dependencies */}
          <div>
            <span className="text-sm text-slate-300">
              {service.dependencies}
            </span>
          </div>

          {/* Arrow */}
          <ChevronRight
            size={17}
            className="hidden text-slate-600 md:block"
          />

        </button>
      ))}

      {/* Empty state */}
      {filteredServices.length === 0 && (
        <div className="px-5 py-12 text-center">

          <Server
            size={28}
            className="mx-auto text-slate-700"
          />

          <p className="mt-3 text-sm font-medium text-slate-400">
            No services found
          </p>

          <p className="mt-1 text-xs text-slate-600">
            Try changing your search or status filter.
          </p>

        </div>
      )}

    </div>
  )
}