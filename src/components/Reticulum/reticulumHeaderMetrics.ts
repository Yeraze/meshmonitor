/**
 * Derives the source-header gauges (battery / channel load / airtime) for a
 * Reticulum source from its live interface snapshots (issue #6120).
 *
 * Rule (issue #6120 "Open decision"): the FIRST RNode interface that is Up.
 * RNS only reports these gauges for an RNode LoRa interface, so a source with
 * several interfaces still surfaces the radio's numbers, and a source whose
 * RNode is down (or has no RNode) surfaces nothing.
 *
 * Units match RNS/`rnstatus`: battery-percent is 0-100, and airtime/
 * channel-load are already percentages — so they map straight onto the
 * Meshtastic header's `batteryLevel` / `airUtilTx` / `channelUtilization`
 * ({@link LocalNodeMetrics}) with no scaling. The longer (1h) window is
 * preferred over the 15s one for a steadier header reading, falling back to
 * the short window when only it is present.
 *
 * Returns `undefined` when no Up RNode interface reports any of the three, so
 * the header hides the values entirely rather than showing an empty badge.
 */
import type { LocalNodeMetrics } from '../AppHeader/CyclingConnectionStatus';
import type { ReticulumInterfaceRow } from '../../types/reticulum';

export function reticulumHeaderMetrics(
  interfaces: ReticulumInterfaceRow[],
): LocalNodeMetrics | undefined {
  const rnode = interfaces.find(
    (i) => i.online && /rnode/i.test(i.interfaceType ?? ''),
  );
  if (!rnode) return undefined;

  const metrics: LocalNodeMetrics = {};
  if (rnode.batteryPercent != null) metrics.batteryLevel = rnode.batteryPercent;

  const channel = rnode.channelLoadLong ?? rnode.channelLoadShort;
  if (channel != null) metrics.channelUtilization = channel;

  const airtime = rnode.airtimeLong ?? rnode.airtimeShort;
  if (airtime != null) metrics.airUtilTx = airtime;

  if (
    metrics.batteryLevel == null &&
    metrics.channelUtilization == null &&
    metrics.airUtilTx == null
  ) {
    return undefined;
  }
  return metrics;
}
