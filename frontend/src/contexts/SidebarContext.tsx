import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

interface SidebarContextType {
  collapsed: boolean
  toggle: () => void
  setCollapsed: (collapsed: boolean) => void
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined)

const STORAGE_KEY = 'sidebar-collapsed'

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try {
      // On small screens, default to collapsed
      if (typeof window !== 'undefined' && window.innerWidth < 1024) {
        return true
      }
      return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })

  // Update CSS variable so dialogs/overlays know the current sidebar width
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--sidebar-width',
      collapsed ? '0rem' : '16rem'
    )
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed))
    } catch {}
  }, [collapsed])

  // Auto-collapse on resize to small screen, auto-expand on resize to large
  useEffect(() => {
    let lastIsSmall = window.innerWidth < 1024
    const handleResize = () => {
      const isSmall = window.innerWidth < 1024
      if (isSmall !== lastIsSmall) {
        lastIsSmall = isSmall
        if (isSmall) {
          setCollapsedState(true)
        } else {
          // Restore user preference when going back to large
          try {
            const saved = localStorage.getItem(STORAGE_KEY)
            setCollapsedState(saved === 'true')
          } catch {
            setCollapsedState(false)
          }
        }
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const toggle = () => setCollapsedState(prev => !prev)
  const setCollapsed = (val: boolean) => setCollapsedState(val)

  return (
    <SidebarContext.Provider value={{ collapsed, toggle, setCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const ctx = useContext(SidebarContext)
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider')
  return ctx
}
