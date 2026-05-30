import { useState } from 'react'
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

/**
 * Drop-in dropdown that re-generates the relevant agent reports first
 * and then downloads the result in the user's chosen format.
 *
 * Flow per click:
 *   1. POST /api/reports/regenerate  (bypasses agent rate-limit)
 *   2. GET  /api/reports/download/:format
 *   3. Trigger a browser download
 *
 * Steps 1 and 2 stream their state into a single inline status message so
 * users see "Refreshing reports…" → "Building file…" → "Downloaded".
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

  const close = () => setOpen(false)

  // For non-global scopes the scopeId must resolve before the menu does
  // anything useful. We render the trigger anyway (so it's visible) but
  // disable it with a tooltip until the lookup completes.
  const disabledForMissingId = scope !== 'global' && !scopeId

  const handleDownload = async (format: Format) => {
    if (busy || disabledForMissingId) return
    setBusy(format)
    setStatusText('Refreshing reports on agents…')
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
        // Don't bail out — we can still download whatever's already on disk.
        const msg = err.response?.data?.error || err.message || 'Regeneration failed'
        toast.error(`Could not refresh reports: ${msg}. Downloading existing data instead.`)
      }

      // Step 2 — download
      setStatusText(`Building ${format.toUpperCase()} file…`)
      const response = await reportsApi.download(format, scope, scopeId)

      // Step 3 — turn it into a browser download
      const fileBaseName = `backup-report_${scope}${scopeId ? '_' + scopeId.substring(0, 8) : ''}_${new Date().toISOString().replace(/[:.]/g, '-')}`

      if (format === 'xlsx') {
        // Server returns { sheets: [{ name, rows }, …] }; build with SheetJS.
        const env = response.data
        const sheets = env?.sheets || []
        const wb = XLSX.utils.book_new()
        for (const sheet of sheets) {
          const ws = XLSX.utils.aoa_to_sheet(sheet.rows || [])
          XLSX.utils.book_append_sheet(wb, ws, (sheet.name || 'Sheet').substring(0, 31))
        }
        XLSX.writeFile(wb, `${fileBaseName}.xlsx`)
      } else {
        // axios returned a Blob; create a download link
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
      close()
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || 'Download failed'
      toast.error(`Download failed: ${msg}`)
    } finally {
      setBusy(null)
      setStatusText('')
    }
  }

  return (
    <div className="relative inline-block text-left">
      <Button
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
      {open && !busy && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-0 mt-2 w-64 origin-top-right rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg z-20">
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
          </div>
        </>
      )}
    </div>
  )
}
