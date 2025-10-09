import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Always build for root - runtime HTML rewriting will handle BASE_URL
  base: '/',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ['sentry.yeraze.online'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  build: {
    rollupOptions: {
      external: [
        './src/services/database.js',
        'better-sqlite3',
        'path',
        'url',
        'fs'
      ]
    }
  }
})