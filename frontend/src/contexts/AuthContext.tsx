import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import axios from 'axios'

interface AuthContextType {
  isAuthenticated: boolean
  user: { username: string; role: string } | null
  login: (username: string, password: string) => Promise<boolean>
  logout: () => void
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>
  token: string | null
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

// Simple backend URL configuration
const apiEndpointBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [user, setUser] = useState<{ username: string; role: string } | null>(null)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    // Check if user is already logged in
    const storedToken = localStorage.getItem('authToken')
    const storedUser = localStorage.getItem('user')
    
    if (storedToken && storedUser) {
      setToken(storedToken)
      setUser(JSON.parse(storedUser))
      setIsAuthenticated(true)
      
      // Verify token is still valid
      verifyToken(storedToken)
    }
  }, [])

  const verifyToken = async (token: string) => {
    try {
      const apiEndpoint = `${apiEndpointBase}/auth/verify`
      const response = await axios.get(apiEndpoint, {
        headers: { Authorization: `Bearer ${token}` }
      })
      
      if (response.data.success) {
        setUser(response.data.user)
        setIsAuthenticated(true)
      } else {
        // Token invalid, logout
        logout()
      }
    } catch (error) {
      // Token invalid or expired, logout
      logout()
    }
  }

  const login = async (username: string, password: string): Promise<boolean> => {
    try {
      const apiEndpoint = `${apiEndpointBase}/auth/login`
      const response = await axios.post(apiEndpoint, {
        username,
        password
      })
      
      if (response.data.success) {
        const { token, user } = response.data
        
        setToken(token)
        setUser(user)
        setIsAuthenticated(true)
        
        localStorage.setItem('authToken', token)
        localStorage.setItem('user', JSON.stringify(user))
        
        return true
      }
      
      return false
    } catch (error) {
      console.error('Login error:', error)
      return false
    }
  }

  const changePassword = async (currentPassword: string, newPassword: string): Promise<boolean> => {
    if (!token) return false
    
    try {
      const apiEndpoint = `${apiEndpointBase}/auth/change-password`
      const response = await axios.post(
        apiEndpoint,
        { currentPassword, newPassword },
        { headers: { Authorization: `Bearer ${token}` } }
      )
      
      return response.data.success
    } catch (error: any) {
      console.error('Change password error:', error)
      return false
    }
  }

  const logout = () => {
    if (token) {
      // Notify backend of logout (optional)
      const apiEndpoint = `${apiEndpointBase}/auth/logout`
      axios.post(
        apiEndpoint,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(() => {
        // Ignore errors on logout
      })
    }
    
    setUser(null)
    setToken(null)
    setIsAuthenticated(false)
    localStorage.removeItem('authToken')
    localStorage.removeItem('user')
    localStorage.removeItem('userPassword') // Remove old client-side password
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, logout, changePassword, token }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
