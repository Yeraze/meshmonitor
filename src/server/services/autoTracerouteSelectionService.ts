/**
 * Auto-Traceroute Selection Service
 *
 * Extracted from DatabaseService.getNodeNeedingTracerouteAsync. Given the
 * resolved (per-source) traceroute filter configuration, picks the next node
 * that should receive an automatic traceroute — applying the last-heard / hop
 * AND-filters, the union of node/channel/role/hwModel/regex filters, and the
 * sort-by-hops-or-random selection strategy.
 */
import type { NodesRepository } from '../../db/repositories/nodes.js';
import type { DbNode } from '../../db/types.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { logger } from '../../utils/logger.js';
import {
  resolveTxTargetMaxAgeHours,
  TX_TARGET_MAX_AGE_HOURS_WHEN_UNLIMITED_DEFAULT,
} from '../../constants/nodeDisplayDefaults.js';

/**
 * How one of the five node-matching filters combines with the others (#5230).
 *
 * - `'or'` — the historical behaviour, and still the default: the filter joins
 *   the union, so a node matching ANY enabled `or` filter is eligible.
 * - `'and'` — the filter becomes a scope: a node must match it, whatever else
 *   it matches. This is what "only auto-traceroute nodes on LongTurbo" needs;
 *   under `'or'` a channel selection cannot narrow anything, it can only widen.
 *
 * Absent or unrecognised values read as `'or'`, so an install that predates the
 * setting keeps the filter logic it already had.
 */
export type TracerouteFilterMode = 'or' | 'and';

/** Coerce a stored string to a mode, defaulting to the back-compatible 'or'. */
export function parseTracerouteFilterMode(raw: string | null | undefined): TracerouteFilterMode {
  return raw === 'and' ? 'and' : 'or';
}

/**
 * Resolved traceroute filter configuration. Mirrors the return type of
 * DatabaseService.getTracerouteFilterSettingsAsync.
 */
export interface TracerouteFilterConfig {
  enabled: boolean;
  nodeNums: number[];
  filterChannels: number[];
  filterRoles: number[];
  filterHwModels: number[];
  filterNameRegex: string;
  filterNodesEnabled: boolean;
  filterChannelsEnabled: boolean;
  filterRolesEnabled: boolean;
  filterHwModelsEnabled: boolean;
  filterRegexEnabled: boolean;
  filterNodesMode: TracerouteFilterMode;
  filterChannelsMode: TracerouteFilterMode;
  filterRolesMode: TracerouteFilterMode;
  filterHwModelsMode: TracerouteFilterMode;
  filterRegexMode: TracerouteFilterMode;
  expirationHours: number;
  sortByHops: boolean;
  filterLastHeardEnabled: boolean;
  filterLastHeardHours: number;
  filterHopsEnabled: boolean;
  filterHopsMin: number;
  filterHopsMax: number;
}

export interface AutoTracerouteSelectionDeps {
  filterCfg: TracerouteFilterConfig;
  maxNodeAgeHours: number;
  nodesRepo: NodesRepository;
  normalizeBigInts: (node: DbNode) => DbNode;
}

/**
 * Select a node that needs a traceroute based on the configured filters and
 * timing windows. Returns the (BigInt-normalized) node, or null when none is
 * eligible.
 */
export async function selectNodeNeedingTraceroute(
  localNodeNum: number,
  sourceId: string | undefined,
  deps: AutoTracerouteSelectionDeps
): Promise<DbNode | null> {
  const { filterCfg, maxNodeAgeHours, nodesRepo, normalizeBigInts } = deps;

  const now = Date.now();
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const EXPIRATION_MS = filterCfg.expirationHours * 60 * 60 * 1000;

  // Callers pass the TX-target window (getTxTargetMaxAgeHours), which is never
  // 0. Guard anyway: a 0 ("unlimited") window here must not mean "no nodes"
  // (cutoff = now) nor "every node ever heard" for a TX job (#5376).
  const windowHours = resolveTxTargetMaxAgeHours(
    maxNodeAgeHours,
    TX_TARGET_MAX_AGE_HOURS_WHEN_UNLIMITED_DEFAULT,
  );

  // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
  const activeNodeCutoff = Math.floor(now / 1000) - windowHours * 60 * 60;

  try {
    // Get eligible nodes from repository
    let eligibleNodes = await nodesRepo.getEligibleNodesForTraceroute(
      localNodeNum,
      activeNodeCutoff,
      now - THREE_HOURS_MS,
      now - EXPIRATION_MS,
      sourceId
    );

    // Last heard and hop range filters (AND logic, applied before OR union filters)
    const filterLastHeardEnabled = filterCfg.filterLastHeardEnabled;
    const filterLastHeardHours = filterCfg.filterLastHeardHours;
    const filterHopsEnabled = filterCfg.filterHopsEnabled;
    const filterHopsMin = filterCfg.filterHopsMin;
    const filterHopsMax = filterCfg.filterHopsMax;

    // Apply last-heard filter (AND logic — applied before OR union filters)
    if (filterLastHeardEnabled) {
      const lastHeardCutoff = Math.floor(now / 1000) - filterLastHeardHours * 3600;
      eligibleNodes = eligibleNodes.filter((node) => {
        // Exclude nodes with no lastHeard or lastHeard older than cutoff
        return node.lastHeard != null && node.lastHeard >= lastHeardCutoff;
      });
    }

    // Apply hop range filter (AND logic)
    if (filterHopsEnabled) {
      eligibleNodes = eligibleNodes.filter((node) => {
        // Treat NULL hopsAway as 1 (direct neighbor)
        const hops = node.hopsAway ?? 1;
        return hops >= filterHopsMin && hops <= filterHopsMax;
      });
    }

    // Check if node filter is enabled (per-source when scoped)
    const filterEnabled = filterCfg.enabled;

    if (filterEnabled) {
      const specificNodes = filterCfg.nodeNums;
      const filterChannels = filterCfg.filterChannels;
      const filterRoles = filterCfg.filterRoles;
      const filterHwModels = filterCfg.filterHwModels;
      const filterNameRegex = filterCfg.filterNameRegex;

      const filterNodesEnabled = filterCfg.filterNodesEnabled;
      const filterChannelsEnabled = filterCfg.filterChannelsEnabled;
      const filterRolesEnabled = filterCfg.filterRolesEnabled;
      const filterHwModelsEnabled = filterCfg.filterHwModelsEnabled;
      const filterRegexEnabled = filterCfg.filterRegexEnabled;

      // Build regex matcher if enabled
      let regexMatcher: RegExp | null = null;
      if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
        try {
          regexMatcher = compileUserRegex(filterNameRegex, 'i');
        } catch (e) {
          logger.warn(`Invalid traceroute filter regex: ${filterNameRegex}`, e);
        }
      }

      /**
       * Each enabled filter is a predicate plus a combine mode (#5230).
       *
       * A filter only participates when it is enabled AND actually configured —
       * an enabled-but-empty channel list is not a scope that excludes
       * everything, it is a filter the user has not filled in yet. Treating it
       * as a scope would silently stop all auto-traceroutes.
       */
      type ActiveFilter = { mode: TracerouteFilterMode; matches: (node: DbNode) => boolean };
      const active: ActiveFilter[] = [];

      if (filterNodesEnabled && specificNodes.length > 0) {
        active.push({
          mode: filterCfg.filterNodesMode,
          matches: (node) => specificNodes.includes(node.nodeNum),
        });
      }
      if (filterChannelsEnabled && filterChannels.length > 0) {
        active.push({
          mode: filterCfg.filterChannelsMode,
          // A node with no known channel never matches. Under 'or' that is
          // harmless (another filter can still admit it); under 'and' it is the
          // point — "heard on LongTurbo" cannot be true of a node we have never
          // decoded a channel for. The UI surfaces how many nodes that excludes.
          matches: (node) => node.channel != null && filterChannels.includes(node.channel),
        });
      }
      if (filterRolesEnabled && filterRoles.length > 0) {
        active.push({
          mode: filterCfg.filterRolesMode,
          matches: (node) => node.role != null && filterRoles.includes(node.role),
        });
      }
      if (filterHwModelsEnabled && filterHwModels.length > 0) {
        active.push({
          mode: filterCfg.filterHwModelsMode,
          matches: (node) => node.hwModel != null && filterHwModels.includes(node.hwModel),
        });
      }
      if (filterRegexEnabled && regexMatcher !== null) {
        const matcher = regexMatcher;
        active.push({
          mode: filterCfg.filterRegexMode,
          matches: (node) => matcher.test(node.longName || node.shortName || node.nodeId || ''),
        });
      }

      const andFilters = active.filter((f) => f.mode === 'and');
      const orFilters = active.filter((f) => f.mode === 'or');

      if (active.length > 0) {
        eligibleNodes = eligibleNodes.filter((node) => {
          // Every 'and' filter must match — these are scopes.
          if (!andFilters.every((f) => f.matches(node))) return false;
          // The 'or' filters keep their historical union behaviour. With none
          // configured the clause is vacuous, so a pure-'and' config is a plain
          // intersection rather than a set that matches nothing.
          if (orFilters.length > 0 && !orFilters.some((f) => f.matches(node))) return false;
          return true;
        });
      }
      // With no filter configured at all, every node passes.
    }

    if (eligibleNodes.length === 0) {
      return null;
    }

    // Check if sort by hops is enabled (per-source when scoped)
    const sortByHops = filterCfg.sortByHops;

    if (sortByHops) {
      // Sort by hopsAway ascending (closer nodes first), with undefined hops at the end
      eligibleNodes.sort((a, b) => {
        const hopsA = a.hopsAway ?? Infinity;
        const hopsB = b.hopsAway ?? Infinity;
        return hopsA - hopsB;
      });
      // Take the first (closest) node
      return normalizeBigInts(eligibleNodes[0]);
    }

    // Randomly select one node from the eligible nodes
    const randomIndex = Math.floor(Math.random() * eligibleNodes.length);
    return normalizeBigInts(eligibleNodes[randomIndex]);
  } catch (error) {
    logger.error('Error in selectNodeNeedingTraceroute:', error);
    return null;
  }
}
