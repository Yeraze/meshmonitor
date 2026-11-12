/**
 * loadNodeOptions: one picker row per nodeNum (#4173 review L28). /api/nodes
 * can list the same node once per source; the picker stores nodeNums, so two
 * rows for one node read the same and toggle together.
 */
import { describe, it, expect, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', () => ({ default: { get } }));

import { loadNodeOptions } from './loadNodeOptions';

describe('loadNodeOptions', () => {
  it('keeps the first row for a nodeNum seen on two sources', async () => {
    get.mockResolvedValue([
      { nodeNum: 10, longName: 'Hill', shortName: 'HILL', nodeId: '!0000000a' },
      { nodeNum: 11, longName: 'Hill', shortName: 'HILL', nodeId: '!0000000b' },
      { nodeNum: 10, longName: 'Hill', shortName: 'HILL', nodeId: '!0000000a' },
    ]);
    const opts = await loadNodeOptions();
    expect(opts.map((o) => o.nodeNum)).toEqual([10, 11]);
  });

  it('resolves to [] when the request fails', async () => {
    get.mockRejectedValue(new Error('nope'));
    expect(await loadNodeOptions()).toEqual([]);
  });
});
