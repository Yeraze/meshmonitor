import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  vite: {
    server: {
      host: '0.0.0.0',
      allowedHosts: ['localhost', 'meshmonitor.org', 'www.meshmonitor.org', 'sentry.yeraze.online'],
      cors: true
    }
  },
  title: "MeshMonitor",
  description: "Web application for monitoring Meshtastic nodes over IP",
  base: '/',  // Custom domain: meshmonitor.org

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/images/logo.svg',

    nav: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'FAQ', link: '/faq' },
      { text: '🌐 Site Gallery', link: '/site-gallery' },
      { text: '📜 User Scripts', link: '/user-scripts' },
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
            { text: 'Admin Commands', link: '/features/admin-commands' },
            { text: 'Push Notifications', link: '/features/notifications' },
            { text: 'Packet Monitor', link: '/features/packet-monitor' },
            { text: '🌍 Translations', link: '/features/translations' },
            { text: '🎨 Theme Gallery', link: '/THEME_GALLERY' },
            { text: '🌐 Site Gallery', link: '/site-gallery' },
            { text: '📜 User Scripts', link: '/user-scripts' }
          ]
        }
      ],
      '/configuration/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Overview', link: '/configuration/' },
            { text: '🖥️ Desktop App', link: '/configuration/desktop' },
            { text: '⚡ Docker Compose Configurator', link: '/configurator' },
            { text: 'Using meshtasticd', link: '/configuration/meshtasticd' },
            { text: 'BLE Bridge', link: '/configuration/ble-bridge' },
            { text: 'Serial Bridge', link: '/configuration/serial-bridge' },
            { text: 'Virtual Node', link: '/configuration/virtual-node' },
            { text: '🗺️ Custom Tile Servers', link: '/configuration/custom-tile-servers' },
            { text: 'SSO Setup', link: '/configuration/sso' },
            { text: 'Reverse Proxy', link: '/configuration/reverse-proxy' },
            { text: 'HTTP vs HTTPS', link: '/configuration/http-vs-https' },
            { text: 'Production Deployment', link: '/configuration/production' },
            { text: '🔄 Automatic Self-Upgrade', link: '/configuration/auto-upgrade' },
            { text: 'Push Notifications', link: '/features/notifications' }
          ]
        },
        {
          text: 'Deployment',
          items: [
            { text: 'Deployment Guide', link: '/deployment/DEPLOYMENT_GUIDE' },
            { text: '📦 Proxmox LXC', link: '/deployment/PROXMOX_LXC_GUIDE' }
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
            { text: 'API Documentation', link: '/development/api' },
            { text: 'API Reference', link: '/development/api-reference' }
          ]
        },
        {
          text: 'Advanced Topics',
          items: [
            { text: 'Auto Responder Scripting', link: '/developers/auto-responder-scripting' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'discord', link: 'https://discord.gg/SdMfbmTGH' },
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
  srcExclude: ['**/architecture/**', '**/database/**', '**/api/**']
})
