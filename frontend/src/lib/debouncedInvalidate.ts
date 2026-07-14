import type { QueryClient } from '@tanstack/react-query'

const timers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Invalidate a query key at most once per `delay` ms, coalescing bursts.
 * When many jobs emit socket events at once (10+ backups starting), naive
 * per-event invalidation triggers a refetch storm — each /backups request
 * also runs a server-side agent sync — which is what made the panel laggy
 * under load. One trailing-edge invalidation per window is enough.
 */
export function debouncedInvalidate(
  queryClient: QueryClient,
  queryKey: (string | object)[],
  delay = 1500
) {
  const key = JSON.stringify(queryKey)
  if (timers.has(key)) return
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      queryClient.invalidateQueries({ queryKey })
    }, delay)
  )
}
