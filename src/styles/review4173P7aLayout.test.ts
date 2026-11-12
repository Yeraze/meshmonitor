/**
 * Layout fixes from the 4.17.3 pre-release review, batch P7a (live re-pass
 * findings N1, N3, N7, N9, N10, N11, N12).
 *
 * jsdom has no layout and no media queries, so each CSS fix is pinned by
 * resolving the real sheet at the viewport the bug was seen on. Selector-list
 * rules (`a, b { }`) and selectors with `:global(...)` / `+` are beyond the
 * shared resolver's single-selector regex, so this file resolves by exact
 * selector match within each rule's comma list, last declaration winning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  topLevelBlocks,
  mediaMatches,
  PORTRAIT_PHONE,
  LANDSCAPE_PHONE,
  LANDSCAPE_SMALL_PHONE,
  DESKTOP,
  type Viewport,
} from './cssCascadeResolver';

const read = (path: string) => readFileSync(resolve(path), 'utf-8');

/** `(selector, property, viewport) => value | null`, source order decides. */
function sheet(path: string) {
  const blocks = topLevelBlocks(read(path));
  return (selector: string, property: string, vp: Viewport): string | null => {
    let winner: string | null = null;
    for (const block of blocks) {
      if (block.condition !== null && !mediaMatches(block.condition, vp)) continue;
      const ruleRe = /([^{}]+)\{([^}]*)\}/g;
      let rule: RegExpExecArray | null;
      while ((rule = ruleRe.exec(block.body)) !== null) {
        const selectors = rule[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
        if (!selectors.includes(selector)) continue;
        const declRe = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g');
        let decl: RegExpExecArray | null;
        while ((decl = declRe.exec(rule[2])) !== null) winner = decl[1].trim();
      }
    }
    return winner;
  };
}

describe('N1: Reticulum and MeshCore Ingest titles share the one-line source title', () => {
  const css = sheet('src/pages/SourcePageTopbar.module.css');

  it.each([['portrait phone', PORTRAIT_PHONE], ['landscape phone', LANDSCAPE_PHONE]] as const)(
    'the shared title stays on one line and ellipsises at %s',
    (_label, vp) => {
      expect(css('.logo .title', 'white-space', vp)).toBe('nowrap');
      expect(css('.logo .title', 'text-overflow', vp)).toBe('ellipsis');
      expect(css('.logo .title', 'overflow', vp)).toBe('hidden');
      expect(css('.logo', 'min-width', vp)).toBe('0');
    },
  );

  it.each([
    'src/pages/ReticulumSourcePage.tsx',
    'src/pages/MeshCoreIngestSourcePage.tsx',
    'src/pages/MeshCoreSourcePage.tsx',
  ])('%s uses the shared module, not a copy', (path) => {
    const src = read(path);
    expect(src).toMatch(/from '\.\/SourcePageTopbar\.module\.css'/);
    // Every source-name title carries the module class.
    const titles = src.match(/className=\{?[`"][^`"]*dashboard-topbar-title[^`"]*[`"]/g) ?? [];
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) expect(t).toMatch(/\.title\}/);
  });
});

describe('N3: wide Reticulum tables scroll with an edge cue', () => {
  const css = sheet('src/components/common/HorizontalScroll.module.css');

  it('the shared scroll box scrolls sideways', () => {
    expect(css('.scroll', 'overflow-x', PORTRAIT_PHONE)).toBe('auto');
  });

  it('fades whichever edge still hides content', () => {
    expect(css(".scroll[data-overflow-end='true']", 'mask-image', PORTRAIT_PHONE)).toMatch(/transparent 100%\)$/);
    expect(css(".scroll[data-overflow-start='true']", 'mask-image', PORTRAIT_PHONE)).toMatch(/^linear-gradient\(to right, transparent 0/);
  });
});

describe('N7: legacy .modal-overlay dialogs stack above the app header', () => {
  // common/Modal.css puts .modal-overlay at 10001, above the app header
  // (10000). An inline zIndex below that drops the dialog under the header,
  // which stayed undimmed and tappable at 390px (Import/Export Configuration).
  const tsxFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return tsxFiles(p);
      return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
    });

  it('base rule sits above the header', () => {
    const modal = sheet('src/components/common/Modal.css');
    expect(Number(modal('.modal-overlay', 'z-index', PORTRAIT_PHONE))).toBeGreaterThan(10000);
  });

  it('no .modal-overlay element overrides the z-index inline with a lower value', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(resolve('src'))) {
      const src = readFileSync(file, 'utf-8');
      const re = /className="modal-overlay"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        // The rest of this element's opening tag: up to a `>` that closes it,
        // either on its own line or right after the last attribute.
        const rest = src.slice(m.index, m.index + 600);
        const tagEnd = rest.search(/\n\s*>|\}\}\s*>|"\s*>/);
        const tag = tagEnd === -1 ? rest : rest.slice(0, tagEnd + 3);
        const z = /zIndex:\s*(\d+)/.exec(tag);
        if (z && Number(z[1]) <= 10000) offenders.push(`${file}: zIndex ${z[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('N9: Meshtastic rail fits a 1440x900 desktop', () => {
  // Measured live as admin: 16 nav items need 686px; the list had 664px.
  // The trims below give back 28px (12 sidebar floor, 8 footer padding, 8
  // footer button padding) plus 4px from the controls, and the list then fits
  // with ~18px to spare.
  it('desktop sidebar floor is 4px, not 1rem, outside a safe-area inset', () => {
    const css = sheet('src/components/Sidebar.css');
    expect(css('.sidebar', 'padding-bottom', DESKTOP)).toBe('max(4px, env(safe-area-inset-bottom))');
    expect(css('.sidebar-controls', 'padding', DESKTOP)).toBe('0 8px 4px 8px');
  });

  it('the collapsed footer grid is trimmed', () => {
    const css = sheet('src/components/SidebarFooter.module.css');
    expect(css('.narrow', 'padding', DESKTOP)).toBe('4px 4px');
    expect(css('.narrow .btn', 'padding', DESKTOP)).toBe('2px');
  });
});

describe('N10: Connection Error banner is compact in short landscape', () => {
  const css = sheet('src/components/ConnectionErrorPanel.module.css');

  it('puts heading and buttons on one row and clamps the message at 844x390', () => {
    expect(css('.panel.panel', 'display', LANDSCAPE_PHONE)).toBe('flex');
    expect(css('.panel.panel', 'padding', LANDSCAPE_PHONE)).toBe('0.4rem 0.75rem');
    // Capped and scrollable, not clamped: a clamp hides the end of a long
    // error on touch, where the title tooltip never opens.
    expect(css('.panel .message', 'max-height', LANDSCAPE_PHONE)).toBe('2.6em');
    expect(css('.panel .message', 'overflow-y', LANDSCAPE_PHONE)).toBe('auto');
    expect(css('.panel .message', 'flex-basis', LANDSCAPE_PHONE)).toBe('100%');
    expect(css('.panel .actions', 'margin-left', LANDSCAPE_SMALL_PHONE)).toBe('auto');
  });

  it('leaves the desktop and portrait layout to the base rules', () => {
    expect(css('.panel.panel', 'display', DESKTOP)).toBeNull();
    expect(css('.panel.panel', 'display', PORTRAIT_PHONE)).toBeNull();
  });

  it('App.tsx renders the extracted panel', () => {
    const src = read('src/App.tsx');
    expect(src).toMatch(/<ConnectionErrorPanel\b/);
    expect(src).not.toMatch(/<h3>Connection Error<\/h3>/);
  });
});

describe('N11: schedule table actions stay on screen', () => {
  const css = sheet('src/components/MeshCore/MeshCoreNodeScheduleTable.module.css');

  it.each([['portrait phone', PORTRAIT_PHONE], ['desktop', DESKTOP]] as const)(
    'pins the Actions column to the right edge at %s',
    (_label, vp) => {
      for (const sel of ['.table th:last-child', '.table td:last-child']) {
        expect(css(sel, 'position', vp)).toBe('sticky');
        expect(css(sel, 'right', vp)).toBe('0');
        // Opaque, or the scrolled columns show through.
        expect(css(sel, 'background', vp)).toBe('var(--color-bg)');
      }
    },
  );

  it.each([
    'src/components/MeshCore/MeshCoreRemoteTelemetrySection.tsx',
    'src/components/MeshCore/MeshCoreTimeSyncSection.tsx',
  ])('Actions is the last column of %s', (path) => {
    const src = read(path);
    const heads = [...src.matchAll(/<th>\{t\('([^']+)'/g)].map((m) => m[1]);
    expect(heads[heads.length - 1]).toBe('common.actions');
  });
});

describe('N12: unread scroll clears the date label above the divider', () => {
  const css = sheet('src/components/messages/UnreadDivider.module.css');

  it('keeps the L22 clearance for a bare divider', () => {
    expect(parseFloat(css('.divider', 'scroll-margin-top', DESKTOP) ?? '')).toBeGreaterThanOrEqual(3);
  });

  it.each([':global(.date-separator) + .divider', ':global(.mc-date-separator) + .divider'])(
    'adds the date label run when %s',
    (sel) => {
      const value = css(sel, 'scroll-margin-top', PORTRAIT_PHONE) ?? '';
      expect(value).toMatch(/rem$/);
      // Measured: pill bottom 52px below the list top, label top 42px above
      // the divider. 6rem left 1.5px; require at least 6.5rem.
      expect(parseFloat(value)).toBeGreaterThanOrEqual(6.5);
    },
  );
});
