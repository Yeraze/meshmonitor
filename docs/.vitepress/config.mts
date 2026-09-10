import { defineConfig } from 'vitepress'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const generatorPath = resolve(repoRoot, 'scripts/blog-to-news.mjs')

function regenerateNewsJson(label: string) {
  const result = spawnSync(process.execPath, [generatorPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`[${label}] blog-to-news generator exited with code ${result.status}`)
  }
}

const newsJsonPlugin = {
  name: 'meshmonitor:news-json',
  buildStart() {
    regenerateNewsJson('vite:buildStart')
  },
  configureServer() {
    regenerateNewsJson('vite:configureServer')
  },
}

// https://vitepress.dev/reference/site-config
/**
 * Features sidebar.
 *
 * Rebalanced so no group runs past six rows: "Network Insight" had grown to ten
 * and "Administration & Security" to nine, which is past the point a sidebar
 * group can be scanned. Groups are named for what the reader is doing rather
 * than for the subsystem involved.
 *
 * Shared with the root-level pages below (`/faq`, `/user-scripts`,
 * `/security-duplicate-keys`, …) so those stop rendering with no sidebar at
 * all. Their URLs are deliberately unchanged — this site has no redirect
 * mechanism, so a move would break every inbound link permanently, and the two
 * `security-*` URLs in particular are shared with users directly.
 */
const featuresSidebar = [
  {
    text: 'Start Here',
    collapsed: false,
    items: [
      { text: 'Settings', link: '/features/settings' },
      { text: 'Global Settings', link: '/features/global-settings' },
      { text: 'Multi-Source', link: '/features/multi-source' },
      { text: 'Privacy Disclosures', link: '/features/privacy-disclosures' }
    ]
  },
  {
    text: 'Your Nodes',
    collapsed: false,
    items: [
      { text: 'Device Configuration', link: '/features/device' },
      { text: 'Node Number Changes (2.8)', link: '/features/node-identity-changes' },
      { text: 'Traffic Management', link: '/features/traffic-management' },
      { text: 'Receive-Only Mode', link: '/features/receive-only-mode' }
    ]
  },
  {
    text: 'Messaging & Channels',
    collapsed: false,
    items: [
      { text: 'Message Search', link: '/features/message-search' },
      { text: 'Delivery Details', link: '/features/delivery-diagnostics' },
      { text: 'Channel Database', link: '/features/channel-database' },
      { text: 'Store & Forward', link: '/features/store-forward' }
    ]
  },
  {
    text: 'Maps & Geography',
    collapsed: false,
    items: [
      { text: 'Interactive Maps', link: '/features/maps' },
      { text: 'Map Analysis', link: '/features/map-analysis' },
      { text: 'Waypoints', link: '/features/waypoints' },
      { text: 'Position Estimation', link: '/features/position-estimation' },
      { text: 'Estimated Accuracy', link: '/features/estimated-accuracy' },
      { text: 'Embed Maps', link: '/features/embed-maps' }
    ]
  },
  {
    text: 'Monitoring & Telemetry',
    collapsed: false,
    items: [
      { text: 'Analytics', link: '/features/analytics' },
      { text: 'Analysis & Reports', link: '/features/analysis-reports' },
      { text: 'Telemetry Widgets', link: '/features/telemetry-widgets' },
      { text: 'Solar Monitoring', link: '/features/solar-monitoring' }
    ]
  },
  {
    text: 'Diagnostics',
    collapsed: false,
    items: [
      {
        text: 'Mesh Issues Analysis',
        link: '/features/mesh-issues',
        items: [
          { text: 'Test Reference', link: '/features/mesh-issues-test-reference' }
        ]
      },
      { text: 'Link Quality & Smart Hops', link: '/features/link-quality' },
      { text: 'Packet Monitor', link: '/features/packet-monitor' }
    ]
  },
  {
    text: 'Automation & Alerts',
    collapsed: false,
    items: [
      { text: 'Automatic Responses', link: '/features/automation' },
      { text: 'Automation Engine', link: '/features/automation-engine' },
      { text: 'Geofence Triggers', link: '/features/geofence-triggers' },
      { text: 'Push Notifications', link: '/features/notifications' },
      { text: 'Auto Heap Management', link: '/features/auto-heap-management' }
    ]
  },
  {
    text: 'Security',
    collapsed: false,
    items: [
      { text: 'Security Overview', link: '/features/security' },
      { text: 'Duplicate Encryption Keys', link: '/security-duplicate-keys' },
      { text: 'Low-Entropy Encryption Keys', link: '/security-low-entropy-keys' },
      { text: 'Impersonation Detection', link: '/features/impersonation-detection' },
      { text: 'PKI Direct Message Decryption', link: '/features/pki-dm-decryption' },
      { text: 'Security Advisories', link: '/security/SECURITY_ADVISORY' }
    ]
  },
  {
    text: 'Administration',
    collapsed: false,
    items: [
      { text: 'Per-Source Permissions', link: '/features/per-source-permissions' },
      { text: 'Admin Commands', link: '/features/admin-commands' },
      { text: 'System Backup & Restore', link: '/features/system-backup' },
      { text: 'Firmware OTA Updates', link: '/firmware-ota-prerequisites' }
    ]
  },
  {
    text: 'Integrations',
    collapsed: false,
    items: [
      { text: 'Embedded MQTT Broker & Bridge', link: '/features/mqtt-broker' },
      { text: 'ATAK / CoT Integration', link: '/features/atak' }
    ]
  },
  {
    text: 'MeshCore',
    collapsed: false,
    items: [
      { text: 'MeshCore Overview', link: '/features/meshcore' },
      { text: 'Receive-Only Mode', link: '/features/meshcore-receive-only' },
      { text: 'Analyzer Observer', link: '/features/meshcore-analyzer-observer' },
      { text: 'MQTT Ingest', link: '/features/meshcore-mqtt-ingest' }
    ]
  },
  {
    text: 'Appearance & Community',
    collapsed: true,
    items: [
      { text: '\u{1F3A8} Custom Themes', link: '/features/custom-themes' },
      { text: '\u{1F3A8} Theme Gallery', link: '/THEME_GALLERY' },
      { text: '\u{1F30D} Translations', link: '/features/translations' },
      { text: '\u{1F310} Site Gallery', link: '/site-gallery' },
      { text: '\u{1F4DC} User Scripts', link: '/user-scripts' }
    ]
  }
]

export default defineConfig({
  vite: {
    server: {
      host: '0.0.0.0',
      allowedHosts: ['localhost', 'meshmonitor.org', 'www.meshmonitor.org', 'sentry.yeraze.online', 'spire.yeraze.online'],
      cors: true
    },
    plugins: [newsJsonPlugin]
  },
  title: "MeshMonitor",
  description: "Self-hosted, multi-protocol web dashboard for Meshtastic, MeshCore, and MQTT mesh networks. Real-time maps, messaging, telemetry, automation, and alerts. Runs on Docker, desktop, or Kubernetes.",
  base: '/',  // Custom domain: meshmonitor.org

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: '/images/logo.svg',

    nav: [
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'FAQ', link: '/faq' },
      {
        text: 'Documents',
        items: [
          { text: 'Features', link: '/features/settings' },
          { text: 'Configuration', link: '/configuration/' },
          { text: 'Add-ons', link: '/add-ons/' },
          { text: 'Development', link: '/development/' },
          { text: 'Blog', link: '/blog/' },
          { text: '🌐 Site Gallery', link: '/site-gallery' },
          { text: '📜 User Scripts', link: '/user-scripts' }
        ]
      },
      { text: '📦 Releases', link: 'https://github.com/yeraze/meshmonitor/releases' }
    ],

    sidebar: {
      '/features/': featuresSidebar,

      // Root-level pages used to render with NO sidebar at all, because every
      // sidebar key was a directory prefix and these live at the site root.
      // Arriving from search gave the reader no sense that a section existed.
      // Their URLs are unchanged on purpose (no redirect support on this site);
      // they just borrow the Features sidebar for context.
      //
      // `/security-duplicate-keys` and `/security-low-entropy-keys` are the
      // short URLs shared with users about key problems. Do not move or rename
      // them.
      '/security-duplicate-keys': featuresSidebar,
      '/security-low-entropy-keys': featuresSidebar,
      '/security/': featuresSidebar,
      '/firmware-ota-prerequisites': featuresSidebar,
      '/THEME_GALLERY': featuresSidebar,
      '/site-gallery': featuresSidebar,
      '/user-scripts': featuresSidebar,
      '/faq': featuresSidebar,

      '/configuration/': [
        {
          text: 'Get Started',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/configuration/' },
            { text: '⚡ Docker Compose Configurator', link: '/configurator' },
            { text: '🖥️ Desktop App', link: '/configuration/desktop' }
          ]
        },
        {
          text: 'Connect Your Mesh',
          collapsed: false,
          items: [
            { text: 'BLE Bridge (Bluetooth)', link: '/configuration/ble-bridge' },
            { text: 'Serial Bridge (USB)', link: '/configuration/serial-bridge' },
            { text: 'Virtual Node Server', link: '/configuration/virtual-node' },
            { text: 'Using meshtasticd', link: '/configuration/meshtasticd' },
            { text: '🧪 Tested Hardware', link: '/configuration/tested-hardware' }
          ]
        },
        {
          text: 'Networking & TLS',
          collapsed: false,
          items: [
            { text: 'HTTP vs HTTPS', link: '/configuration/http-vs-https' },
            { text: 'Reverse Proxy', link: '/configuration/reverse-proxy' },
            { text: 'HTTPS with DuckDNS', link: '/configuration/duckdns-https' }
          ]
        },
        {
          text: 'Authentication & Hardening',
          collapsed: false,
          items: [
            { text: 'SSO (OpenID Connect)', link: '/configuration/sso' },
            { text: 'Fail2ban Integration', link: '/configuration/fail2ban' }
          ]
        },
        {
          text: 'Production & Operations',
          collapsed: false,
          items: [
            { text: 'Production Deployment', link: '/configuration/production' },
            { text: '🔄 Updating MeshMonitor', link: '/configuration/updating' },
          { text: 'Unattended Upgrades', link: '/configuration/auto-upgrade' },
            { text: 'Reducing Node Load', link: '/configuration/node-load' },
            { text: 'Push Notifications', link: '/features/notifications' },
            { text: '🗺️ Custom Tile Servers', link: '/configuration/custom-tile-servers' }
          ]
        },
        {
          text: 'Deployment Guides',
          collapsed: true,
          items: [
            { text: 'Deployment Guide', link: '/deployment/DEPLOYMENT_GUIDE' },
            { text: '☸️ Kubernetes / Helm', link: '/deployment/HELM_GUIDE' },
            { text: '📦 Proxmox LXC', link: '/deployment/PROXMOX_LXC_GUIDE' },
            { text: '📡 Reticulum Bridge', link: '/deployment/RETICULUM_BRIDGE_GUIDE' }
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
          text: 'Getting Started',
          collapsed: false,
          items: [
            { text: 'Overview', link: '/development/' },
            { text: 'Development Setup', link: '/development/setup' },
            { text: 'Claude Code Quickstart', link: '/development/claude-getting-started' }
          ]
        },
        {
          text: 'Architecture',
          collapsed: false,
          items: [
            { text: 'Architecture Overview', link: '/development/architecture' },
            { text: 'Frontend Structure', link: '/development/FRONTEND_STRUCTURE' },
            { text: 'Database', link: '/development/database' },
            { text: 'Authentication', link: '/development/authentication' }
          ]
        },
        {
          text: 'API & Testing',
          collapsed: false,
          items: [
            { text: 'API Reference', link: '/development/api-reference' },
            { text: 'Test Suite', link: '/development/TEST_SUITE' }
          ]
        },
        {
          text: 'Advanced Topics',
          collapsed: true,
          items: [
            { text: 'Auto Responder Scripting', link: '/developers/auto-responder-scripting' },
            { text: 'BLE Bridge Migration', link: '/development/BLE_BRIDGE_MIGRATION' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'discord', link: 'https://discord.gg/JVR3VBETQE' },
      { icon: 'github', link: 'https://github.com/yeraze/meshmonitor' },
      // Ko-fi donation link — same handle as .github/FUNDING.yml and the
      // in-app Settings Support button. Heart glyph matches the app's UiIcon
      // "heart" affordance; aria-label spells out the destination.
      {
        icon: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7-4.35-9.5-8.5C.75 9.5 2.5 5.5 6 5.5c2 0 3.5 1.25 4.5 3 1-1.75 2.5-3 4.5-3 3.5 0 5.25 4 3.5 7C19 16.65 12 21 12 21z"/></svg>'
        },
        link: 'https://ko-fi.com/yeraze',
        ariaLabel: 'Support MeshMonitor on Ko-fi'
      }
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

  // Ignore localhost links (used in examples); the build is the source of truth
  // for everything else, so dead links surface as warnings.
  ignoreDeadLinks: [
    /^http:\/\/localhost/
  ],

  // Exclude internal-only documentation from VitePress processing.
  // Anything under docs/internal/ stays in the repository for developers
  // browsing on GitHub but does not ship to the public site.
  srcExclude: [
    '**/internal/**',
    // Legacy directories of design docs / planning that pre-date docs/internal/.
    // Kept for now so the build still ignores them if any straggler is added.
    '**/architecture/**',
    '**/database/**',
    '**/api/**',
    '**/planning/**',
    '**/plans/**',
    '**/operations/**',
    // Dated point-in-time security review, kept in-repo as an archive record.
    // The living advisory page (security/SECURITY_ADVISORY.md) still publishes.
    '**/security/2026-*-review.md'
  ]
})
