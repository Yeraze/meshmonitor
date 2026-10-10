/**
 * Phone layout of the Map Analysis detail pane, and where the time slider sits
 * next to the open Map controls panel.
 *
 * jsdom applies no stylesheet, so these read the real rules and resolve them at
 * concrete viewports with the shared cascade resolver, as MapToolPanels.css.test.ts
 * does. The DOM order the slider's sibling selector relies on (controls panel
 * first, one parent) is pinned in MapAnalysisCanvas.test.tsx.
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
} from '../../styles/cssCascadeResolver';

const read = (p: string) => readFileSync(resolve(p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
// The resolver matches plain selectors; unwrap the CSS-module `:global()`.
const unwrap = (css: string) => css.replace(/:global\((\.[\w-]+)\)/g, '$1');

const inspectorCss = unwrap(read('src/components/MapAnalysis/AnalysisInspectorPanel.module.css'));
const sliderCss = unwrap(read('src/components/MapAnalysis/TimeSliderControl.module.css'));
const globalCss = read('src/styles/map-analysis.css');

const inspector = createResolver(inspectorCss);
const base = createResolver(globalCss);
const slider = createResolver(sliderCss);
const SHEET = '.map-analysis-inspector.sheet';
const BESIDE = '.map-sidebar ~ .slider';

describe('detail pane', () => {
  it('stays a fixed 340px column on desktop', () => {
    expect(base('.map-analysis-inspector', 'flex', DESKTOP)).toBe('0 0 340px');
    expect(inspector('.body', 'flex-direction', DESKTOP)).toBeNull();
    expect(inspector(SHEET, 'flex', DESKTOP)).toBeNull();
  });

  it('docks under the map on a portrait phone, capped so the map keeps most of the height', () => {
    expect(inspector('.body', 'flex-direction', PORTRAIT_PHONE)).toBe('column');
    expect(inspector(SHEET, 'flex', PORTRAIT_PHONE)).toBe('0 0 auto');
    expect(inspector(SHEET, 'max-height', PORTRAIT_PHONE)).toBe('45%');
    expect(inspector(SHEET, 'border-left', PORTRAIT_PHONE)).toBe('none');
    expect(inspector('.body > .map-analysis-canvas', 'min-height', PORTRAIT_PHONE)).toBe('0');
  });

  it.each([
    ['landscape phone', LANDSCAPE_PHONE],
    // Matches both phone blocks; the landscape one must win.
    ['small landscape phone', LANDSCAPE_SMALL_PHONE],
  ])('docks beside the map, narrower than desktop, on a %s', (_name, vp) => {
    expect(inspector('.body', 'flex-direction', vp)).toBe('row');
    expect(inspector(SHEET, 'flex', vp)).toBe('0 0 min(300px, 40%)');
    expect(inspector(SHEET, 'max-height', vp)).toBe('none');
  });
});

describe('time slider', () => {
  it('lives in its module now, not the global sheet', () => {
    expect(globalCss).not.toMatch(/\.map-analysis-time-slider\s*\{/);
    expect(slider('.slider', 'position', DESKTOP)).toBe('absolute');
    expect(slider('.slider', 'left', DESKTOP)).toBe('50%');
    expect(slider('.slider', 'z-index', DESKTOP)).toBe('2000');
    expect(sliderCss).not.toMatch(/300px|310px/);
  });

  it('centres in the map area left of the open controls panel on desktop', () => {
    expect(slider(BESIDE, 'left', DESKTOP)).toBe(
      'calc((100% - 2 * var(--map-sidebar-inset) - var(--map-sidebar-width)) / 2)',
    );
    expect(slider(BESIDE, 'width', DESKTOP)).toBe(
      'min(520px, calc(100% - 2 * var(--map-sidebar-inset) - var(--map-sidebar-width) - 24px))',
    );
  });

  it('drops under the full controls sheet on a portrait phone', () => {
    expect(slider(BESIDE, 'left', PORTRAIT_PHONE)).toBe('50%');
    expect(slider(BESIDE, 'z-index', PORTRAIT_PHONE)).toBe('1000');
  });

  it.each([
    ['landscape phone', LANDSCAPE_PHONE],
    ['small landscape phone', LANDSCAPE_SMALL_PHONE],
  ])('centres left of the landscape controls sheet on a %s', (_name, vp) => {
    expect(slider(BESIDE, 'left', vp)).toBe('calc((100% - min(var(--map-sidebar-width), 60%)) / 2)');
    expect(slider(BESIDE, 'z-index', vp)).toBe('2000');
  });
});
