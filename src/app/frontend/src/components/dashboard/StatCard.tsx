import type { LucideIcon } from "lucide-react"

interface StatCardProps {
  title: string
  value: string | number
  description: string
  icon: LucideIcon
  iconColor: string
}

export default function StatCard({
  title,
  value,
  description,
  icon: Icon,
  iconColor,
}: StatCardProps) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">
            {title}
          </p>

          <p className="mt-2 text-3xl font-bold text-white">
            {value}
          </p>

          <p className="mt-1 text-xs text-slate-500">
            {description}
          </p>
        </div>

        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconColor}`}
        >
          <Icon size={20} />
        </div>
      </div>
    </div>
  )
}