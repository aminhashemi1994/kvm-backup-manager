import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, RefreshCw, Loader2 } from 'lucide-react'
import AgentHealthStatus from './AgentHealthStatus'
import AddAgentDialog from './AddAgentDialog'
import { useAgents, useDeleteAgent, useHealthCheckAgent } from '@/hooks/useAgents'
import { formatDate } from '@/lib/utils'
import { toast } from 'sonner'

export default function AgentList() {
  const [showAddDialog, setShowAddDialog] = useState(false)
  const { data: agents, isLoading } = useAgents()
  const deleteAgent = useDeleteAgent()
  const healthCheck = useHealthCheckAgent()

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete agent "${name}"?`)) {
      await deleteAgent.mutateAsync(id)
    }
  }

  const handleHealthCheck = async (id: string) => {
    await healthCheck.mutateAsync(id)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Backup Agents</CardTitle>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Agent
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : agents && agents.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Check</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell className="font-mono text-sm">{agent.url}</TableCell>
                    <TableCell>
                      <AgentHealthStatus
                        status={agent.status}
                        lastCheck={agent.lastHealthCheck}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {formatDate(agent.lastHealthCheck)}
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {formatDate(agent.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleHealthCheck(agent.id)}
                          disabled={healthCheck.isPending}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(agent.id, agent.name)}
                          disabled={deleteAgent.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No agents found</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Agent
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AddAgentDialog open={showAddDialog} onOpenChange={setShowAddDialog} />
    </>
  )
}
