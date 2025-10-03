import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import meshtasticManager from './meshtasticManager.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
// Validate and normalize BASE_URL
const BASE_URL = (() => {
  let baseUrl = process.env.BASE_URL || '';

  // Ensure BASE_URL starts with /
  if (baseUrl && !baseUrl.startsWith('/')) {
    console.warn(`BASE_URL should start with '/'. Fixing: ${baseUrl} -> /${baseUrl}`);
    baseUrl = `/${baseUrl}`;
  }

  // Validate against path traversal attempts BEFORE normalization
  // Check for any form of path traversal: ../, ..\, or .. as a segment
  if (baseUrl.includes('../') || baseUrl.includes('..\\') || baseUrl.includes('/..')) {
    console.error(`Invalid BASE_URL: path traversal detected in '${baseUrl}'. Using default.`);
    return '';
  }

  // Remove trailing slashes
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }

  // Validate URL path segments
  if (baseUrl) {
    const segments = baseUrl.split('/').filter(Boolean);
    const validSegment = /^[a-zA-Z0-9-_]+$/;

    // Check each segment for path traversal or invalid characters
    for (const segment of segments) {
      // Reject segments that are exactly '..'
      if (segment === '..') {
        console.error(`Invalid BASE_URL: path traversal segment detected. Using default.`);
        return '';
      }

      if (!validSegment.test(segment)) {
        console.warn(`BASE_URL contains invalid characters in segment: ${segment}. Only alphanumeric, hyphens, and underscores are allowed.`);
      }
    }

    // Log multi-segment paths for visibility
    if (segments.length > 1) {
      console.log(`Using multi-segment BASE_URL: ${baseUrl} (${segments.length} segments)`);
    }
  }

  return baseUrl;
})();
const serverStartTime = Date.now();

// Custom JSON replacer to handle BigInt values
const jsonReplacer = (_key: string, value: any) => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
};

// Override JSON.stringify to handle BigInt
const originalStringify = JSON.stringify;
JSON.stringify = function(value, replacer?: any, space?: any) {
  if (replacer) {
    return originalStringify(value, replacer, space);
  }
  return originalStringify(value, jsonReplacer, space);
};

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Meshtastic connection
setTimeout(async () => {
  try {
    await meshtasticManager.connect();
    console.log('Meshtastic manager connected successfully');
  } catch (error) {
    console.error('Failed to connect to Meshtastic node on startup:', error);
  }
}, 1000);

// Schedule hourly telemetry purge to keep database performant
// Keep telemetry for 7 days (168 hours) by default
const TELEMETRY_RETENTION_HOURS = 168; // 7 days
setInterval(() => {
  try {
    const purgedCount = databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS);
    if (purgedCount > 0) {
      console.log(`⏰ Hourly telemetry purge completed: removed ${purgedCount} records`);
    }
  } catch (error) {
    console.error('Error during telemetry purge:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Run initial purge on startup
setTimeout(() => {
  try {
    databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS);
  } catch (error) {
    console.error('Error during initial telemetry purge:', error);
  }
}, 5000); // Wait 5 seconds after startup

// Create router for API routes
const apiRouter = express.Router();

// API Routes
apiRouter.get('/nodes', (_req, res) => {
  try {
    const nodes = meshtasticManager.getAllNodes();

    // Enhance nodes with mobility detection
    const enhancedNodes = nodes.map(node => {
      if (!node.user?.id) return { ...node, isMobile: false };

      // Check position telemetry for this node
      const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
      const latitudes = positionTelemetry.filter(t => t.telemetryType === 'latitude');
      const longitudes = positionTelemetry.filter(t => t.telemetryType === 'longitude');

      let isMobile = false;

      if (latitudes.length >= 2 && longitudes.length >= 2) {
        // Calculate distance variation
        const latValues = latitudes.map(t => t.value);
        const lonValues = longitudes.map(t => t.value);

        const minLat = Math.min(...latValues);
        const maxLat = Math.max(...latValues);
        const minLon = Math.min(...lonValues);
        const maxLon = Math.max(...lonValues);

        // Calculate distance between min/max corners using Haversine formula
        const R = 6371; // Earth's radius in km
        const dLat = (maxLat - minLat) * Math.PI / 180;
        const dLon = (maxLon - minLon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(minLat * Math.PI / 180) * Math.cos(maxLat * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If movement is greater than 1km, mark as mobile
        isMobile = distance > 1.0;
      }

      return { ...node, isMobile };
    });

    console.log('🔍 Sending nodes to frontend, sample node:', enhancedNodes[0] ? {
      nodeNum: enhancedNodes[0].nodeNum,
      longName: enhancedNodes[0].user?.longName,
      role: enhancedNodes[0].user?.role,
      hopsAway: enhancedNodes[0].hopsAway,
      isMobile: enhancedNodes[0].isMobile
    } : 'No nodes');
    res.json(enhancedNodes);
  } catch (error) {
    console.error('Error fetching nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

apiRouter.get('/nodes/active', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const nodes = databaseService.getActiveNodes(days);
    res.json(nodes);
  } catch (error) {
    console.error('Error fetching active nodes:', error);
    res.status(500).json({ error: 'Failed to fetch active nodes' });
  }
});

// Get position history for a node (for mobile node visualization)
apiRouter.get('/nodes/:nodeId/position-history', (req, res) => {
  try {
    const { nodeId } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 168; // Default 7 days

    const cutoffTime = Date.now() - (hoursParam * 60 * 60 * 1000);

    // Get position telemetry
    const positionTelemetry = databaseService.getTelemetryByNode(nodeId, 1000, cutoffTime);

    // Group by timestamp to get lat/lon pairs
    const positionMap = new Map<number, { lat?: number; lon?: number; alt?: number }>();

    positionTelemetry.forEach(t => {
      if (!positionMap.has(t.timestamp)) {
        positionMap.set(t.timestamp, {});
      }
      const pos = positionMap.get(t.timestamp)!;

      if (t.telemetryType === 'latitude') {
        pos.lat = t.value;
      } else if (t.telemetryType === 'longitude') {
        pos.lon = t.value;
      } else if (t.telemetryType === 'altitude') {
        pos.alt = t.value;
      }
    });

    // Convert to array of positions, filter incomplete ones
    const positions = Array.from(positionMap.entries())
      .filter(([_timestamp, pos]) => pos.lat !== undefined && pos.lon !== undefined)
      .map(([timestamp, pos]) => ({
        timestamp,
        latitude: pos.lat!,
        longitude: pos.lon!,
        altitude: pos.alt
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(positions);
  } catch (error) {
    console.error('Error fetching position history:', error);
    res.status(500).json({ error: 'Failed to fetch position history' });
  }
});

apiRouter.get('/messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const messages = meshtasticManager.getRecentMessages(limit);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

apiRouter.get('/messages/channel/:channel', (req, res) => {
  try {
    const requestedChannel = parseInt(req.params.channel);
    const limit = parseInt(req.query.limit as string) || 100;

    // Check if this is a Primary channel request and map to channel 0 messages
    let messageChannel = requestedChannel;
    const allChannels = databaseService.getAllChannels();

    // Find any channel that could be Primary (name="Primary" or name="Channel 0")
    const primaryChannels = allChannels.filter(ch => ch.name === 'Primary' || ch.name === 'Channel 0');

    // If the requested channel is any of the Primary channels, map to channel 0
    const isPrimaryRequest = primaryChannels.some(ch => ch.id === requestedChannel);
    if (isPrimaryRequest) {
      messageChannel = 0;
    }

    const messages = databaseService.getMessagesByChannel(messageChannel, limit);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

apiRouter.get('/messages/direct/:nodeId1/:nodeId2', (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const messages = databaseService.getDirectMessages(nodeId1, nodeId2, limit);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching direct messages:', error);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

// Debug endpoint to see all channels
apiRouter.get('/channels/debug', (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();
    console.log('🔍 DEBUG: All channels in database:', allChannels);
    res.json(allChannels);
  } catch (error) {
    console.error('Error fetching debug channels:', error);
    res.status(500).json({ error: 'Failed to fetch debug channels' });
  }
});

apiRouter.get('/channels', (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();

    // Ensure Primary channel exists and is properly named
    // Look for existing channels that should be Primary (Channel 0 or Primary)
    const primaryChannels = allChannels.filter(ch => ch.name === 'Primary' || ch.name === 'Channel 0');

    if (primaryChannels.length === 0) {
      // Create a new primary channel with ID 0 if none exists
      // ID 0 is the default Meshtastic channel index
      const newPrimary = {
        id: 0,
        name: 'Primary',
        psk: undefined
      };
      try {
        databaseService.upsertChannel(newPrimary);
        console.log('📡 Created missing Primary channel with ID 0');
      } catch (error) {
        console.error('❌ Failed to create Primary channel:', error);
      }
    } else if (primaryChannels.length === 1) {
      // Single channel - rename if needed
      const primaryChannel = primaryChannels[0];
      if (primaryChannel.name === 'Channel 0') {
        try {
          const updatedChannel = { ...primaryChannel, name: 'Primary' };
          databaseService.upsertChannel(updatedChannel);
          primaryChannel.name = 'Primary'; // Update in memory
          console.log('📡 Renamed "Channel 0" to "Primary"');
        } catch (error) {
          console.error('❌ Failed to rename channel to Primary:', error);
        }
      }
    } else {
      // Multiple Primary channels - keep the older one, remove newer duplicates
      const sortedPrimary = primaryChannels.sort((a, b) => a.createdAt - b.createdAt);
      const keepChannel = sortedPrimary[0];
      const removeChannels = sortedPrimary.slice(1);

      // Rename the keeper if needed
      if (keepChannel.name === 'Channel 0') {
        try {
          const updatedChannel = { ...keepChannel, name: 'Primary' };
          databaseService.upsertChannel(updatedChannel);
          keepChannel.name = 'Primary';
          console.log('📡 Renamed primary channel to "Primary"');
        } catch (error) {
          console.error('❌ Failed to rename primary channel:', error);
        }
      }

      // Remove duplicates by filtering them out from the allChannels array
      for (const duplicate of removeChannels) {
        const index = allChannels.findIndex(ch => ch.id === duplicate.id);
        if (index > -1) {
          allChannels.splice(index, 1);
          console.log(`📡 Removed duplicate Primary channel (id=${duplicate.id})`);
        }
      }
    }

    // Filter channels to only show meaningful ones
    const filteredChannels = allChannels.filter(channel => {
      // Always show Primary and telemetry by name
      if (channel.name === 'Primary' || channel.name === 'telemetry') {
        return true;
      }

      // Show other channels only if they have a meaningful name (not just "Channel X")
      if (channel.name && !channel.name.match(/^Channel \d+$/)) {
        return true;
      }

      // For generic "Channel X" names, only show if they're likely to be active
      if (channel.name && channel.name.match(/^Channel \d+$/)) {
        const channelNumber = parseInt(channel.name.replace('Channel ', ''));
        return channelNumber <= 3; // Only show Channel 1, 2, 3 (Channel 0 is now Primary)
      }

      return false;
    });

    // Ensure Primary channel is first in the list
    const primaryIndex = filteredChannels.findIndex(ch => ch.name === 'Primary');
    if (primaryIndex > 0) {
      const primary = filteredChannels.splice(primaryIndex, 1)[0];
      filteredChannels.unshift(primary);
    }

    console.log(`📡 Serving ${filteredChannels.length} filtered channels (from ${allChannels.length} total)`);
    console.log(`🔍 All channels in DB:`, allChannels.map(ch => ({ id: ch.id, name: ch.name })));
    console.log(`🔍 Filtered channels:`, filteredChannels.map(ch => ({ id: ch.id, name: ch.name })));
    res.json(filteredChannels);
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

apiRouter.get('/stats', (_req, res) => {
  try {
    const messageCount = databaseService.getMessageCount();
    const nodeCount = databaseService.getNodeCount();
    const channelCount = databaseService.getChannelCount();
    const messagesByDay = databaseService.getMessagesByDay(7);

    res.json({
      messageCount,
      nodeCount,
      channelCount,
      messagesByDay
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

apiRouter.post('/export', (_req, res) => {
  try {
    const data = databaseService.exportData();
    res.json(data);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

apiRouter.post('/import', (req, res) => {
  try {
    const data = req.body;
    databaseService.importData(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

apiRouter.post('/cleanup/messages', (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupOldMessages(days);
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Failed to cleanup messages' });
  }
});

apiRouter.post('/cleanup/nodes', (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupInactiveNodes(days);
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error cleaning up nodes:', error);
    res.status(500).json({ error: 'Failed to cleanup nodes' });
  }
});

apiRouter.post('/cleanup/channels', (_req, res) => {
  try {
    const deletedCount = databaseService.cleanupInvalidChannels();
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error cleaning up channels:', error);
    res.status(500).json({ error: 'Failed to cleanup channels' });
  }
});


// Send message endpoint
apiRouter.post('/messages/send', async (req, res) => {
  try {
    const { text, channel, destination, replyId, emoji } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    // Validate replyId if provided
    if (replyId !== undefined && (typeof replyId !== 'number' || replyId < 0 || !Number.isInteger(replyId))) {
      return res.status(400).json({ error: 'Invalid replyId: must be a positive integer' });
    }

    // Validate emoji flag if provided (should be 0 or 1)
    if (emoji !== undefined && (typeof emoji !== 'number' || (emoji !== 0 && emoji !== 1))) {
      return res.status(400).json({ error: 'Invalid emoji flag: must be 0 or 1' });
    }

    // Convert destination nodeId to nodeNum if provided
    let destinationNum: number | undefined = undefined;
    if (destination) {
      const nodeIdStr = destination.replace('!', '');
      destinationNum = parseInt(nodeIdStr, 16);
    }

    // Map Primary channel to channel 0 for mesh network
    let meshChannel = channel || 0;
    const allChannels = databaseService.getAllChannels();

    // Find any channel that could be Primary (name="Primary" or name="Channel 0")
    const primaryChannels = allChannels.filter(ch => ch.name === 'Primary' || ch.name === 'Channel 0');
    const isPrimaryChannel = primaryChannels.some(ch => ch.id === channel);

    if (isPrimaryChannel) {
      // User is sending to Primary channel, but mesh expects channel 0
      meshChannel = 0;
    }

    // Send the message to the mesh network (with optional destination for DMs, replyId, and emoji flag)
    // Returns the message ID that was assigned by the firmware
    const messageId = await meshtasticManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji);

    // Save the sent message to database immediately (if local node info is available)
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();

    if (localNodeInfo) {
      const message = {
        id: `${localNodeInfo.nodeNum}_${messageId}`, // Use the real message ID from firmware
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum || 4294967295, // Use destination if provided, otherwise broadcast
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: destination || '!ffffffff',
        text: text,
        // Use channel -1 for direct messages, otherwise use the actual channel
        channel: destination ? -1 : meshChannel,
        portnum: 1, // TEXT_MESSAGE_APP
        timestamp: Date.now(),
        rxTime: Date.now(),
        createdAt: Date.now(),
        replyId: replyId,
        emoji: emoji
      };

      try {
        // Ensure the local node exists in the database
        databaseService.upsertNode({
          nodeNum: localNodeInfo.nodeNum,
          nodeId: localNodeInfo.nodeId,
          longName: localNodeInfo.longName,
          shortName: localNodeInfo.shortName,
          hwModel: localNodeInfo.hwModel
        });

        // Ensure the destination node exists (if it's a DM)
        if (destinationNum && destinationNum !== 4294967295) {
          const destNode = databaseService.getNode(destinationNum);
          if (!destNode) {
            // Create a minimal node entry for the destination
            databaseService.upsertNode({
              nodeNum: destinationNum,
              nodeId: destination || `!${destinationNum.toString(16).padStart(8, '0')}`
            });
          }
        }

        databaseService.insertMessage(message);
        console.log(`💾 Saved sent message to database with ID ${messageId}: "${text.substring(0, 50)}..."`);
      } catch (error) {
        console.warn(`⚠️ Could not save sent message to database:`, error);
      }
    } else {
      console.warn('⚠️ Local node info not available yet, skipping database save');
      console.warn('   Message will be saved when it arrives back from the mesh network');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Traceroute endpoint
apiRouter.post('/traceroute', async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    await meshtasticManager.sendTraceroute(destinationNum, 0);
    res.json({ success: true, message: `Traceroute request sent to ${destinationNum.toString(16)}` });
  } catch (error) {
    console.error('Error sending traceroute:', error);
    res.status(500).json({ error: 'Failed to send traceroute' });
  }
});

// Get recent traceroutes (last 24 hours)
apiRouter.get('/traceroutes/recent', (req, res) => {
  try {
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

    const allTraceroutes = databaseService.getAllTraceroutes(limit);
    const cutoffTime = Date.now() - (hoursParam * 60 * 60 * 1000);

    const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

    const traceroutesWithHops = recentTraceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          hopCount = routeArray.length;
        }
      } catch (e) {
        hopCount = 999;
      }
      return { ...tr, hopCount };
    });

    res.json(traceroutesWithHops);
  } catch (error) {
    console.error('Error fetching recent traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch recent traceroutes' });
  }
});

// Get longest active route segment (within last 7 days)
apiRouter.get('/route-segments/longest-active', (_req, res) => {
  try {
    const segment = databaseService.getLongestActiveRouteSegment();
    if (!segment) {
      res.json(null);
      return;
    }

    // Enrich with node names
    const fromNode = databaseService.getNode(segment.fromNodeNum);
    const toNode = databaseService.getNode(segment.toNodeNum);

    const enrichedSegment = {
      ...segment,
      fromNodeName: fromNode?.longName || segment.fromNodeId,
      toNodeName: toNode?.longName || segment.toNodeId
    };

    res.json(enrichedSegment);
  } catch (error) {
    console.error('Error fetching longest active route segment:', error);
    res.status(500).json({ error: 'Failed to fetch longest active route segment' });
  }
});

// Get record holder route segment
apiRouter.get('/route-segments/record-holder', (_req, res) => {
  try {
    const segment = databaseService.getRecordHolderRouteSegment();
    if (!segment) {
      res.json(null);
      return;
    }

    // Enrich with node names
    const fromNode = databaseService.getNode(segment.fromNodeNum);
    const toNode = databaseService.getNode(segment.toNodeNum);

    const enrichedSegment = {
      ...segment,
      fromNodeName: fromNode?.longName || segment.fromNodeId,
      toNodeName: toNode?.longName || segment.toNodeId
    };

    res.json(enrichedSegment);
  } catch (error) {
    console.error('Error fetching record holder route segment:', error);
    res.status(500).json({ error: 'Failed to fetch record holder route segment' });
  }
});

// Clear record holder route segment
apiRouter.delete('/route-segments/record-holder', (_req, res) => {
  try {
    databaseService.clearRecordHolderSegment();
    res.json({ success: true, message: 'Record holder cleared' });
  } catch (error) {
    console.error('Error clearing record holder:', error);
    res.status(500).json({ error: 'Failed to clear record holder' });
  }
});

// Get telemetry data for a node
apiRouter.get('/telemetry/:nodeId', (req, res) => {
  try {
    const { nodeId } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - (hoursParam * 60 * 60 * 1000);

    // Use averaged query for graph data to reduce data points
    // This ensures max 20 points per hour (60 minutes / 3 minute intervals = 20)
    // Pass hours to apply LIMIT for performance
    const recentTelemetry = databaseService.getTelemetryByNodeAveraged(nodeId, cutoffTime, 3, hoursParam);
    res.json(recentTelemetry);
  } catch (error) {
    console.error('Error fetching telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// Check which nodes have telemetry data
apiRouter.get('/telemetry/available/nodes', (_req, res) => {
  try {
    const nodes = databaseService.getAllNodes();
    const nodesWithTelemetry: string[] = [];
    const nodesWithWeather: string[] = [];

    const weatherTypes = ['temperature', 'humidity', 'pressure'];

    nodes.forEach(node => {
      const telemetry = databaseService.getTelemetryByNode(node.nodeId, 10);
      if (telemetry.length > 0) {
        nodesWithTelemetry.push(node.nodeId);

        // Check if any telemetry is weather-related
        const hasWeather = telemetry.some(t => weatherTypes.includes(t.telemetryType));
        if (hasWeather) {
          nodesWithWeather.push(node.nodeId);
        }
      }
    });

    res.json({
      nodes: nodesWithTelemetry,
      weather: nodesWithWeather
    });
  } catch (error) {
    console.error('Error checking telemetry availability:', error);
    res.status(500).json({ error: 'Failed to check telemetry availability' });
  }
});

// Connection status endpoint
apiRouter.get('/connection', (_req, res) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting connection status:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// Configuration endpoint for frontend
apiRouter.get('/config', (_req, res) => {
  res.json({
    meshtasticNodeIp: process.env.MESHTASTIC_NODE_IP || '192.168.1.100',
    meshtasticTcpPort: parseInt(process.env.MESHTASTIC_TCP_PORT || '4403', 10),
    baseUrl: BASE_URL
  });
});

// Device configuration endpoint
apiRouter.get('/device-config', async (_req, res) => {
  try {
    const config = await meshtasticManager.getDeviceConfig();
    if (config) {
      res.json(config);
    } else {
      res.status(503).json({ error: 'Unable to retrieve device configuration' });
    }
  } catch (error) {
    console.error('Error fetching device config:', error);
    res.status(500).json({ error: 'Failed to fetch device configuration' });
  }
});

// Refresh nodes from device endpoint
apiRouter.post('/nodes/refresh', async (_req, res) => {
  try {
    console.log('🔄 Manual node database refresh requested...');

    // Trigger full node database refresh
    await meshtasticManager.refreshNodeDatabase();

    const nodeCount = databaseService.getNodeCount();
    const channelCount = databaseService.getChannelCount();

    console.log(`✅ Node refresh complete: ${nodeCount} nodes, ${channelCount} channels`);

    res.json({
      success: true,
      nodeCount,
      channelCount,
      message: `Refreshed ${nodeCount} nodes and ${channelCount} channels`
    });
  } catch (error) {
    console.error('❌ Failed to refresh nodes:', error);
    res.status(500).json({
      error: 'Failed to refresh node database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Refresh channels from device endpoint
apiRouter.post('/channels/refresh', async (_req, res) => {
  try {
    console.log('🔄 Manual channel refresh requested...');

    // Trigger full node database refresh (includes channels)
    await meshtasticManager.refreshNodeDatabase();

    const channelCount = databaseService.getChannelCount();

    console.log(`✅ Channel refresh complete: ${channelCount} channels`);

    res.json({
      success: true,
      channelCount,
      message: `Refreshed ${channelCount} channels`
    });
  } catch (error) {
    console.error('❌ Failed to refresh channels:', error);
    res.status(500).json({
      error: 'Failed to refresh channel database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Settings endpoints
apiRouter.post('/settings/traceroute-interval', (req, res) => {
  try {
    const { intervalMinutes } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 1 || intervalMinutes > 60) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 1 and 60 minutes.' });
    }

    meshtasticManager.setTracerouteInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    console.error('Error setting traceroute interval:', error);
    res.status(500).json({ error: 'Failed to set traceroute interval' });
  }
});

// Get all settings
apiRouter.get('/settings', (_req, res) => {
  try {
    const settings = databaseService.getAllSettings();
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Save settings
apiRouter.post('/settings', (req, res) => {
  try {
    const settings = req.body;

    // Validate settings
    const validKeys = ['maxNodeAgeHours', 'tracerouteIntervalMinutes', 'temperatureUnit', 'distanceUnit', 'telemetryVisualizationHours', 'telemetryFavorites'];
    const filteredSettings: Record<string, string> = {};

    for (const key of validKeys) {
      if (key in settings) {
        filteredSettings[key] = String(settings[key]);
      }
    }

    // Save to database
    databaseService.setSettings(filteredSettings);

    // Apply traceroute interval if changed
    if ('tracerouteIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.tracerouteIntervalMinutes);
      if (!isNaN(interval) && interval >= 1 && interval <= 60) {
        meshtasticManager.setTracerouteInterval(interval);
      }
    }

    res.json({ success: true, settings: filteredSettings });
  } catch (error) {
    console.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Reset settings to defaults
apiRouter.delete('/settings', (_req, res) => {
  try {
    databaseService.deleteAllSettings();
    // Reset traceroute interval to default
    meshtasticManager.setTracerouteInterval(3);
    res.json({ success: true, message: 'Settings reset to defaults' });
  } catch (error) {
    console.error('Error resetting settings:', error);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// Danger zone endpoints
apiRouter.post('/purge/nodes', async (_req, res) => {
  try {
    databaseService.purgeAllNodes();
    // Trigger a node refresh after purging
    await meshtasticManager.refreshNodeDatabase();
    res.json({ success: true, message: 'All nodes and traceroutes purged, refresh triggered' });
  } catch (error) {
    console.error('Error purging nodes:', error);
    res.status(500).json({ error: 'Failed to purge nodes' });
  }
});

apiRouter.post('/purge/telemetry', (_req, res) => {
  try {
    databaseService.purgeAllTelemetry();
    res.json({ success: true, message: 'All telemetry data purged' });
  } catch (error) {
    console.error('Error purging telemetry:', error);
    res.status(500).json({ error: 'Failed to purge telemetry' });
  }
});

apiRouter.post('/purge/messages', (_req, res) => {
  try {
    databaseService.purgeAllMessages();
    res.json({ success: true, message: 'All messages purged' });
  } catch (error) {
    console.error('Error purging messages:', error);
    res.status(500).json({ error: 'Failed to purge messages' });
  }
});

// System status endpoint
apiRouter.get('/system/status', (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  let uptimeString = '';
  if (days > 0) uptimeString += `${days}d `;
  if (hours > 0 || days > 0) uptimeString += `${hours}h `;
  if (minutes > 0 || hours > 0 || days > 0) uptimeString += `${minutes}m `;
  uptimeString += `${seconds}s`;

  res.json({
    version: packageJson.version,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    uptime: uptimeString,
    uptimeSeconds,
    environment: process.env.NODE_ENV || 'development',
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    }
  });
});

// Health check endpoint
apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// Serve static files from the React app build
const buildPath = path.join(__dirname, '../../dist');

// Mount API router first - this must come before static file serving
if (BASE_URL) {
  app.use(`${BASE_URL}/api`, apiRouter);
} else {
  app.use('/api', apiRouter);
}

// Function to rewrite HTML with BASE_URL at runtime
const rewriteHtml = (htmlContent: string, baseUrl: string): string => {
  if (!baseUrl) return htmlContent;

  // Replace asset paths in the HTML
  return htmlContent
    .replace(/href="\/assets\//g, `href="${baseUrl}/assets/`)
    .replace(/src="\/assets\//g, `src="${baseUrl}/assets/`)
    .replace(/href="\/vite\.svg"/g, `href="${baseUrl}/vite.svg"`);
};

// Cache for rewritten HTML to avoid repeated file reads
let cachedHtml: string | null = null;
let cachedRewrittenHtml: string | null = null;

// Serve static assets (JS, CSS, images)
if (BASE_URL) {
  // Serve assets folder specifically
  app.use(`${BASE_URL}/assets`, express.static(path.join(buildPath, 'assets')));
  // Serve other static files (like vite.svg) - but exclude /api
  app.use(BASE_URL, (req, res, next) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api')) {
      return next();
    }
    express.static(buildPath, { index: false })(req, res, next);
  });

  // Catch all handler for SPA routing - but exclude /api
  app.get(`${BASE_URL}`, (_req: express.Request, res: express.Response) => {
    // Use cached HTML if available, otherwise read and cache
    if (!cachedRewrittenHtml) {
      const htmlPath = path.join(buildPath, 'index.html');
      cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
      cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL);
    }
    res.type('html').send(cachedRewrittenHtml);
  });
  // Use a route pattern that Express 5 can handle
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Skip if this is not under our BASE_URL
    if (!req.path.startsWith(BASE_URL)) {
      return next();
    }
    // Skip if this is an API route
    if (req.path.startsWith(`${BASE_URL}/api`)) {
      return next();
    }
    // Serve cached rewritten HTML for all other routes under BASE_URL
    if (!cachedRewrittenHtml) {
      const htmlPath = path.join(buildPath, 'index.html');
      cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
      cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL);
    }
    res.type('html').send(cachedRewrittenHtml);
  });
} else {
  // Normal static file serving for root deployment
  app.use(express.static(buildPath));

  // Catch all handler for SPA routing
  app.use((_req: express.Request, res: express.Response) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  meshtasticManager.disconnect();
  databaseService.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  meshtasticManager.disconnect();
  databaseService.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`MeshMonitor server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});