/**
 * Back-to-Dashboard navigation guard (#4447).
 *
 * `DashboardPage` skips its default-landing-page redirect only when it is
 * navigated to with `location.state.showList === true`
 * (`DashboardPage.tsx`, "default landing page redirect"). Every button that
 * sends the user back to the dashboard must therefore carry that flag —
 * otherwise a deployment with a configured default landing page bounces the
 * user straight back out of the dashboard they just asked for.
 *
 * Five buttons shipped without it (#4447, reported by matt via Discord). The
 * Automation Engine's was worse than a missing flag: it used
 * `window.location.href`, a full page load, which cannot carry router state at
 * all and so redirected unconditionally.
 *
 * This reads the source rather than rendering, deliberately. The five pages
 * live behind very different provider stacks, and the property under test is
 * one line in each — a regex guard covers all five for the cost of one cheap
 * test, and it fails for a NEW page that gets the same thing wrong. Rendered
 * behavior for the toolbar button is asserted in
 * `MapAnalysisToolbar.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

/** Every source file with a "back to the dashboard" control. */
const BACK_TO_DASHBOARD_SOURCES = [
  'components/MapAnalysis/MapAnalysisToolbar.tsx',
  'pages/ReportsPage.tsx',
  'pages/UsersPage.tsx',
  'pages/GlobalSettingsPage.tsx',
  'components/automations/AutomationsPage.tsx',
];

const read = (rel: string) => readFileSync(resolve(srcRoot, rel), 'utf8');

/** `navigate('/')` — with any quote style and optional whitespace — carrying
 *  no second argument, i.e. no state. */
const BARE_ROOT_NAVIGATE = /navigate\(\s*['"`]\/['"`]\s*\)/;

/** A hard navigation to the app root. Cannot carry router state, so it always
 *  triggers the redirect. */
const HARD_ROOT_NAVIGATION = /(?:window\.)?location\.(?:href|assign|replace)\s*[=(]\s*[`'"]?\$\{appBasename\}\//;

describe('back-to-dashboard navigation (#4447)', () => {
  it.each(BACK_TO_DASHBOARD_SOURCES)('%s passes showList when navigating to the dashboard', (rel) => {
    const source = read(rel);

    expect(source).toMatch(/navigate\(\s*['"`]\/['"`]\s*,\s*\{\s*state:\s*\{\s*showList:\s*true/);
  });

  it.each(BACK_TO_DASHBOARD_SOURCES)('%s has no stateless navigate("/")', (rel) => {
    expect(read(rel)).not.toMatch(BARE_ROOT_NAVIGATE);
  });

  it.each(BACK_TO_DASHBOARD_SOURCES)('%s does not hard-navigate to the app root', (rel) => {
    // A full page load drops router state entirely, so the dashboard can never
    // see showList and redirects every time (#4447 item 5).
    expect(read(rel)).not.toMatch(HARD_ROOT_NAVIGATION);
  });

  it('DashboardPage still keys its redirect skip on location.state.showList', () => {
    // If this contract ever moves, the guards above are testing nothing.
    expect(read('pages/DashboardPage.tsx')).toMatch(/state\s+as\s+\{\s*showList\?:\s*boolean/);
  });
});
