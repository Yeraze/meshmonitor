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

  // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
  const activeNodeCutoff = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

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
      const lastHeardCutoff = Math.floor(Date.now() / 1000) - filterLastHeardHours * 3600;
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

      // Check if ANY filter is actually configured
      const hasAnyFilter =
        (filterNodesEnabled && specificNodes.length > 0) ||
        (filterChannelsEnabled && filterChannels.length > 0) ||
        (filterRolesEnabled && filterRoles.length > 0) ||
        (filterHwModelsEnabled && filterHwModels.length > 0) ||
        (filterRegexEnabled && regexMatcher !== null);

      // Only filter if at least one filter is configured
      if (hasAnyFilter) {
        eligibleNodes = eligibleNodes.filter((node) => {
          // UNION logic: node passes if it matches ANY enabled filter
          // Check specific nodes filter
          if (filterNodesEnabled && specificNodes.length > 0) {
            if (specificNodes.includes(node.nodeNum)) {
              return true;
            }
          }

          // Check channel filter
          if (filterChannelsEnabled && filterChannels.length > 0) {
            if (node.channel != null && filterChannels.includes(node.channel)) {
              return true;
            }
          }

          // Check role filter
          if (filterRolesEnabled && filterRoles.length > 0) {
            if (node.role != null && filterRoles.includes(node.role)) {
              return true;
            }
          }

          // Check hardware model filter
          if (filterHwModelsEnabled && filterHwModels.length > 0) {
            if (node.hwModel != null && filterHwModels.includes(node.hwModel)) {
              return true;
            }
          }

          // Check regex name filter
          if (filterRegexEnabled && regexMatcher !== null) {
            const name = node.longName || node.shortName || node.nodeId || '';
            if (regexMatcher.test(name)) {
              return true;
            }
          }

          // Node didn't match any enabled filter
          return false;
        });
      }
      // If hasAnyFilter is false, all nodes pass (no filtering applied)
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
