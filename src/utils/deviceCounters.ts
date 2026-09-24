/**
 * Firmware LocalStats traffic counters (#5101 Phase 3).
 *
 * The firmware keeps one counter per metric across every transport (RF, UDP
 * and MQTT combined), so these can never be split by transport the way the
 * MeshMonitor-computed `system*Rf/Udp/Mqtt` series can. The UI surfaces this
 * with a visible `DeviceCounterNote` caption wherever one of these types is
 * charted, rather than a tooltip (phones cannot hover) — see
 * `docs/internal/dev-notes/TRANSPORT_BREAKDOWN_P3_SPEC.md` §2 (D4).
 *
 * Heap, noise floor and uptime are device metrics too, but not traffic
 * counters, so they are deliberately excluded here.
 */

export const DEVICE_COUNTER_TYPES: ReadonlySet<string> = new Set([
  'numOnlineNodes',
  'numTotalNodes',
  'numPacketsTx',
  'numPacketsRx',
  'numPacketsRxBad',
  'numRxDupe',
  'numTxRelay',
  'numTxRelayCanceled',
  'numTxDropped',
]);

export function isDeviceCounterType(type: string): boolean {
  return DEVICE_COUNTER_TYPES.has(type);
}
