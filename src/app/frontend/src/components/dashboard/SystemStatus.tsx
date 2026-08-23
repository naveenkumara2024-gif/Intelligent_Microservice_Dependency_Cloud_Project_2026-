import {
  Activity,
  CheckCircle2,
  Clock3,
  Server,
} from "lucide-react"

export default function SystemStatus() {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60">
      
      <div className="border-b border-slate-800 px-5 py-4">
        <h3 className="font-semibold text-white">
          System Status
        </h3>

        <p className="mt-1 text-xs text-slate-500">
          Overall platform health
        </p>
      </div>

      <div className="p-5">
        <div className="flex items-center gap-3 rounded-lg bg-emerald-500/10 p-4">
          <CheckCircle2
            size={24}
            className="text-emerald-400"
          />

          <div>
            <p className="font-medium text-emerald-400">
              Operational
            </p>

            <p className="text-xs text-slate-500">
              All critical systems are being monitored
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Server
                size={17}
                className="text-slate-500"
              />

              <span className="text-sm text-slate-400">
                Services monitored
              </span>
            </div>

            <span className="text-sm font-semibold text-white">
              12
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Activity
                size={17}
                className="text-slate-500"
              />

              <span className="text-sm text-slate-400">
                System uptime
              </span>
            </div>

            <span className="text-sm font-semibold text-white">
              99.92%
            </span>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Clock3
                size={17}
                className="text-slate-500"
              />

              <span className="text-sm text-slate-400">
                Last updated
              </span>
            </div>

            <span className="text-sm font-semibold text-white">
              Just now
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}