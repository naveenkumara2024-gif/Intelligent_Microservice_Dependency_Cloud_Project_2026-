import { Activity } from "lucide-react"
import { mockServices } from "../../mock/services"

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

export default function ServiceHealth() {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div>
          <h3 className="font-semibold text-white">
            Service Health
          </h3>

          <p className="mt-1 text-xs text-slate-500">
            Current microservice health status
          </p>
        </div>

        <Activity size={19} className="text-slate-500" />
      </div>

      <div className="divide-y divide-slate-800">
        {mockServices.map((service) => (
          <div
            key={service.id}
            className="flex items-center justify-between px-5 py-4"
          >
            <div className="flex items-center gap-3">
              <span
                className={`h-2.5 w-2.5 rounded-full ${getStatusColor(
                  service.status,
                )}`}
              />

              <div>
                <p className="text-sm font-medium text-white">
                  {service.name}
                </p>

                <p className="text-xs text-slate-500">
                  {service.latency} ms latency
                </p>
              </div>
            </div>

            <div className="text-right">
              <p
                className={`text-xs font-medium capitalize ${getStatusTextColor(
                  service.status,
                )}`}
              >
                {service.status}
              </p>

              <p className="text-xs text-slate-500">
                {service.errorRate}% errors
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}