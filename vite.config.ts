import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Use BASE_URL environment variable if set, otherwise default to '/'
  base: process.env.BASE_URL || '/',
  server: {
    host: true,
    port: 5173,
    strictPort: true,
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