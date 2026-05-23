import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { healthCheckApi } from '@/services/api'

/**
 * useHealthCheckOnMount (Item 4)
 *
 * Triggers a server-side health check when the app first mounts (user opens
 * the panel). This ensures the displayed statuses are fresh rather than
 * showing stale data from the last periodic check.
 *
 * Only fires once per browser session and only when authenticated.
 */
export function useHealthCheckOnMount() {
  const triggered = useRef(false)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (triggered.current) return
    
    // Only trigger if we have an auth token (user is logged in)
    const token = localStorage.getItem('authToken')
    if (!token) return
    
    triggered.current = true

    // Fire-and-forget: trigger server-side health check
    healthCheckApi.trigger().then(() => {
      // After a short delay, invalidate host queries so the UI picks up fresh data
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
        queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
      }, 3000) // Give the server 3s to complete the check
    }).catch(() => {
      // Best-effort — don't block the UI
    })
  }, [queryClient])
}

/**
 * useHealthCheckStatus
 *
 * Returns the health-check service status (last check time, next check, etc.)
 * Useful for showing "last checked X seconds ago" in the UI.
 */
export function useHealthCheckStatus() {
  return {
    trigger: async () => {
      try {
        await healthCheckApi.trigger()
        return { success: true }
      } catch (e: any) {
        return { success: false, error: e.message }
      }
    },
    getStatus: async () => {
      try {
        const res = await healthCheckApi.getStatus()
        return res.data.data
      } catch {
        return null
      }
    },
  }
}
