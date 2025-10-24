import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import meshtasticManager from './meshtasticManager.js';
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import { getSessionConfig } from './auth/sessionConfig.js';
import { initializeOIDC } from './auth/oidcAuth.js';
import {
  optionalAuth,
  requireAuth,
  requirePermission,
  requireAdmin,
  hasPermission
} from './auth/authMiddleware.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { setupAccessLogger } from './middleware/accessLogger.js';
import { getEnvironmentConfig } from './config/environment.js';
import { pushNotificationService } from './services/pushNotificationService.js';
import { appriseNotificationService } from './services/appriseNotificationService.js';
import { getUserNotificationPreferences, saveUserNotificationPreferences } from './utils/notificationFiltering.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment configuration
const env = getEnvironmentConfig();

const app = express();
const PORT = env.port;
const BASE_URL = env.baseUrl;
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

// Trust proxy configuration for reverse proxy deployments
// When behind a reverse proxy (nginx, Traefik, etc.), this allows Express to:
// - Read X-Forwarded-* headers to determine the actual client protocol/IP
// - Set secure cookies correctly when the proxy terminates HTTPS
if (env.trustProxyProvided) {
  app.set('trust proxy', env.trustProxy);
  logger.debug(`✅ Trust proxy configured: ${env.trustProxy}`);
} else if (env.isProduction) {
  // Default: trust first proxy in production (common reverse proxy setup)
  app.set('trust proxy', 1);
  logger.debug('ℹ️  Trust proxy defaulted to 1 hop (production mode)');
}

// Security: Helmet.js for HTTP security headers
// Use relaxed settings in development to avoid HTTPS enforcement
// For Quick Start: default to HTTP-friendly (no HSTS) even in production
// Only enable HSTS when COOKIE_SECURE explicitly set to 'true'
const helmetConfig = env.isProduction && env.cookieSecure
  ? {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],  // React uses inline styles
          imgSrc: [
            "'self'",
            "data:",
            "https:",
            "https://*.tile.openstreetmap.org",  // OpenStreetMap tiles
            "https://*.basemaps.cartocdn.com",   // CartoDB tiles
            "https://*.tile.opentopomap.org",    // OpenTopoMap tiles
            "https://server.arcgisonline.com"    // Esri tiles
          ],
          connectSrc: [
            "'self'",
            "https://*.tile.openstreetmap.org",  // OpenStreetMap tiles
            "https://*.basemaps.cartocdn.com",   // CartoDB tiles
            "https://*.tile.opentopomap.org",    // OpenTopoMap tiles
            "https://server.arcgisonline.com"    // Esri tiles
          ],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"]
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true
      },
      frameguard: {
        action: 'deny' as const
      },
      noSniff: true,
      xssFilter: true
    }
  : {
      // Development or HTTP-only: Relaxed CSP, no HSTS, no upgrade-insecure-requests
      contentSecurityPolicy: {
        useDefaults: false,  // Don't use default directives that include upgrade-insecure-requests
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "http:", "https:"],
          connectSrc: [
            "'self'",
            "https://*.tile.openstreetmap.org",  // OpenStreetMap tiles
            "http://*.tile.openstreetmap.org"    // HTTP fallback for development
          ],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"]
          // upgradeInsecureRequests intentionally omitted for HTTP
        },
      },
      hsts: false, // Disable HSTS when not using secure cookies or in development
      frameguard: {
        action: 'deny' as const
      },
      noSniff: true,
      xssFilter: true
    };

app.use(helmet(helmetConfig));

// Security: CORS configuration with allowed origins
const getAllowedOrigins = () => {
  const origins = [...env.allowedOrigins];
  // Always allow localhost in development
  if (env.isDevelopment) {
    origins.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080');
  }
  return origins.length > 0 ? origins : ['http://localhost:3000'];
};

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();

    // Allow requests with no origin (mobile apps, Postman, same-origin)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      logger.warn(`CORS request blocked from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

// Access logging for fail2ban (optional, configured via ACCESS_LOG_ENABLED)
const accessLogger = setupAccessLogger();
if (accessLogger) {
  app.use(accessLogger);
}

// Security: Request body size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true, parameterLimit: 1000 }));

// Session middleware
app.use(session(getSessionConfig()));

// Security: CSRF protection middleware
import { csrfTokenMiddleware, csrfProtection, csrfTokenEndpoint } from './middleware/csrf.js';
app.use(csrfTokenMiddleware);  // Generate and attach tokens to all requests
// csrfProtection applied to API routes below (after CSRF token endpoint)

// Initialize OIDC if configured
initializeOIDC().then(enabled => {
  if (enabled) {
    logger.debug('✅ OIDC authentication enabled');
  } else {
    logger.debug('ℹ️  OIDC authentication disabled (not configured)');
  }
}).catch(error => {
  logger.error('Failed to initialize OIDC:', error);
});

// Initialize Meshtastic connection
setTimeout(async () => {
  try {
    // Load saved traceroute interval from database before connecting
    const savedInterval = databaseService.getSetting('tracerouteIntervalMinutes');
    if (savedInterval !== null) {
      const intervalMinutes = parseInt(savedInterval);
      if (!isNaN(intervalMinutes) && intervalMinutes >= 0 && intervalMinutes <= 60) {
        meshtasticManager.setTracerouteInterval(intervalMinutes);
        logger.debug(`✅ Loaded saved traceroute interval: ${intervalMinutes} minutes${intervalMinutes === 0 ? ' (disabled)' : ''}`);
      }
    }

    await meshtasticManager.connect();
    logger.debug('Meshtastic manager connected successfully');
  } catch (error) {
    logger.error('Failed to connect to Meshtastic node on startup:', error);
  }
}, 1000);

// Schedule hourly telemetry purge to keep database performant
// Keep telemetry for 7 days (168 hours) by default
const TELEMETRY_RETENTION_HOURS = 168; // 7 days
setInterval(() => {
  try {
    const purgedCount = databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS);
    if (purgedCount > 0) {
      logger.debug(`⏰ Hourly telemetry purge completed: removed ${purgedCount} records`);
    }
  } catch (error) {
    logger.error('Error during telemetry purge:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Run initial purge on startup
setTimeout(() => {
  try {
    databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS);
  } catch (error) {
    logger.error('Error during initial telemetry purge:', error);
  }
}, 5000); // Wait 5 seconds after startup

// Create router for API routes
const apiRouter = express.Router();

// Import route handlers
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import packetRoutes from './routes/packetRoutes.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Authentication routes
apiRouter.use('/auth', authRoutes);

// User management routes (admin only)
apiRouter.use('/users', userRoutes);

// Audit log routes (admin only)
apiRouter.use('/audit', auditRoutes);

// Packet log routes (requires channels:read AND messages:read)
apiRouter.use('/packets', optionalAuth(), packetRoutes);

// API Routes
apiRouter.get('/nodes', optionalAuth(), (_req, res) => {
  try {
    const nodes = meshtasticManager.getAllNodes();

    // Enhance nodes with mobility detection and estimated positions
    const enhancedNodes = nodes.map(node => {
      if (!node.user?.id) return { ...node, isMobile: false };

      // Check position telemetry for this node
      const positionTelemetry = databaseService.getTelemetryByNode(node.user.id, 100);
      const latitudes = positionTelemetry.filter(t => t.telemetryType === 'latitude');
      const longitudes = positionTelemetry.filter(t => t.telemetryType === 'longitude');
      const estimatedLatitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_latitude');
      const estimatedLongitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_longitude');

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

      // If node doesn't have a regular position, check for estimated position
      let enhancedNode = { ...node, isMobile };
      if (!node.position?.latitude && !node.position?.longitude &&
          estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
        // Use the most recent estimated position
        const latestEstimatedLat = estimatedLatitudes[0]; // getTelemetryByNode returns most recent first
        const latestEstimatedLon = estimatedLongitudes[0];

        enhancedNode.position = {
          latitude: latestEstimatedLat.value,
          longitude: latestEstimatedLon.value,
          altitude: node.position?.altitude
        };
      }

      return enhancedNode;
    });

    logger.debug('🔍 Sending nodes to frontend, sample node:', enhancedNodes[0] ? {
      nodeNum: enhancedNodes[0].nodeNum,
      longName: enhancedNodes[0].user?.longName,
      role: enhancedNodes[0].user?.role,
      hopsAway: enhancedNodes[0].hopsAway,
      isMobile: enhancedNodes[0].isMobile
    } : 'No nodes');
    res.json(enhancedNodes);
  } catch (error) {
    logger.error('Error fetching nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

apiRouter.get('/nodes/active', optionalAuth(), (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const nodes = databaseService.getActiveNodes(days);
    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching active nodes:', error);
    res.status(500).json({ error: 'Failed to fetch active nodes' });
  }
});

// Get position history for a node (for mobile node visualization)
apiRouter.get('/nodes/:nodeId/position-history', optionalAuth(), (req, res) => {
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
    logger.error('Error fetching position history:', error);
    res.status(500).json({ error: 'Failed to fetch position history' });
  }
});

// Standardized error response types for better client-side handling
interface ApiErrorResponse {
  error: string;
  code: string;
  details?: string;
}

// Set node favorite status (with optional device sync)
apiRouter.post('/nodes/:nodeId/favorite', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { isFavorite, syncToDevice = true } = req.body;

    if (typeof isFavorite !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isFavorite must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isFavorite parameter'
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)'
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Update favorite status in database
    databaseService.setNodeFavorite(nodeNum, isFavorite);

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      try {
        if (isFavorite) {
          await meshtasticManager.sendFavoriteNode(nodeNum);
        } else {
          await meshtasticManager.sendRemoveFavoriteNode(nodeNum);
        }
        deviceSyncStatus = 'success';
        logger.debug(`✅ Synced favorite status to device for node ${nodeNum}`);
      } catch (error) {
        // Special handling for firmware version incompatibility
        if (error instanceof Error && error.message === 'FIRMWARE_NOT_SUPPORTED') {
          deviceSyncStatus = 'skipped';
          logger.debug(`ℹ️ Device sync skipped for node ${nodeNum}: firmware does not support favorites (requires >= 2.7.0)`);
          // Don't set deviceSyncError - this is expected behavior for pre-2.7 firmware
        } else {
          deviceSyncStatus = 'failed';
          deviceSyncError = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`⚠️ Failed to sync favorite to device for node ${nodeNum}:`, error);
        }
        // Don't fail the whole request if device sync fails
      }
    }

    res.json({
      success: true,
      nodeNum,
      isFavorite,
      deviceSync: {
        status: deviceSyncStatus,
        error: deviceSyncError
      }
    });
  } catch (error) {
    logger.error('Error setting node favorite:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node favorite',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred'
    };
    res.status(500).json(errorResponse);
  }
});

apiRouter.get('/messages', optionalAuth(), (req, res) => {
  try {
    // Check if user has either channels or messages permission
    const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channels', 'read');
    const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channels or messages', action: 'read' }
      });
    }

    const limit = parseInt(req.query.limit as string) || 100;
    let messages = meshtasticManager.getRecentMessages(limit);

    // Filter messages based on permissions
    // If user only has channels permission, exclude direct messages (channel -1)
    // If user only has messages permission, only include direct messages (channel -1)
    if (hasChannelsRead && !hasMessagesRead) {
      // Only channel messages
      messages = messages.filter(msg => msg.channel !== -1);
    } else if (hasMessagesRead && !hasChannelsRead) {
      // Only direct messages
      messages = messages.filter(msg => msg.channel === -1);
    }
    // If both permissions, return all messages

    res.json(messages);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

apiRouter.get('/messages/channel/:channel', requirePermission('channels', 'read'), (req, res) => {
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
    logger.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

apiRouter.get('/messages/direct/:nodeId1/:nodeId2', requirePermission('messages', 'read'), (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const messages = databaseService.getDirectMessages(nodeId1, nodeId2, limit);
    res.json(messages);
  } catch (error) {
    logger.error('Error fetching direct messages:', error);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

// Mark messages as read
apiRouter.post('/messages/mark-read', optionalAuth(), (req, res) => {
  try {
    // Check if user has either channels or messages permission
    const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channels', 'read');
    const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channels or messages', action: 'read' }
      });
    }

    const userId = req.user?.id ?? null;
    const { messageIds, channelId, nodeId, beforeTimestamp } = req.body;
    let markedCount = 0;

    if (messageIds && Array.isArray(messageIds)) {
      // Mark specific messages as read
      databaseService.markMessagesAsRead(messageIds, userId);
      markedCount = messageIds.length;
    } else if (channelId !== undefined) {
      // Mark all messages in a channel as read
      if (!hasChannelsRead) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'channels', action: 'read' }
        });
      }
      markedCount = databaseService.markChannelMessagesAsRead(channelId, userId, beforeTimestamp);
    } else if (nodeId) {
      // Mark all DMs with a node as read
      if (!hasMessagesRead) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'read' }
        });
      }
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = databaseService.markDMMessagesAsRead(localNodeInfo.nodeId, nodeId, userId, beforeTimestamp);
    } else {
      return res.status(400).json({ error: 'Must provide messageIds, channelId, or nodeId' });
    }

    res.json({ marked: markedCount });
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Get unread message counts
apiRouter.get('/messages/unread-counts', optionalAuth(), (req, res) => {
  try {
    // Check if user has either channels or messages permission
    const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channels', 'read');
    const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channels or messages', action: 'read' }
      });
    }

    const userId = req.user?.id ?? null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();

    const result: {
      channels?: {[channelId: number]: number},
      directMessages?: {[nodeId: string]: number}
    } = {};

    // Get channel unread counts if user has channels permission
    if (hasChannelsRead) {
      result.channels = databaseService.getUnreadCountsByChannel(userId);
    }

    // Get DM unread counts if user has messages permission
    if (hasMessagesRead && localNodeInfo) {
      const directMessages: {[nodeId: string]: number} = {};
      // Get all nodes that have DMs
      const allNodes = meshtasticManager.getAllNodes();
      for (const node of allNodes) {
        if (node.user?.id) {
          const count = databaseService.getUnreadDMCount(localNodeInfo.nodeId, node.user.id, userId);
          if (count > 0) {
            directMessages[node.user.id] = count;
          }
        }
      }
      result.directMessages = directMessages;
    }

    res.json(result);
  } catch (error) {
    logger.error('Error fetching unread counts:', error);
    res.status(500).json({ error: 'Failed to fetch unread counts' });
  }
});

// Debug endpoint to see all channels
apiRouter.get('/channels/debug', requirePermission('messages', 'read'), (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();
    logger.debug('🔍 DEBUG: All channels in database:', allChannels);
    res.json(allChannels);
  } catch (error) {
    logger.error('Error fetching debug channels:', error);
    res.status(500).json({ error: 'Failed to fetch debug channels' });
  }
});

// Get all channels (unfiltered, for export/config purposes)
apiRouter.get('/channels/all', requirePermission('channels', 'read'), (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();
    logger.debug(`📡 Serving all ${allChannels.length} channels (unfiltered)`);
    res.json(allChannels);
  } catch (error) {
    logger.error('Error fetching all channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

apiRouter.get('/channels', requirePermission('channels', 'read'), (_req, res) => {
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
        logger.debug('📡 Created missing Primary channel with ID 0');
      } catch (error) {
        logger.error('❌ Failed to create Primary channel:', error);
      }
    } else if (primaryChannels.length === 1) {
      // Single channel - rename if needed
      const primaryChannel = primaryChannels[0];
      if (primaryChannel.name === 'Channel 0') {
        try {
          const updatedChannel = { ...primaryChannel, name: 'Primary' };
          databaseService.upsertChannel(updatedChannel);
          primaryChannel.name = 'Primary'; // Update in memory
          logger.debug('📡 Renamed "Channel 0" to "Primary"');
        } catch (error) {
          logger.error('❌ Failed to rename channel to Primary:', error);
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
          logger.debug('📡 Renamed primary channel to "Primary"');
        } catch (error) {
          logger.error('❌ Failed to rename primary channel:', error);
        }
      }

      // Remove duplicates by filtering them out from the allChannels array
      for (const duplicate of removeChannels) {
        const index = allChannels.findIndex(ch => ch.id === duplicate.id);
        if (index > -1) {
          allChannels.splice(index, 1);
          logger.debug(`📡 Removed duplicate Primary channel (id=${duplicate.id})`);
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

    logger.debug(`📡 Serving ${filteredChannels.length} filtered channels (from ${allChannels.length} total)`);
    logger.debug(`🔍 All channels in DB:`, allChannels.map(ch => ({ id: ch.id, name: ch.name })));
    logger.debug(`🔍 Filtered channels:`, filteredChannels.map(ch => ({ id: ch.id, name: ch.name })));
    res.json(filteredChannels);
  } catch (error) {
    logger.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Export a specific channel configuration
apiRouter.get('/channels/:id/export', requirePermission('channels', 'read'), (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    const channel = databaseService.getChannelById(channelId);
    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    logger.info(`📤 Exporting channel ${channelId} (${channel.name}):`, {
      role: channel.role,
      positionPrecision: channel.positionPrecision,
      uplinkEnabled: channel.uplinkEnabled,
      downlinkEnabled: channel.downlinkEnabled
    });

    // Create export data with metadata
    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      channel: {
        id: channel.id,
        name: channel.name,
        psk: channel.psk,
        role: channel.role,
        uplinkEnabled: channel.uplinkEnabled,
        downlinkEnabled: channel.downlinkEnabled,
        positionPrecision: channel.positionPrecision
      }
    };

    // Set filename header
    const filename = `meshmonitor-channel-${channel.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (error) {
    logger.error('Error exporting channel:', error);
    res.status(500).json({ error: 'Failed to export channel' });
  }
});

// Update a channel configuration
apiRouter.put('/channels/:id', requirePermission('channels', 'write'), async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0 || channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID. Must be between 0-7' });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = req.body;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    if (name.length > 11) {
      return res.status(400).json({ error: 'Channel name must be 11 characters or less' });
    }

    // Validate PSK if provided
    if (psk !== undefined && psk !== null && typeof psk !== 'string') {
      return res.status(400).json({ error: 'Invalid PSK format' });
    }

    // Validate role if provided
    if (role !== undefined && role !== null && (typeof role !== 'number' || role < 0 || role > 2)) {
      return res.status(400).json({ error: 'Invalid role. Must be 0 (Disabled), 1 (Primary), or 2 (Secondary)' });
    }

    // Validate positionPrecision if provided
    if (positionPrecision !== undefined && positionPrecision !== null && (typeof positionPrecision !== 'number' || positionPrecision < 0 || positionPrecision > 32)) {
      return res.status(400).json({ error: 'Invalid position precision. Must be between 0-32' });
    }

    // Get existing channel
    const existingChannel = databaseService.getChannelById(channelId);
    if (!existingChannel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Update channel in database (treat null and undefined the same way)
    databaseService.upsertChannel({
      id: channelId,
      name,
      psk: (psk !== undefined && psk !== null) ? psk : existingChannel.psk,
      role: (role !== undefined && role !== null) ? role : existingChannel.role,
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : existingChannel.uplinkEnabled,
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : existingChannel.downlinkEnabled,
      positionPrecision: (positionPrecision !== undefined && positionPrecision !== null) ? positionPrecision : existingChannel.positionPrecision
    });

    // TODO: Send channel configuration to Meshtastic device
    // This would require implementing setChannelConfig in meshtasticManager
    // For now, we only update the database

    const updatedChannel = databaseService.getChannelById(channelId);
    logger.info(`✅ Updated channel ${channelId}: ${name}`);
    res.json({ success: true, channel: updatedChannel });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Import a channel configuration to a specific slot
apiRouter.post('/channels/:slotId/import', requirePermission('channels', 'write'), async (req, res) => {
  try {
    const slotId = parseInt(req.params.slotId);
    if (isNaN(slotId) || slotId < 0 || slotId > 7) {
      return res.status(400).json({ error: 'Invalid slot ID. Must be between 0-7' });
    }

    const { channel } = req.body;

    if (!channel || typeof channel !== 'object') {
      return res.status(400).json({ error: 'Invalid import data. Expected channel object' });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = channel;

    // Validate required fields
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Channel name is required' });
    }

    if (name.length > 11) {
      return res.status(400).json({ error: 'Channel name must be 11 characters or less' });
    }

    // Validate role if provided (handle both null and undefined as "not provided")
    if (role !== null && role !== undefined) {
      if (typeof role !== 'number' || role < 0 || role > 2) {
        return res.status(400).json({ error: 'Channel role must be 0 (Disabled), 1 (Primary), or 2 (Secondary)' });
      }
    }

    // Validate positionPrecision if provided (handle both null and undefined as "not provided")
    if (positionPrecision !== null && positionPrecision !== undefined) {
      if (typeof positionPrecision !== 'number' || positionPrecision < 0 || positionPrecision > 32) {
        return res.status(400).json({ error: 'Position precision must be between 0-32 bits' });
      }
    }

    // Import channel to the specified slot
    databaseService.upsertChannel({
      id: slotId,
      name,
      psk: psk || undefined,
      role: (role !== null && role !== undefined) ? role : undefined,
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : true,
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : true,
      positionPrecision: (positionPrecision !== null && positionPrecision !== undefined) ? positionPrecision : undefined
    });

    // TODO: Send channel configuration to Meshtastic device
    // This would require implementing setChannelConfig in meshtasticManager

    const importedChannel = databaseService.getChannelById(slotId);
    logger.info(`✅ Imported channel to slot ${slotId}: ${name}`);
    res.json({ success: true, channel: importedChannel });
  } catch (error) {
    logger.error('Error importing channel:', error);
    res.status(500).json({ error: 'Failed to import channel' });
  }
});

// Decode Meshtastic channel URL for preview
apiRouter.post('/channels/decode-url', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const channelUrlService = (await import('./services/channelUrlService.js')).default;
    const decoded = channelUrlService.decodeUrl(url);

    if (!decoded) {
      return res.status(400).json({ error: 'Invalid or malformed Meshtastic URL' });
    }

    res.json(decoded);
  } catch (error) {
    logger.error('Error decoding channel URL:', error);
    res.status(500).json({ error: 'Failed to decode channel URL' });
  }
});

// Encode current configuration to Meshtastic URL
apiRouter.post('/channels/encode-url', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const { channelIds, includeLoraConfig } = req.body;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Get selected channels from database
    const channels = channelIds
      .map((id: number) => databaseService.getChannelById(id))
      .filter((ch): ch is NonNullable<typeof ch> => ch !== null)
      .map(ch => ({
        psk: ch.psk ? ch.psk : 'none',
        name: ch.name, // Use the actual name from database (preserved from device)
        uplinkEnabled: ch.uplinkEnabled,
        downlinkEnabled: ch.downlinkEnabled,
        positionPrecision: ch.positionPrecision
      }));

    if (channels.length === 0) {
      return res.status(400).json({ error: 'No valid channels selected' });
    }

    // Get LoRa config if requested
    let loraConfig = undefined;
    if (includeLoraConfig) {
      logger.info('📡 includeLoraConfig is TRUE, fetching device config...');
      const deviceConfig = await meshtasticManager.getDeviceConfig();
      logger.info('📡 Device config lora:', JSON.stringify(deviceConfig?.lora, null, 2));
      if (deviceConfig?.lora) {
        loraConfig = {
          usePreset: deviceConfig.lora.usePreset,
          modemPreset: deviceConfig.lora.modemPreset,
          bandwidth: deviceConfig.lora.bandwidth,
          spreadFactor: deviceConfig.lora.spreadFactor,
          codingRate: deviceConfig.lora.codingRate,
          frequencyOffset: deviceConfig.lora.frequencyOffset,
          region: deviceConfig.lora.region,
          hopLimit: deviceConfig.lora.hopLimit,
          txEnabled: deviceConfig.lora.txEnabled,
          txPower: deviceConfig.lora.txPower,
          channelNum: deviceConfig.lora.channelNum,
          sx126xRxBoostedGain: deviceConfig.lora.sx126xRxBoostedGain,
          configOkToMqtt: deviceConfig.lora.configOkToMqtt
        };
        logger.info('📡 LoRa config to encode:', JSON.stringify(loraConfig, null, 2));
      } else {
        logger.warn('⚠️ Device config or lora config is missing');
      }
    } else {
      logger.info('📡 includeLoraConfig is FALSE, skipping LoRa config');
    }

    const url = channelUrlService.encodeUrl(channels, loraConfig);

    if (!url) {
      return res.status(500).json({ error: 'Failed to encode URL' });
    }

    res.json({ url });
  } catch (error) {
    logger.error('Error encoding channel URL:', error);
    res.status(500).json({ error: 'Failed to encode channel URL' });
  }
});

apiRouter.get('/stats', requirePermission('dashboard', 'read'), (_req, res) => {
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
    logger.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

apiRouter.post('/export', requireAdmin(), (_req, res) => {
  try {
    const data = databaseService.exportData();
    res.json(data);
  } catch (error) {
    logger.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

apiRouter.post('/import', requireAdmin(), (req, res) => {
  try {
    const data = req.body;
    databaseService.importData(data);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

apiRouter.post('/cleanup/messages', requireAdmin(), (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupOldMessages(days);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Failed to cleanup messages' });
  }
});

apiRouter.post('/cleanup/nodes', requireAdmin(), (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const deletedCount = databaseService.cleanupInactiveNodes(days);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up nodes:', error);
    res.status(500).json({ error: 'Failed to cleanup nodes' });
  }
});

apiRouter.post('/cleanup/channels', requireAdmin(), (_req, res) => {
  try {
    const deletedCount = databaseService.cleanupInvalidChannels();
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up channels:', error);
    res.status(500).json({ error: 'Failed to cleanup channels' });
  }
});


// Send message endpoint
apiRouter.post('/messages/send', requirePermission('messages', 'write'), async (req, res) => {
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
    // Note: sendTextMessage() now handles saving the message to the database
    // Pass userId so sent messages are automatically marked as read for the sender
    await meshtasticManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Traceroute endpoint
apiRouter.post('/traceroute', requirePermission('traceroute', 'write'), async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    await meshtasticManager.sendTraceroute(destinationNum, 0);
    res.json({ success: true, message: `Traceroute request sent to ${destinationNum.toString(16)}` });
  } catch (error) {
    logger.error('Error sending traceroute:', error);
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
    logger.error('Error fetching recent traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch recent traceroutes' });
  }
});

// Get longest active route segment (within last 7 days)
apiRouter.get('/route-segments/longest-active', requirePermission('info', 'read'), (_req, res) => {
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
    logger.error('Error fetching longest active route segment:', error);
    res.status(500).json({ error: 'Failed to fetch longest active route segment' });
  }
});

// Get record holder route segment
apiRouter.get('/route-segments/record-holder', requirePermission('info', 'read'), (_req, res) => {
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
    logger.error('Error fetching record holder route segment:', error);
    res.status(500).json({ error: 'Failed to fetch record holder route segment' });
  }
});

// Clear record holder route segment
apiRouter.delete('/route-segments/record-holder', requirePermission('info', 'write'), (_req, res) => {
  try {
    databaseService.clearRecordHolderSegment();
    res.json({ success: true, message: 'Record holder cleared' });
  } catch (error) {
    logger.error('Error clearing record holder:', error);
    res.status(500).json({ error: 'Failed to clear record holder' });
  }
});

// Get all neighbor info (latest per node pair)
apiRouter.get('/neighbor-info', requirePermission('info', 'read'), (_req, res) => {
  try {
    const neighborInfo = databaseService.getLatestNeighborInfoPerNode();

    // Enrich with node names
    const enrichedNeighborInfo = neighborInfo.map(ni => {
      const node = databaseService.getNode(ni.nodeNum);
      const neighbor = databaseService.getNode(ni.neighborNodeNum);

      return {
        ...ni,
        nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
        nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        nodeLatitude: node?.latitude,
        nodeLongitude: node?.longitude,
        neighborLatitude: neighbor?.latitude,
        neighborLongitude: neighbor?.longitude
      };
    });

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});

// Get neighbor info for a specific node
apiRouter.get('/neighbor-info/:nodeNum', requirePermission('info', 'read'), (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum);
    const neighborInfo = databaseService.getNeighborsForNode(nodeNum);

    // Enrich with node names
    const enrichedNeighborInfo = neighborInfo.map(ni => {
      const neighbor = databaseService.getNode(ni.neighborNodeNum);

      return {
        ...ni,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborLatitude: neighbor?.latitude,
        neighborLongitude: neighbor?.longitude
      };
    });

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info for node:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info for node' });
  }
});

// Get telemetry data for a node
apiRouter.get('/telemetry/:nodeId', optionalAuth(), (req, res) => {
  try {
    // Allow users with info read OR dashboard read (dashboard needs telemetry data)
    if (!req.user?.isAdmin &&
        !hasPermission(req.user!, 'info', 'read') &&
        !hasPermission(req.user!, 'dashboard', 'read')) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

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
    logger.error('Error fetching telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// Check which nodes have telemetry data
apiRouter.get('/telemetry/available/nodes', requirePermission('info', 'read'), (_req, res) => {
  try {
    const nodes = databaseService.getAllNodes();
    const nodesWithTelemetry: string[] = [];
    const nodesWithWeather: string[] = [];
    const nodesWithEstimatedPosition: string[] = [];

    const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);
    const estimatedPositionTypes = new Set(['estimated_latitude', 'estimated_longitude']);

    // Efficient bulk query: get all telemetry types for all nodes at once
    const nodeTelemetryTypes = databaseService.getAllNodesTelemetryTypes();

    nodes.forEach(node => {
      const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
      if (telemetryTypes && telemetryTypes.length > 0) {
        nodesWithTelemetry.push(node.nodeId);

        // Check if any telemetry type is weather-related
        const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
        if (hasWeather) {
          nodesWithWeather.push(node.nodeId);
        }

        // Check if node has estimated position telemetry
        const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
        if (hasEstimatedPosition) {
          nodesWithEstimatedPosition.push(node.nodeId);
        }
      }
    });

    // Check for PKC-enabled nodes
    const nodesWithPKC: string[] = [];
    nodes.forEach(node => {
      if (node.hasPKC || node.publicKey) {
        nodesWithPKC.push(node.nodeId);
      }
    });

    res.json({
      nodes: nodesWithTelemetry,
      weather: nodesWithWeather,
      estimatedPosition: nodesWithEstimatedPosition,
      pkc: nodesWithPKC
    });
  } catch (error) {
    logger.error('Error checking telemetry availability:', error);
    res.status(500).json({ error: 'Failed to check telemetry availability' });
  }
});

// Connection status endpoint
apiRouter.get('/connection', optionalAuth(), (_req, res) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error getting connection status:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// User-initiated disconnect endpoint
apiRouter.post('/connection/disconnect', requirePermission('connection', 'write'), async (req, res) => {
  try {
    await meshtasticManager.userDisconnect();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'connection_disconnected',
      'connection',
      'User initiated disconnect',
      req.ip || null
    );

    res.json({ success: true, status: 'user-disconnected' });
  } catch (error) {
    logger.error('Error disconnecting:', error);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// User-initiated reconnect endpoint
apiRouter.post('/connection/reconnect', requirePermission('connection', 'write'), async (req, res) => {
  try {
    const success = await meshtasticManager.userReconnect();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'connection_reconnected',
      'connection',
      JSON.stringify({ success }),
      req.ip || null
    );

    res.json({
      success,
      status: success ? 'connecting' : 'disconnected'
    });
  } catch (error) {
    logger.error('Error reconnecting:', error);
    res.status(500).json({ error: 'Failed to reconnect' });
  }
});

// Configuration endpoint for frontend
apiRouter.get('/config', optionalAuth(), async (_req, res) => {
  try {
    // Get the local node number from settings to include rebootCount
    const localNodeNumStr = databaseService.getSetting('localNodeNum');

    let deviceMetadata = undefined;
    let localNodeInfo = undefined;
    if (localNodeNumStr) {
      const localNodeNum = parseInt(localNodeNumStr, 10);
      const currentNode = databaseService.getNode(localNodeNum);

      if (currentNode) {
        deviceMetadata = {
          firmwareVersion: currentNode.firmwareVersion,
          rebootCount: currentNode.rebootCount
        };

        // Include local node identity information for anonymous users
        localNodeInfo = {
          nodeId: currentNode.nodeId,
          longName: currentNode.longName,
          shortName: currentNode.shortName
        };
      }
    }

    res.json({
      meshtasticNodeIp: env.meshtasticNodeIp,
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false,  // We're using TCP, not TLS
      baseUrl: BASE_URL,
      deviceMetadata: deviceMetadata,
      localNodeInfo: localNodeInfo
    });
  } catch (error) {
    logger.error('Error in /api/config:', error);
    res.json({
      meshtasticNodeIp: env.meshtasticNodeIp,
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false,
      baseUrl: BASE_URL
    });
  }
});

// Device configuration endpoint
apiRouter.get('/device-config', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const config = await meshtasticManager.getDeviceConfig();
    if (config) {
      res.json(config);
    } else {
      res.status(503).json({ error: 'Unable to retrieve device configuration' });
    }
  } catch (error) {
    logger.error('Error fetching device config:', error);
    res.status(500).json({ error: 'Failed to fetch device configuration' });
  }
});

// Refresh nodes from device endpoint
apiRouter.post('/nodes/refresh', requirePermission('nodes', 'write'), async (_req, res) => {
  try {
    logger.debug('🔄 Manual node database refresh requested...');

    // Trigger full node database refresh
    await meshtasticManager.refreshNodeDatabase();

    const nodeCount = databaseService.getNodeCount();
    const channelCount = databaseService.getChannelCount();

    logger.debug(`✅ Node refresh complete: ${nodeCount} nodes, ${channelCount} channels`);

    res.json({
      success: true,
      nodeCount,
      channelCount,
      message: `Refreshed ${nodeCount} nodes and ${channelCount} channels`
    });
  } catch (error) {
    logger.error('❌ Failed to refresh nodes:', error);
    res.status(500).json({
      error: 'Failed to refresh node database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Refresh channels from device endpoint
apiRouter.post('/channels/refresh', requirePermission('messages', 'write'), async (_req, res) => {
  try {
    logger.debug('🔄 Manual channel refresh requested...');

    // Trigger full node database refresh (includes channels)
    await meshtasticManager.refreshNodeDatabase();

    const channelCount = databaseService.getChannelCount();

    logger.debug(`✅ Channel refresh complete: ${channelCount} channels`);

    res.json({
      success: true,
      channelCount,
      message: `Refreshed ${channelCount} channels`
    });
  } catch (error) {
    logger.error('❌ Failed to refresh channels:', error);
    res.status(500).json({
      error: 'Failed to refresh channel database',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Settings endpoints
apiRouter.post('/settings/traceroute-interval', requirePermission('settings', 'write'), (req, res) => {
  try {
    const { intervalMinutes } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 0 || intervalMinutes > 60) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 0 and 60 minutes (0 = disabled).' });
    }

    meshtasticManager.setTracerouteInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting traceroute interval:', error);
    res.status(500).json({ error: 'Failed to set traceroute interval' });
  }
});

// Get all settings
apiRouter.get('/settings', optionalAuth(), (_req, res) => {
  try {
    // Allow all users (including anonymous) to read settings
    // Settings contain UI preferences (temperature unit, map tileset, etc.) that all users need
    const settings = databaseService.getAllSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Save settings
apiRouter.post('/settings', requirePermission('settings', 'write'), (req, res) => {
  try {
    const settings = req.body;

    // Get current settings for before/after comparison
    const currentSettings = databaseService.getAllSettings();

    // Validate settings
    const validKeys = ['maxNodeAgeHours', 'tracerouteIntervalMinutes', 'temperatureUnit', 'distanceUnit', 'telemetryVisualizationHours', 'telemetryFavorites', 'autoAckEnabled', 'autoAckRegex', 'autoAckChannels', 'autoAckDirectMessages', 'autoAnnounceEnabled', 'autoAnnounceIntervalHours', 'autoAnnounceMessage', 'autoAnnounceChannelIndex', 'autoAnnounceOnStart', 'preferredSortField', 'preferredSortDirection', 'timeFormat', 'dateFormat', 'mapTileset', 'packet_log_enabled', 'packet_log_max_count', 'packet_log_max_age_hours'];
    const filteredSettings: Record<string, string> = {};

    for (const key of validKeys) {
      if (key in settings) {
        filteredSettings[key] = String(settings[key]);
      }
    }

    // Validate autoAckRegex pattern
    if ('autoAckRegex' in filteredSettings) {
      const pattern = filteredSettings.autoAckRegex;

      // Check length
      if (pattern.length > 100) {
        return res.status(400).json({ error: 'Regex pattern too long (max 100 characters)' });
      }

      // Check for potentially dangerous patterns
      if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(pattern)) {
        return res.status(400).json({ error: 'Regex pattern too complex or may cause performance issues' });
      }

      // Try to compile
      try {
        new RegExp(pattern, 'i');
      } catch (error) {
        return res.status(400).json({ error: 'Invalid regex syntax' });
      }
    }

    // Validate autoAckChannels (channel indices must be 0-7)
    if ('autoAckChannels' in filteredSettings) {
      const channelList = filteredSettings.autoAckChannels.split(',');
      const validChannels = channelList
        .map(c => parseInt(c.trim()))
        .filter(n => !isNaN(n) && n >= 0 && n < 8); // Max 8 channels in Meshtastic

      filteredSettings.autoAckChannels = validChannels.join(',');
    }

    // Save to database
    databaseService.setSettings(filteredSettings);

    // Apply traceroute interval if changed
    if ('tracerouteIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.tracerouteIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        meshtasticManager.setTracerouteInterval(interval);
      }
    }

    // Audit log with before/after values
    const changedSettings: Record<string, { before: string | undefined; after: string }> = {};
    Object.keys(filteredSettings).forEach(key => {
      if (currentSettings[key] !== filteredSettings[key]) {
        changedSettings[key] = {
          before: currentSettings[key],
          after: filteredSettings[key]
        };
      }
    });

    if (Object.keys(changedSettings).length > 0) {
      databaseService.auditLog(
        req.user!.id,
        'settings_updated',
        'settings',
        JSON.stringify({ keys: Object.keys(changedSettings) }),
        req.ip || null,
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.before]))),
        JSON.stringify(Object.fromEntries(Object.entries(changedSettings).map(([k, v]) => [k, v.after])))
      );
    }

    res.json({ success: true, settings: filteredSettings });
  } catch (error) {
    logger.error('Error saving settings:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Reset settings to defaults
apiRouter.delete('/settings', requirePermission('settings', 'write'), (req, res) => {
  try {
    // Get current settings before deletion for audit log
    const currentSettings = databaseService.getAllSettings();

    databaseService.deleteAllSettings();
    // Reset traceroute interval to default (disabled)
    meshtasticManager.setTracerouteInterval(0);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'settings_reset',
      'settings',
      'All settings reset to defaults',
      req.ip || null,
      JSON.stringify(currentSettings),
      null
    );

    res.json({ success: true, message: 'Settings reset to defaults' });
  } catch (error) {
    logger.error('Error resetting settings:', error);
    res.status(500).json({ error: 'Failed to reset settings' });
  }
});

// Auto-announce endpoints
apiRouter.post('/announce/send', requirePermission('automation', 'write'), async (_req, res) => {
  try {
    await meshtasticManager.sendAutoAnnouncement();
    // Update last announcement time
    databaseService.setSetting('lastAnnouncementTime', Date.now().toString());
    res.json({ success: true, message: 'Announcement sent successfully' });
  } catch (error) {
    logger.error('Error sending announcement:', error);
    res.status(500).json({ error: 'Failed to send announcement' });
  }
});

apiRouter.get('/announce/last', requirePermission('automation', 'read'), (_req, res) => {
  try {
    const lastAnnouncementTime = databaseService.getSetting('lastAnnouncementTime');
    res.json({ lastAnnouncementTime: lastAnnouncementTime ? parseInt(lastAnnouncementTime) : null });
  } catch (error) {
    logger.error('Error fetching last announcement time:', error);
    res.status(500).json({ error: 'Failed to fetch last announcement time' });
  }
});

// Danger zone endpoints
apiRouter.post('/purge/nodes', requireAdmin(), async (req, res) => {
  try {
    const nodeCount = databaseService.getNodeCount();
    databaseService.purgeAllNodes();
    // Trigger a node refresh after purging
    await meshtasticManager.refreshNodeDatabase();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'nodes_purged',
      'nodes',
      JSON.stringify({ count: nodeCount }),
      req.ip || null
    );

    res.json({ success: true, message: 'All nodes and traceroutes purged, refresh triggered' });
  } catch (error) {
    logger.error('Error purging nodes:', error);
    res.status(500).json({ error: 'Failed to purge nodes' });
  }
});

apiRouter.post('/purge/telemetry', requireAdmin(), (req, res) => {
  try {
    databaseService.purgeAllTelemetry();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'telemetry_purged',
      'telemetry',
      'All telemetry data purged',
      req.ip || null
    );

    res.json({ success: true, message: 'All telemetry data purged' });
  } catch (error) {
    logger.error('Error purging telemetry:', error);
    res.status(500).json({ error: 'Failed to purge telemetry' });
  }
});

apiRouter.post('/purge/messages', requireAdmin(), (req, res) => {
  try {
    const messageCount = databaseService.getMessageCount();
    databaseService.purgeAllMessages();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'messages_purged',
      'messages',
      JSON.stringify({ count: messageCount }),
      req.ip || null
    );

    res.json({ success: true, message: 'All messages purged' });
  } catch (error) {
    logger.error('Error purging messages:', error);
    res.status(500).json({ error: 'Failed to purge messages' });
  }
});

// Configuration endpoints
// GET current configuration
apiRouter.get('/config/current', requirePermission('configuration', 'read'), (_req, res) => {
  try {
    const config = meshtasticManager.getCurrentConfig();
    res.json(config);
  } catch (error) {
    logger.error('Error getting current config:', error);
    res.status(500).json({ error: 'Failed to get current configuration' });
  }
});

apiRouter.post('/config/device', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setDeviceConfig(config);
    res.json({ success: true, message: 'Device configuration sent' });
  } catch (error) {
    logger.error('Error setting device config:', error);
    res.status(500).json({ error: 'Failed to set device configuration' });
  }
});

apiRouter.post('/config/lora', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setLoRaConfig(config);
    res.json({ success: true, message: 'LoRa configuration sent' });
  } catch (error) {
    logger.error('Error setting LoRa config:', error);
    res.status(500).json({ error: 'Failed to set LoRa configuration' });
  }
});

apiRouter.post('/config/position', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setPositionConfig(config);
    res.json({ success: true, message: 'Position configuration sent' });
  } catch (error) {
    logger.error('Error setting position config:', error);
    res.status(500).json({ error: 'Failed to set position configuration' });
  }
});

apiRouter.post('/config/mqtt', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setMQTTConfig(config);
    res.json({ success: true, message: 'MQTT configuration sent' });
  } catch (error) {
    logger.error('Error setting MQTT config:', error);
    res.status(500).json({ error: 'Failed to set MQTT configuration' });
  }
});

apiRouter.post('/config/neighborinfo', requirePermission('configuration', 'write'), async (req, res) => {
  logger.debug('🔍 DEBUG: /config/neighborinfo endpoint called with body:', JSON.stringify(req.body));
  try {
    const config = req.body;
    await meshtasticManager.setNeighborInfoConfig(config);
    res.json({ success: true, message: 'NeighborInfo configuration sent' });
  } catch (error) {
    logger.error('Error setting NeighborInfo config:', error);
    res.status(500).json({ error: 'Failed to set NeighborInfo configuration' });
  }
});

apiRouter.post('/config/owner', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { longName, shortName } = req.body;
    if (!longName || !shortName) {
      res.status(400).json({ error: 'longName and shortName are required' });
      return;
    }
    await meshtasticManager.setNodeOwner(longName, shortName);
    res.json({ success: true, message: 'Node owner updated' });
  } catch (error) {
    logger.error('Error setting node owner:', error);
    res.status(500).json({ error: 'Failed to set node owner' });
  }
});

apiRouter.post('/config/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    await meshtasticManager.requestConfig(configType);
    res.json({ success: true, message: 'Config request sent' });
  } catch (error) {
    logger.error('Error requesting config:', error);
    res.status(500).json({ error: 'Failed to request configuration' });
  }
});

apiRouter.post('/config/module/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    await meshtasticManager.requestModuleConfig(configType);
    res.json({ success: true, message: 'Module config request sent' });
  } catch (error) {
    logger.error('Error requesting module config:', error);
    res.status(500).json({ error: 'Failed to request module configuration' });
  }
});

apiRouter.post('/device/reboot', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const seconds = req.body?.seconds || 5;
    await meshtasticManager.rebootDevice(seconds);
    res.json({ success: true, message: `Device will reboot in ${seconds} seconds` });
  } catch (error) {
    logger.error('Error rebooting device:', error);
    res.status(500).json({ error: 'Failed to reboot device' });
  }
});

// Helper to detect if running in Docker
function isRunningInDocker(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

// System status endpoint
apiRouter.get('/system/status', requirePermission('dashboard', 'read'), (_req, res) => {
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
    environment: env.nodeEnv,
    isDocker: isRunningInDocker(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    }
  });
});

// Health check endpoint
apiRouter.get('/health', optionalAuth(), (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: env.nodeEnv
  });
});

// Detailed status endpoint - provides system statistics and connection status
apiRouter.get('/status', optionalAuth(), (_req, res) => {
  const connectionStatus = meshtasticManager.getConnectionStatus();
  const localNode = meshtasticManager.getLocalNodeInfo();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: packageJson.version,
    nodeEnv: env.nodeEnv,
    connection: {
      connected: connectionStatus.connected,
      localNode: localNode ? {
        nodeNum: localNode.nodeNum,
        nodeId: localNode.nodeId,
        longName: localNode.longName,
        shortName: localNode.shortName
      } : null
    },
    statistics: {
      nodes: databaseService.getNodeCount(),
      messages: databaseService.getMessageCount(),
      channels: databaseService.getChannelCount()
    },
    uptime: process.uptime()
  });
});

// Version check endpoint - compares current version with latest GitHub release
let versionCheckCache: { data: any; timestamp: number } | null = null;
const VERSION_CHECK_CACHE_MS = 60 * 60 * 1000; // 1 hour cache

apiRouter.get('/version/check', optionalAuth(), async (_req, res) => {
  try {
    // Check cache first
    if (versionCheckCache && (Date.now() - versionCheckCache.timestamp) < VERSION_CHECK_CACHE_MS) {
      return res.json(versionCheckCache.data);
    }

    // Fetch latest release from GitHub
    const response = await fetch('https://api.github.com/repos/Yeraze/meshmonitor/releases/latest');

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status} for version check`);
      return res.json({ updateAvailable: false, error: 'Unable to check for updates' });
    }

    const release = await response.json();
    const currentVersion = packageJson.version;
    const latestVersionRaw = release.tag_name;

    // Strip 'v' prefix from version strings for comparison
    const latestVersion = latestVersionRaw.replace(/^v/, '');
    const current = currentVersion.replace(/^v/, '');

    // Simple semantic version comparison
    const updateAvailable = compareVersions(latestVersion, current) > 0;

    const result = {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseName: release.name
    };

    // Cache the result
    versionCheckCache = { data: result, timestamp: Date.now() };

    return res.json(result);
  } catch (error) {
    logger.error('Error checking for version updates:', error);
    return res.json({ updateAvailable: false, error: 'Unable to check for updates' });
  }
});

// Helper function to compare semantic versions
function compareVersions(a: string, b: string): number {
  const aParts = a.split(/[-.]/).map(p => parseInt(p) || 0);
  const bParts = b.split(/[-.]/).map(p => parseInt(p) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aPart = aParts[i] || 0;
    const bPart = bParts[i] || 0;

    if (aPart > bPart) return 1;
    if (aPart < bPart) return -1;
  }

  return 0;
}

// Restart/shutdown container endpoint
apiRouter.post('/system/restart', requirePermission('settings', 'write'), (_req, res) => {
  const isDocker = isRunningInDocker();

  if (isDocker) {
    logger.info('🔄 Container restart requested by admin');
    res.json({
      success: true,
      message: 'Container will restart now',
      action: 'restart'
    });

    // Gracefully shutdown - Docker will restart the container automatically
    setTimeout(() => {
      gracefulShutdown('Admin-requested container restart');
    }, 500);
  } else {
    logger.info('🛑 Shutdown requested by admin');
    res.json({
      success: true,
      message: 'MeshMonitor will shut down now',
      action: 'shutdown'
    });

    // Gracefully shutdown - will need to be manually restarted
    setTimeout(() => {
      gracefulShutdown('Admin-requested shutdown');
    }, 500);
  }
});

// ==========================================
// Push Notification Endpoints
// ==========================================

// Get VAPID public key and configuration status
apiRouter.get('/push/vapid-key', optionalAuth(), (_req, res) => {
  const publicKey = pushNotificationService.getPublicKey();
  const status = pushNotificationService.getVapidStatus();

  res.json({
    publicKey,
    status
  });
});

// Get push notification status
apiRouter.get('/push/status', optionalAuth(), (_req, res) => {
  const status = pushNotificationService.getVapidStatus();
  res.json(status);
});

// Update VAPID subject (admin only)
apiRouter.put('/push/vapid-subject', requireAdmin(), (req, res) => {
  try {
    const { subject } = req.body;

    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject is required and must be a string' });
    }

    pushNotificationService.updateVapidSubject(subject);
    res.json({ success: true, subject });
  } catch (error: any) {
    logger.error('Error updating VAPID subject:', error);
    res.status(400).json({ error: error.message || 'Failed to update VAPID subject' });
  }
});

// Subscribe to push notifications
apiRouter.post('/push/subscribe', optionalAuth(), async (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid subscription data' });
    }

    const userId = req.session?.userId;
    const userAgent = req.headers['user-agent'];

    await pushNotificationService.saveSubscription(userId, subscription, userAgent);

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error saving push subscription:', error);
    res.status(500).json({ error: error.message || 'Failed to save subscription' });
  }
});

// Unsubscribe from push notifications
apiRouter.post('/push/unsubscribe', optionalAuth(), async (req, res) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: 'Endpoint is required' });
    }

    await pushNotificationService.removeSubscription(endpoint);

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error removing push subscription:', error);
    res.status(500).json({ error: error.message || 'Failed to remove subscription' });
  }
});

// Test push notification (admin only)
apiRouter.post('/push/test', requireAdmin(), async (req, res) => {
  try {
    const userId = req.session?.userId;

    const result = await pushNotificationService.sendToUser(userId, {
      title: 'Test Notification',
      body: 'This is a test push notification from MeshMonitor',
      icon: '/logo.png',
      badge: '/logo.png',
      tag: 'test-notification'
    });

    res.json({
      success: true,
      sent: result.sent,
      failed: result.failed
    });
  } catch (error: any) {
    logger.error('Error sending test notification:', error);
    res.status(500).json({ error: error.message || 'Failed to send test notification' });
  }
});

// Get notification preferences (unified for Web Push and Apprise)
apiRouter.get('/push/preferences', requireAuth(), async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const prefs = getUserNotificationPreferences(userId);

    if (prefs) {
      res.json(prefs);
    } else {
      // Return defaults
      res.json({
        enableWebPush: true,
        enableApprise: false,
        enabledChannels: [],
        enableDirectMessages: true,
        notifyOnEmoji: true,
        notifyOnNewNode: true,
        notifyOnTraceroute: true,
        whitelist: ['Hi', 'Help'],
        blacklist: ['Test', 'Copy']
      });
    }
  } catch (error: any) {
    logger.error('Error loading notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to load preferences' });
  }
});

// Save notification preferences (unified for Web Push and Apprise)
apiRouter.post('/push/preferences', requireAuth(), async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { enableWebPush, enableApprise, enabledChannels, enableDirectMessages, notifyOnEmoji, notifyOnNewNode, notifyOnTraceroute, whitelist, blacklist } = req.body;

    // Validate input
    if (typeof enableWebPush !== 'boolean' || typeof enableApprise !== 'boolean' ||
        !Array.isArray(enabledChannels) || typeof enableDirectMessages !== 'boolean' ||
        typeof notifyOnEmoji !== 'boolean' || typeof notifyOnNewNode !== 'boolean' ||
        typeof notifyOnTraceroute !== 'boolean' ||
        !Array.isArray(whitelist) || !Array.isArray(blacklist)) {
      return res.status(400).json({ error: 'Invalid preferences data' });
    }

    const prefs = {
      enableWebPush,
      enableApprise,
      enabledChannels,
      enableDirectMessages,
      notifyOnEmoji,
      notifyOnNewNode,
      notifyOnTraceroute,
      whitelist,
      blacklist
    };

    const success = saveUserNotificationPreferences(userId, prefs);

    if (success) {
      logger.info(`✅ Saved notification preferences for user ${userId} (WebPush: ${enableWebPush}, Apprise: ${enableApprise})`);
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  } catch (error: any) {
    logger.error('Error saving notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to save preferences' });
  }
});

// ==========================================
// Apprise Notification Endpoints
// ==========================================

// Get Apprise status (admin only)
apiRouter.get('/apprise/status', requireAdmin(), async (_req, res) => {
  try {
    const isAvailable = appriseNotificationService.isAvailable();
    res.json({
      available: isAvailable,
      enabled: databaseService.getSetting('apprise_enabled') === 'true',
      url: databaseService.getSetting('apprise_url') || 'http://localhost:8000'
    });
  } catch (error: any) {
    logger.error('Error getting Apprise status:', error);
    res.status(500).json({ error: error.message || 'Failed to get Apprise status' });
  }
});

// Send test Apprise notification (admin only)
apiRouter.post('/apprise/test', requireAdmin(), async (_req, res) => {
  try {
    const success = await appriseNotificationService.sendNotification({
      title: 'Test Notification',
      body: 'This is a test notification from MeshMonitor via Apprise',
      type: 'info'
    });

    if (success) {
      res.json({ success: true, message: 'Test notification sent successfully' });
    } else {
      res.json({ success: false, message: 'Apprise not available or no URLs configured' });
    }
  } catch (error: any) {
    logger.error('Error sending test Apprise notification:', error);
    res.status(500).json({ error: error.message || 'Failed to send test notification' });
  }
});

// Get configured Apprise URLs (admin only)
apiRouter.get('/apprise/urls', requireAdmin(), async (_req, res) => {
  try {
    const configFile = process.env.APPRISE_CONFIG_DIR
      ? `${process.env.APPRISE_CONFIG_DIR}/urls.txt`
      : '/data/apprise-config/urls.txt';

    // Check if file exists
    const fs = await import('fs/promises');
    try {
      const content = await fs.readFile(configFile, 'utf-8');
      const urls = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

      res.json({ urls });
    } catch (error: any) {
      // File doesn't exist or can't be read - return empty array
      if (error.code === 'ENOENT') {
        res.json({ urls: [] });
      } else {
        throw error;
      }
    }
  } catch (error: any) {
    logger.error('Error reading Apprise URLs:', error);
    res.status(500).json({ error: error.message || 'Failed to read Apprise URLs' });
  }
});

// Configure Apprise URLs (admin only)
apiRouter.post('/apprise/configure', requireAdmin(), async (req, res) => {
  try {
    const { urls } = req.body;

    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'URLs must be an array' });
    }

    // Security: Validate URL schemes to prevent malicious URLs
    // Comprehensive list of all Apprise-supported notification services
    // Reference: https://github.com/caronc/apprise
    const ALLOWED_SCHEMES = [
      // Core Apprise
      'apprise', 'apprises',

      // Chat & Messaging
      'discord', 'slack', 'msteams', 'teams', 'guilded', 'revolt',
      'matrix', 'matrixs', 'mmost', 'mmosts', 'rocket', 'rockets',
      'ryver', 'zulip', 'twist', 'gchat', 'flock',

      // Instant Messaging & Social
      'telegram', 'tgram', 'signal', 'signals', 'whatsapp', 'line',
      'mastodon', 'mastodons', 'misskey', 'misskeys', 'bluesky', 'reddit', 'twitter',

      // Team Communication
      'workflows', 'wxteams', 'wecombot', 'feishu', 'lark', 'dingtalk',

      // Push Notifications
      'pushover', 'pover', 'pushbullet', 'pbul', 'pushed', 'pushme',
      'pushplus', 'pushdeer', 'pushdeers', 'pushy', 'prowl',
      'simplepush', 'spush', 'popcorn', 'push',

      // Notification Services
      'ntfy', 'ntfys', 'gotify', 'gotifys', 'join', 'ifttt', 'notica',
      'notifiarr', 'notifico', 'onesignal', 'kumulos', 'bark', 'barks',
      'chanify', 'serverchan', 'schan', 'qq', 'wxpusher',

      // Incident Management & Monitoring
      'pagerduty', 'pagertree', 'opsgenie', 'spike', 'splunk', 'victorops',
      'signl4',

      // Email Services
      'mailto', 'email', 'smtp', 'smtps', 'ses', 'mailgun', 'sendgrid',
      'smtp2go', 'sparkpost', 'o365', 'resend', 'sendpulse',

      // SMS Services
      'bulksms', 'bulkvs', 'burstsms', 'clickatell', 'clicksend', 'd7sms',
      'freemobile', 'httpsms', 'atalk',

      // Cloud/IoT/Home
      'fcm', 'hassio', 'hassios', 'homeassistant', 'parsep', 'parseps',
      'aws', 'sns',

      // Media Centers
      'kodi', 'kodis', 'xbmc', 'xbmcs', 'emby', 'embys', 'enigma2', 'enigma2s',

      // Collaboration & Productivity
      'ncloud', 'nclouds', 'nctalk', 'nctalks', 'office365',

      // Streaming & Gaming
      'streamlabs', 'strmlabs',

      // Specialized
      'lametric', 'synology', 'synologys', 'vapid', 'mqtt', 'mqtts',
      'rsyslog', 'syslog', 'dapnet', 'aprs', 'growl', 'pjet', 'pjets',
      'psafer', 'psafers', 'spugpush', 'pushsafer',

      // Generic webhooks & protocols
      'webhook', 'webhooks', 'json', 'xml', 'form',
      'http', 'https'
    ];

    const invalidUrls: string[] = [];
    const validUrls = urls.filter((url: string) => {
      if (typeof url !== 'string' || !url.trim()) {
        invalidUrls.push(url);
        return false;
      }

      try {
        const parsed = new URL(url);
        const scheme = parsed.protocol.slice(0, -1).toLowerCase(); // Remove trailing ':' and normalize

        if (!ALLOWED_SCHEMES.includes(scheme)) {
          invalidUrls.push(url);
          return false;
        }

        return true;
      } catch {
        invalidUrls.push(url);
        return false;
      }
    });

    if (invalidUrls.length > 0) {
      return res.status(400).json({
        error: 'Invalid or disallowed URL schemes detected',
        invalidUrls,
        allowedSchemes: ALLOWED_SCHEMES
      });
    }

    const result = await appriseNotificationService.configureUrls(validUrls);
    res.json(result);
  } catch (error: any) {
    logger.error('Error configuring Apprise URLs:', error);
    res.status(500).json({ error: error.message || 'Failed to configure Apprise URLs' });
  }
});

// Enable/disable Apprise system-wide (admin only)
apiRouter.put('/apprise/enabled', requireAdmin(), (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }

    databaseService.setSetting('apprise_enabled', enabled ? 'true' : 'false');
    logger.info(`✅ Apprise ${enabled ? 'enabled' : 'disabled'} system-wide`);
    res.json({ success: true, enabled });
  } catch (error: any) {
    logger.error('Error updating Apprise enabled status:', error);
    res.status(500).json({ error: error.message || 'Failed to update Apprise status' });
  }
});

// Serve static files from the React app build
const buildPath = path.join(__dirname, '../../dist');

// Mount API router first - this must come before static file serving
// Apply rate limiting and CSRF protection to all API routes (except csrf-token endpoint)
if (BASE_URL) {
  app.use(`${BASE_URL}/api`, apiLimiter, csrfProtection, apiRouter);
} else {
  app.use('/api', apiLimiter, csrfProtection, apiRouter);
}

// Function to rewrite HTML with BASE_URL at runtime
const rewriteHtml = (htmlContent: string, baseUrl: string): string => {
  if (!baseUrl) return htmlContent;

  // Add <base> tag to set the base URL for all relative paths
  // This ensures that all relative URLs (like /api/config) resolve from the base URL
  // instead of the current page URL (like /api/auth/oidc/callback)
  const baseTag = `<base href="${baseUrl}/">`;

  // Insert the base tag right after <head>
  let rewritten = htmlContent.replace(/<head>/, `<head>\n    ${baseTag}`);

  // Replace asset paths in the HTML
  rewritten = rewritten
    .replace(/href="\/assets\//g, `href="${baseUrl}/assets/`)
    .replace(/src="\/assets\//g, `src="${baseUrl}/assets/`)
    .replace(/href="\/vite\.svg"/g, `href="${baseUrl}/vite.svg"`)
    .replace(/href="\/favicon\.ico"/g, `href="${baseUrl}/favicon.ico"`)
    .replace(/href="\/favicon-16x16\.png"/g, `href="${baseUrl}/favicon-16x16.png"`)
    .replace(/href="\/favicon-32x32\.png"/g, `href="${baseUrl}/favicon-32x32.png"`)
    .replace(/href="\/logo\.png"/g, `href="${baseUrl}/logo.png"`)
    // PWA-related paths
    .replace(/href="\/manifest\.webmanifest"/g, `href="${baseUrl}/manifest.webmanifest"`)
    .replace(/src="\/registerSW\.js"/g, `src="${baseUrl}/registerSW.js"`);

  return rewritten;
};

// Cache for rewritten HTML to avoid repeated file reads
let cachedHtml: string | null = null;
let cachedRewrittenHtml: string | null = null;

// Serve static assets (JS, CSS, images)
if (BASE_URL) {
  // Serve PWA files with BASE_URL rewriting (MUST be before static middleware)
  app.get(`${BASE_URL}/registerSW.js`, (_req: express.Request, res: express.Response) => {
    const swRegisterPath = path.join(buildPath, 'registerSW.js');
    let content = fs.readFileSync(swRegisterPath, 'utf-8');
    // Rewrite service worker registration to use BASE_URL
    // The generated file has: navigator.serviceWorker.register('/sw.js', { scope: '/' })
    content = content
      .replace("'/sw.js'", `'${BASE_URL}/sw.js'`)
      .replace('"/sw.js"', `"${BASE_URL}/sw.js"`)
      .replace("scope: '/'", `scope: '${BASE_URL}/'`)
      .replace('scope: "/"', `scope: "${BASE_URL}/"`);
    res.type('application/javascript').send(content);
  });

  app.get(`${BASE_URL}/manifest.webmanifest`, (_req: express.Request, res: express.Response) => {
    const manifestPath = path.join(buildPath, 'manifest.webmanifest');
    let content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);
    // Update manifest paths
    manifest.scope = `${BASE_URL}/`;
    manifest.start_url = `${BASE_URL}/`;
    res.type('application/manifest+json').json(manifest);
  });

  // Serve assets folder specifically
  app.use(`${BASE_URL}/assets`, express.static(path.join(buildPath, 'assets')));

  // Create static middleware once and reuse it
  const staticMiddleware = express.static(buildPath, { index: false });

  // Serve other static files (like favicon, logo, etc.) - but exclude /api
  app.use(BASE_URL, (req, res, next) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api')) {
      return next();
    }
    staticMiddleware(req, res, next);
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
    // Skip if this is a static file (has an extension like .ico, .png, .svg, etc.)
    if (/\.[a-zA-Z0-9]+$/.test(req.path)) {
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

  // Catch all handler for SPA routing - skip API routes
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: env.isDevelopment ? err.message : 'Something went wrong'
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT received');
});

// Graceful shutdown function
function gracefulShutdown(reason: string): void {
  logger.info(`🛑 Initiating graceful shutdown: ${reason}`);

  // Stop accepting new connections
  server.close(() => {
    logger.debug('✅ HTTP server closed');

    // Disconnect from Meshtastic
    try {
      meshtasticManager.disconnect();
      logger.debug('✅ Meshtastic connection closed');
    } catch (error) {
      logger.error('Error disconnecting from Meshtastic:', error);
    }

    // Close database connections
    try {
      databaseService.close();
      logger.debug('✅ Database connections closed');
    } catch (error) {
      logger.error('Error closing database:', error);
    }

    logger.info('✅ Graceful shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    logger.warn('⚠️ Graceful shutdown timeout - forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM received');
});

const server = app.listen(PORT, () => {
  logger.debug(`MeshMonitor server running on port ${PORT}`);
  logger.debug(`Environment: ${env.nodeEnv}`);
});