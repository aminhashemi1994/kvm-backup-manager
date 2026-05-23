import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCreateBackupHost } from '@/hooks/useBackupHosts'
import { Loader2 } from 'lucide-react'

interface AddBackupHostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AddBackupHostDialog({ open, onOpenChange }: AddBackupHostDialogProps) {
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    description: '',
    maxConcurrentBackups: 2,
  })

  const createHost = useCreateBackupHost()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Ensure URL has protocol
    let url = formData.url.trim()
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url
    }
    
    await createHost.mutateAsync({
      ...formData,
      url,
    })
    
    setFormData({ name: '', url: '', description: '', maxConcurrentBackups: 2 })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Backup Host</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Host Name *</Label>
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
                placeholder="192.168.1.100:3001"
                value={formData.url}
                onChange={(e) => setFormData({ ...formData, url: e.target.value })}
                required
              />
              <p className="text-xs text-gray-500">
                IP and port of the agent backend (http:// will be added automatically)
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

            <div className="space-y-2">
              <Label htmlFor="maxConcurrentBackups">Max Concurrent Backups</Label>
              <Input
                id="maxConcurrentBackups"
                type="number"
                min="1"
                max="10"
                placeholder="2"
                value={formData.maxConcurrentBackups}
                onChange={(e) => setFormData({ ...formData, maxConcurrentBackups: parseInt(e.target.value) || 2 })}
              />
              <p className="text-xs text-gray-500">
                Maximum number of backups that can run simultaneously on this host (default: 2)
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createHost.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createHost.isPending}>
              {createHost.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Backup Host
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
