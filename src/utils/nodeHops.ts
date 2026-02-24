import type { DeviceInfo } from '../types/device';
import type { NodeHopsCalculation } from '../contexts/SettingsContext';

interface TracerouteData {
  fromNodeNum: number;
  toNodeNum: number;
  route: string | null;
  routeBack: string | null;
}

/**
 * Calculate the effective hop count for a node based on the selected calculation mode.
 *
 * @param node - The node to calculate hops for
 * @param calculation - The hop calculation mode ('nodeinfo' | 'traceroute' | 'messages')
 * @param traceroutes - Array of traceroute data (only needed for 'traceroute' mode)
 * @param currentNodeNum - The current local node number (only needed for 'traceroute' mode)
 * @returns The effective hop count (0-999, where 999 indicates unknown)
 */
export function getEffectiveHops(
  node: DeviceInfo,
  calculation: NodeHopsCalculation,
  traceroutes?: TracerouteData[],
  currentNodeNum?: number | null
): number {
  switch (calculation) {
    case 'nodeinfo':
      // Use hopsAway from NodeInfo packet (current behavior)
      return node.hopsAway ?? 999;

    case 'traceroute':
      // Find the best traceroute between current node and this node
      if (traceroutes && currentNodeNum && node.nodeNum) {
        const relevantTraceroutes = traceroutes.filter(tr =>
          (tr.fromNodeNum === currentNodeNum && tr.toNodeNum === node.nodeNum) ||
          (tr.fromNodeNum === node.nodeNum && tr.toNodeNum === currentNodeNum)
        );

        if (relevantTraceroutes.length > 0) {
          let minHops = 999;

          for (const tr of relevantTraceroutes) {
            // Parse route and routeBack to get hop counts
            try {
              if (tr.route) {
                const route = JSON.parse(tr.route);
                if (Array.isArray(route) && route.length < minHops) {
                  minHops = route.length;
                }
              }
              if (tr.routeBack) {
                const routeBack = JSON.parse(tr.routeBack);
                if (Array.isArray(routeBack) && routeBack.length < minHops) {
                  minHops = routeBack.length;
                }
              }
            } catch {
              // Ignore parse errors
            }
          }

          if (minHops < 999) {
            return minHops;
          }
        }
      }
      // Fall back to hopsAway if no traceroute found
      return node.hopsAway ?? 999;

    case 'messages':
      // Use lastMessageHops from the most recent packet, fall back to hopsAway
      return node.lastMessageHops ?? node.hopsAway ?? 999;

    default:
      return node.hopsAway ?? 999;
  }
}
