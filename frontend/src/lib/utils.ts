import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { toast as sonnerToast } from 'sonner'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a VM name of the form "<uuid>_<readable-name>" into its parts.
 * VM names in this system are prefixed with a generated id like
 * "20251229-153547887023267-58_office-database-1-net.part5.psg.network".
 * The portion after the FIRST underscore is the human-readable name.
 *
 * Returns:
 *   - uuid:  the id prefix (everything before the first "_"), or "" if none
 *   - title: the readable name (everything after the first "_"); falls back
 *            to the whole string if there is no underscore
 *   - full:  the original unmodified string
 */
export function parseVmName(vmName: string | null | undefined): {
  uuid: string
  title: string
  full: string
} {
  const full = vmName || ''
  const idx = full.indexOf('_')
  if (idx === -1) {
    return { uuid: '', title: full, full }
  }
  return {
    uuid: full.slice(0, idx),
    title: full.slice(idx + 1),
    full,
  }
}

// Toast wrapper to ensure all toasts have close button
const defaultToastOptions = {
  closeButton: true,
  dismissible: true,
}

export const toast = {
  success: (message: string, options?: any) => 
    sonnerToast.success(message, { ...defaultToastOptions, ...options }),
  error: (message: string, options?: any) => 
    sonnerToast.error(message, { ...defaultToastOptions, ...options }),
  info: (message: string, options?: any) => 
    sonnerToast.info(message, { ...defaultToastOptions, ...options }),
  warning: (message: string, options?: any) => 
    sonnerToast.warning(message, { ...defaultToastOptions, ...options }),
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

export function formatDuration(startTime: string, endTime?: string): string {
  const start = new Date(startTime)
  const end = endTime ? new Date(endTime) : new Date()
  const diff = Math.floor((end.getTime() - start.getTime()) / 1000)

  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleString()
}

/**
 * Short timestamp for dense tables: "08-18 22:34", or "22:34" when the date is
 * today. The full timestamp stays available via formatDate() in a tooltip.
 */
export function formatDateCompact(date: string | Date): string {
  const d = new Date(date)
  if (isNaN(d.getTime())) return '-'
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return sameDay ? time : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`
}

/**
 * One-letter job-type code for the narrow Type column. The full word is shown
 * on hover — a whole column of the words "BACKUP"/"RESTORE" repeated is a lot
 * of horizontal space for a value that is almost always the same.
 */
export function jobTypeCode(jobType?: string | null): { code: string; label: string; className: string } {
  switch ((jobType || 'backup').toLowerCase()) {
    case 'restore':
      return { code: 'R', label: 'Restore', className: 'bg-purple-50 text-purple-700 border-purple-200' }
    case 'rsync':
    case 'replication':
      return { code: 'S', label: 'Rsync', className: 'bg-teal-50 text-teal-700 border-teal-200' }
    case 'sync':
    case 'offsite':
      return { code: 'S', label: 'Sync (offsite replication)', className: 'bg-teal-50 text-teal-700 border-teal-200' }
    default:
      return { code: 'B', label: 'Backup', className: 'bg-blue-50 text-blue-700 border-blue-200' }
  }
}

/** One-letter schedule/method code, same reasoning as jobTypeCode(). */
export function methodCode(method?: string | null): { code: string; label: string } {
  const raw = (method || '').toLowerCase()
  const map: Record<string, string> = {
    daily: 'D',
    weekly: 'W',
    monthly: 'M',
    once: 'O',
    interval: 'I',
    cron: 'C',
    'custom-days': 'X',
    custom: 'X',
    manual: 'H',     // Hand-triggered: not a cadence, but the honest answer
                     // for a run nobody scheduled
    full: 'F',
    inc: 'N',        // iNcremental — I is taken by interval
    incremental: 'N',
    copy: 'P',
  }
  if (!raw) return { code: '-', label: 'Unknown' }
  const code = map[raw] || raw.charAt(0).toUpperCase()
  if (raw === 'custom-days') return { code, label: 'Custom' }
  return { code, label: raw.charAt(0).toUpperCase() + raw.slice(1) }
}

export function formatRelativeTime(date: string | Date): string {
  const now = new Date()
  const then = new Date(date)
  const diffMs = now.getTime() - then.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return formatDate(date)
}

export function getStatusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'online':
    case 'connected':
    case 'completed':
    case 'success':
      return 'text-green-600 bg-green-100'
    case 'offline':
    case 'disconnected':
    case 'failed':
    case 'error':
      return 'text-red-600 bg-red-100'
    case 'running':
    case 'in-progress':
    case 'queued':
      return 'text-blue-600 bg-blue-100'
    case 'retrying':
      return 'text-purple-600 bg-purple-100'
    case 'skipped':
    // An offsite sync that did nothing because another transfer held the VM's
    // lock. Retryable, but not a failure — so it must not read red.
    case 'busy':
      return 'text-orange-600 bg-orange-100'
    case 'cancelled':
      return 'text-gray-600 bg-gray-100'
    // The agent on that host predates independent replication.
    case 'unsupported':
      return 'text-orange-700 bg-orange-100'
    // Declined because the VM was already backing up — not a failure.
    case 'rejected':
      return 'text-amber-700 bg-amber-100'
    case 'pending':
    case 'warning':
      return 'text-yellow-600 bg-yellow-100'
    default:
      return 'text-gray-600 bg-gray-100'
  }
}
