import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { toast as sonnerToast } from 'sonner'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
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
    case 'skipped':
      return 'text-orange-600 bg-orange-100'
    case 'pending':
    case 'warning':
      return 'text-yellow-600 bg-yellow-100'
    default:
      return 'text-gray-600 bg-gray-100'
  }
}
