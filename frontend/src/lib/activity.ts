/**
 * User-activity tracking for idle-session handling.
 *
 * We treat a session as "in use" only when there is real user interaction
 * (mouse, keyboard, touch, scroll). Background polling (health checks, job
 * status refetches) does NOT count as activity, so an unattended tab will
 * still go idle and log out after the configured window.
 *
 * The last-activity timestamp is stored in localStorage so all tabs of the
 * same session share one idle clock.
 */

const ACTIVITY_KEY = 'lastActivityAt'

// Logout after this much inactivity (no user interaction).
export const IDLE_LIMIT_MS = 30 * 60 * 1000 // 30 minutes

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'mousedown',
  'mousemove',
  'keydown',
  'scroll',
  'touchstart',
  'click',
]

let initialized = false
let lastWrite = 0

/** Record that the user just interacted (throttled to once every 5s). */
export function recordActivity(): void {
  const now = Date.now()
  if (now - lastWrite > 5000) {
    lastWrite = now
    try {
      localStorage.setItem(ACTIVITY_KEY, String(now))
    } catch {
      /* localStorage may be unavailable; ignore */
    }
  }
}

/** Epoch ms of the last recorded user activity (0 if never). */
export function getLastActivity(): number {
  const v = parseInt(localStorage.getItem(ACTIVITY_KEY) || '0', 10)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** True if the user has interacted within the given window. */
export function isUserActive(windowMs: number = IDLE_LIMIT_MS): boolean {
  const last = getLastActivity()
  if (!last) return false
  return Date.now() - last <= windowMs
}

/** Attach global listeners once. Safe to call multiple times. */
export function initActivityTracking(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  recordActivity() // seed so a fresh login counts as active immediately
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, recordActivity, { passive: true })
  }
}

/** Clear the stored activity timestamp (e.g. on logout). */
export function clearActivity(): void {
  try {
    localStorage.removeItem(ACTIVITY_KEY)
  } catch {
    /* ignore */
  }
  lastWrite = 0
}
