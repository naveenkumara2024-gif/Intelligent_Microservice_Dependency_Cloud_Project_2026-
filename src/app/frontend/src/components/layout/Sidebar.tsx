import {
  Activity,
  AlertTriangle,
  Boxes,
  GitBranch,
  LayoutDashboard,
  Network,
  Settings,
} from "lucide-react"

interface SidebarProps {
  currentPage: string
  onNavigate: (page: string) => void
}

const navigationItems = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
  },
  {
    id: "graph",
    label: "Dependency Graph",
    icon: Network,
  },
  {
    id: "services",
    label: "Services",
    icon: Boxes,
  },
  {
    id: "incidents",
    label: "Incidents",
    icon: AlertTriangle,
  },
  {
    id: "rca",
    label: "Root Cause Analysis",
    icon: GitBranch,
  },
]

export default function Sidebar({
  currentPage,
  onNavigate,
}: SidebarProps) {
  return (
    <aside className="flex h-screen w-64 flex-col border-r border-slate-800 bg-slate-950">
      
      {/* Logo / Project Name */}
      <div className="border-b border-slate-800 px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600">
            <Activity size={22} />
          </div>

          <div>
            <h1 className="text-sm font-semibold text-white">
              Microservice
            </h1>

            <p className="text-xs text-slate-500">
              Dependency Analysis
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Monitoring
        </p>

        {navigationItems.map((item) => {
          const Icon = item.icon
          const isActive = currentPage === item.id

          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition ${
                isActive
                  ? "bg-blue-600/15 text-blue-400"
                  : "text-slate-400 hover:bg-slate-900 hover:text-white"
              }`}
            >
              <Icon size={18} />

              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      {/* Bottom */}
      <div className="border-t border-slate-800 p-3">
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-sm text-slate-400 hover:bg-slate-900 hover:text-white">
          <Settings size={18} />
          Settings
        </button>

        <div className="mt-3 rounded-lg bg-emerald-500/10 px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-400" />

            <span className="text-xs font-medium text-emerald-400">
              System Operational
            </span>
          </div>
        </div>
      </div>
    </aside>
  )
}