import HypervisorList from '@/components/hypervisors/HypervisorList'

export default function HypervisorsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Hypervisors & Virtual Machines</h1>
        <p className="text-gray-600 mt-2">
          Manage hypervisor servers and their virtual machines
        </p>
      </div>

      <HypervisorList />
    </div>
  )
}
