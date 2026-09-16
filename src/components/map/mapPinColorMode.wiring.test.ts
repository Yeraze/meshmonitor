/**
 * #5018 wiring guard: every map that draws node pins must pass `colorMode`
 * AND include it in its marker cache key.
 *
 * Both halves fail silently and differently:
 *
 *  - A map that never passes `colorMode` just ignores the setting. The toggle
 *    appears to work on the map you happened to test and does nothing on the
 *    others. There are three independent node-marker maps, and a previous map
 *    toggle (#5177) shipped to one of them with a fully green suite.
 *
 *  - A map that passes it but leaves it out of `iconSig` is worse: Leaflet
 *    reuses the cached icon, so the colour changes only for nodes that happen
 *    to be re-rendered for some other reason. That reads as "the toggle is
 *    flaky" rather than "the toggle is broken".
 *
 * A source-level check is crude, but it catches the omission at the point it
 * is made. Rendering three Leaflet maps to assert the same thing would be far
 * more machinery for a weaker guarantee.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Every component that builds a node marker icon from the pin settings. */
const NODE_MARKER_MAPS = [
  'src/components/Dashboard/DashboardMap.tsx',
  'src/components/MapAnalysis/layers/NodeMarkersLayer.tsx',
  'src/components/NodesTab.tsx',
];

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('mapPinColorMode wiring (#5018)', () => {
  it.each(NODE_MARKER_MAPS)('%s reads mapPinColorMode from settings', (rel) => {
    expect(read(rel)).toContain('mapPinColorMode');
  });

  it.each(NODE_MARKER_MAPS)('%s passes colorMode to the icon factory', (rel) => {
    expect(read(rel)).toContain('colorMode: mapPinColorMode');
  });

  /**
   * Pull the line that assigns iconSig. Matching on the line rather than a
   * template-literal regex over the whole file — these components contain many
   * backtick strings, and an unanchored match happily grabs the wrong one.
   */
  const iconSigLine = (rel: string): string => {
    const line = read(rel)
      .split('\n')
      .find((l) => /iconSig\s*[:=]/.test(l));
    expect(line, `no iconSig assignment found in ${rel}`).toBeDefined();
    return line as string;
  };

  it.each(NODE_MARKER_MAPS)('%s includes it in the marker cache key', (rel) => {
    // Without this the icon is cached across a toggle, so the colour changes
    // only for nodes re-rendered for some other reason.
    expect(iconSigLine(rel)).toContain('${mapPinColorMode}');
  });

  it.each(NODE_MARKER_MAPS)('%s keeps the pin style in the cache key too', (rel) => {
    expect(iconSigLine(rel)).toContain('${mapPinStyle}');
  });
});

/**
 * The two places a stored value enters the app must agree on what is valid.
 * Reviewing #5018 flagged that the server-load path used a truthiness check
 * plus an unchecked cast, so a stored `"foo"` would reach the icon factory as
 * neither branch — while the localStorage seed beside it already allowlisted.
 */
describe('mapPinColorMode is allowlisted on BOTH load paths (#5018)', () => {
  const ctx = () => read('src/contexts/SettingsContext.tsx');

  it('seeds from localStorage through an allowlist', () => {
    expect(ctx()).toMatch(/localStorage\.getItem\('mapPinColorMode'\)[\s\S]{0,200}?saved === 'hops'/);
  });

  it('accepts a server value only when it is one of the two modes', () => {
    // Not `if (settings.mapPinColorMode)` — that admits any non-empty string.
    expect(ctx()).toContain("settings.mapPinColorMode === 'hops' || settings.mapPinColorMode === 'node'");
  });

  it('does not cast the server value to the type unchecked', () => {
    expect(ctx()).not.toContain('settings.mapPinColorMode as MapPinColorMode');
  });
});
