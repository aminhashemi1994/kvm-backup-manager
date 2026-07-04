import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { useUpdateOffsiteHost } from '@/hooks/useOffsiteHosts'
import type { OffsiteHost } from '@/types'

interface EditOffsiteHostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  offsiteHost: OffsiteHost
}

export default function EditOffsiteHostDialog({ open, onOpenChange, offsiteHost }: EditOffsiteHostDialogProps) {
  const [name, setName] = useState(offsiteHost.name)
  const [ip, setIp] = useState(offsiteHost.ip)
  const [username, setUsername] = useState(offsiteHost.username || 'root')
  const [backupPath, setBackupPath] = useState(offsiteHost.backupPath || '')
  
  const updateHost = useUpdateOffsiteHost()

  useEffect(() => {
    if (open) {
      setName(offsiteHost.name)
      setIp(offsiteHost.ip)
      setUsername(offsiteHost.username || 'root')
      setBackupPath(offsiteHost.backupPath || '')
    }
  }, [open, offsiteHost])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmedPath = backupPath.trim()
    if (trimmedPath && !trimmedPath.startsWith('/')) {
      alert('Backup path must be an absolute path (start with /)')
      return
    }

    try {
      await updateHost.mutateAsync({
        id: offsiteHost.id,
        data: { name, ip, username, backupPath: trimmedPath }
      })
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to update offsite host:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Offsite Host</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Offsite-1"
              required
            />
          </div>

          <div>
            <Label htmlFor="ip">IP Address</Label>
            <Input
              id="ip"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.2.100"
              required
            />
          </div>

          <div>
            <Label htmlFor="username">SSH Username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="root"
              required
            />
          </div>

          <div>
            <Label htmlFor="backupPath">Backup Path (optional)</Label>
            <Input
              id="backupPath"
              value={backupPath}
              onChange={(e) => setBackupPath(e.target.value)}
              placeholder="/mnt/offsite/backups"
            />
            <p className="text-xs text-gray-500 mt-1">
              Destination base directory on this offsite host. Backups replicate to
              <code className="mx-1">&lt;path&gt;/&lt;vm&gt;</code>. Leave empty to mirror the source
              storage-pool path (default).
            </p>
          </div>

          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateHost.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateHost.isPending}>
              {updateHost.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
