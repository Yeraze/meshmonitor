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

    // NOTE: MeshMonitor used to patch the removed v2.7 TrafficManagementConfig
    // bool toggles back into the schema here. That shim is gone (#5123): the
    // Traffic Management UI is gated on `supportsTrafficManagement()` —
    // firmware 2.8.0+ — which is exactly the firmware that reserved those tags,
    // so re-adding them could only ever put reserved bytes on the wire.

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
  /** Firmware 2.8+: device verified the packet's XEdDSA signature (#3923). */
  xeddsaSigned?: boolean;
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
  /** `ChannelSettings` — the PSK is `bytes`, so protobufjs yields a Uint8Array. */
  offerChannel?: { name?: string; psk?: Uint8Array };
  offer_channel?: { name?: string; psk?: Uint8Array };
  offerRegion?: number;
  offer_region?: number;
  offerPreset?: number;
  offer_preset?: number;
}