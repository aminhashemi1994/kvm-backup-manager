import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Database, Loader2, AlertCircle } from 'lucide-react'
import { toast } from '@/lib/utils'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null) // Clear previous errors

    try {
      const success = await login(username, password)
      
      if (success) {
        toast.success('Login successful', {
          duration: 3000,
        })
        navigate('/dashboard')
      } else {
        const errorMessage = 'Invalid username or password. Please check your credentials and try again.'
        setError(errorMessage)
        toast.error('Invalid username or password', {
          duration: 5000,
        })
      }
    } catch (error: any) {
      console.error('Login error:', error)
      const errorMessage = error.response?.data?.error || error.message || 'An error occurred during login. Please try again.'
      setError(errorMessage)
      toast.error('Login failed', {
        description: errorMessage,
        duration: 5000,
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 to-gray-800 p-4">
      <div className="w-full max-w-md space-y-4">
        <Card>
          <CardHeader className="space-y-4">
            <div className="flex justify-center">
              <div className="h-16 w-16 bg-blue-600 rounded-full flex items-center justify-center">
                <Database className="h-8 w-8 text-white" />
              </div>
            </div>
            <CardTitle className="text-2xl text-center">KVM Backup Manager</CardTitle>
            <CardDescription className="text-center">
              Sign in to manage your backup infrastructure
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value)
                    setError(null)
                  }}
                  required
                  disabled={isLoading}
                  className={error ? 'border-red-500 focus:border-red-500' : ''}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setError(null)
                  }}
                  required
                  disabled={isLoading}
                  className={error ? 'border-red-500 focus:border-red-500' : ''}
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isLoading ? 'Signing In...' : 'Sign In'}
              </Button>
            </form>
          </CardContent>
        </Card>
        
        {/* Footer with author credit */}
        <div className="text-center text-xs text-gray-400">
          <p>
            Built by{' '}
            <a
              href="https://www.linkedin.com/in/amin-hashemi-2955061bb"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 hover:underline transition-colors"
            >
              Mohammad Amin Hashemi
            </a>
          </p>
          <p className="mt-1 text-gray-500">
            Powered by{' '}
            <a
              href="https://github.com/abbbi/virtnbdbackup"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-300 transition-colors"
            >
              virtnbdbackup
            </a>
            {' '}• Open Source (MIT)
          </p>
        </div>
      </div>
    </div>
  )
}
