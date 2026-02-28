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
          { text: 'Add-ons', link: '/add-ons/' },
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
            { text: 'Channel Database', link: '/features/channel-database' },
            { text: 'Security', link: '/features/security' },
            { text: 'Message Search', link: '/features/message-search' },
            { text: 'Embed Maps', link: '/features/embed-maps' },
            { text: 'Link Quality & Smart Hops', link: '/features/link-quality' },
            { text: 'MeshCore (Experimental)', link: '/features/meshcore' },
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
      '/add-ons/': [
        {
          text: 'Community Add-ons',
          items: [
            { text: 'Overview', link: '/add-ons/' },
            { text: 'MQTT Client Proxy', link: '/add-ons/mqtt-proxy' },
            { text: 'AI Responder', link: '/add-ons/ai-responder' }
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
      { icon: 'discord', link: 'https://discord.gg/JVR3VBETQE' },
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

  // Ignore dead links in old documentation files and excluded internal docs
  ignoreDeadLinks: [
    /^http:\/\/localhost/,
    (url) => {
      // Ignore links to excluded directories
      if (url.includes('/deployment/') || url.includes('/architecture/') || url.includes('/database/') || url.includes('/operations/')) {
        return true;
      }
      // Ignore links to excluded internal documentation files
      const excludedDocs = [
        'ARCHITECTURE_LESSONS', 'AUTHENTICATION', 'AUTH_IMPLEMENTATION_SUMMARY',
        'CHANGE_PASSWORD_FEATURE', 'development-learnings', 'mqtt-vs-http-analysis',
        'proxy-compatibility-analysis', 'PUSH_NOTIFICATIONS', 'REFACTORING_PLAN',
        'SECURITY_AUDIT', 'TEST_UPDATES', 'v2.0.0-authentication-plan',
        'v2.16-IMPLEMENTATION-SUMMARY', 'MACOS_CODE_SIGNING_SETUP',
        'PERMISSIONS_QUICK_REFERENCE', 'security-duplicate-keys', 'security-low-entropy-keys',
        'database-migration', 'meshtastic-config-import'
      ];
      return excludedDocs.some(doc => url.includes(doc));
    }
  ],

  // Exclude old documentation directories and internal development docs from VitePress processing
  // These are available on GitHub for developers who need them
  srcExclude: [
    '**/architecture/**',
    '**/database/**',
    '**/api/**',
    '**/planning/**',
    '**/plans/**',
    '**/operations/**',
    // Internal development documentation (available on GitHub)
    'ARCHITECTURE_LESSONS.md',
    'AUTHENTICATION.md',
    'AUTH_IMPLEMENTATION_SUMMARY.md',
    'CHANGE_PASSWORD_FEATURE.md',
    'development-learnings.md',
    'mqtt-vs-http-analysis.md',
    'proxy-compatibility-analysis.md',
    'PUSH_NOTIFICATIONS.md',
    'REFACTORING_PLAN.md',
    'SECURITY_AUDIT.md',
    'TEST_UPDATES.md',
    'v2.0.0-authentication-plan.md',
    'v2.16-IMPLEMENTATION-SUMMARY.md',
    'MACOS_CODE_SIGNING_SETUP.md',
    'PERMISSIONS_QUICK_REFERENCE.md',
    'security-duplicate-keys.md',
    'security-low-entropy-keys.md',
    'database-migration.md',
    'meshtastic-config-import.md'
  ]
})
