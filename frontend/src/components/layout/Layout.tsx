import { ReactNode, useEffect } from 'react'
import Sidebar from './Sidebar'
import Header from './Header'
import CommandPalette from './CommandPalette'
import { useSocket, useSocketEvent } from '@/hooks/useSocket'
import { useQueryClient } from '@tanstack/react-query'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { isConnected } = useSocket()
  const queryClient = useQueryClient()

  // Handle job-removed event from WebSocket
  useSocketEvent('job-removed', (data: any) => {
    console.log('Job removed event received:', data)
    
    // Remove the job from cache immediately
    queryClient.setQueriesData({ queryKey: ['backups'] }, (oldData: any) => {
      if (!oldData) return oldData
      
      const jobId = data.jobId
      
      if (oldData.data?.jobs) {
        return {
          ...oldData,
          data: {
            ...oldData.data,
            jobs: oldData.data.jobs.filter((job: any) => job.id !== jobId)
          }
        }
      } else if (Array.isArray(oldData.data)) {
        return {
          ...oldData,
          data: oldData.data.filter((job: any) => job.id !== jobId)
        }
      } else if (Array.isArray(oldData)) {
        return oldData.filter((job: any) => job.id !== jobId)
      }
      
      return oldData
    })
    
    queryClient.invalidateQueries({ queryKey: ['backups'] })
  })

  // Handle job-updated event (from agent sync)
  useSocketEvent('job-updated', () => {
    queryClient.invalidateQueries({ queryKey: ['backups'] })
  })

  useEffect(() => {
    // Socket is initialized in useSocket hook
  }, [])

  return (
    <div className="h-screen flex overflow-hidden bg-gradient-to-br from-gray-50 via-gray-100 to-blue-50/30 dark:from-gray-950 dark:via-gray-900 dark:to-blue-950/20">
      <Sidebar />
      
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Header />
        
        <main className="flex-1 overflow-y-auto overflow-x-auto p-4 sm:p-6">
          <div className="page-enter page-enter-active min-w-0">
            {children}
          </div>
        </main>
      </div>

      {/* Global command palette */}
      <CommandPalette />
    </div>
  )
}
