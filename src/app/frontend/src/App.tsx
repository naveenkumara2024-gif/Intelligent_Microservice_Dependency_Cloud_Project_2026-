import { useState } from "react"

import Sidebar from "./components/layout/Sidebar"
import Header from "./components/layout/Header"

import Dashboard from "./pages/Dashboard"
import DependencyGraphPage from "./pages/DependencyGraphPage"
import Services from "./pages/Services"
import Incidents from "./pages/Incidents"
import RCA from "./pages/RCA"

const pageTitles: Record<string, string> = {
  dashboard: "Dashboard",
  graph: "Dependency Graph",
  services: "Services",
  incidents: "Incidents",
  rca: "Root Cause Analysis",
}

function App() {
  const [currentPage, setCurrentPage] = useState("dashboard")

  const renderPage = () => {
    switch (currentPage) {
      case "graph":
        return <DependencyGraphPage />

      case "services":
        return <Services />

      case "incidents":
        return <Incidents />

      case "rca":
        return <RCA />

      case "dashboard":
      default:
        return <Dashboard />
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950 text-white">
      
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        
        <Header
          pageTitle={pageTitles[currentPage]}
        />

        <main className="flex-1 overflow-y-auto p-6">
          {renderPage()}
        </main>

      </div>
    </div>
  )
}

export default App