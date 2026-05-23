import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

const Dialog: React.FC<DialogProps> = ({ open, onOpenChange, children }) => {
  // Hooks must always be called — guard inside the effect, not before
  React.useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  // Close on Escape
  React.useEffect(() => {
    if (!open) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange?.(false)
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [open, onOpenChange])

  if (!open) return null

  // RENDER VIA PORTAL TO document.body
  // This guarantees the dialog escapes ANY parent container (overflow, transform,
  // backdrop-filter, etc.) that would otherwise clip it.
  const dialogContent = (
    <DialogScrollContainer onClick={() => onOpenChange?.(false)}>
      {/* Backdrop — only covers the main content area */}
      <div className="dialog-overlay-backdrop" aria-hidden="true" />

      {/* Centering wrapper */}
      <div className="flex min-h-full items-start justify-center py-[5vh] px-4">
        {children}
      </div>
    </DialogScrollContainer>
  )

  return createPortal(dialogContent, document.body)
}

/**
 * Internal scroll container for the dialog overlay.
 * The container starts at scroll 0 naturally on mount (since it's a fresh
 * DOM element from the portal). We do NOT manually reset scroll on any
 * effect — that caused jumps on re-renders inside the dialog.
 */
const DialogScrollContainer: React.FC<{
  children: React.ReactNode
  onClick?: () => void
}> = ({ children, onClick }) => {
  return (
    <div
      className="dialog-overlay"
      onClick={onClick}
      role="dialog"
      aria-modal="true"
    >
      {children}
    </div>
  )
}

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "relative z-[10000] bg-white dark:bg-gray-900 p-6 rounded-2xl w-full max-w-lg",
      "border border-gray-200/60 dark:border-gray-700/50",
      "shadow-[0_20px_60px_-10px_rgba(0,0,0,0.15),0_8px_20px_-8px_rgba(0,0,0,0.1)]",
      className
    )}
    onClick={(e) => e.stopPropagation()}
    {...props}
  >
    {children}
  </div>
))
DialogContent.displayName = "DialogContent"

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-center sm:text-left mb-5", className)}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn("text-xl font-semibold leading-none tracking-tight", className)}
    {...props}
  />
))
DialogTitle.displayName = "DialogTitle"

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = "DialogDescription"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6 pt-4 border-t border-gray-100 dark:border-gray-800", className)}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogClose = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "absolute right-4 top-4 rounded-xl p-1.5 opacity-60 transition-all duration-200 hover:opacity-100 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none",
      className
    )}
    {...props}
  >
    <X className="h-4 w-4" />
    <span className="sr-only">Close</span>
  </button>
))
DialogClose.displayName = "DialogClose"

export {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
}
