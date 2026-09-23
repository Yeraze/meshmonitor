/**
 * Shared SQL predicate for classifying a stored `TransportMechanism` column
 * into an RF/UDP/MQTT class (#5101).
 *
 * Two tables now need the same "stored mechanism -> class" predicate:
 * `packet_log.transport_mechanism` (Packet Monitor / Info tab packet split)
 * and `route_segments.transportMechanism` (Longest Active / Record Holder
 * per-transport records). Neither table has a `viaMqtt` companion column —
 * every writer already folds `viaMqtt` into the stored mechanism before
 * insert — so this predicate is exactly `classifyNodeTransport` with
 * `viaMqtt` absent: MQTT(5)->mqtt, MULTICAST_UDP(6)->udp, anything else
 * (incl. NULL) ->rf.
 *
 * NOT used for `messages`: that table classifies with `classifyMessageTransport`
 * (viaMqtt wins) in TypeScript, not SQL — see `MessagesRepository`.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { NodeTransportClass } from '../../utils/nodeTransport.js';
import { TransportMechanism } from '../../server/constants/meshtastic.js';

/**
 * Build the SQL condition matching rows of `column` (a stored
 * TransportMechanism integer, nullable) that classify as `cls`.
 */
export function transportClassCondition(column: SQL, cls: NodeTransportClass): SQL {
  switch (cls) {
    case 'mqtt':
      return sql`${column} = ${TransportMechanism.MQTT}`;
    case 'udp':
      return sql`${column} = ${TransportMechanism.MULTICAST_UDP}`;
    case 'rf':
      return sql`(${column} IS NULL OR ${column} NOT IN (${TransportMechanism.MQTT}, ${TransportMechanism.MULTICAST_UDP}))`;
  }
}
