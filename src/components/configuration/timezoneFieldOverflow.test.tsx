/**
 * @vitest-environment jsdom
 *
 * #5291 part 2: a long custom POSIX timezone
 * (`EST5EDT,M3.2.0/02:00:00,M11.1.0/02:00:00`) overflowed the Device Timezone
 * field on a phone and pushed the chevron outside its border.
 *
 * Two causes, both asserted here against the real source rather than a render
 * (jsdom does no layout, so it cannot see an overflow):
 *
 * 1. The label's flex wrapper had `flex: 1` and no `min-width: 0`, so it
 *    refused to shrink below the string's min-content width.
 * 2. The trigger carried an inline `width: 400px`, which beats any stylesheet
 *    and left the mobile rule fighting it with `!important`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createResolver, DESKTOP } from '../../styles/cssCascadeResolver';

const source = readFileSync(resolve('src/components/configuration/DeviceConfigSection.tsx'), 'utf-8');
const settingsCss = readFileSync(resolve('src/styles/settings.css'), 'utf-8');
const appCss = readFileSync(resolve('src/App.css'), 'utf-8');

describe('timezone trigger markup (#5291)', () => {
  it('lets the label wrapper shrink below its content width', () => {
    expect(source).toMatch(/flex:\s*1,\s*minWidth:\s*0/);
  });

  it('breaks the POSIX string, which has no spaces to wrap at', () => {
    const occurrences = source.match(/overflowWrap:\s*'anywhere'/g) ?? [];
    // The closed trigger, the "use custom value" row, and the preset rows'
    // value line — every place a raw POSIX string is shown.
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the chevron from shrinking', () => {
    expect(source).toMatch(/flexShrink:\s*0/);
  });

  it('no longer hardcodes the width inline, so the stylesheet owns sizing', () => {
    expect(source).not.toMatch(/width:\s*'400px'/);
  });

  it('gives the Role dropdown the same treatment (review follow-up)', () => {
    // It carried an inline `800px` on both trigger and menu, so it had the
    // same overflow waiting to be reported.
    expect(source).not.toMatch(/width:\s*'800px'/);
    expect(source).toMatch(/config-custom-dropdown--wide/);
    expect(source).toMatch(/config-custom-dropdown-menu--wide/);
  });
});

describe('timezone dropdown width (#5291)', () => {
  const resolveSettings = createResolver(settingsCss);

  it('is 400px on desktop, from the stylesheet rather than an inline style', () => {
    expect(resolveSettings('.config-custom-dropdown', 'width', DESKTOP)).toBe('400px');
    expect(resolveSettings('.config-custom-dropdown', 'max-width', DESKTOP)).toBe('100%');
  });

  it('caps the menu the same way, so a long value cannot widen it', () => {
    expect(resolveSettings('.config-custom-dropdown-menu', 'max-width', DESKTOP)).toBe('100%');
  });

  it('still narrows to the viewport on a phone', () => {
    // Asserted by pattern, not the resolver: App.css declares these two
    // selectors as one grouped rule and the resolver matches single selectors.
    const mobileBlock = appCss.slice(appCss.indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toMatch(
      /\.config-custom-dropdown,\s*\n\s*\.config-custom-dropdown-menu\s*\{[^}]*width:\s*100%\s*!important/
    );
  });
});
