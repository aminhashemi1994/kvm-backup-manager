import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { useUpdateHypervisor } from '@/hooks/useHypervisors'
import type { Hypervisor } from '@/types'

interface EditHypervisorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hypervisor: Hypervisor
}

export default function EditHypervisorDialog({ open, onOpenChange, hypervisor }: EditHypervisorDialogProps) {
  const [name, setName] = useState(hypervisor.name)
  const [ip, setIp] = useState(hypervisor.ip)
  const [port, setPort] = useState(hypervisor.port?.toString() || '22')
  const [username, setUsername] = useState(hypervisor.username || 'root')
  
  const updateHypervisor = useUpdateHypervisor()

  useEffect(() => {
    if (open) {
      setName(hypervisor.name)
      setIp(hypervisor.ip)
      setPort(hypervisor.port?.toString() || '22')
      setUsername(hypervisor.username || 'root')
    }
  }, [open, hypervisor])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    try {
      await updateHypervisor.mutateAsync({
        id: hypervisor.id,
        data: { 
          name, 
          ip, 
          port: parseInt(port), 
          username 
        }
      })
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to update hypervisor:', error)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Hypervisor</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="HV-01"
              required
            />
          </div>

          <div>
            <Label htmlFor="ip">IP Address</Label>
            <Input
              id="ip"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.50"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="port">SSH Port</Label>
              <Input
                id="port"
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
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
          </div>

          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateHypervisor.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateHypervisor.isPending}>
              {updateHypervisor.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
