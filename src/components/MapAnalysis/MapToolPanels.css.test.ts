/**
 * Where the Map Analysis tool panels sit next to the open Map controls panel.
 *
 * jsdom applies no stylesheet, so these read the real rules and resolve them
 * at concrete viewports with the shared cascade resolver. The DOM order the
 * sibling selectors rely on (controls panel first, one parent) is pinned in
 * MapAnalysisCanvas.test.tsx.
 *
 * #5706 moved only the Site Planner, with the controls panel's 10px inset and
 * 300px width copied into its own module. The GNSS DOP panel, pinned to the
 * same corner, stayed under the controls panel, and the Link Profile drawer's
 * radio inputs sat under its lower end.
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
const toolCss = read('src/components/MapAnalysis/MapToolPanels.module.css')
  .replace(/:global\((\.[\w-]+)\)/g, '$1');
const sidebarCss = read('src/components/map/MapSidebar.css');
const plannerCss = read('src/components/MapAnalysis/SitePlannerPanel.module.css');
const gnssCss = read('src/components/MapAnalysis/GnssDopPanel.module.css');

const tool = createResolver(toolCss);
const sidebar = createResolver(sidebarCss);
const BESIDE = '.map-sidebar ~ .toolColumn';
const DRAWER = '.map-sidebar ~ .clearOfControls';

describe('Map controls geometry tokens', () => {
  it('defines the inset and width once, and the controls panel uses them', () => {
    expect(sidebarCss).toMatch(/:root\s*\{[^}]*--map-sidebar-inset:\s*10px;[^}]*--map-sidebar-width:\s*300px;/);
    expect(sidebar('.map-sidebar', 'right', DESKTOP)).toBe('var(--map-sidebar-inset)');
    expect(sidebar('.map-sidebar', 'width', DESKTOP)).toBe('var(--map-sidebar-width)');
    expect(sidebar('.map-sidebar', 'width', LANDSCAPE_PHONE)).toBe('var(--map-sidebar-width)');
  });

  it('is the only place the numbers live', () => {
    expect(toolCss).not.toMatch(/300px|310px/);
    expect(plannerCss).not.toMatch(/map-sidebar|300px/);
  });
});

describe('tool column', () => {
  it('pins to the top-right corner, clear of the collapsed controls button', () => {
    expect(tool('.toolColumn', 'position', DESKTOP)).toBe('absolute');
    expect(tool('.toolColumn', 'top', DESKTOP)).toBe('4rem');
    expect(tool('.toolColumn', 'right', DESKTOP)).toBe('0.75rem');
    expect(tool('.toolColumn', 'flex-direction', DESKTOP)).toBe('column');
  });

  it('owns placement: neither panel positions itself any more', () => {
    for (const css of [plannerCss, gnssCss]) {
      expect(css).not.toMatch(/position:\s*absolute/);
      expect(css).not.toMatch(/z-index/);
    }
  });

  it('moves left of the open controls panel on desktop', () => {
    expect(tool(BESIDE, 'right', DESKTOP)).toBe(
      'calc(var(--map-sidebar-inset) + var(--map-sidebar-width) + 0.75rem)',
    );
  });

  it('stays in the corner under the portrait full sheet', () => {
    expect(tool(BESIDE, 'right', PORTRAIT_PHONE)).toBe('0.75rem');
  });

  it.each([
    ['landscape phone', LANDSCAPE_PHONE],
    // Matches both phone blocks; the landscape one must win.
    ['small landscape phone', LANDSCAPE_SMALL_PHONE],
  ])('sits beside the landscape sheet on a %s', (_name, vp) => {
    expect(tool(BESIDE, 'right', vp)).toBe('calc(min(var(--map-sidebar-width), 60%) + 0.5rem)');
  });

  it('caps its height on a phone so part of the map shows', () => {
    expect(tool('.toolColumn', 'max-height', PORTRAIT_PHONE)).toBe('55%');
    expect(tool('.toolColumn', 'max-height', LANDSCAPE_PHONE)).toBe('55%');
    expect(tool('.toolColumn', 'max-height', DESKTOP)).toBe('calc(100% - 5rem)');
  });
});

describe('Link Profile drawer', () => {
  it('ends short of the open controls panel on desktop', () => {
    expect(tool(DRAWER, 'right', DESKTOP)).toBe(
      'calc(2 * var(--map-sidebar-inset) + var(--map-sidebar-width))',
    );
  });

  it('spans the pane under the portrait sheet and clears the landscape one', () => {
    expect(tool(DRAWER, 'right', PORTRAIT_PHONE)).toBe('0');
    expect(tool(DRAWER, 'right', LANDSCAPE_SMALL_PHONE)).toBe('min(var(--map-sidebar-width), 60%)');
  });
});
