import { createContext, useCallback, useContext, useRef, useState, ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertTriangle, Loader2 } from 'lucide-react'

/**
 * Promise-based confirmation dialog — a drop-in replacement for the native
 * window.confirm(). Instead of a browser alert, it renders a proper modal
 * (portal-based, theme-aware) and resolves to true/false.
 *
 * Usage:
 *   const confirm = useConfirm()
 *   const ok = await confirm({
 *     title: 'Delete schedule?',
 *     description: 'This cannot be undone.',
 *     confirmText: 'Delete',
 *     variant: 'danger',
 *   })
 *   if (!ok) return
 *
 * With input confirmation:
 *   const ok = await confirm({
 *     title: 'Delete all backups?',
 *     description: 'Type DELETE to confirm',
 *     requireInput: 'DELETE',
 *     variant: 'danger',
 *   })
 */

export interface ConfirmOptions {
  title: string
  description?: ReactNode
  /** Extra detail lines rendered as a bulleted list. */
  details?: string[]
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'danger'
  /** Require user to type this exact text to enable confirmation */
  requireInput?: string
  /** Custom input fields for the confirmation dialog */
  inputs?: Array<{
    id: string
    label: string
    type?: 'text' | 'number' | 'email'
    placeholder?: string
    required?: boolean
    defaultValue?: string
  }>
}

export interface ConfirmResult {
  confirmed: boolean
  inputs?: Record<string, string>
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts)
    setInputValue('')
    // Initialize input values with defaults
    if (opts.inputs) {
      const defaults: Record<string, string> = {}
      opts.inputs.forEach(input => {
        defaults[input.id] = input.defaultValue || ''
      })
      setInputValues(defaults)
    } else {
      setInputValues({})
    }
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const settle = (value: boolean) => {
    setOpen(false)
    setInputValue('')
    setInputValues({})
    // Defer clearing options until the close transition is done-ish so the
    // text doesn't flash empty.
    resolverRef.current?.(value)
    resolverRef.current = null
  }

  const variant = options?.variant || 'default'
  const canConfirm = options?.requireInput 
    ? inputValue.trim() === options.requireInput 
    : true

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={open} onOpenChange={(o) => { if (!o) settle(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {variant === 'danger' && <AlertTriangle className="h-5 w-5 text-red-600" />}
              {options?.title}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {options?.description && (
              <div className="text-sm text-gray-600 dark:text-gray-300">
                {options.description}
              </div>
            )}

            {options?.details && options.details.length > 0 && (
              <ul className="space-y-1 text-sm text-gray-500 dark:text-gray-400 list-disc list-inside">
                {options.details.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}

            {/* Required input confirmation */}
            {options?.requireInput && (
              <div className="space-y-2">
                <Label htmlFor="confirm-input" className="text-sm font-medium">
                  Type <code className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">
                    {options.requireInput}
                  </code> to confirm
                </Label>
                <Input
                  id="confirm-input"
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={options.requireInput}
                  autoComplete="off"
                  className="font-mono"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canConfirm) {
                      settle(true)
                    }
                  }}
                />
              </div>
            )}

            {/* Custom input fields */}
            {options?.inputs && options.inputs.length > 0 && (
              <div className="space-y-3">
                {options.inputs.map((input) => (
                  <div key={input.id} className="space-y-2">
                    <Label htmlFor={input.id} className="text-sm font-medium">
                      {input.label}
                      {input.required && <span className="text-red-500 ml-1">*</span>}
                    </Label>
                    <Input
                      id={input.id}
                      type={input.type || 'text'}
                      value={inputValues[input.id] || ''}
                      onChange={(e) => setInputValues(prev => ({
                        ...prev,
                        [input.id]: e.target.value
                      }))}
                      placeholder={input.placeholder}
                      required={input.required}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              {options?.cancelText || 'Cancel'}
            </Button>
            <Button
              variant={variant === 'danger' ? 'destructive' : 'default'}
              onClick={() => settle(true)}
              disabled={!canConfirm}
            >
              {options?.confirmText || 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    // Fallback so a component used outside the provider doesn't crash —
    // degrade to window.confirm. In practice the provider wraps the app.
    return async (opts: ConfirmOptions) => {
      if (opts.requireInput || opts.inputs) {
        console.warn('useConfirm: requireInput/inputs not supported in fallback mode')
      }
      return window.confirm(opts.title)
    }
  }
  return ctx
}

/** Loading button variant for in-flight confirm actions (optional helper). */
export function ConfirmSpinner() {
  return <Loader2 className="h-4 w-4 animate-spin" />
}
