/**
 * Asset Tracking (#5354) — the payload overlay in enhanceNodeForClient.
 *
 * An asset gets `asset: { retentionDays }` and `isMobile: true`; the raw
 * `mobile` column is passed through untouched so nothing that reads it
 * (becameMobile, the `node.mobile` automation token) sees the flag.
 */
import { describe, it, expect } from 'vitest';
import { enhanceNodeForClient } from './nodeEnhancer.js';
import type { DeviceInfo } from '../meshtasticManager.js';

const node = (nodeNum: number, mobile: number): DeviceInfo =>
  ({ nodeNum, mobile, user: { id: `!${nodeNum.toString(16).padStart(8, '0')}`, longName: 'N', shortName: 'N' } }) as DeviceInfo;

const assets = new Map([[0x11, { retentionDays: 30 }]]);

describe('enhanceNodeForClient asset overlay (#5354)', () => {
  it('forces isMobile on for a stationary asset and keeps mobile raw', async () => {
    const out = await enhanceNodeForClient(node(0x11, 0), null, undefined, false, assets);
    expect(out.isMobile).toBe(true);
    expect(out.asset).toEqual({ retentionDays: 30 });
    expect(out.mobile).toBe(0);
  });

  it('leaves a non-asset on the heuristic', async () => {
    const stationary = await enhanceNodeForClient(node(0x22, 0), null, undefined, false, assets);
    expect(stationary.isMobile).toBe(false);
    expect(stationary.asset).toBeUndefined();
    const moving = await enhanceNodeForClient(node(0x22, 1), null, undefined, false, assets);
    expect(moving.isMobile).toBe(true);
  });

  it('behaves as before when no asset map is passed', async () => {
    const out = await enhanceNodeForClient(node(0x11, 0), null, undefined, false);
    expect(out.isMobile).toBe(false);
    expect(out.asset).toBeUndefined();
  });

  it('applies the overlay to a node with no user id', async () => {
    const bare = { nodeNum: 0x11, mobile: 0 } as DeviceInfo;
    const out = await enhanceNodeForClient(bare, null, undefined, false, assets);
    expect(out.isMobile).toBe(true);
  });
});
