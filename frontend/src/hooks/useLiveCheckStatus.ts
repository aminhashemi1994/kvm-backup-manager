import { useEffect, useRef, useState } from 'react'
import socketService from '@/services/socket'

const CHECK_TIMEOUT_MS = 10000

// Module-level registry of in-flight "checking" timers, keyed by `${event}:${id}`.
//
// The timers live here, rather than only inside the React `useEffect` cleanup,
// so the 10s safety-net survives:
//   - React Strict Mode's mount → unmount → remount cycle in development, which
//     would otherwise cancel the timer mid-flight and leave the "Connecting"
//     badge stuck on `true` until a matching socket event happened to arrive.
//   - Background refetches / parent re-renders that re-emit `checking: true`
//     for already-known rows and would re-trigger the effect.
//
// Either case would make the row appear to be "connecting" forever when the
// controller's probe took too long or the socket event was missed. With the
// timers parked in this registry, they fire after exactly `CHECK_TIMEOUT_MS`
// regardless of what React does, which is what the UI wants: connect
// immediately, and if it hasn't resolved in 10s, give up and show whatever
// status is already known (which for an unreachable host is "unavailable").
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function armCheckTimer(key: string, onExpire: () => void) {
  const existing = activeTimers.get(key)
  if (existing) clearTimeout(existing)
  const t = setTimeout(() => {
    activeTimers.delete(key)
    onExpire()
  }, CHECK_TIMEOUT_MS)
  activeTimers.set(key, t)
}

function disarmCheckTimer(key: string) {
  const t = activeTimers.get(key)
  if (t) {
    clearTimeout(t)
    activeTimers.delete(key)
  }
}

/**
 * Drives the "connecting..." → resolved/unavailable transition for a single
 * backup host / hypervisor / offsite host row on the Backup Hosts tab.
 *
 * The list endpoints respond immediately with whatever is already known, and
 * mark freshly loaded rows `checking: true` while the controller probes them
 * in the background (see routes/backupHosts.js, routes/hypervisors.js,
 * routes/offsiteHosts.js). This hook owns the visible "connecting" window:
 * it clears the moment a matching status-updated socket event arrives for
 * `id`, and falls back to clearing itself after CHECK_TIMEOUT_MS so a probe
 * that never reports back (crashed agent, dropped socket) doesn't spin
 * forever — the row then just shows whatever status it already has, which
 * for a genuinely unreachable host is already "offline"/"error"/"unavailable".
 */
export function useLiveCheckStatus(id: string, initiallyChecking: boolean | undefined, event: string): boolean {
  const [isChecking, setIsChecking] = useState(!!initiallyChecking)
  // Only (re)arm the 10s window once per id; subsequent renders / refetches
  // for the same id shouldn't restart the spinner.
  const startedFor = useRef<string | null>(null)

  useEffect(() => {
    const key = `${event}:${id}`

    if (initiallyChecking && startedFor.current !== id) {
      startedFor.current = id
      setIsChecking(true)
      armCheckTimer(key, () => setIsChecking(false))
    }

    const cleanup = socketService.on(event, (data: any) => {
      const matchesId = data?.hypervisorId === id || data?.offsiteHostId === id || data?.backupHostId === id
      if (matchesId) {
        disarmCheckTimer(key)
        setIsChecking(false)
      }
    })

    return () => {
      cleanup()
      // Intentionally NOT clearing the timer — see activeTimers comment.
    }
  }, [id, initiallyChecking, event])

  return isChecking
}

/**
 * Same idea as {@link useLiveCheckStatus}, but for a whole list rendered in
 * a single `.map()` (e.g. offsite hosts under a backup host) where calling a
 * hook per row would call hooks inside a loop. Returns the set of ids
 * currently "checking" so the caller can test `checkingIds.has(item.id)`
 * per row instead.
 */
export function useLiveCheckStatusMap<T extends { id: string; checking?: boolean }>(
  items: T[] | undefined,
  event: string
): Set<string> {
  const [checkingIds, setCheckingIds] = useState<Set<string>>(() => {
    const s = new Set<string>()
    items?.forEach(i => { if (i.checking) s.add(i.id) })
    return s
  })
  const startedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!items) return

    items.forEach(item => {
      if (item.checking && !startedRef.current.has(item.id)) {
        startedRef.current.add(item.id)
        setCheckingIds(prev => {
          const next = new Set(prev)
          next.add(item.id)
          return next
        })
        const key = `${event}:${item.id}`
        armCheckTimer(key, () => {
          setCheckingIds(prev => {
            if (!prev.has(item.id)) return prev
            const next = new Set(prev)
            next.delete(item.id)
            return next
          })
        })
      }
    })

    const cleanup = socketService.on(event, (data: any) => {
      const id = data?.hypervisorId ?? data?.offsiteHostId ?? data?.backupHostId
      if (!id) return
      disarmCheckTimer(`${event}:${id}`)
      setCheckingIds(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })

    return () => {
      cleanup()
      // Intentionally NOT clearing the timers — see activeTimers comment.
    }
  }, [items, event])

  return checkingIds
}