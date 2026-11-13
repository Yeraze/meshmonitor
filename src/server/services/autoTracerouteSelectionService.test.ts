/**
 * Auto-Traceroute selection — per-filter combine modes (#5230).
 *
 * The five node-matching filters used to be a hard-coded union, so a channel
 * selection could only ever WIDEN the candidate pool. An operator running one
 * preset per channel could not say "only trace nodes heard on LongTurbo" — the
 * exact request in #5230, and the one that saves airtime rather than spending
 * it.
 *
 * Each filter now carries a mode. `'or'` is the default and reproduces the old
 * behaviour exactly, so what matters here is: the default really is unchanged,
 * `'and'` really does scope, and the two compose without either swallowing the
 * other.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  selectNodeNeedingTraceroute,
  parseTracerouteFilterMode,
  type TracerouteFilterConfig,
} from './autoTracerouteSelectionService.js';
import type { DbNode } from '../../db/types.js';

const LOCAL = 111;

/** Roles/hwModels are plain enum ints here; only identity matters to the filter. */
const ROUTER = 2;
const CLIENT = 1;
const HELTEC = 4;
const TBEAM = 9;

/** Channel ids as they appear on `nodes.channel`: 0-7 device slots, >=100 virtual. */
const LONGTURBO = 163;
const LONGFAST = 102;

function node(over: Partial<DbNode> & { nodeNum: number }): DbNode {
  return {
    nodeId: `!${over.nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${over.nodeNum}`,
    shortName: `N${over.nodeNum}`,
    channel: null,
    role: null,
    hwModel: null,
    hopsAway: 1,
    lastHeard: Math.floor(Date.now() / 1000),
    ...over,
  } as DbNode;
}

function config(over: Partial<TracerouteFilterConfig> = {}): TracerouteFilterConfig {
  return {
    enabled: true,
    nodeNums: [],
    filterChannels: [],
    filterRoles: [],
    filterHwModels: [],
    filterNameRegex: '.*',
    filterNodesEnabled: true,
    filterChannelsEnabled: true,
    filterRolesEnabled: true,
    filterHwModelsEnabled: true,
    filterRegexEnabled: false,
    filterNodesMode: 'or',
    filterChannelsMode: 'or',
    filterRolesMode: 'or',
    filterHwModelsMode: 'or',
    filterRegexMode: 'or',
    expirationHours: 24,
    sortByHops: true, // deterministic pick — random selection would flake
    filterLastHeardEnabled: false,
    filterLastHeardHours: 168,
    filterHopsEnabled: false,
    filterHopsMin: 0,
    filterHopsMax: 10,
    ...over,
  };
}

/** Run the selector over a fixed candidate list and report who survived. */
async function survivors(nodes: DbNode[], cfg: TracerouteFilterConfig): Promise<number[]> {
  const picked: number[] = [];
  // `sortByHops` makes the selector return the lowest-hop survivor, so walk the
  // list by removing each winner until nothing is eligible. That reads the whole
  // surviving set out of a function that only ever returns one node.
  let remaining = [...nodes];
  for (let guard = 0; guard < nodes.length + 1 && remaining.length > 0; guard++) {
    const deps = {
      filterCfg: cfg,
      maxNodeAgeHours: 24,
      nodesRepo: { getEligibleNodesForTraceroute: vi.fn().mockResolvedValue(remaining) } as never,
      normalizeBigInts: (n: DbNode) => n,
    };
    const got = await selectNodeNeedingTraceroute(LOCAL, 'src-a', deps);
    if (!got) break;
    picked.push(got.nodeNum);
    remaining = remaining.filter((n) => n.nodeNum !== got.nodeNum);
  }
  return picked.sort((a, b) => a - b);
}

describe('parseTracerouteFilterMode', () => {
  it('defaults to or for anything that is not exactly "and"', () => {
    // Back-compat hinges on this: every install predating #5230 has no stored
    // value, and must keep the union behaviour it already had.
    expect(parseTracerouteFilterMode(null)).toBe('or');
    expect(parseTracerouteFilterMode(undefined)).toBe('or');
    expect(parseTracerouteFilterMode('')).toBe('or');
    expect(parseTracerouteFilterMode('AND')).toBe('or');
    expect(parseTracerouteFilterMode('nonsense')).toBe('or');
  });

  it('reads "and" as and', () => {
    expect(parseTracerouteFilterMode('and')).toBe('and');
  });
});

describe('selectNodeNeedingTraceroute — combine modes', () => {
  const pool = [
    node({ nodeNum: 1, channel: LONGTURBO, role: ROUTER, hwModel: HELTEC, hopsAway: 1 }),
    node({ nodeNum: 2, channel: LONGFAST, role: ROUTER, hwModel: TBEAM, hopsAway: 2 }),
    node({ nodeNum: 3, channel: LONGTURBO, role: CLIENT, hwModel: TBEAM, hopsAway: 3 }),
    node({ nodeNum: 4, channel: null, role: ROUTER, hwModel: HELTEC, hopsAway: 4 }),
  ];

  it('defaults to the historical union — a channel pick WIDENS, never narrows', async () => {
    // This is the bug #5230 reports. Channel={LongTurbo} + role={ROUTER} under
    // the old semantics still traces the LongFast router and the channel-less
    // one, because matching ANY filter is enough.
    expect(await survivors(pool, config({
      filterChannels: [LONGTURBO],
      filterRoles: [ROUTER],
    }))).toEqual([1, 2, 3, 4]);
  });

  it('scopes to the channel when that filter is set to and', async () => {
    const s = await survivors(pool, config({
      filterChannels: [LONGTURBO],
      filterChannelsMode: 'and',
      filterRoles: [ROUTER],
    }));
    // Node 1: LongTurbo + ROUTER — passes the scope and the union.
    // Node 3: LongTurbo but CLIENT — in scope, fails the remaining OR group.
    // Node 2: ROUTER but LongFast — out of scope.
    // Node 4: ROUTER but no known channel — out of scope.
    expect(s).toEqual([1]);
  });

  it('a pure-and config is a plain intersection, not an empty set', async () => {
    // With no or-mode filters left, the union clause must be vacuous rather
    // than failing every node.
    const s = await survivors(pool, config({
      filterChannels: [LONGTURBO],
      filterChannelsMode: 'and',
      filterRoles: [ROUTER],
      filterRolesMode: 'and',
      filterHwModels: [HELTEC],
      filterHwModelsMode: 'and',
    }));
    expect(s).toEqual([1]);
  });

  it('excludes nodes with no known channel from an and-scoped channel filter', async () => {
    // "Heard on LongTurbo" cannot be true of a node we have never decoded a
    // channel for. The UI surfaces the count so the exclusion is not silent.
    const s = await survivors(pool, config({
      filterChannels: [LONGTURBO, LONGFAST],
      filterChannelsMode: 'and',
    }));
    expect(s).toEqual([1, 2, 3]);
  });

  it('keeps an and-scoped filter out of the union it is scoping', async () => {
    // Channel scoped to LongFast, and an OR group of role=CLIENT. Node 2 is
    // LongFast but a ROUTER, node 3 is a CLIENT but LongTurbo — neither passes.
    const s = await survivors(pool, config({
      filterChannels: [LONGFAST],
      filterChannelsMode: 'and',
      filterRoles: [CLIENT],
      filterNodesEnabled: false,
      filterHwModelsEnabled: false,
    }));
    expect(s).toEqual([]);
  });

  it('ignores an enabled but EMPTY filter rather than treating it as a scope', async () => {
    // An and-mode channel filter with nothing selected is a filter the user has
    // not filled in — not an instruction to trace nothing. Getting this wrong
    // would silently stop every auto-traceroute.
    const s = await survivors(pool, config({
      filterChannels: [],
      filterChannelsMode: 'and',
    }));
    expect(s).toEqual([1, 2, 3, 4]);
  });

  it('respects the enabled toggle independently of the mode', async () => {
    // Mode is meaningless while the filter is switched off.
    const s = await survivors(pool, config({
      filterChannels: [LONGTURBO],
      filterChannelsMode: 'and',
      filterChannelsEnabled: false,
    }));
    expect(s).toEqual([1, 2, 3, 4]);
  });

  it('still applies the always-AND last-heard and hop filters alongside a scope', async () => {
    const s = await survivors(pool, config({
      filterChannels: [LONGTURBO],
      filterChannelsMode: 'and',
      filterHopsEnabled: true,
      filterHopsMin: 0,
      filterHopsMax: 2,
    }));
    expect(s).toEqual([1]);
  });

  it('scopes by name regex when that filter is set to and', async () => {
    const named = [
      node({ nodeNum: 10, longName: 'LongTurbo Router', channel: LONGTURBO }),
      node({ nodeNum: 11, longName: 'Plain Client', channel: LONGTURBO }),
    ];
    const s = await survivors(named, config({
      filterNameRegex: '^LongTurbo',
      filterRegexEnabled: true,
      filterRegexMode: 'and',
      filterNodesEnabled: false,
      filterChannelsEnabled: false,
      filterRolesEnabled: false,
      filterHwModelsEnabled: false,
    }));
    expect(s).toEqual([10]);
  });

  it('passes every node when the whole filter block is disabled', async () => {
    const s = await survivors(pool, config({
      enabled: false,
      filterChannels: [LONGTURBO],
      filterChannelsMode: 'and',
    }));
    expect(s).toEqual([1, 2, 3, 4]);
  });
});

describe('selectNodeNeedingTraceroute — active-node cutoff (#5376)', () => {
  async function cutoffFor(maxNodeAgeHours: number): Promise<number> {
    const getEligibleNodesForTraceroute = vi.fn().mockResolvedValue([]);
    await selectNodeNeedingTraceroute(LOCAL, 'src-a', {
      filterCfg: config(),
      maxNodeAgeHours,
      nodesRepo: { getEligibleNodesForTraceroute } as never,
      normalizeBigInts: (n: DbNode) => n,
    });
    return getEligibleNodesForTraceroute.mock.calls[0][1] as number;
  }

  it('uses the given window as the lastHeard cutoff', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = await cutoffFor(48);
    expect(nowSec - cutoff).toBeGreaterThanOrEqual(48 * 3600 - 2);
    expect(nowSec - cutoff).toBeLessThanOrEqual(48 * 3600 + 2);
  });

  it('never turns a 0 ("unlimited") window into cutoff = now; falls back to the 24h TX default', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = await cutoffFor(0);
    // Before #5376 this was `now`, so no node was ever eligible.
    expect(nowSec - cutoff).toBeGreaterThanOrEqual(24 * 3600 - 2);
    expect(nowSec - cutoff).toBeLessThanOrEqual(24 * 3600 + 2);
  });
});

/**
 * Last-heard and hop-range filters. These are always AND, applied before the
 * combinable filters. Replaces src/services/database.traceroute-filters.test.ts,
 * which tested a copy of these predicates (#6379).
 */
describe('selectNodeNeedingTraceroute — last-heard filter', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const hoursAgo = (h: number) => nowSec() - h * 3600;

  const pool = () => [
    node({ nodeNum: 1, lastHeard: hoursAgo(1), hopsAway: 1 }),
    node({ nodeNum: 2, lastHeard: hoursAgo(30), hopsAway: 2 }),
    node({ nodeNum: 3, lastHeard: hoursAgo(200), hopsAway: 3 }),
    node({ nodeNum: 4, lastHeard: null as unknown as number, hopsAway: 4 }),
  ];

  it('passes every node, including one never heard, when disabled', async () => {
    expect(await survivors(pool(), config({ filterLastHeardEnabled: false }))).toEqual([1, 2, 3, 4]);
  });

  it('drops nodes last heard before the cutoff', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardEnabled: true,
      filterLastHeardHours: 24,
    }))).toEqual([1]);
  });

  it('uses the window in hours (168 h keeps a 30 h-old node, drops a 200 h-old one)', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardEnabled: true,
      filterLastHeardHours: 168,
    }))).toEqual([1, 2]);
  });

  it('excludes a node with no lastHeard', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardEnabled: true,
      filterLastHeardHours: 100000,
    }))).toEqual([1, 2, 3]);
  });
});

describe('selectNodeNeedingTraceroute — hop-range filter', () => {
  const pool = () => [
    node({ nodeNum: 1, hopsAway: 0 }),
    node({ nodeNum: 2, hopsAway: 2 }),
    node({ nodeNum: 3, hopsAway: 5 }),
    node({ nodeNum: 4, hopsAway: null as unknown as number }),
    node({ nodeNum: 5, hopsAway: undefined }),
  ];

  it('passes every node when disabled', async () => {
    expect(await survivors(pool(), config({
      filterHopsEnabled: false,
      filterHopsMin: 3,
      filterHopsMax: 3,
    }))).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps nodes inside [min, max], both ends inclusive', async () => {
    expect(await survivors(pool(), config({
      filterHopsEnabled: true,
      filterHopsMin: 2,
      filterHopsMax: 5,
    }))).toEqual([2, 3]);
  });

  it('treats null and undefined hopsAway as 1 (direct neighbour)', async () => {
    expect(await survivors(pool(), config({
      filterHopsEnabled: true,
      filterHopsMin: 1,
      filterHopsMax: 1,
    }))).toEqual([4, 5]);
  });

  it('allows max 0 to select only 0-hop nodes', async () => {
    expect(await survivors(pool(), config({
      filterHopsEnabled: true,
      filterHopsMin: 0,
      filterHopsMax: 0,
    }))).toEqual([1]);
  });
});

describe('selectNodeNeedingTraceroute — last-heard AND hop range', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const pool = () => [
    node({ nodeNum: 1, lastHeard: nowSec() - 3600, hopsAway: 1 }), // recent, near
    node({ nodeNum: 2, lastHeard: nowSec() - 3600, hopsAway: 6 }), // recent, far
    node({ nodeNum: 3, lastHeard: nowSec() - 48 * 3600, hopsAway: 1 }), // stale, near
    node({ nodeNum: 4, lastHeard: nowSec() - 48 * 3600, hopsAway: 6 }), // stale, far
  ];

  it('requires both when both are enabled', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardEnabled: true,
      filterLastHeardHours: 24,
      filterHopsEnabled: true,
      filterHopsMin: 0,
      filterHopsMax: 3,
    }))).toEqual([1]);
  });

  it('applies only last-heard when hops is disabled', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardEnabled: true,
      filterLastHeardHours: 24,
      filterHopsMin: 0,
      filterHopsMax: 3,
    }))).toEqual([1, 2]);
  });

  it('applies only hops when last-heard is disabled', async () => {
    expect(await survivors(pool(), config({
      filterLastHeardHours: 24,
      filterHopsEnabled: true,
      filterHopsMin: 0,
      filterHopsMax: 3,
    }))).toEqual([1, 3]);
  });

  it('applies even when the node-matching filter block is disabled', async () => {
    expect(await survivors(pool(), config({
      enabled: false,
      filterLastHeardEnabled: true,
      filterLastHeardHours: 24,
      filterHopsEnabled: true,
      filterHopsMin: 0,
      filterHopsMax: 3,
    }))).toEqual([1]);
  });
});

describe('selectNodeNeedingTraceroute — other filter branches', () => {
  it('admits listed node numbers under the specific-nodes filter', async () => {
    const pool = [node({ nodeNum: 1 }), node({ nodeNum: 2 }), node({ nodeNum: 3 })];
    expect(await survivors(pool, config({ nodeNums: [1, 3] }))).toEqual([1, 3]);
  });

  it('never matches a null role or hwModel', async () => {
    const pool = [
      node({ nodeNum: 1, role: ROUTER, hwModel: HELTEC }),
      node({ nodeNum: 2, role: null as unknown as number, hwModel: null as unknown as number }),
    ];
    expect(await survivors(pool, config({ filterRoles: [ROUTER], filterRolesMode: 'and' }))).toEqual([1]);
    expect(await survivors(pool, config({ filterHwModels: [HELTEC], filterHwModelsMode: 'and' }))).toEqual([1]);
  });

  it('ignores an invalid name regex instead of excluding every node', async () => {
    const pool = [node({ nodeNum: 1 }), node({ nodeNum: 2 })];
    expect(await survivors(pool, config({
      filterNameRegex: '([unclosed',
      filterRegexEnabled: true,
      filterRegexMode: 'and',
    }))).toEqual([1, 2]);
  });

  it('matches the regex case-insensitively, falling back to shortName then nodeId', async () => {
    const pool = [
      node({ nodeNum: 1, longName: 'ALPHA base' }),
      node({ nodeNum: 2, longName: null as unknown as string, shortName: 'alph' }),
      node({ nodeNum: 3, longName: null as unknown as string, shortName: null as unknown as string, nodeId: '!alpha003' }),
      node({ nodeNum: 4, longName: 'Bravo' }),
    ];
    expect(await survivors(pool, config({
      filterNameRegex: 'alph',
      filterRegexEnabled: true,
      filterRegexMode: 'and',
      filterNodesEnabled: false,
      filterChannelsEnabled: false,
      filterRolesEnabled: false,
      filterHwModelsEnabled: false,
    }))).toEqual([1, 2, 3]);
  });

  it('with sortByHops, picks the nearest node and puts unknown hops last', async () => {
    const pick = async (nodes: DbNode[]) => (await selectNodeNeedingTraceroute(LOCAL, 'src-a', {
      filterCfg: config({ enabled: false }),
      maxNodeAgeHours: 24,
      nodesRepo: { getEligibleNodesForTraceroute: vi.fn().mockResolvedValue(nodes) } as never,
      normalizeBigInts: (n: DbNode) => n,
    }))?.nodeNum;
    expect(await pick([
      node({ nodeNum: 1, hopsAway: 3 }),
      node({ nodeNum: 2, hopsAway: 1 }),
      node({ nodeNum: 3, hopsAway: 2 }),
    ])).toBe(2);
    expect(await pick([
      node({ nodeNum: 1, hopsAway: undefined }),
      node({ nodeNum: 2, hopsAway: 4 }),
    ])).toBe(2);
  });

  it('returns null when nothing survives', async () => {
    const got = await selectNodeNeedingTraceroute(LOCAL, 'src-a', {
      filterCfg: config({ filterHopsEnabled: true, filterHopsMin: 9, filterHopsMax: 9 }),
      maxNodeAgeHours: 24,
      nodesRepo: { getEligibleNodesForTraceroute: vi.fn().mockResolvedValue([node({ nodeNum: 1 })]) } as never,
      normalizeBigInts: (n: DbNode) => n,
    });
    expect(got).toBeNull();
  });
});
