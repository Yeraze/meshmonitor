import databaseService from '../services/database.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService from './protobufService.js';

export interface MeshtasticConfig {
  nodeIp: string;
  nodePort?: number;
  basePath?: string;
  useTls: boolean;
}

export interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    role?: string;
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
  hopsAway?: number;
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
  private tracerouteInterval: NodeJS.Timeout | null = null;
  private tracerouteIntervalMinutes: number = 3;
  private localNodeInfo: {
    nodeNum: number;
    nodeId: string;
    longName: string;
    shortName: string;
    firmwareVersion?: string;
    isLocked?: boolean;  // Flag to prevent overwrites after initial setup
  } | null = null;
  private actualDeviceConfig: any = null;  // Store actual device config
  private actualModuleConfig: any = null;  // Store actual module config

  constructor() {
    this.config = {
      nodeIp: process.env.MESHTASTIC_NODE_IP || '192.168.1.100',
      nodePort: process.env.MESHTASTIC_PORT ? parseInt(process.env.MESHTASTIC_PORT, 10) : undefined,
      basePath: process.env.MESHTASTIC_BASE_PATH || '',
      useTls: process.env.MESHTASTIC_USE_TLS === 'true'
    };
  }

  private getBaseUrl(): string {
    const protocol = this.config.useTls ? 'https' : 'http';
    const host = this.config.nodeIp;
    const port = this.config.nodePort ? `:${this.config.nodePort}` : '';
    const basePath = this.config.basePath || '';
    return `${protocol}://${host}${port}${basePath}`;
  }

  private getNodeAddress(): string {
    const host = this.config.nodeIp;
    const port = this.config.nodePort ? `:${this.config.nodePort}` : '';
    const basePath = this.config.basePath || '';
    return `${host}${port}${basePath}`;
  }

  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.getBaseUrl()}${endpoint}`;

    try {
      const response = await fetch(url, options);

      // Debug logging for problematic responses
      if (!response.ok) {
        if (response.status === 400) {
          console.error(`❌ HTTP 400 Bad Request for: ${url}`);
          console.error(`   Method: ${options.method || 'GET'}`);
          console.error(`   Endpoint: ${endpoint}`);
          console.error(`   Full URL: ${url}`);
        }
      } else if (endpoint.includes('/api/v1/fromradio')) {
        // Log Content-Type for fromradio endpoints to help debug encoding issues
        const contentType = response.headers.get('content-type');
        const contentEncoding = response.headers.get('content-encoding');
        const contentLength = response.headers.get('content-length');
        console.log(`📡 Response headers for ${endpoint}:`);
        console.log(`   Content-Type: ${contentType || 'not specified'}`);
        console.log(`   Content-Encoding: ${contentEncoding || 'none'}`);
        console.log(`   Content-Length: ${contentLength || 'unknown'}`);
      }

      return response;
    } catch (error) {
      console.error(`Meshtastic API request failed (${endpoint}):`, error);
      throw error;
    }
  }

  async connect(): Promise<boolean> {
    try {
      console.log(`Connecting to Meshtastic node at ${this.getBaseUrl()}...`);

      // Initialize protobuf service first
      await meshtasticProtobufService.initialize();

      // Test connection with a simple HTTP request (don't read fromradio yet)
      const response = await this.makeRequest('/hotspot-detect.html');
      if (response.status === 200 || response.status === 404) {
        this.isConnected = true;
        console.log('Connected to Meshtastic node successfully');

        // Send want_config_id to request full node DB and config
        // IMPORTANT: Do this BEFORE starting polling so we don't consume the queue
        await this.requestFullConfiguration();

        // Start polling for updates AFTER configuration is complete
        this.startPolling();

        // Start automatic traceroute scheduler
        this.startTracerouteScheduler();

        // Ensure we have a Primary channel
        console.log('➡️ About to call ensurePrimaryChannel()...');
        this.ensurePrimaryChannel();
        console.log('✅ ensurePrimaryChannel() completed');

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

      // Send want_config_id to trigger device configuration transfer
      await this.sendWantConfigId();

      // Small delay to allow device to populate the fromradio queue
      // The device needs a moment to prepare all configuration data
      // Testing shows 2-5 seconds is typically needed
      console.log('⏳ Waiting 5 seconds for device to prepare configuration...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      console.log('📡 Beginning continuous read from device...');

      // Continuous reading loop using ?all=false (like official Meshtastic web UI)
      // Each request returns ONE FromRadio message at a time
      let totalBytes = 0;
      let iterationCount = 0;
      const maxIterations = 100; // Safety limit (official UI makes ~11 requests)
      let consecutiveEmptyCount = 0;
      const maxConsecutiveEmpty = 3; // Stop after 3 consecutive empty responses

      while (iterationCount < maxIterations) {
        iterationCount++;
        console.log(`📡 Read iteration ${iterationCount}...`);

        try {
          // Use ?all=false to get one message at a time (official UI approach)
          const response = await this.makeRequest('/api/v1/fromradio?all=false');

          if (response.ok) {
            const data = await response.arrayBuffer();
            const messageData = new Uint8Array(data);

            console.log(`📊 Received ${messageData.byteLength} bytes`);

            if (messageData.byteLength > 0) {
              // Log first 32 bytes to help identify data format
              const preview = messageData.slice(0, Math.min(32, messageData.byteLength));
              const hexPreview = Array.from(preview).map(b => b.toString(16).padStart(2, '0')).join(' ');
              const asciiPreview = Array.from(preview).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
              console.log(`📊 First ${preview.length} bytes (hex): ${hexPreview}`);
              console.log(`📊 First ${preview.length} bytes (ascii): ${asciiPreview}`);

              totalBytes += messageData.byteLength;
              consecutiveEmptyCount = 0; // Reset counter on data received

              // Process single FromRadio message
              await this.processIncomingData(messageData);

              // Log current status
              const currentNodes = databaseService.getNodeCount();
              const currentChannels = databaseService.getChannelCount();
              console.log(`📈 Current state: ${currentNodes} nodes, ${currentChannels} channels`);
            } else {
              consecutiveEmptyCount++;
              console.log(`📭 Device queue empty (${consecutiveEmptyCount}/${maxConsecutiveEmpty})`);

              // Continue polling a few more times even when queue appears empty
              // MyNodeInfo and other config data may arrive shortly after initial queue drain
              if (consecutiveEmptyCount >= maxConsecutiveEmpty) {
                console.log('✅ Device queue empty, configuration transfer complete');
                break;
              }
            }
          } else {
            console.warn(`⚠️ Request failed with status ${response.status}`);
            break;
          }
        } catch (readError) {
          console.error('❌ Error during read iteration:', readError);
          break;
        }

        // Small delay between reads to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (iterationCount >= maxIterations) {
        console.warn(`⚠️ Reached maximum iteration limit (${maxIterations})`);
      }

      console.log(`📊 Configuration transfer complete: ${totalBytes} total bytes in ${iterationCount} iterations`);

      // Check if we received meaningful data
      const finalNodeCount = databaseService.getNodeCount();
      const finalChannelCount = databaseService.getChannelCount();

      if (finalNodeCount === 0 || finalChannelCount === 0) {
        console.log('⚠️ Limited data received, trying fallback approaches...');
        await this.tryFallbackDataSources();
      }

      console.log(`✅ Configuration complete: ${finalNodeCount} nodes, ${finalChannelCount} channels`);

      // If localNodeInfo wasn't set during configuration (device didn't send MyNodeInfo),
      // initialize it from database
      if (!this.localNodeInfo) {
        await this.initializeLocalNodeInfoFromDatabase();
      }

    } catch (error) {
      console.error('❌ Failed to request full configuration:', error);
      // Even if configuration fails, ensure we have basic setup
      this.ensureBasicSetup();
    }
  }

  private async tryFallbackDataSources(): Promise<void> {
    // Fallback 1: Try JSON endpoint for device info
    try {
      console.log('📱 Trying JSON /json/info endpoint...');
      const nodeInfoResponse = await this.makeRequest('/json/info');
      if (nodeInfoResponse.ok) {
        const nodeInfo = await nodeInfoResponse.json();
        console.log('📱 Device info received:', nodeInfo);

        if (nodeInfo.num && nodeInfo.user) {
          const nodeData = {
            nodeNum: nodeInfo.num,
            nodeId: nodeInfo.user.id,
            longName: nodeInfo.user.longName || 'Connected Node',
            shortName: nodeInfo.user.shortName || nodeInfo.user.id?.substring(1, 5) || 'NODE',
            hwModel: nodeInfo.user.hwModel || 0,
            role: nodeInfo.user.role,
            hopsAway: nodeInfo.hopsAway,
            lastHeard: Date.now() / 1000,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          databaseService.upsertNode(nodeData);
          console.log('✅ Created local node from JSON');
        }
      }
    } catch (error) {
      console.log('⚠️ Could not fetch /json/info:', error);
    }

    // Fallback 2: Try JSON endpoint for node database
    try {
      console.log('🏠 Trying JSON /json/nodes endpoint...');
      const nodesResponse = await this.makeRequest('/json/nodes');
      if (nodesResponse.ok) {
        const nodesData = await nodesResponse.json();

        if (Array.isArray(nodesData) && nodesData.length > 0) {
          console.log(`🏠 Found ${nodesData.length} nodes in JSON data`);

          for (const node of nodesData) {
            if (node.num && node.user?.id) {
              const nodeData = {
                nodeNum: node.num,
                nodeId: node.user.id,
                longName: node.user.longName || `Node ${node.user.id}`,
                shortName: node.user.shortName || node.user.id?.substring(1, 5) || 'UNK',
                hwModel: node.user.hwModel || 0,
                role: node.user.role,
                hopsAway: node.hopsAway,
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
              databaseService.upsertNode(nodeData);
            }
          }
          console.log('✅ Imported nodes from JSON');
        }
      }
    } catch (error) {
      console.log('⚠️ Could not fetch /json/nodes:', error);
    }

    // Fallback 3: Ensure basic channel setup
    const channelCount = databaseService.getChannelCount();
    if (channelCount === 0) {
      console.log('📡 No channels found, creating default Primary channel...');
      this.createDefaultChannels();
    }
  }

  private createDefaultChannels(): void {
    console.log('📡 Creating default channel configuration...');

    // Create default channel with ID 0 for messages that use channel 0
    // This is Meshtastic's default channel when no specific channel is configured
    try {
      const existingChannel0 = databaseService.getChannelById(0);
      if (!existingChannel0) {
        // Manually insert channel with ID 0 since it might not come from device
        const stmt = databaseService.db.prepare(`
          INSERT OR REPLACE INTO channels (id, name, createdAt, updatedAt)
          VALUES (0, 'Primary', ?, ?)
        `);
        const now = Date.now();
        stmt.run(now, now);
        console.log('📡 Created Primary channel with ID 0');
      }
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
    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
      this.tracerouteInterval = null;
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

        // Note: Removed periodic sendWantConfigId() calls as they trigger full
        // config dumps from the node, blocking normal mesh traffic. The node
        // will naturally send nodeInfo updates as they occur on the mesh.
        pollCount++;
      }
    }, 2000);
  }

  private startTracerouteScheduler(): void {
    if (this.tracerouteInterval) {
      clearInterval(this.tracerouteInterval);
    }

    const intervalMs = this.tracerouteIntervalMinutes * 60 * 1000;
    console.log(`🗺️ Starting traceroute scheduler with ${this.tracerouteIntervalMinutes} minute interval`);

    this.tracerouteInterval = setInterval(async () => {
      if (this.isConnected && this.localNodeInfo) {
        try {
          const targetNode = databaseService.getNodeNeedingTraceroute(this.localNodeInfo.nodeNum);
          if (targetNode) {
            console.log(`🗺️ Auto-traceroute: Sending traceroute to ${targetNode.longName || targetNode.nodeId} (${targetNode.nodeId})`);
            await this.sendTraceroute(targetNode.nodeNum, 0);
          } else {
            console.log('🗺️ Auto-traceroute: No nodes available for traceroute');
          }
        } catch (error) {
          console.error('❌ Error in auto-traceroute:', error);
        }
      }
    }, intervalMs);
  }

  setTracerouteInterval(minutes: number): void {
    if (minutes < 1 || minutes > 60) {
      throw new Error('Traceroute interval must be between 1 and 60 minutes');
    }
    this.tracerouteIntervalMinutes = minutes;
    console.log(`🗺️ Traceroute interval updated to ${minutes} minutes`);

    if (this.isConnected) {
      this.startTracerouteScheduler();
    }
  }

  private async pollForUpdates(): Promise<void> {
    try {
      // Use ?all=false to get one message at a time (official UI approach)
      const response = await this.makeRequest('/api/v1/fromradio?all=false');
      if (!response.ok) {
        console.warn('Failed to poll for updates:', response.status);
        return;
      }

      const data = await response.arrayBuffer();
      if (data.byteLength > 0) {
        console.log(`Received ${data.byteLength} bytes from Meshtastic node`);

        const uint8Array = new Uint8Array(data);
        await this.processIncomingData(uint8Array);
      }
    } catch (error) {
      console.error('Error polling for updates:', error);
    }
  }

  private async processIncomingData(data: Uint8Array): Promise<void> {
    try {
      if (data.length === 0) {
        return;
      }

      console.log(`📦 Processing single FromRadio message (${data.length} bytes)...`);

      // Parse single message (using ?all=false approach)
      const parsed = meshtasticProtobufService.parseIncomingData(data);

      if (!parsed) {
        console.warn('⚠️ Failed to parse message');
        return;
      }

      console.log(`📦 Parsed message type: ${parsed.type}`);

      // Process the message
      switch (parsed.type) {
        case 'fromRadio':
          console.log('⚠️ Generic FromRadio message (no specific field set)');
          break;
        case 'meshPacket':
          await this.processMeshPacket(parsed.data);
          break;
        case 'myInfo':
          await this.processMyNodeInfo(parsed.data);
          break;
        case 'nodeInfo':
          await this.processNodeInfoProtobuf(parsed.data);
          break;
        case 'metadata':
          await this.processDeviceMetadata(parsed.data);
          break;
        case 'config':
          console.log('⚙️ Received Config:', JSON.stringify(parsed.data, null, 2));
          // Merge the actual device configuration (don't overwrite)
          this.actualDeviceConfig = { ...this.actualDeviceConfig, ...parsed.data };
          console.log('📊 Merged actualDeviceConfig now has:', Object.keys(this.actualDeviceConfig));
          break;
        case 'moduleConfig':
          console.log('⚙️ Received Module Config:', JSON.stringify(parsed.data, null, 2));
          // Merge the actual module configuration (don't overwrite)
          this.actualModuleConfig = { ...this.actualModuleConfig, ...parsed.data };
          break;
        case 'channel':
          await this.processChannelProtobuf(parsed.data);
          break;
        case 'configComplete':
          console.log('✅ Config complete received, ID:', parsed.data.configCompleteId);
          break;
      }

      console.log(`✅ Processed message type: ${parsed.type}`);
    } catch (error) {
      console.error('❌ Error processing incoming data:', error);
    }
  }


  /**
   * Process MyNodeInfo protobuf message
   */
  /**
   * Decode Meshtastic minAppVersion to version string
   * Format is Mmmss where M = 1 + major version
   * Example: 30200 = 2.2.0 (M=3 -> major=2, mm=02, ss=00)
   */
  private decodeMinAppVersion(minAppVersion: number): string {
    const versionStr = minAppVersion.toString().padStart(5, '0');
    const major = parseInt(versionStr[0]) - 1;
    const minor = parseInt(versionStr.substring(1, 3));
    const patch = parseInt(versionStr.substring(3, 5));
    return `${major}.${minor}.${patch}`;
  }

  /**
   * Initialize localNodeInfo from database when MyNodeInfo wasn't received
   */
  private async initializeLocalNodeInfoFromDatabase(): Promise<void> {
    try {
      console.log('📱 Checking for local node info in database...');

      // Try to load previously saved local node info from settings
      const savedNodeNum = databaseService.getSetting('localNodeNum');
      const savedNodeId = databaseService.getSetting('localNodeId');

      if (savedNodeNum && savedNodeId) {
        const nodeNum = parseInt(savedNodeNum);
        console.log(`📱 Found saved local node info: ${savedNodeId} (${nodeNum})`);

        // Try to get full node info from database
        const node = databaseService.getNode(nodeNum);
        if (node) {
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: savedNodeId,
            longName: node.longName || 'Unknown',
            shortName: node.shortName || 'UNK',
            hwModel: node.hwModel || undefined,
            isLocked: false // Allow updates if MyNodeInfo arrives later
          } as any;
          console.log(`✅ Restored local node info from settings: ${savedNodeId}`);
        } else {
          // Create minimal local node info
          this.localNodeInfo = {
            nodeNum: nodeNum,
            nodeId: savedNodeId,
            longName: 'Unknown',
            shortName: 'UNK',
            isLocked: false
          } as any;
          console.log(`✅ Restored minimal local node info from settings: ${savedNodeId}`);
        }
      } else {
        console.log('⚠️ No MyNodeInfo received yet, waiting for device to send local node identification');
      }
    } catch (error) {
      console.error('❌ Failed to check local node info:', error);
    }
  }

  private async processMyNodeInfo(myNodeInfo: any): Promise<void> {
    console.log('📱 Processing MyNodeInfo for local device');
    console.log('📱 MyNodeInfo contents:', JSON.stringify(myNodeInfo, null, 2));

    // If we already have locked local node info, don't overwrite it
    if (this.localNodeInfo?.isLocked) {
      console.log('📱 Local node info already locked, skipping update');
      return;
    }

    // Log minAppVersion for debugging but don't use it as firmware version
    if (myNodeInfo.minAppVersion) {
      const minVersion = `v${this.decodeMinAppVersion(myNodeInfo.minAppVersion)}`;
      console.log(`📱 Minimum app version required: ${minVersion}`);
    }

    const nodeNum = Number(myNodeInfo.myNodeNum);
    const nodeId = `!${myNodeInfo.myNodeNum.toString(16).padStart(8, '0')}`;

    // Save local node info to settings for persistence
    databaseService.setSetting('localNodeNum', nodeNum.toString());
    databaseService.setSetting('localNodeId', nodeId);
    console.log(`💾 Saved local node info to settings: ${nodeId} (${nodeNum})`);

    // Check if we already have this node with actual names in the database
    const existingNode = databaseService.getNode(nodeNum);

    if (existingNode && existingNode.longName && existingNode.longName !== 'Local Device') {
      // We already have real node info, use it and lock it
      this.localNodeInfo = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        longName: existingNode.longName,
        shortName: existingNode.shortName || 'LOCAL',
        firmwareVersion: (existingNode as any).firmwareVersion || null,
        isLocked: true  // Lock it to prevent overwrites
      } as any;
      console.log(`📱 Using existing node info for local device: ${existingNode.longName} (${nodeId}) - LOCKED`);
    } else {
      // We don't have real node info yet, store basic info and wait for NodeInfo
      const nodeData = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        hwModel: myNodeInfo.hwModel || 0,
        lastHeard: Date.now() / 1000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      // Store minimal local node info - actual names will come from NodeInfo
      this.localNodeInfo = {
        nodeNum: nodeNum,
        nodeId: nodeId,
        longName: null,  // Will be set when NodeInfo is received
        shortName: null,  // Will be set when NodeInfo is received
        firmwareVersion: null, // Will be set when DeviceMetadata is received
        isLocked: false  // Not locked yet, waiting for complete info
      } as any;

      databaseService.upsertNode(nodeData);
      console.log(`📱 Stored basic local node info, waiting for NodeInfo for names (${nodeId})`);
    }
  }

  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string } | null {
    return this.localNodeInfo;
  }

  /**
   * Process DeviceMetadata protobuf message
   */
  private async processDeviceMetadata(metadata: any): Promise<void> {
    console.log('📱 Processing DeviceMetadata:', JSON.stringify(metadata, null, 2));
    console.log('📱 Firmware version:', metadata.firmwareVersion);

    // Update local node info with firmware version (always allowed, even if locked)
    if (this.localNodeInfo && metadata.firmwareVersion) {
      // Only update firmware version, don't touch other fields
      this.localNodeInfo.firmwareVersion = metadata.firmwareVersion;
      console.log(`📱 Updated firmware version: ${metadata.firmwareVersion}`);

      // Update the database with the firmware version
      if (this.localNodeInfo.nodeNum) {
        const nodeData = {
          nodeNum: this.localNodeInfo.nodeNum,
          nodeId: this.localNodeInfo.nodeId,
          firmwareVersion: metadata.firmwareVersion
        };
        databaseService.upsertNode(nodeData);
        console.log(`📱 Saved firmware version to database for node ${this.localNodeInfo.nodeId}`);
      }
    } else {
      console.log('⚠️ Cannot update firmware - localNodeInfo not initialized yet');
    }
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
  // Configuration messages don't typically need database storage
  // They contain device settings like LoRa parameters, GPS settings, etc.

  /**
   * Process MeshPacket protobuf message
   */
  private async processMeshPacket(meshPacket: any): Promise<void> {
    console.log(`🔄 Processing MeshPacket: ID=${meshPacket.id}, from=${meshPacket.from}, to=${meshPacket.to}`);

    // Extract node information if available
    // Note: Only update technical fields (SNR/RSSI/lastHeard), not names
    // Names should only come from NODEINFO packets
    if (meshPacket.from && meshPacket.from !== BigInt(0)) {
      const fromNum = Number(meshPacket.from);
      const nodeId = `!${fromNum.toString(16).padStart(8, '0')}`;

      // Check if node exists first
      const existingNode = databaseService.getNode(fromNum);

      const nodeData: any = {
        nodeNum: fromNum,
        nodeId: nodeId,
        lastHeard: meshPacket.rxTime ? Number(meshPacket.rxTime) : Date.now() / 1000
      };

      // Only set default name if this is a brand new node
      if (!existingNode) {
        nodeData.longName = `Node ${nodeId}`;
        nodeData.shortName = nodeId.substring(1, 5);
      }

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
          case 70: // TRACEROUTE_APP
            await this.processTracerouteMessage(meshPacket, processedPayload as any);
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

        // Determine if this is a direct message or a channel message
        // Direct messages (not broadcast) should use channel -1
        const isDirectMessage = toNum !== 4294967295;
        const channelIndex = isDirectMessage ? -1 : (meshPacket.channel !== undefined ? meshPacket.channel : 0);

        // Ensure channel 0 (Primary) exists if this message uses it
        if (!isDirectMessage && channelIndex === 0) {
          const channel0 = databaseService.getChannelById(0);
          if (!channel0) {
            console.log('📡 Creating Primary channel (ID 0) for message with channel=0');
            databaseService.upsertChannel({ id: 0, name: 'Primary' });
          }
        }

        // Extract replyId and emoji from decoded Data message - check both camelCase and snake_case
        const decodedReplyId = (meshPacket.decoded as any)?.replyId ?? (meshPacket.decoded as any)?.reply_id;
        const replyId = (decodedReplyId !== undefined && decodedReplyId > 0) ? decodedReplyId : undefined;
        const decodedEmoji = (meshPacket.decoded as any)?.emoji;
        const emoji = (decodedEmoji !== undefined && decodedEmoji > 0) ? decodedEmoji : undefined;

        // Extract hop fields - check both camelCase and snake_case
        // Note: hopStart is the INITIAL hop limit when message was sent, hopLimit is current remaining hops
        const hopStart = (meshPacket as any).hopStart ?? (meshPacket as any).hop_start ?? null;
        const hopLimit = (meshPacket as any).hopLimit ?? (meshPacket as any).hop_limit ?? null;

        const message = {
          id: `${fromNum}_${meshPacket.id || Date.now()}`,
          fromNodeNum: fromNum,
          toNodeNum: actualToNum,
          fromNodeId: fromNodeId,
          toNodeId: toNodeId,
          text: messageText,
          channel: channelIndex,
          portnum: 1, // TEXT_MESSAGE_APP
          timestamp: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          rxTime: meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now(),
          hopStart: hopStart,
          hopLimit: hopLimit,
          replyId: replyId && replyId > 0 ? replyId : undefined,
          emoji: emoji,
          createdAt: Date.now()
        };
        databaseService.insertMessage(message);
        if (isDirectMessage) {
          console.log(`💾 Saved direct message from ${message.fromNodeId} to ${message.toNodeId}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        } else {
          console.log(`💾 Saved channel message from ${message.fromNodeId} on channel ${channelIndex}: "${messageText.substring(0, 30)}..." (replyId: ${message.replyId})`);
        }
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
        role: user.role,
        hopsAway: meshPacket.hopsAway,
        lastHeard: Date.now() / 1000
      };

      // Only include SNR/RSSI if they have valid values
      if (meshPacket.rxSnr && meshPacket.rxSnr !== 0) {
        nodeData.snr = meshPacket.rxSnr;
      }
      if (meshPacket.rxRssi && meshPacket.rxRssi !== 0) {
        nodeData.rssi = meshPacket.rxRssi;
      }

      console.log(`🔍 Saving node with role=${user.role}, hopsAway=${meshPacket.hopsAway}`);
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
      const timestamp = telemetry.time ? Number(telemetry.time) * 1000 : Date.now();
      const now = Date.now();

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
      // Note: The protobuf decoder puts variant fields directly on the telemetry object
      if (telemetry.deviceMetrics) {
        const deviceMetrics = telemetry.deviceMetrics;
        console.log(`📊 Device telemetry: battery=${deviceMetrics.batteryLevel}%, voltage=${deviceMetrics.voltage}V`);

        nodeData.batteryLevel = deviceMetrics.batteryLevel;
        nodeData.voltage = deviceMetrics.voltage;
        nodeData.channelUtilization = deviceMetrics.channelUtilization;
        nodeData.airUtilTx = deviceMetrics.airUtilTx;

        // Save individual telemetry values
        if (deviceMetrics.batteryLevel !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'batteryLevel',
            timestamp, value: deviceMetrics.batteryLevel, unit: '%', createdAt: now
          });
        }
        if (deviceMetrics.voltage !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'voltage',
            timestamp, value: deviceMetrics.voltage, unit: 'V', createdAt: now
          });
        }
        if (deviceMetrics.channelUtilization !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'channelUtilization',
            timestamp, value: deviceMetrics.channelUtilization, unit: '%', createdAt: now
          });
        }
        if (deviceMetrics.airUtilTx !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'airUtilTx',
            timestamp, value: deviceMetrics.airUtilTx, unit: '%', createdAt: now
          });
        }
      } else if (telemetry.environmentMetrics) {
        const envMetrics = telemetry.environmentMetrics;
        console.log(`🌡️ Environment telemetry: temp=${envMetrics.temperature}°C, humidity=${envMetrics.relativeHumidity}%`);

        if (envMetrics.temperature !== undefined && envMetrics.temperature !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'temperature',
            timestamp, value: envMetrics.temperature, unit: '°C', createdAt: now
          });
        }
        if (envMetrics.relativeHumidity !== undefined && envMetrics.relativeHumidity !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'humidity',
            timestamp, value: envMetrics.relativeHumidity, unit: '%', createdAt: now
          });
        }
        if (envMetrics.barometricPressure !== undefined && envMetrics.barometricPressure !== null) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'pressure',
            timestamp, value: envMetrics.barometricPressure, unit: 'hPa', createdAt: now
          });
        }
      } else if (telemetry.powerMetrics) {
        const powerMetrics = telemetry.powerMetrics;
        console.log(`⚡ Power telemetry: ch1_voltage=${powerMetrics.ch1Voltage}V`);

        if (powerMetrics.ch1Voltage !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ch1Voltage',
            timestamp, value: powerMetrics.ch1Voltage, unit: 'V', createdAt: now
          });
        }
        if (powerMetrics.ch1Current !== undefined) {
          databaseService.insertTelemetry({
            nodeId, nodeNum: fromNum, telemetryType: 'ch1Current',
            timestamp, value: powerMetrics.ch1Current, unit: 'mA', createdAt: now
          });
        }
      }

      databaseService.upsertNode(nodeData);
      console.log(`📊 Updated node telemetry and saved to telemetry table: ${nodeId}`);
    } catch (error) {
      console.error('❌ Error processing telemetry message:', error);
    }
  }

  /**
   * Process traceroute message
   */
  private async processTracerouteMessage(meshPacket: any, routeDiscovery: any): Promise<void> {
    try {
      const fromNum = Number(meshPacket.from);
      const fromNodeId = `!${fromNum.toString(16).padStart(8, '0')}`;
      const toNum = Number(meshPacket.to);
      const toNodeId = `!${toNum.toString(16).padStart(8, '0')}`;

      console.log(`🗺️ Traceroute response from ${fromNodeId}:`, routeDiscovery);

      // Ensure from node exists in database (don't overwrite existing names)
      const existingFromNode = databaseService.getNode(fromNum);
      if (!existingFromNode) {
        databaseService.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          longName: `Node ${fromNodeId}`,
          shortName: fromNodeId.substring(1, 5),
          lastHeard: Date.now() / 1000
        });
      } else {
        // Just update lastHeard, don't touch the name
        databaseService.upsertNode({
          nodeNum: fromNum,
          nodeId: fromNodeId,
          lastHeard: Date.now() / 1000
        });
      }

      // Ensure to node exists in database (don't overwrite existing names)
      const existingToNode = databaseService.getNode(toNum);
      if (!existingToNode) {
        databaseService.upsertNode({
          nodeNum: toNum,
          nodeId: toNodeId,
          longName: `Node ${toNodeId}`,
          shortName: toNodeId.substring(1, 5),
          lastHeard: Date.now() / 1000
        });
      } else {
        // Just update lastHeard, don't touch the name
        databaseService.upsertNode({
          nodeNum: toNum,
          nodeId: toNodeId,
          lastHeard: Date.now() / 1000
        });
      }

      // Build the route string
      const route = routeDiscovery.route || [];
      const routeBack = routeDiscovery.routeBack || [];
      const snrTowards = routeDiscovery.snrTowards || [];
      const snrBack = routeDiscovery.snrBack || [];

      const fromNode = databaseService.getNode(fromNum);
      const fromName = fromNode?.longName || fromNodeId;

      let routeText = `📍 Traceroute to ${fromName} (${fromNodeId})\n\n`;

      if (route.length > 0) {
        routeText += `Forward path (${route.length} hops):\n`;
        route.forEach((nodeNum: number, index: number) => {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = databaseService.getNode(nodeNum);
          const nodeName = node?.longName || nodeId;
          const snr = snrTowards[index] ? `${(snrTowards[index] / 4).toFixed(1)}dB` : 'N/A';
          routeText += `  ${index + 1}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
        });
      }

      if (routeBack.length > 0) {
        routeText += `\nReturn path (${routeBack.length} hops):\n`;
        routeBack.forEach((nodeNum: number, index: number) => {
          const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
          const node = databaseService.getNode(nodeNum);
          const nodeName = node?.longName || nodeId;
          const snr = snrBack[index] ? `${(snrBack[index] / 4).toFixed(1)}dB` : 'N/A';
          routeText += `  ${index + 1}. ${nodeName} (${nodeId}) - SNR: ${snr}\n`;
        });
      }

      // Traceroute responses are direct messages, not channel messages
      const isDirectMessage = toNum !== 4294967295;
      const channelIndex = isDirectMessage ? -1 : (meshPacket.channel !== undefined ? meshPacket.channel : 0);
      const timestamp = meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : Date.now();

      // Save as a special message in the database
      const message = {
        id: `traceroute_${fromNum}_${Date.now()}`,
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        text: routeText,
        channel: channelIndex,
        portnum: 70, // TRACEROUTE_APP
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: Date.now()
      };

      databaseService.insertMessage(message);
      console.log(`💾 Saved traceroute result from ${fromNodeId} (channel: ${channelIndex})`);

      // Save to traceroutes table
      const tracerouteRecord = {
        fromNodeNum: fromNum,
        toNodeNum: toNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        route: JSON.stringify(route),
        routeBack: JSON.stringify(routeBack),
        snrTowards: JSON.stringify(snrTowards),
        snrBack: JSON.stringify(snrBack),
        timestamp: timestamp,
        createdAt: Date.now()
      };

      databaseService.insertTraceroute(tracerouteRecord);
      console.log(`💾 Saved traceroute record to traceroutes table`);
    } catch (error) {
      console.error('❌ Error processing traceroute message:', error);
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

      // Note: Telemetry data (batteryLevel, voltage, etc.) is NOT saved from NodeInfo packets
      // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()

      // If this is the local node, update localNodeInfo with names (only if not locked)
      if (this.localNodeInfo && this.localNodeInfo.nodeNum === Number(nodeInfo.num) && !this.localNodeInfo.isLocked) {
        console.log(`📱 Updating local node info with names from NodeInfo`);
        if (nodeInfo.user && nodeInfo.user.longName && nodeInfo.user.shortName) {
          this.localNodeInfo.longName = nodeInfo.user.longName;
          this.localNodeInfo.shortName = nodeInfo.user.shortName;
          this.localNodeInfo.isLocked = true;  // Lock it now that we have complete info
          console.log(`📱 Local node: ${nodeInfo.user.longName} (${nodeInfo.user.shortName}) - LOCKED`);
        }
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
    console.log('🔍 Checking for Primary channel (ID 0)...');
    const channel0 = databaseService.getChannelById(0);
    console.log('🔍 getChannelById(0) result:', channel0);
    if (!channel0) {
      console.log('📡 Creating Primary channel (ID 0)');
      databaseService.upsertChannel({
        id: 0,
        name: 'Primary'
      });
      console.log('✅ Primary channel created');
    } else {
      console.log('✅ Primary channel already exists');
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

        // Note: Telemetry data (batteryLevel, voltage, etc.) is NOT extracted from NodeInfo during config parsing
        // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()

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
          position: telemetry.position
          // Note: deviceMetrics are NOT included - telemetry is only saved from TELEMETRY_APP packets
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

      // Determine if this is a direct message or a channel message
      const isDirectMessage = toNodeNum !== 4294967295;
      const channelIndex = isDirectMessage ? -1 : (packet.channel || 0);

      const message = {
        id: packet.id || `${fromNodeId}_${Date.now()}`,
        fromNodeNum: fromNodeNum,
        toNodeNum: toNodeNum,
        fromNodeId: fromNodeId,
        toNodeId: toNodeId,
        text: packet.text,
        channel: channelIndex,
        portnum: packet.portnum,
        timestamp: packet.timestamp || Date.now(),
        rxTime: packet.rxTime || packet.timestamp || Date.now(),
        createdAt: packet.createdAt || Date.now()
      };

      try {
        databaseService.insertMessage(message);
        if (isDirectMessage) {
          console.log('Saved direct message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        } else {
          console.log('Saved channel message to database:', message.text.substring(0, 50) + (message.text.length > 50 ? '...' : ''));
        }
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
      // Note: Telemetry data (batteryLevel, voltage, etc.) is NOT saved from NodeInfo packets
      // It is only saved from actual TELEMETRY_APP packets in processTelemetryMessageProtobuf()
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
    // Try to get additional info from JSON report endpoint
    let jsonReportData: any = null;
    try {
      const reportResponse = await this.makeRequest('/json/report');
      if (reportResponse.ok) {
        const report = await reportResponse.json();
        jsonReportData = report.data;
      }
    } catch (error) {
      console.log('Could not fetch JSON report:', error);
    }

    // If we have actual config data with lora config, use it
    if (this.actualDeviceConfig?.lora || this.actualModuleConfig) {
      console.log('Using actualDeviceConfig:', JSON.stringify(this.actualDeviceConfig, null, 2));
      return this.buildDeviceConfigFromActual(jsonReportData);
    }

    // Fallback to parsed data if no actual config is available
    try {
      // Request device configuration from Meshtastic node
      const response = await this.makeRequest('/api/v1/fromradio?all=true');
      if (response.ok) {
        const data = await response.arrayBuffer();
        return this.parseConfigDataWithReport(new Uint8Array(data), jsonReportData);
      }
    } catch (error) {
      console.error('Failed to get device config:', error);
    }
    return null;
  }

  private buildDeviceConfigFromActual(jsonReportData?: any): any {
    const dbChannels = databaseService.getAllChannels();
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled
    }));

    const localNode = this.localNodeInfo as any;

    // Extract actual values from stored config or use sensible defaults
    const loraConfig = this.actualDeviceConfig?.lora || {};
    const mqttConfig = this.actualModuleConfig?.mqtt || {};

    console.log('🔍 loraConfig being used:', JSON.stringify(loraConfig, null, 2));
    console.log('🔍 mqttConfig being used:', JSON.stringify(mqttConfig, null, 2));

    // Map region enum values to strings
    const regionMap: { [key: number]: string } = {
      0: 'UNSET',
      1: 'US',
      2: 'EU_433',
      3: 'EU_868',
      4: 'CN',
      5: 'JP',
      6: 'ANZ',
      7: 'KR',
      8: 'TW',
      9: 'RU',
      10: 'IN',
      11: 'NZ_865',
      12: 'TH',
      13: 'LORA_24',
      14: 'UA_433',
      15: 'UA_868'
    };

    // Map modem preset enum values to strings
    const modemPresetMap: { [key: number]: string } = {
      0: 'Long Fast',
      1: 'Long Slow',
      2: 'Very Long Slow',
      3: 'Medium Slow',
      4: 'Medium Fast',
      5: 'Short Slow',
      6: 'Short Fast',
      7: 'Long Moderate',
      8: 'Short Turbo'
    };

    // Convert enum values to human-readable strings
    const regionValue = typeof loraConfig.region === 'number' ? regionMap[loraConfig.region] || `Unknown (${loraConfig.region})` : loraConfig.region || 'Unknown';
    const modemPresetValue = typeof loraConfig.modemPreset === 'number' ? modemPresetMap[loraConfig.modemPreset] || `Unknown (${loraConfig.modemPreset})` : loraConfig.modemPreset || 'Unknown';

    // Use JSON report data to supplement missing config
    const radioData = jsonReportData?.radio || {};

    return {
      basic: {
        nodeAddress: this.getNodeAddress(),
        useTls: this.config.useTls,
        connected: this.isConnected,
        nodeId: localNode?.nodeId || null,
        nodeName: localNode?.longName || null,
        firmwareVersion: localNode?.firmwareVersion || null
      },
      radio: {
        region: regionValue,
        modemPreset: modemPresetValue,
        hopLimit: loraConfig.hopLimit !== undefined ? loraConfig.hopLimit : 'Unknown',
        txPower: loraConfig.txPower !== undefined ? loraConfig.txPower : 'Unknown',
        bandwidth: loraConfig.bandwidth || 'Unknown',
        spreadFactor: loraConfig.spreadFactor || 'Unknown',
        codingRate: loraConfig.codingRate || 'Unknown',
        channelNum: loraConfig.channelNum !== undefined ? loraConfig.channelNum : (radioData.lora_channel || 'Unknown'),
        frequency: radioData.frequency ? `${radioData.frequency} MHz` : 'Unknown',
        txEnabled: loraConfig.txEnabled !== undefined ? loraConfig.txEnabled : 'Unknown',
        sx126xRxBoostedGain: loraConfig.sx126xRxBoostedGain !== undefined ? loraConfig.sx126xRxBoostedGain : 'Unknown',
        configOkToMqtt: loraConfig.configOkToMqtt !== undefined ? loraConfig.configOkToMqtt : 'Unknown'
      },
      mqtt: {
        enabled: mqttConfig.enabled || false,
        server: mqttConfig.address || 'Not configured',
        username: mqttConfig.username || 'Not set',
        encryption: mqttConfig.encryptionEnabled || false,
        json: mqttConfig.jsonEnabled || false,
        tls: mqttConfig.tlsEnabled || false,
        rootTopic: mqttConfig.root || 'msh'
      },
      channels: channels.length > 0 ? channels : [
        { index: 0, name: 'Primary', psk: 'None', uplinkEnabled: true, downlinkEnabled: true }
      ]
    };
  }

  private parseConfigDataWithReport(data: Uint8Array, jsonReportData?: any): any {
    const radioData = jsonReportData?.radio || {};

    // Parse actual device configuration from protobuf data
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);

    // Intelligent region detection based on frequency
    let region = 'Unknown';
    const frequency = radioData.frequency;
    if (frequency) {
      // Determine region based on frequency band
      if (frequency >= 902 && frequency <= 928) {
        region = 'US';
      } else if (frequency >= 863 && frequency <= 870) {
        region = 'EU_868';
      } else if (frequency >= 433.05 && frequency <= 434.79) {
        region = 'EU_433';
      } else if (frequency >= 915 && frequency <= 928) {
        region = 'ANZ';
      } else if (frequency >= 920 && frequency <= 925) {
        region = 'JP';
      } else if (frequency >= 865 && frequency <= 867) {
        region = 'IN';
      }
    }

    // Try to infer modem preset from frequency and channel combination
    // This is based on common Meshtastic configurations
    let modemPreset = 'Unknown';
    if (frequency && radioData.lora_channel !== undefined) {
      // US region channel 45 at 913.125 MHz is commonly Medium Fast
      // These are heuristics based on common configurations
      if (region === 'US' && radioData.lora_channel === 45 && Math.abs(frequency - 913.125) < 0.1) {
        modemPreset = 'Medium Fast';
      }
      // Add more heuristics as we learn common patterns
    }

    // MQTT server detection from raw data
    let mqttEnabled = false;
    let mqttServer = 'Not configured';

    // Look for MQTT server patterns in the raw data
    const mqttPatterns = [
      'mqtt.areyoumeshingwith.us',
      'mqtt.meshtastic.org',
      'broker.hivemq.com',
      'test.mosquitto.org'
    ];

    for (const pattern of mqttPatterns) {
      if (text.includes(pattern)) {
        mqttEnabled = true;
        mqttServer = pattern;
        console.log(`🔍 Detected MQTT server in raw data: ${pattern}`);
        break;
      }
    }

    // Extract channels from the database
    const dbChannels = databaseService.getAllChannels();
    const channels = dbChannels.map(ch => ({
      index: ch.id,
      name: ch.name,
      psk: ch.psk ? 'Set' : 'None',
      uplinkEnabled: ch.uplinkEnabled,
      downlinkEnabled: ch.downlinkEnabled
    }));

    const localNode = this.localNodeInfo as any;

    return {
      basic: {
        nodeAddress: this.getNodeAddress(),
        useTls: this.config.useTls,
        connected: this.isConnected,
        nodeId: localNode?.nodeId || null,
        nodeName: localNode?.longName || null,
        firmwareVersion: localNode?.firmwareVersion || null
      },
      radio: {
        region: region,
        modemPreset: modemPreset,
        hopLimit: 'Unknown',
        txPower: 'Unknown',
        bandwidth: 'Unknown',
        spreadFactor: 'Unknown',
        codingRate: 'Unknown',
        channelNum: radioData.lora_channel || 'Unknown',
        frequency: radioData.frequency ? `${radioData.frequency} MHz` : 'Unknown',
        txEnabled: 'Unknown',
        sx126xRxBoostedGain: 'Unknown',
        configOkToMqtt: 'Unknown'
      },
      mqtt: {
        enabled: mqttEnabled,
        server: mqttServer,
        username: 'Not set',
        encryption: false,
        json: false,
        tls: false,
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

  async sendTraceroute(destination: number, channel: number = 0): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      const tracerouteData = meshtasticProtobufService.createTracerouteMessage(destination, channel);

      const response = await this.makeRequest('/api/v1/toradio', {
        method: 'PUT',
        body: tracerouteData as BodyInit,
        headers: {
          'Content-Type': 'application/x-protobuf'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to send traceroute: ${response.status} ${response.statusText}`);
      }

      databaseService.recordTracerouteRequest(destination);
      console.log(`Traceroute request sent to node: !${destination.toString(16).padStart(8, '0')}`);
    } catch (error) {
      console.error('Error sending traceroute:', error);
      throw error;
    }
  }

  getConnectionStatus(): { connected: boolean; nodeIp: string } {
    return {
      connected: this.isConnected,
      nodeIp: this.getNodeAddress()
    };
  }

  // Get data from database instead of maintaining in-memory state
  getAllNodes(): DeviceInfo[] {
    const dbNodes = databaseService.getAllNodes();
    if (dbNodes.length > 0) {
      console.log('🔍 Sample dbNode from database:', {
        nodeId: dbNodes[0].nodeId,
        longName: dbNodes[0].longName,
        role: dbNodes[0].role,
        hopsAway: dbNodes[0].hopsAway
      });
    }
    return dbNodes.map(node => {
      const deviceInfo: any = {
        nodeNum: node.nodeNum,
        user: {
          id: node.nodeId,
          longName: node.longName || '',
          shortName: node.shortName || '',
          hwModel: node.hwModel
        },
        deviceMetrics: {
          batteryLevel: node.batteryLevel,
          voltage: node.voltage,
          channelUtilization: node.channelUtilization,
          airUtilTx: node.airUtilTx
        },
        lastHeard: node.lastHeard,
        snr: node.snr,
        rssi: node.rssi
      };

      // Add role if it exists
      if (node.role !== null && node.role !== undefined) {
        deviceInfo.user.role = node.role.toString();
      }

      // Add hopsAway if it exists
      if (node.hopsAway !== null && node.hopsAway !== undefined) {
        deviceInfo.hopsAway = node.hopsAway;
      }

      // Add position if coordinates exist
      if (node.latitude && node.longitude) {
        deviceInfo.position = {
          latitude: node.latitude,
          longitude: node.longitude,
          altitude: node.altitude
        };
      }

      return deviceInfo;
    });
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
      timestamp: new Date(msg.timestamp),
      hopStart: msg.hopStart,
      hopLimit: msg.hopLimit,
      replyId: msg.replyId,
      emoji: msg.emoji
    }));
  }

  // Public method to trigger manual refresh of node database
  async refreshNodeDatabase(): Promise<void> {
    console.log('🔄 Manually refreshing node database...');

    if (!this.isConnected) {
      console.log('⚠️ Not connected, attempting to reconnect...');
      await this.connect();
    }

    // Trigger the full configuration request
    await this.requestFullConfiguration();
  }
}

export default new MeshtasticManager();