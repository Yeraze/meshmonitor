#!/usr/bin/env node

/**
 * Capture documentation screenshots of MeshMonitor UI
 *
 * Rerun this script any time the UI changes to refresh the docs site images.
 * The screenshot list below is the single source of truth — add, remove, or
 * reorder entries and rerun to update.
 *
 * Prerequisites:
 *   - Dev instance running on the configured port
 *   - npm install (puppeteer is a devDependency)
 *
 * Usage:
 *   node scripts/capture-doc-screenshots.js                    # defaults
 *   node scripts/capture-doc-screenshots.js --port 8080        # custom port
 *   node scripts/capture-doc-screenshots.js --base /           # no base URL prefix
 *   node scripts/capture-doc-screenshots.js --user admin --pass changeme1
 *   node scripts/capture-doc-screenshots.js --only features    # just one category
 *   node scripts/capture-doc-screenshots.js --only packet-monitor.png  # single file
 *   node scripts/capture-doc-screenshots.js --list             # print all shots, don't capture
 *
 * Output directories (relative to repo root):
 *   docs/public/images/           ← homepage hero images (main.png, etc.)
 *   docs/public/images/features/  ← feature page screenshots
 *   docs/public/images/configuration/ ← config page screenshots
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const getArg = (name, defaultVal) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
};

const PORT      = getArg('port', '8081');
const BASE      = getArg('base', '/meshmonitor');
const BASE_URL  = `http://localhost:${PORT}${BASE}`;
const ADMIN_USER = getArg('user', 'admin');
const ADMIN_PASS = getArg('pass', 'changeme1');
const ONLY      = getArg('only', '');       // filter by category or filename
const LIST_ONLY = hasFlag('list');

// Output directories
const DIRS = {
  homepage:      path.join(__dirname, '../docs/public/images'),
  features:      path.join(__dirname, '../docs/public/images/features'),
  configuration: path.join(__dirname, '../docs/public/images/configuration'),
};

// ---------------------------------------------------------------------------
// Screenshot definitions
//
// Each entry produces one PNG. To add a new screenshot:
//   1. Add an entry here with name, dir, hash, and desc
//   2. Optionally add before/after hooks for interactions (scroll, toggle, etc.)
//   3. Rerun the script
//   4. Reference the image in docs as /images/{dir}/{name}
//
// Fields:
//   name   – output filename (*.png)
//   dir    – output subdirectory key (homepage | features | configuration)
//   hash   – URL hash to navigate to (#nodes, #settings, etc.)
//   desc   – human-readable description (shown during capture)
//   before – async fn(page) run before screenshot (optional)
//   after  – async fn(page) cleanup after screenshot (optional)
// ---------------------------------------------------------------------------
const SCREENSHOTS = [

  // ── Homepage hero images ─────────────────────────────────────────────
  { name: 'main.png',          dir: 'homepage', hash: 'nodes',         desc: 'Main nodes/map view' },
  { name: 'channels.png',      dir: 'homepage', hash: 'channels',      desc: 'Channels tab' },
  { name: 'dashboard.png',     dir: 'homepage', hash: 'dashboard',     desc: 'Dashboard widgets' },
  { name: 'device-config.png', dir: 'homepage', hash: 'configuration', desc: 'Device configuration' },

  // ── Feature pages ─────────────────────────────────────────────────────
  { name: 'nodes-map.png',      dir: 'features', hash: 'nodes',          desc: 'Interactive map with nodes' },
  { name: 'channels.png',       dir: 'features', hash: 'channels',       desc: 'Channel messaging' },
  { name: 'messages.png',       dir: 'features', hash: 'messages',       desc: 'Direct messages' },
  { name: 'dashboard.png',      dir: 'features', hash: 'dashboard',      desc: 'Dashboard widgets' },
  { name: 'settings.png',       dir: 'features', hash: 'settings',       desc: 'Settings panel' },
  { name: 'automation.png',     dir: 'features', hash: 'automation',     desc: 'Automation rules' },
  { name: 'device-config.png',  dir: 'features', hash: 'configuration',  desc: 'Device configuration' },
  { name: 'notifications.png',  dir: 'features', hash: 'notifications',  desc: 'Notification setup' },
  { name: 'security.png',       dir: 'features', hash: 'security',       desc: 'Security scanner' },
  { name: 'users.png',          dir: 'features', hash: 'users',          desc: 'User management' },
  { name: 'audit-log.png',      dir: 'features', hash: 'audit',          desc: 'Audit log' },
  { name: 'admin-commands.png', dir: 'features', hash: 'admin',          desc: 'Admin commands' },
  {
    name: 'packet-monitor.png',
    dir: 'features',
    hash: 'nodes',
    desc: 'Packet monitor panel',
    before: async (page) => {
      await page.evaluate(() => localStorage.setItem('showPacketMonitor', 'true'));
      await page.reload({ waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 3000));
    },
    after: async (page) => {
      await page.evaluate(() => localStorage.setItem('showPacketMonitor', 'false'));
    },
  },

  {
    name: 'link-quality.png',
    dir: 'features',
    hash: 'messages',
    desc: 'Link Quality & Smart Hops',
    before: async (page) => {
      // Click the first node in the DM list to open its telemetry panel
      await page.evaluate(() => {
        const nodeItem = document.querySelector('.node-item');
        if (nodeItem) nodeItem.click();
      });
      await new Promise(r => setTimeout(r, 3000));
      // Scroll to the Link Quality / Smart Hops graphs area
      await page.evaluate(() => {
        // Look for the graph section headers or the graph containers
        const candidates = [
          ...document.querySelectorAll('h3, h4, .graph-title, .chart-title, text')
        ];
        for (const el of candidates) {
          const text = el.textContent?.toLowerCase() || '';
          if (text.includes('link quality') || text.includes('smart hop')) {
            el.scrollIntoView({ behavior: 'instant', block: 'start' });
            return;
          }
        }
        // Fallback: scroll the right panel down significantly
        const panel = document.querySelector('.dm-right-panel, .message-detail, .telemetry-section');
        if (panel) panel.scrollTop = panel.scrollHeight;
      });
      await new Promise(r => setTimeout(r, 2000));
    },
  },

  // ── Configuration pages ───────────────────────────────────────────────
  {
    name: 'channel-database.png',
    dir: 'features',
    hash: 'configuration',
    desc: 'Channel Database config',
    before: async (page) => {
      await page.evaluate(() => {
        const el = document.getElementById('config-channel-database');
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      });
      await new Promise(r => setTimeout(r, 1000));
    },
    clip: '#config-channel-database',
  },
  {
    name: 'settings-backup.png',
    dir: 'configuration',
    hash: 'settings',
    desc: 'Backup & restore section',
    before: async (page) => {
      await page.evaluate(() => {
        for (const h of document.querySelectorAll('h3, h4, .section-header, button')) {
          if (h.textContent?.toLowerCase().includes('backup')) {
            h.scrollIntoView({ behavior: 'instant', block: 'start' });
            return;
          }
        }
      });
      await new Promise(r => setTimeout(r, 1000));
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the instance to respond before launching the browser. */
async function waitForInstance(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Instance at ${url} did not respond within ${timeoutMs / 1000}s`);
}

/** Authenticate as admin and reload the page with the new session. */
async function login(page) {
  console.log(`  Logging in as ${ADMIN_USER}...`);

  // Load app to establish a session cookie
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#root', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 2000));

  // Fetch CSRF token
  const csrfToken = await page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/csrf-token`, { credentials: 'include' });
    const json = await res.json();
    return json.csrfToken;
  }, BASE_URL);

  // POST login
  const result = await page.evaluate(async (base, user, pass, token) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ username: user, password: pass }),
    });
    return { ok: res.ok, status: res.status };
  }, BASE_URL, ADMIN_USER, ADMIN_PASS, csrfToken);

  if (!result.ok) throw new Error(`Login failed (HTTP ${result.status})`);
  console.log('  Authenticated ✓');

  // Reload so the React app picks up the authenticated session
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForSelector('#root', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 3000));

  // Dismiss the news popup: check "don't show again", then click Close
  await page.evaluate(() => {
    const overlay = document.querySelector('.news-modal-overlay');
    if (!overlay) return;
    const checkbox = overlay.querySelector('.news-dont-show-checkbox input[type="checkbox"]');
    if (checkbox && !checkbox.checked) checkbox.click();
    // Click through all news items until the last "Close" button
    const clickNext = () => {
      const btn = overlay.querySelector('.news-button-primary');
      if (btn) { btn.click(); return true; }
      return false;
    };
    // Click up to 20 times to get through all news items
    for (let i = 0; i < 20 && clickNext(); i++) { /* keep clicking Next/Close */ }
  });
  await new Promise(r => setTimeout(r, 1000));
}

/** Filter the screenshot list by --only flag. */
function filterScreenshots(shots, filter) {
  if (!filter) return shots;
  return shots.filter(s =>
    s.dir === filter ||
    s.name === filter ||
    s.name === `${filter}.png`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const shots = filterScreenshots(SCREENSHOTS, ONLY);

  if (shots.length === 0) {
    console.error(`No screenshots match --only "${ONLY}". Use --list to see all.`);
    process.exit(1);
  }

  // --list: print and exit
  if (LIST_ONLY) {
    console.log(`\n  ${shots.length} screenshot(s):\n`);
    for (const s of shots) {
      console.log(`  ${s.dir.padEnd(15)} ${s.name.padEnd(25)} ${s.desc}`);
    }
    console.log();
    process.exit(0);
  }

  // Ensure output directories exist
  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Pre-flight: make sure the instance is up
  console.log(`\nMeshMonitor Doc Screenshot Tool`);
  console.log(`───────────────────────────────`);
  console.log(`  Target:      ${BASE_URL}`);
  console.log(`  Screenshots: ${shots.length}`);
  console.log(`  Output:      docs/public/images/\n`);

  console.log('Waiting for instance...');
  await waitForInstance(`${BASE_URL}/`);
  console.log('  Instance ready ✓');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--font-render-hinting=none',
      '--enable-font-antialiasing',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

    await login(page);

    let captured = 0;
    let failed = 0;
    const errors = [];

    console.log();
    for (const shot of shots) {
      const outputDir = DIRS[shot.dir];
      const outputPath = path.join(outputDir, shot.name);
      const label = `${shot.dir}/${shot.name}`;

      try {
        process.stdout.write(`  ${shot.desc.padEnd(30)} `);

        await page.goto(`${BASE_URL}/#${shot.hash}`, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });
        await page.waitForSelector('#root', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 5000));

        if (shot.before) await shot.before(page);

        if (shot.clip) {
          // Element-level screenshot — captures just the matched element
          const el = await page.$(shot.clip);
          if (el) {
            await el.screenshot({ path: outputPath });
          } else {
            await page.screenshot({ path: outputPath, fullPage: false });
          }
        } else {
          await page.screenshot({ path: outputPath, fullPage: false });
        }
        captured++;

        const sizeKB = (fs.statSync(outputPath).size / 1024).toFixed(0);
        console.log(`✓  ${label}  (${sizeKB} KB)`);

        if (shot.after) await shot.after(page);
      } catch (err) {
        console.log(`✗  ${label}`);
        errors.push({ label, error: err.message });
        failed++;
      }
    }

    // Summary
    console.log(`\n───────────────────────────────`);
    console.log(`  Captured: ${captured}   Failed: ${failed}   Total: ${shots.length}`);
    if (errors.length > 0) {
      console.log(`\n  Errors:`);
      for (const e of errors) {
        console.log(`    ${e.label}: ${e.error}`);
      }
    }
    console.log();

    if (failed > 0) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
