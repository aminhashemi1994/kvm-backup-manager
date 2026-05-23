import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCreateAgent } from '@/hooks/useAgents'
import { Loader2 } from 'lucide-react'

interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AddAgentDialog({ open, onOpenChange }: AddAgentDialogProps) {
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    description: '',
  })

  const createAgent = useCreateAgent()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    await createAgent.mutateAsync(formData)
    
    // Reset form
    setFormData({ name: '', url: '', description: '' })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add New Agent</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Agent Name *</Label>
              <Input
                id="name"
                placeholder="Backup Server 1"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="url">Agent URL *</Label>
              <Input
                id="url"
                type="url"
                placeholder="http://192.168.1.100:3001"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                required
              />
              <p className="text-xs text-gray-500">
                URL of the agent backend (e.g., http://192.168.1.100:3001)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Primary backup server in datacenter A"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createAgent.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createAgent.isPending}>
              {createAgent.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
