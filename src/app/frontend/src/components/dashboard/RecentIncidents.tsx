import { AlertTriangle, ArrowRight } from "lucide-react"

const incidents = [
  {
    id: "INC-1024",
    service: "Payment",
    severity: "critical",
    status: "Active",
    time: "2 min ago",
  },
  {
    id: "INC-1023",
    service: "Cart",
    severity: "high",
    status: "Investigating",
    time: "8 min ago",
  },
  {
    id: "INC-1022",
    service: "Catalog",
    severity: "medium",
    status: "Resolved",
    time: "24 min ago",
  },
]

function getSeverityColor(severity: string) {
  switch (severity) {
    case "critical":
      return "text-red-400 bg-red-500/10"

    case "high":
      return "text-orange-400 bg-orange-500/10"

    case "medium":
      return "text-amber-400 bg-amber-500/10"

    default:
      return "text-slate-400 bg-slate-500/10"
  }
}

export default function RecentIncidents() {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div>
          <h3 className="font-semibold text-white">
            Recent Incidents
          </h3>

          <p className="mt-1 text-xs text-slate-500">
            Latest detected system issues
          </p>
        </div>

        <AlertTriangle
          size={19}
          className="text-slate-500"
        />
      </div>

      <div className="divide-y divide-slate-800">
        {incidents.map((incident) => (
          <div
            key={incident.id}
            className="flex items-center justify-between px-5 py-4 transition hover:bg-slate-800/30"
          >
            <div className="flex items-center gap-4">
              <div>
                <p className="text-sm font-medium text-white">
                  {incident.id}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {incident.service} · {incident.time}
                </p>
              </div>

              <span
                className={`rounded-md px-2 py-1 text-xs font-medium capitalize ${getSeverityColor(
                  incident.severity,
                )}`}
              >
                {incident.severity}
              </span>
            </div>

            <div className="flex items-center gap-4">
              <span className="text-xs text-slate-400">
                {incident.status}
              </span>

              <ArrowRight
                size={16}
                className="text-slate-600"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}