/**
 * Layout fixes from the 4.17.3 pre-release review, batch P4 (#4173 review).
 *
 * jsdom has no layout and no media queries, so each fix is pinned by resolving
 * the real sheet at the viewport the bug was seen on (see cssCascadeResolver).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createResolver,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
} from './cssCascadeResolver';

const sheet = (path: string) => createResolver(readFileSync(resolve(path), 'utf-8'));

describe('M8: shared ConfirmDialog panel scrolls on a short screen', () => {
  const css = sheet('src/components/shared/automation/ConfirmDialog.module.css');
  it.each([['landscape phone', LANDSCAPE_PHONE], ['desktop', DESKTOP]] as const)(
    'caps the panel to the viewport and scrolls it at %s',
    (_label, vp) => {
      expect(css('.panel', 'max-height', vp)).toBe('calc(100dvh - 2rem)');
      expect(css('.panel', 'overflow-y', vp)).toBe('auto');
    },
  );
});

describe('M11: MeshCore status bar buttons wrap instead of running off a phone', () => {
  const css = sheet('src/components/MeshCore/MeshCorePage.css');
  it.each([['portrait phone', PORTRAIT_PHONE], ['landscape phone', LANDSCAPE_PHONE]] as const)(
    'right group wraps and may shrink at %s',
    (_label, vp) => {
      expect(css('.meshcore-status-bar-right', 'flex-wrap', vp)).toBe('wrap');
      expect(css('.meshcore-status-bar-right', 'flex-shrink', vp)).toBe('1');
      expect(css('.meshcore-status-bar-right', 'min-width', vp)).toBe('0');
    },
  );

  it('desktop keeps the one-row, non-shrinking group', () => {
    expect(css('.meshcore-status-bar-right', 'flex-wrap', DESKTOP)).toBeNull();
    expect(css('.meshcore-status-bar-right', 'flex-shrink', DESKTOP)).toBe('0');
  });

  it('source title stays on one line and ellipsises', () => {
    const page = sheet('src/pages/SourcePageTopbar.module.css');
    expect(page('.logo .title', 'white-space', PORTRAIT_PHONE)).toBe('nowrap');
    expect(page('.logo .title', 'text-overflow', PORTRAIT_PHONE)).toBe('ellipsis');
    expect(page('.logo', 'min-width', PORTRAIT_PHONE)).toBe('0');
  });
});

describe('M12: legacy .modal-overlay covers the full width on a phone', () => {
  const css = sheet('src/App.css');
  it.each([['portrait phone', PORTRAIT_PHONE], ['small landscape phone', LANDSCAPE_SMALL_PHONE]] as const)(
    'App.css sets no stale 48px left offset at %s',
    (_label, vp) => {
      // The base rule (common/Modal.css) is `left: 0`; App.css must not move it.
      expect(css('.modal-overlay', 'left', vp)).toBeNull();
    },
  );
});

describe('M16: Meshtastic Channels header folds into the menu in phone landscape', () => {
  const css = sheet('src/App.css');
  it('hides the inline actions and MQTT toggle, shows the "more" menu at 844x390', () => {
    expect(css('.channels-controls .channel-actions', 'display', LANDSCAPE_PHONE)).toBe('none');
    expect(css('.channels-controls .mqtt-toggle', 'display', LANDSCAPE_PHONE)).toBe('none');
    expect(css('.channels-controls .channel-overflow', 'display', LANDSCAPE_PHONE)).toBe('block');
  });

  it('keeps the inline desktop controls on a desktop', () => {
    expect(css('.channels-controls .mqtt-toggle', 'display', DESKTOP)).toBeNull();
    expect(css('.channel-overflow', 'display', DESKTOP)).toBe('none');
  });

  it('keeps the inline-flex mobile rules for a narrow portrait phone', () => {
    expect(css('.channels-controls .channel-overflow', 'display', PORTRAIT_PHONE)).toBe('block');
  });

  it('trims the card padding around the message list at 844x390', () => {
    expect(css('.channel-conversation-section', 'padding', LANDSCAPE_PHONE)).toBe('0.35rem');
    expect(css('.channel-conversation', 'padding', LANDSCAPE_PHONE)).toBe('0.5rem');
    expect(css('.channel-conversation', 'padding', DESKTOP)).toBe('1rem');
  });
});

describe('L17: Packet Monitor pop-out uses a defined background token', () => {
  it('never references the undefined --bg-primary', () => {
    const src = readFileSync(resolve('src/pages/PacketMonitorPage.tsx'), 'utf-8');
    expect(src).not.toContain('--bg-primary');
    expect(src).toContain("background: 'var(--color-bg)'");
  });
});

describe('L22: unread divider lands clear of the Jump to Bottom pill', () => {
  it('scroll-margin-top clears the sticky pill (0.5rem offset + ~2.1rem tall)', () => {
    const css = sheet('src/components/messages/UnreadDivider.module.css');
    const value = css('.divider', 'scroll-margin-top', DESKTOP) ?? '';
    expect(value).toMatch(/rem$/);
    expect(parseFloat(value)).toBeGreaterThanOrEqual(3);
  });
});

describe('L33: MQTT Root Finder inputs are themed', () => {
  it('styles the inputs with role tokens, not browser defaults', () => {
    const css = sheet('src/components/MQTT/MqttRootFinder.module.css');
    expect(css('.field input', 'background', DESKTOP)).toBe('var(--color-surface-hover)');
    expect(css('.field input', 'color', DESKTOP)).toBe('var(--color-text)');
    expect(css('.field input', 'border', DESKTOP)).toMatch(/var\(--color-/);
  });
});

describe('L34: Days to View input follows the theme', () => {
  it('drops the hardcoded mocha colours for role tokens', () => {
    const src = readFileSync(resolve('src/components/Dashboard/components/DashboardFilters.tsx'), 'utf-8');
    expect(src).not.toMatch(/#1e1e2e|#cdd6f4|#45475a/i);
    const css = sheet('src/components/Dashboard/components/DashboardFilters.module.css');
    expect(css('.daysInput', 'background', DESKTOP)).toBe('var(--color-bg)');
    expect(css('.daysInput', 'color', DESKTOP)).toBe('var(--color-text)');
  });
});
