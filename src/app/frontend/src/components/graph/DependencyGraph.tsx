import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react"

import { mockDependencies } from "../../mock/dependencies"
import { mockServices } from "../../mock/services"

import ServiceNode from "./ServiceNode"

const nodeTypes = {
  service: ServiceNode,
}

interface DependencyGraphProps {
  onServiceSelect: (serviceId: string) => void
}

function getNodePosition(index: number) {
  const positions = [
    { x: 50, y: 220 },
    { x: 360, y: 80 },
    { x: 360, y: 360 },
    { x: 700, y: 80 },
    { x: 700, y: 360 },
  ]

  return positions[index] ?? { x: 100, y: 100 }
}

const nodes: Node[] = mockServices.map((service, index) => ({
  id: service.id,

  type: "service",

  position: getNodePosition(index),

  data: {
    name: service.name,
    status: service.status,
    latency: service.latency,
    errorRate: service.errorRate,
  },
}))

const edges: Edge[] = mockDependencies.map((dependency) => ({
  id: dependency.id,

  source: dependency.source,

  target: dependency.target,

  type: "smoothstep",

  animated: true,

  style: {
    stroke: "#60a5fa",
    strokeWidth: 2,
  },

  label: `${dependency.latency} ms`,

  labelStyle: {
    fill: "#cbd5e1",
    fontSize: 10,
    fontWeight: 500,
  },

  labelBgStyle: {
    fill: "#0f172a",
    fillOpacity: 0.9,
  },

  labelBgPadding: [6, 3],

  labelBgBorderRadius: 4,
}))

export default function DependencyGraph({
  onServiceSelect,
}: DependencyGraphProps) {

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onServiceSelect(node.id)
  }

  return (
    <div className="h-[650px] overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{
          padding: 0.2,
        }}
        minZoom={0.4}
        maxZoom={1.8}
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        onNodeClick={handleNodeClick}
      >
        <Background
          gap={20}
          size={1}
          color="#1e293b"
        />

        <Controls />

        <MiniMap
          nodeColor={(node) => {
            const status = node.data?.status

            if (status === "critical") {
              return "#f87171"
            }

            if (status === "warning") {
              return "#fbbf24"
            }

            return "#34d399"
          }}
        />
      </ReactFlow>
    </div>
  )
}