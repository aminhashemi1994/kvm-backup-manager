import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { NotificationProvider } from './contexts/NotificationContext'
import { SidebarProvider } from './contexts/SidebarContext'
import Layout from './components/layout/Layout'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import BackupHostsPage from './pages/BackupHostsPage'
import SchedulesPage from './pages/SchedulesPage'
import ActiveBackupsPage from './pages/ActiveBackupsPage'
import HistoryPage from './pages/HistoryPage'
import Reports from './pages/Reports'
import Resources from './pages/Resources'
import BackupManagement from './pages/BackupManagement'
import StoragePoolsPage from './pages/StoragePoolsPage'
import CleanupPage from './pages/CleanupPage'
import SettingsPage from './pages/SettingsPage'
import { useHealthCheckOnMount } from './hooks/useHealthCheck'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

function AppRoutes() {
  const { isAuthenticated } = useAuth()
  
  // Item 4: Trigger a fresh health check when user opens the panel
  useHealthCheckOnMount()

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout>
              <Navigate to="/dashboard" replace />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/dashboard"
        element={
          <PrivateRoute>
            <Layout>
              <DashboardPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/backup-hosts"
        element={
          <PrivateRoute>
            <Layout>
              <BackupHostsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/schedules"
        element={
          <PrivateRoute>
            <Layout>
              <SchedulesPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/backups/active"
        element={
          <PrivateRoute>
            <Layout>
              <ActiveBackupsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/backups/history"
        element={
          <PrivateRoute>
            <Layout>
              <HistoryPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/reports"
        element={
          <PrivateRoute>
            <Layout>
              <Reports />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/resources"
        element={
          <PrivateRoute>
            <Layout>
              <Resources />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/backup-management"
        element={
          <PrivateRoute>
            <Layout>
              <BackupManagement />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/storage-pools"
        element={
          <PrivateRoute>
            <Layout>
              <StoragePoolsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/cleanup"
        element={
          <PrivateRoute>
            <Layout>
              <CleanupPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <PrivateRoute>
            <Layout>
              <SettingsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/settings/users"
        element={
          <PrivateRoute>
            <Layout>
              <SettingsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/settings/audit"
        element={
          <PrivateRoute>
            <Layout>
              <SettingsPage />
            </Layout>
          </PrivateRoute>
        }
      />
      <Route
        path="/settings/notifications"
        element={
          <PrivateRoute>
            <Layout>
              <SettingsPage />
            </Layout>
          </PrivateRoute>
        }
      />
    </Routes>
  )
}

function App() {
  return (
    <Router>
      <AuthProvider>
        <ThemeProvider>
          <SidebarProvider>
            <NotificationProvider>
              <AppRoutes />
              <Toaster 
                position="top-right" 
                richColors 
                closeButton={true}
                duration={5000}
                expand={false}
                visibleToasts={5}
                toastOptions={{
                  style: {
                    cursor: 'pointer',
                  },
                  closeButton: true,
                  dismissible: true,
                }}
              />
            </NotificationProvider>
          </SidebarProvider>
        </ThemeProvider>
      </AuthProvider>
    </Router>
  )
}

export default App
