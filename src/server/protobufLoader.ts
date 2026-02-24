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