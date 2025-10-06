import protobuf from 'protobufjs';
import path from 'path';
import { getProtobufRoot } from './protobufLoader.js';

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

class ProtobufService {
  private root: protobuf.Root | null = null;
  private types: Map<string, protobuf.Type> = new Map();
  private enums: Map<string, protobuf.Enum> = new Map();
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      console.log('🔧 Initializing protobuf service...');

      const protoDir = '/app/protobufs';
      console.log(`Loading proto files from: ${protoDir}`);

      // Load mesh.proto with the proper root path for imports
      this.root = new protobuf.Root();
      this.root.resolvePath = (origin: string, target: string) => {
        console.log(`Resolving import: origin=${origin}, target=${target}`);
        if (target.startsWith('meshtastic/')) {
          const resolved = path.join(protoDir, target);
          console.log(`Resolved to: ${resolved}`);
          return resolved;
        }
        return protobuf.util.path.resolve(origin, target);
      };

      await this.root.load(path.join(protoDir, 'meshtastic/mesh.proto'));

      // Load admin.proto explicitly (not imported by mesh.proto)
      await this.root.load(path.join(protoDir, 'meshtastic/admin.proto'));
      console.log('✅ Loaded admin.proto for AdminMessage support');

      // Cache available enums
      this.cacheEnum('meshtastic.PortNum');

      this.isInitialized = true;
      console.log('✅ Protobuf service initialized successfully');

    } catch (error) {
      console.error('❌ Failed to initialize protobuf service:', error);
      throw error;
    }
  }



  private cacheEnum(enumName: string): void {
    const enumType = this.root?.lookupEnum(enumName);
    if (enumType) {
      this.enums.set(enumName, enumType);
      console.log(`📦 Cached enum: ${enumName}`);
    } else {
      console.warn(`⚠️  Could not find enum: ${enumName}`);
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
      console.log('🗺️  Attempting to decode position data with protobuf...');

      const Position = this.root?.lookupType('meshtastic.Position');
      if (!Position) {
        console.error('🗺️  Position type not found in loaded proto files');
        return null;
      }

      const decoded = Position.decode(data);
      const position = Position.toObject(decoded);
      console.log('🗺️  Decoded position:', JSON.stringify(position, null, 2));

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
      console.error('Failed to decode Position message:', error);
      return null;
    }
  }

  // User message parsing - decode using mesh.proto definition
  decodeUser(data: Uint8Array): MeshtasticUser | null {
    try {
      console.log('👤 Attempting to decode user data with protobuf...');

      const User = this.root?.lookupType('meshtastic.User');
      if (!User) {
        console.error('👤 User type not found in loaded proto files');
        return null;
      }

      const decoded = User.decode(data);
      const user = User.toObject(decoded);
      console.log('👤 Decoded user:', JSON.stringify(user, null, 2));

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
      console.error('Failed to decode User message:', error);
      return null;
    }
  }

  // NodeInfo message parsing - decode using mesh.proto definition
  decodeNodeInfo(data: Uint8Array): MeshtasticNodeInfo | null {
    try {
      console.log('🏠 Attempting to decode NodeInfo data with protobuf...');

      const NodeInfo = this.root?.lookupType('meshtastic.NodeInfo');
      if (!NodeInfo) {
        console.error('🏠 NodeInfo type not found in loaded proto files');
        return null;
      }

      const decoded = NodeInfo.decode(data);
      const nodeInfo = NodeInfo.toObject(decoded);
      console.log('🏠 Decoded NodeInfo:', JSON.stringify(nodeInfo, null, 2));

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
        console.log('🏠 NodeInfo contains user data:', user.long_name);
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
        console.log(`🗺️ NodeInfo contains position data: ${position.latitude_i}, ${position.longitude_i}`);
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
        console.log('🏠 NodeInfo contains device metrics');
      }

      console.log('🏠 NodeInfo components extracted - User:', !!user, 'Position:', !!position, 'DeviceMetrics:', !!deviceMetrics);

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
      console.error('Failed to decode NodeInfo message:', error);
      return null;
    }
  }

  decodeDeviceMetrics(_data: Uint8Array): MeshtasticDeviceMetrics | null {
    console.log('📊 DeviceMetrics decoding not implemented yet');
    return null;
  }

  decodeTelemetry(_data: Uint8Array): MeshtasticTelemetry | null {
    console.log('📡 Telemetry decoding not implemented yet');
    return null;
  }

  decodeFromRadio(data: Uint8Array): any | null {
    try {
      console.log('📻 Attempting to decode FromRadio with protobuf...');

      const FromRadio = this.root?.lookupType('meshtastic.FromRadio');
      if (!FromRadio) {
        console.error('📻 FromRadio type not found in loaded proto files');
        return null;
      }

      const decoded = FromRadio.decode(data);
      const fromRadio = FromRadio.toObject(decoded);
      console.log('📻 Decoded FromRadio:', JSON.stringify(fromRadio, null, 2));

      return fromRadio;
    } catch (error) {
      console.error('Failed to decode FromRadio message:', error);
      return null;
    }
  }

  decodeMeshPacket(data: Uint8Array): MeshtasticMessage | null {
    try {
      console.log('📦 Attempting to decode MeshPacket with protobuf...');

      const MeshPacket = this.root?.lookupType('meshtastic.MeshPacket');
      if (!MeshPacket) {
        console.error('📦 MeshPacket type not found in loaded proto files');
        return null;
      }

      const decoded = MeshPacket.decode(data);
      const meshPacket = MeshPacket.toObject(decoded);
      console.log('📦 Decoded MeshPacket:', JSON.stringify(meshPacket, null, 2));

      // Extract the decoded payload if available
      let unencrypted: any = null;
      if (meshPacket.decoded) {
        console.log('📦 Processing decoded payload...');
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
          console.log(`📦 Attempting to decode payload for port ${unencrypted.portnum} (${this.getPortNumName(unencrypted.portnum)})`);

          switch (unencrypted.portnum) {
            case 3: // POSITION_APP
              const position = this.decodePosition(unencrypted.payload);
              if (position) {
                console.log('📦 Successfully decoded position from MeshPacket payload');
                unencrypted.decodedPayload = position;
              }
              break;
            case 4: // NODEINFO_APP
              const nodeInfo = this.decodeNodeInfo(unencrypted.payload);
              if (nodeInfo) {
                console.log('📦 Successfully decoded NodeInfo from MeshPacket payload');
                unencrypted.decodedPayload = nodeInfo;
              }
              break;
            case 67: // TELEMETRY_APP
              const telemetry = this.decodeTelemetry(unencrypted.payload);
              if (telemetry) {
                console.log('📦 Successfully decoded telemetry from MeshPacket payload');
                unencrypted.decodedPayload = telemetry;
              }
              break;
            default:
              console.log(`📦 No specific decoder for port ${unencrypted.portnum}`);
              break;
          }
        }
      }

      if (unencrypted) {
        console.log('🔍 Unencrypted Data fields:', {
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
      console.error('Failed to decode MeshPacket message:', error);
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
        console.error(`Type ${typeName} not found`);
        return null;
      }

      const message = MessageType.decode(data);
      console.log(`🔍 Inspecting ${typeName}:`, JSON.stringify(message, null, 2));
      return message;
    } catch (error) {
      console.error(`Failed to inspect ${typeName}:`, error);
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
      console.log('⚙️ Created GetSessionKey request (getConfigRequest=SESSIONKEY_CONFIG)');
      return encoded;
    } catch (error) {
      console.error('Failed to create GetSessionKey request:', error);
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

      const adminMsg = AdminMessage.create({
        setFavoriteNode: nodeNum,
        sessionPasskey: sessionPasskey || new Uint8Array()
      });

      const encoded = AdminMessage.encode(adminMsg).finish();
      console.log(`⚙️ Created SetFavoriteNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      console.error('Failed to create SetFavoriteNode message:', error);
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

      const adminMsg = AdminMessage.create({
        removeFavoriteNode: nodeNum,
        sessionPasskey: sessionPasskey || new Uint8Array()
      });

      const encoded = AdminMessage.encode(adminMsg).finish();
      console.log(`⚙️ Created RemoveFavoriteNode admin message for node ${nodeNum}`);
      return encoded;
    } catch (error) {
      console.error('Failed to create RemoveFavoriteNode message:', error);
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
      const adminMsg = AdminMessage.toObject(decoded);
      console.log('⚙️ Decoded AdminMessage:', JSON.stringify(adminMsg, null, 2));
      return adminMsg;
    } catch (error) {
      console.error('Failed to decode AdminMessage:', error);
      return null;
    }
  }

  /**
   * Create a complete ToRadio packet with an admin message
   * @param adminMessagePayload The encoded admin message
   * @param destination Optional destination node number (0 for local node)
   */
  createAdminPacket(adminMessagePayload: Uint8Array, destination: number = 0): Uint8Array {
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
        portnum: 6, // ADMIN_APP
        payload: adminMessagePayload,
        wantResponse: true
      });

      // Create MeshPacket
      const meshPacket = MeshPacket.create({
        to: destination,
        decoded: dataMsg,
        wantAck: true,
        channel: 0
      });

      // Wrap in ToRadio
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      const encoded = ToRadio.encode(toRadio).finish();
      console.log(`📤 Created admin ToRadio packet (destination: ${destination})`);
      return encoded;
    } catch (error) {
      console.error('Failed to create admin ToRadio packet:', error);
      throw error;
    }
  }
}

export default new ProtobufService();