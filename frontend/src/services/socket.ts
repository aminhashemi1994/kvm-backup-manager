import { io, Socket } from 'socket.io-client'

// Simple backend URL configuration
// Extract base URL from VITE_BACKEND_URL (remove /api or /api-backup suffix)
const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'
// Remove any API path suffix to get the base WebSocket URL
const WS_URL = backendUrl.replace(/\/api.*$/, '')

class SocketService {
  private socket: Socket | null = null
  private listeners: Map<string, Set<Function>> = new Map()

  connect() {
    if (this.socket?.connected) {
      return this.socket
    }

    this.socket = io(WS_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    })

    this.socket.on('connect', () => {
      console.log('✓ WebSocket connected')
    })

    this.socket.on('disconnect', () => {
      console.log('✗ WebSocket disconnected')
    })

    this.socket.on('connect_error', (error) => {
      console.error('WebSocket connection error:', error)
    })

    // Setup event listeners
    this.setupEventListeners()

    return this.socket
  }

  private setupEventListeners() {
    if (!this.socket) return

    // Backup events
    this.socket.on('backup-started', (data) => {
      this.emit('backup-started', data)
    })

    this.socket.on('backup-progress', (data) => {
      this.emit('backup-progress', data)
    })

    this.socket.on('backup-complete', (data) => {
      this.emit('backup-complete', data)
    })

    this.socket.on('backup-error', (data) => {
      this.emit('backup-error', data)
    })

    this.socket.on('backup-log', (data) => {
      this.emit('backup-log', data)
    })

    this.socket.on('backup-skipped', (data) => {
      this.emit('backup-skipped', data)
    })

    this.socket.on('job-removed', (data) => {
      this.emit('job-removed', data)
    })

    // Init events
    this.socket.on('init-log', (data) => {
      this.emit('init-log', data)
    })

    this.socket.on('init-complete', (data) => {
      this.emit('init-complete', data)
    })

    this.socket.on('init-error', (data) => {
      this.emit('init-error', data)
    })

    // Agent status updates
    this.socket.on('agents-status-update', (data) => {
      this.emit('agents-status-update', data)
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  subscribeToJob(jobId: string) {
    if (this.socket) {
      this.socket.emit('subscribe-job', jobId)
    }
  }

  unsubscribeFromJob(jobId: string) {
    if (this.socket) {
      this.socket.emit('unsubscribe-job', jobId)
    }
  }

  subscribeToInit(initId: string) {
    if (this.socket) {
      this.socket.emit('subscribe-init', initId)
    }
  }

  unsubscribeFromInit(initId: string) {
    if (this.socket) {
      this.socket.emit('unsubscribe-init', initId)
    }
  }

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(callback)

    // Return cleanup function
    return () => {
      this.off(event, callback)
    }
  }

  off(event: string, callback: Function) {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      eventListeners.delete(callback)
    }
  }

  private emit(event: string, data: any) {
    const eventListeners = this.listeners.get(event)
    if (eventListeners) {
      eventListeners.forEach((callback) => callback(data))
    }
  }

  isConnected(): boolean {
    return this.socket?.connected || false
  }
}

export const socketService = new SocketService()
export default socketService
