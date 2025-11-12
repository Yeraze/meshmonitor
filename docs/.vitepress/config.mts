import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  vite: {
    server: {
      host: '0.0.0.0',
      allowedHosts: ['localhost', 'meshmonitor.org', 'www.meshmonitor.org', 'sentry.yeraze.online']
    }
  },
  title: "MeshMonitor",
  description: "Web application for monitoring Meshtastic nodes over IP",
  base: '/',  // Custom domain: meshmonitor.org

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/images/logo.svg',

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'FAQ', link: '/faq' },
      { text: '🌐 Site Gallery', link: '/site-gallery' },
      {
        text: 'Docs',
        items: [
          { text: 'Features', link: '/features/settings' },
          { text: 'Configuration', link: '/configuration/' },
          { text: 'Development', link: '/development/' }
        ]
      },
      { text: '📦 Releases', link: 'https://github.com/yeraze/meshmonitor/releases' }
    ],

    sidebar: {
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Settings', link: '/features/settings' },
            { text: 'Automation', link: '/features/automation' },
            { text: 'Device Configuration', link: '/features/device' },
            { text: 'Push Notifications', link: '/features/notifications' },
            { text: '🎨 Theme Gallery', link: '/THEME_GALLERY' },
            { text: '🌐 Site Gallery', link: '/site-gallery' }
          ]
        }
      ],
      '/configuration/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Overview', link: '/configuration/' },
            { text: '⚡ Docker Compose Configurator', link: '/configurator' },
            { text: 'Using meshtasticd', link: '/configuration/meshtasticd' },
            { text: 'BLE Bridge', link: '/configuration/ble-bridge' },
            { text: 'Serial Bridge', link: '/configuration/serial-bridge' },
            { text: 'Virtual Node', link: '/configuration/virtual-node' },
            { text: 'SSO Setup', link: '/configuration/sso' },
            { text: 'Reverse Proxy', link: '/configuration/reverse-proxy' },
            { text: 'HTTP vs HTTPS', link: '/configuration/http-vs-https' },
            { text: 'Production Deployment', link: '/configuration/production' },
            { text: '🔄 Automatic Self-Upgrade', link: '/configuration/auto-upgrade' },
            { text: 'Push Notifications', link: '/features/notifications' }
          ]
        }
      ],
      '/development/': [
        {
          text: 'Development',
          items: [
            { text: 'Overview', link: '/development/' },
            { text: 'Development Setup', link: '/development/setup' },
            { text: 'Architecture', link: '/development/architecture' },
            { text: 'Database', link: '/development/database' },
            { text: 'Authentication', link: '/development/authentication' },
            { text: 'API Documentation', link: '/development/api' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/yeraze/meshmonitor' }
    ],

    footer: {
      message: 'Released under the <a href="https://github.com/yeraze/meshmonitor/blob/main/LICENSE" target="_blank">BSD-3-Clause License</a>.',
      copyright: 'Copyright © 2024-present MeshMonitor Contributors'
    },

    search: {
      provider: 'local'
    }
  },

  // Enable last updated timestamp
  lastUpdated: true,

  // Markdown configuration
  markdown: {
    lineNumbers: true
  },

  // Ignore dead links in old documentation files
  ignoreDeadLinks: [
    /^http:\/\/localhost/,
    (url) => {
      return url.includes('/deployment/') || url.includes('/architecture/') || url.includes('/database/')
    }
  ],

  // Exclude old documentation directories from VitePress processing
  srcExclude: ['**/deployment/**', '**/architecture/**', '**/database/**', '**/api/**']
})
