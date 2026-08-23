import {
  Bell,
  CircleHelp,
  Search,
} from "lucide-react"

interface HeaderProps {
  pageTitle: string
}

export default function Header({ pageTitle }: HeaderProps) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950 px-6">
      
      {/* Page title */}
      <div>
        <h2 className="text-lg font-semibold text-white">
          {pageTitle}
        </h2>

        <p className="text-xs text-slate-500">
          Intelligent Microservice Dependency Analysis Framework
        </p>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-4">
        
        {/* Search */}
        <button className="rounded-lg p-2 text-slate-400 hover:bg-slate-900 hover:text-white">
          <Search size={19} />
        </button>

        {/* Help */}
        <button className="rounded-lg p-2 text-slate-400 hover:bg-slate-900 hover:text-white">
          <CircleHelp size={19} />
        </button>

        {/* Notifications */}
        <button className="relative rounded-lg p-2 text-slate-400 hover:bg-slate-900 hover:text-white">
          <Bell size={19} />

          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500" />
        </button>

        {/* User */}
        <div className="ml-2 flex items-center gap-3 border-l border-slate-800 pl-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-white">
            S
          </div>

          <div className="hidden sm:block">
            <p className="text-sm font-medium text-white">
              SRE User
            </p>

            <p className="text-xs text-slate-500">
              System Administrator
            </p>
          </div>
        </div>
      </div>
    </header>
  )
}