import AgentList from '@/components/agents/AgentList'

export default function AgentsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Backup Agents</h1>
        <p className="text-gray-600 mt-2">
          Manage backup agents running on your backup hosts
        </p>
      </div>

      <AgentList />
    </div>
  )
}
