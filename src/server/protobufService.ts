import protobuf from 'protobufjs';
import path from 'path';
import { getProtobufRoot } from './protobufLoader.js';
import { logger } from '../utils/logger.js';
import { PortNum } from './constants/meshtastic.js';

export interface MeshtasticPosition {
  latitude_i: number;
  longitude_i: number;
  altitude: number;
  time: number;
  location_source: number;
  altitude_source: number;
  timestamp: number;
  timestamp_millis_adjust: number;
  altitude_hae: number;
  altitude_geoidal_separation: number;
  PDOP: number;
  HDOP: number;
  VDOP: number;
  gps_accuracy: number;
  ground_speed: number;
  ground_track: number;
  fix_quality: number;
  fix_type: number;
  sats_in_view: number;
  sensor_id: number;
  next_update: number;
  seq_number: number;
  precision_bits: number;
}

export interface MeshtasticUser {
  id: string;
  long_name: string;
  short_name: string;
  macaddr: Uint8Array;
  hw_model: number;
  is_licensed: boolean;
  role: number;
  public_key: Uint8Array;
}

export interface MeshtasticNodeInfo {
  num: number;
  user?: MeshtasticUser;
  position?: MeshtasticPosition;
  snr: number;
  last_heard: number;
  device_metrics?: MeshtasticDeviceMetrics;
  channel: number;
  via_mqtt: boolean;
  hops_away: number;
  is_favorite: boolean;
}

export interface MeshtasticDeviceMetrics {
  battery_level: number;
  voltage: number;
  channel_utilization: number;
  air_util_tx: number;
  uptime_seconds: number;
}

export interface MeshtasticTelemetry {
  time: number;
  device_metrics?: MeshtasticDeviceMetrics;
  environment_metrics?: any;
  power_metrics?: any;
}

export interface MeshtasticRouting {
  route: number[];
  error_reason: number;
}

export interface MeshtasticMessage {
  id: number;
  rx_time: number;
  rx_snr: number;
  rx_rssi: number;
  hop_limit: number;
  hop_start: number;
  want_ack: boolean;
  priority: number;
  channel: number;
  encrypted: Uint8Array;
  unencrypted: any;  // Will contain decoded payload based on portnum
  from: number;
  to: number;
  decoded?: {
    portnum: number;
    payload: Uint8Array;
    want_response: boolean;
    dest: number;
    source: number;
    request_id: number;
    reply_id: number;
    emoji: number;
  };
}

/**
 * Convert a dotted-decimal IP address string to a 32-bit unsigned integer
 * Meshtastic stores IP addresses in little-endian format (first octet in LSB)
 * e.g., "192.168.1.100" -> octets stored as [192, 168, 1, 100] in little-endian
 */
export function ipStringToUint32(ip: string): number {
  if (!ip || typeof ip !== 'string') return 0;
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;

  const octets = parts.map(p => parseInt(p, 10));
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return 0;

  // Little-endian: first octet goes in LSB position
  return (octets[0] | (octets[1] << 8) | (octets[2] << 16) | (octets[3] << 24)) >>> 0;
}

/**
 * Convert a 32-bit unsigned integer to a dotted-decimal IP address string
 * Meshtastic stores IP addresses in little-endian format (first octet in LSB)
 * e.g., uint32 with first octet in LSB -> "192.168.1.100"
 */
export function uint32ToIpString(num: number): string {
  if (num === undefined || num === null || num === 0) return '';
  // Ensure we're working with an unsigned 32-bit integer
  const unsigned = num >>> 0;
  // Little-endian: extract first octet from LSB
  return [
    unsigned & 0xFF,
    (unsigned >>> 8) & 0xFF,
    (unsigned >>> 16) & 0xFF,
    (unsigned >>> 24) & 0xFF
  ].join('.');
}

/**
 * Convert ipv4Config object from uint32 values to string format (for frontend display)
 */
export function convertIpv4ConfigToStrings(config: any): any {
  if (!config) return config;
  return {
    ip: uint32ToIpString(config.ip),
    gateway: uint32ToIpString(config.gateway),
    subnet: uint32ToIpString(config.subnet),
    dns: uint32ToIpString(config.dns)
  };
}

/**
 * Convert ipv4Config object from string format to uint32 values (for protobuf encoding)
 */
export function convertIpv4ConfigToUint32(config: any): any {
  if (!config) return config;
  return {
    ip: ipStringToUint32(config.ip),
    gateway: ipStringToUint32(config.gateway),
    subnet: ipStringToUint32(config.subnet),
    dns: ipStringToUint32(config.dns)
  };
}

class ProtobufService {
  private root: protobuf.Root | null = null;
  private types: Map<string, protobuf.Type> = new Map();
  private enums: Map<string, protobuf.Enum> = new Map();
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logger.debug('🔧 Initializing protobuf service...');

      const protoDir = '/app/protobufs';
      logger.debug(`Loading proto files from: ${protoDir}`);

      // Load mesh.proto with the proper root path for imports
      this.root = new protobuf.Root();
      this.root.resolvePath = (origin: string, target: string) => {
        logger.debug(`Resolving import: origin=${origin}, target=${target}`);
        if (target.startsWith('meshtastic/')) {
          const resolved = path.join(protoDir, target);
          logger.debug(`Resolved to: ${resolved}`);
          return resolved;
        }
        return protobuf.util.path.resolve(origin, target);
      };

      await this.root.load(path.join(protoDir, 'meshtastic/mesh.proto'));

      // Load admin.proto explicitly (not imported by mesh.proto)
      await this.root.load(path.join(protoDir, 'meshtastic/admin.proto'));
      logger.debug('✅ Loaded admin.proto for AdminMessage support');

      // Cache available enums
      this.cacheEnum('meshtastic.PortNum');

      this.isInitialized = true;
      logger.debug('✅ Protobuf service initialized successfully');

    } catch (error) {
      logger.error('❌ Failed to initialize protobuf service:', error);
      throw error;
    }
  }



  private cacheEnum(enumName: string): void {
    const enumType = this.root?.lookupEnum(enumName);
    if (enumType) {
      this.enums.set(enumName, enumType);
      logger.debug(`📦 Cached enum: ${enumName}`);
    } else {
      logger.warn(`⚠️  Could not find enum: ${enumName}`);
    }
  }

  getPortNum(): protobuf.Enum | undefined {
    return this.enums.get('meshtastic.PortNum');
  }

  getHardwareModel(): protobuf.Enum | undefined {
    return this.enums.get('meshtastic.HardwareModel');
  }

  // Position message parsing - decode using mesh.proto definition
  decodePosition(data: Uint8Array): MeshtasticPosition | null {
    try {
      logger.debug('🗺️  Attempting to decode position data with protobuf...');

      const Position = this.root?.lookupType('meshtastic.Position');
      if (!Position) {
        logger.error('🗺️  Position type not found in loaded proto files');
        return null;
      }

      const decoded = Position.decode(data);
      const position = Position.toObject(decoded);
      logger.debug('🗺️  Decoded position:', JSON.stringify(position, null, 2));

      // Map protobuf field names to our interface
      return {
        latitude_i: position.latitudeI || 0,
        longitude_i: position.longitudeI || 0,
        altitude: position.altitude || 0,
        time: position.time || 0,
        location_source: position.locationSource || 0,
        altitude_source: position.altitudeSource || 0,
        timestamp: position.timestamp || 0,
        timestamp_millis_adjust: position.timestampMillisAdjust || 0,
        altitude_hae: position.altitudeHae || 0,
        altitude_geoidal_separation: position.altitudeGeoidalSeparation || 0,
        PDOP: position.PDOP || 0,
        HDOP: position.HDOP || 0,
        VDOP: position.VDOP || 0,
        gps_accuracy: position.gpsAccuracy || 0,
        ground_speed: position.groundSpeed || 0,
        ground_track: position.groundTrack || 0,
        fix_quality: position.fixQuality || 0,
        fix_type: position.fixType || 0,
        sats_in_view: position.satsInView || 0,
        sensor_id: position.sensorId || 0,
        next_update: position.nextUpdate || 0,
        seq_number: position.seqNumber || 0,
        precision_bits: position.precisionBits || 0
      };
    } catch (error) {
      logger.error('Failed to decode Position message:', error);
      return null;
    }
  }

  // User message parsing - decode using mesh.proto definition
  decodeUser(data: Uint8Array): MeshtasticUser | null {
    try {
      logger.debug('👤 Attempting to decode user data with protobuf...');

      const User = this.root?.lookupType('meshtastic.User');
      if (!User) {
        logger.error('👤 User type not found in loaded proto files');
        return null;
      }

      const decoded = User.decode(data);
      const user = User.toObject(decoded);
      logger.debug('👤 Decoded user:', JSON.stringify(user, null, 2));

      return {
        id: user.id || '',
        long_name: user.longName || '',
        short_name: user.shortName || '',
        macaddr: user.macaddr || new Uint8Array(),
        hw_model: user.hwModel || 0,
        is_licensed: user.isLicensed || false,
        role: user.role || 0,
        public_key: user.publicKey || new Uint8Array()
      };
    } catch (error) {
      logger.error('Failed to decode User message:', error);
      return null;
    }
  }

  // NodeInfo message parsing - decode using mesh.proto definition
  decodeNodeInfo(data: Uint8Array): MeshtasticNodeInfo | null {
    try {
      logger.debug('🏠 Attempting to decode NodeInfo data with protobuf...');

      const NodeInfo = this.root?.lookupType('meshtastic.NodeInfo');
      if (!NodeInfo) {
        logger.error('🏠 NodeInfo type not found in loaded proto files');
        return null;
      }

      const decoded = NodeInfo.decode(data);
      const nodeInfo = NodeInfo.toObject(decoded);
      logger.debug('🏠 Decoded NodeInfo:', JSON.stringify(nodeInfo, null, 2));

      // Extract embedded User and Position data
      let user: MeshtasticUser | undefined = undefined;
      let position: MeshtasticPosition | undefined = undefined;
      let deviceMetrics: MeshtasticDeviceMetrics | undefined = undefined;

      // Decode embedded User if present
      if (nodeInfo.user) {
        user = {
          id: nodeInfo.user.id || '',
          long_name: nodeInfo.user.longName || '',
          short_name: nodeInfo.user.shortName || '',
          macaddr: nodeInfo.user.macaddr || new Uint8Array(),
          hw_model: nodeInfo.user.hwModel || 0,
          is_licensed: nodeInfo.user.isLicensed || false,
          role: nodeInfo.user.role || 0,
          public_key: nodeInfo.user.publicKey || new Uint8Array()
        };
        logger.debug('🏠 NodeInfo contains user data:', user.long_name);
      }

      // Decode embedded Position if present
      if (nodeInfo.position && (nodeInfo.position.latitudeI || nodeInfo.position.longitudeI)) {
        position = {
          latitude_i: nodeInfo.position.latitudeI || 0,
          longitude_i: nodeInfo.position.longitudeI || 0,
          altitude: nodeInfo.position.altitude || 0,
          time: nodeInfo.position.time || 0,
          location_source: nodeInfo.position.locationSource || 0,
          altitude_source: nodeInfo.position.altitudeSource || 0,
          timestamp: nodeInfo.position.timestamp || 0,
          timestamp_millis_adjust: nodeInfo.position.timestampMillisAdjust || 0,
          altitude_hae: nodeInfo.position.altitudeHae || 0,
          altitude_geoidal_separation: nodeInfo.position.altitudeGeoidalSeparation || 0,
          PDOP: nodeInfo.position.PDOP || 0,
          HDOP: nodeInfo.position.HDOP || 0,
          VDOP: nodeInfo.position.VDOP || 0,
          gps_accuracy: nodeInfo.position.gpsAccuracy || 0,
          ground_speed: nodeInfo.position.groundSpeed || 0,
          ground_track: nodeInfo.position.groundTrack || 0,
          fix_quality: nodeInfo.position.fixQuality || 0,
          fix_type: nodeInfo.position.fixType || 0,
          sats_in_view: nodeInfo.position.satsInView || 0,
          sensor_id: nodeInfo.position.sensorId || 0,
          next_update: nodeInfo.position.nextUpdate || 0,
          seq_number: nodeInfo.position.seqNumber || 0,
          precision_bits: nodeInfo.position.precisionBits || 0
        };
        logger.debug(`🗺️ NodeInfo contains position data: ${position.latitude_i}, ${position.longitude_i}`);
      }

      // Decode embedded DeviceMetrics if present
      if (nodeInfo.deviceMetrics) {
        deviceMetrics = {
          battery_level: nodeInfo.deviceMetrics.batteryLevel || 0,
          voltage: nodeInfo.deviceMetrics.voltage || 0,
          channel_utilization: nodeInfo.deviceMetrics.channelUtilization || 0,
          air_util_tx: nodeInfo.deviceMetrics.airUtilTx || 0,
          uptime_seconds: nodeInfo.deviceMetrics.uptimeSeconds || 0
        };
        logger.debug('🏠 NodeInfo contains device metrics');
      }

      logger.debug('🏠 NodeInfo components extracted - User:', !!user, 'Position:', !!position, 'DeviceMetrics:', !!deviceMetrics);

      // Map the decoded data to our interface
      const result: MeshtasticNodeInfo = {
        num: nodeInfo.num || 0,
        snr: nodeInfo.snr || 0,
        last_heard: nodeInfo.lastHeard || 0,
        channel: nodeInfo.channel || 0,
        via_mqtt: nodeInfo.viaMqtt || false,
        hops_away: nodeInfo.hopsAway || 0,
        is_favorite: nodeInfo.isFavorite || false,
        user,
        position,
        device_metrics: deviceMetrics
      };

      return result;
    } catch (error) {
      logger.error('Failed to decode NodeInfo message:', error);
      return null;
    }
  }

  decodeDeviceMetrics(_data: Uint8Array): MeshtasticDeviceMetrics | null {
    logger.debug('📊 DeviceMetrics decoding not implemented yet');
    return null;
  }

  decodeTelemetry(_data: Uint8Array): MeshtasticTelemetry | null {
    logger.debug('📡 Telemetry decoding not implemented yet');
    return null;
  }

  decodeFromRadio(data: Uint8Array): any | null {
    try {
      logger.debug('📻 Attempting to decode FromRadio with protobuf...');

      const FromRadio = this.root?.lookupType('meshtastic.FromRadio');
      if (!FromRadio) {
        logger.error('📻 FromRadio type not found in loaded proto files');
        return null;
      }

      const decoded = FromRadio.decode(data);
      const fromRadio = FromRadio.toObject(decoded);
      logger.debug('📻 Decoded FromRadio:', JSON.stringify(fromRadio, null, 2));

      return fromRadio;
    } catch (error) {
      logger.error('Failed to decode FromRadio message:', error);
      return null;
    }
  }

  decodeMeshPacket(data: Uint8Array): MeshtasticMessage | null {
    try {
      logger.debug('📦 Attempting to decode MeshPacket with protobuf...');

      const MeshPacket = this.root?.lookupType('meshtastic.MeshPacket');
      if (!MeshPacket) {
        logger.error('📦 MeshPacket type not found in loaded proto files');
        return null;
      }

      const decoded = MeshPacket.decode(data);
      const meshPacket = MeshPacket.toObject(decoded);
      logger.debug('📦 Decoded MeshPacket:', JSON.stringify(meshPacket, null, 2));

      // Extract the decoded payload if available
      let unencrypted: any = null;
      if (meshPacket.decoded) {
        logger.debug('📦 Processing decoded payload...');
        unencrypted = {
          portnum: meshPacket.decoded.portnum || 0,
          payload: meshPacket.decoded.payload || new Uint8Array(),
          want_response: meshPacket.decoded.wantResponse || false,
          dest: meshPacket.decoded.dest || 0,
          source: meshPacket.decoded.source || 0,
          request_id: meshPacket.decoded.requestId || 0,
          reply_id: meshPacket.decoded.replyId || 0,
          emoji: meshPacket.decoded.emoji || 0
        };

        // Try to decode specific payload types based on portnum
        if (unencrypted.payload && unencrypted.payload.length > 0) {
          logger.debug(`📦 Attempting to decode payload for port ${unencrypted.portnum} (${this.getPortNumName(unencrypted.portnum)})`);

          switch (unencrypted.portnum) {
            case PortNum.POSITION_APP:
              const position = this.decodePosition(unencrypted.payload);
              if (position) {
                logger.debug('📦 Successfully decoded position from MeshPacket payload');
                unencrypted.decodedPayload = position;
              }
              break;
            case PortNum.NODEINFO_APP:
              const nodeInfo = this.decodeNodeInfo(unencrypted.payload);
              if (nodeInfo) {
                logger.debug('📦 Successfully decoded NodeInfo from MeshPacket payload');
                unencrypted.decodedPayload = nodeInfo;
              }
              break;
            case PortNum.TELEMETRY_APP:
              const telemetry = this.decodeTelemetry(unencrypted.payload);
              if (telemetry) {
                logger.debug('📦 Successfully decoded telemetry from MeshPacket payload');
                unencrypted.decodedPayload = telemetry;
              }
              break;
            default:
              logger.debug(`📦 No specific decoder for port ${unencrypted.portnum}`);
              break;
          }
        }
      }

      if (unencrypted) {
        logger.debug('🔍 Unencrypted Data fields:', {
          portnum: unencrypted.portnum,
          payloadLength: unencrypted.payload?.length,
          wantResponse: unencrypted.wantResponse,
          dest: unencrypted.dest,
          source: unencrypted.source,
          requestId: unencrypted.requestId,
          replyId: unencrypted.replyId,
          emoji: unencrypted.emoji
        });
      }

      const result: MeshtasticMessage = {
        id: meshPacket.id || 0,
        rx_time: meshPacket.rxTime || 0,
        rx_snr: meshPacket.rxSnr || 0,
        rx_rssi: meshPacket.rxRssi || 0,
        hop_limit: meshPacket.hopLimit || 0,
        hop_start: meshPacket.hopStart || 0,
        want_ack: meshPacket.wantAck || false,
        priority: meshPacket.priority || 0,
        channel: meshPacket.channel || 0,
        encrypted: meshPacket.encrypted || new Uint8Array(),
        unencrypted,
        from: meshPacket.from || 0,
        to: meshPacket.to || 0,
        decoded: unencrypted ? {
          portnum: unencrypted.portnum,
          payload: unencrypted.payload,
          want_response: unencrypted.wantResponse,
          dest: unencrypted.dest,
          source: unencrypted.source,
          request_id: unencrypted.requestId,
          reply_id: unencrypted.replyId,
          emoji: unencrypted.emoji
        } : undefined
      };

      return result;
    } catch (error) {
      logger.error('Failed to decode MeshPacket message:', error);
      return null;
    }
  }

  // Helper method to convert latitude/longitude integers to decimal degrees
  convertCoordinates(latitudeI: number, longitudeI: number): { latitude: number; longitude: number } {
    return {
      latitude: latitudeI / 10000000,  // Convert from int32 * 1e7 to decimal degrees
      longitude: longitudeI / 10000000
    };
  }

  // Helper method to get port number name from enum
  getPortNumName(portnum: number): string {
    const PortNumEnum = this.getPortNum();
    if (PortNumEnum) {
      return PortNumEnum.valuesById[portnum] || `UNKNOWN_${portnum}`;
    }
    return `UNKNOWN_${portnum}`;
  }

  // Helper method to get hardware model name from enum
  getHardwareModelName(hwModel: number): string {
    const HardwareModelEnum = this.getHardwareModel();
    if (HardwareModelEnum) {
      return HardwareModelEnum.valuesById[hwModel] || `UNKNOWN_${hwModel}`;
    }
    return `UNKNOWN_${hwModel}`;
  }

  // Debug method to inspect protobuf structure
  inspectMessage(data: Uint8Array, typeName: string): any {
    try {
      const MessageType = this.types.get(typeName);
      if (!MessageType) {
        logger.error(`Type ${typeName} not found`);
        return null;
      }

      const message = MessageType.decode(data);
      logger.debug(`🔍 Inspecting ${typeName}:`, JSON.stringify(message, null, 2));
      return message;
    } catch (error) {
      logger.error(`Failed to inspect ${typeName}:`, error);
      return null;
    }
  }

  /**
   * Create an AdminMessage to request session passkey
   */
  createGetSessionKeyRequest(): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      // SESSIONKEY_CONFIG = 8 (from admin.proto ConfigType enum)
      const adminMsg = AdminMessage.create({
        getConfigRequest: 8  // SESSIONKEY_CONFIG
      });

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created GetSessionKey request (getConfigRequest=SESSIONKEY_CONFIG)');
      return encoded;
    } catch (error) {
      logger.error('Failed to create GetSessionKey request:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set a node as favorite
   * @param nodeNum The node number to favorite
   * @param sessionPasskey The session passkey from the device
   */
  createSetFavoriteNodeMessage(nodeNum: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        setFavoriteNode: nodeNum
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created SetFavoriteNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetFavoriteNode message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to remove a node from favorites
   * @param nodeNum The node number to unfavorite
   * @param sessionPasskey The session passkey from the device
   */
  createRemoveFavoriteNodeMessage(nodeNum: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        removeFavoriteNode: nodeNum
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created RemoveFavoriteNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create RemoveFavoriteNode message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set a node as ignored
   * @param nodeNum The node number to ignore
   * @param sessionPasskey The session passkey from the device
   */
  createSetIgnoredNodeMessage(nodeNum: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        setIgnoredNode: nodeNum
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created SetIgnoredNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetIgnoredNode message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to remove a node from ignored list
   * @param nodeNum The node number to un-ignore
   * @param sessionPasskey The session passkey from the device
   */
  createRemoveIgnoredNodeMessage(nodeNum: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        removeIgnoredNode: nodeNum
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created RemoveIgnoredNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create RemoveIgnoredNode message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to remove a node from the device NodeDB
   * @param nodeNum The node number to remove from the device
   * @param sessionPasskey Optional session passkey for authentication
   */
  createRemoveNodeMessage(nodeNum: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        removeByNodenum: nodeNum
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created RemoveNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create RemoveNode message:', error);
      throw error;
    }
  }

  /**
   * Decode an AdminMessage response
   */
  decodeAdminMessage(data: Uint8Array): any {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const decoded = AdminMessage.decode(data);
      // Use toObject with proper options to ensure nested objects are converted to camelCase
      const adminMsg = AdminMessage.toObject(decoded, {
        longs: String,
        enums: Number,  // Use Number instead of String to preserve enum values (0, 1, 2)
        bytes: Buffer,  // Use Buffer instead of String to preserve byte arrays
        defaults: true,
        arrays: true,
        objects: true,
        oneofs: true
      });
      
      // If there's a getChannelResponse, ensure the nested Channel object is properly converted
      if (adminMsg.getChannelResponse) {
        const Channel = root?.lookupType('meshtastic.Channel');
        if (Channel) {
          // Re-encode and decode the channel to ensure proper conversion
          const channelEncoded = Channel.encode(adminMsg.getChannelResponse).finish();
          const channelDecoded = Channel.decode(channelEncoded);
          adminMsg.getChannelResponse = Channel.toObject(channelDecoded, {
            longs: String,
            enums: Number,  // Use Number instead of String to preserve enum values
            bytes: Buffer,  // Use Buffer instead of String to preserve byte arrays
            defaults: true,
            arrays: true,
            objects: true,
            oneofs: true
          });
        }
      }
      
      // If there's a getConfigResponse, ensure the nested Config object is properly converted
      if (adminMsg.getConfigResponse) {
        const Config = root?.lookupType('meshtastic.Config');
        if (Config) {
          try {
            // Check if it's already a plain object (has direct property access)
            // Protobuf message objects have methods like .toJSON(), .encode(), etc.
            const isPlainObject = !adminMsg.getConfigResponse.encode && !adminMsg.getConfigResponse.toJSON;
            
            if (isPlainObject) {
              // Already a plain object, but ensure nested objects are converted
              // Re-encode and decode to ensure all nested fields are properly converted
              const configMessage = Config.create(adminMsg.getConfigResponse);
              const configEncoded = Config.encode(configMessage).finish();
              const configDecoded = Config.decode(configEncoded);
              adminMsg.getConfigResponse = Config.toObject(configDecoded, {
                longs: String,
                enums: Number,
                bytes: Buffer,
                defaults: true,
                arrays: true,
                objects: true,
                oneofs: true
              });
            } else {
              // It's a protobuf message object, convert it to a plain object
              adminMsg.getConfigResponse = Config.toObject(adminMsg.getConfigResponse, {
                longs: String,
                enums: Number,
                bytes: Buffer,
                defaults: true,
                arrays: true,
                objects: true,
                oneofs: true
              });
            }
            logger.debug('⚙️ Converted getConfigResponse to plain object, keys:', Object.keys(adminMsg.getConfigResponse || {}));
          } catch (error) {
            logger.error('Failed to convert getConfigResponse:', error);
            // If conversion fails, try to use the object as-is (might already be a plain object)
          }
        }
      }
      
      // If there's a getModuleConfigResponse, ensure the nested ModuleConfig object is properly converted
      if (adminMsg.getModuleConfigResponse) {
        const ModuleConfig = root?.lookupType('meshtastic.ModuleConfig');
        if (ModuleConfig) {
          try {
            // Check if it's already a plain object (has direct property access)
            // Protobuf message objects have methods like .toJSON(), .encode(), etc.
            const isPlainObject = !adminMsg.getModuleConfigResponse.encode && !adminMsg.getModuleConfigResponse.toJSON;
            
            if (isPlainObject) {
              // Already a plain object, but ensure nested objects are converted
              // Re-encode and decode to ensure all nested fields are properly converted
              const moduleConfigMessage = ModuleConfig.create(adminMsg.getModuleConfigResponse);
              const moduleConfigEncoded = ModuleConfig.encode(moduleConfigMessage).finish();
              const moduleConfigDecoded = ModuleConfig.decode(moduleConfigEncoded);
              adminMsg.getModuleConfigResponse = ModuleConfig.toObject(moduleConfigDecoded, {
                longs: String,
                enums: Number,
                bytes: Buffer,
                defaults: true,
                arrays: true,
                objects: true,
                oneofs: true
              });
            } else {
              // It's a protobuf message object, convert it to a plain object
              adminMsg.getModuleConfigResponse = ModuleConfig.toObject(adminMsg.getModuleConfigResponse, {
                longs: String,
                enums: Number,
                bytes: Buffer,
                defaults: true,
                arrays: true,
                objects: true,
                oneofs: true
              });
            }
            logger.debug('⚙️ Converted getModuleConfigResponse to plain object, keys:', Object.keys(adminMsg.getModuleConfigResponse || {}));
          } catch (error) {
            logger.error('Failed to convert getModuleConfigResponse:', error);
            // If conversion fails, try to use the object as-is (might already be a plain object)
          }
        }
      }
      
      logger.debug('⚙️ Decoded AdminMessage:', JSON.stringify(adminMsg, null, 2));
      return adminMsg;
    } catch (error) {
      logger.error('Failed to decode AdminMessage:', error);
      return null;
    }
  }

  /**
   * Create an AdminMessage to get a specific config type from the device
   * @param configType The config type to request (DEVICE_CONFIG=0, LORA_CONFIG=5, etc.)
   */
  createGetConfigRequest(configType: number): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsg = AdminMessage.create({
        getConfigRequest: configType
      });

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created GetConfig request (configType=${configType})`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create GetConfig request:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to get a specific module config type from the device
   * @param configType The module config type to request (MQTT_CONFIG=0, NEIGHBORINFO_CONFIG=9, etc.)
   */
  createGetModuleConfigRequest(configType: number): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsg = AdminMessage.create({
        getModuleConfigRequest: configType
      });

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created GetModuleConfig request (configType=${configType})`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create GetModuleConfig request:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set device configuration (role, broadcast intervals, etc.)
   * @param config Device config object with role, node_info_broadcast_secs, etc.
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetDeviceConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      // Convert config fields to format expected by protobufjs
      // Note: protobufjs uses camelCase for field names, not snake_case
      const deviceConfig: any = {};
      if (config.role !== undefined) {
        deviceConfig.role = config.role;
      }
      if (config.nodeInfoBroadcastSecs !== undefined) {
        deviceConfig.nodeInfoBroadcastSecs = config.nodeInfoBroadcastSecs;
      }
      if (config.tzdef !== undefined) {
        deviceConfig.tzdef = config.tzdef;
      }
      if (config.rebroadcastMode !== undefined) {
        deviceConfig.rebroadcastMode = config.rebroadcastMode;
      }
      if (config.doubleTapAsButtonPress !== undefined) {
        deviceConfig.doubleTapAsButtonPress = config.doubleTapAsButtonPress;
      }
      if (config.disableTripleClick !== undefined) {
        deviceConfig.disableTripleClick = config.disableTripleClick;
      }
      if (config.ledHeartbeatDisabled !== undefined) {
        deviceConfig.ledHeartbeatDisabled = config.ledHeartbeatDisabled;
      }
      if (config.buzzerMode !== undefined) {
        deviceConfig.buzzerMode = config.buzzerMode;
      }
      if (config.buttonGpio !== undefined) {
        deviceConfig.buttonGpio = config.buttonGpio;
      }
      if (config.buzzerGpio !== undefined) {
        deviceConfig.buzzerGpio = config.buzzerGpio;
      }

      logger.debug('⚙️ Sending device config:', JSON.stringify(deviceConfig));

      const configMsg = Config.create({
        device: deviceConfig
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetDeviceConfig admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetDeviceConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set LoRa configuration (preset, region, etc.)
   * @param config LoRa config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetLoRaConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      // Build LoRa config object, ensuring fields with value 0 or false are included
      // This is critical for modemPreset which can be 0 (LONG_FAST)
      const loraConfigData: any = {};
      if (config.usePreset !== undefined) loraConfigData.usePreset = config.usePreset;
      if (config.modemPreset !== undefined) loraConfigData.modemPreset = config.modemPreset;
      if (config.bandwidth !== undefined) loraConfigData.bandwidth = config.bandwidth;
      if (config.spreadFactor !== undefined) loraConfigData.spreadFactor = config.spreadFactor;
      if (config.codingRate !== undefined) loraConfigData.codingRate = config.codingRate;
      if (config.frequencyOffset !== undefined) loraConfigData.frequencyOffset = config.frequencyOffset;
      if (config.region !== undefined) loraConfigData.region = config.region;
      if (config.hopLimit !== undefined) loraConfigData.hopLimit = config.hopLimit;
      if (config.txEnabled !== undefined) loraConfigData.txEnabled = config.txEnabled;
      if (config.txPower !== undefined) loraConfigData.txPower = config.txPower;
      if (config.channelNum !== undefined) loraConfigData.channelNum = config.channelNum;
      if (config.sx126xRxBoostedGain !== undefined) loraConfigData.sx126xRxBoostedGain = config.sx126xRxBoostedGain;
      if (config.configOkToMqtt !== undefined) loraConfigData.configOkToMqtt = config.configOkToMqtt;
      if (config.ignoreIncoming !== undefined) loraConfigData.ignoreIncoming = config.ignoreIncoming;
      if (config.overrideDutyCycle !== undefined) loraConfigData.overrideDutyCycle = config.overrideDutyCycle;
      if (config.overrideFrequency !== undefined) loraConfigData.overrideFrequency = config.overrideFrequency;
      if (config.paFanDisabled !== undefined) loraConfigData.paFanDisabled = config.paFanDisabled;
      if (config.ignoreMqtt !== undefined) loraConfigData.ignoreMqtt = config.ignoreMqtt;

      logger.debug('LoRa config data being sent to device:', JSON.stringify(loraConfigData, null, 2));

      const configMsg = Config.create({
        lora: loraConfigData
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetLoRaConfig admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetLoRaConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set security configuration (admin keys, etc.)
   * @param config Security config object with adminKeys (array of base64 or hex strings), isManaged, serialEnabled, etc.
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetSecurityConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      const securityConfigData: any = {};

      // Handle admin keys - convert from base64/hex strings to Uint8Array
      // Maximum of 3 admin keys allowed (per protobuf config.options)
      if (config.adminKeys && Array.isArray(config.adminKeys)) {
        const validKeys = config.adminKeys
          .filter((key: string) => key && key.trim().length > 0)
          .slice(0, 3); // Enforce max 3 keys
        
        if (config.adminKeys.length > 3) {
          logger.warn(`⚠️ More than 3 admin keys provided (${config.adminKeys.length}), only using first 3`);
        }
        
        securityConfigData.adminKey = validKeys.map((key: string) => {
            const trimmed = key.trim();
            try {
              // Try base64 first
              if (trimmed.startsWith('base64:')) {
                return Buffer.from(trimmed.substring(7), 'base64');
              }
              // Try hex
              if (trimmed.startsWith('0x') || /^[0-9a-fA-F]{64}$/.test(trimmed)) {
                const hex = trimmed.startsWith('0x') ? trimmed.substring(2) : trimmed;
                return Buffer.from(hex, 'hex');
              }
              // Try base64 without prefix
              return Buffer.from(trimmed, 'base64');
            } catch (error) {
              logger.error(`Failed to parse admin key "${trimmed}":`, error);
              throw new Error(`Invalid admin key format: ${trimmed}. Use base64 or hex format.`);
            }
          });
      }

      if (config.isManaged !== undefined) securityConfigData.isManaged = config.isManaged;
      if (config.serialEnabled !== undefined) securityConfigData.serialEnabled = config.serialEnabled;
      if (config.debugLogApiEnabled !== undefined) securityConfigData.debugLogApiEnabled = config.debugLogApiEnabled;
      if (config.adminChannelEnabled !== undefined) securityConfigData.adminChannelEnabled = config.adminChannelEnabled;

      // IMPORTANT: Include public_key and private_key to preserve them when updating other settings
      // If we don't include them, the firmware may reset them to empty/random values
      if (config.publicKey) {
        try {
          securityConfigData.publicKey = Buffer.from(config.publicKey, 'base64');
          logger.debug('Including existing public key in security config update');
        } catch (error) {
          logger.warn('Failed to parse public key, not including in update:', error);
        }
      }
      if (config.privateKey) {
        try {
          securityConfigData.privateKey = Buffer.from(config.privateKey, 'base64');
          logger.debug('Including existing private key in security config update');
        } catch (error) {
          logger.warn('Failed to parse private key, not including in update:', error);
        }
      }

      logger.debug('Security config data being sent to device:', JSON.stringify({
        ...securityConfigData,
        adminKey: securityConfigData.adminKey ? `${securityConfigData.adminKey.length} key(s)` : 'none',
        publicKey: securityConfigData.publicKey ? '[PRESENT]' : '[NOT SET]',
        privateKey: securityConfigData.privateKey ? '[PRESENT]' : '[NOT SET]'
      }, null, 2));

      const configMsg = Config.create({
        security: securityConfigData
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetSecurityConfig admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetSecurityConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set network configuration (NTP server, etc.)
   * @param config Network config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetNetworkConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      // Build network config object - include ALL fields to avoid wiping existing config
      // NetworkConfig fields: wifiEnabled, wifiSsid, wifiPsk, ntpServer, ethEnabled,
      // addressMode, ipv4Config, rsyslogServer, enabledProtocols, ipv6Enabled
      const networkConfig: any = {};

      // Boolean fields - must explicitly include to preserve values
      if (config.wifiEnabled !== undefined) {
        networkConfig.wifiEnabled = config.wifiEnabled;
      }
      if (config.wifiSsid !== undefined) {
        networkConfig.wifiSsid = config.wifiSsid;
      }
      if (config.wifiPsk !== undefined) {
        networkConfig.wifiPsk = config.wifiPsk;
      }
      if (config.ntpServer !== undefined) {
        networkConfig.ntpServer = config.ntpServer;
      }
      if (config.ethEnabled !== undefined) {
        networkConfig.ethEnabled = config.ethEnabled;
      }
      if (config.addressMode !== undefined) {
        networkConfig.addressMode = config.addressMode;
      }
      if (config.ipv4Config !== undefined) {
        // Convert string IP addresses to uint32 for protobuf encoding
        networkConfig.ipv4Config = convertIpv4ConfigToUint32(config.ipv4Config);
      }
      if (config.rsyslogServer !== undefined) {
        networkConfig.rsyslogServer = config.rsyslogServer;
      }
      if (config.enabledProtocols !== undefined) {
        networkConfig.enabledProtocols = config.enabledProtocols;
      }
      if (config.ipv6Enabled !== undefined) {
        networkConfig.ipv6Enabled = config.ipv6Enabled;
      }

      logger.debug('⚙️ Sending network config:', JSON.stringify(networkConfig));

      const configMsg = Config.create({
        network: networkConfig
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetNetworkConfig admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetNetworkConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set channel configuration
   * @param channelIndex The channel index (0-7)
   * @param config Channel configuration
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetChannelMessage(channelIndex: number, config: {
    name?: string;
    psk?: string;
    role?: number;
    uplinkEnabled?: boolean;
    downlinkEnabled?: boolean;
    positionPrecision?: number;
  }, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Channel = root?.lookupType('meshtastic.Channel');
      const ChannelSettings = root?.lookupType('meshtastic.ChannelSettings');
      if (!AdminMessage || !Channel || !ChannelSettings) {
        throw new Error('Required proto types not found');
      }

      // Create channel settings
      const settingsData: any = {};
      if (config.name !== undefined) {
        settingsData.name = config.name;
      }
      if (config.psk !== undefined) {
        // Handle shorthand PSK values and convert to bytes
        if (config.psk === 'none') {
          settingsData.psk = Buffer.from([0]);
        } else if (config.psk === 'default') {
          settingsData.psk = Buffer.from([1]);
        } else if (config.psk.startsWith('simple')) {
          const num = parseInt(config.psk.replace('simple', ''));
          settingsData.psk = Buffer.from([num + 1]);
        } else {
          // Assume it's a base64 encoded key
          settingsData.psk = Buffer.from(config.psk, 'base64');
        }
      }
      if (config.uplinkEnabled !== undefined) {
        settingsData.uplinkEnabled = config.uplinkEnabled;
      }
      if (config.downlinkEnabled !== undefined) {
        settingsData.downlinkEnabled = config.downlinkEnabled;
      }
      if (config.positionPrecision !== undefined) {
        settingsData.moduleSettings = {
          positionPrecision: config.positionPrecision
        };
      }

      const settings = ChannelSettings.create(settingsData);

      // Create channel with index and settings
      const channelData: any = {
        index: channelIndex,
        settings
      };

      if (config.role !== undefined) {
        channelData.role = config.role;
      }

      const channel = Channel.create(channelData);

      const adminMsgData: any = {
        setChannel: channel
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created SetChannel admin message for channel ${channelIndex}`);
      return encoded;
    } catch (error) {
      logger.error(`Failed to create SetChannel message for channel ${channelIndex}:`, error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set position configuration (broadcast intervals, etc.)
   * @param config Position config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetPositionConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      // Build position config object, ensuring all fields are properly mapped
      // protobufjs uses camelCase for field names (converts from snake_case automatically)
      const positionConfigData: any = {};
      
      if (config.positionBroadcastSecs !== undefined) positionConfigData.positionBroadcastSecs = config.positionBroadcastSecs;
      if (config.positionBroadcastSmartEnabled !== undefined) positionConfigData.positionBroadcastSmartEnabled = config.positionBroadcastSmartEnabled;
      if (config.fixedPosition !== undefined) positionConfigData.fixedPosition = config.fixedPosition;
      if (config.gpsUpdateInterval !== undefined) positionConfigData.gpsUpdateInterval = config.gpsUpdateInterval;
      if (config.positionFlags !== undefined) positionConfigData.positionFlags = config.positionFlags;
      if (config.rxGpio !== undefined) positionConfigData.rxGpio = config.rxGpio;
      if (config.txGpio !== undefined) positionConfigData.txGpio = config.txGpio;
      if (config.broadcastSmartMinimumDistance !== undefined) positionConfigData.broadcastSmartMinimumDistance = config.broadcastSmartMinimumDistance;
      if (config.broadcastSmartMinimumIntervalSecs !== undefined) positionConfigData.broadcastSmartMinimumIntervalSecs = config.broadcastSmartMinimumIntervalSecs;
      if (config.gpsEnGpio !== undefined) positionConfigData.gpsEnGpio = config.gpsEnGpio;
      if (config.gpsMode !== undefined) positionConfigData.gpsMode = config.gpsMode;

      const configMsg = Config.create({
        position: positionConfigData
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.info('⚙️ Created SetPositionConfig admin message');
      logger.info('⚙️ Position config data:', JSON.stringify(positionConfigData, null, 2));
      logger.info('⚙️ Smart broadcast enabled:', positionConfigData.positionBroadcastSmartEnabled);
      if (positionConfigData.positionBroadcastSmartEnabled) {
        logger.info('⚙️ Smart broadcast minimum distance:', positionConfigData.broadcastSmartMinimumDistance);
        logger.info('⚙️ Smart broadcast minimum interval:', positionConfigData.broadcastSmartMinimumIntervalSecs);
      }
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetPositionConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set MQTT module configuration
   * @param config MQTT config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetMQTTConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const ModuleConfig = root?.lookupType('meshtastic.ModuleConfig');
      if (!AdminMessage || !ModuleConfig) {
        throw new Error('Required proto types not found');
      }

      const moduleConfigMsg = ModuleConfig.create({
        mqtt: config
      });

      const adminMsgData: any = {
        setModuleConfig: moduleConfigMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetMQTTConfig admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetMQTTConfig message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set NeighborInfo module configuration
   * @param config NeighborInfo config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetNeighborInfoConfigMessage(config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const ModuleConfig = root?.lookupType('meshtastic.ModuleConfig');
      if (!AdminMessage || !ModuleConfig) {
        throw new Error('Required proto types not found');
      }

      const moduleConfigMsg = ModuleConfig.create({
        neighborInfo: config
      });

      const adminMsgData: any = {
        setModuleConfig: moduleConfigMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetNeighborInfoConfig admin message');
      logger.debug('🔍 AdminMessage bytes:', Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' '));
      logger.debug('🔍 AdminMessage object:', JSON.stringify(adminMsg, null, 2));
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetNeighborInfoConfig message:', error);
      throw error;
    }
  }

  /**
   * Generic method to create a set config message for any device config type
   * @param configType The config type name (e.g., 'power', 'display', 'bluetooth', etc.)
   * @param config The config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetDeviceConfigMessageGeneric(configType: string, config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Config = root?.lookupType('meshtastic.Config');
      if (!AdminMessage || !Config) {
        throw new Error('Required proto types not found');
      }

      // Map config type names to protobuf field names
      const configFieldMap: { [key: string]: string } = {
        'power': 'power',
        'display': 'display',
        'bluetooth': 'bluetooth',
        'sessionkey': 'sessionkey',
        'deviceui': 'deviceui'
      };

      const fieldName = configFieldMap[configType];
      if (!fieldName) {
        throw new Error(`Unknown device config type: ${configType}`);
      }

      const configData: any = {};
      // Copy all properties from config to configData
      Object.keys(config).forEach(key => {
        if (config[key] !== undefined) {
          configData[key] = config[key];
        }
      });

      const configMsg = Config.create({
        [fieldName]: configData
      });

      const adminMsgData: any = {
        setConfig: configMsg
      };

      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);
      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created Set${configType.charAt(0).toUpperCase() + configType.slice(1)}Config admin message`);
      return encoded;
    } catch (error) {
      logger.error(`Failed to create Set${configType}Config message:`, error);
      throw error;
    }
  }

  /**
   * Generic method to create a set module config message for any module config type
   * @param configType The config type name (e.g., 'serial', 'extnotif', etc.)
   * @param config The config object
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetModuleConfigMessageGeneric(configType: string, config: any, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const ModuleConfig = root?.lookupType('meshtastic.ModuleConfig');
      if (!AdminMessage || !ModuleConfig) {
        throw new Error('Required proto types not found');
      }

      // Map config type names to protobuf field names
      const configFieldMap: { [key: string]: string } = {
        'serial': 'serial',
        'extnotif': 'externalNotification',
        'storeforward': 'storeForward',
        'rangetest': 'rangeTest',
        'telemetry': 'telemetry',
        'cannedmsg': 'cannedMessage',
        'audio': 'audio',
        'remotehardware': 'remoteHardware',
        'neighborinfo': 'neighborInfo',
        'ambientlighting': 'ambientLighting',
        'detectionsensor': 'detectionSensor',
        'paxcounter': 'paxcounter',
        'statusmessage': 'statusmessage',
        'trafficmanagement': 'trafficManagement'
      };

      const fieldName = configFieldMap[configType];
      if (!fieldName) {
        throw new Error(`Unknown module config type: ${configType}`);
      }

      const configData: any = {};
      // Copy all properties from config to configData
      Object.keys(config).forEach(key => {
        if (config[key] !== undefined) {
          configData[key] = config[key];
        }
      });

      const moduleConfigMsg = ModuleConfig.create({
        [fieldName]: configData
      });

      const adminMsgData: any = {
        setModuleConfig: moduleConfigMsg
      };

      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);
      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created Set${configType.charAt(0).toUpperCase() + configType.slice(1)}Config admin message`);
      return encoded;
    } catch (error) {
      logger.error(`Failed to create Set${configType}Config message:`, error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set fixed position
   * @param latitude Latitude in degrees
   * @param longitude Longitude in degrees
   * @param altitude Altitude in meters
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetFixedPositionMessage(latitude: number, longitude: number, altitude: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const Position = root?.lookupType('meshtastic.Position');
      if (!AdminMessage || !Position) {
        throw new Error('Required proto types not found');
      }

      // Meshtastic uses degrees * 1e-7 for lat/long
      const positionMsg = Position.create({
        latitudeI: Math.round(latitude * 1e7),
        longitudeI: Math.round(longitude * 1e7),
        altitude: Math.round(altitude)
      });

      const adminMsgData: any = {
        setFixedPosition: positionMsg
      };

      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);
      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created SetFixedPosition admin message');
      logger.debug('🔍 Position data:', JSON.stringify(positionMsg));
      logger.debug('🔍 AdminMessage data:', JSON.stringify(adminMsgData));
      logger.debug('🔍 AdminMessage object:', JSON.stringify(adminMsg, null, 2));
      logger.debug('🔍 AdminMessage bytes:', Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' '));
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetFixedPosition message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to set node owner (long name and short name)
   * @param longName Node long name
   * @param shortName Node short name
   * @param isUnmessagable Optional flag to prevent others from sending direct messages
   * @param sessionPasskey Optional session passkey for authentication
   */
  createSetOwnerMessage(longName: string, shortName: string, isUnmessagable?: boolean, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      const User = root?.lookupType('meshtastic.User');
      if (!AdminMessage || !User) {
        throw new Error('Required proto types not found');
      }

      const userMsg = User.create({
        longName: longName,
        shortName: shortName,
        isUnmessagable: isUnmessagable
      });

      const adminMsgData: any = {
        setOwner: userMsg
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created SetOwner admin message: "${longName}" (${shortName}), isUnmessagable: ${isUnmessagable}`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create SetOwner message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to reboot the device
   * @param seconds Number of seconds to wait before rebooting
   * @param sessionPasskey Optional session passkey for authentication
   */
  createRebootMessage(seconds: number, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        rebootSeconds: seconds
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created Reboot admin message (rebootSeconds=${seconds})`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create Reboot message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to purge the node database
   * @param seconds Number of seconds to wait before purging (typically 0 for immediate)
   * @param sessionPasskey Optional session passkey for authentication
   */
  createPurgeNodeDbMessage(seconds: number = 0, sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        nodedbReset: seconds
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug(`⚙️ Created NodeDB Reset admin message (nodedbReset=${seconds})`);
      return encoded;
    } catch (error) {
      logger.error('Failed to create NodeDB Reset message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to begin settings edit transaction
   * @param sessionPasskey Optional session passkey for authentication
   */
  createBeginEditSettingsMessage(sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        beginEditSettings: true
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created BeginEditSettings admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create BeginEditSettings message:', error);
      throw error;
    }
  }

  /**
   * Create an AdminMessage to commit settings edit transaction
   * @param sessionPasskey Optional session passkey for authentication
   */
  createCommitEditSettingsMessage(sessionPasskey?: Uint8Array): Uint8Array {
    try {
      const root = getProtobufRoot();
      const AdminMessage = root?.lookupType('meshtastic.AdminMessage');
      if (!AdminMessage) {
        throw new Error('AdminMessage type not found in loaded proto files');
      }

      const adminMsgData: any = {
        commitEditSettings: true
      };

      // Only include sessionPasskey if provided
      if (sessionPasskey && sessionPasskey.length > 0) {
        adminMsgData.sessionPasskey = sessionPasskey;
      }

      const adminMsg = AdminMessage.create(adminMsgData);

      const encoded = AdminMessage.encode(adminMsg).finish();
      logger.debug('⚙️ Created CommitEditSettings admin message');
      return encoded;
    } catch (error) {
      logger.error('Failed to create CommitEditSettings message:', error);
      throw error;
    }
  }

  /**
   * Create a complete ToRadio packet with an admin message
   * @param adminMessagePayload The encoded admin message
   * @param destination Optional destination node number (0 for local node)
   * @param fromNodeNum Optional source node number (required for proper packet routing)
   */
  createAdminPacket(adminMessagePayload: Uint8Array, destination: number = 0, fromNodeNum?: number): Uint8Array {
    try {
      const root = getProtobufRoot();
      const ToRadio = root?.lookupType('meshtastic.ToRadio');
      const MeshPacket = root?.lookupType('meshtastic.MeshPacket');
      const Data = root?.lookupType('meshtastic.Data');

      if (!ToRadio || !MeshPacket || !Data) {
        throw new Error('Required proto types not found');
      }

      // Create Data message with admin payload
      const dataMsg = Data.create({
        portnum: PortNum.ADMIN_APP,
        payload: adminMessagePayload,
        wantResponse: true  // Request response for admin config changes
      });

      // Create MeshPacket with random ID
      // Generate random packet ID (must be non-zero)
      const packetId = Math.floor(Math.random() * 0xFFFFFFFF) + 1;
      logger.debug(`🔍 Generated packet ID: ${packetId} (0x${packetId.toString(16)})`);

      const meshPacketData: any = {
        id: packetId,
        to: destination,
        decoded: dataMsg,
        channel: 0,
        hopLimit: 3,
        wantAck: true,
        priority: 70,  // RELIABLE priority
        pkiEncrypted: true  // Python CLI sets this flag even with plaintext admin messages
      };

      // Include from field if provided
      if (fromNodeNum !== undefined) {
        meshPacketData.from = fromNodeNum;
        logger.debug(`🔍 Setting from field: ${fromNodeNum} (0x${fromNodeNum.toString(16)})`);
      }

      const meshPacket = MeshPacket.create(meshPacketData);

      logger.debug('🔍 MeshPacket created:', JSON.stringify(meshPacket, null, 2));

      // Wrap in ToRadio
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      const encoded = ToRadio.encode(toRadio).finish();
      logger.debug(`📤 Created admin ToRadio packet (destination: ${destination})`);
      logger.debug('🔍 ToRadio bytes:', Array.from(encoded).map(b => b.toString(16).padStart(2, '0')).join(' '));
      return encoded;
    } catch (error) {
      logger.error('Failed to create admin ToRadio packet:', error);
      throw error;
    }
  }
}

export default new ProtobufService();