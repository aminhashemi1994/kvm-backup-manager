import { useQuery } from '@tanstack/react-query'
import { versionApi } from '@/services/api'

export interface AppVersion {
  version: string
  name: string
  license: string
  service: string
}

/**
 * The panel's version, from the controller.
 *
 * Every place that shows a version reads it here. They used to each carry
 * their own literal, which is how the sidebar and Settings ended up
 * disagreeing with each other and with the backend.
 *
 * Cached for the session: it cannot change without the controller restarting,
 * and a restart reloads the page anyway.
 */
export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: async () => {
      const res = await versionApi.get()
      return res.data.data as AppVersion
    },
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
