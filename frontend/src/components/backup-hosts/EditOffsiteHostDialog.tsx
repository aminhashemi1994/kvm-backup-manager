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
  
  const updateHost = useUpdateOffsiteHost()

  useEffect(() => {
    if (open) {
      setName(offsiteHost.name)
      setIp(offsiteHost.ip)
      setUsername(offsiteHost.username || 'root')
    }
  }, [open, offsiteHost])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    try {
      await updateHost.mutateAsync({
        id: offsiteHost.id,
        data: { name, ip, username }
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
