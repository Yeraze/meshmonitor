import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['favicon.ico', 'logo.png', 'favicon-16x16.png', 'favicon-32x32.png'],
      manifest: {
        name: 'MeshMonitor',
        short_name: 'MeshMonitor',
        description: 'Meshtastic Node Monitoring',
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'any',
        icons: [
          {
            src: 'logo.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,ico,png,svg}'],
        // Exclude HTML and API routes from precaching
        // HTML must be fetched from server to get runtime BASE_URL path rewriting
        globIgnores: ['**/api/**', '**/*.html'],
        // Increase size limit to accommodate maplibre-gl (vector tile library)
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024 // 3 MB
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
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