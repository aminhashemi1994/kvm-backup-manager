import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { useCreateHypervisor } from '@/hooks/useHypervisors'

interface AddHypervisorDialogProps {
  backupHostId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AddHypervisorDialog({ backupHostId, open, onOpenChange }: AddHypervisorDialogProps) {
  const [formData, setFormData] = useState({
    name: '',
    ip: '',
    port: 22,
    username: 'root',
  })

  const createHypervisor = useCreateHypervisor()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    await createHypervisor.mutateAsync({
      ...formData,
      backupHostId,
    })
    
    setFormData({
      name: '',
      ip: '',
      port: 22,
      username: 'root',
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Hypervisor</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
              <strong>Important:</strong> SSH keys must be configured manually on the backup host server.
              Ensure passwordless SSH access is set up before adding the hypervisor.
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                placeholder="KVM Host 1"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ip">IP Address *</Label>
                <Input
                  id="ip"
                  placeholder="192.168.1.10"
                  value={formData.ip}
                  onChange={(e) => setFormData({ ...formData, ip: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">SSH Port</Label>
                <Input
                  id="port"
                  type="number"
                  value={formData.port}
                  onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) || 22 })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              />
              <p className="text-xs text-gray-500">
                SSH user for connecting to the hypervisor
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createHypervisor.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createHypervisor.isPending}>
              {createHypervisor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Hypervisor
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
