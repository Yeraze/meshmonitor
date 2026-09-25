/**
 * Regression test for #5356: the position-history heading triangle must let
 * hover and click through to the position dot beneath it.
 *
 * The triangle is a Leaflet Marker with interactive={false} (mapHelpers.tsx),
 * rendered in the marker pane above the dot's overlay pane. A stylesheet rule
 * re-enabling pointer-events on the icon made it swallow the dot's tooltip and
 * popup. jsdom does no cascade, so this reads the stylesheet source, like the
 * other stylesheet assertions in this folder.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settingsCss = readFileSync(resolve('src/styles/settings.css'), 'utf-8');

function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

describe('position history heading triangle (#5356)', () => {
  it('ignores the pointer so the dot underneath keeps hover and click', () => {
    const body = ruleBody(settingsCss, '.leaflet-marker-icon.position-history-arrow-icon');
    expect(body).not.toBeNull();
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).not.toMatch(/pointer-events:\s*auto/);
    expect(body).not.toMatch(/cursor:\s*pointer/);
  });

  it('is still rendered as a non-interactive Marker', () => {
    const helpers = readFileSync(resolve('src/utils/mapHelpers.tsx'), 'utf-8');
    const arrow = helpers.slice(helpers.indexOf("className: 'position-history-arrow-icon'"));
    expect(arrow).toMatch(/interactive=\{false\}/);
  });
});
