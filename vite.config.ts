import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'path'
import { readFile } from 'fs/promises'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Turn a filesystem path into the form Vite uses for module ids: forward
 * slashes on every platform.
 *
 * `path.resolve` returns backslashes on Windows (`D:\a\repo\src\main.tsx`),
 * while the ids Vite hands to plugin hooks always use forward slashes
 * (`D:/a/repo/src/main.tsx`). Comparing one to the other never matches there
 * (#5558). Vite's own `normalizePath` only swaps separators when it runs on
 * Windows, so it cannot be tested from Linux CI; this does the same job on
 * any host.
 */
export function toModuleId(file: string): string {
  return file.replace(/\\/g, '/')
}

const stripQuery = (id: string) => id.replace(/[?#].*$/, '')

/** True when a Vite module id names the eager-styles placeholder module. */
export function isEagerStylesId(id: string, eagerStyles: string): boolean {
  return toModuleId(stripQuery(id)) === toModuleId(eagerStyles)
}

export interface EagerCssOptions {
  /** The app entry holding the `lazy(() => import(...))` route pages. */
  entry?: string
  /** The placeholder module this plugin fills in. */
  eagerStyles?: string
  /** File reader, replaceable in tests. */
  read?: (file: string) => Promise<string>
}

/**
 * Keep every stylesheet eager, and in its pre-split cascade order, after the
 * route pages in `src/main.tsx` became `React.lazy` chunks.
 *
 * Before the split, every page was a static import, so all CSS shipped in one
 * upfront sheet in import order. The global sheets (`src/styles/*.css`,
 * `App.css`, ...) share class names (`.node-name`, `.export-menu`,
 * `.detail-row`, ...) and pages lean on rules defined by other pages' sheets.
 * Letting each lazy chunk bring its own CSS would change which rule wins and
 * drop rules a page relied on.
 *
 * So this plugin fills `src/eagerStyles.ts` (imported by main.tsx where the
 * pages used to be) with a side-effect import of every CSS file the lazy pages
 * reach through static imports, in the order the old static graph ran them:
 * a depth-first walk of each page's imports in source order, roots taken from
 * the `lazy(() => import(...))` calls in main.tsx. Only JS moves into lazy
 * chunks; the CSS stays in the entry sheet. Imports of a module from inside a
 * page's own `import()` are not followed, matching the old build.
 *
 * The plugin must never do nothing quietly (#5558). On Windows it once failed
 * to recognise its own module id, left the placeholder empty, and shipped a
 * build whose landing page had no theme rules: a white page. Two guards now
 * fail the build instead: `load` throws when the walk finds no stylesheet, and
 * `buildEnd` throws when `load` never ran for the placeholder at all.
 */
export function eagerCss(options: EagerCssOptions = {}): Plugin {
  const entry = toModuleId(options.entry ?? resolve(__dirname, 'src/main.tsx'))
  const eagerStyles = toModuleId(options.eagerStyles ?? resolve(__dirname, 'src/eagerStyles.ts'))
  const read = options.read ?? ((file: string) => readFile(file, 'utf8'))
  // `import 'x'`, or `import|export ... from 'x'` (multi-line lists allowed;
  // `(` and `=` never occur in an import list, so a declaration such as
  // `export function f() {` cannot run on into a later string literal).
  const IMPORT_RE =
    /^\s*(?:import\s*|(?:import|export)\s+(type\s+)?[^'";()=]*?\sfrom\s*)['"]([^'"]+)['"]/gm
  const LAZY_RE = /lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g
  let isBuild = false
  // Stylesheets the last `load` of the placeholder emitted; null = never ran.
  let emitted: number | null = null
  return {
    name: 'meshmonitor-eager-css',
    configResolved(config) {
      isBuild = config.command === 'build'
    },
    buildStart() {
      emitted = null
    },
    async load(id) {
      if (!isEagerStylesId(id, eagerStyles)) return null
      const seen = new Set<string>()
      const css: string[] = []
      const walk = async (rawFile: string): Promise<void> => {
        const file = toModuleId(rawFile)
        if (seen.has(file)) return
        seen.add(file)
        if (/\.css$/.test(file)) {
          css.push(file)
          return
        }
        if (!/\.[cm]?[jt]sx?$/.test(file) || file.includes('/node_modules/')) return
        const code = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, '')
        for (const m of code.matchAll(IMPORT_RE)) {
          if (m[1]) continue // `import type` is erased at compile time
          const resolved = await this.resolve(m[2], file)
          if (resolved && !resolved.external) await walk(stripQuery(resolved.id))
        }
      }
      const entryCode = await read(entry)
      for (const m of entryCode.matchAll(LAZY_RE)) {
        const resolved = await this.resolve(m[1], entry)
        if (resolved) await walk(stripQuery(resolved.id))
      }
      emitted = css.length
      if (css.length === 0) {
        this.error(
          `meshmonitor-eager-css: found no stylesheet to keep eager while filling ${eagerStyles}. ` +
            `The walk starts at the lazy(() => import(...)) pages in ${entry}; without their CSS in the ` +
            `entry sheet the landing page has no theme rules and renders white (#5558).`,
        )
      }
      // Vite marks CSS modules side-effect free, so a bare `import 'x.module.css'`
      // would be tree-shaken and its CSS left in the lazy chunk. Binding and
      // retaining each one keeps it (and its CSS) in the entry.
      const lines = css.map((f, i) =>
        /\.module\.css$/.test(f)
          ? `import m${i} from ${JSON.stringify(f)};`
          : `import ${JSON.stringify(f)};`,
      )
      const modules = css.flatMap((f, i) => (/\.module\.css$/.test(f) ? [`m${i}`] : []))
      lines.push(`globalThis.__meshmonitorEagerCss = [${modules.join(', ')}];`)
      return lines.join('\n')
    },
    buildEnd(error) {
      // A dev server loads modules on demand, so "never loaded" means nothing
      // there. An earlier build error is the real story; do not bury it.
      if (!isBuild || error || emitted !== null) return
      this.error(
        `meshmonitor-eager-css: the build ended without loading ${eagerStyles}, so no stylesheet was ` +
          `kept eager. Either ${entry} no longer imports it, or its module id did not match ` +
          `(path separators, #5558). The landing page would render white.`,
      )
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    eagerCss(),
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
        // Every route page is a lazy chunk (src/main.tsx), so no single asset
        // comes near this cap any more (largest is ~1.4 MB). Workbox silently
        // skips precaching files above it, so a build that outgrows it should
        // split further rather than raise the cap.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 // 4 MiB
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  // Always build for root - runtime HTML rewriting will handle BASE_URL
  base: '/',
  experimental: {
    // URLs that JS builds at runtime (lazy-chunk preload deps, imported asset
    // URLs) resolve against the importing chunk's `import.meta.url` instead of
    // the root-absolute `base`. The server rewrites `/assets/` only inside HTML
    // (src/server/utils/htmlRewriter.ts), so with `base: '/'` a lazy route's
    // CSS/JS preload would request `/assets/...` and 404 under a BASE_URL
    // subpath such as `/meshmonitor`. HTML and CSS keep the default.
    // `experimental` API, verified on Vite 8.3. After a Vite upgrade, check
    // that no JS chunk in dist/assets holds a quoted root-absolute `/assets/`
    // string (`/api/assets/...` API paths are fine).
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === 'js' ? { relative: true } : undefined
    },
  },
  // MapLibre v6 loads its bundled worker with `{ type: 'module' }`, so Vite must
  // emit worker chunks in ES format rather than the default IIFE (#4800).
  worker: {
    format: 'es',
  },
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
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html'),
      },
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