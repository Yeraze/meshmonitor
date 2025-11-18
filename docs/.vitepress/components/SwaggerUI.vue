<template>
  <div>
    <div id="swagger-ui"></div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'

onMounted(async () => {
  // Dynamically import Swagger UI to avoid SSR issues
  const SwaggerUIBundle = (await import('swagger-ui-dist/swagger-ui-bundle.js')).default
  const SwaggerUIStandalonePreset = (await import('swagger-ui-dist/swagger-ui-standalone-preset.js')).default

  // Load CSS
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'https://unpkg.com/swagger-ui-dist@5/swagger-ui.css'
  document.head.appendChild(link)

  // Initialize Swagger UI
  const ui = SwaggerUIBundle({
    url: '/openapi.yaml',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl
    ],
    layout: 'StandaloneLayout',
    docExpansion: 'list',
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
    displayRequestDuration: true,
    filter: true,
    syntaxHighlight: {
      activate: true,
      theme: 'monokai'
    },
    tryItOutEnabled: true,
    persistAuthorization: true
  })

  // Wait for both CSS and Swagger UI to load, then inject custom styles
  const applyCustomStyles = () => {
    // Get computed VitePress colors from the document
    const root = document.documentElement
    const styles = getComputedStyle(root)
    const isDark = root.classList.contains('dark')

    // Extract colors with trimming to remove whitespace
    let brandColor = styles.getPropertyValue('--vp-c-brand-1').trim() || '#3451b2'
    let brand2Color = styles.getPropertyValue('--vp-c-brand-2').trim() || '#5672cd'
    let bgColor = styles.getPropertyValue('--vp-c-bg').trim() || (isDark ? '#1b1b1f' : '#ffffff')
    let bgSoft = styles.getPropertyValue('--vp-c-bg-soft').trim() || (isDark ? '#252529' : '#f6f6f7')
    let divider = styles.getPropertyValue('--vp-c-divider').trim() || (isDark ? '#3c3f44' : '#e2e2e3')
    let textColor = styles.getPropertyValue('--vp-c-text-1').trim() || (isDark ? '#c9d1d9' : '#213547')
    let text2Color = styles.getPropertyValue('--vp-c-text-2').trim() || (isDark ? '#8b949e' : '#476582')
    let greenColor = styles.getPropertyValue('--vp-c-green-1').trim() || '#10b981'
    let yellowColor = styles.getPropertyValue('--vp-c-yellow-1').trim() || '#f59e0b'
    let redColor = styles.getPropertyValue('--vp-c-red-1').trim() || '#ef4444'
    let grayColor = styles.getPropertyValue('--vp-c-gray-1').trim() || '#6b7280'
    let gray2Color = styles.getPropertyValue('--vp-c-gray-2').trim() || '#9ca3af'

    // Remove old style if exists
    const oldStyle = document.getElementById('swagger-custom-theme')
    if (oldStyle) oldStyle.remove()

    // Inject comprehensive custom styles with actual color values
    const style = document.createElement('style')
    style.id = 'swagger-custom-theme'
    style.textContent = `
      /* Base styles */
      .swagger-ui {
        background: transparent !important;
        font-family: inherit !important;
      }

      /* Opblock (endpoint) styling */
      .swagger-ui .opblock {
        background: ${bgSoft} !important;
        border: 1px solid ${divider} !important;
        margin-bottom: 15px !important;
      }

      .swagger-ui .opblock .opblock-summary {
        background: ${bgColor} !important;
        border-bottom: 1px solid ${divider} !important;
      }

      .swagger-ui .opblock .opblock-summary:hover {
        background: ${bgSoft} !important;
      }

      /* HTTP Method colors */
      .swagger-ui .opblock-summary-method {
        background: ${brandColor} !important;
        color: white !important;
        border-radius: 3px !important;
      }

      .swagger-ui .opblock.opblock-post .opblock-summary-method {
        background: ${greenColor} !important;
      }

      .swagger-ui .opblock.opblock-put .opblock-summary-method {
        background: ${yellowColor} !important;
      }

      .swagger-ui .opblock.opblock-delete .opblock-summary-method {
        background: ${redColor} !important;
      }

      /* Opblock body */
      .swagger-ui .opblock-description-wrapper,
      .swagger-ui .opblock-body {
        background: ${bgColor} !important;
      }

      /* Buttons */
      .swagger-ui .btn {
        background: ${brandColor} !important;
        color: white !important;
        border: none !important;
      }

      .swagger-ui .btn:hover {
        background: ${brand2Color} !important;
      }

      .swagger-ui .btn.cancel {
        background: ${grayColor} !important;
      }

      .swagger-ui .btn.cancel:hover {
        background: ${gray2Color} !important;
      }

      .swagger-ui .authorization__btn {
        background: ${brandColor} !important;
        color: white !important;
        border: 1px solid ${brandColor} !important;
      }

      .swagger-ui .authorization__btn:hover {
        background: ${brand2Color} !important;
        border-color: ${brand2Color} !important;
      }

      /* Topbar */
      .swagger-ui .topbar {
        background: ${bgSoft} !important;
        border-bottom: 1px solid ${divider} !important;
        padding: 10px 0 !important;
      }

      /* Info section */
      .swagger-ui .info {
        background: ${bgColor} !important;
        margin: 20px 0 !important;
      }

      .swagger-ui .info .title {
        color: ${textColor} !important;
        font-size: 2em !important;
      }

      .swagger-ui .info .description,
      .swagger-ui .info .description p,
      .swagger-ui .info .description div {
        color: ${text2Color} !important;
      }

      /* Ensure all text is visible */
      .swagger-ui .opblock-summary-description,
      .swagger-ui .opblock-description,
      .swagger-ui .opblock-title_normal,
      .swagger-ui .response-col_description,
      .swagger-ui .markdown p,
      .swagger-ui .renderedMarkdown p {
        color: ${textColor} !important;
      }

      /* Links */
      .swagger-ui a {
        color: ${brandColor} !important;
      }

      .swagger-ui a:hover {
        color: ${brand2Color} !important;
      }

      /* Input fields */
      .swagger-ui input[type=text],
      .swagger-ui input[type=password],
      .swagger-ui textarea,
      .swagger-ui select {
        background: ${bgColor} !important;
        border: 1px solid ${divider} !important;
        color: ${textColor} !important;
      }

      .swagger-ui input[type=text]:focus,
      .swagger-ui input[type=password]:focus,
      .swagger-ui textarea:focus,
      .swagger-ui select:focus {
        border-color: ${brandColor} !important;
        outline: none !important;
      }

      /* Tables and responses */
      .swagger-ui .response-col_status {
        color: ${textColor} !important;
      }

      .swagger-ui table thead tr th,
      .swagger-ui table thead tr td {
        background: ${bgSoft} !important;
        color: ${textColor} !important;
        border-bottom: 1px solid ${divider} !important;
      }

      /* Tabs */
      .swagger-ui .tab li {
        color: ${text2Color} !important;
      }

      .swagger-ui .tab li.active {
        color: ${brandColor} !important;
      }

      /* Models */
      .swagger-ui .model-box,
      .swagger-ui .responses-inner {
        background: ${bgSoft} !important;
      }

      .swagger-ui .model-title {
        color: ${textColor} !important;
      }

      /* Parameters */
      .swagger-ui .parameter__name {
        color: ${textColor} !important;
      }

      .swagger-ui .parameter__type {
        color: ${text2Color} !important;
      }

      /* Scheme container */
      .swagger-ui .scheme-container {
        background: ${bgSoft} !important;
        border: 1px solid ${divider} !important;
      }

      /* Force white text on colored backgrounds for visibility */
      .swagger-ui .opblock-summary-method,
      .swagger-ui .btn:not(.cancel),
      .swagger-ui .authorization__btn {
        color: #ffffff !important;
      }

      /* Catch-all for all text elements */
      .swagger-ui,
      .swagger-ui label,
      .swagger-ui td,
      .swagger-ui th,
      .swagger-ui p,
      .swagger-ui span,
      .swagger-ui div {
        color: ${textColor} !important;
      }

      /* Re-apply white to elements that need it */
      .swagger-ui .opblock-summary-method,
      .swagger-ui .opblock-summary-method span,
      .swagger-ui .btn:not(.cancel),
      .swagger-ui .btn:not(.cancel) span,
      .swagger-ui .authorization__btn,
      .swagger-ui .authorization__btn span {
        color: #ffffff !important;
      }

      /* HEADER OVERRIDES - MUST BE LAST */
      .swagger-ui .opblock-tag,
      .swagger-ui .opblock-tag *,
      .swagger-ui .opblock-tag-section,
      .swagger-ui .opblock-tag-section *,
      .swagger-ui h4.opblock-tag-section,
      .swagger-ui h4.opblock-tag-section * {
        color: ${textColor} !important;
      }

      .swagger-ui .opblock-tag {
        border-bottom: 1px solid ${divider} !important;
      }
    `
    document.head.appendChild(style)
  }

  // Apply styles after CSS loads
  link.onload = () => {
    setTimeout(() => {
      applyCustomStyles()

      // Force header text colors via JavaScript
      setTimeout(() => {
        const root = document.documentElement
        const styles = getComputedStyle(root)
        const isDark = root.classList.contains('dark')
        const textColor = styles.getPropertyValue('--vp-c-text-1').trim() || (isDark ? '#c9d1d9' : '#213547')

        const headers = document.querySelectorAll('.swagger-ui .info h1, .swagger-ui .info h2, .swagger-ui .info h3, .swagger-ui .info h4, .swagger-ui .info h5, .swagger-ui h2, .swagger-ui h3, .swagger-ui h4, .swagger-ui h5, .swagger-ui .opblock-tag, .swagger-ui .opblock-tag *, .swagger-ui .renderedMarkdown h1, .swagger-ui .renderedMarkdown h2, .swagger-ui .renderedMarkdown h3, .swagger-ui .renderedMarkdown h4, .swagger-ui .renderedMarkdown h5')
        console.log('Found', headers.length, 'headers to style with color:', textColor)
        headers.forEach(el => {
          el.style.setProperty('color', textColor, 'important')
        })
      }, 1000)
    }, 100)

    // Reapply on theme change
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'class') {
          setTimeout(() => {
            applyCustomStyles()
            // Re-force header colors
            const headers = document.querySelectorAll('.swagger-ui .info h1, .swagger-ui .info h2, .swagger-ui .info h3, .swagger-ui .info h4, .swagger-ui .info h5, .swagger-ui h2, .swagger-ui h3, .swagger-ui h4, .swagger-ui h5, .swagger-ui .opblock-tag, .swagger-ui .opblock-tag *, .swagger-ui .renderedMarkdown h1, .swagger-ui .renderedMarkdown h2, .swagger-ui .renderedMarkdown h3, .swagger-ui .renderedMarkdown h4, .swagger-ui .renderedMarkdown h5')
            const root = document.documentElement
            const styles = getComputedStyle(root)
            const isDark = root.classList.contains('dark')
            const textColor = styles.getPropertyValue('--vp-c-text-1').trim() || (isDark ? '#c9d1d9' : '#213547')
            headers.forEach(el => {
              el.style.setProperty('color', textColor, 'important')
            })
          }, 50)
        }
      })
    })
    observer.observe(document.documentElement, { attributes: true })
  }
})
</script>

<style>
/* Override Swagger UI styles to match VitePress theme */
#swagger-ui {
  font-family: inherit !important;
}

/* Light mode colors to match VitePress */
.swagger-ui .opblock-tag {
  border-bottom: 1px solid var(--vp-c-divider) !important;
}

.swagger-ui .opblock {
  border: 1px solid var(--vp-c-divider) !important;
  background: var(--vp-c-bg-soft) !important;
}

.swagger-ui .opblock .opblock-summary {
  background: var(--vp-c-bg) !important;
  border-bottom: 1px solid var(--vp-c-divider) !important;
}

.swagger-ui .opblock .opblock-summary:hover {
  background: var(--vp-c-bg-soft) !important;
}

.swagger-ui .opblock-summary-method {
  background: var(--vp-c-brand-1) !important;
  color: white !important;
}

.swagger-ui .opblock.opblock-post .opblock-summary-method {
  background: var(--vp-c-green-1) !important;
}

.swagger-ui .opblock.opblock-put .opblock-summary-method {
  background: var(--vp-c-yellow-1) !important;
}

.swagger-ui .opblock.opblock-delete .opblock-summary-method {
  background: var(--vp-c-red-1) !important;
}

.swagger-ui .opblock-description-wrapper,
.swagger-ui .opblock-body {
  background: var(--vp-c-bg) !important;
}

.swagger-ui .response-col_status {
  color: var(--vp-c-text-1) !important;
}

.swagger-ui .tab li {
  color: var(--vp-c-text-2) !important;
}

.swagger-ui .tab li.active {
  color: var(--vp-c-brand-1) !important;
}

.swagger-ui .btn {
  background: var(--vp-c-brand-1) !important;
  color: white !important;
  border: none !important;
}

.swagger-ui .btn:hover {
  background: var(--vp-c-brand-2) !important;
}

.swagger-ui .btn.cancel {
  background: var(--vp-c-gray-1) !important;
}

.swagger-ui .btn.cancel:hover {
  background: var(--vp-c-gray-2) !important;
}

.swagger-ui .authorization__btn {
  background: var(--vp-c-brand-1) !important;
  color: white !important;
  border: 1px solid var(--vp-c-brand-1) !important;
}

.swagger-ui .authorization__btn:hover {
  background: var(--vp-c-brand-2) !important;
  border-color: var(--vp-c-brand-2) !important;
}

.swagger-ui input[type=text],
.swagger-ui input[type=password],
.swagger-ui textarea,
.swagger-ui select {
  background: var(--vp-c-bg) !important;
  border: 1px solid var(--vp-c-divider) !important;
  color: var(--vp-c-text-1) !important;
}

.swagger-ui input[type=text]:focus,
.swagger-ui input[type=password]:focus,
.swagger-ui textarea:focus,
.swagger-ui select:focus {
  border-color: var(--vp-c-brand-1) !important;
}

.swagger-ui .scheme-container {
  background: var(--vp-c-bg-soft) !important;
  border: 1px solid var(--vp-c-divider) !important;
}

.swagger-ui .loading-container .loading:after {
  color: var(--vp-c-brand-1) !important;
}

/* Dark mode adjustments */
.dark .swagger-ui .opblock .opblock-summary-method {
  color: var(--vp-c-bg) !important;
}

.dark .swagger-ui .btn,
.dark .swagger-ui .authorization__btn {
  color: var(--vp-c-bg) !important;
}

/* Model and response containers */
.swagger-ui .model-box,
.swagger-ui .responses-inner {
  background: var(--vp-c-bg-soft) !important;
}

.swagger-ui .model-title {
  color: var(--vp-c-text-1) !important;
}

.swagger-ui .parameter__name {
  color: var(--vp-c-text-1) !important;
}

.swagger-ui .parameter__type {
  color: var(--vp-c-text-2) !important;
}

/* Code highlighting to match VitePress */
.swagger-ui .highlight-code > .microlight {
  background: var(--vp-code-block-bg) !important;
  color: var(--vp-code-block-color) !important;
  border: 1px solid var(--vp-c-divider) !important;
}

/* Info section */
.swagger-ui .info {
  background: var(--vp-c-bg) !important;
}

.swagger-ui .info .title {
  color: var(--vp-c-text-1) !important;
}

.swagger-ui .info .description {
  color: var(--vp-c-text-2) !important;
}

.swagger-ui a {
  color: var(--vp-c-brand-1) !important;
}

.swagger-ui a:hover {
  color: var(--vp-c-brand-2) !important;
}

/* Topbar */
.swagger-ui .topbar {
  background: var(--vp-c-bg-soft) !important;
  border-bottom: 1px solid var(--vp-c-divider) !important;
}

/* Hide the Swagger logo/branding if desired */
.swagger-ui .topbar .topbar-wrapper::before {
  display: none;
}
</style>
