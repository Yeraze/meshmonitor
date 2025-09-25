import databaseService from '../services/database.js';

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
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
}

class MeshtasticManager {
  private config: MeshtasticConfig;
  private isConnected = false;
  private pollingInterval: NodeJS.Timeout | null = null;

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
      console.log('Requesting full configuration from node...');

      // Strategy 1: Standard want_config_id approach with extended timeout
      await this.sendWantConfigId();
      console.log('Waiting 10 seconds for device to populate fromradio queue...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      let totalDataReceived = 0;

      // Try multiple requests to get all configuration data
      for (let attempt = 1; attempt <= 5; attempt++) {
        console.log(`Configuration request attempt ${attempt}...`);

        const response = await this.makeRequest('/api/v1/fromradio?all=true');
        if (response.ok) {
          const data = await response.arrayBuffer();
          console.log(`Attempt ${attempt}: Received ${data.byteLength} bytes`);
          totalDataReceived += data.byteLength;

          if (data.byteLength > 0) {
            const uint8Array = new Uint8Array(data);

            // Log configuration data for debugging on first attempt
            if (attempt === 1) {
              const hexString = Array.from(uint8Array.slice(0, 100))
                .map(b => b.toString(16).padStart(2, '0'))
                .join(' ');
              console.log('Config hex data (first 100 bytes):', hexString);
            }

            await this.processIncomingData(uint8Array);
            console.log(`Processed data from attempt ${attempt}`);
          }
        } else {
          console.warn(`Attempt ${attempt} failed, status:`, response.status);
        }

        // Small delay between attempts
        if (attempt < 5) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      console.log(`Total configuration data received: ${totalDataReceived} bytes`);

      // Strategy 2: If we didn't get much data, try alternative approaches
      if (totalDataReceived < 100) {
        console.log('Limited data received, trying alternative approaches...');

        // Try sending want_config_id again
        await this.sendWantConfigId();
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Try without 'all' parameter
        const altResponse = await this.makeRequest('/api/v1/fromradio');
        if (altResponse.ok) {
          const altData = await altResponse.arrayBuffer();
          if (altData.byteLength > 0) {
            console.log(`Alternative approach: ${altData.byteLength} bytes`);
            await this.processIncomingData(new Uint8Array(altData));
          }
        }

        // Strategy 3: Try to request device info and stats
        try {
          const nodeInfoResponse = await this.makeRequest('/json/info');
          if (nodeInfoResponse.ok) {
            const nodeInfo = await nodeInfoResponse.json();
            console.log('Device info:', nodeInfo);

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

              console.log('Creating node from device info:', nodeData);
              databaseService.upsertNode(nodeData);
            }
          }
        } catch (infoError) {
          console.log('Could not fetch device info:', infoError);
        }
      }

    } catch (error) {
      console.error('Failed to request full configuration:', error);
    }
  }

  private async sendWantConfigId(): Promise<void> {
    try {
      console.log('Sending want_config_id to trigger configuration data...');

      // Create a minimal ToRadio protobuf with want_config_id
      // From mesh.proto: want_config_id is field number 3 in ToRadio message
      // Format: field number 3, wire type 0 (varint), value 1
      const wantConfigIdMessage = new Uint8Array([
        0x18, 0x01  // Field 3 (want_config_id), value 1 (true)
      ]);

      const response = await this.makeRequest('/api/v1/toradio', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/x-protobuf'
        },
        body: wantConfigIdMessage
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

      // Basic protobuf parsing - look for node information in binary data
      const parsedData = this.parseFromRadioProtobuf(data);

      if (parsedData) {
        console.log('Parsed protobuf data:', parsedData.type, parsedData.data.longName || parsedData.data.text?.substring(0, 30) || 'unknown');

        if (parsedData.type === 'nodeInfo') {
          await this.processNodeInfo(parsedData.data);
        } else if (parsedData.type === 'packet') {
          await this.processPacket(parsedData.data);
        } else if (parsedData.type === 'nodeDatabase') {
          console.log(parsedData.data.message);
          // Node processing already happened in extractAllNodesFromDatabase
        } else if (parsedData.type === 'channelConfig') {
          console.log(parsedData.data.message);
          // Channel processing - just log for now, prevents message processing
        }
      } else {
        console.log('No parseable data found in', data.length, 'bytes');
      }
    } catch (error) {
      console.error('Error processing incoming data:', error);
    }
  }

  private parseFromRadioProtobuf(data: Uint8Array): any {
    try {
      // Basic protobuf parsing for Meshtastic FromRadio messages
      // This is a simplified parser that looks for common patterns

      if (data.length < 5) return null;

      // Decode as text for pattern matching
      const text = new TextDecoder('utf-8', { fatal: false }).decode(data);

      // Log all potential node IDs we find
      const nodeIdMatches = text.match(/!([a-f0-9]{8})/g);
      if (nodeIdMatches && nodeIdMatches.length > 0) {
        console.log('Found node IDs in data:', nodeIdMatches);
      }

      // Look for any readable text that might be names or messages
      const readableMatches = text.match(/[A-Za-z][A-Za-z0-9\s\-_]{2,30}/g);
      if (readableMatches && readableMatches.length > 0) {
        console.log('Found readable text:', readableMatches.slice(0, 10));
      }

      // If we have node IDs, extract and save them first before processing other data
      if (nodeIdMatches && nodeIdMatches.length > 0) {
        // Save all discovered nodes to database first
        this.saveNodesFromData(nodeIdMatches, readableMatches || [], text);

        // If we have many node IDs, this is likely a complete mesh database
        if (nodeIdMatches.length > 5) {
          return {
            type: 'nodeDatabase',
            data: {
              nodesProcessed: nodeIdMatches.length,
              message: `Processed ${nodeIdMatches.length} nodes from mesh database`
            }
          };
        }
      }

      // Check for channel configuration data after node processing
      const channelResult = this.extractChannelInfo(data, text, readableMatches);
      if (channelResult) return channelResult;

      // Look for text messages first (these are more common)
      const messageResult = this.extractTextMessage(data, text);
      if (messageResult) return messageResult;

      // Look for node information - be more aggressive
      const nodeResult = this.extractNodeInfo(data, text);
      if (nodeResult) return nodeResult;

      // Try to extract any protobuf structure we can recognize
      const protoResult = this.extractProtobufStructure(data);
      if (protoResult) return protoResult;

      // Look for other packet types
      const otherResult = this.extractOtherPackets(data, text);
      if (otherResult) return otherResult;

    } catch (error) {
      console.error('Error parsing protobuf:', error);
    }

    return null;
  }

  private saveNodesFromData(nodeIds: string[], readableText: string[], text: string): void {
    // Extract and save all discovered nodes to database
    const uniqueNodeIds = [...new Set(nodeIds)];
    console.log(`Saving ${uniqueNodeIds.length} nodes to database`);

    for (const nodeId of uniqueNodeIds) {
      try {
        const nodeNum = parseInt(nodeId.substring(1), 16);

        // Try to find a name for this node in the readable text
        const possibleName = this.findNameForNode(nodeId, readableText, text);

        const nodeData = {
          nodeNum: nodeNum,
          nodeId: nodeId,
          longName: possibleName.longName || `Node ${nodeId}`,
          shortName: possibleName.shortName || nodeId.substring(1, 5),
          hwModel: 0, // We don't have this info yet
          lastHeard: Date.now() / 1000,
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

  private extractChannelInfo(_data: Uint8Array, _text: string, readableMatches: string[] | null): any {
    if (!readableMatches) return null;

    // Filter readable matches to exclude WiFi-related terms but allow any legitimate channel names
    const validChannels = readableMatches.filter(match =>
      match.length >= 2 && // Must be at least 2 characters
      match.length <= 20 && // Reasonable channel name length
      !/wifi|ssid|network|5g|2\.4g|hotspot|router|access.*point/i.test(match) && // Explicitly exclude WiFi-related terms
      !/^[0-9]+$/.test(match) && // Exclude pure numbers (likely not channel names)
      /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(match) // Must start with letter, contain only alphanumeric, underscore, hyphen
    );

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
      console.log('Creating default Primary channel');
      this.saveChannelsToDatabase(['Primary']);
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

  private findNameForNode(nodeId: string, _readableText: string[], fullText: string): {longName?: string, shortName?: string} {
    // Try to find text near this node ID that might be its name
    const nodeIndex = fullText.indexOf(nodeId);
    if (nodeIndex === -1) return {};

    // Look for readable text before and after the node ID
    const contextBefore = fullText.substring(Math.max(0, nodeIndex - 50), nodeIndex);
    const contextAfter = fullText.substring(nodeIndex + nodeId.length, nodeIndex + nodeId.length + 50);

    // Look for name patterns in the context
    const nameMatch = contextAfter.match(/([A-Za-z][A-Za-z0-9\s\-_]{2,20})/);
    if (nameMatch) {
      const longName = nameMatch[1].trim();
      const shortName = longName.length > 4 ? longName.substring(0, 4) : longName;
      return { longName, shortName };
    }

    // Try before the node ID
    const beforeMatch = contextBefore.match(/([A-Za-z][A-Za-z0-9\s\-_]{2,20})\s*$/);
    if (beforeMatch) {
      const longName = beforeMatch[1].trim();
      const shortName = longName.length > 4 ? longName.substring(0, 4) : longName;
      return { longName, shortName };
    }

    return {};
  }

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
      const nameMatches = part.match(/([A-Za-z0-9\s\-_.\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]{2,31})/gu);

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
    // Enhanced telemetry extraction
    // This is still simplified but could be improved with proper protobuf parsing

    const telemetry: any = {
      hwModel: undefined,
      snr: undefined,
      rssi: undefined,
      position: undefined,
      deviceMetrics: undefined
    };

    // Look for SNR/RSSI patterns in the binary data
    for (let i = 0; i < data.length - 4; i++) {
      const value = new DataView(data.buffer, data.byteOffset + i, 4);

      try {
        const floatVal = value.getFloat32(0, true); // little endian

        // SNR typically ranges from -20 to +10
        if (floatVal >= -25 && floatVal <= 15 && !telemetry.snr) {
          telemetry.snr = Math.round(floatVal * 100) / 100;
        }

        // RSSI typically ranges from -120 to -30
        if (floatVal >= -150 && floatVal <= -20 && !telemetry.rssi) {
          telemetry.rssi = Math.round(floatVal);
        }
      } catch (e) {
        // Continue searching
      }
    }

    return telemetry;
  }


  private async processPacket(packet: any): Promise<void> {
    // Handle the new packet structure from enhanced protobuf parsing
    if (packet.text && packet.text.length > 0) {
      const message = {
        id: packet.id || `${packet.fromNodeId}_${Date.now()}`,
        fromNodeNum: packet.from || packet.fromNodeNum || 0,
        toNodeNum: packet.to || packet.toNodeNum || 0xFFFFFFFF,
        fromNodeId: packet.fromNodeId || packet.from?.toString() || 'unknown',
        toNodeId: packet.toNodeId || packet.to?.toString() || '!ffffffff',
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
      }
    }
  }

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

  async sendTextMessage(text: string, channel: number = 0): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to Meshtastic node');
    }

    try {
      const message = {
        type: 'sendtext',
        payload: {
          text: text,
          channel: channel,
          wantAck: true
        }
      };

      const encoder = new TextEncoder();
      const data = encoder.encode(JSON.stringify(message));

      const response = await this.makeRequest('/api/v1/toradio', {
        method: 'PUT',
        body: data,
        headers: {
          'Content-Type': 'application/octet-stream'
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
      text: msg.text,
      channel: msg.channel,
      portnum: msg.portnum,
      timestamp: new Date(msg.timestamp)
    }));
  }
}

export default new MeshtasticManager();