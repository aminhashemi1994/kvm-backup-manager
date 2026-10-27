import { useEffect, useState } from 'react'
import axios from 'axios'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Database, Loader2, AlertCircle, ShieldCheck } from 'lucide-react'
import { toast } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors'

const apiEndpointBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [setupToken, setSetupToken] = useState('')
  // null = still checking whether the initial admin must be created
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { login } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    axios
      .get(`${apiEndpointBase}/auth/setup-status`)
      .then((res) => setNeedsSetup(!!res.data?.needsSetup))
      .catch(() => setNeedsSetup(false))
  }, [])

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsLoading(true)
    try {
      await axios.post(`${apiEndpointBase}/auth/setup`, { username, password, setupToken })
      toast.success('Administrator account created', { duration: 3000 })
      if (await login(username, password)) {
        navigate('/dashboard')
      } else {
        setNeedsSetup(false)
      }
    } catch (error: any) {
      if (error?.response?.status === 409) {
        // Someone else finished setup first: fall back to normal sign-in
        setNeedsSetup(false)
        setPassword('')
        setConfirmPassword('')
      }
      setError(getErrorMessage(error, 'Failed to create the administrator account.'))
    } finally {
      setIsLoading(false)
    }
  }

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
      const errorMessage = getErrorMessage(error, 'An error occurred during login. Please try again.')
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
              {needsSetup
                ? 'Welcome! Create the administrator account to get started'
                : 'Sign in to manage your backup infrastructure'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {needsSetup === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
            <form onSubmit={needsSetup ? handleSetup : handleSubmit} className="space-y-4">
              {needsSetup && (
                <Alert>
                  <ShieldCheck className="h-4 w-4" />
                  <AlertDescription>
                    <span className="font-medium">First-time setup.</span> No user account exists yet and
                    there is no default password. Choose the username and password for the administrator
                    account; you will use them to sign in from now on.
                  </AlertDescription>
                </Alert>
              )}
              {needsSetup && (
                <div className="space-y-2">
                  <Label htmlFor="setupToken">Setup Token</Label>
                  <Input
                    id="setupToken"
                    type="text"
                    placeholder="Paste the token from the controller log"
                    autoComplete="off"
                    spellCheck={false}
                    value={setupToken}
                    onChange={(e) => {
                      setSetupToken(e.target.value)
                      setError(null)
                    }}
                    required
                    disabled={isLoading}
                    className={`font-mono ${error ? 'border-red-500 focus:border-red-500' : ''}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Proves you operate this server. It is printed in the controller log at startup and
                    stored in <code className="font-mono">controller-backend/data/setup-token</code>.
                  </p>
                </div>
              )}
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
                  placeholder={needsSetup ? 'e.g. admin' : 'Username'}
                  autoComplete="username"
                  autoFocus
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
                  placeholder={needsSetup ? 'At least 8 characters' : '••••••••'}
                  autoComplete={needsSetup ? 'new-password' : 'current-password'}
                  minLength={needsSetup ? 8 : undefined}
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
              {needsSetup && (
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="Repeat the password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value)
                      setError(null)
                    }}
                    required
                    disabled={isLoading}
                    className={error ? 'border-red-500 focus:border-red-500' : ''}
                  />
                </div>
              )}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {needsSetup
                  ? (isLoading ? 'Creating Account...' : 'Create Administrator Account')
                  : (isLoading ? 'Signing In...' : 'Sign In')}
              </Button>
            </form>
            )}
          </CardContent>
        </Card>
        
        {/* Footer */}
        <div className="text-center text-xs text-gray-400">
          <p className="text-gray-500">
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
