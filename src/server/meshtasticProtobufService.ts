/**
 * Meshtastic Protobuf Service
 *
 * This service provides proper protobuf parsing using the official Meshtastic
 * protobuf definitions and protobufjs library.
 */
import { loadProtobufDefinitions, getProtobufRoot, type FromRadio, type MeshPacket } from './protobufLoader.js';
import { logger } from '../utils/logger.js';
import { PortNum } from './constants/meshtastic.js';

export class MeshtasticProtobufService {
  private static instance: MeshtasticProtobufService;
  private isInitialized = false;

  private constructor() {}

  static getInstance(): MeshtasticProtobufService {
    if (!MeshtasticProtobufService.instance) {
      MeshtasticProtobufService.instance = new MeshtasticProtobufService();
    }
    return MeshtasticProtobufService.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      logger.debug('🔧 Initializing Meshtastic Protobuf Service...');
      await loadProtobufDefinitions();
      this.isInitialized = true;
      logger.debug('✅ Meshtastic Protobuf Service initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize protobuf service:', error);
      throw error;
    }
  }

  /**
   * Create a ToRadio message with want_config_id using proper protobuf encoding
   */
  createWantConfigRequest(): Uint8Array {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      // Fallback to simple manual encoding
      return new Uint8Array([0x18, 0x01]);
    }

    try {
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      // Try sending a different config ID - maybe 0xFFFFFFFF to request all configs
      const toRadio = ToRadio.create({
        wantConfigId: 0xFFFFFFFF  // Request ALL config sections
      });

      return ToRadio.encode(toRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create want_config_id request:', error);
      // Fallback to simple manual encoding
      return new Uint8Array([0x18, 0x01]);
    }
  }

  /**
   * Create a traceroute request ToRadio using proper protobuf encoding
   */
  createTracerouteMessage(destination: number, channel?: number): Uint8Array {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return new Uint8Array();
    }

    try {
      // Create the RouteDiscovery message (empty for request)
      const RouteDiscovery = root.lookupType('meshtastic.RouteDiscovery');
      const routeDiscovery = RouteDiscovery.create({
        route: []
      });

      // Encode the RouteDiscovery as payload
      const payload = RouteDiscovery.encode(routeDiscovery).finish();

      // Create the Data message with TRACEROUTE_APP portnum
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.TRACEROUTE_APP,
        payload: payload,
        dest: destination,
        wantResponse: true
      });

      // Create the MeshPacket
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        to: destination,
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: false, // Traceroute doesn't need ack
        hopLimit: 7 // Default hop limit
      });

      // Create the ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return ToRadio.encode(toRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create traceroute message:', error);
      return new Uint8Array();
    }
  }

  /**
   * Create a position request ToRadio using proper protobuf encoding
   * This sends a position packet with wantResponse=true to request the destination node's position
   */
  createPositionRequestMessage(
    destination: number,
    channel?: number,
    position?: { latitude: number; longitude: number; altitude?: number | null }
  ): { data: Uint8Array; packetId: number; requestId: number } {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }

    try {
      // Generate a unique packet ID (Meshtastic uses 32-bit unsigned integers)
      const packetId = Math.floor(Math.random() * 0xffffffff);
      const requestId = Math.floor(Math.random() * 0xffffffff);

      // Create Position message for position exchange
      // According to Meshtastic protocol: send your position with wantResponse=true to exchange positions
      const Position = root.lookupType('meshtastic.Position');
      const positionData: any = {};

      if (position) {
        // Send actual position for position exchange
        positionData.latitudeI = Math.round(position.latitude * 1e7);  // Convert to fixed-point
        positionData.longitudeI = Math.round(position.longitude * 1e7); // Convert to fixed-point
        if (position.altitude !== null && position.altitude !== undefined) {
          positionData.altitude = Math.round(position.altitude);
        }
        positionData.time = Math.floor(Date.now() / 1000); // Unix timestamp
      }
      // If no position provided, send empty position (fallback behavior)

      const positionMessage = Position.create(positionData);

      // Encode the Position as payload
      const payload = Position.encode(positionMessage).finish();

      // Create the Data message with POSITION_APP portnum
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.POSITION_APP,
        payload: payload,
        dest: destination,
        wantResponse: true, // Request position exchange from destination
        requestId: requestId
      });

      // Create the MeshPacket with explicit ID
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        id: packetId,
        to: destination,
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: true, // We want to know if the message was delivered
        hopLimit: 3 // Default hop limit for position exchange
      });

      // Create the ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return { data: ToRadio.encode(toRadio).finish(), packetId, requestId };
    } catch (error) {
      logger.error('❌ Failed to create position exchange message:', error);
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }
  }

  /**
   * Create a NodeInfo request ToRadio using proper protobuf encoding
   * This sends a User message with wantResponse=true to request the destination node's user info
   * Similar to "Exchange User Info" feature in mobile apps - triggers key exchange
   */
  createNodeInfoRequestMessage(
    destination: number,
    channel?: number,
    userInfo?: { id: string; longName: string; shortName: string; hwModel?: number; role?: number; publicKey?: Uint8Array }
  ): { data: Uint8Array; packetId: number; requestId: number } {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }

    try {
      // Generate a unique packet ID (Meshtastic uses 32-bit unsigned integers)
      const packetId = Math.floor(Math.random() * 0xffffffff);
      const requestId = Math.floor(Math.random() * 0xffffffff);

      // Create User message for nodeinfo exchange
      // According to Meshtastic protocol: send your user info with wantResponse=true to exchange user info
      const User = root.lookupType('meshtastic.User');
      const userData: any = {};

      if (userInfo) {
        // Send actual user info for exchange
        userData.id = userInfo.id;
        userData.longName = userInfo.longName;
        userData.shortName = userInfo.shortName;
        if (userInfo.hwModel !== undefined) {
          userData.hwModel = userInfo.hwModel;
        }
        if (userInfo.role !== undefined) {
          userData.role = userInfo.role;
        }
        if (userInfo.publicKey && userInfo.publicKey.length > 0) {
          userData.publicKey = userInfo.publicKey;
        }
      }
      // If no user info provided, send empty user (fallback behavior)

      const userMessage = User.create(userData);

      // Encode the User as payload
      const payload = User.encode(userMessage).finish();

      // Create the Data message with NODEINFO_APP portnum
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.NODEINFO_APP,
        payload: payload,
        dest: destination,
        wantResponse: true, // Request nodeinfo exchange from destination
        requestId: requestId
      });

      // Create the MeshPacket with explicit ID
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        id: packetId,
        to: destination,
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: true, // We want to know if the message was delivered
        hopLimit: 3 // Default hop limit for nodeinfo exchange
      });

      // Create the ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return { data: ToRadio.encode(toRadio).finish(), packetId, requestId };
    } catch (error) {
      logger.error('❌ Failed to create nodeinfo exchange message:', error);
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }
  }

  /**
   * Create a telemetry request ToRadio to request LocalStats from a node
   * This sends an empty telemetry packet with wantResponse=true to request stats
   */
  createTelemetryRequestMessage(
    destination: number,
    channel?: number,
    telemetryType?: 'device' | 'environment' | 'airQuality' | 'power'
  ): { data: Uint8Array; packetId: number; requestId: number } {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }

    try {
      // Generate unique IDs
      const packetId = Math.floor(Math.random() * 0xffffffff);
      const requestId = Math.floor(Math.random() * 0xffffffff);

      // Create Telemetry message with appropriate variant based on telemetryType
      const Telemetry = root.lookupType('meshtastic.Telemetry');
      let telemetryPayload: { deviceMetrics?: object; environmentMetrics?: object; airQualityMetrics?: object; powerMetrics?: object } = {};

      // Set the appropriate empty variant to request that telemetry type
      switch (telemetryType) {
        case 'device': {
          const DeviceMetrics = root.lookupType('meshtastic.DeviceMetrics');
          telemetryPayload = { deviceMetrics: DeviceMetrics.create({}) };
          break;
        }
        case 'environment': {
          const EnvironmentMetrics = root.lookupType('meshtastic.EnvironmentMetrics');
          telemetryPayload = { environmentMetrics: EnvironmentMetrics.create({}) };
          break;
        }
        case 'airQuality': {
          const AirQualityMetrics = root.lookupType('meshtastic.AirQualityMetrics');
          telemetryPayload = { airQualityMetrics: AirQualityMetrics.create({}) };
          break;
        }
        case 'power': {
          const PowerMetrics = root.lookupType('meshtastic.PowerMetrics');
          telemetryPayload = { powerMetrics: PowerMetrics.create({}) };
          break;
        }
        default: {
          // No type specified - request general telemetry (device metrics by default)
          const DeviceMetrics = root.lookupType('meshtastic.DeviceMetrics');
          telemetryPayload = { deviceMetrics: DeviceMetrics.create({}) };
        }
      }

      const telemetryMessage = Telemetry.create(telemetryPayload);

      // Encode the Telemetry as payload
      const payload = Telemetry.encode(telemetryMessage).finish();

      // Create Data message with TELEMETRY_APP portnum
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.TELEMETRY_APP,
        payload: payload,
        dest: destination,
        wantResponse: true, // Request telemetry from destination
        requestId: requestId
      });

      // Create MeshPacket with explicit ID
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        id: packetId,
        to: destination,
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: true, // Want delivery confirmation
        hopLimit: 3 // Allow multi-hop delivery (like other remote requests)
      });

      // Create ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return { data: ToRadio.encode(toRadio).finish(), packetId, requestId };
    } catch (error) {
      logger.error('❌ Failed to create telemetry request message:', error);
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }
  }

  /**
   * Create a neighbor info request ToRadio to request NeighborInfo from a remote node
   * This sends an empty NeighborInfo packet with wantResponse=true to request neighbor data
   * Note: Target node must have NeighborInfo module enabled; firmware rate-limits responses to 1 per 3 minutes
   */
  createNeighborInfoRequestMessage(
    destination: number,
    channel?: number
  ): { data: Uint8Array; packetId: number; requestId: number } {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }

    try {
      // Generate unique IDs
      const packetId = Math.floor(Math.random() * 0xffffffff);
      const requestId = Math.floor(Math.random() * 0xffffffff);

      // Create empty NeighborInfo message (request format)
      const NeighborInfo = root.lookupType('meshtastic.NeighborInfo');
      const neighborInfoMessage = NeighborInfo.create({});

      // Encode the NeighborInfo as payload
      const payload = NeighborInfo.encode(neighborInfoMessage).finish();

      // Create Data message with NEIGHBORINFO_APP portnum
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.NEIGHBORINFO_APP,
        payload: payload,
        dest: destination,
        wantResponse: true, // Request neighbor info from destination
        requestId: requestId
      });

      // Create MeshPacket with explicit ID
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        id: packetId,
        to: destination,
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: true, // Want delivery confirmation
        hopLimit: 7 // Default hop limit for remote nodes
      });

      // Create ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return { data: ToRadio.encode(toRadio).finish(), packetId, requestId };
    } catch (error) {
      logger.error('❌ Failed to create neighbor info request message:', error);
      return { data: new Uint8Array(), packetId: 0, requestId: 0 };
    }
  }

  /**
   * Create a text message ToRadio using proper protobuf encoding
   */
  createTextMessage(text: string, destination?: number, channel?: number, replyId?: number, emoji?: number): { data: Uint8Array; messageId: number } {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return { data: new Uint8Array(), messageId: 0 };
    }

    try {
      // Create the Data message with text payload
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: PortNum.TEXT_MESSAGE_APP,
        payload: new TextEncoder().encode(text),
        replyId: replyId,
        emoji: emoji
      });

      // Generate a unique message ID so we can track this message
      const messageId = Math.floor(Math.random() * 0xFFFFFFFF);

      // Create the MeshPacket
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      // Ensure channel is valid (0-7) for Meshtastic, default to 0 if invalid
      const validChannel = (channel !== undefined && channel >= 0 && channel <= 7) ? channel : 0;
      const meshPacket = MeshPacket.create({
        id: messageId,
        to: destination || 0xFFFFFFFF, // Broadcast if no destination
        channel: validChannel,
        decoded: dataMessage,
        wantAck: true
      });

      logger.debug(`📤 Creating MeshPacket - ID: ${messageId}, to: ${(meshPacket as any).to.toString(16)}, channel: ${validChannel}, wantAck: ${(meshPacket as any).wantAck}`);

      // Create the ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return { data: ToRadio.encode(toRadio).finish(), messageId };
    } catch (error) {
      logger.error('❌ Failed to create text message:', error);
      return { data: new Uint8Array(), messageId: 0 };
    }
  }

  /**
   * Parse multiple concatenated FromRadio messages from a buffer
   *
   * The HTTP API returns concatenated FromRadio messages without message-level length prefixes.
   * We need to manually parse each message by reading the protobuf wire format.
   */
  async parseMultipleMessages(data: Uint8Array): Promise<Array<{ type: string; data: any }>> {
    const messages: Array<{ type: string; data: any }> = [];

    if (data.length === 0) return messages;

    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return messages;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const { default: protobufjs } = await import('protobufjs');

      let offset = 0;

      while (offset < data.length) {
        try {
          // Create a reader for the remaining data
          const remainingData = data.subarray(offset);
          const reader = protobufjs.Reader.create(remainingData);

          // Track initial position
          const initialPos = reader.pos;
          let lastValidPos = initialPos;
          const seenFields = new Set<number>();

          // Read fields until we can't read anymore or hit a repeated field
          while (reader.pos < reader.len) {
            const posBeforeTag = reader.pos;
            const tag = reader.uint32();
            const fieldNumber = tag >>> 3;
            const wireType = tag & 7;

            // Check if this is a valid FromRadio field (fields 1-16)
            if (fieldNumber < 1 || fieldNumber > 16) {
              reader.pos = lastValidPos;
              break;
            }

            // KEY INSIGHT: If we see a field number we've already seen, this is a NEW message!
            // FromRadio fields are all optional and NOT repeated
            if (seenFields.has(fieldNumber)) {
              logger.debug(`🔍 Field ${fieldNumber} repeated at offset ${offset + posBeforeTag} - new message starts here`);
              // Rewind to before this tag
              reader.pos = posBeforeTag;
              break;
            }

            seenFields.add(fieldNumber);
            lastValidPos = reader.pos;

            // Skip the field data
            try {
              reader.skipType(wireType);
              lastValidPos = reader.pos;
            } catch (_skipError) {
              logger.debug(`⚠️ Error skipping field ${fieldNumber} at offset ${offset + posBeforeTag}`);
              reader.pos = lastValidPos;
              break;
            }
          }

          // Now decode the message properly from the identified range
          const messageLength = lastValidPos - initialPos;
          if (messageLength > 0) {
            const messageData = remainingData.subarray(0, messageLength);
            const messageReader = protobufjs.Reader.create(messageData);
            const decodedMessage = FromRadio.decode(messageReader) as FromRadio;

            logger.debug(`📦 Decoded FromRadio at offset ${offset}, length ${messageLength}, next offset ${offset + messageLength}`);

            // Extract the actual message
            if (decodedMessage.packet) {
              // Check if decoded is Uint8Array and manually decode it as a Data message
              if (decodedMessage.packet.decoded && decodedMessage.packet.decoded instanceof Uint8Array) {
                try {
                  const Data = root.lookupType('meshtastic.Data');
                  const decodedData = Data.decode(decodedMessage.packet.decoded);
                  (decodedMessage.packet as any).decoded = decodedData;
                } catch (e) {
                  logger.error('❌ Failed to manually decode Data:', e);
                }
              }

              messages.push({ type: 'meshPacket', data: decodedMessage.packet });
            } else if (decodedMessage.myInfo) {
              messages.push({ type: 'myInfo', data: decodedMessage.myInfo });
            } else if (decodedMessage.nodeInfo) {
              messages.push({ type: 'nodeInfo', data: decodedMessage.nodeInfo });
            } else if (decodedMessage.config) {
              messages.push({ type: 'config', data: decodedMessage.config });
            } else if (decodedMessage.channel) {
              messages.push({ type: 'channel', data: decodedMessage.channel });
            } else if (decodedMessage.metadata) {
              messages.push({ type: 'metadata', data: decodedMessage.metadata });
            } else {
              messages.push({ type: 'fromRadio', data: decodedMessage });
            }

            offset += messageLength;
          } else {
            logger.debug(`⚠️ No valid message data at offset ${offset}`);
            break;
          }
        } catch (error) {
          logger.debug(`⚠️ Error decoding message at offset ${offset}:`, (error as Error).message);
          break;
        }
      }

      logger.debug(`✅ Successfully parsed ${messages.length} FromRadio messages`);
    } catch (error) {
      logger.error('❌ Error parsing multiple messages:', error);
    }

    return messages;
  }

  /**
   * Parse any incoming data and attempt to decode as various message types
   */
  parseIncomingData(data: Uint8Array): {
    type: string;
    data: any;
  } | null {
    logger.debug('🔍 Parsing incoming data with Meshtastic protobuf service');

    if (data.length === 0) return null;

    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      // Try to decode as FromRadio message first
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const fromRadio = FromRadio.decode(data) as FromRadio;

      logger.debug('📦 Decoded FromRadio message:', {
        id: fromRadio.id,
        hasPacket: !!fromRadio.packet,
        hasMyInfo: !!fromRadio.myInfo,
        hasNodeInfo: !!fromRadio.nodeInfo,
        hasConfig: !!fromRadio.config,
        hasChannel: !!fromRadio.channel,
        hasMetadata: !!fromRadio.metadata,
        hasModuleConfig: !!fromRadio.moduleConfig,
        configCompleteId: fromRadio.configCompleteId,
        hasClientNotification: !!(fromRadio as any).clientNotification,
        hasLogRecord: !!(fromRadio as any).logRecord,
        hasQueueStatus: !!(fromRadio as any).queueStatus,
        hasFileInfo: !!(fromRadio as any).fileInfo
      });

      // Debug: dump all keys of fromRadio for unknown messages
      if (!fromRadio.packet && !fromRadio.myInfo && !fromRadio.nodeInfo && !fromRadio.config &&
          !fromRadio.channel && !fromRadio.metadata && !fromRadio.moduleConfig && !fromRadio.configCompleteId) {
        logger.debug('🔍 DEBUG: All FromRadio keys:', Object.keys(fromRadio));
        logger.debug('🔍 DEBUG: Full FromRadio object:', JSON.stringify(fromRadio, null, 2));
      }

      if (fromRadio.packet) {
        if (fromRadio.packet.decoded && fromRadio.packet.decoded instanceof Uint8Array) {
          try {
            const Data = root.lookupType('meshtastic.Data');
            const decodedData = Data.decode(fromRadio.packet.decoded);
            (fromRadio.packet as any).decoded = decodedData;
            logger.debug('✅ Manually decoded Data message in parseIncomingData');
          } catch (e) {
            logger.error('❌ Failed to manually decode Data in parseIncomingData:', e);
          }
        }

        return {
          type: 'meshPacket',
          data: fromRadio.packet
        };
      } else if (fromRadio.myInfo) {
        return {
          type: 'myInfo',
          data: fromRadio.myInfo
        };
      } else if (fromRadio.nodeInfo) {
        return {
          type: 'nodeInfo',
          data: fromRadio.nodeInfo
        };
      } else if (fromRadio.metadata) {
        return {
          type: 'metadata',
          data: fromRadio.metadata
        };
      } else if (fromRadio.config) {
        return {
          type: 'config',
          data: fromRadio.config
        };
      } else if (fromRadio.channel) {
        return {
          type: 'channel',
          data: fromRadio.channel
        };
      } else if (fromRadio.moduleConfig) {
        return {
          type: 'moduleConfig',
          data: fromRadio.moduleConfig
        };
      } else if (fromRadio.configCompleteId) {
        return {
          type: 'configComplete',
          data: { configCompleteId: fromRadio.configCompleteId }
        };
      } else {
        return {
          type: 'fromRadio',
          data: fromRadio
        };
      }
    } catch (error) {
      logger.debug('⚠️ Failed to decode as FromRadio, trying as MeshPacket:', (error as Error).message);

      try {
        // Try to decode directly as MeshPacket
        const MeshPacket = root.lookupType('meshtastic.MeshPacket');
        const meshPacket = MeshPacket.decode(data) as MeshPacket;

        logger.debug('📦 Decoded MeshPacket directly:', {
          from: meshPacket.from,
          to: meshPacket.to,
          id: meshPacket.id,
          channel: meshPacket.channel,
          hasDecoded: !!meshPacket.decoded
        });

        return {
          type: 'meshPacket',
          data: meshPacket
        };
      } catch (meshPacketError) {
        logger.debug('⚠️ Failed to decode as MeshPacket:', (meshPacketError as Error).message);
        return null;
      }
    }
  }


  /**
   * Process payload based on port number using protobuf definitions
   */
  processPayload(portnum: number, payload: Uint8Array): any {
    logger.debug(`🔍 Processing payload for port ${portnum} (${this.getPortNumName(portnum)})`);

    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return payload;
    }

    try {
      switch (portnum) {
        case PortNum.TEXT_MESSAGE_APP:
          return new TextDecoder('utf-8').decode(payload);

        case PortNum.POSITION_APP:
          const Position = root.lookupType('meshtastic.Position');
          const position = Position.decode(payload);
          return position;

        case PortNum.NODEINFO_APP:
          const User = root.lookupType('meshtastic.User');
          const user = User.decode(payload);
          return user;

        case PortNum.ROUTING_APP:
          const Routing = root.lookupType('meshtastic.Routing');
          const routing = Routing.decode(payload);
          return routing;

        case PortNum.PAXCOUNTER_APP:
          const Paxcount = root.lookupType('meshtastic.Paxcount');
          const paxcount = Paxcount.decode(payload);
          return paxcount;

        case PortNum.TELEMETRY_APP:
          const Telemetry = root.lookupType('meshtastic.Telemetry');
          const telemetry = Telemetry.decode(payload);
          return telemetry;

        case PortNum.TRACEROUTE_APP:
          const RouteDiscovery = root.lookupType('meshtastic.RouteDiscovery');
          const routeDiscovery = RouteDiscovery.decode(payload);
          return routeDiscovery;

        case PortNum.NEIGHBORINFO_APP:
          const NeighborInfo = root.lookupType('meshtastic.NeighborInfo');
          const neighborInfo = NeighborInfo.decode(payload);
          return neighborInfo;

        default:
          logger.debug(`⚠️ Unhandled port number: ${portnum}`);
          return payload;
      }
    } catch (error) {
      logger.error(`❌ Failed to decode payload for port ${portnum}:`, error);
      return payload;
    }
  }

  /**
   * Normalize portnum to a number, handling both numeric and string enum values
   * protobufjs can return enums as either numbers or strings depending on configuration
   */
  normalizePortNum(portnum: number | string | undefined): number | undefined {
    if (portnum === undefined || portnum === null) {
      return undefined;
    }

    // If it's already a number, return it
    if (typeof portnum === 'number') {
      return portnum;
    }

    // If it's a string, map it to the numeric value
    if (typeof portnum === 'string') {
      const portNumMap: { [key: string]: number } = {
        'UNKNOWN_APP': 0,
        'TEXT_MESSAGE_APP': 1,
        'REMOTE_HARDWARE_APP': 2,
        'POSITION_APP': 3,
        'NODEINFO_APP': 4,
        'ROUTING_APP': 5,
        'ADMIN_APP': 6,
        'TEXT_MESSAGE_COMPRESSED_APP': 7,
        'WAYPOINT_APP': 8,
        'AUDIO_APP': 9,
        'DETECTION_SENSOR_APP': 10,
        'ALERT_APP': 11,
        'KEY_VERIFICATION_APP': 12,
        'REPLY_APP': 32,
        'IP_TUNNEL_APP': 33,
        'PAXCOUNTER_APP': 34,
        'SERIAL_APP': 64,
        'STORE_FORWARD_APP': 65,
        'RANGE_TEST_APP': 66,
        'TELEMETRY_APP': 67,
        'ZPS_APP': 68,
        'SIMULATOR_APP': 69,
        'TRACEROUTE_APP': 70,
        'NEIGHBORINFO_APP': 71,
        'ATAK_PLUGIN': 72,
        'MAP_REPORT_APP': 73,
        'POWERSTRESS_APP': 74,
        'RETICULUM_TUNNEL_APP': 76,
        'CAYENNE_APP': 77,
        'PRIVATE_APP': 256,
        'ATAK_FORWARDER': 257,
        'MAX': 511
      };

      const normalized = portNumMap[portnum];
      if (normalized !== undefined) {
        logger.debug(`🔄 Normalized portnum string "${portnum}" to number ${normalized}`);
        return normalized;
      }

      logger.warn(`⚠️ Unknown portnum string value: "${portnum}"`);
      return undefined;
    }

    logger.warn(`⚠️ Unexpected portnum type: ${typeof portnum}, value: ${portnum}`);
    return undefined;
  }

  /**
   * Get human-readable port number name
   */
  getPortNumName(portnum: number | string | undefined): string {
    // Normalize the portnum first
    const normalizedPortNum = this.normalizePortNum(portnum);
    if (normalizedPortNum === undefined) {
      return `UNKNOWN_${portnum}`;
    }
    // Port numbers from official Meshtastic protobuf definitions
    // https://github.com/meshtastic/protobufs/blob/master/meshtastic/portnums.proto
    const portNames: { [key: number]: string } = {
      0: 'UNKNOWN_APP',
      1: 'TEXT_MESSAGE_APP',
      2: 'REMOTE_HARDWARE_APP',
      3: 'POSITION_APP',
      4: 'NODEINFO_APP',
      5: 'ROUTING_APP',
      6: 'ADMIN_APP',
      7: 'TEXT_MESSAGE_COMPRESSED_APP',
      8: 'WAYPOINT_APP',
      9: 'AUDIO_APP',
      10: 'DETECTION_SENSOR_APP',
      11: 'ALERT_APP',
      12: 'KEY_VERIFICATION_APP',
      32: 'REPLY_APP',
      33: 'IP_TUNNEL_APP',
      34: 'PAXCOUNTER_APP',
      64: 'SERIAL_APP',
      65: 'STORE_FORWARD_APP',
      66: 'RANGE_TEST_APP',
      67: 'TELEMETRY_APP',
      68: 'ZPS_APP',
      69: 'SIMULATOR_APP',
      70: 'TRACEROUTE_APP',
      71: 'NEIGHBORINFO_APP',
      72: 'ATAK_PLUGIN',
      73: 'MAP_REPORT_APP',
      74: 'POWERSTRESS_APP',
      76: 'RETICULUM_TUNNEL_APP',
      77: 'CAYENNE_APP',
      256: 'PRIVATE_APP',
      257: 'ATAK_FORWARDER',
      511: 'MAX'
    };

    return portNames[normalizedPortNum] || `UNKNOWN_${normalizedPortNum}`;
  }

  /**
   * Convert integer coordinates to decimal degrees
   */
  convertCoordinates(latitudeI: number, longitudeI: number): { latitude: number; longitude: number } {
    return {
      latitude: latitudeI / 10000000,  // Convert from int32 * 1e7 to decimal degrees
      longitude: longitudeI / 10000000
    };
  }

  /**
   * Convert decimal degrees to integer coordinates
   */
  convertCoordinatesToInt(latitude: number, longitude: number): { latitudeI: number; longitudeI: number } {
    return {
      latitudeI: Math.round(latitude * 10000000),
      longitudeI: Math.round(longitude * 10000000)
    };
  }

  /**
   * Parse ToRadio message from mobile app client
   */
  async parseToRadio(data: Uint8Array): Promise<any | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.decode(data);
      return toRadio;
    } catch (error) {
      logger.error('❌ Failed to parse ToRadio:', error);
      return null;
    }
  }

  /**
   * Create MyNodeInfo FromRadio message
   */
  async createMyNodeInfo(info: {
    myNodeNum: number;
    numBands?: number;
    firmwareVersion?: string;
    rebootCount?: number;
    bitrate?: number;
    messageTimeoutMsec?: number;
    minAppVersion?: number;
    maxChannels?: number;
  }): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const MyNodeInfo = root.lookupType('meshtastic.MyNodeInfo');
      const FromRadio = root.lookupType('meshtastic.FromRadio');

      const myInfo = MyNodeInfo.create({
        myNodeNum: info.myNodeNum,
        numBands: info.numBands || 13,
        firmwareVersion: info.firmwareVersion || '2.0.0',
        rebootCount: info.rebootCount || 0,
        bitrate: info.bitrate || 17.24,
        messageTimeoutMsec: info.messageTimeoutMsec || 300000,
        minAppVersion: info.minAppVersion || 20200,
        maxChannels: info.maxChannels || 8,
      });

      const fromRadio = FromRadio.create({
        myInfo: myInfo,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create MyNodeInfo:', error);
      return null;
    }
  }

  /**
   * Create NodeInfo FromRadio message
   */
  async createNodeInfo(info: {
    nodeNum: number;
    user: {
      id: string;
      longName: string;
      shortName: string;
      hwModel?: number;
      role?: number;
      publicKey?: string;
    };
    position?: {
      latitude: number;
      longitude: number;
      altitude: number;
      time: number;
    };
    deviceMetrics?: {
      batteryLevel?: number;
      voltage?: number;
      channelUtilization?: number;
      airUtilTx?: number;
    };
    snr?: number;
    lastHeard?: number;
    hopsAway?: number;
    viaMqtt?: boolean;
    isFavorite?: boolean;
    isIgnored?: boolean;
  }): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const NodeInfo = root.lookupType('meshtastic.NodeInfo');
      const User = root.lookupType('meshtastic.User');
      const Position = root.lookupType('meshtastic.Position');
      const DeviceMetrics = root.lookupType('meshtastic.DeviceMetrics');
      const FromRadio = root.lookupType('meshtastic.FromRadio');

      // Convert base64 publicKey to Uint8Array if present
      // Note: Public keys are stored as base64 in the database
      let publicKeyBytes: Uint8Array | undefined;
      if (info.user.publicKey && info.user.publicKey.length > 0) {
        try {
          // Decode base64 string to bytes
          publicKeyBytes = new Uint8Array(Buffer.from(info.user.publicKey, 'base64'));
        } catch (error) {
          logger.warn(`Failed to convert publicKey to bytes for node ${info.user.id}:`, error);
        }
      }

      const user = User.create({
        id: info.user.id,
        longName: info.user.longName,
        shortName: info.user.shortName,
        hwModel: info.user.hwModel || 0,
        role: info.user.role !== undefined ? info.user.role : 0,
        publicKey: publicKeyBytes,
      });

      let position = undefined;
      if (info.position) {
        const coords = this.convertCoordinatesToInt(info.position.latitude, info.position.longitude);
        position = Position.create({
          latitudeI: coords.latitudeI,
          longitudeI: coords.longitudeI,
          altitude: info.position.altitude,
          time: info.position.time,
        });
      }

      let deviceMetrics = undefined;
      if (info.deviceMetrics && (
        info.deviceMetrics.batteryLevel !== undefined ||
        info.deviceMetrics.voltage !== undefined ||
        info.deviceMetrics.channelUtilization !== undefined ||
        info.deviceMetrics.airUtilTx !== undefined
      )) {
        deviceMetrics = DeviceMetrics.create({
          batteryLevel: info.deviceMetrics.batteryLevel,
          voltage: info.deviceMetrics.voltage,
          channelUtilization: info.deviceMetrics.channelUtilization,
          airUtilTx: info.deviceMetrics.airUtilTx,
        });
      }

      const nodeInfo = NodeInfo.create({
        num: info.nodeNum,
        user: user,
        position: position,
        deviceMetrics: deviceMetrics,
        snr: info.snr,
        lastHeard: info.lastHeard,
        hopsAway: info.hopsAway,
        viaMqtt: info.viaMqtt,
        isFavorite: info.isFavorite,
        isIgnored: info.isIgnored,
      });

      const fromRadio = FromRadio.create({
        nodeInfo: nodeInfo,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create NodeInfo:', error);
      return null;
    }
  }

  /**
   * Create Channel FromRadio message
   */
  async createChannel(channelData: {
    index: number;
    settings: {
      name: string;
      psk?: Buffer;
      uplinkEnabled: boolean;
      downlinkEnabled: boolean;
    };
    role: number;
  }): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const Channel = root.lookupType('meshtastic.Channel');
      const ChannelSettings = root.lookupType('meshtastic.ChannelSettings');
      const FromRadio = root.lookupType('meshtastic.FromRadio');

      const settings = ChannelSettings.create({
        name: channelData.settings.name,
        psk: channelData.settings.psk || Buffer.alloc(0),
        uplinkEnabled: channelData.settings.uplinkEnabled,
        downlinkEnabled: channelData.settings.downlinkEnabled,
      });

      const channel = Channel.create({
        index: channelData.index,
        settings: settings,
        role: channelData.role,
      });

      const fromRadio = FromRadio.create({
        channel: channel,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create Channel:', error);
      return null;
    }
  }

  /**
   * Create ConfigComplete FromRadio message
   */
  async createConfigComplete(configId: number): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');

      const fromRadio = FromRadio.create({
        configCompleteId: configId,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create ConfigComplete:', error);
      return null;
    }
  }

  /**
   * Rewrite the firmware_version in a cached DeviceMetadata FromRadio message.
   * Decodes the raw FromRadio bytes, appends a suffix to the firmware_version
   * in the metadata field, and re-encodes.
   * Returns the modified bytes, or null if the message isn't a metadata message.
   */
  async rewriteMetadataFirmwareVersion(rawFromRadio: Uint8Array, suffix: string): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const decoded = FromRadio.decode(rawFromRadio) as any;

      if (!decoded.metadata) {
        return null;
      }

      // Append suffix to firmware version
      const original = decoded.metadata.firmwareVersion || '';
      decoded.metadata.firmwareVersion = original + suffix;
      logger.debug(`Virtual node: Rewrote firmware version: "${original}" → "${decoded.metadata.firmwareVersion}"`);

      return FromRadio.encode(decoded).finish();
    } catch (error) {
      logger.error('❌ Failed to rewrite metadata firmware version:', error);
      return null;
    }
  }

  /**
   * Create QueueStatus FromRadio message
   * Used as a heartbeat response to keep iOS clients connected
   */
  async createQueueStatus(options?: {
    res?: number;
    free?: number;
    maxlen?: number;
    meshPacketId?: number;
  }): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const QueueStatus = root.lookupType('meshtastic.QueueStatus');

      const queueStatus = QueueStatus.create({
        res: options?.res ?? 0,
        free: options?.free ?? 32,
        maxlen: options?.maxlen ?? 32,
        meshPacketId: options?.meshPacketId ?? 0,
      });

      const fromRadio = FromRadio.create({
        queueStatus: queueStatus,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create QueueStatus:', error);
      return null;
    }
  }

  /**
   * Create FromRadio message wrapping a MeshPacket
   * Used for processing outgoing messages locally so they appear in the web UI
   *
   * @param meshPacket - The MeshPacket to wrap
   * @param overrideFrom - Optional node number to use for 'from' field (fixes Android client issue #626)
   */
  async createFromRadioWithPacket(meshPacket: MeshPacket, overrideFrom?: number): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');

      let packetToEncode: any = meshPacket;

      // If overrideFrom is provided, create a modified copy of the packet
      // This is used to fix issue #626 where Android clients send from=0
      if (overrideFrom !== undefined) {
        const packetObj: any = MeshPacket.toObject(meshPacket as any);
        packetObj.from = overrideFrom;
        packetToEncode = MeshPacket.create(packetObj);
        logger.debug(`📦 Created MeshPacket copy with from=${overrideFrom} for local storage`);
      }

      const fromRadio = FromRadio.create({
        packet: packetToEncode,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create FromRadio with packet:', error);
      return null;
    }
  }

  /**
   * Create a FromRadio message containing a text message MeshPacket
   * Used to replay historical messages to virtual node clients
   *
   * @param message - Message data from database
   * @returns Encoded FromRadio bytes or null on failure
   */
  async createFromRadioTextMessage(message: {
    id?: string;  // Database message ID (format: "fromNum_packetId") - used to extract original packet ID
    fromNodeNum: number;
    toNodeNum: number;
    text: string;
    channel: number;
    timestamp: number;
    requestId?: number | null;
    hopLimit?: number | null;
    rxTime?: number | null;
    rxSnr?: number | null;
    rxRssi?: number | null;
    replyId?: number | null;
    emoji?: number | null;
  }): Promise<Uint8Array | null> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const Data = root.lookupType('meshtastic.Data');

      // Create the Data payload with the text message
      // Include replyId and emoji for tapbacks/reactions to display correctly
      const textBytes = new TextEncoder().encode(message.text);

      // Build data message fields - only include replyId/emoji if they have valid values
      // This ensures tapbacks are properly associated with their original messages
      const dataFields: Record<string, unknown> = {
        portnum: PortNum.TEXT_MESSAGE_APP,
        payload: textBytes,
      };

      // Add replyId if present (links this message/reaction to another message)
      if (message.replyId && message.replyId > 0) {
        dataFields.replyId = message.replyId;
      }

      // Add emoji flag if present (indicates this is a tapback/reaction, not a regular message)
      if (message.emoji && message.emoji > 0) {
        dataFields.emoji = message.emoji;
      }

      const dataMessage = Data.create(dataFields);

      // Generate a packet ID - prefer the original packet ID if available
      // Message IDs are stored in format "fromNum_packetId", so we can extract the original
      // This is critical for tapbacks to link correctly to their original messages
      let packetId = message.requestId;
      if (!packetId && message.id) {
        const idParts = message.id.split('_');
        if (idParts.length > 1) {
          const extractedId = parseInt(idParts[1], 10);
          if (!isNaN(extractedId) && extractedId > 0) {
            packetId = extractedId;
          }
        }
      }
      // Fallback to timestamp-based ID if no packet ID found
      if (!packetId) {
        packetId = message.timestamp & 0xffffffff;
      }

      // Convert timestamp from milliseconds (database format) to seconds (Meshtastic protocol)
      // The database stores timestamps as milliseconds since epoch, but MeshPacket.rxTime
      // expects Unix seconds. Without this conversion, the 13-digit ms timestamp overflows
      // 32-bit integers and wraps to dates in the 1960s on iOS clients.
      const rxTimeSeconds = Math.floor((message.rxTime || message.timestamp) / 1000);

      // Create the MeshPacket
      const meshPacket = MeshPacket.create({
        from: message.fromNodeNum,
        to: message.toNodeNum,
        channel: message.channel >= 0 ? message.channel : 0, // Use 0 for DMs
        decoded: dataMessage,
        id: packetId,
        rxTime: rxTimeSeconds,
        rxSnr: message.rxSnr || 0,
        rxRssi: message.rxRssi || 0,
        hopLimit: message.hopLimit || 3,
      });

      // Wrap in FromRadio
      const fromRadio = FromRadio.create({
        packet: meshPacket,
      });

      return FromRadio.encode(fromRadio).finish();
    } catch (error) {
      logger.error('❌ Failed to create FromRadio text message:', error);
      return null;
    }
  }

  /**
   * Strip PKI encryption from a ToRadio packet with from=0
   * This is needed because Android clients send PKI-encrypted packets with from=0,
   * which fail validation at the physical node when relayed through Virtual Node Server
   *
   * @param toRadioBytes - The original ToRadio packet bytes
   * @returns Modified ToRadio packet bytes without PKI encryption, or original bytes if stripping fails
   */
  async stripPKIEncryption(toRadioBytes: Uint8Array): Promise<Uint8Array> {
    const root = getProtobufRoot();
    if (!root) {
      logger.error('❌ Protobuf definitions not loaded');
      return toRadioBytes;
    }

    try {
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');

      // Decode the ToRadio message
      const toRadio: any = ToRadio.decode(toRadioBytes);

      if (!toRadio.packet) {
        return toRadioBytes; // Not a packet message, return unchanged
      }

      // Convert packet to object to modify it
      const packetObj: any = MeshPacket.toObject(toRadio.packet);

      // Only strip PKI if from=0 and pkiEncrypted=true
      if ((packetObj.from === 0 || !packetObj.from) && packetObj.pkiEncrypted) {
        logger.info(`🔓 Stripping PKI encryption from packet with from=0 (pkiEncrypted=${packetObj.pkiEncrypted})`);

        // Remove PKI-related fields
        delete packetObj.pkiEncrypted;
        delete packetObj.publicKey;

        // Recreate the packet without PKI encryption
        const newPacket = MeshPacket.create(packetObj);
        const newToRadio = ToRadio.create({
          packet: newPacket,
        });

        logger.info(`✅ Successfully stripped PKI encryption from packet`);
        return ToRadio.encode(newToRadio).finish();
      }

      // No modification needed
      return toRadioBytes;
    } catch (error) {
      logger.error('❌ Failed to strip PKI encryption:', error);
      return toRadioBytes; // Return original on error
    }
  }

}

// Export singleton instance
export default MeshtasticProtobufService.getInstance();