/**
 * Aggregation Routes for MeshManager Integration
 * 
 * Provides aggregation endpoints for MeshManager to collect data from
 * multiple MeshMonitor instances.
 * 
 * Endpoints:
 * - GET /api/aggregate/summary - Aggregated summary
 * - GET /api/aggregate/nodes - All nodes with full details
 * - GET /api/aggregate/messages - All messages (with pagination)
 * - GET /api/aggregate/channels - All configured channels
 * - GET /api/aggregate/stats - Network statistics
 */

import express, { Request, Response, NextFunction } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

/**
 * Optional authentication middleware that supports both session and API key
 * Tries session auth first, then API key from headers
 */
const optionalAuthWithApiKey = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    // Try session authentication first
    if (req.session?.userId) {
      const user = databaseService.userModel.findById(req.session.userId);
      if (user && user.isActive) {
        (req as any).user = user;
        return next();
      }
    }

    // Try API key authentication
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const userId = await databaseService.apiTokenModel.validate(token);
      if (userId) {
        const user = databaseService.userModel.findById(userId);
        if (user && user.isActive) {
          (req as any).user = user;
          return next();
        }
      }
    } else if (apiKeyHeader) {
      const userId = await databaseService.apiTokenModel.validate(apiKeyHeader);
      if (userId) {
        const user = databaseService.userModel.findById(userId);
        if (user && user.isActive) {
          (req as any).user = user;
          return next();
        }
      }
    }

    // If no authentication, attach anonymous user for permission checks
    const anonymousUser = databaseService.userModel.findByUsername('anonymous');
    if (anonymousUser && anonymousUser.isActive) {
      (req as any).user = anonymousUser;
    }

    next();
  } catch (error) {
    logger.error('Error in optionalAuthWithApiKey middleware:', error);
    next();
  }
};

// Apply optional authentication (supports both session and API key)
router.use(optionalAuthWithApiKey);

/**
 * GET /api/aggregate/summary
 * Returns aggregated summary of the mesh network
 */
router.get('/summary', (_req: Request, res: Response) => {
  try {
    const nodeCount = databaseService.getNodeCount();
    const messageCount = databaseService.getMessageCount();
    const channelCount = databaseService.getChannelCount();

    // Get last update time from most recent node or message
    const nodes = databaseService.getAllNodes();
    const messages = databaseService.getMessages(1); // Get most recent message
    
    let lastUpdate: string;
    if (messages.length > 0 && nodes.length > 0) {
      // Messages use milliseconds, nodes use milliseconds for updatedAt
      const lastMessageTime = messages[0].rxTime || messages[0].timestamp;
      const lastNodeTime = Math.max(...nodes.map(n => n.updatedAt || 0));
      lastUpdate = new Date(Math.max(lastMessageTime, lastNodeTime)).toISOString();
    } else if (messages.length > 0) {
      lastUpdate = new Date(messages[0].rxTime || messages[0].timestamp).toISOString();
    } else if (nodes.length > 0) {
      lastUpdate = new Date(Math.max(...nodes.map(n => n.updatedAt || 0))).toISOString();
    } else {
      lastUpdate = new Date().toISOString();
    }

    res.json({
      nodeCount,
      messageCount,
      channelCount,
      lastUpdate,
    });
  } catch (error) {
    logger.error('Error in /api/aggregate/summary:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get summary',
    });
  }
});

/**
 * GET /api/aggregate/nodes
 * Returns all nodes with full details
 */
router.get('/nodes', (_req: Request, res: Response) => {
  try {
    const nodes = databaseService.getAllNodes();
    
    // Transform nodes to match MeshManager's expected format
    const formattedNodes = nodes.map(node => ({
      id: node.nodeId,
      name: node.longName,
      shortName: node.shortName,
      position: node.latitude !== undefined && node.longitude !== undefined ? {
        latitude: node.latitude,
        longitude: node.longitude,
        altitude: node.altitude,
      } : undefined,
      telemetry: {
        batteryLevel: node.batteryLevel,
        voltage: node.voltage,
        channelUtilization: node.channelUtilization,
        airUtilTx: node.airUtilTx,
      },
      lastSeen: node.lastHeard ? new Date(node.lastHeard * 1000).toISOString() : undefined,
      hardwareModel: node.hwModel,
      firmwareVersion: node.firmwareVersion,
      role: node.role,
      nodeNum: node.nodeNum,
      hopsAway: node.hopsAway,
      snr: node.snr,
      rssi: node.rssi,
    }));

    res.json(formattedNodes);
  } catch (error) {
    logger.error('Error in /api/aggregate/nodes:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get nodes',
    });
  }
});

/**
 * GET /api/aggregate/messages
 * Returns all messages with optional pagination and filtering
 * 
 * Query parameters:
 * - limit: number (default: 100)
 * - offset: number (default: 0)
 * - channel: number (optional)
 * - since: ISO 8601 timestamp (optional)
 * - node: string (node ID, optional)
 */
router.get('/messages', (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const channel = req.query.channel ? parseInt(req.query.channel as string, 10) : undefined;
    const since = req.query.since ? new Date(req.query.since as string).getTime() : undefined;
    const nodeId = req.query.node as string | undefined;

    // Validate parameters
    if (isNaN(limit) || limit < 0) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid limit parameter',
      });
    }
    if (isNaN(offset) || offset < 0) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Invalid offset parameter',
      });
    }

    let messages;
    
    // Get messages based on filters
    if (channel !== undefined) {
      messages = databaseService.getMessagesByChannel(channel, limit + offset);
    } else if (since) {
      // Convert ISO 8601 to milliseconds timestamp
      const sinceTimestamp = new Date(since).getTime();
      messages = databaseService.getMessagesAfterTimestamp(sinceTimestamp);
      messages = messages.slice(0, limit + offset);
    } else {
      messages = databaseService.getMessages(limit + offset);
    }

    // Apply node filter if specified
    if (nodeId) {
      messages = messages.filter(m => m.fromNodeId === nodeId || m.toNodeId === nodeId);
    }

    // Apply pagination
    const paginatedMessages = messages.slice(offset, offset + limit);

    // Transform messages to match MeshManager's expected format
    const formattedMessages = paginatedMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId !== '!00000000' ? msg.toNodeId : undefined,
      text: msg.text,
      channel: msg.channel,
      timestamp: new Date(msg.rxTime || msg.timestamp).toISOString(),
      packetId: msg.requestId,
      hopLimit: msg.hopLimit,
      hopStart: msg.hopStart,
    }));

    res.json(formattedMessages);
  } catch (error) {
    logger.error('Error in /api/aggregate/messages:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get messages',
    });
  }
});

/**
 * GET /api/aggregate/channels
 * Returns all configured channels
 */
router.get('/channels', (_req: Request, res: Response) => {
  try {
    const channels = databaseService.getAllChannels();
    
    // Transform channels to match MeshManager's expected format
    const formattedChannels = channels
      .filter(channel => channel.role !== 0) // Exclude disabled channels
      .map(channel => ({
        index: channel.id,
        name: channel.name,
        role: channel.role === 1 ? 'primary' : channel.role === 2 ? 'secondary' : undefined,
        uplinkEnabled: channel.uplinkEnabled,
        downlinkEnabled: channel.downlinkEnabled,
        positionPrecision: channel.positionPrecision,
      }));

    res.json(formattedChannels);
  } catch (error) {
    logger.error('Error in /api/aggregate/channels:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get channels',
    });
  }
});

/**
 * GET /api/aggregate/stats
 * Returns network statistics
 */
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const totalMessages = databaseService.getMessageCount();
    const totalNodes = databaseService.getNodeCount();
    const channelCount = databaseService.getChannelCount();

    // Calculate uptime (server start time) - will be set by server.ts
    const serverStartTime = (global as any).serverStartTime || Date.now();
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);

    // Calculate message rate (messages per second)
    const messageRate = uptime > 0 ? totalMessages / uptime : 0;

    // Get first and last message timestamps
    const messages = databaseService.getMessages(1);
    const lastMessageTime = messages.length > 0 
      ? new Date(messages[0].rxTime || messages[0].timestamp).toISOString() 
      : undefined;

    // Get first message (oldest) - need to get all and find oldest
    const allMessages = databaseService.getMessages(10000);
    const firstMessageTime = allMessages.length > 0 
      ? new Date(allMessages[allMessages.length - 1].rxTime || allMessages[allMessages.length - 1].timestamp).toISOString() 
      : undefined;

    res.json({
      totalMessages,
      totalNodes,
      channelCount,
      uptime,
      messageRate,
      nodeCount: totalNodes, // Alias for consistency
      lastMessageTime,
      firstMessageTime,
    });
  } catch (error) {
    logger.error('Error in /api/aggregate/stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to get stats',
    });
  }
});

export default router;

