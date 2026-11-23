/**
 * #6523: raw Meshtastic node rows (the v1 API) lose the Timezone Override
 * wherever they already lose a position the viewer may not see.
 */
import { describe, it, expect } from 'vitest';
import { scopeNodeRowsForViewer, withholdPrivateOverride } from './nodeEnhancer.js';

const SRC = 'src-a';
const row = (extra: Record<string, unknown> = {}) => ({
  nodeNum: 1,
  channel: 0,
  positionChannel: 0,
  latitude: 41.8,
  longitude: -87.6,
  positionOverrideEnabled: true,
  latitudeOverride: 41.9,
  longitudeOverride: -87.7,
  positionOverrideIsPrivate: false,
  timezoneOverride: 'America/Chicago',
  ...extra,
});

const access = (opts: { isAdmin?: boolean; privateOk?: boolean; channels?: number[] }) =>
  ({
    isAdmin: opts.isAdmin ?? false,
    canViewPrivate: () => opts.privateOk ?? false,
    canViewNode: (_src: string | undefined, channel: number | null | undefined) =>
      (opts.channels ?? [0]).includes(Number(channel)),
  }) as never;

describe('Timezone Override in raw node rows', () => {
  it('withholdPrivateOverride drops it', () => {
    expect(withholdPrivateOverride(row())).not.toHaveProperty('timezoneOverride');
  });

  it('stays for a viewer who sees the position, and for admins', () => {
    expect(scopeNodeRowsForViewer([row()], access({}), SRC)[0].timezoneOverride).toBe('America/Chicago');
    expect(scopeNodeRowsForViewer([row({ positionOverrideIsPrivate: true })], access({ isAdmin: true }), SRC)[0].timezoneOverride)
      .toBe('America/Chicago');
  });

  it('goes with a private override the viewer cannot see', () => {
    const [out] = scopeNodeRowsForViewer([row({ positionOverrideIsPrivate: true })], access({}), SRC);
    expect(out).not.toHaveProperty('timezoneOverride');
    expect(out).not.toHaveProperty('latitudeOverride');
  });

  it('goes with a reported position from a channel the viewer cannot see', () => {
    const [out] = scopeNodeRowsForViewer([row({ positionChannel: 3 })], access({}), SRC);
    expect(out).not.toHaveProperty('timezoneOverride');
    expect(out).not.toHaveProperty('latitude');
  });
});
