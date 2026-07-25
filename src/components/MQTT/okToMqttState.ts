/**
 * Client-side reconstruction of the `ok_to_mqtt` state for one MQTT packet-log
 * row (#4114 Phase 2).
 *
 * Phase 1 stores the raw `Data.bitfield` (NULL = unreadable) plus a derived 0/1
 * `okToMqttViolation` that already has the relayed / self-gateway predicate
 * applied server-side (MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(f)). The browser does
 * NOT know `localGatewayNodeNum` and must never re-derive that predicate — it
 * trusts the flag and uses `bitfield` only to tell the three non-violating
 * states apart.
 *
 * See MQTT_OK_TO_MQTT_PHASE2_SPEC.md §2(b).
 */

export type OkToMqttState =
  /** Confirmed: a gateway other than the originator relayed a packet whose bit was explicitly 0. */
  | 'violation'
  /** The originator set ok_to_mqtt; relaying is permitted. */
  | 'ok'
  /**
   * Bit explicitly 0 but the server did not flag a violation. Reachable
   * whenever attribution could not be (or need not be) made against a
   * third-party relay — per Phase 1 spec §2(f) this covers: the originator
   * publishing its own packet (rows 2/4/15), malformed/absent `gatewayId`
   * (rows 8/9), and missing `fromNode` (row 10). Not "self-publish"
   * specifically — just "sender opted out, no violation could be attributed".
   */
  | 'optedOut'
  /** The bit could not be read: absent, undecryptable, or captured before detection existed. */
  | 'unknown';

export interface OkToMqttFields {
  okToMqttViolation?: number | null;
  bitfield?: number | null;
}

export function okToMqttState(row: OkToMqttFields): OkToMqttState {
  if (Number(row.okToMqttViolation ?? 0) === 1) return 'violation';
  if (row.bitfield === null || row.bitfield === undefined) return 'unknown';
  return (Number(row.bitfield) & 1) === 1 ? 'ok' : 'optedOut';
}
