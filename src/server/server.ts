import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import meshtasticManager from './meshtasticManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

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

// Serve static files from the React app build
const buildPath = path.join(__dirname, '../../dist');
app.use(express.static(buildPath));

// API Routes
app.get('/api/nodes', (_req, res) => {
  try {
    const nodes = meshtasticManager.getAllNodes();
    res.json(nodes);
  } catch (error) {
    console.error('Error fetching nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

app.get('/api/nodes/active', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const nodes = databaseService.getActiveNodes(days);
    res.json(nodes);
  } catch (error) {
    console.error('Error fetching active nodes:', error);
    res.status(500).json({ error: 'Failed to fetch active nodes' });
  }
});

app.get('/api/messages', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const messages = meshtasticManager.getRecentMessages(limit);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.get('/api/messages/channel/:channel', (req, res) => {
  try {
    const channel = parseInt(req.params.channel);
    const limit = parseInt(req.query.limit as string) || 100;
    const messages = databaseService.getMessagesByChannel(channel, limit);
    res.json(messages);
  } catch (error) {
    console.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

app.get('/api/messages/direct/:nodeId1/:nodeId2', (req, res) => {
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

app.get('/api/channels', (_req, res) => {
  try {
    const channels = databaseService.getAllChannels();
    res.json(channels);
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

app.get('/api/stats', (_req, res) => {
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

app.post('/api/export', (_req, res) => {
  try {
    const data = databaseService.exportData();
    res.json(data);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const data = req.body;
    databaseService.importData(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

app.post('/api/cleanup/messages', (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupOldMessages(days);
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Failed to cleanup messages' });
  }
});

app.post('/api/cleanup/nodes', (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupInactiveNodes(days);
    res.json({ deletedCount });
  } catch (error) {
    console.error('Error cleaning up nodes:', error);
    res.status(500).json({ error: 'Failed to cleanup nodes' });
  }
});


// Send message endpoint
app.post('/api/messages/send', async (req, res) => {
  try {
    const { text, channel } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Message text is required' });
    }

    await meshtasticManager.sendTextMessage(text, channel || 0);
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Connection status endpoint
app.get('/api/connection', (_req, res) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting connection status:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// Configuration endpoint for frontend
app.get('/api/config', (_req, res) => {
  res.json({
    meshtasticNodeIp: process.env.MESHTASTIC_NODE_IP || '192.168.1.100',
    meshtasticUseTls: process.env.MESHTASTIC_USE_TLS === 'true'
  });
});

// Device configuration endpoint
app.get('/api/device-config', async (_req, res) => {
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

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// Catch all handler: send back React's index.html file for client-side routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

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