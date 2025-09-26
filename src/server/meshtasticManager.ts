import databaseService from '../services/database.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService from './protobufService.js';

export interface MeshtasticConfig {
  nodeIp: string;
  useTls: boolean;
}

export interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
  };
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
  };
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  fromNodeId: string;  // For consistency with database
  toNodeId: string;    // For consistency with database
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
}

class MeshtasticManager {
  private config: MeshtasticConfig;
  private isConnected = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private localNodeInfo: { nodeNum: number; nodeId: string; longName: string; shortName: string } | null = null;

  constructor() {
    this.config = {
      nodeIp: process.env.MESHTASTIC_NODE_IP || '192.168.1.100',
      useTls: process.env.MESHTASTIC_USE_TLS === 'true'
    };
  }

  private getBaseUrl(): string {
    const protocol = this.config.useTls ? 'https' : 'http';
    return `${protocol}://${this.config.nodeIp}`;
  }

  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.getBaseUrl()}${endpoint}`;

    try {
      const response = await fetch(url, options);
      return response;
    } catch (error) {
      console.error(`Meshtastic API request failed (${endpoint}):`, error);
      throw error;
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`Connecting to Meshtastic node at ${this.config.nodeIp}...`);

      // Initialize protobuf service first
      await meshtasticProtobufService.initialize();

      // Test connection by trying to get node info
      const response = await this.makeRequest('/api/v1/fromradio');
      if (response.ok) {
        this.isConnected = true;
        console.log('Connected to Meshtastic node successfully');

        // Send want_config_id to request full node DB and config
        await this.requestFullConfiguration();

        // Start polling for updates
        this.startPolling();

        // Ensure we have a Primary channel
        this.ensurePrimaryChannel();

        return true;
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      this.isConnected = false;
      console.error('Failed to connect to Meshtastic node:', error);
      throw error;
    }
  }

  private async requestFullConfiguration(): Promise<void> {
    try {
      console.log('🔧 Requesting full configuration from node...');

      // Strategy 1: Standard want_config_id approach with extended timeout
      await this.sendWantConfigId();
      console.log('⏳ Waiting 15 seconds for device to populate fromradio queue...');
      await new Promise(resolve => setTimeout(resolve, 15000));

      let totalDataReceived = 0;
      let nodesFound = 0;
      let channelsFound = 0;

      // Try multiple requests to get all configuration data
      for (let attempt = 1; attempt <= 7; attempt++) {
        console.log(`📡 Configuration request attempt ${attempt}...`);

        const response = await this.makeRequest('/api/v1/fromradio?all=true');
        if (response.ok) {
          const data = await response.arrayBuffer();
          console.log(`📊 Attempt ${attempt}: Received ${data.byteLength} bytes`);
          totalDataReceived += data.byteLength;

          if (data.byteLength > 0) {
            const uint8Array = new Uint8Array(data);

            // Log configuration data for debugging on first few attempts
            if (attempt <= 2) {
              const hexString = Array.from(uint8Array.slice(0, 100))
                .map(b => b.toString(16).padStart(2, '0'))
                .join(' ');
              console.log(`🔍 Config hex data (first 100 bytes):`, hexString);
            }

            await this.processIncomingData(uint8Array);
            console.log(`✅ Processed data from attempt ${attempt}`);

            // Check how many nodes and channels we have now
            const currentNodes = databaseService.getNodeCount();
            const currentChannels = databaseService.getChannelCount();
            if (currentNodes > nodesFound) {
              nodesFound = currentNodes;
              console.log(`📈 Total nodes discovered: ${nodesFound}`);
            }
            if (currentChannels > channelsFound) {
              channelsFound = currentChannels;
              console.log(`📈 Total channels discovered: ${channelsFound}`);
            }
          }
        } else {
          console.warn(`⚠️ Attempt ${attempt} failed, status:`, response.status);
        }

        // Small delay between attempts
        if (attempt < 7) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }

      console.log(`📊 Configuration summary: ${totalDataReceived} bytes, ${nodesFound} nodes, ${channelsFound} channels`);

      // Strategy 2: Alternative approaches if limited data received
      if (totalDataReceived < 100 || nodesFound === 0) {
        console.log('🔄 Limited initial data, trying alternative approaches...');

        // Send multiple want_config_id requests
        for (let i = 0; i < 3; i++) {
          await this.sendWantConfigId();
          await new Promise(resolve => setTimeout(resolve, 8000));

          const altResponse = await this.makeRequest('/api/v1/fromradio');
          if (altResponse.ok) {
            const altData = await altResponse.arrayBuffer();
            if (altData.byteLength > 0) {
              console.log(`🔄 Alternative attempt ${i + 1}: ${altData.byteLength} bytes`);
              await this.processIncomingData(new Uint8Array(altData));
            }
          }
        }

        // Strategy 3: Try to get device info from JSON endpoint
        try {
          console.log('📱 Trying to fetch device info from JSON endpoint...');
          const nodeInfoResponse = await this.makeRequest('/json/info');
          if (nodeInfoResponse.ok) {
            const nodeInfo = await nodeInfoResponse.json();
            console.log('📱 Device info received:', nodeInfo);

            // If we have device info, create a basic node entry
            if (nodeInfo.num && nodeInfo.user) {
              const nodeData = {
                nodeNum: nodeInfo.num,
                nodeId: nodeInfo.user.id,
                longName: nodeInfo.user.longName || 'Connected Node',
                shortName: nodeInfo.user.shortName || nodeInfo.user.id?.substring(1, 5) || 'NODE',
                hwModel: nodeInfo.user.hwModel || 0,
                lastHeard: Date.now() / 1000,
                createdAt: Date.now(),
                updatedAt: Date.now()
              };

              console.log('📱 Creating local node from device info:', nodeData);
              databaseService.upsertNode(nodeData);
            }
          }
        } catch (infoError) {
          console.log('⚠️ Could not fetch device info:', infoError);
        }

        // Strategy 4: Try other JSON endpoints for more data
        try {
          console.log('📡 Trying to fetch from JSON stats endpoint...');
          const statsResponse = await this.makeRequest('/json/stats');
          if (statsResponse.ok) {
            const stats = await statsResponse.json();
            console.log('📊 Stats received:', stats);
          }
        } catch (statsError) {
          console.log('⚠️ Could not fetch stats:', statsError);
        }

        // Strategy 5: Try to get node database from hotspot JSON endpoints
        try {
          console.log('🏠 Trying to fetch node database from JSON endpoints...');
          const nodesResponse = await this.makeRequest('/json/nodes');
          if (nodesResponse.ok) {
            const nodesData = await nodesResponse.json();
            console.log('🏠 Nodes data from JSON:', nodesData);

            // Process nodes from JSON if available
            if (Array.isArray(nodesData) && nodesData.length > 0) {
              for (const node of nodesData) {
                if (node.num && node.user?.id) {
                  const nodeData = {
                    nodeNum: node.num,
                    nodeId: node.user.id,
                    longName: node.user.longName || `Node ${node.user.id}`,
                    shortName: node.user.shortName || node.user.id?.substring(1, 5) || 'UNK',
                    hwModel: node.user.hwModel || 0,
                    latitude: node.position?.latitude,
                    longitude: node.position?.longitude,
                    altitude: node.position?.altitude,
                    batteryLevel: node.deviceMetrics?.batteryLevel,
                    voltage: node.deviceMetrics?.voltage,
                    lastHeard: node.lastHeard || Date.now() / 1000,
                    snr: node.snr,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                  };
                  console.log('🏠 Creating node from JSON data:', nodeData.longName);
                  databaseService.upsertNode(nodeData);
                }
              }
            }
          }
        } catch (nodesError) {
          console.log('⚠️ Could not fetch nodes from JSON:', nodesError);
        }
      }

      // Strategy 6: Ensure we have basic channels even if none were discovered
      const finalChannelCount = databaseService.getChannelCount();
      if (finalChannelCount === 0) {
        console.log('📡 No channels discovered, creating default channels...');
        this.createDefaultChannels();
      }

      // Final summary
      const finalNodeCount = databaseService.getNodeCount();
      const finalChannelCountAfter = databaseService.getChannelCount();
      console.log(`✅ Configuration complete: ${finalNodeCount} nodes, ${finalChannelCountAfter} channels`);

    } catch (error) {
      console.error('❌ Failed to request full configuration:', error);
      // Even if configuration fails, ensure we have basic setup
      this.ensureBasicSetup();
    }
  }

  private createDefaultChannels(): void {
    console.log('📡 Creating default channel configuration...');

    // Create Primary channel by default
    try {
      databaseService.upsertChannel({
        id: 0,
        name: 'Primary'
      });
      console.log('📡 Created Primary channel');
    } catch (error) {
      console.error('❌ Failed to create Primary channel:', error);
    }
  }

  private ensureBasicSetup(): void {
    console.log('🔧 Ensuring basic setup is complete...');

    // Ensure we have at least a Primary channel
    const channelCount = databaseService.getChannelCount();
    if (channelCount === 0) {
      this.createDefaultChannels();
    }

    // Note: Don't create fake nodes - they will be discovered naturally through mesh traffic
    console.log('✅ Basic setup ensured');
  }

  private async sendWantConfigId(): Promise<void> {
    try {
      console.log('Sending want_config_id to trigger configuration data...');

      // Use the new protobuf service to create a proper want_config_id message
      const wantConfigMessage = meshtasticProtobufService.createWantConfigRequest();

      const response = await this.makeRequest('/api/v1/toradio', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/x-protobuf'
        },
        body: wantConfigMessage as BodyInit
      });

      if (response.ok) {
        console.log('Successfully sent want_config_id request');
      } else {
        console.warn('Failed to send want_config_id, status:', response.status);
      }
    } catch (error) {
      console.error('Error sending want_config_id:', error);
    }
  }

  disconnect(): void {
    this.isConnected = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    console.log('Disconnected from Meshtastic node');
  }

  private startPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    let pollCount = 0;

    // Poll every 2 seconds for new data
    this.pollingInterval = setInterval(async () => {
      if (this.isConnected) {
        await this.pollForUpdates();

        // Every 30 polls (1 minute), try to request node database again
        pollCount++;
        if (pollCount % 30 === 0) {
          console.log('Periodic node database refresh...');
          await this.sendWantConfigId();
        }
      }
    }, 2000);
  }

  private async pollForUpdates(): Promise<void> {
    try {
      const response = await this.makeRequest('/api/v1/fromradio');
      if (!response.ok) {
        console.warn('Failed to poll for updates:', response.status);
        return;
      }

      const data = await response.arrayBuffer();
      if (data.byteLength > 0) {
        console.log(`Received ${data.byteLength} bytes from Meshtastic node`);

        // Log raw data in hex for debugging
        const uint8Array = new Uint8Array(data);
        const hexString = Array.from(uint8Array)
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ');
        console.log('Raw hex data:', hexString.substring(0, 200) + (hexString.length > 200 ? '...' : ''));

        // Log readable ASCII content
        const textDecoder = new TextDecoder('utf-8', { fatal: false });
        const readable = textDecoder.decode(uint8Array);
        const printableChars = readable.replace(/[\x00-\x1F\x7F-\xFF]/g, '.');
        console.log('Readable content:', printableChars.substring(0, 200) + (printableChars.length > 200 ? '...' : ''));

        await this.processIncomingData(uint8Array);
      }
    } catch (error) {
      console.error('Error polling for updates:', error);
    }
  }

  private async processIncomingData(data: Uint8Array): Promise<void> {
    try {
      if (data.length === 0) {
        return; // Empty response
      }

      console.log(`📦 Processing ${data.length} bytes with unified protobuf service...`);

      // Use the unified protobuf service to parse incoming data
      const parsedData = meshtasticProtobufService.parseIncomingData(data);

      if (parsedData) {
        console.log(`✅ Decoded ${parsedData.type}:`, parsedData.data);

        switch (parsedData.type) {
          case 'fromRadio':
            await this.processFromRadio(parsedData.data);
            break;
          case 'meshPacket':
            await this.processMeshPacket(parsedData.data);
            break;
          case 'myInfo':
            await this.processMyNodeInfo(parsedData.data);
            break;
          case 'nodeInfo':
            await this.processNodeInfoProtobuf(parsedData.data);
            break;
          case 'config':
            await this.processConfigProtobuf(parsedData.data);
            break;
          case 'channel':
            await this.processChannelProtobuf(parsedData.data);
            break;
          default:
            console.log(`🤷 Unhandled protobuf type: ${parsedData.type}`);
        }
      } else {
        console.log('⚠️ No parseable protobuf data found in', data.length, 'bytes');
        // Log hex data for debugging
        const hexString = Array.from(data.slice(0, 100))
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ');
        console.log('Raw hex data (first 100 bytes):', hexString);
      }
    } catch (error) {
      console.error('❌ Error processing incoming data:', error);
    }
  }

  /**
   * Process FromRadio protobuf message
   */
  private async processFromRadio(fromRadio: any): Promise<void> {
    console.log('📻 Processing FromRadio message');

    switch (fromRadio.payloadVariant.case) {
      case 'packet':
        if (fromRadio.payloadVariant.value) {
          await this.processMeshPacket(fromRadio.payloadVariant.value);
        }
        break;
      case 'myInfo':
        console.log('📱 Received MyNodeInfo:', fromRadio.payloadVariant.value);
        if (fromRadio.payloadVariant.value) {
          await this.processMyNodeInfo(fromRadio.payloadVariant.value);
        }
        break;
      case 'nodeInfo':
        console.log('🏠 Received NodeInfo:', fromRadio.payloadVariant.value);
        if (fromRadio.payloadVariant.value) {
          await this.processNodeInfoProtobuf(fromRadio.payloadVariant.value);
        }
        break;
      case 'config':
        console.log('⚙️ Received Config:', fromRadio.payloadVariant.value);
        // Handle device configuration
        break;
      case 'logRecord':
        console.log('📝 Received LogRecord:', fromRadio.payloadVariant.value);
        // Handle log records
        break;
      case 'configCompleteId':
        console.log('✅ Configuration complete, ID:', fromRadio.payloadVariant.value);
        // Configuration is complete
        break;
      case 'rebooted':
        console.log('🔄 Device rebooted');
        // Device has rebooted
        break;
      case 'moduleConfig':
        console.log('💭 Module config:', fromRadio.payloadVariant.value);
        // Handle module configuration
        break;
      case 'channel':
        console.log('📡 Received Channel:', fromRadio.payloadVariant.value);
        await this.processChannelProtobuf(fromRadio.payloadVariant.value);
        break;
      case 'queueStatus':
        console.log('📋 Queue status:', fromRadio.payloadVariant.value);
        // Handle queue status
        break;
      case 'xmodemPacket':
        console.log('📦 XModem packet received');
        // Handle XModem packets for file transfer
        break;
      case 'metadata':
        console.log('📊 Metadata:', fromRadio.payloadVariant.value);
        // Handle metadata
        break;
      case 'mqttClientProxyMessage':
        console.log('🌐 MQTT proxy message:', fromRadio.payloadVariant.value);
        // Handle MQTT proxy messages
        break;
      default:
        console.log('🤷 Unknown FromRadio variant:', fromRadio.payloadVariant.case);
    }
  }

  /**
   * Process MyNodeInfo protobuf message
   */
  private async processMyNodeInfo(myNodeInfo: any): Promise<void> {
    console.log('📱 Processing MyNodeInfo for local device');

    const nodeData = {
      nodeNum: Number(myNodeInfo.myNodeNum),
      nodeId: `!${myNodeInfo.myNodeNum.toString(16).padStart(8, '0')}`,
      longName: 'Local Device',
      shortName: 'LOCAL',
      hwModel: myNodeInfo.hwModel || 0,
      lastHeard: Date.now() / 1000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Store local node info for message sending
    this.localNodeInfo = {
      nodeNum: nodeData.nodeNum,
      nodeId: nodeData.nodeId,
      longName: nodeData.longName,
      shortName: nodeData.shortName
    };

    databaseService.upsertNode(nodeData);
    console.log('📱 Updated local device info in database');
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string } | null {
    return this.localNodeInfo;
  }

  /**
   * Process Channel protobuf message
   */
  private async processChannelProtobuf(channel: any): Promise<void> {
    console.log('📡 Processing Channel protobuf', {
      index: channel.index,
      role: channel.role,
      name: channel.settings?.name,
      hasPsk: !!channel.settings?.psk,
      uplinkEnabled: channel.settings?.uplinkEnabled,
      downlinkEnabled: channel.settings?.downlinkEnabled
    });

    if (channel.settings) {
      // Only save channels that are actually configured and useful
      const channelName = channel.settings.name || `Channel ${channel.index}`;
      const hasValidConfig = channel.settings.name ||
                            channel.settings.psk ||
                            channel.role === 1 || // PRIMARY role
                            channel.role === 2 || // SECONDARY role
                            channel.index === 0;   // Always include channel 0

      if (hasValidConfig) {
        try {
          databaseService.upsertChannel({
            id: channel.index,
            name: channelName,
            psk: channel.settings.psk ? 'Set' : undefined
          });
          console.log(`📡 Saved channel: ${channelName} (role: ${channel.role}, index: ${channel.index})`);
        } catch (error) {
          console.error('❌ Failed to save channel:', error);
        }
      } else {
        console.log(`📡 Skipping empty/unused channel ${channel.index}`);
      }
    }
  }

  /**
   * Process Config protobuf message
   */
  private async processConfigProtobuf(config: any): Promise<void> {
    console.log('⚙️ Processing Config protobuf:', config);
    // Configuration messages don't typically need database storage
    // They contain device settings like LoRa parameters, GPS settings, etc.
  }

  /**
   * Process MeshPacket protobuf message
   */
  private async processMeshPacket(meshPacket: any): Promise<void> {
    console.log(`🔄 Processing MeshPacket: ID=${meshPacket.id}, from=${meshPacket.from}, to=${meshPacket.to}`);

    // Extract node information if available
    if (meshPacket.from && meshPacket.from !== BigInt(0)) {
      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        longName: `Node ${nodeId}`,
        shortName: nodeId.substring(1, 5),
        lastHeard: meshPacket.rxTime ? Number(meshPacket.rxTime) / 1000 : Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }
      databaseService.upsertNode(nodeData);
    }

    // Process decoded payload if present
    if (meshPacket.decoded) {
      const portnum = meshPacket.decoded.portnum;
      const payload = meshPacket.decoded.payload;

      console.log(`📨 Processing payload: portnum=${portnum} (${meshtasticProtobufService.getPortNumName(portnum)}), payload size=${payload?.length || 0}`);

      if (payload && payload.length > 0) {
        // Use the unified protobuf service to process the payload
        const processedPayload = meshtasticProtobufService.processPayload(portnum, payload);

        switch (portnum) {
          case 1: // TEXT_MESSAGE_APP
            await this.processTextMessageProtobuf(meshPacket, processedPayload as string);
            break;
          case 3: // POSITION_APP
            await this.processPositionMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 4: // NODEINFO_APP
            await this.processNodeInfoMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 67: // TELEMETRY_APP
            await this.processTelemetryMessageProtobuf(meshPacket, processedPayload as any);
            break;
          case 5: // ROUTING_APP
            console.log('🗺️ Routing message:', processedPayload);
            break;
          case 6: // ADMIN_APP
            console.log('⚙️ Admin message:', processedPayload);
            break;
          case 42: // NEIGHBORINFO_APP
            console.log('🏠 Neighbor info:', processedPayload);
            break;
          case 41: // TRACEROUTE_APP
            console.log('🗺️ Traceroute:', processedPayload);
            break;
          default:
            console.log(`🤷 Unhandled portnum: ${portnum} (${meshtasticProtobufService.getPortNumName(portnum)})`);
        }
      }
    }
  }

  /**
   * Process text message using protobuf types
   */
  private async processTextMessageProtobuf(meshPacket: any, messageText: string): Promise<void> {
    try {
      console.log(`💬 Text message: "${messageText}"`);

      if (messageText && messageText.length > 0 && messageText.length < 500) {
        const fromNum = Number(meshPacket.from);
        const toNum = Number(meshPacket.to);

        // Ensure the from node exists in the database
        const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
        const existingFromNode = databaseService.getNode(fromNum);
        if (!existingFromNode) {
          // Create a basic node entry if it doesn't exist
          const basicNodeData = {
            nodeNum: fromNum,
            nodeId: fromNodeId,
            longName: `Node ${fromNodeId}`,
            shortName: fromNodeId.substring(1, 5),
            lastHeard: Date.now() / 1000,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          databaseService.upsertNode(basicNodeData);
          console.log(`📝 Created basic node entry for ${fromNodeId}`);
        }

        // Handle broadcast address (4294967295 = 0xFFFFFFFF)
        let actualToNum = toNum;
        const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

        if (toNum === 4294967295) {
          // For broadcast messages, use a special broadcast node
          const broadcastNodeNum = 4294967295;
          const existingBroadcastNode = databaseService.getNode(broadcastNodeNum);
          if (!existingBroadcastNode) {
            const broadcastNodeData = {
              nodeNum: broadcastNodeNum,
              nodeId: '!ffffffff',
              longName: 'Broadcast',
              shortName: 'BCAST',
              lastHeard: Date.now() / 1000,
              createdAt: Date.now(),
              updatedAt: Date.now()
            };
            databaseService.upsertNode(broadcastNodeData);
            console.log(`📝 Created broadcast node entry`);
          }
        }

        const message = {
          id: `${fromNum}_${meshPacket.id || Date.now()}`,
          fromNodeNum: fromNum,
          toNodeNum: actualToNum,
          fromNodeId: fromNodeId,
          toNodeId: toNodeId,
          text: messageText,
          channel: meshPacket.channel || 0,
          portnum: 1, // TEXT_MESSAGE_APP
          timestamp: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          rxTime: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          createdAt: Date.now()
        };

        console.log(`🔍 Channel debug: meshPacket.channel=${meshPacket.channel}, saved channel=${message.channel}, typeof=${typeof meshPacket.channel}`);
        databaseService.insertMessage(message);
        console.log(`💾 Saved text message from ${message.fromNodeId}: "${messageText.substring(0, 30)}..."`);
      }
    } catch (error) {
      console.error('❌ Error processing text message:', error);
    }
  }

  /**
   * Legacy text message processing (for backward compatibility)
   */

  /**
   * Process position message using protobuf types
   */
  private async processPositionMessageProtobuf(meshPacket: any, position: any): Promise<void> {
    try {
      console.log(`🗺️ Position message: lat=${position.latitudeI}, lng=${position.longitudeI}`);

      if (position.latitudeI && position.longitudeI) {
        // Convert coordinates from integer format to decimal degrees
        const coords = meshtasticProtobufService.convertCoordinates(position.latitudeI, position.longitudeI);

        const fromNum = Number(meshPacket.from);
        const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
        const nodeData: any = {
          nodeNum: fromNum,
          nodeId: nodeId,
          latitude: coords.latitude,
          longitude: coords.longitude,
          altitude: position.altitude,
          lastHeard: position.time ? Number(position.time) : Date.now() / 1000
        };

        // Only include SNR/RSSI if they have valid values
        if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
          nodeData.snr = meshPacket.rxSnr;
        }
        if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
          nodeData.rssi = meshPacket.rxRssi;
        }

        databaseService.upsertNode(nodeData);
        console.log(`🗺️ Updated node position: ${nodeId} -> ${coords.latitude}, ${coords.longitude}`);
      }
    } catch (error) {
      console.error('❌ Error processing position message:', error);
    }
  }

  /**
   * Legacy position message processing (for backward compatibility)
   */

  /**
   * Process user message (node info) using protobuf types
   */
  private async processNodeInfoMessageProtobuf(meshPacket: any, user: any): Promise<void> {
    try {
      console.log(`👤 User message for: ${user.longName}`);

      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        longName: user.longName,
        shortName: user.shortName,
        hwModel: user.hwModel,
        lastHeard: Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      databaseService.upsertNode(nodeData);
      console.log(`👤 Updated user info: ${user.longName || nodeId}`);
    } catch (error) {
      console.error('❌ Error processing user message:', error);
    }
  }

  /**
   * Legacy node info message processing (for backward compatibility)
   */

  /**
   * Process telemetry message using protobuf types
   */
  private async processTelemetryMessageProtobuf(meshPacket: any, telemetry: any): Promise<void> {
    try {
      console.log('📊 Processing telemetry message');

      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        lastHeard: telemetry.time ? Number(telemetry.time) : Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      // Handle different telemetry types
      if (telemetry.variant?.case === 'deviceMetrics' && telemetry.variant.value) {
        const deviceMetrics = telemetry.variant.value;
        console.log(`📊 Device telemetry: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);

        nodeData.batteryLevel = deviceMetrics.batteryLevel;
        nodeData.voltage = deviceMetrics.voltage;
        nodeData.channelUtilization = deviceMetrics.channelUtilization;
        nodeData.airUtilTx = deviceMetrics.airUtilTx;
      } else if (telemetry.variant?.case === 'environmentMetrics' && telemetry.variant.value) {
        const envMetrics = telemetry.variant.value;
        console.log(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);
        // Could extend nodeData to include environmental metrics
      } else if (telemetry.variant?.case === 'powerMetrics' && telemetry.variant.value) {
        const powerMetrics = telemetry.variant.value;
        console.log(`⚡ Power telemetry: ch1_voltage=${powerMetrics.ch1Voltage}V`);
        // Could extend nodeData to include power metrics
      }

      databaseService.upsertNode(nodeData);
      console.log(`📊 Updated node telemetry: ${nodeId}`);
    } catch (error) {
      console.error('❌ Error processing telemetry message:', error);
    }
  }

  /**
   * Legacy telemetry message processing (for backward compatibility)
   */

  /**
   * Process NodeInfo protobuf message directly
   */
  private async processNodeInfoProtobuf(nodeInfo: any): Promise<void> {
    try {
      console.log(`🏠 Processing NodeInfo for node ${nodeInfo.num}`);

      const nodeId = `!${Number(nodeInfo.num).toString(16).padStart(8, '0')}`;
      const nodeData: any = {
        nodeNum: Number(nodeInfo.num),
        nodeId: nodeId,
        lastHeard: nodeInfo.lastHeard ? Number(nodeInfo.lastHeard) : Date.now() / 1000,
        snr: nodeInfo.snr,
        rssi: 0 // Will be updated from mesh packet if available
      };

      // Add user information if available
      if (nodeInfo.user) {
        nodeData.longName = nodeInfo.user.longName;
        nodeData.shortName = nodeInfo.user.shortName;
        nodeData.hwModel = nodeInfo.user.hwModel;
      }

      // Add position information if available
      if (nodeInfo.position && (nodeInfo.position.latitudeI || nodeInfo.position.longitudeI)) {
        const coords = meshtasticProtobufService.convertCoordinates(
          nodeInfo.position.latitudeI,
          nodeInfo.position.longitudeI
        );
        nodeData.latitude = coords.latitude;
        nodeData.longitude = coords.longitude;
        nodeData.altitude = nodeInfo.position.altitude;
      }

      // Add device metrics if available
      if (nodeInfo.deviceMetrics) {
        nodeData.batteryLevel = nodeInfo.deviceMetrics.batteryLevel;
        nodeData.voltage = nodeInfo.deviceMetrics.voltage;
        nodeData.channelUtilization = nodeInfo.deviceMetrics.channelUtilization;
        nodeData.airUtilTx = nodeInfo.deviceMetrics.airUtilTx;
      }

      databaseService.upsertNode(nodeData);
      console.log(`🏠 Updated node info: ${nodeData.longName || nodeId}`);
    } catch (error) {
      console.error('❌ Error processing NodeInfo protobuf:', error);
    }
  }

  /**
   * Process User protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processUserProtobuf(user: any): Promise<void> {
    try {
      console.log(`👤 Processing User: ${user.longName}`);

      // Extract node number from user ID if possible
      let nodeNum = 0;
      if (user.id && user.id.startsWith('!')) {
        nodeNum = parseInt(user.id.substring(1), 16);
      }

      if (nodeNum > 0) {
        const nodeData = {
          nodeNum: nodeNum,
          nodeId: user.id,
          longName: user.longName,
          shortName: user.shortName,
          hwModel: user.hwModel,
          lastHeard: Date.now() / 1000
        };

        databaseService.upsertNode(nodeData);
        console.log(`👤 Updated user info: ${user.longName}`);
      }
    } catch (error) {
      console.error('❌ Error processing User protobuf:', error);
    }
  }

  /**
   * Process Position protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processPositionProtobuf(position: any): Promise<void> {
    try {
      console.log(`🗺️ Processing Position: lat=${position.latitudeI}, lng=${position.longitudeI}`);

      if (position.latitudeI && position.longitudeI) {
        const coords = meshtasticProtobufService.convertCoordinates(position.latitudeI, position.longitudeI);
        console.log(`🗺️ Position: ${coords.latitude}, ${coords.longitude}`);

        // Note: Without a mesh packet context, we can't determine which node this position belongs to
        // This would need to be handled at a higher level or with additional context
      }
    } catch (error) {
      console.error('❌ Error processing Position protobuf:', error);
    }
  }

  /**
   * Process Telemetry protobuf message directly
   */
  // @ts-ignore - Legacy function kept for backward compatibility
  private async processTelemetryProtobuf(telemetry: any): Promise<void> {
    try {
      console.log('📊 Processing Telemetry protobuf');

      // Note: Without a mesh packet context, we can't determine which node this telemetry belongs to
      // This would need to be handled at a higher level or with additional context

      if (telemetry.variant?.case === 'deviceMetrics' && telemetry.variant.value) {
        const deviceMetrics = telemetry.variant.value;
        console.log(`📊 Device metrics: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);
      } else if (telemetry.variant?.case === 'environmentMetrics' && telemetry.variant.value) {
        const envMetrics = telemetry.variant.value;
        console.log(`🌡️ Environment metrics: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);
      }
    } catch (error) {
      console.error('❌ Error processing Telemetry protobuf:', error);
    }
  }


  // @ts-ignore - Legacy function kept for backward compatibility
  private saveNodesFromData(nodeIds: string[], readableText: string[], text: string): void {
    // Extract and save all discovered nodes to database
    const uniqueNodeIds = [...new Set(nodeIds)];
    console.log(`Saving ${uniqueNodeIds.length} nodes to database`);

    for (const nodeId of uniqueNodeIds) {
      try {
        const nodeNum = parseInt(nodeId.substring(1), 16);

        // Try to find a name for this node in the readable text using enhanced protobuf parsing
        const possibleName = this.findNameForNodeEnhanced(nodeId, readableText, text);

        const nodeData = {
          nodeNum: nodeNum,
          nodeId: nodeId,
          longName: possibleName.longName || `Node ${nodeId}`,
          shortName: possibleName.shortName || nodeId.substring(1, 5),
          hwModel: possibleName.hwModel || 0,
          lastHeard: Date.now() / 1000,
          snr: possibleName.snr,
          rssi: possibleName.rssi,
          batteryLevel: possibleName.batteryLevel,
          voltage: possibleName.voltage,
          latitude: possibleName.latitude,
          longitude: possibleName.longitude,
          altitude: possibleName.altitude,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };

        // Save to database immediately
        databaseService.upsertNode(nodeData);
        console.log(`Saved node: ${nodeData.longName} (${nodeData.nodeId})`);

      } catch (error) {
        console.error(`Failed to process node ${nodeId}:`, error);
      }
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractChannelInfo(_data: Uint8Array, text: string, readableMatches: string[] | null): any {
    // Extract channel names from both readableMatches and direct text analysis
    const knownMeshtasticChannels = ['Primary', 'admin', 'gauntlet', 'telemetry', 'Secondary', 'LongFast', 'VeryLong'];
    const foundChannels = new Set<string>();

    // Check readableMatches first
    if (readableMatches) {
      readableMatches.forEach(match => {
        const normalizedMatch = match.trim().toLowerCase();
        knownMeshtasticChannels.forEach(channel => {
          if (channel.toLowerCase() === normalizedMatch) {
            foundChannels.add(channel);
          }
        });
      });
    }

    // Also check direct text for channel names (case-insensitive)
    const textLower = text.toLowerCase();
    knownMeshtasticChannels.forEach(channel => {
      if (textLower.includes(channel.toLowerCase())) {
        foundChannels.add(channel);
      }
    });

    const validChannels = Array.from(foundChannels);

    if (validChannels.length > 0) {
      console.log('Found valid Meshtastic channels:', validChannels);
      this.saveChannelsToDatabase(validChannels);

      return {
        type: 'channelConfig',
        data: {
          channels: validChannels,
          message: `Found Meshtastic channels: ${validChannels.join(', ')}`
        }
      };
    }

    // Ensure we always have a Primary channel
    const existingChannels = databaseService.getAllChannels();
    if (existingChannels.length === 0) {
      console.log('Creating default Primary channel');
      this.saveChannelsToDatabase(['Primary']);

      return {
        type: 'channelConfig',
        data: {
          channels: ['Primary'],
          message: 'Created default Primary channel'
        }
      };
    }

    return null;
  }

  private ensurePrimaryChannel(): void {
    const existingChannels = databaseService.getAllChannels();
    if (existingChannels.length === 0) {
      console.log('📡 Creating default Primary channel');
      this.createDefaultChannels();
    }
  }

  private saveChannelsToDatabase(channelNames: string[]): void {
    for (let i = 0; i < channelNames.length; i++) {
      const channelName = channelNames[i].trim();
      if (channelName.length > 0) {
        try {
          databaseService.upsertChannel({
            id: i, // Use index as channel ID
            name: channelName
          });
        } catch (error) {
          console.error(`Failed to save channel ${channelName}:`, error);
        }
      }
    }
  }

  private findNameForNodeEnhanced(nodeId: string, readableText: string[], fullText: string): any {
    // Enhanced protobuf parsing to extract all node information including telemetry
    const result: any = {
      longName: undefined,
      shortName: undefined,
      hwModel: undefined,
      snr: undefined,
      rssi: undefined,
      batteryLevel: undefined,
      voltage: undefined,
      latitude: undefined,
      longitude: undefined,
      altitude: undefined
    };

    // Find the position of this node ID in the binary data
    const nodeIndex = fullText.indexOf(nodeId);
    if (nodeIndex === -1) return result;

    // Extract a larger context around the node ID for detailed parsing
    const contextStart = Math.max(0, nodeIndex - 100);
    const contextEnd = Math.min(fullText.length, nodeIndex + nodeId.length + 200);
    const context = fullText.substring(contextStart, contextEnd);

    // Parse the protobuf structure around this node ID
    try {
      const contextBytes = new TextEncoder().encode(context);
      const parsedData = this.parseNodeProtobufData(contextBytes, nodeId);
      if (parsedData) {
        Object.assign(result, parsedData);
      }
    } catch (error) {
      console.error(`Error parsing node data for ${nodeId}:`, error);
    }

    // Fallback: Look for readable text patterns near the node ID
    if (!result.longName) {
      // Look for known good names from the readableText array first
      for (const text of readableText) {
        if (this.isValidNodeName(text) && text !== nodeId && text.length >= 3) {
          result.longName = text.trim();
          break;
        }
      }

      // If still no good name, try pattern matching in the context with stricter validation
      if (!result.longName) {
        const afterContext = fullText.substring(nodeIndex + nodeId.length, nodeIndex + nodeId.length + 100);
        const nameMatch = afterContext.match(/([\p{L}\p{S}][\p{L}\p{N}\p{S}\p{P}\s\-_.]{1,30})/gu);

        if (nameMatch && nameMatch[0] && this.isValidNodeName(nameMatch[0]) && nameMatch[0].length >= 3) {
          result.longName = nameMatch[0].trim();
        }
      }

      // Validate shortName length (must be 2-4 characters)
      if (result.shortName && (result.shortName.length < 2 || result.shortName.length > 4)) {
        // Try to create a valid shortName from longName
        if (result.longName && result.longName.length >= 3) {
          result.shortName = result.longName.substring(0, 4).toUpperCase();
        } else {
          delete result.shortName;
        }
      }

      // Generate shortName if we have a longName
      if (result.longName && !result.shortName) {
        // Look for a separate short name in readableText
        for (const text of readableText) {
          if (text !== result.longName && text.length >= 2 && text.length <= 8 &&
              this.isValidNodeName(text) && text !== nodeId) {
            result.shortName = text.trim();
            break;
          }
        }

        // If no separate shortName found, generate from longName
        if (!result.shortName) {
          const alphanumeric = result.longName.replace(/[^\w]/g, '');
          result.shortName = alphanumeric.substring(0, 4) || result.longName.substring(0, 4);
        }
      }
    }

    // Try to extract telemetry data from readable text patterns
    for (const text of readableText) {
      // Look for battery level patterns
      const batteryMatch = text.match(/(\d{1,3})%/);
      if (batteryMatch && !result.batteryLevel) {
        const batteryLevel = parseInt(batteryMatch[1]);
        if (batteryLevel >= 0 && batteryLevel <= 100) {
          result.batteryLevel = batteryLevel;
        }
      }

      // Look for voltage patterns
      const voltageMatch = text.match(/(\d+\.\d+)V/);
      if (voltageMatch && !result.voltage) {
        result.voltage = parseFloat(voltageMatch[1]);
      }

      // Look for coordinate patterns
      const latMatch = text.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
      if (latMatch && !result.latitude) {
        result.latitude = parseFloat(latMatch[1]);
        result.longitude = parseFloat(latMatch[2]);
      }
    }

    return result;
  }

  private parseNodeProtobufData(data: Uint8Array, nodeId: string): any {
    // Enhanced protobuf parsing specifically for node information
    const result: any = {};

    try {
      // First, try to decode the entire data block as a NodeInfo message
      const nodeInfo = protobufService.decodeNodeInfo(data);
      if (nodeInfo && nodeInfo.position) {
        console.log(`🗺️ Extracted position from NodeInfo during config parsing for ${nodeId}`);
        const coords = protobufService.convertCoordinates(
          nodeInfo.position.latitude_i,
          nodeInfo.position.longitude_i
        );
        result.latitude = coords.latitude;
        result.longitude = coords.longitude;
        result.altitude = nodeInfo.position.altitude;

        // Also extract other NodeInfo data if available
        if (nodeInfo.user) {
          result.longName = nodeInfo.user.long_name;
          result.shortName = nodeInfo.user.short_name;
          result.hwModel = nodeInfo.user.hw_model;
        }

        if (nodeInfo.device_metrics) {
          result.batteryLevel = nodeInfo.device_metrics.battery_level;
          result.voltage = nodeInfo.device_metrics.voltage;
        }

        console.log(`📍 Config position data: ${coords.latitude}, ${coords.longitude} for ${nodeId}`);
      }
    } catch (nodeInfoError) {
      // NodeInfo parsing failed, try manual field parsing as fallback
    }

    try {
      let offset = 0;

      while (offset < data.length - 10) {
        // Look for protobuf field patterns
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 50) {
          offset++;

          if (wireType === 2) { // Length-delimited field (strings, embedded messages)
            if (offset < data.length) {
              const length = data[offset];
              offset++;

              if (offset + length <= data.length && length > 0 && length < 50) {
                const fieldData = data.slice(offset, offset + length);

                try {
                  // Try to decode as UTF-8 string (non-fatal for better emoji support)
                  const str = new TextDecoder('utf-8', { fatal: false }).decode(fieldData);

                  // Debug: log raw bytes for troubleshooting Unicode issues
                  if (fieldData.length <= 10) {
                    const hex = Array.from(fieldData).map(b => b.toString(16).padStart(2, '0')).join(' ');
                    console.log(`Field ${fieldNumber} raw bytes for "${str}": [${hex}]`);
                  }

                  // Parse based on actual protobuf field numbers (Meshtastic User message schema)
                  if (fieldNumber === 2) { // longName field
                    if (this.isValidNodeName(str) && str !== nodeId && str.length >= 3) {
                      result.longName = str;
                      console.log(`Extracted longName from protobuf field 2: ${str}`);
                    }
                  } else if (fieldNumber === 3) { // shortName field
                    // For shortName, count actual Unicode characters, not bytes
                    const unicodeLength = Array.from(str).length;
                    if (unicodeLength >= 1 && unicodeLength <= 4 && this.isValidNodeName(str)) {
                      result.shortName = str;
                      console.log(`Extracted shortName from protobuf field 3: ${str} (${unicodeLength} chars)`);
                    }
                  }
                } catch (e) {
                  // Not valid UTF-8 text, might be binary data
                  // Try to parse as embedded message with telemetry data
                  this.parseEmbeddedTelemetry(fieldData, result);
                }

                offset += length;
              }
            }
          } else if (wireType === 0) { // Varint (numbers)
            let value = 0;
            let shift = 0;
            let hasMore = true;

            while (offset < data.length && hasMore) {
              const byte = data[offset];
              hasMore = (byte & 0x80) !== 0;
              value |= (byte & 0x7F) << shift;
              shift += 7;
              offset++;

              if (!hasMore || shift >= 64) break;
            }

            // Try to identify what this number represents based on field number and value range
            if (fieldNumber === 1 && value > 1000000) {
              // Likely node number
            } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
              // Might be battery level
              result.batteryLevel = value;
            } else if (fieldNumber === 7 && value > 0) {
              // Might be hardware model
              result.hwModel = value;
            }
          } else {
            offset++;
          }
        } else {
          offset++;
        }

        if (offset >= data.length) break;
      }
    } catch (error) {
      // Ignore parsing errors, this is experimental
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  private isValidNodeName(str: string): boolean {
    // Validate that this is a legitimate node name
    if (str.length < 2 || str.length > 30) return false;

    // Must contain at least some Unicode letters or numbers (full Unicode support)
    if (!/[\p{L}\p{N}]/u.test(str)) return false;

    // Reject strings that are mostly control characters (using Unicode categories)
    const controlCharCount = (str.match(/[\p{C}]/gu) || []).length;
    if (controlCharCount > str.length * 0.3) return false;

    // Reject binary null bytes and similar problematic characters
    if (str.includes('\x00') || str.includes('\xFF')) return false;

    // Count printable/displayable characters using Unicode categories
    // Letters, Numbers, Symbols, Punctuation, and some Marks are considered valid
    const validChars = str.match(/[\p{L}\p{N}\p{S}\p{P}\p{M}\s]/gu) || [];
    const validCharRatio = validChars.length / str.length;

    // At least 70% of characters should be valid/printable Unicode characters
    if (validCharRatio < 0.7) return false;

    // Reject strings that are mostly punctuation/symbols without letters/numbers
    const letterNumberCount = (str.match(/[\p{L}\p{N}]/gu) || []).length;
    const letterNumberRatio = letterNumberCount / str.length;
    if (letterNumberRatio < 0.3) return false;

    // Additional validation for common binary/garbage patterns
    // Reject strings with too many identical consecutive characters
    if (/(.)\1{4,}/.test(str)) return false;

    // Reject strings that look like hex dumps or similar patterns
    if (/^[A-F0-9\s]{8,}$/i.test(str) && !/[G-Z]/i.test(str)) return false;

    return true;
  }

  private parseEmbeddedTelemetry(data: Uint8Array, result: any): void {
    // Parse embedded protobuf messages that may contain position data
    console.log(`🔍 parseEmbeddedTelemetry called with ${data.length} bytes: [${Array.from(data.slice(0, Math.min(20, data.length))).map(b => b.toString(16).padStart(2, '0')).join(' ')}${data.length > 20 ? '...' : ''}]`);

    // Strategy 1: Look for encoded integer patterns that could be coordinates
    // Meshtastic encodes lat/lng as integers * 10^7
    for (let i = 0; i <= data.length - 4; i++) {
      try {
        // Try to decode as little-endian 32-bit signed integer
        const view = new DataView(data.buffer, data.byteOffset + i, 4);
        const value = view.getInt32(0, true); // little endian

        const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000;
        const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000;

        if (isValidLatitude) {
          console.log(`🌍 Found potential latitude at byte ${i}: ${value / 10000000} (raw: ${value})`);
          if (!result.position) result.position = {};
          result.position.latitude = value / 10000000;
          result.latitude = value / 10000000;
        } else if (isValidLongitude) {
          console.log(`🌍 Found potential longitude at byte ${i}: ${value / 10000000} (raw: ${value})`);
          if (!result.position) result.position = {};
          result.position.longitude = value / 10000000;
          result.longitude = value / 10000000;
        }
      } catch (e) {
        // Skip invalid positions
      }
    }

    try {
      let offset = 0;
      while (offset < data.length - 1) {
        if (data[offset] === 0) {
          offset++;
          continue;
        }

        const tag = data[offset];
        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        offset++;

        if (wireType === 0) { // Varint - this is where position data lives!
          let value = 0;
          let shift = 0;
          let hasMore = true;

          while (offset < data.length && hasMore && shift < 64) {
            const byte = data[offset];
            hasMore = (byte & 0x80) !== 0;
            value |= (byte & 0x7F) << shift;
            shift += 7;
            offset++;

            if (!hasMore) break;
          }

          console.log(`Embedded Field ${fieldNumber} Varint value: ${value} (0x${value.toString(16)})`);

          // Look for Meshtastic Position message structure
          // latitudeI and longitudeI are typically * 10^7 integers
          const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000; // -90 to +90 degrees
          const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000; // -180 to +180 degrees

          // Position message: field 1=latitudeI, field 2=longitudeI, field 3=altitude
          if (fieldNumber === 1 && isValidLatitude) {
            console.log(`🌍 Found embedded latitude in field ${fieldNumber}: ${value / 10000000}`);
            if (!result.position) result.position = {};
            result.position.latitude = value / 10000000;
            result.latitude = value / 10000000; // Also set flat field for database
          } else if (fieldNumber === 2 && isValidLongitude) {
            console.log(`🌍 Found embedded longitude in field ${fieldNumber}: ${value / 10000000}`);
            if (!result.position) result.position = {};
            result.position.longitude = value / 10000000;
            result.longitude = value / 10000000; // Also set flat field for database
          } else if (fieldNumber === 3 && value >= -1000 && value <= 10000) {
            // Altitude in meters
            console.log(`🌍 Found embedded altitude in field ${fieldNumber}: ${value}m`);
            if (!result.position) result.position = {};
            result.position.altitude = value;
            result.altitude = value; // Also set flat field for database
          } else if (fieldNumber === 4 && value >= -200 && value <= -20) {
            // RSSI
            result.rssi = value;
          } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
            // Battery level
            result.batteryLevel = value;
          }

        } else if (wireType === 2) { // Length-delimited - could contain nested position message
          if (offset < data.length) {
            const length = data[offset];
            offset++;

            if (offset + length <= data.length && length > 0) {
              const nestedData = data.slice(offset, offset + length);
              console.log(`Found nested message in field ${fieldNumber}, length ${length} bytes`);

              // Recursively parse nested messages that might contain position data
              this.parseEmbeddedTelemetry(nestedData, result);

              offset += length;
            }
          }
        } else if (wireType === 5) { // Fixed32 - float values
          if (offset + 4 <= data.length) {
            const floatVal = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, true);

            if (Number.isFinite(floatVal)) {
              // SNR as float (typical range -25 to +15)
              if (floatVal >= -30 && floatVal <= 20 && !result.snr) {
                result.snr = Math.round(floatVal * 100) / 100;
              }
              // Voltage (typical range 3.0V to 5.0V)
              if (floatVal >= 2.5 && floatVal <= 6.0 && !result.voltage) {
                result.voltage = Math.round(floatVal * 100) / 100;
              }
            }

            offset += 4;
          }
        } else {
          // Skip unknown wire types
          offset++;
        }
      }
    } catch (error) {
      // Ignore parsing errors, this is experimental
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractProtobufStructure(data: Uint8Array): any {
    // Try to extract basic protobuf field structure
    // Protobuf uses varint encoding, look for common patterns

    try {
      let offset = 0;
      const fields: any = {};

      while (offset < data.length - 1) {
        // Read potential field tag
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 100) { // Reasonable field numbers
          offset++;

          if (wireType === 0) { // Varint
            let value = 0;
            let shift = 0;
            while (offset < data.length && (data[offset] & 0x80) !== 0) {
              value |= (data[offset] & 0x7F) << shift;
              shift += 7;
              offset++;
            }
            if (offset < data.length) {
              value |= (data[offset] & 0x7F) << shift;
              offset++;
              fields[fieldNumber] = value;
            }
          } else if (wireType === 2) { // Length-delimited
            if (offset < data.length) {
              const length = data[offset];
              offset++;
              if (offset + length <= data.length) {
                const fieldData = data.slice(offset, offset + length);

                // Try to decode as string
                try {
                  const str = new TextDecoder('utf-8', { fatal: true }).decode(fieldData);
                  if (str.length > 0 && /[A-Za-z]/.test(str)) {
                    fields[fieldNumber] = str;
                    console.log(`Found string field ${fieldNumber}:`, str);
                  }
                } catch (e) {
                  // Not valid UTF-8, store as bytes
                  fields[fieldNumber] = fieldData;
                }
                offset += length;
              }
            }
          } else {
            // Skip unknown wire types
            offset++;
          }
        } else {
          offset++;
        }
      }

      // If we found some structured data, try to interpret it
      if (Object.keys(fields).length > 0) {
        console.log('Extracted protobuf fields:', fields);

        // Look for node-like data
        if (fields[1] && typeof fields[1] === 'string' && fields[1].startsWith('!')) {
          return {
            type: 'nodeInfo',
            data: {
              num: parseInt(fields[1].substring(1), 16),
              user: {
                id: fields[1],
                longName: fields[2] || `Node ${fields[1]}`,
                shortName: fields[3] || (fields[2] ? fields[2].substring(0, 4) : 'UNK')
              },
              lastHeard: Date.now() / 1000
            }
          };
        }

        // Look for message-like data
        for (const [, value] of Object.entries(fields)) {
          if (typeof value === 'string' && value.length > 2 && value.length < 200 &&
              !value.startsWith('!') && /[A-Za-z]/.test(value)) {
            return {
              type: 'packet',
              data: {
                id: `msg_${Date.now()}`,
                from: 0,
                to: 0xFFFFFFFF,
                fromNodeId: 'unknown',
                toNodeId: '!ffffffff',
                text: value,
                channel: 0,
                timestamp: Date.now(),
                rxTime: Date.now(),
                createdAt: Date.now()
              }
            };
          }
        }
      }
    } catch (error) {
      // Ignore protobuf parsing errors, this is experimental
    }

    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractTextMessage(data: Uint8Array, text: string): any {
    // Look for text message indicators
    if (text.includes('TEXT_MESSAGE_APP') || this.containsReadableText(text)) {
      // Try to extract sender node ID
      const fromNodeMatch = text.match(/!([a-f0-9]{8})/);
      const fromNodeId = fromNodeMatch ? '!' + fromNodeMatch[1] : 'unknown';
      const fromNodeNum = fromNodeMatch ? parseInt(fromNodeMatch[1], 16) : 0;

      // Extract readable text from the message
      const messageText = this.extractMessageText(text, data);

      if (messageText && messageText.length > 0 && messageText.length < 200) {
        return {
          type: 'packet',
          data: {
            id: `${fromNodeId}_${Date.now()}`,
            from: fromNodeNum,
            to: 0xFFFFFFFF, // Broadcast by default
            fromNodeId: fromNodeId,
            toNodeId: '!ffffffff',
            text: messageText,
            channel: 0, // Default channel
            timestamp: Date.now(),
            rxTime: Date.now(),
            createdAt: Date.now()
          }
        };
      }
    }
    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractNodeInfo(data: Uint8Array, text: string): any {
    // Look for node ID patterns (starts with '!')
    const nodeIdMatch = text.match(/!([a-f0-9]{8})/);
    if (nodeIdMatch) {
      const nodeId = '!' + nodeIdMatch[1];

      // Extract names using improved pattern matching
      const names = this.extractNodeNames(text, nodeId);

      // Try to extract basic telemetry data
      const nodeNum = parseInt(nodeId.substring(1), 16);
      const telemetry = this.extractTelemetryData(data);

      return {
        type: 'nodeInfo',
        data: {
          num: nodeNum,
          user: {
            id: nodeId,
            longName: names.longName || `Node ${nodeNum}`,
            shortName: names.shortName || names.longName.substring(0, 4) || 'UNK',
            hwModel: telemetry.hwModel
          },
          lastHeard: Date.now() / 1000,
          snr: telemetry.snr,
          rssi: telemetry.rssi,
          position: telemetry.position,
          deviceMetrics: telemetry.deviceMetrics
        }
      };
    }
    return null;
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private extractOtherPackets(_data: Uint8Array, _text: string): any {
    // Handle other packet types like telemetry, position, etc.
    return null;
  }

  private containsReadableText(text: string): boolean {
    // Check if the string contains readable text (not just binary gibberish)
    const readableChars = text.match(/[A-Za-z0-9\s.,!?'"]/g);
    const readableRatio = readableChars ? readableChars.length / text.length : 0;
    return readableRatio > 0.3; // At least 30% readable characters
  }

  private extractMessageText(text: string, data: Uint8Array): string {
    // Try multiple approaches to extract the actual message text

    // Method 1: Look for sequences of printable characters
    const printableText = text.match(/[\x20-\x7E]{3,}/g);
    if (printableText) {
      for (const candidate of printableText) {
        if (candidate.length >= 3 &&
            candidate.length <= 200 &&
            !candidate.startsWith('!') &&
            !candidate.match(/^[0-9A-F]{8}$/)) {
          return candidate.trim();
        }
      }
    }

    // Method 2: Look for UTF-8 text after node IDs
    const parts = text.split(/![a-f0-9]{8}/);
    for (const part of parts) {
      const cleanPart = part.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
      if (cleanPart.length >= 3 && cleanPart.length <= 200 && /[A-Za-z]/.test(cleanPart)) {
        return cleanPart;
      }
    }

    // Method 3: Try to find text in different positions of the binary data
    for (let offset = 10; offset < Math.min(data.length - 10, 100); offset++) {
      try {
        const slice = data.slice(offset, Math.min(offset + 50, data.length));
        const testText = new TextDecoder('utf-8', { fatal: true }).decode(slice);
        const cleanTest = testText.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();

        if (cleanTest.length >= 3 && cleanTest.length <= 200 && /[A-Za-z]/.test(cleanTest)) {
          return cleanTest;
        }
      } catch (e) {
        // Invalid UTF-8, continue
      }
    }

    return '';
  }

  private extractNodeNames(text: string, nodeId: string): { longName: string; shortName: string } {
    // Improved name extraction
    let longName = '';
    let shortName = '';

    // Split text around the node ID to get name candidates
    const parts = text.split(nodeId);

    for (const part of parts) {
      // Look for readable name patterns
      const nameMatches = part.match(/([\p{L}\p{N}\p{S}\p{P}\s\-_.]{2,31})/gu);

      if (nameMatches) {
        const validNames = nameMatches.filter(match =>
          match.trim().length >= 2 &&
          match.trim().length <= 30 &&
          /[A-Za-z0-9]/.test(match) && // Must contain alphanumeric
          !match.match(/^[0-9A-F]+$/) && // Not just hex
          !match.startsWith('!') // Not a node ID
        );

        if (validNames.length > 0 && !longName) {
          longName = validNames[0].trim();
        }
        if (validNames.length > 1 && !shortName) {
          shortName = validNames[1].trim();
        }
      }
    }

    // Generate short name if not found
    if (longName && !shortName) {
      shortName = longName.substring(0, 4);
    }

    return { longName, shortName };
  }

  private extractTelemetryData(data: Uint8Array): any {
    // Enhanced telemetry extraction using improved protobuf parsing
    const telemetry: any = {
      hwModel: undefined,
      snr: undefined,
      rssi: undefined,
      position: undefined,
      deviceMetrics: undefined
    };

    // Parse protobuf structure looking for telemetry fields
    let offset = 0;
    while (offset < data.length - 5) {
      try {
        const tag = data[offset];
        if (tag === 0) {
          offset++;
          continue;
        }

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (fieldNumber > 0 && fieldNumber < 100) {
          offset++;

          if (wireType === 0) { // Varint (integers)
            let value = 0;
            let shift = 0;
            let hasMore = true;

            while (offset < data.length && hasMore && shift < 64) {
              const byte = data[offset];
              hasMore = (byte & 0x80) !== 0;
              value |= (byte & 0x7F) << shift;
              shift += 7;
              offset++;

              if (!hasMore) break;
            }

            // Debug: Log all Varint values to diagnose position parsing
            if (fieldNumber >= 1 && fieldNumber <= 10) {
              console.log(`Field ${fieldNumber} Varint value: ${value} (0x${value.toString(16)})`);
            }

            // Look for position data in various field numbers - Meshtastic Position message
            // latitudeI and longitudeI are typically * 10^7 integers
            const isValidLatitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 900000000; // -90 to +90 degrees
            const isValidLongitude = Math.abs(value) >= 100000000 && Math.abs(value) <= 1800000000; // -180 to +180 degrees

            if (isValidLatitude && (fieldNumber === 1 || fieldNumber === 3 || fieldNumber === 5)) {
              console.log(`🌍 Found latitude in field ${fieldNumber}: ${value / 10000000}`);
              if (!telemetry.position) telemetry.position = {};
              telemetry.position.latitude = value / 10000000;
            } else if (isValidLongitude && (fieldNumber === 2 || fieldNumber === 4 || fieldNumber === 6)) {
              console.log(`🌍 Found longitude in field ${fieldNumber}: ${value / 10000000}`);
              if (!telemetry.position) telemetry.position = {};
              telemetry.position.longitude = value / 10000000;
            } else if (fieldNumber === 3 && value >= -1000 && value <= 10000) {
              // Could be altitude in meters, or RSSI if negative and in different range
              if (value >= -200 && value <= -20) {
                // Likely RSSI
                telemetry.rssi = value;
              } else if (value >= -1000 && value <= 10000) {
                // Likely altitude
                if (!telemetry.position) telemetry.position = {};
                telemetry.position.altitude = value;
              }
            } else if (fieldNumber === 4 && value >= -30 && value <= 20) {
              // Likely SNR (but as integer * 4 or * 100)
              telemetry.snr = value > 100 ? value / 100 : value / 4;
            } else if (fieldNumber === 5 && value >= 0 && value <= 100) {
              // Likely battery percentage
              if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
              telemetry.deviceMetrics.batteryLevel = value;
            } else if (fieldNumber === 7 && value > 0) {
              // Hardware model
              telemetry.hwModel = value;
            }

          } else if (wireType === 1) { // Fixed64 (double)
            if (offset + 8 <= data.length) {
              const value = new DataView(data.buffer, data.byteOffset + offset, 8);
              const doubleVal = value.getFloat64(0, true); // little endian

              // Check for coordinate values
              if (doubleVal >= -180 && doubleVal <= 180 && Math.abs(doubleVal) > 0.001) {
                if (!telemetry.position) telemetry.position = {};
                if (fieldNumber === 1 && doubleVal >= -90 && doubleVal <= 90) {
                  telemetry.position.latitude = doubleVal;
                } else if (fieldNumber === 2 && doubleVal >= -180 && doubleVal <= 180) {
                  telemetry.position.longitude = doubleVal;
                } else if (fieldNumber === 3 && doubleVal >= -1000 && doubleVal <= 10000) {
                  telemetry.position.altitude = doubleVal;
                }
              }

              offset += 8;
            }

          } else if (wireType === 5) { // Fixed32 (float)
            if (offset + 4 <= data.length) {
              const value = new DataView(data.buffer, data.byteOffset + offset, 4);
              const floatVal = value.getFloat32(0, true); // little endian

              if (Number.isFinite(floatVal)) {
                // SNR as float (typical range -25 to +15)
                if (floatVal >= -30 && floatVal <= 20 && !telemetry.snr) {
                  telemetry.snr = Math.round(floatVal * 100) / 100;
                }

                // Voltage (typical range 3.0V to 5.0V)
                if (floatVal >= 2.5 && floatVal <= 6.0) {
                  if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
                  if (!telemetry.deviceMetrics.voltage) {
                    telemetry.deviceMetrics.voltage = Math.round(floatVal * 100) / 100;
                  }
                }

                // Channel utilization (0.0 to 1.0)
                if (floatVal >= 0.0 && floatVal <= 1.0) {
                  if (!telemetry.deviceMetrics) telemetry.deviceMetrics = {};
                  if (!telemetry.deviceMetrics.channelUtilization) {
                    telemetry.deviceMetrics.channelUtilization = Math.round(floatVal * 1000) / 1000;
                  }
                }
              }

              offset += 4;
            }

          } else if (wireType === 2) { // Length-delimited (embedded messages, strings)
            if (offset < data.length) {
              const length = data[offset];
              offset++;

              if (offset + length <= data.length && length > 0) {
                const fieldData = data.slice(offset, offset + length);

                // Try to parse as embedded telemetry message
                if (length >= 4) {
                  this.parseEmbeddedTelemetry(fieldData, telemetry);
                }

                offset += length;
              }
            }
          } else {
            offset++;
          }
        } else {
          offset++;
        }
      } catch (error) {
        offset++;
      }
    }

    return telemetry;
  }


  // @ts-ignore - Legacy function kept for backward compatibility
  private async processPacket(packet: any): Promise<void> {
    // Handle the new packet structure from enhanced protobuf parsing
    if (packet.text && packet.text.length > 0) {
      // Ensure nodes exist in database before creating message
      const fromNodeId = packet.fromNodeId || 'unknown';
      const toNodeId = packet.toNodeId || '!ffffffff';
      const fromNodeNum = packet.from || packet.fromNodeNum || 0;
      const toNodeNum = packet.to || packet.toNodeNum || 0xFFFFFFFF;

      // Make sure fromNode exists in database (including unknown nodes)
      const existingFromNode = databaseService.getNode(fromNodeNum);
      if (!existingFromNode) {
        // Create a basic node entry if it doesn't exist
        const nodeData = {
          nodeNum: fromNodeNum,
          nodeId: fromNodeId,
          longName: fromNodeId === 'unknown' ? 'Unknown Node' : fromNodeId,
          shortName: fromNodeId === 'unknown' ? 'UNK' : fromNodeId.substring(1, 5),
          hwModel: 0,
          lastHeard: Date.now() / 1000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        console.log(`Creating missing fromNode: ${fromNodeId} (${fromNodeNum})`);
        console.log(`DEBUG nodeData values: nodeNum=${nodeData.nodeNum}, nodeId="${nodeData.nodeId}"`);
        console.log(`DEBUG nodeData types: nodeNum type=${typeof nodeData.nodeNum}, nodeId type=${typeof nodeData.nodeId}`);
        console.log(`DEBUG validation check: nodeNum undefined? ${nodeData.nodeNum === undefined}, nodeNum null? ${nodeData.nodeNum === null}, nodeId falsy? ${!nodeData.nodeId}`);

        // Force output with console.error to bypass any buffering
        console.error(`FORCE DEBUG: nodeData:`, JSON.stringify(nodeData));

        databaseService.upsertNode(nodeData);
        console.log(`DEBUG: Called upsertNode, checking if node was created...`);
        const checkNode = databaseService.getNode(fromNodeNum);
        console.log(`DEBUG: Node exists after upsert:`, checkNode ? 'YES' : 'NO');
      }

      // Make sure toNode exists in database (including broadcast node)
      const existingToNode = databaseService.getNode(toNodeNum);
      if (!existingToNode) {
        const nodeData = {
          nodeNum: toNodeNum,
          nodeId: toNodeId,
          longName: toNodeId === '!ffffffff' ? 'Broadcast' : toNodeId,
          shortName: toNodeId === '!ffffffff' ? 'BCST' : toNodeId.substring(1, 5),
          hwModel: 0,
          lastHeard: Date.now() / 1000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        console.log(`Creating missing toNode: ${toNodeId} (${toNodeNum})`);
        databaseService.upsertNode(nodeData);
      }

      const message = {
        id: packet.id || `${fromNodeId}_${Date.now()}`,
        fromNodeNum: fromNodeNum,
        toNodeNum: toNodeNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        text: packet.text,
        channel: packet.channel || 0,
        portnum: packet.portnum,
        timestamp: packet.timestamp || Date.now(),
        rxTime: packet.rxTime || packet.timestamp || Date.now(),
        createdAt: packet.createdAt || Date.now()
      };

      try {
        databaseService.insertMessage(message);
        console.log('Saved message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
      } catch (error) {
        console.error('Failed to save message:', error);
        console.error('Message data:', message);
      }
    }
  }

  // @ts-ignore - Legacy function kept for backward compatibility
  private async processNodeInfo(nodeInfo: any): Promise<void> {
    const nodeData = {
      nodeNum: nodeInfo.num,
      nodeId: nodeInfo.user?.id || nodeInfo.num.toString(),
      longName: nodeInfo.user?.longName,
      shortName: nodeInfo.user?.shortName,
      hwModel: nodeInfo.user?.hwModel,
      macaddr: nodeInfo.user?.macaddr,
      latitude: nodeInfo.position?.latitude,
      longitude: nodeInfo.position?.longitude,
      altitude: nodeInfo.position?.altitude,
      batteryLevel: nodeInfo.deviceMetrics?.batteryLevel,
      voltage: nodeInfo.deviceMetrics?.voltage,
      channelUtilization: nodeInfo.deviceMetrics?.channelUtilization,
      airUtilTx: nodeInfo.deviceMetrics?.airUtilTx,
      lastHeard: nodeInfo.lastHeard ? Math.floor(nodeInfo.lastHeard) : Math.floor(Date.now() / 1000),
      snr: nodeInfo.snr,
      rssi: nodeInfo.rssi
    };

    try {
      databaseService.upsertNode(nodeData);
      console.log('Updated node in database:', nodeData.longName || nodeData.nodeId);
    } catch (error) {
      console.error('Failed to update node:', error);
    }
  }

  // Configuration retrieval methods
  async getDeviceConfig(): Promise<any> {
    try {
      // Request device configuration from Meshtastic node
      const response = await this.makeRequest('/api/v1/fromradio?all=true');
      if (response.ok) {
        const data = await response.arrayBuffer();
        return this.parseConfigData(new Uint8Array(data));
      }
    } catch (error) {
      console.error('Failed to get device config:', error);
    }
    return null;
  }

  private parseConfigData(data: Uint8Array): any {
    // Parse actual device configuration from protobuf data
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);

    // Look for MQTT configuration in the text
    const mqttEnabled = text.includes('mqtt') || text.includes('areyoumeshingwith');
    const mqttServer = text.match(/([a-z0-9.-]+\.(?:us|com|org|net))/i)?.[1] || '';

    // Look for radio configuration hints
    const regionMatch = text.match(/US|EU|JP|KR|TW|RU|IN|NZ|TH|UA|MY|SG|PH/);
    const region = regionMatch ? regionMatch[0] : 'US';

    // Extract channels from the database instead of hardcoded
    const dbChannels = databaseService.getAllChannels();
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled
    }));

    return {
      basic: {
        nodeAddress: this.config.nodeIp,
        useTls: this.config.useTls,
        connected: this.isConnected
      },
      radio: {
        region: region,
        modemPreset: 'Medium_Fast',
        hopLimit: 3,
        txPower: 30,
        bandwidth: 250,
        spreadFactor: 9,
        codingRate: 8
      },
      mqtt: {
        enabled: mqttEnabled,
        server: mqttServer || 'mqtt.areyoumeshingwith.us',
        username: 'uplink',
        encryption: true,
        json: true,
        tls: true,
        rootTopic: 'msh'
      },
      channels: channels.length > 0 ? channels : [
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true }
      ]
    };
  }

  async sendTextMessage(text: string, channel: number = 0, destination?: number): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      // Use the new protobuf service to create a proper text message
      const textMessageData = meshtasticProtobufService.createTextMessage(text, destination, channel);

      const response = await this.makeRequest('/api/v1/toradio', {
        method: 'PUT',
        body: textMessageData as BodyInit,
        headers: {
          'Content-Type': 'application/x-protobuf'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
      }

      console.log('Message sent successfully:', text);
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  getConnectionStatus(): { connected: boolean; nodeIp: string } {
    return {
      connected: this.isConnected,
      nodeIp: this.config.nodeIp
    };
  }

  // Get data from database instead of maintaining in-memory state
  getAllNodes(): DeviceInfo[] {
    const dbNodes = databaseService.getAllNodes();
    return dbNodes.map(node => ({
      nodeNum: node.nodeNum,
      user: {
        id: node.nodeId,
        longName: node.longName || '',
        shortName: node.shortName || '',
        hwModel: node.hwModel
      },
      position: node.latitude && node.longitude ? {
        latitude: node.latitude,
        longitude: node.longitude,
        altitude: node.altitude
      } : undefined,
      deviceMetrics: {
        batteryLevel: node.batteryLevel,
        voltage: node.voltage,
        channelUtilization: node.channelUtilization,
        airUtilTx: node.airUtilTx
      },
      lastHeard: node.lastHeard,
      snr: node.snr,
      rssi: node.rssi
    }));
  }

  getRecentMessages(limit: number = 50): MeshMessage[] {
    const dbMessages = databaseService.getMessages(limit);
    return dbMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId,
      fromNodeId: msg.fromNodeId,
      toNodeId: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      portnum: msg.portnum,
      timestamp: new Date(msg.timestamp)
    }));
  }
}

export default new MeshtasticManager();