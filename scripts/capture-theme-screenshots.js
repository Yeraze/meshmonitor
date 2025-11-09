#!/usr/bin/env node

/**
 * Capture screenshots of MeshMonitor in all available themes
 * Requires: npm install puppeteer
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

const MESHMONITOR_URL = 'http://localhost:8080/meshmonitor/';
const OUTPUT_DIR = path.join(__dirname, '../docs/public/images/themes');

const viewports = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 375, height: 812 } // iPhone X size
];

const pages = [
  { name: 'nodes', path: '' },
  { name: 'channels', path: '?tab=channels' }
];

async function captureThemeScreenshots() {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('Starting browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const browserPage = await browser.newPage();

    console.log(`Connecting to ${MESHMONITOR_URL}...`);
    console.log('Using anonymous access (no authentication required)\n');

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
          const url = `${MESHMONITOR_URL}${pageInfo.path}`;

          try {
            // Navigate to the page
            await browserPage.goto(url, {
              waitUntil: 'networkidle0',
              timeout: 30000
            });

            // Wait for React app to render
            await browserPage.waitForSelector('#root', { timeout: 10000 });

            // Set the theme via localStorage before data loads
            await browserPage.evaluate((themeId) => {
              localStorage.setItem('theme', themeId);
              document.documentElement.setAttribute('data-theme', themeId);
            }, theme.id);

            // Wait for data to load (nodes, messages, etc.)
            await new Promise(resolve => setTimeout(resolve, 5000));

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
