#!/usr/bin/env node

/**
 * Capture screenshots of MeshMonitor in all available themes
 *
 * Requirements:
 * - npm install puppeteer
 * - Emoji fonts (for proper icon rendering):
 *   Ubuntu/Debian: sudo apt-get install fonts-noto-color-emoji
 *   Fedora/RHEL: sudo dnf install google-noto-emoji-fonts
 *   macOS: Emoji fonts included by default
 *
 * Usage: node scripts/capture-theme-screenshots.js
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const themes = [
  // Catppuccin
  { id: 'latte', name: 'Catppuccin Latte' },
  { id: 'frappe', name: 'Catppuccin Frappé' },
  { id: 'macchiato', name: 'Catppuccin Macchiato' },
  { id: 'mocha', name: 'Catppuccin Mocha' },
  // Popular
  { id: 'nord', name: 'Nord' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'solarized-dark', name: 'Solarized Dark' },
  { id: 'solarized-light', name: 'Solarized Light' },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark' },
  { id: 'gruvbox-light', name: 'Gruvbox Light' },
  // High Contrast
  { id: 'high-contrast-dark', name: 'High Contrast Dark' },
  { id: 'high-contrast-light', name: 'High Contrast Light' },
  // Color Blind Friendly
  { id: 'protanopia', name: 'Protanopia' },
  { id: 'deuteranopia', name: 'Deuteranopia' },
  { id: 'tritanopia', name: 'Tritanopia' }
];

// The dev container publishes 8081:3001 (docker-compose.dev.yml), so the old
// hardcoded :8080 pointed at nothing on a standard local deploy. Override with
// MESHMONITOR_URL when running against a different host/port.
const MESHMONITOR_URL = process.env.MESHMONITOR_URL || 'http://localhost:8081/meshmonitor/';
const OUTPUT_DIR = path.join(__dirname, '../docs/public/images/themes');

const viewports = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 375, height: 812 } // iPhone X size
];

// Tabs are path segments under /source/:sourceId/:tab (UIContext derives the
// active tab from location.pathname). The old `?tab=channels` query form is
// ignored, and `path: ''` lands on the sources dashboard rather than a node
// list — both silently produced the wrong screenshots. `:sourceId` is filled in
// at runtime from /api/sources.
const pages = [
  { name: 'nodes', path: 'source/:sourceId/nodes' },
  { name: 'channels', path: 'source/:sourceId/channels' }
];

/** Light themes must also flip appearanceMode, or the map keeps the dark tileset. */
const LIGHT_THEMES = new Set([
  'latte', 'solarized-light', 'gruvbox-light', 'high-contrast-light'
]);

/** Pick a source to screenshot: prefer a Meshtastic TCP source (richest node list). */
async function resolveSourceId(page, baseUrl) {
  const sources = await page.evaluate(async (u) => {
    const r = await fetch(`${u}api/sources`, { credentials: 'include' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : (j.data ?? []);
  }, baseUrl);
  if (!sources.length) throw new Error('no sources returned by /api/sources');
  const preferred = sources.find(s => s.type === 'meshtastic_tcp') ?? sources[0];
  console.log(`Using source: ${preferred.name} (${preferred.id})\n`);
  return preferred.id;
}

async function captureThemeScreenshots() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Starting browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--font-render-hinting=none',
      '--enable-font-antialiasing',
      '--disable-gpu'
    ]
  });

  try {
    const browserPage = await browser.newPage();

    console.log(`Connecting to ${MESHMONITOR_URL}...`);
    console.log('Using anonymous access (no authentication required)\n');

    await browserPage.goto(MESHMONITOR_URL, { waitUntil: 'networkidle0', timeout: 30000 });
    const sourceId = await resolveSourceId(browserPage, MESHMONITOR_URL);

    // Iterate through all combinations
    for (const theme of themes) {
      console.log(`\n📸 Capturing ${theme.name} (${theme.id})`);

      for (const viewport of viewports) {
        console.log(`  ${viewport.name === 'desktop' ? '🖥️ ' : '📱'} ${viewport.name} view`);

        // Set viewport
        await browserPage.setViewport({
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.name === 'mobile' ? 2 : 1
        });

        for (const pageInfo of pages) {
          const url = `${MESHMONITOR_URL}${pageInfo.path.replace(':sourceId', sourceId)}`;

          try {
            // Seed the theme BEFORE the app boots, then reload — SettingsContext
            // reads these on mount, so setting them after render leaves the map
            // tileset on whatever the previous appearance was.
            await browserPage.evaluate((themeId, isLight) => {
              const mode = isLight ? 'light' : 'dark';
              localStorage.setItem('appearanceMode', mode);
              localStorage.setItem(isLight ? 'lightTheme' : 'darkTheme', themeId);
              localStorage.setItem('theme', themeId);
            }, theme.id, LIGHT_THEMES.has(theme.id));

            await browserPage.goto(url, {
              waitUntil: 'networkidle0',
              timeout: 30000
            });

            // Wait for React app to render
            await browserPage.waitForSelector('#root', { timeout: 10000 });

            // Wait for data to load (nodes, messages, etc.)
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Assert the theme LAST. SettingsContext loads settings from the
            // server after mount and re-applies `data-theme` from them, so an
            // attribute set before the app settles is overwritten — that is why
            // light themes were rendering dark. Setting it after the settle,
            // immediately before the shot, is what actually sticks.
            await browserPage.evaluate((themeId) => {
              document.documentElement.setAttribute('data-theme', themeId);
            }, theme.id);
            await new Promise(resolve => setTimeout(resolve, 900));

            // Generate filename: theme-page-viewport.png
            const filename = `${theme.id}-${pageInfo.name}-${viewport.name}.png`;
            const screenshotPath = path.join(OUTPUT_DIR, filename);

            // Take screenshot
            await browserPage.screenshot({
              path: screenshotPath,
              fullPage: false
            });

            console.log(`    ✓ ${pageInfo.name}: ${filename}`);
          } catch (error) {
            console.error(`    ✗ Error capturing ${pageInfo.name}: ${error.message}`);
          }
        }
      }
    }

    console.log('\n\n✅ All screenshots captured successfully!');
    console.log(`📁 Screenshots saved to: ${OUTPUT_DIR}`);
    console.log(`📊 Total screenshots: ${themes.length * viewports.length * pages.length}`);

  } catch (error) {
    console.error('Error during screenshot capture:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the script
captureThemeScreenshots().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
