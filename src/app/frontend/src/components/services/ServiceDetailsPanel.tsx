import ServiceDetails from "../graph/ServiceDetails"

interface ServiceDetailsPanelProps {
  serviceId: string
  onClose: () => void
}

export default function ServiceDetailsPanel({
  serviceId,
  onClose,
}: ServiceDetailsPanelProps) {
  return (
    <div className="mt-6">
      <ServiceDetails
        serviceId={serviceId}
        onClose={onClose}
      />
    </div>
  )
}