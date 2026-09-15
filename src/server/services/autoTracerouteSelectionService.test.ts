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
