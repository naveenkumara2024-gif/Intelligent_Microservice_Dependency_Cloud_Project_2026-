import { useState } from "react"

import {
  Activity,
  Database,
  Info,
  Network,
} from "lucide-react"

import DependencyGraph from "../components/graph/DependencyGraph"
import ServiceDetails from "../components/graph/ServiceDetails"

export default function DependencyGraphPage() {
  const [selectedService, setSelectedService] = useState<string | null>(null)
  return (
    <div className="space-y-6">

      {/* Page heading */}
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Network
                size={21}
                className="text-blue-400"
              />
            </div>

            <div>
              <h1 className="text-2xl font-semibold text-white">
                Dependency Graph
              </h1>

              <p className="mt-1 text-sm text-slate-500">
                Interactive microservice dependency topology
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />

            <span className="text-xs text-slate-400">
              Live topology
            </span>
          </div>

          <button className="rounded-lg border border-slate-800 bg-slate-900 p-2.5 text-slate-400 hover:bg-slate-800 hover:text-white">
            <Activity size={17} />
          </button>
        </div>
      </div>

      {/* Information cards */}
      <div className="grid gap-4 md:grid-cols-3">

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-3">
            <Network
              size={18}
              className="text-blue-400"
            />

            <div>
              <p className="text-xs text-slate-500">
                Services
              </p>

              <p className="mt-1 text-lg font-semibold text-white">
                5
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-3">
            <Database
              size={18}
              className="text-purple-400"
            />

            <div>
              <p className="text-xs text-slate-500">
                Dependencies
              </p>

              <p className="mt-1 text-lg font-semibold text-white">
                4
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex items-center gap-3">
            <Info
              size={18}
              className="text-amber-400"
            />

            <div>
              <p className="text-xs text-slate-500">
                Graph Source
              </p>

              <p className="mt-1 text-sm font-semibold text-white">
                Knowledge Graph
              </p>
            </div>
          </div>
        </div>

      </div>

      {/* Graph */}
      <DependencyGraph
        onServiceSelect={setSelectedService}
      />
      {selectedService && (
        <ServiceDetails
          serviceId={selectedService}
          onClose={() => setSelectedService(null)}
          />
      )}
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-6 rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-4">

        <span className="text-xs font-medium text-slate-400">
          Service Status
        </span>

        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <span className="text-xs text-slate-400">
            Healthy
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
          <span className="text-xs text-slate-400">
            Warning
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
          <span className="text-xs text-slate-400">
            Critical
          </span>
        </div>

        <span className="ml-auto text-xs text-slate-600">
          Drag nodes to explore dependencies
        </span>

      </div>

    </div>
  )
}