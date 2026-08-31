import { parseVmName } from '@/lib/utils'

interface VmNameCellProps {
  vmName: string | null | undefined
  /** When true, show the full raw name instead of the parsed title. */
  showFull?: boolean
  /** Optional secondary line (e.g. hypervisor name) shown below the uuid. */
  subtitle?: string | null
  /** Max width of the truncated content. Defaults to 280px. */
  maxWidthClass?: string
}

/**
 * Renders a VM name in a fixed-width, truncated box so action columns never
 * get pushed off-screen. By default it shows the readable title (the part
 * after the first underscore) as the primary line and the id prefix as a
 * small muted line below. In "full" mode it shows the raw name.
 *
 * The full name is always available via the native hover tooltip.
 */
export default function VmNameCell({
  vmName,
  showFull = false,
  subtitle,
  maxWidthClass = 'max-w-[380px]',
}: VmNameCellProps) {
  const { uuid, title, full } = parseVmName(vmName)

  if (showFull) {
    return (
      <div className={`truncate ${maxWidthClass}`} title={full}>
        {full || '-'}
      </div>
    )
  }

  return (
    <div className={maxWidthClass}>
      {/* Wrap up to two lines and ellipsise at the column edge instead of
          cutting a long VM name off mid-word on a single line. A short name
          still renders as a single line, so this only kicks in when the
          column is too narrow. The full name is on hover. */}
      <div className="font-medium line-clamp-2 break-all" title={full}>
        {title || '-'}
      </div>
      {uuid && (
        <div className="truncate text-xs text-gray-400 font-mono" title={full}>
          {uuid}
        </div>
      )}
      {subtitle && (
        <div className="truncate text-xs text-gray-400" title={subtitle}>
          {subtitle}
        </div>
      )}
    </div>
  )
}
