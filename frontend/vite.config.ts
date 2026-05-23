import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: process.env.VITE_SERVICE_IP || '0.0.0.0',
    port: parseInt(process.env.VITE_PORT || '5173'),
    proxy: {
      '/api': {
        target: `http://${process.env.VITE_BACKEND_IP || 'localhost'}:${process.env.VITE_BACKEND_PORT || '3000'}`,
        changeOrigin: true,
      },
      '/socket.io': {
        target: `http://${process.env.VITE_BACKEND_IP || 'localhost'}:${process.env.VITE_BACKEND_PORT || '3000'}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
