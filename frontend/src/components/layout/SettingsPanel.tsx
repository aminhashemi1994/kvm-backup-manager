import { useState } from 'react'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Moon, Sun, Bell, Rocket, Lock, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'

export default function SettingsPanel() {
  const { theme, toggleTheme } = useTheme()
  const { changePassword } = useAuth()
  
  // Rocket.Chat settings
  const [rocketChatUrl, setRocketChatUrl] = useState(
    localStorage.getItem('rocketChatUrl') || ''
  )
  const [rocketChatToken, setRocketChatToken] = useState(
    localStorage.getItem('rocketChatToken') || ''
  )
  const [rocketChatUserId, setRocketChatUserId] = useState(
    localStorage.getItem('rocketChatUserId') || ''
  )
  const [rocketChatChannel, setRocketChatChannel] = useState(
    localStorage.getItem('rocketChatChannel') || ''
  )
  const [rocketChatEnabled, setRocketChatEnabled] = useState(
    localStorage.getItem('rocketChatEnabled') === 'true'
  )

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)

  const handleSaveRocketChat = () => {
    localStorage.setItem('rocketChatUrl', rocketChatUrl)
    localStorage.setItem('rocketChatToken', rocketChatToken)
    localStorage.setItem('rocketChatUserId', rocketChatUserId)
    localStorage.setItem('rocketChatChannel', rocketChatChannel)
    localStorage.setItem('rocketChatEnabled', rocketChatEnabled.toString())
    toast.success('Rocket.Chat settings saved')
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validate inputs
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error('All fields are required')
      return
    }

    if (newPassword.length < 6) {
      toast.error('New password must be at least 6 characters')
      return
    }

    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match')
      return
    }

    // Attempt to change password
    const success = await changePassword(currentPassword, newPassword)

    if (success) {
      toast.success('Password changed successfully')
      // Clear form
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } else {
      toast.error('Current password is incorrect')
    }
  }

  return (
    <div className="w-96 bg-white dark:bg-gray-800 border-l shadow-lg flex flex-col h-full">
      <div className="p-4 border-b">
        <h2 className="font-semibold text-lg">Settings</h2>
      </div>

      <ScrollArea className="flex-1">
        <Tabs defaultValue="appearance" className="p-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
          </TabsList>

          <TabsContent value="appearance" className="space-y-4 mt-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Theme</Label>
                  <p className="text-sm text-gray-500">
                    Switch between light and dark mode
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleTheme}
                >
                  {theme === 'light' ? (
                    <Moon className="h-4 w-4" />
                  ) : (
                    <Sun className="h-4 w-4" />
                  )}
                </Button>
              </div>

              <div className="pt-4 border-t">
                <p className="text-sm font-medium mb-2">Current Theme</p>
                <p className="text-sm text-gray-500 capitalize">{theme} mode</p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="security" className="space-y-4 mt-4">
            <div className="space-y-4">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  Change Password
                </Label>
                <p className="text-sm text-gray-500">
                  Update your account password
                </p>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-4 pt-4 border-t">
                <div className="space-y-2">
                  <Label htmlFor="currentPassword">Current Password</Label>
                  <div className="relative">
                    <Input
                      id="currentPassword"
                      type={showCurrentPassword ? 'text' : 'password'}
                      placeholder="Enter current password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                    >
                      {showCurrentPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="newPassword">New Password</Label>
                  <div className="relative">
                    <Input
                      id="newPassword"
                      type={showNewPassword ? 'text' : 'password'}
                      placeholder="Enter new password (min 6 characters)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                    >
                      {showNewPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">
                    Password must be at least 6 characters long
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">Confirm New Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder="Confirm new password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <Button type="submit" className="w-full">
                  Change Password
                </Button>
              </form>

              <div className="pt-4 border-t">
                <p className="text-xs text-gray-500">
                  <strong>Note:</strong> After changing your password, you will need to use the new password on your next login.
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="notifications" className="space-y-4 mt-4">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-2">
                    <Rocket className="h-4 w-4" />
                    Rocket.Chat Integration
                  </Label>
                  <p className="text-sm text-gray-500">
                    Send notifications to Rocket.Chat
                  </p>
                </div>
                <Switch
                  checked={rocketChatEnabled}
                  onCheckedChange={setRocketChatEnabled}
                />
              </div>

              {rocketChatEnabled && (
                <div className="space-y-4 pt-4 border-t">
                  <div className="space-y-2">
                    <Label htmlFor="rocketChatUrl">Rocket.Chat URL</Label>
                    <Input
                      id="rocketChatUrl"
                      placeholder="https://chat.example.com"
                      value={rocketChatUrl}
                      onChange={(e) => setRocketChatUrl(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="rocketChatToken">Auth Token</Label>
                    <Input
                      id="rocketChatToken"
                      type="password"
                      placeholder="Your auth token"
                      value={rocketChatToken}
                      onChange={(e) => setRocketChatToken(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="rocketChatUserId">User ID</Label>
                    <Input
                      id="rocketChatUserId"
                      placeholder="Your user ID"
                      value={rocketChatUserId}
                      onChange={(e) => setRocketChatUserId(e.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="rocketChatChannel">Channel</Label>
                    <Input
                      id="rocketChatChannel"
                      placeholder="backup-notifications"
                      value={rocketChatChannel}
                      onChange={(e) => setRocketChatChannel(e.target.value)}
                    />
                  </div>

                  <Button onClick={handleSaveRocketChat} className="w-full">
                    Save Rocket.Chat Settings
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </ScrollArea>
    </div>
  )
}
