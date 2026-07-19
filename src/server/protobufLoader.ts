/**
 * Loads and provides access to Meshtastic protobuf definitions
 */
import protobuf from 'protobufjs';
import path from 'path';
import { logger } from '../utils/logger.js';

let root: protobuf.Root | null = null;

export async function loadProtobufDefinitions(): Promise<protobuf.Root> {
  if (root) {
    return root;
  }

  try {
    // Set up the include paths for protobuf loading
    const protoRoot = path.join(process.cwd(), 'protobufs');

    // Load the main mesh.proto file which imports all others
    const protoPath = path.join(protoRoot, 'meshtastic/mesh.proto');

    // Create a root with proper include paths
    root = new protobuf.Root();
    root.resolvePath = (origin: string, target: string) => {
      // Handle relative imports from meshtastic/ directory
      if (target.startsWith('meshtastic/')) {
        return path.join(protoRoot, target);
      }
      return path.resolve(origin, target);
    };

    await root.load(protoPath);

    // Apply the 2.7 TrafficManagement compat patch immediately after the main
    // load (mesh.proto imports module_config.proto) so a failure loading any
    // of the later, unrelated protos can't leave TM in a broken state.
    restoreLegacyTrafficManagementFields(root);

    // Load admin.proto explicitly (not imported by mesh.proto)
    const adminProtoPath = path.join(protoRoot, 'meshtastic/admin.proto');
    await root.load(adminProtoPath);
    logger.debug('✅ Loaded admin.proto for AdminMessage support');

    // Load apponly.proto for ChannelSet support (used for import/export URLs)
    const apponlyProtoPath = path.join(protoRoot, 'meshtastic/apponly.proto');
    await root.load(apponlyProtoPath);
    logger.debug('✅ Loaded apponly.proto for ChannelSet support');

    // Load paxcount.proto for PAXCOUNTER_APP support
    const paxcountProtoPath = path.join(protoRoot, 'meshtastic/paxcount.proto');
    await root.load(paxcountProtoPath);
    logger.debug('✅ Loaded paxcount.proto for Paxcount support');

    // Load mqtt.proto for ServiceEnvelope support (MQTT proxy message decoding)
    const mqttProtoPath = path.join(protoRoot, 'meshtastic/mqtt.proto');
    await root.load(mqttProtoPath);
    logger.debug('✅ Loaded mqtt.proto for ServiceEnvelope support');

    // Load storeforward.proto for Store & Forward client support
    const storeForwardProtoPath = path.join(protoRoot, 'meshtastic/storeforward.proto');
    await root.load(storeForwardProtoPath);
    logger.debug('✅ Loaded storeforward.proto for Store & Forward support');

    // Load mesh_beacon.proto for MeshBeacon support (2.8 preview; not imported
    // by mesh.proto). MESH_BEACON_APP payload decode lands with #3854.
    const meshBeaconProtoPath = path.join(protoRoot, 'meshtastic/mesh_beacon.proto');
    await root.load(meshBeaconProtoPath);
    logger.debug('✅ Loaded mesh_beacon.proto for MeshBeacon support');

    logger.debug('✅ Successfully loaded Meshtastic protobuf definitions');
    return root;
  } catch (error) {
    logger.error('❌ Failed to load protobuf definitions:', error);
    throw error;
  }
}

/**
 * 2.7-compat schema patch for TrafficManagementConfig.
 *
 * The protobufs submodule is pinned to a 2.8-preview develop commit
 * (ba16bfc, ahead of v2.7.26) to enable MeshBeacon/XEdDSA work (#3854,
 * #3548, #3923). That range includes upstream commit d4f7ddb, which
 * REMOVED the v2.7.x TrafficManagementConfig bool-toggle fields (tags
 * 1,2,3,5,7,10,12,13,14 are now `reserved`) in favor of a
 * "non-zero implies enabled" convention for firmware 2.8.
 *
 * Shipping 2.7-alpha firmware (v2.7.20+) still uses those tags on the
 * wire, and MeshMonitor's Traffic Management config UI still reads and
 * writes them. Because the runtime schema comes straight from the
 * submodule's .proto files, dropping the fields would silently break TM
 * configuration for every existing user: encode would omit `enabled`
 * (tag 1) so the module could never be turned on, and decode would
 * discard the device's reported toggle state.
 *
 * `reserved` constrains the schema, not the wire — so re-adding the
 * fields here restores byte-for-byte v2.7.26 encode/decode behavior for
 * this one message while the rest of the schema tracks the 2.8 preview.
 *
 * REMOVE when firmware 2.8 ships and the TM config path grows a
 * version-aware dual schema (gate exists: supportsTrafficManagement()).
 * Tracked on #3548.
 *
 * Exported for tests (idempotency coverage); production code should rely on
 * loadProtobufDefinitions() calling it.
 */
export function restoreLegacyTrafficManagementFields(protoRoot: protobuf.Root): void {
  const legacyFields: Array<[name: string, id: number, type: string]> = [
    ['enabled', 1, 'bool'],
    ['positionDedupEnabled', 2, 'bool'],
    ['positionPrecisionBits', 3, 'uint32'],
    ['nodeinfoDirectResponse', 5, 'bool'],
    ['rateLimitEnabled', 7, 'bool'],
    ['dropUnknownEnabled', 10, 'bool'],
    ['exhaustHopTelemetry', 12, 'bool'],
    ['exhaustHopPosition', 13, 'bool'],
    ['routerPreserveHops', 14, 'bool'],
  ];
  try {
    const tmm = protoRoot.lookupType('meshtastic.ModuleConfig.TrafficManagementConfig');
    // Clear the reserved ranges/names so Type#add doesn't reject the ids.
    // Blunt on purpose: this wipes ALL reservations on this one message, so an
    // unrelated future upstream reservation (e.g. tags 15+) would be lost too.
    // Acceptable for a shim this short-lived; revisit if upstream reserves
    // anything else here before the shim is removed.
    tmm.reserved = [];
    for (const [name, id, type] of legacyFields) {
      // Skip anything upstream may have restored (or that a future tag
      // re-introduces) so this patch stays idempotent and non-clobbering.
      if (!tmm.fields[name] && !tmm.fieldsById[id]) {
        tmm.add(new protobuf.Field(name, id, type));
      }
    }
    logger.debug('✅ Restored legacy TrafficManagementConfig fields (2.7 firmware compat)');
  } catch (error) {
    // TM config would silently stop working — make that loud, but don't
    // take down every other protobuf consumer with it.
    logger.error('❌ Failed to restore legacy TrafficManagementConfig fields — Traffic Management configuration will not work against 2.7 firmware:', error);
  }
}

export function getProtobufRoot(): protobuf.Root | null {
  return root;
}

// Type definitions for key Meshtastic protobuf messages
export interface MeshPacket {
  to?: number;
  from?: number;
  id?: number;
  channel?: number;
  decoded?: Data;
  rxTime?: number;
  rxSnr?: number;
  rxRssi?: number;
  hopLimit?: number;
  hopStart?: number;
  wantAck?: boolean;
  priority?: number;
  relayNode?: number;
  viaMqtt?: boolean;
  encrypted?: Uint8Array;
  /** Transport mechanism - see TransportMechanism enum in constants/meshtastic.ts */
  transportMechanism?: number;
}

export interface Data {
  portnum?: number;
  payload?: Uint8Array;
  text?: string;
}

export interface FromRadio {
  id?: number;
  packet?: MeshPacket;
  myInfo?: any;
  nodeInfo?: any;
  config?: any;
  logRecord?: any;
  configCompleteId?: number;
  rebooted?: boolean;
  moduleConfig?: any;
  channel?: any;
  queueStatus?: any;
  xmodemPacket?: any;
  metadata?: any;
  mqttClientProxyMessage?: any;
}

export interface Position {
  latitudeI?: number;
  longitudeI?: number;
  altitude?: number;
  time?: number;
}

export interface User {
  id?: string;
  longName?: string;
  shortName?: string;
  macaddr?: Uint8Array;
  hwModel?: number;
}

export interface NodeInfo {
  num?: number;
  user?: User;
  position?: Position;
  snr?: number;
  lastHeard?: number;
  deviceMetrics?: any;
}

/**
 * Decoded MESH_BEACON_APP payload (firmware 2.8+, #3854). protobufjs may
 * surface fields in camelCase or snake_case depending on conversion options,
 * so both spellings are modeled.
 */
export interface MeshBeaconPayload {
  message?: string;
  offerChannel?: { name?: string };
  offer_channel?: { name?: string };
  offerRegion?: number;
  offer_region?: number;
  offerPreset?: number;
  offer_preset?: number;
}