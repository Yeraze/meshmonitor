/**
 * Meshtastic Protobuf Service
 *
 * This service provides proper protobuf parsing using the official Meshtastic
 * protobuf definitions and protobufjs library.
 */
import { loadProtobufDefinitions, getProtobufRoot, type FromRadio, type MeshPacket } from './protobufLoader.js';

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
      console.log('🔧 Initializing Meshtastic Protobuf Service...');
      await loadProtobufDefinitions();
      this.isInitialized = true;
      console.log('✅ Meshtastic Protobuf Service initialized');
    } catch (error) {
      console.error('❌ Failed to initialize protobuf service:', error);
      throw error;
    }
  }

  /**
   * Create a ToRadio message with want_config_id using proper protobuf encoding
   */
  createWantConfigRequest(): Uint8Array {
    const root = getProtobufRoot();
    if (!root) {
      console.error('❌ Protobuf definitions not loaded');
      // Fallback to simple manual encoding
      return new Uint8Array([0x18, 0x01]);
    }

    try {
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        wantConfigId: 1
      });

      return ToRadio.encode(toRadio).finish();
    } catch (error) {
      console.error('❌ Failed to create want_config_id request:', error);
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
      console.error('❌ Protobuf definitions not loaded');
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
        portnum: 70, // TRACEROUTE_APP
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
      console.error('❌ Failed to create traceroute message:', error);
      return new Uint8Array();
    }
  }

  /**
   * Create a text message ToRadio using proper protobuf encoding
   */
  createTextMessage(text: string, destination?: number, channel?: number): Uint8Array {
    const root = getProtobufRoot();
    if (!root) {
      console.error('❌ Protobuf definitions not loaded');
      return new Uint8Array();
    }

    try {
      // Create the Data message with text payload
      const Data = root.lookupType('meshtastic.Data');
      const dataMessage = Data.create({
        portnum: 1, // TEXT_MESSAGE_APP
        payload: new TextEncoder().encode(text)
      });

      // Create the MeshPacket
      const MeshPacket = root.lookupType('meshtastic.MeshPacket');
      const meshPacket = MeshPacket.create({
        to: destination || 0xFFFFFFFF, // Broadcast if no destination
        channel: channel || 0,
        decoded: dataMessage,
        wantAck: true
      });

      // Create the ToRadio message
      const ToRadio = root.lookupType('meshtastic.ToRadio');
      const toRadio = ToRadio.create({
        packet: meshPacket
      });

      return ToRadio.encode(toRadio).finish();
    } catch (error) {
      console.error('❌ Failed to create text message:', error);
      return new Uint8Array();
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
      console.error('❌ Protobuf definitions not loaded');
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
              console.log(`🔍 Field ${fieldNumber} repeated at offset ${offset + posBeforeTag} - new message starts here`);
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
            } catch (skipError) {
              console.log(`⚠️ Error skipping field ${fieldNumber} at offset ${offset + posBeforeTag}`);
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

            console.log(`📦 Decoded FromRadio at offset ${offset}, length ${messageLength}, next offset ${offset + messageLength}`);

            // Extract the actual message
            if (decodedMessage.packet) {
              // Check if decoded is Uint8Array and manually decode it as a Data message
              if (decodedMessage.packet.decoded && decodedMessage.packet.decoded instanceof Uint8Array) {
                try {
                  const Data = root.lookupType('meshtastic.Data');
                  const decodedData = Data.decode(decodedMessage.packet.decoded);
                  (decodedMessage.packet as any).decoded = decodedData;
                } catch (e) {
                  console.error('❌ Failed to manually decode Data:', e);
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
            } else {
              messages.push({ type: 'fromRadio', data: decodedMessage });
            }

            offset += messageLength;
          } else {
            console.log(`⚠️ No valid message data at offset ${offset}`);
            break;
          }
        } catch (error) {
          console.log(`⚠️ Error decoding message at offset ${offset}:`, (error as Error).message);
          break;
        }
      }

      console.log(`✅ Successfully parsed ${messages.length} FromRadio messages`);
    } catch (error) {
      console.error('❌ Error parsing multiple messages:', error);
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
    console.log('🔍 Parsing incoming data with Meshtastic protobuf service');

    if (data.length === 0) return null;

    const root = getProtobufRoot();
    if (!root) {
      console.error('❌ Protobuf definitions not loaded');
      return null;
    }

    try {
      // Try to decode as FromRadio message first
      const FromRadio = root.lookupType('meshtastic.FromRadio');
      const fromRadio = FromRadio.decode(data) as FromRadio;

      console.log('📦 Decoded FromRadio message:', {
        id: fromRadio.id,
        hasPacket: !!fromRadio.packet,
        hasMyInfo: !!fromRadio.myInfo,
        hasNodeInfo: !!fromRadio.nodeInfo,
        hasConfig: !!fromRadio.config,
        hasChannel: !!fromRadio.channel
      });

      if (fromRadio.packet) {
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
      } else {
        return {
          type: 'fromRadio',
          data: fromRadio
        };
      }
    } catch (error) {
      console.log('⚠️ Failed to decode as FromRadio, trying as MeshPacket:', (error as Error).message);

      try {
        // Try to decode directly as MeshPacket
        const MeshPacket = root.lookupType('meshtastic.MeshPacket');
        const meshPacket = MeshPacket.decode(data) as MeshPacket;

        console.log('📦 Decoded MeshPacket directly:', {
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
        console.log('⚠️ Failed to decode as MeshPacket:', (meshPacketError as Error).message);
        return null;
      }
    }
  }


  /**
   * Process payload based on port number using protobuf definitions
   */
  processPayload(portnum: number, payload: Uint8Array): any {
    console.log(`🔍 Processing payload for port ${portnum} (${this.getPortNumName(portnum)})`);

    const root = getProtobufRoot();
    if (!root) {
      console.error('❌ Protobuf definitions not loaded');
      return payload;
    }

    try {
      switch (portnum) {
        case 1: // TEXT_MESSAGE_APP
          return new TextDecoder('utf-8').decode(payload);

        case 3: // POSITION_APP
          const Position = root.lookupType('meshtastic.Position');
          const position = Position.decode(payload);
          return position;

        case 4: // NODEINFO_APP
          const User = root.lookupType('meshtastic.User');
          const user = User.decode(payload);
          return user;

        case 67: // TELEMETRY_APP
          const Telemetry = root.lookupType('meshtastic.Telemetry');
          const telemetry = Telemetry.decode(payload);
          return telemetry;

        case 70: // TRACEROUTE_APP
          const RouteDiscovery = root.lookupType('meshtastic.RouteDiscovery');
          const routeDiscovery = RouteDiscovery.decode(payload);
          return routeDiscovery;

        default:
          console.log(`⚠️ Unhandled port number: ${portnum}`);
          return payload;
      }
    } catch (error) {
      console.error(`❌ Failed to decode payload for port ${portnum}:`, error);
      return payload;
    }
  }

  /**
   * Get human-readable port number name
   */
  getPortNumName(portnum: number): string {
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
      32: 'REPLY_APP',
      33: 'IP_TUNNEL_APP',
      34: 'PAXCOUNTER_APP',
      35: 'SERIAL_APP',
      36: 'STORE_FORWARD_APP',
      37: 'RANGE_TEST_APP',
      38: 'TELEMETRY_APP',
      39: 'ZPS_APP',
      40: 'SIMULATOR_APP',
      41: 'TRACEROUTE_APP',
      42: 'NEIGHBORINFO_APP',
      43: 'ATAK_PLUGIN_APP',
      44: 'MAP_REPORT_APP',
      64: 'PRIVATE_APP',
      65: 'ATAK_FORWARDER_APP',
      67: 'TELEMETRY_APP'
    };

    return portNames[portnum] || `UNKNOWN_${portnum}`;
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
}

// Export singleton instance
export default MeshtasticProtobufService.getInstance();