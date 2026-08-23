import {
  Handle,
  Position,
} from "@xyflow/react"

import { Server } from "lucide-react"

import type { ServiceStatus } from "../../types/service"

interface ServiceNodeData {
  name: string
  status: ServiceStatus
  latency: number
  errorRate: number
}

interface ServiceNodeProps {
  data: ServiceNodeData
}

function getStatusColor(status: ServiceStatus) {
  switch (status) {
    case "healthy":
      return "bg-emerald-400"

    case "warning":
      return "bg-amber-400"

    case "critical":
      return "bg-red-400"
  }
}

function getStatusTextColor(status: ServiceStatus) {
  switch (status) {
    case "healthy":
      return "text-emerald-400"

    case "warning":
      return "text-amber-400"

    case "critical":
      return "text-red-400"
  }
}

export default function ServiceNode({
  data,
}: ServiceNodeProps) {
  return (
    <div className="relative w-56 rounded-xl border border-slate-700 bg-slate-900 shadow-xl">

      {/* Incoming connection */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-slate-950 !bg-blue-400"
      />

      {/* Outgoing connection */}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-slate-950 !bg-blue-400"
      />

      {/* Service header */}
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-3">

        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800">
          <Server
            size={18}
            className="text-blue-400"
          />
        </div>

        <div className="min-w-0">

          <p className="truncate text-sm font-semibold text-white">
            {data.name}
          </p>

          <div className="mt-1 flex items-center gap-2">

            <span
              className={`h-2 w-2 rounded-full ${getStatusColor(
                data.status,
              )}`}
            />

            <span
              className={`text-xs capitalize ${getStatusTextColor(
                data.status,
              )}`}
            >
              {data.status}
            </span>

          </div>
        </div>

      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 px-4 py-3">

        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Latency
          </p>

          <p className="mt-1 text-xs font-medium text-slate-300">
            {data.latency} ms
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Errors
          </p>

          <p className="mt-1 text-xs font-medium text-slate-300">
            {data.errorRate}%
          </p>
        </div>

      </div>

    </div>
  )
}