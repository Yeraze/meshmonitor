/**
 * Map scope lock (#5645): a node's status message never reaches a map marker.
 *
 * The leading status emoji is a badge on chat avatars only. On the map it
 * would sit beside badges that carry real meaning, and anyone can type an SOS
 * or warning sign as the first character of a status. These guards fail if a
 * later change wires status into the marker factory.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn((opts: unknown) => opts),
    icon: vi.fn(),
  },
}));

import { createNodeIcon, type CreateNodeIconOptions } from './markerIcons';
import markerIconsSource from './markerIcons.ts?raw';
import nodeMarkerIconSource from './nodeMarkerIcon.ts?raw';

const mapSources = import.meta.glob<string>('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const STATUS = '🆘 need help';

function html(options: CreateNodeIconOptions): string {
  return String((createNodeIcon(options) as unknown as { html: string }).html);
}

const variants: Array<[string, CreateNodeIconOptions]> = [
  ['meshmonitor pin', { hops: 1, shortName: 'ABCD', showLabel: true, pinStyle: 'meshmonitor' }],
  ['official circle', { hops: 1, shortName: 'ABCD', showLabel: true, pinStyle: 'official', nodeNum: 0x1234abcd }],
  ['router tower', { hops: 0, shortName: 'RTR', isRouter: true, showLabel: true }],
  ['selected + aircraft + unmessagable', { hops: 2, shortName: 'AIR', isSelected: true, isLikelyAircraft: true, isUnmessagable: true }],
  ['meshcore badge', { variant: 'meshcore', labelName: 'Repeater', fixedColor: 'var(--color-accent)' }],
];

describe('map markers take no status (#5645 scope lock)', () => {
  it('the marker factory has no status option', () => {
    // Compile-time: adding any of these keys to CreateNodeIconOptions makes
    // `never` stop being assignable and fails the type check.
    type StatusKeys = Extract<
      keyof CreateNodeIconOptions,
      'status' | 'nodeStatus' | 'statusEmoji' | 'statusBadge' | 'statusMessage'
    >;
    const none: StatusKeys[] = [];
    expect(none).toEqual([]);

    expect(markerIconsSource).not.toMatch(/nodeStatus|statusMessage|getLeadingEmoji|statusEmoji/);
    expect(nodeMarkerIconSource).not.toMatch(/nodeStatus|statusMessage|getLeadingEmoji|statusEmoji/);
  });

  it.each(variants)('%s: a status passed anyway changes nothing and is not drawn', (_name, options) => {
    const plain = html(options);
    const withStatus = html({
      ...options,
      // Not part of the type: this is what a careless spread of a node object
      // into the options would do.
      ...({ nodeStatus: STATUS, status: STATUS, statusEmoji: '🆘' } as object),
    });
    expect(withStatus).toBe(plain);
    expect(withStatus).not.toContain('🆘');
    expect(withStatus).not.toContain('need help');
  });

  it('no map module uses the avatar-badge helper or component', () => {
    const offenders = Object.entries(mapSources)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, source]) => /getLeadingEmoji|SenderAvatar|StatusEmojiIndicator/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    // The glob must really cover the map tree, or the check above is hollow.
    expect(Object.keys(mapSources)).toContain('./markerIcons.ts');
    expect(Object.keys(mapSources).length).toBeGreaterThan(20);
  });
});
