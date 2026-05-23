// Test script to verify environment variables during build
import { loadEnv } from 'vite'

const env = loadEnv('production', process.cwd(), '')

console.log('=================================')
console.log('Environment Variables Test')
console.log('=================================')
console.log('VITE_BACKEND_IP:', JSON.stringify(env.VITE_BACKEND_IP))
console.log('VITE_BACKEND_PORT:', JSON.stringify(env.VITE_BACKEND_PORT))
console.log('VITE_API_BASE_PATH:', JSON.stringify(env.VITE_API_BASE_PATH))
console.log('=================================')
console.log('')

if (env.VITE_BACKEND_IP === '' && env.VITE_BACKEND_PORT === '') {
  console.log('✅ Environment variables are correctly empty')
} else if (env.VITE_BACKEND_IP === undefined && env.VITE_BACKEND_PORT === undefined) {
  console.log('❌ ERROR: Environment variables are undefined!')
  console.log('This means .env file is not being read')
} else {
  console.log('❌ ERROR: Environment variables have values!')
  console.log('They should be empty for production')
}
