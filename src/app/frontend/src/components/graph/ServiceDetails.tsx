import {
  Activity,
  AlertCircle,
  Clock3,
  Server,
  X,
} from "lucide-react"

import { mockServices } from "../../mock/services"

interface ServiceDetailsProps {
  serviceId: string
  onClose: () => void
}

function getStatusColor(status: string) {
  switch (status) {
    case "healthy":
      return "text-emerald-400 bg-emerald-500/10"

    case "warning":
      return "text-amber-400 bg-amber-500/10"

    case "critical":
      return "text-red-400 bg-red-500/10"

    default:
      return "text-slate-400 bg-slate-500/10"
  }
}

export default function ServiceDetails({
  serviceId,
  onClose,
}: ServiceDetailsProps) {

  const service = mockServices.find(
    (item) => item.id === serviceId,
  )

  if (!service) {
    return null
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">

      {/* Header */}
      <div className="flex items-start justify-between border-b border-slate-800 p-5">

        <div className="flex items-center gap-3">

          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
            <Server
              size={20}
              className="text-blue-400"
            />
          </div>

          <div>
            <h3 className="font-semibold text-white">
              {service.name} Service
            </h3>

            <p className="mt-1 text-xs text-slate-500">
              Microservice details
            </p>
          </div>

        </div>

        <button
          onClick={onClose}
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-800 hover:text-white"
        >
          <X size={18} />
        </button>

      </div>

      {/* Status */}
      <div className="p-5">

        <div
          className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium capitalize ${getStatusColor(
            service.status,
          )}`}
        >
          <span className="h-2 w-2 rounded-full bg-current" />

          {service.status}
        </div>

        {/* Metrics */}
        <div className="mt-5 grid grid-cols-2 gap-3">

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">

            <div className="flex items-center gap-2 text-slate-500">
              <Clock3 size={15} />

              <span className="text-xs">
                Latency
              </span>
            </div>

            <p className="mt-2 text-xl font-semibold text-white">
              {service.latency} ms
            </p>

          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">

            <div className="flex items-center gap-2 text-slate-500">
              <AlertCircle size={15} />

              <span className="text-xs">
                Error Rate
              </span>
            </div>

            <p className="mt-2 text-xl font-semibold text-white">
              {service.errorRate}%
            </p>

          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">

            <div className="flex items-center gap-2 text-slate-500">
              <Activity size={15} />

              <span className="text-xs">
                Requests
              </span>
            </div>

            <p className="mt-2 text-xl font-semibold text-white">
              {service.requestCount.toLocaleString()}
            </p>

          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">

            <div className="flex items-center gap-2 text-slate-500">
              <Server size={15} />

              <span className="text-xs">
                Dependencies
              </span>
            </div>

            <p className="mt-2 text-xl font-semibold text-white">
              {service.dependencies}
            </p>

          </div>

        </div>

        {/* Information */}
        <div className="mt-6">

          <h4 className="text-sm font-semibold text-white">
            Dependency Information
          </h4>

          <div className="mt-3 space-y-3">

            <div className="flex items-center justify-between rounded-lg bg-slate-950 px-4 py-3">

              <span className="text-xs text-slate-500">
                Service ID
              </span>

              <span className="text-xs font-medium text-slate-300">
                {service.id}
              </span>

            </div>

            <div className="flex items-center justify-between rounded-lg bg-slate-950 px-4 py-3">

              <span className="text-xs text-slate-500">
                Current Status
              </span>

              <span className="text-xs font-medium capitalize text-slate-300">
                {service.status}
              </span>

            </div>

          </div>

        </div>

      </div>
    </div>
  )
}