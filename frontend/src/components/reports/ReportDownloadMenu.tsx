import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2, FileText, FileSpreadsheet, FileJson, FileCode, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { reportsApi } from '@/services/api'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'

type Format = 'txt' | 'md' | 'xlsx' | 'json' | 'csv'
type Scope = 'global' | 'host' | 'vm' | 'hypervisor'

interface Props {
  scope: Scope
  scopeId?: string
  /** Label for the trigger button (e.g. "Download All Hosts" or "Download VM Report"). */
  label?: string
  /** Tailwind size class — defaults to small. */
  size?: 'sm' | 'default'
  variant?: 'default' | 'outline' | 'ghost'
  /** Override the formats offered. Defaults to txt/md/xlsx/json/csv. */
  formats?: Format[]
}

const FORMAT_LABELS: Record<Format, { label: string; icon: any }> = {
  txt: { label: 'Plain text (.txt)', icon: FileText },
  md: { label: 'Markdown (.md)', icon: FileCode },
  xlsx: { label: 'Excel (.xlsx)', icon: FileSpreadsheet },
  json: { label: 'JSON (.json)', icon: FileJson },
  csv: { label: 'CSV (.csv)', icon: FileSpreadsheet },
}

const MENU_WIDTH = 256

/**
 * Drop-in dropdown that re-generates the relevant agent reports first
 * and then downloads the result in the user's chosen format.
 *
 * The menu panel is rendered via React's createPortal directly on
 * document.body and positioned with `position: fixed` at the trigger
 * button's coordinates. This keeps it out of every parent's stacking
 * context — without it, a dropdown nested inside a Card row sits below
 * sibling cards and dialogs whose own z-index/transform/filter create
 * containing blocks.
 */
export default function ReportDownloadMenu({
  scope,
  scopeId,
  label = 'Download',
  size = 'sm',
  variant = 'outline',
  formats = ['txt', 'md', 'xlsx', 'json', 'csv'],
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<Format | null>(null)
  const [statusText, setStatusText] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const close = () => setOpen(false)

  // For non-global scopes the scopeId must resolve before the menu does
  // anything useful. We render the trigger anyway (so it's visible) but
  // disable it with a tooltip until the lookup completes.
  const disabledForMissingId = scope !== 'global' && !scopeId

  // Recompute the panel position whenever it opens, the window resizes,
  // or the page scrolls. We anchor to the trigger button's bounding rect
  // and right-align the panel under it. If the panel would clip off the
  // bottom of the viewport, flip it above the trigger instead.
  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const btn = triggerRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const panelHeight = menuRef.current?.offsetHeight || 240
      const spaceBelow = window.innerHeight - rect.bottom
      const top = spaceBelow > panelHeight + 16
        ? rect.bottom + 8
        : Math.max(8, rect.top - panelHeight - 8)
      const left = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, rect.right - MENU_WIDTH))
      setCoords({ top, left })
    }
    reposition()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleDownload = async (format: Format) => {
    if (busy || disabledForMissingId) return
    setBusy(format)
    setStatusText('Refreshing reports on agents…')
    setOpen(false)
    try {
      // Step 1 — regenerate (bypass rate-limit, all relevant hosts in parallel)
      try {
        const regen = await reportsApi.regenerate(scope, scopeId)
        const regenData = regen.data
        if (regenData && regenData.results) {
          const ok = regenData.results.filter((r: any) => r.status === 'ok' || r.status === 'in-progress').length
          const errs = regenData.results.filter((r: any) => r.status === 'error')
          if (errs.length > 0 && ok === 0) {
            throw new Error(errs.map((e: any) => `${e.hostName}: ${e.error}`).join('; '))
          }
          if (errs.length > 0) {
            toast.warning(`${errs.length} agent(s) could not regenerate; using last available data for those`)
          }
        }
      } catch (err: any) {
        const msg = err.response?.data?.error || err.message || 'Regeneration failed'
        toast.error(`Could not refresh reports: ${msg}. Downloading existing data instead.`)
      }

      // Step 2 — download
      setStatusText(`Building ${format.toUpperCase()} file…`)
      const response = await reportsApi.download(format, scope, scopeId)

      // Step 3 — turn it into a browser download
      const fileBaseName = `backup-report_${scope}${scopeId ? '_' + scopeId.substring(0, 8) : ''}_${new Date().toISOString().replace(/[:.]/g, '-')}`

      if (format === 'xlsx') {
        const env = response.data
        const sheets = env?.sheets || []
        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const ws = XLSX.utils.aoa_to_sheet(sheet.rows || [])
          XLSX.utils.book_append_sheet(wb, ws, (sheet.name || 'Sheet').substring(0, 31))
        }
        XLSX.writeFile(wb, `${fileBaseName}.xlsx`)
      } else {
        const blob = response.data instanceof Blob ? response.data : new Blob([response.data])
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${fileBaseName}.${format}`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      }

      toast.success(`Report downloaded (${format.toUpperCase()})`)
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || 'Download failed'
      toast.error(`Download failed: ${msg}`)
    } finally {
      setBusy(null)
      setStatusText('')
    }
  }

  const dropdown = open && !busy && coords ? createPortal(
    <div
      ref={menuRef}
      // Very high z-index so we float above dialogs (which use 50)
      // and any future overlays. The portal target is document.body so
      // no parent transform / filter / overflow:hidden can clip us.
      style={{
        position: 'fixed',
        top: coords.top,
        left: coords.left,
        width: MENU_WIDTH,
        zIndex: 9999,
      }}
      className="origin-top-right rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
        Reports will be regenerated before download
      </div>
      <ul className="py-1">
        {formats.map(fmt => {
          const meta = FORMAT_LABELS[fmt]
          const Icon = meta.icon
          return (
            <li key={fmt}>
              <button
                type="button"
                onClick={() => handleDownload(fmt)}
                className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <Icon className="h-4 w-4 text-gray-500" />
                {meta.label}
              </button>
            </li>
          )
        })}
      </ul>
    </div>,
    document.body
  ) : null

  return (
    <>
      <Button
        ref={triggerRef as any}
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen(o => !o)}
        disabled={!!busy || disabledForMissingId}
        title={disabledForMissingId ? 'Resolving target…' : (busy ? statusText : 'Download report')}
      >
        {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
        {busy ? statusText || 'Working…' : label}
        <ChevronDown className="h-4 w-4 ml-1" />
      </Button>
      {dropdown}
    </>
  )
}
