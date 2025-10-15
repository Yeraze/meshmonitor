import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // Exclude API routes from ALL caching - navigation fallback AND precaching
        navigateFallbackDenylist: [/^\/api/],
        navigateFallbackAllowlist: [/^(?!\/api).*/],
        // Force immediate activation of new service worker
        skipWaiting: true,
        clientsClaim: true,
        // Completely ignore API routes in runtime caching
        runtimeCaching: [
          {
            // Explicitly ignore all API routes
            urlPattern: /^.*\/api\/.*/,
            handler: 'NetworkOnly'
          },
          {
            urlPattern: /^https:\/\/.*\.tile\.openstreetmap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openstreetmap-tiles',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
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