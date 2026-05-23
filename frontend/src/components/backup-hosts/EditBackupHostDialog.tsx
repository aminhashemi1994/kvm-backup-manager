import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Loader2 } from 'lucide-react'
import { useUpdateBackupHost } from '@/hooks/useBackupHosts'
import type { BackupHost } from '@/types'

interface EditBackupHostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  backupHost: BackupHost
}

export default function EditBackupHostDialog({ open, onOpenChange, backupHost }: EditBackupHostDialogProps) {
  const [name, setName] = useState(backupHost.name)
  const [url, setUrl] = useState(backupHost.url)
  const [description, setDescription] = useState(backupHost.description || '')
  const [maxConcurrentBackups, setMaxConcurrentBackups] = useState(backupHost.maxConcurrentBackups || 2)
  
  const updateHost = useUpdateBackupHost()

  useEffect(() => {
    if (open) {
      setName(backupHost.name)
      setUrl(backupHost.url)
      setDescription(backupHost.description || '')
      setMaxConcurrentBackups(backupHost.maxConcurrentBackups || 2)
    }
  }, [open, backupHost])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    try {
      await updateHost.mutateAsync({
        id: backupHost.id,
        data: { name, url, description, maxConcurrentBackups }
      })
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to update backup host:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Backup Host</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Backup Server 1"
              required
            />
          </div>

          <div>
            <Label htmlFor="url">URL</Label>
            <Input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://192.168.1.100:3001"
              required
            />
            <p className="text-xs text-gray-500 mt-1">
              Agent backend URL (e.g., http://192.168.1.100:3001)
            </p>
          </div>

          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Primary backup server"
              rows={3}
            />
          </div>

          <div>
            <Label htmlFor="maxConcurrentBackups">Max Concurrent Backups</Label>
            <Input
              id="maxConcurrentBackups"
              type="number"
              min="1"
              max="10"
              value={maxConcurrentBackups}
              onChange={(e) => setMaxConcurrentBackups(parseInt(e.target.value) || 2)}
            />
            <p className="text-xs text-gray-500 mt-1">
              Maximum number of backups that can run simultaneously on this host
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
