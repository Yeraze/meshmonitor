import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import meshtasticManager from './meshtasticManager.js';
import { VirtualNodeServer } from './virtualNodeServer.js';
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
import { getEnvironmentConfig, resetEnvironmentConfig } from './config/environment.js';
import { pushNotificationService } from './services/pushNotificationService.js';
import { appriseNotificationService } from './services/appriseNotificationService.js';
import { deviceBackupService } from './services/deviceBackupService.js';
import { backupFileService } from './services/backupFileService.js';
import { backupSchedulerService } from './services/backupSchedulerService.js';
import { systemBackupService } from './services/systemBackupService.js';
import { systemRestoreService } from './services/systemRestoreService.js';
import { duplicateKeySchedulerService } from './services/duplicateKeySchedulerService.js';
import { solarMonitoringService } from './services/solarMonitoringService.js';
import { getUserNotificationPreferences, saveUserNotificationPreferences } from './utils/notificationFiltering.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file in development mode
// dotenv/config automatically loads .env from project root
// This must run before getEnvironmentConfig() is called
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
  // Reset cached environment config to ensure .env values are loaded
  resetEnvironmentConfig();
  logger.info('📄 Loaded .env file from project root (if present)');
}

// Load environment configuration (after .env is loaded)
const env = getEnvironmentConfig();

/**
 * Gets the scripts directory path.
 * In development, uses relative path from project root (data/scripts).
 * In production, uses absolute path (/data/scripts).
 */
const getScriptsDirectory = (): string => {
  if (env.isDevelopment) {
    // In development, use relative path from project root
    const projectRoot = path.resolve(__dirname, '../../');
    const devScriptsDir = path.join(projectRoot, 'data', 'scripts');
    
    // Ensure directory exists
    if (!fs.existsSync(devScriptsDir)) {
      fs.mkdirSync(devScriptsDir, { recursive: true });
      logger.info(`📁 Created scripts directory: ${devScriptsDir}`);
    }
    
    return devScriptsDir;
  }
  
  // In production, use absolute path
  return '/data/scripts';
};

/**
 * Converts a script path to the actual file system path.
 * Handles both /data/scripts/... (stored format) and actual file paths.
 */
const resolveScriptPath = (scriptPath: string): string | null => {
  // Validate script path (security check)
  if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
    logger.error(`🚫 Invalid script path: ${scriptPath}`);
    return null;
  }
  
  const scriptsDir = getScriptsDirectory();
  const filename = path.basename(scriptPath);
  const resolvedPath = path.join(scriptsDir, filename);
  
  // Additional security: ensure resolved path is within scripts directory
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedScriptsDir = path.normalize(scriptsDir);
  
  if (!normalizedResolved.startsWith(normalizedScriptsDir)) {
    logger.error(`🚫 Script path resolves outside scripts directory: ${scriptPath}`);
    return null;
  }
  
  return normalizedResolved;
};

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

// Function to initialize virtual node server after config capture is complete
async function initializeVirtualNodeServer(): Promise<void> {
  // Only initialize once
  if ((global as any).virtualNodeServer) {
    logger.debug('Virtual node server already initialized, skipping');
    return;
  }

  if (env.enableVirtualNode) {
    try {
      const virtualNodeServer = new VirtualNodeServer({
        port: env.virtualNodePort,
        meshtasticManager: meshtasticManager,
        allowAdminCommands: env.virtualNodeAllowAdminCommands,
      });

      await virtualNodeServer.start();
      logger.info(`🌐 Virtual node server started on port ${env.virtualNodePort}`);

      // Store reference for cleanup
      (global as any).virtualNodeServer = virtualNodeServer;
    } catch (error) {
      logger.error('❌ Failed to start virtual node server:', error);
      logger.warn('⚠️  Continuing without virtual node server');
    }
  } else {
    logger.debug('Virtual node server disabled (ENABLE_VIRTUAL_NODE=false)');
  }
}

// Register callback to initialize virtual node server when config capture completes
// This ensures it starts after both initial connection and reconnections
meshtasticManager.registerConfigCaptureCompleteCallback(initializeVirtualNodeServer);

// ========== Bootstrap Restore Logic ==========
// Check for RESTORE_FROM_BACKUP environment variable and restore if set
// This MUST happen before services start (per ARCHITECTURE_LESSONS.md)
(async () => {
  try {
    const restoreFromBackup = systemRestoreService.shouldRestore();

    if (restoreFromBackup) {
      logger.info('🔄 RESTORE_FROM_BACKUP environment variable detected');
      logger.info(`📦 Attempting to restore from: ${restoreFromBackup}`);

      // Validate restore can proceed
      const validation = await systemRestoreService.canRestore(restoreFromBackup);
      if (!validation.can) {
        logger.error(`❌ Cannot restore from backup: ${validation.reason}`);
        logger.error('⚠️  Container will start normally without restore');
        return;
      }

      logger.info('✅ Backup validation passed, starting restore...');

      // Restore the system (this happens BEFORE services start)
      const result = await systemRestoreService.restoreFromBackup(restoreFromBackup);

      if (result.success) {
        logger.info('✅ System restore completed successfully!');
        logger.info(`📊 Restored ${result.tablesRestored} tables with ${result.rowsRestored} rows`);

        if (result.migrationRequired) {
          logger.info('⚠️  Schema migration was required and completed');
        }

        // Audit log to mark restore completion point (after migrations)
        databaseService.auditLog(
          null, // System action during bootstrap
          'system_restore_bootstrap_complete',
          'system_backup',
          JSON.stringify({
            dirname: restoreFromBackup,
            tablesRestored: result.tablesRestored,
            rowsRestored: result.rowsRestored,
            migrationRequired: result.migrationRequired || false
          }),
          null // No IP address during startup
        );

        logger.info('🚀 Continuing with normal startup...');
      } else {
        logger.error('❌ System restore failed:', result.message);
        if (result.errors) {
          result.errors.forEach(err => logger.error(`  - ${err}`));
        }
        logger.error('⚠️  Container will start normally with existing database');
      }
    }
  } catch (error) {
    logger.error('❌ Fatal error during bootstrap restore:', error);
    logger.error('⚠️  Container will start normally with existing database');
  }
})();

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

    // Mark all existing nodes as welcomed BEFORE connecting to prevent thundering herd
    // This must run before connect() so nodes in the DB are marked before new packets arrive
    const autoWelcomeEnabled = databaseService.getSetting('autoWelcomeEnabled');
    if (autoWelcomeEnabled === 'true') {
      const markedCount = databaseService.markAllNodesAsWelcomed();
      if (markedCount > 0) {
        logger.info(`👋 Marked ${markedCount} existing node(s) as welcomed to prevent spam on startup`);
      }
    }

    await meshtasticManager.connect();
    logger.debug('Meshtastic manager connected successfully');

    // Initialize backup scheduler
    backupSchedulerService.initialize(meshtasticManager);
    logger.debug('Backup scheduler initialized');

    // Initialize duplicate key scanner
    duplicateKeySchedulerService.start();
    logger.debug('Duplicate key scanner initialized');

    // Initialize solar monitoring service
    solarMonitoringService.initialize();
    logger.debug('Solar monitoring service initialized');

    // Note: Virtual node server initialization has been moved to a callback
    // that triggers when config capture completes (see registerConfigCaptureCompleteCallback above)
  } catch (error) {
    logger.error('Failed to connect to Meshtastic node on startup:', error);
    // Virtual node server will still initialize on successful reconnection
    // via the registered callback
  }
}, 1000);

// Schedule hourly telemetry purge to keep database performant
// Keep telemetry for 7 days (168 hours) by default
const TELEMETRY_RETENTION_HOURS = 168; // 7 days
setInterval(() => {
  try {
    // Get favorite telemetry storage days from settings (defaults to 7 if not set)
    const favoriteDaysStr = databaseService.getSetting('favoriteTelemetryStorageDays');
    const favoriteDays = favoriteDaysStr ? parseInt(favoriteDaysStr) : 7;
    const purgedCount = databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS, favoriteDays);
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
    // Get favorite telemetry storage days from settings (defaults to 7 if not set)
    const favoriteDaysStr = databaseService.getSetting('favoriteTelemetryStorageDays');
    const favoriteDays = favoriteDaysStr ? parseInt(favoriteDaysStr) : 7;
    databaseService.purgeOldTelemetry(TELEMETRY_RETENTION_HOURS, favoriteDays);
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
import securityRoutes from './routes/securityRoutes.js';
import packetRoutes from './routes/packetRoutes.js';
import solarRoutes from './routes/solarRoutes.js';
import upgradeRoutes from './routes/upgradeRoutes.js';
import messageRoutes from './routes/messageRoutes.js';
import linkPreviewRoutes from './routes/linkPreviewRoutes.js';
import scriptContentRoutes from './routes/scriptContentRoutes.js';
import apiTokenRoutes from './routes/apiTokenRoutes.js';
import v1Router from './routes/v1/index.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Health check endpoint (for upgrade watchdog and monitoring)
apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: packageJson.version,
    uptime: Date.now() - serverStartTime
  });
});

// Debug endpoint for IP detection (development only)
// Helps diagnose reverse proxy and rate limiting issues
if (!env.isProduction) {
  apiRouter.get('/debug/ip', (req, res) => {
    res.json({
      'req.ip': req.ip,
      'req.ips': req.ips,
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-real-ip': req.headers['x-real-ip'],
      'trust-proxy': app.get('trust proxy'),
      note: 'The rate limiter uses req.ip to identify clients'
    });
  });
}

// Authentication routes
apiRouter.use('/auth', authRoutes);

// API Token management routes (requires auth)
apiRouter.use('/token', apiTokenRoutes);

// v1 API routes (requires API token)
apiRouter.use('/v1', v1Router);

// User management routes (admin only)
apiRouter.use('/users', userRoutes);

// Audit log routes (admin only)
apiRouter.use('/audit', auditRoutes);

// Security routes (requires security:read)
apiRouter.use('/security', securityRoutes);

// Packet log routes (requires channels:read AND messages:read)
apiRouter.use('/packets', optionalAuth(), packetRoutes);

// Solar monitoring routes
apiRouter.use('/solar', optionalAuth(), solarRoutes);

// Upgrade routes (requires authentication)
apiRouter.use('/upgrade', upgradeRoutes);

// Message routes (requires appropriate write permissions)
apiRouter.use('/messages', optionalAuth(), messageRoutes);

// Link preview routes
apiRouter.use('/', linkPreviewRoutes);

// Script content proxy routes (for User Scripts Gallery)
apiRouter.use('/', scriptContentRoutes);

// API Routes
apiRouter.get('/nodes', optionalAuth(), (_req, res) => {
  try {
    const nodes = meshtasticManager.getAllNodes();

    // Enhance nodes with estimated positions if no regular position is available
    // Mobile status is now pre-computed in the database during packet processing
    const enhancedNodes = nodes.map(node => {
      if (!node.user?.id) return { ...node, isMobile: false };

      let enhancedNode = { ...node, isMobile: node.mobile === 1 };

      // If node doesn't have a regular position, check for estimated position
      if (!node.position?.latitude && !node.position?.longitude) {
        // Get only the most recent estimated position (limit 1 of each type)
        const positionTelemetry = databaseService.getPositionTelemetryByNode(node.user.id, 2);
        const estimatedLatitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_latitude');
        const estimatedLongitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_longitude');

        if (estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
          // Use the most recent estimated position
          const latestEstimatedLat = estimatedLatitudes[0]; // getPositionTelemetryByNode returns most recent first
          const latestEstimatedLon = estimatedLongitudes[0];

          enhancedNode.position = {
            latitude: latestEstimatedLat.value,
            longitude: latestEstimatedLon.value,
            altitude: node.position?.altitude
          };
        }
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

    // Allow hours parameter for future use, but default to fetching ALL position history
    // This ensures we capture movement that may have happened long ago
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : null;
    const cutoffTime = hoursParam ? Date.now() - (hoursParam * 60 * 60 * 1000) : 0;

    // Get only position-related telemetry (lat/lon/alt) for the node - much more efficient!
    const positionTelemetry = databaseService.getPositionTelemetryByNode(nodeId, 1500, cutoffTime);

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

// Alternative endpoint with limit parameter for fetching positions
apiRouter.get('/nodes/:nodeId/positions', optionalAuth(), (req, res) => {
  try {
    const { nodeId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 2000;

    // Get only position-related telemetry (lat/lon/alt) for the node
    const positionTelemetry = databaseService.getPositionTelemetryByNode(nodeId, limit);

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
    logger.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
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

// Get nodes with key security issues (low-entropy or duplicate keys)
apiRouter.get('/nodes/security-issues', optionalAuth(), (_req, res) => {
  try {
    const nodes = databaseService.getNodesWithKeySecurityIssues();
    res.json(nodes);
  } catch (error) {
    logger.error('Error getting nodes with security issues:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to get nodes with security issues',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred'
    };
    res.status(500).json(errorResponse);
  }
});

// Send key security warning DM to a specific node
apiRouter.post('/nodes/:nodeId/send-key-warning', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format
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

    // Verify the node actually has a security issue
    const node = databaseService.getNode(nodeNum);
    if (!node) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `No node found with ID ${nodeId}`
      };
      res.status(404).json(errorResponse);
      return;
    }

    if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node has no security issues',
        code: 'NO_SECURITY_ISSUE',
        details: 'This node does not have any detected key security issues'
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Send warning message on gauntlet channel
    const warningMessage = `⚠️ SECURITY WARNING: Your encryption key has been identified as compromised (${
      node.keyIsLowEntropy ? 'low-entropy' : 'duplicate'
    }). Your direct messages may not be private. Please regenerate your key in Settings > Security.`;

    const messageId = await meshtasticManager.sendTextMessage(
      warningMessage,
      0,  // Channel 0
      nodeNum  // Destination
    );

    logger.info(`🔐 Sent key security warning to node ${nodeId} (${node.longName || 'Unknown'})`);

    res.json({
      success: true,
      nodeNum,
      nodeId,
      messageId,
      messageSent: warningMessage
    });
  } catch (error) {
    logger.error('Error sending key warning:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to send key warning',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred'
    };
    res.status(500).json(errorResponse);
  }
});

// Scan all nodes for duplicate keys and update database
apiRouter.post('/nodes/scan-duplicate-keys', requirePermission('nodes', 'write'), async (_req, res) => {
  try {
    const { detectDuplicateKeys } = await import('../services/lowEntropyKeyService.js');
    const nodesWithKeys = databaseService.getNodesWithPublicKeys();
    const duplicates = detectDuplicateKeys(nodesWithKeys);

    // Clear existing duplicate flags first
    const allNodes = databaseService.getAllNodes();
    for (const node of allNodes) {
      if (node.duplicateKeyDetected) {
        databaseService.upsertNode({
          nodeNum: node.nodeNum,
          nodeId: node.nodeId,
          duplicateKeyDetected: false,
          keySecurityIssueDetails: node.keyIsLowEntropy
            ? 'Known low-entropy key detected'
            : undefined
        });
      }
    }

    // Update database with new duplicate flags
    for (const [keyHash, nodeNums] of duplicates) {
      for (const nodeNum of nodeNums) {
        const node = databaseService.getNode(nodeNum);
        if (!node) continue;

        const otherNodes = nodeNums.filter(n => n !== nodeNum);
        const details = node.keyIsLowEntropy
          ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
          : `Key shared with nodes: ${otherNodes.join(', ')}`;

        databaseService.upsertNode({
          nodeNum,
          nodeId: node.nodeId,
          duplicateKeyDetected: true,
          keySecurityIssueDetails: details
        });
      }
      logger.info(`🔐 Detected ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
    }

    res.json({
      success: true,
      duplicatesFound: duplicates.size,
      affectedNodes: Array.from(duplicates.values()).flat(),
      totalNodesScanned: nodesWithKeys.length
    });
  } catch (error) {
    logger.error('Error scanning for duplicate keys:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to scan for duplicate keys',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred'
    };
    res.status(500).json(errorResponse);
  }
});

apiRouter.get('/messages', optionalAuth(), (req, res) => {
  try {
    // Check if user has either any channel permission or messages permission
    const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channel_0', 'read');
    const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' }
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

apiRouter.get('/messages/channel/:channel', optionalAuth(), (req, res) => {
  try {
    const requestedChannel = parseInt(req.params.channel);
    const limit = parseInt(req.query.limit as string) || 100;

    // Check if this is a Primary channel request and map to channel 0 messages
    let messageChannel = requestedChannel;
    // In Meshtastic, channel 0 is always the Primary channel
    // If the requested channel is 0, use it directly
    if (requestedChannel === 0) {
      messageChannel = 0;
    }

    // Check per-channel read permission
    const channelResource = `channel_${messageChannel}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !hasPermission(req.user!, channelResource, 'read')) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'read' }
      });
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
    const { messageIds, channelId, nodeId, beforeTimestamp } = req.body;

    // If marking by channelId, check per-channel read permission
    if (channelId !== undefined && channelId !== null && channelId !== -1) {
      const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !hasPermission(req.user!, channelResource, 'read')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'read' }
        });
      }
    }

    // If marking by nodeId (DMs), check messages permission
    if (nodeId && channelId === -1) {
      const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');
      if (!hasMessagesRead) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'read' }
        });
      }
    }

    const userId = req.user?.id ?? null;
    let markedCount = 0;

    if (messageIds && Array.isArray(messageIds)) {
      // Mark specific messages as read
      databaseService.markMessagesAsRead(messageIds, userId);
      markedCount = messageIds.length;
    } else if (channelId !== undefined) {
      // Mark all messages in a channel as read (specific channel permission already checked above)
      markedCount = databaseService.markChannelMessagesAsRead(channelId, userId, beforeTimestamp);
    } else if (nodeId) {
      // Mark all DMs with a node as read (permission already checked above)
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
    // Check if user has either any channel permission or messages permission
    const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channel_0', 'read');
    const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' }
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

// Get Virtual Node server status (requires authentication)
apiRouter.get('/virtual-node/status', requireAuth(), (_req, res) => {
  try {
    const virtualNodeServer = (global as any).virtualNodeServer;

    if (!virtualNodeServer) {
      return res.json({
        enabled: false,
        isRunning: false,
        clientCount: 0,
        clients: []
      });
    }

    const isRunning = virtualNodeServer.isRunning();
    const clientCount = virtualNodeServer.getClientCount();
    const clients = virtualNodeServer.getClientDetails();

    res.json({
      enabled: true,
      isRunning,
      clientCount,
      clients
    });
  } catch (error) {
    logger.error('Error getting virtual node status:', error);
    res.status(500).json({ error: 'Failed to get virtual node status' });
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
apiRouter.get('/channels/all', requirePermission('channel_0', 'read'), (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();
    logger.debug(`📡 Serving all ${allChannels.length} channels (unfiltered)`);
    res.json(allChannels);
  } catch (error) {
    logger.error('Error fetching all channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

apiRouter.get('/channels', requirePermission('channel_0', 'read'), (_req, res) => {
  try {
    const allChannels = databaseService.getAllChannels();

    // Channel 0 will be created automatically when device config syncs
    // It should have an empty name as per Meshtastic protocol

    // Filter channels to only show configured ones
    // Meshtastic supports channels 0-7 (8 total)
    const filteredChannels = allChannels.filter(channel => {
      // Exclude disabled channels (role === 0)
      if (channel.role === 0) {
        return false;
      }

      // Always show channel 0 (Primary channel)
      if (channel.id === 0) {
        return true;
      }

      // Show channels 1-7 if they have a PSK configured (indicating they're in use)
      if (channel.id >= 1 && channel.id <= 7 && channel.psk) {
        return true;
      }

      // Show channels with a role defined (PRIMARY, SECONDARY)
      if (channel.role !== null && channel.role !== undefined) {
        return true;
      }

      return false;
    });

    // Ensure Primary channel (ID 0) is first in the list
    const primaryIndex = filteredChannels.findIndex(ch => ch.id === 0);
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
apiRouter.get('/channels/:id/export', requirePermission('channel_0', 'read'), (req, res) => {
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
apiRouter.put('/channels/:id', requirePermission('channel_0', 'write'), async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0 || channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID. Must be between 0-7' });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = req.body;

    // Validate name if provided (allow empty names for unnamed channels)
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'Channel name must be a string' });
      }
      if (name.length > 11) {
        return res.status(400).json({ error: 'Channel name must be 11 characters or less' });
      }
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

    // Prepare the updated channel data
    const updatedChannelData = {
      id: channelId,
      name: (name !== undefined && name !== null) ? name : existingChannel.name,
      psk: (psk !== undefined && psk !== null) ? psk : existingChannel.psk,
      role: (role !== undefined && role !== null) ? role : existingChannel.role,
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : existingChannel.uplinkEnabled,
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : existingChannel.downlinkEnabled,
      positionPrecision: (positionPrecision !== undefined && positionPrecision !== null) ? positionPrecision : existingChannel.positionPrecision
    };

    // Update channel in database
    databaseService.upsertChannel(updatedChannelData);

    // Send channel configuration to Meshtastic device
    try {
      await meshtasticManager.setChannelConfig(channelId, {
        name: updatedChannelData.name,
        psk: updatedChannelData.psk === '' ? undefined : updatedChannelData.psk,
        role: updatedChannelData.role,
        uplinkEnabled: updatedChannelData.uplinkEnabled,
        downlinkEnabled: updatedChannelData.downlinkEnabled,
        positionPrecision: updatedChannelData.positionPrecision
      });
      logger.info(`✅ Sent channel ${channelId} configuration to device`);
    } catch (deviceError) {
      logger.error(`⚠️ Failed to send channel ${channelId} config to device:`, deviceError);
      // Continue even if device update fails - database is updated
    }

    const updatedChannel = databaseService.getChannelById(channelId);
    logger.info(`✅ Updated channel ${channelId}: ${name}`);
    res.json({ success: true, channel: updatedChannel });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Import a channel configuration to a specific slot
apiRouter.post('/channels/:slotId/import', requirePermission('channel_0', 'write'), async (req, res) => {
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

    // Prepare the imported channel data
    const importedChannelData = {
      id: slotId,
      name,
      psk: psk || undefined,
      role: (role !== null && role !== undefined) ? role : undefined,
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : true,
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : true,
      positionPrecision: (positionPrecision !== null && positionPrecision !== undefined) ? positionPrecision : undefined
    };

    // Import channel to the specified slot in database
    databaseService.upsertChannel(importedChannelData);

    // Send channel configuration to Meshtastic device
    try {
      await meshtasticManager.setChannelConfig(slotId, {
        name: importedChannelData.name,
        psk: importedChannelData.psk,
        role: importedChannelData.role,
        uplinkEnabled: importedChannelData.uplinkEnabled,
        downlinkEnabled: importedChannelData.downlinkEnabled,
        positionPrecision: importedChannelData.positionPrecision
      });
      logger.info(`✅ Sent imported channel ${slotId} configuration to device`);
    } catch (deviceError) {
      logger.error(`⚠️ Failed to send imported channel ${slotId} config to device:`, deviceError);
      // Continue even if device update fails - database is updated
    }

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
      .map(ch => {
        logger.info(`📡 Channel ${ch.id} from DB - name: "${ch.name}" (length: ${ch.name.length})`);
        return {
          psk: ch.psk ? ch.psk : 'none',
          name: ch.name, // Use the actual name from database (preserved from device)
          uplinkEnabled: ch.uplinkEnabled,
          downlinkEnabled: ch.downlinkEnabled,
          positionPrecision: ch.positionPrecision
        };
      });

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
          // IMPORTANT: Always force txEnabled to true for exported configs
          // This ensures that when someone imports the config, TX is always enabled
          txEnabled: true,
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

// Import configuration from URL
apiRouter.post('/channels/import-config', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { url: configUrl } = req.body;

    if (!configUrl || typeof configUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    logger.info(`📥 Importing configuration from URL: ${configUrl}`);

    // Dynamically import channelUrlService
    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Decode the URL to get channels and lora config
    const decoded = channelUrlService.decodeUrl(configUrl);

    if (!decoded || (!decoded.channels && !decoded.loraConfig)) {
      return res.status(400).json({ error: 'Invalid or empty configuration URL' });
    }

    logger.info(`📥 Decoded ${decoded.channels?.length || 0} channels, LoRa config: ${!!decoded.loraConfig}`);

    // Begin edit settings transaction to batch all changes
    try {
      logger.info(`🔄 Beginning edit settings transaction for import`);
      await meshtasticManager.beginEditSettings();
      logger.info(`✅ Edit settings transaction started`);
    } catch (error) {
      logger.error(`❌ Failed to begin edit settings transaction:`, error);
      throw new Error('Failed to start configuration transaction');
    }

    // Import channels FIRST (before LoRa config to avoid premature reboot)
    const importedChannels = [];
    if (decoded.channels && decoded.channels.length > 0) {
      for (let i = 0; i < decoded.channels.length; i++) {
        const channel = decoded.channels[i];
        try {
          logger.info(`📥 Importing channel ${i}: ${channel.name || '(unnamed)'}`);

          // Determine role: if not specified, channel 0 is PRIMARY (1), others are SECONDARY (2)
          let role = channel.role;
          if (role === undefined) {
            role = i === 0 ? 1 : 2; // PRIMARY for channel 0, SECONDARY for others
          }

          // Write channel to device via Meshtastic manager
          await meshtasticManager.setChannelConfig(i, {
            name: channel.name || '',
            psk: channel.psk === 'none' ? undefined : channel.psk,
            role: role,
            uplinkEnabled: channel.uplinkEnabled,
            downlinkEnabled: channel.downlinkEnabled,
            positionPrecision: channel.positionPrecision
          });

          importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
          logger.info(`✅ Imported channel ${i}`);
        } catch (error) {
          logger.error(`❌ Failed to import channel ${i}:`, error);
          // Continue with other channels even if one fails
        }
      }
    }

    // Import LoRa config (part of transaction, won't trigger reboot yet)
    let loraImported = false;
    let requiresReboot = false;
    if (decoded.loraConfig) {
      try {
        logger.info(`📥 Importing LoRa config:`, JSON.stringify(decoded.loraConfig, null, 2));

        // IMPORTANT: Always force txEnabled to true
        // MeshMonitor users need TX enabled to send messages
        // Ignore any incoming configuration that tries to disable TX
        const loraConfigToImport = {
          ...decoded.loraConfig,
          txEnabled: true
        };

        logger.info(`📥 LoRa config with txEnabled defaulted: txEnabled=${loraConfigToImport.txEnabled}`);
        await meshtasticManager.setLoRaConfig(loraConfigToImport);
        loraImported = true;
        requiresReboot = true; // LoRa config requires reboot when committed
        logger.info(`✅ Imported LoRa config`);
      } catch (error) {
        logger.error(`❌ Failed to import LoRa config:`, error);
      }
    }

    // Commit all changes (channels + LoRa config) as a single transaction
    // This will save everything to flash and trigger device reboot if needed
    try {
      logger.info(`💾 Committing all configuration changes (${importedChannels.length} channels${loraImported ? ' + LoRa config' : ''})...`);
      await meshtasticManager.commitEditSettings();
      logger.info(`✅ Configuration changes committed successfully`);
    } catch (error) {
      logger.error(`❌ Failed to commit configuration changes:`, error);
    }

    res.json({
      success: true,
      imported: {
        channels: importedChannels.length,
        channelDetails: importedChannels,
        loraConfig: loraImported
      },
      requiresReboot
    });
  } catch (error) {
    logger.error('Error importing configuration:', error);
    res.status(500).json({ error: 'Failed to import configuration' });
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
apiRouter.post('/messages/send', optionalAuth(), async (req, res) => {
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

    // Map channel to mesh network
    // Channel must be 0-7 for Meshtastic. If undefined or invalid, default to 0 (Primary)
    let meshChannel = (channel !== undefined && channel >= 0 && channel <= 7) ? channel : 0;
    logger.info(`📨 Sending message - Received channel: ${channel}, Using meshChannel: ${meshChannel}, Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    // Check permissions based on whether this is a DM or channel message
    if (destinationNum) {
      // Direct message - check 'messages' write permission
      if (!req.user?.isAdmin && !hasPermission(req.user!, 'messages', 'write')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'write' }
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelResource = `channel_${meshChannel}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !hasPermission(req.user!, channelResource, 'write')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'write' }
        });
      }
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

    // Look up the node to get its channel
    const node = databaseService.getNode(destinationNum);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    await meshtasticManager.sendTraceroute(destinationNum, channel);
    res.json({ success: true, message: `Traceroute request sent to ${destinationNum.toString(16)} on channel ${channel}` });
  } catch (error) {
    logger.error('Error sending traceroute:', error);
    res.status(500).json({ error: 'Failed to send traceroute' });
  }
});

// Position request endpoint
apiRouter.post('/position/request', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel
    const node = databaseService.getNode(destinationNum);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const { packetId, requestId } = await meshtasticManager.sendPositionRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    logger.info(`📍 localNodeInfo for system message: ${localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'}`);

    if (localNodeInfo) {
      // Create a system message to record the position request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = (channel === 0) ? -1 : channel;

      logger.info(`📍 Inserting position request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId})`);
      databaseService.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: 'Position exchange requested',
        channel: messageChannel,
        portnum: 1, // TEXT_MESSAGE_APP so it shows in DM view (DM filter requires portnum === 1)
        requestId: requestId, // Store requestId for ACK matching
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: timestamp
      });
      logger.info(`📍 Position request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for position request - localNodeInfo is null`);
    }

    res.json({ success: true, message: `Position request sent to ${destinationNum.toString(16)} on channel ${channel}` });
  } catch (error) {
    logger.error('Error sending position request:', error);
    res.status(500).json({ error: 'Failed to send position request' });
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

// Get traceroute history for a specific source-destination pair
apiRouter.get('/traceroutes/history/:fromNodeNum/:toNodeNum', (req, res) => {
  try {
    const fromNodeNum = parseInt(req.params.fromNodeNum);
    const toNodeNum = parseInt(req.params.toNodeNum);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;

    // Validate node numbers
    if (isNaN(fromNodeNum) || isNaN(toNodeNum)) {
      res.status(400).json({ error: 'Invalid node numbers provided' });
      return;
    }

    // Validate node numbers are positive integers (Meshtastic node numbers are 32-bit unsigned)
    if (fromNodeNum < 0 || fromNodeNum > 0xFFFFFFFF || toNodeNum < 0 || toNodeNum > 0xFFFFFFFF) {
      res.status(400).json({ error: 'Node numbers must be between 0 and 4294967295' });
      return;
    }

    // Validate limit parameter
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: 'Limit must be between 1 and 1000' });
      return;
    }

    const traceroutes = databaseService.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit);

    const traceroutesWithHops = traceroutes.map(tr => {
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
    logger.error('Error fetching traceroute history:', error);
    res.status(500).json({ error: 'Failed to fetch traceroute history' });
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

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = databaseService.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - (maxNodeAgeHours * 60 * 60);

    // Enrich with node names and filter by node age
    const enrichedNeighborInfo = neighborInfo
      .map(ni => {
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
          neighborLongitude: neighbor?.longitude,
          node,
          neighbor
        };
      })
      .filter(ni => {
        // Filter out connections where either node is too old or missing lastHeard
        if (!ni.node?.lastHeard || !ni.neighbor?.lastHeard) {
          return false;
        }
        return ni.node.lastHeard >= cutoffTime && ni.neighbor.lastHeard >= cutoffTime;
      })
      .map(({ node, neighbor, ...rest }) => rest); // Remove the temporary node/neighbor fields

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
    // Dynamic bucketing automatically adjusts interval based on time range:
    // - 0-24h: 3-minute intervals (high detail)
    // - 1-7d: 30-minute intervals (medium detail)
    // - 7d+: 2-hour intervals (low detail, full coverage)
    const recentTelemetry = databaseService.getTelemetryByNodeAveraged(nodeId, cutoffTime, undefined, hoursParam);
    res.json(recentTelemetry);
  } catch (error) {
    logger.error('Error fetching telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// Delete telemetry data for a specific node and type
apiRouter.delete('/telemetry/:nodeId/:telemetryType', requireAuth(), requirePermission('info', 'write'), (req, res) => {
  try {
    const { nodeId, telemetryType } = req.params;

    logger.info(`Purging telemetry data for node ${nodeId}, type ${telemetryType}`);

    const deleted = databaseService.deleteTelemetryByNodeAndType(nodeId, telemetryType);

    if (deleted) {
      logger.info(`Successfully purged ${telemetryType} telemetry for node ${nodeId}`);
      res.json({ success: true, message: `Telemetry data purged successfully` });
    } else {
      res.status(404).json({ error: 'No telemetry data found to delete' });
    }
  } catch (error) {
    logger.error('Error purging telemetry data:', error);
    res.status(500).json({ error: 'Failed to purge telemetry data' });
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

    // Get the local node ID to ensure it's always marked as secure
    const localNodeNumStr = databaseService.getSetting('localNodeNum');
    let localNodeId: string | null = null;
    if (localNodeNumStr) {
      const localNodeNum = parseInt(localNodeNumStr, 10);
      localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
    }

    nodes.forEach(node => {
      // Local node is always secure (direct TCP/serial connection, no mesh encryption needed)
      // OR node has PKC enabled
      if (node.nodeId === localNodeId || node.hasPKC || node.publicKey) {
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
apiRouter.get('/connection', optionalAuth(), (req, res) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    // Hide nodeIp from anonymous users
    if (!req.session.userId) {
      const { nodeIp, ...statusWithoutNodeIp } = status;
      res.json(statusWithoutNodeIp);
    } else {
      res.json(status);
    }
  } catch (error) {
    logger.error('Error getting connection status:', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

// Check if TX is disabled
apiRouter.get('/device/tx-status', optionalAuth(), async (_req, res) => {
  try {
    const deviceConfig = await meshtasticManager.getDeviceConfig();
    const txEnabled = deviceConfig?.lora?.txEnabled !== false; // Default to true if undefined
    res.json({ txEnabled });
  } catch (error) {
    logger.error('Error getting TX status:', error);
    res.status(500).json({ error: 'Failed to get TX status' });
  }
});

// Consolidated polling endpoint - reduces multiple API calls to one
apiRouter.get('/poll', optionalAuth(), async (req, res) => {
  logger.info('🔔 [POLL] Endpoint called');
  try {
    const result: {
      connection?: any;
      nodes?: any[];
      messages?: any[];
      unreadCounts?: any;
      channels?: any[];
      telemetryNodes?: any;
      config?: any;
      deviceConfig?: any;
    } = {};

    // 1. Connection status (always available)
    try {
      const connectionStatus = meshtasticManager.getConnectionStatus();
      // Hide nodeIp from anonymous users
      if (!req.session.userId) {
        const { nodeIp, ...statusWithoutNodeIp } = connectionStatus;
        result.connection = statusWithoutNodeIp;
      } else {
        result.connection = connectionStatus;
      }
    } catch (error) {
      logger.error('Error getting connection status in poll:', error);
      result.connection = { error: 'Failed to get connection status' };
    }

    // 2. Nodes (always available with optionalAuth)
    try {
      const nodes = meshtasticManager.getAllNodes();

      // Enhance nodes with estimated positions if no regular position is available
      // Mobile status is now pre-computed in the database during packet processing
      const enhancedNodes = nodes.map(node => {
        if (!node.user?.id) return { ...node, isMobile: false };

        let enhancedNode = { ...node, isMobile: node.mobile === 1 };

        // If node doesn't have a regular position, check for estimated position
        if (!node.position?.latitude && !node.position?.longitude) {
          // Get only the most recent estimated position (limit 1 of each type)
          const positionTelemetry = databaseService.getPositionTelemetryByNode(node.user.id, 2);
          const estimatedLatitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_latitude');
          const estimatedLongitudes = positionTelemetry.filter(t => t.telemetryType === 'estimated_longitude');

          if (estimatedLatitudes.length > 0 && estimatedLongitudes.length > 0) {
            const latestEstimatedLat = estimatedLatitudes[0];
            const latestEstimatedLon = estimatedLongitudes[0];

            enhancedNode.position = {
              latitude: latestEstimatedLat.value,
              longitude: latestEstimatedLon.value,
              altitude: node.position?.altitude
            };
          }
        }

        return enhancedNode;
      });

      result.nodes = enhancedNodes;
    } catch (error) {
      logger.error('Error fetching nodes in poll:', error);
      result.nodes = [];
    }

    // 3. Messages (requires any channel permission OR messages permission)
    try {
      const hasChannelsRead = req.user?.isAdmin || hasPermission(req.user!, 'channel_0', 'read');
      const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

      if (hasChannelsRead || hasMessagesRead) {
        let messages = meshtasticManager.getRecentMessages(100);

        // Filter messages based on permissions
        if (hasChannelsRead && !hasMessagesRead) {
          messages = messages.filter(msg => msg.channel !== -1);
        } else if (hasMessagesRead && !hasChannelsRead) {
          messages = messages.filter(msg => msg.channel === -1);
        }

        result.messages = messages;
      }
    } catch (error) {
      logger.error('Error fetching messages in poll:', error);
    }

    // 4. Unread counts (requires channels OR messages permission)
    try {
      const userId = req.user?.id ?? null;
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      const hasMessagesRead = req.user?.isAdmin || hasPermission(req.user!, 'messages', 'read');

      const unreadResult: {
        channels?: {[channelId: number]: number},
        directMessages?: {[nodeId: string]: number}
      } = {};

      // Get unread counts for all channels first
      const allUnreadChannels = databaseService.getUnreadCountsByChannel(userId);

      // Filter channels based on per-channel read permission
      const filteredUnreadChannels: {[channelId: number]: number} = {};
      for (const [channelIdStr, count] of Object.entries(allUnreadChannels)) {
        const channelId = parseInt(channelIdStr);
        const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = req.user?.isAdmin || hasPermission(req.user!, channelResource, 'read');

        if (hasChannelRead) {
          filteredUnreadChannels[channelId] = count;
        }
      }
      unreadResult.channels = filteredUnreadChannels;

      if (hasMessagesRead && localNodeInfo) {
        const directMessages: {[nodeId: string]: number} = {};
        const allNodes = meshtasticManager.getAllNodes();
        for (const node of allNodes) {
          if (node.user?.id) {
            const count = databaseService.getUnreadDMCount(localNodeInfo.nodeId, node.user.id, userId);
            if (count > 0) {
              directMessages[node.user.id] = count;
            }
          }
        }
        unreadResult.directMessages = directMessages;
      }

      result.unreadCounts = unreadResult;
    } catch (error) {
      logger.error('Error fetching unread counts in poll:', error);
    }

    // 5. Channels (filtered based on per-channel read permissions)
    try {
      const allChannels = databaseService.getAllChannels();

      const filteredChannels = allChannels.filter(channel => {
        // Exclude disabled channels (role === 0)
        if (channel.role === 0) {
          return false;
        }

        // Check per-channel read permission
        const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = req.user?.isAdmin || hasPermission(req.user!, channelResource, 'read');

        if (!hasChannelRead) {
          return false;  // User doesn't have permission to see this channel
        }

        // Show channel 0 (Primary channel) if user has permission
        if (channel.id === 0) return true;

        // Show channels 1-7 if they have a PSK configured (indicating they're in use)
        if (channel.id >= 1 && channel.id <= 7 && channel.psk) return true;

        // Show channels with a role defined (PRIMARY, SECONDARY)
        if (channel.role !== null && channel.role !== undefined) return true;

        return false;
      });

      // Ensure Primary channel (ID 0) is first in the list
      const primaryIndex = filteredChannels.findIndex(ch => ch.id === 0);
      if (primaryIndex > 0) {
        const primary = filteredChannels.splice(primaryIndex, 1)[0];
        filteredChannels.unshift(primary);
      }

      result.channels = filteredChannels;
    } catch (error) {
      logger.error('Error fetching channels in poll:', error);
    }

    // 6. Telemetry availability (requires info:read permission)
    try {
      const hasInfoRead = req.user?.isAdmin || hasPermission(req.user!, 'info', 'read');
      if (hasInfoRead) {
        const nodes = databaseService.getAllNodes();
        const nodesWithTelemetry: string[] = [];
        const nodesWithWeather: string[] = [];
        const nodesWithEstimatedPosition: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);
        const estimatedPositionTypes = new Set(['estimated_latitude', 'estimated_longitude']);

        const nodeTelemetryTypes = databaseService.getAllNodesTelemetryTypes();

        nodes.forEach(node => {
          const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
          if (telemetryTypes && telemetryTypes.length > 0) {
            nodesWithTelemetry.push(node.nodeId);

            const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
            if (hasWeather) {
              nodesWithWeather.push(node.nodeId);
            }

            const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
            if (hasEstimatedPosition) {
              nodesWithEstimatedPosition.push(node.nodeId);
            }
          }
        });

        const nodesWithPKC: string[] = [];
        nodes.forEach(node => {
          if (node.hasPKC || node.publicKey) {
            nodesWithPKC.push(node.nodeId);
          }
        });

        result.telemetryNodes = {
          nodes: nodesWithTelemetry,
          weather: nodesWithWeather,
          estimatedPosition: nodesWithEstimatedPosition,
          pkc: nodesWithPKC
        };
      }
    } catch (error) {
      logger.error('Error checking telemetry availability in poll:', error);
    }

    // 7. Config (always available with optionalAuth)
    try {
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

          localNodeInfo = {
            nodeId: currentNode.nodeId,
            longName: currentNode.longName,
            shortName: currentNode.shortName
          };
        }
      }

      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL,
        deviceMetadata: deviceMetadata,
        localNodeInfo: localNodeInfo
      };
    } catch (error) {
      logger.error('Error in config section of poll:', error);
      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL
      };
    }

    // 8. Device config (requires configuration:read permission)
    try {
      const hasConfigRead = req.user?.isAdmin || hasPermission(req.user!, 'configuration', 'read');
      if (hasConfigRead) {
        const config = await meshtasticManager.getDeviceConfig();
        if (config) {
          // Hide node address from anonymous users
          if (!req.session.userId && config.basic) {
            const { nodeAddress, ...basicWithoutNodeAddress } = config.basic;
            result.deviceConfig = {
              ...config,
              basic: basicWithoutNodeAddress
            };
          } else {
            result.deviceConfig = config;
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching device config in poll:', error);
    }

    res.json(result);
  } catch (error) {
    logger.error('Error in consolidated poll endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch polling data' });
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
apiRouter.get('/config', optionalAuth(), async (req, res) => {
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
      ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false,  // We're using TCP, not TLS
      baseUrl: BASE_URL,
      deviceMetadata: deviceMetadata,
      localNodeInfo: localNodeInfo
    });
  } catch (error) {
    logger.error('Error in /api/config:', error);
    res.json({
      ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
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

// Export complete device configuration as YAML backup
// Compatible with Meshtastic CLI --export-config format
// Query param ?save=true will save to disk instead of just downloading
apiRouter.get('/device/backup', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const saveToFile = req.query.save === 'true';
    logger.info(`📦 Device backup requested (save=${saveToFile})...`);

    // Generate YAML backup using the device backup service
    const yamlBackup = await deviceBackupService.generateBackup(meshtasticManager);

    // Get node ID for filename
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const nodeId = localNodeInfo?.nodeId || '!unknown';

    if (saveToFile) {
      // Save to disk with new filename format
      const filename = await backupFileService.saveBackup(yamlBackup, 'manual', nodeId);

      // Also send the file for download
      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(yamlBackup);

      logger.info(`✅ Device backup saved and downloaded: ${filename}`);
    } else {
      // Just download, don't save - generate filename for display
      const nodeIdNumber = nodeId.startsWith('!') ? nodeId.substring(1) : nodeId;
      const now = new Date();
      const date = now.toISOString().split('T')[0];
      const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `${nodeIdNumber}-${date}-${time}.yaml`;

      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(yamlBackup);

      logger.info(`✅ Device backup generated: ${filename}`);
    }
  } catch (error) {
    logger.error('❌ Error generating device backup:', error);
    res.status(500).json({
      error: 'Failed to generate device backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get backup settings
apiRouter.get('/backup/settings', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const enabled = databaseService.getSetting('backup_enabled') === 'true';
    const maxBackups = parseInt(databaseService.getSetting('backup_maxBackups') || '7', 10);
    const backupTime = databaseService.getSetting('backup_time') || '02:00';

    res.json({
      enabled,
      maxBackups,
      backupTime
    });
  } catch (error) {
    logger.error('❌ Error getting backup settings:', error);
    res.status(500).json({
      error: 'Failed to get backup settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save backup settings
apiRouter.post('/backup/settings', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { enabled, maxBackups, backupTime } = req.body;

    // Validate inputs
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value' });
    }

    if (typeof maxBackups !== 'number' || maxBackups < 1 || maxBackups > 365) {
      return res.status(400).json({ error: 'Invalid maxBackups value (must be 1-365)' });
    }

    if (!backupTime || !/^\d{2}:\d{2}$/.test(backupTime)) {
      return res.status(400).json({ error: 'Invalid backupTime format (must be HH:MM)' });
    }

    // Save settings
    databaseService.setSetting('backup_enabled', enabled.toString());
    databaseService.setSetting('backup_maxBackups', maxBackups.toString());
    databaseService.setSetting('backup_time', backupTime);

    logger.info(`⚙️  Backup settings updated: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error saving backup settings:', error);
    res.status(500).json({
      error: 'Failed to save backup settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List all backups
apiRouter.get('/backup/list', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const backups = await backupFileService.listBackups();
    res.json(backups);
  } catch (error) {
    logger.error('❌ Error listing backups:', error);
    res.status(500).json({
      error: 'Failed to list backups',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Download a specific backup
apiRouter.get('/backup/download/:filename', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal - only allow alphanumeric, hyphens, underscores, and .yaml extension
    if (!/^[a-zA-Z0-9\-_]+\.yaml$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }

    const content = await backupFileService.getBackup(filename);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);

    logger.info(`📥 Backup downloaded: ${filename}`);
  } catch (error) {
    logger.error('❌ Error downloading backup:', error);
    res.status(500).json({
      error: 'Failed to download backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete a specific backup
apiRouter.delete('/backup/delete/:filename', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal - only allow alphanumeric, hyphens, underscores, and .yaml extension
    if (!/^[a-zA-Z0-9\-_]+\.yaml$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename format' });
    }

    await backupFileService.deleteBackup(filename);

    logger.info(`🗑️  Backup deleted: ${filename}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error deleting backup:', error);
    res.status(500).json({
      error: 'Failed to delete backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ========== System Backup Endpoints ==========

// Create a system backup (exports all database tables to JSON)
apiRouter.post('/system/backup', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    logger.info('📦 System backup requested...');

    const dirname = await systemBackupService.createBackup('manual');

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'system_backup_created',
      'system_backup',
      JSON.stringify({ dirname, type: 'manual' }),
      req.ip || null
    );

    logger.info(`✅ System backup created: ${dirname}`);

    res.json({
      success: true,
      dirname,
      message: 'System backup created successfully'
    });
  } catch (error) {
    logger.error('❌ Error creating system backup:', error);
    res.status(500).json({
      error: 'Failed to create system backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List all system backups
apiRouter.get('/system/backup/list', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const backups = await systemBackupService.listBackups();
    res.json(backups);
  } catch (error) {
    logger.error('❌ Error listing system backups:', error);
    res.status(500).json({
      error: 'Failed to list system backups',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Download a system backup as tar.gz
apiRouter.get('/system/backup/download/:dirname', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const { dirname } = req.params;

    // Validate dirname to prevent directory traversal - only allow date format YYYY-MM-DD_HHMMSS
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(dirname)) {
      return res.status(400).json({ error: 'Invalid backup directory name format' });
    }

    const backupPath = systemBackupService.getBackupPath(dirname);
    const archiver = await import('archiver');
    const fs = await import('fs');

    // Check if backup exists
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    // Create tar.gz archive on-the-fly
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${dirname}.tar.gz"`);

    const archive = archiver.default('tar', {
      gzip: true,
      gzipOptions: { level: 9 }
    });

    archive.on('error', (err) => {
      logger.error('❌ Error creating archive:', err);
      res.status(500).json({ error: 'Failed to create archive' });
    });

    // Audit log before streaming
    databaseService.auditLog(
      req.user!.id,
      'system_backup_downloaded',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    archive.pipe(res);
    archive.directory(backupPath, dirname);
    await archive.finalize();

    logger.info(`📥 System backup downloaded: ${dirname}`);
  } catch (error) {
    logger.error('❌ Error downloading system backup:', error);
    res.status(500).json({
      error: 'Failed to download system backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Delete a system backup
apiRouter.delete('/system/backup/delete/:dirname', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { dirname } = req.params;

    // Validate dirname to prevent directory traversal
    if (!/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(dirname)) {
      return res.status(400).json({ error: 'Invalid backup directory name format' });
    }

    await systemBackupService.deleteBackup(dirname);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'system_backup_deleted',
      'system_backup',
      JSON.stringify({ dirname }),
      req.ip || null
    );

    logger.info(`🗑️  System backup deleted: ${dirname}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error deleting system backup:', error);
    res.status(500).json({
      error: 'Failed to delete system backup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get system backup settings
apiRouter.get('/system/backup/settings', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const enabled = databaseService.getSetting('system_backup_enabled') === 'true';
    const maxBackups = parseInt(databaseService.getSetting('system_backup_maxBackups') || '7', 10);
    const backupTime = databaseService.getSetting('system_backup_time') || '03:00';

    res.json({
      enabled,
      maxBackups,
      backupTime
    });
  } catch (error) {
    logger.error('❌ Error getting system backup settings:', error);
    res.status(500).json({
      error: 'Failed to get system backup settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Save system backup settings
apiRouter.post('/system/backup/settings', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { enabled, maxBackups, backupTime } = req.body;

    // Validate inputs
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value' });
    }

    if (typeof maxBackups !== 'number' || maxBackups < 1 || maxBackups > 365) {
      return res.status(400).json({ error: 'Invalid maxBackups value (must be 1-365)' });
    }

    if (!backupTime || !/^\d{2}:\d{2}$/.test(backupTime)) {
      return res.status(400).json({ error: 'Invalid backupTime format (must be HH:MM)' });
    }

    // Save settings
    databaseService.setSetting('system_backup_enabled', enabled.toString());
    databaseService.setSetting('system_backup_maxBackups', maxBackups.toString());
    databaseService.setSetting('system_backup_time', backupTime);

    logger.info(`⚙️  System backup settings updated: enabled=${enabled}, maxBackups=${maxBackups}, time=${backupTime}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error saving system backup settings:', error);
    res.status(500).json({
      error: 'Failed to save system backup settings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
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

// Get auto-traceroute node filter settings
apiRouter.get('/settings/traceroute-nodes', requirePermission('settings', 'read'), (_req, res) => {
  try {
    const enabled = databaseService.isAutoTracerouteNodeFilterEnabled();
    const nodeNums = databaseService.getAutoTracerouteNodes();
    res.json({ enabled, nodeNums });
  } catch (error) {
    logger.error('Error fetching auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to fetch auto-traceroute node filter' });
  }
});

// Update auto-traceroute node filter settings
apiRouter.post('/settings/traceroute-nodes', requirePermission('settings', 'write'), (req, res) => {
  try {
    const { enabled, nodeNums } = req.body;

    // Validate input
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }

    if (!Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }

    // Validate all node numbers are valid integers
    for (const nodeNum of nodeNums) {
      if (!Number.isInteger(nodeNum) || nodeNum < 0) {
        return res.status(400).json({ error: 'All node numbers must be positive integers.' });
      }
    }

    // Update settings
    databaseService.setAutoTracerouteNodeFilterEnabled(enabled);
    databaseService.setAutoTracerouteNodes(nodeNums);

    res.json({ success: true, enabled, nodeNums });
  } catch (error) {
    logger.error('Error updating auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to update auto-traceroute node filter' });
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
    const validKeys = ['maxNodeAgeHours', 'tracerouteIntervalMinutes', 'temperatureUnit', 'distanceUnit', 'telemetryVisualizationHours', 'telemetryFavorites', 'autoAckEnabled', 'autoAckRegex', 'autoAckMessage', 'autoAckChannels', 'autoAckDirectMessages', 'autoAckUseDM', 'autoAnnounceEnabled', 'autoAnnounceIntervalHours', 'autoAnnounceMessage', 'autoAnnounceChannelIndex', 'autoAnnounceOnStart', 'autoAnnounceUseSchedule', 'autoAnnounceSchedule', 'autoWelcomeEnabled', 'autoWelcomeMessage', 'autoWelcomeTarget', 'autoWelcomeWaitForName', 'autoWelcomeMaxHops', 'autoResponderEnabled', 'autoResponderTriggers', 'preferredSortField', 'preferredSortDirection', 'timeFormat', 'dateFormat', 'mapTileset', 'packet_log_enabled', 'packet_log_max_count', 'packet_log_max_age_hours', 'solarMonitoringEnabled', 'solarMonitoringLatitude', 'solarMonitoringLongitude', 'solarMonitoringAzimuth', 'solarMonitoringDeclination', 'mapPinStyle', 'favoriteTelemetryStorageDays', 'theme'];
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

    // Validate autoResponderTriggers JSON
    if ('autoResponderTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.autoResponderTriggers);

        // Validate that it's an array
        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'autoResponderTriggers must be an array' });
        }

        // Validate each trigger
        for (const trigger of triggers) {
          if (!trigger.id || !trigger.trigger || !trigger.responseType || !trigger.response) {
            return res.status(400).json({ error: 'Each trigger must have id, trigger, responseType, and response fields' });
          }

          if (trigger.responseType !== 'text' && trigger.responseType !== 'http' && trigger.responseType !== 'script') {
            return res.status(400).json({ error: 'responseType must be "text", "http", or "script"' });
          }

          // Validate script paths
          if (trigger.responseType === 'script') {
            if (!trigger.response.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Script path must start with /data/scripts/' });
            }
            if (trigger.response.includes('..')) {
              return res.status(400).json({ error: 'Script path cannot contain ..' });
            }
            const ext = trigger.response.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res.status(400).json({ error: 'Script must have .js, .mjs, .py, or .sh extension' });
            }
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for autoResponderTriggers' });
      }
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

    // Restart announce scheduler if announce settings changed
    const announceSettings = ['autoAnnounceEnabled', 'autoAnnounceIntervalHours', 'autoAnnounceUseSchedule', 'autoAnnounceSchedule'];
    const announceSettingsChanged = announceSettings.some(key => key in filteredSettings);
    if (announceSettingsChanged) {
      meshtasticManager.restartAnnounceScheduler();
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

// Custom Themes endpoints

// Get all custom themes (available to all users for reading)
apiRouter.get('/themes', optionalAuth(), (_req, res) => {
  try {
    const themes = databaseService.getAllCustomThemes();
    res.json({ themes });
  } catch (error) {
    logger.error('Error fetching custom themes:', error);
    res.status(500).json({ error: 'Failed to fetch custom themes' });
  }
});

// Get a specific theme by slug
apiRouter.get('/themes/:slug', optionalAuth(), (req, res) => {
  try {
    const { slug } = req.params;
    const theme = databaseService.getCustomThemeBySlug(slug);

    if (!theme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    res.json({ theme });
  } catch (error) {
    logger.error(`Error fetching theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to fetch theme' });
  }
});

// Create a new custom theme
apiRouter.post('/themes', requirePermission('themes', 'write'), (req, res) => {
  try {
    const { name, slug, definition } = req.body;

    // Validation
    if (!name || typeof name !== 'string' || name.length < 1 || name.length > 50) {
      return res.status(400).json({ error: 'Theme name must be 1-50 characters' });
    }

    if (!slug || typeof slug !== 'string' || !slug.match(/^custom-[a-z0-9-]+$/)) {
      return res.status(400).json({ error: 'Slug must start with "custom-" and contain only lowercase letters, numbers, and hyphens' });
    }

    // Check if theme already exists
    const existingTheme = databaseService.getCustomThemeBySlug(slug);
    if (existingTheme) {
      return res.status(409).json({ error: 'Theme with this slug already exists' });
    }

    // Validate theme definition
    if (!databaseService.validateThemeDefinition(definition)) {
      return res.status(400).json({ error: 'Invalid theme definition. All 26 color variables must be valid hex codes' });
    }

    // Create the theme
    const theme = databaseService.createCustomTheme(
      name,
      slug,
      definition,
      req.user!.id
    );

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'theme_created',
      'themes',
      `Created custom theme: ${name} (${slug})`,
      req.ip || null,
      null,
      JSON.stringify({ id: theme.id, name, slug })
    );

    res.status(201).json({ success: true, theme });
  } catch (error) {
    logger.error('Error creating custom theme:', error);
    res.status(500).json({ error: 'Failed to create custom theme' });
  }
});

// Update an existing custom theme
apiRouter.put('/themes/:slug', requirePermission('themes', 'write'), (req, res) => {
  try {
    const { slug } = req.params;
    const { name, definition } = req.body;

    // Get existing theme for audit log
    const existingTheme = databaseService.getCustomThemeBySlug(slug);
    if (!existingTheme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    if (existingTheme.is_builtin) {
      return res.status(403).json({ error: 'Cannot modify built-in themes' });
    }

    const updates: any = {};

    // Validate name if provided
    if (name !== undefined) {
      if (typeof name !== 'string' || name.length < 1 || name.length > 50) {
        return res.status(400).json({ error: 'Theme name must be 1-50 characters' });
      }
      updates.name = name;
    }

    // Validate definition if provided
    if (definition !== undefined) {
      if (!databaseService.validateThemeDefinition(definition)) {
        return res.status(400).json({ error: 'Invalid theme definition. All 26 color variables must be valid hex codes' });
      }
      updates.definition = definition;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    // Update the theme
    databaseService.updateCustomTheme(slug, updates);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'theme_updated',
      'themes',
      `Updated custom theme: ${existingTheme.name} (${slug})`,
      req.ip || null,
      JSON.stringify({ name: existingTheme.name }),
      JSON.stringify(updates)
    );

    res.json({ success: true });
  } catch (error) {
    logger.error(`Error updating theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

// Delete a custom theme
apiRouter.delete('/themes/:slug', requirePermission('themes', 'write'), (req, res) => {
  try {
    const { slug } = req.params;

    // Get theme for audit log before deletion
    const theme = databaseService.getCustomThemeBySlug(slug);
    if (!theme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    if (theme.is_builtin) {
      return res.status(403).json({ error: 'Cannot delete built-in themes' });
    }

    // Delete the theme
    databaseService.deleteCustomTheme(slug);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'theme_deleted',
      'themes',
      `Deleted custom theme: ${theme.name} (${slug})`,
      req.ip || null,
      JSON.stringify({ id: theme.id, name: theme.name, slug }),
      null
    );

    res.json({ success: true, message: 'Theme deleted successfully' });
  } catch (error) {
    logger.error(`Error deleting theme ${req.params.slug}:`, error);
    res.status(500).json({ error: 'Failed to delete theme' });
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

apiRouter.post('/purge/traceroutes', requireAdmin(), (req, res) => {
  try {
    databaseService.purgeAllTraceroutes();

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'traceroutes_purged',
      'traceroutes',
      'All traceroutes and route segments purged',
      req.ip || null
    );

    res.json({ success: true, message: 'All traceroutes and route segments purged' });
  } catch (error) {
    logger.error('Error purging traceroutes:', error);
    res.status(500).json({ error: 'Failed to purge traceroutes' });
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

    // IMPORTANT: Always force txEnabled to true
    // MeshMonitor users need TX enabled to send messages
    // Ignore any incoming configuration that tries to disable TX
    const loraConfigToSet = {
      ...config,
      txEnabled: true
    };

    logger.info(`⚙️ Setting LoRa config with txEnabled defaulted: txEnabled=${loraConfigToSet.txEnabled}`);
    await meshtasticManager.setLoRaConfig(loraConfigToSet);
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
    const { longName, shortName, isUnmessagable } = req.body;
    if (!longName || !shortName) {
      res.status(400).json({ error: 'longName and shortName are required' });
      return;
    }
    await meshtasticManager.setNodeOwner(longName, shortName, isUnmessagable);
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

apiRouter.post('/device/purge-nodedb', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const seconds = req.body?.seconds || 0;

    // Purge the device's node database
    await meshtasticManager.purgeNodeDb(seconds);

    // Also purge the local database
    logger.info('🗑️ Purging local node database');
    databaseService.purgeAllNodes();
    logger.info('✅ Local node database purged successfully');

    res.json({ success: true, message: `Node database purged (both device and local)${seconds > 0 ? ` in ${seconds} seconds` : ''}` });
  } catch (error) {
    logger.error('Error purging node database:', error);
    res.status(500).json({ error: 'Failed to purge node database' });
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

// Helper function to check if Docker image exists in GHCR
async function checkDockerImageExists(version: string, publishedAt?: string): Promise<boolean> {
  try {
    const owner = 'yeraze';
    const repo = 'meshmonitor';

    // STRATEGY 1: Query manifest directly (most reliable, avoids pagination issues)
    // Try both with and without 'v' prefix as GHCR may use either
    const tagsToTry = [version, `v${version}`];

    for (const tag of tagsToTry) {
      try {
        // Step 1: Get anonymous token from GHCR
        const tokenUrl = `https://ghcr.io/token?scope=repository:${owner}/${repo}:pull`;
        const tokenResponse = await fetch(tokenUrl);

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          const token = tokenData.token;

          // Step 2: Try to fetch the manifest for this specific tag
          const manifestUrl = `https://ghcr.io/v2/${owner}/${repo}/manifests/${tag}`;
          const manifestResponse = await fetch(manifestUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.docker.distribution.manifest.v2+json'
            }
          });

          if (manifestResponse.ok) {
            logger.info(`✓ Image for ${version} (tag: ${tag}) found in GitHub Container Registry`);
            return true;
          }
        }
      } catch (manifestError) {
        logger.debug(`Manifest check failed for tag ${tag}:`, manifestError);
        // Try next tag variant
      }
    }

    // If we reach here, manifest check failed for all tag variants
    logger.info(`⏳ Image for ${version} not found via manifest check, falling back to time-based heuristic`);

    // STRATEGY 2: Time-based heuristic fallback (only if manifest check failed)
    // GitHub Actions typically takes 10-30 minutes to build and push container images
    // If release was published more than 30 minutes ago, assume the build completed
    if (publishedAt) {
      const publishTime = new Date(publishedAt).getTime();
      const now = Date.now();
      const minutesSincePublish = (now - publishTime) / (60 * 1000);

      if (minutesSincePublish >= 30) {
        logger.info(`✓ Image for ${version} assumed ready (${Math.round(minutesSincePublish)} minutes since release, API check failed)`);
        return true;
      } else {
        logger.info(`⏳ Image for ${version} still building (${Math.round(minutesSincePublish)}/30 minutes since release)`);
        return false;
      }
    }

    // If no publish time provided and API failed, be conservative and return false
    logger.warn(`Cannot verify image availability for ${version} (no publish time and API failed)`);
    return false;
  } catch (error) {
    logger.warn(`Error checking Docker image existence for ${version}:`, error);
    // On error with known publish time, use time-based fallback
    if (publishedAt) {
      const minutesSincePublish = (Date.now() - new Date(publishedAt).getTime()) / (60 * 1000);
      const assumeReady = minutesSincePublish >= 30;
      if (assumeReady) {
        logger.info(`✓ Image for ${version} assumed ready (${Math.round(minutesSincePublish)} minutes since release, error during check)`);
      }
      return assumeReady;
    }
    // Otherwise fail closed to avoid false positives
    return false;
  }
}

// Version check endpoint - compares current version with latest GitHub release
let versionCheckCache: { data: any; timestamp: number } | null = null;
const VERSION_CHECK_CACHE_MS = 5 * 60 * 1000; // 5 minute cache (reduced to detect image availability sooner)

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
    const isNewerVersion = compareVersions(latestVersion, current) > 0;

    // Check if Docker image exists for this version (pass publish time for time-based heuristic)
    const imageReady = await checkDockerImageExists(latestVersion, release.published_at);

    // Only mark update as available if it's a newer version AND container image exists
    const updateAvailable = isNewerVersion && imageReady;

    const result = {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseName: release.name,
      publishedAt: release.published_at,
      imageReady
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

      // Extract scheme using regex instead of URL parser
      // This allows Apprise URLs with special characters (colons, multiple slashes, etc.)
      // that don't conform to strict URL syntax but are valid for Apprise
      // Support both "scheme://" format and special cases like "mailto:"
      const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);

      if (!schemeMatch) {
        invalidUrls.push(url);
        return false;
      }

      const scheme = schemeMatch[1].toLowerCase();

      if (!ALLOWED_SCHEMES.includes(scheme)) {
        invalidUrls.push(url);
        return false;
      }

      return true;
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

// Public endpoint to list available scripts (no CSRF or auth required)
const scriptsEndpoint = (_req: any, res: any) => {
  try {
    const scriptsDir = getScriptsDirectory();

    // Check if directory exists
    if (!fs.existsSync(scriptsDir)) {
      logger.debug(`📁 Scripts directory does not exist: ${scriptsDir}`);
      return res.json({ scripts: [] });
    }

    // Read directory and filter for valid script extensions
    const files = fs.readdirSync(scriptsDir);
    const validExtensions = ['.js', '.mjs', '.py', '.sh'];

    const scripts = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return validExtensions.includes(ext);
      })
      .filter(file => file !== 'upgrade-watchdog.sh') // Exclude system scripts
      .map(file => `/data/scripts/${file}`) // Always return /data/scripts/... format for API consistency
      .sort();

    if (env.isDevelopment && scripts.length > 0) {
      logger.debug(`📜 Found ${scripts.length} script(s) in ${scriptsDir}`);
    }

    res.json({ scripts });
  } catch (error) {
    logger.error('❌ Error listing scripts:', error);
    res.status(500).json({ error: 'Failed to list scripts', scripts: [] });
  }
};

if (BASE_URL) {
  app.get(`${BASE_URL}/api/scripts`, scriptsEndpoint);
}
app.get('/api/scripts', scriptsEndpoint);

// Script test endpoint - allows testing script execution with sample parameters
apiRouter.post('/scripts/test', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const { script, trigger, testMessage } = req.body;

    if (!script || !trigger || !testMessage) {
      return res.status(400).json({ error: 'Missing required fields: script, trigger, testMessage' });
    }

    // Validate script path (security check)
    if (!script.startsWith('/data/scripts/') || script.includes('..')) {
      return res.status(400).json({ error: 'Invalid script path' });
    }

    // Resolve script path
    const resolvedPath = resolveScriptPath(script);
    if (!resolvedPath) {
      return res.status(400).json({ error: 'Failed to resolve script path' });
    }

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'Script file not found' });
    }

    // Extract parameters from test message using trigger pattern
    // (Reuse pattern matching logic from meshtasticManager)
    const splitTriggerPatterns = (triggerStr: string): string[] => {
      if (!triggerStr.trim()) {
        return [];
      }
      
      const patterns: string[] = [];
      let currentPattern = '';
      let braceDepth = 0;
      
      for (let i = 0; i < triggerStr.length; i++) {
        const char = triggerStr[i];
        
        if (char === '{') {
          braceDepth++;
          currentPattern += char;
        } else if (char === '}') {
          braceDepth--;
          currentPattern += char;
        } else if (char === ',' && braceDepth === 0) {
          const trimmed = currentPattern.trim();
          if (trimmed) {
            patterns.push(trimmed);
          }
          currentPattern = '';
        } else {
          currentPattern += char;
        }
      }
      
      const trimmed = currentPattern.trim();
      if (trimmed) {
        patterns.push(trimmed);
      }
      
      return patterns;
    };

    const patterns = splitTriggerPatterns(trigger);
    let matchedPattern: string | null = null;
    let extractedParams: Record<string, string> = {};

    // Try each pattern until one matches
    for (const patternStr of patterns) {
      interface ParamSpec {
        name: string;
        pattern?: string;
      }
      const params: ParamSpec[] = [];
      let i = 0;

      // Extract parameter specifications
      while (i < patternStr.length) {
        if (patternStr[i] === '{') {
          const startPos = i + 1;
          let depth = 1;
          let colonPos = -1;
          let endPos = -1;

          for (let j = startPos; j < patternStr.length && depth > 0; j++) {
            if (patternStr[j] === '{') {
              depth++;
            } else if (patternStr[j] === '}') {
              depth--;
              if (depth === 0) {
                endPos = j;
              }
            } else if (patternStr[j] === ':' && depth === 1 && colonPos === -1) {
              colonPos = j;
            }
          }

          if (endPos !== -1) {
            const paramName = colonPos !== -1
              ? patternStr.substring(startPos, colonPos)
              : patternStr.substring(startPos, endPos);
            const paramPattern = colonPos !== -1
              ? patternStr.substring(colonPos + 1, endPos)
              : undefined;

            if (!params.find(p => p.name === paramName)) {
              params.push({ name: paramName, pattern: paramPattern });
            }

            i = endPos + 1;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }

      // Build regex pattern
      let regexPattern = '';
      const replacements: Array<{ start: number; end: number; replacement: string }> = [];
      i = 0;

      while (i < patternStr.length) {
        if (patternStr[i] === '{') {
          const startPos = i;
          let depth = 1;
          let endPos = -1;

          for (let j = i + 1; j < patternStr.length && depth > 0; j++) {
            if (patternStr[j] === '{') {
              depth++;
            } else if (patternStr[j] === '}') {
              depth--;
              if (depth === 0) {
                endPos = j;
              }
            }
          }

          if (endPos !== -1) {
            const paramIndex = replacements.length;
            if (paramIndex < params.length) {
              const paramRegex = params[paramIndex].pattern || '[^\\s]+';
              replacements.push({
                start: startPos,
                end: endPos + 1,
                replacement: `(${paramRegex})`
              });
            }
            i = endPos + 1;
          } else {
            i++;
          }
        } else {
          i++;
        }
      }

      // Build the final pattern by replacing placeholders
      for (let i = 0; i < patternStr.length; i++) {
        const replacement = replacements.find(r => r.start === i);
        if (replacement) {
          regexPattern += replacement.replacement;
          i = replacement.end - 1;
        } else {
          const char = patternStr[i];
          if (/[.*+?^${}()|[\]\\]/.test(char)) {
            regexPattern += '\\' + char;
          } else {
            regexPattern += char;
          }
        }
      }

      const triggerRegex = new RegExp(`^${regexPattern}$`, 'i');
      const triggerMatch = testMessage.match(triggerRegex);

      if (triggerMatch) {
        extractedParams = {};
        params.forEach((param, index) => {
          extractedParams[param.name] = triggerMatch[index + 1];
        });
        matchedPattern = patternStr;
        break;
      }
    }

    if (!matchedPattern) {
      return res.status(400).json({ error: `Test message does not match trigger pattern: "${trigger}"` });
    }

    // Determine interpreter based on file extension
    const ext = script.split('.').pop()?.toLowerCase();
    let interpreter: string;
    
    const isDev = process.env.NODE_ENV !== 'production';
    
    switch (ext) {
      case 'js':
      case 'mjs':
        interpreter = isDev ? 'node' : '/usr/local/bin/node';
        break;
      case 'py':
        interpreter = isDev ? 'python' : '/usr/bin/python';
        break;
      case 'sh':
        interpreter = isDev ? 'sh' : '/bin/sh';
        break;
      default:
        return res.status(400).json({ error: `Unsupported script extension: ${ext}` });
    }

    // Execute script
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Prepare environment variables (same as in meshtasticManager)
    const scriptEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      MESSAGE: testMessage,
      FROM_NODE: '12345', // Test node number
      PACKET_ID: '99999', // Test packet ID
      TRIGGER: trigger,
    };

    // Add extracted parameters as PARAM_* environment variables
    Object.entries(extractedParams).forEach(([key, value]) => {
      scriptEnv[`PARAM_${key}`] = value;
    });

    try {
      const { stdout, stderr } = await execFileAsync(interpreter, [resolvedPath], {
        timeout: 10000,
        env: scriptEnv,
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      // Return both stdout and stderr
      const output = stdout.trim();
      const errorOutput = stderr.trim();
      
      return res.json({
        output: output || '(no output)',
        stderr: errorOutput || undefined,
        params: extractedParams,
        matchedPattern: matchedPattern
      });
    } catch (error: any) {
      // Handle execution errors
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        return res.status(408).json({ error: 'Script execution timed out after 10 seconds' });
      }
      
      // Handle Windows EPERM errors gracefully (process may have already terminated)
      if (error.code === 'EPERM' && process.platform === 'win32') {
        // On Windows, EPERM can occur when trying to kill a process that's already dead
        // If we got stdout/stderr before the error, return that
        if (error.stdout || error.stderr) {
          return res.json({
            output: error.stdout?.toString().trim() || '(no output)',
            stderr: error.stderr?.toString().trim() || undefined,
            params: extractedParams,
            matchedPattern: matchedPattern
          });
        }
        // Otherwise, return a more user-friendly error
        return res.status(500).json({ 
          error: 'Script execution completed but encountered a cleanup error (this is usually harmless)',
          stderr: error.stderr?.toString() || undefined
        });
      }
      
      return res.status(500).json({ 
        error: error.message || 'Script execution failed',
        stderr: error.stderr?.toString() || undefined
      });
    }
  } catch (error: any) {
    logger.error('❌ Error testing script:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// HTTP trigger test endpoint - allows testing HTTP triggers safely through backend proxy
apiRouter.post('/http/test', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'Missing required field: url' });
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Security: Only allow HTTP and HTTPS protocols
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are allowed' });
    }

    // Make the HTTP request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'text/plain, text/*, application/json',
          'User-Agent': 'MeshMonitor/AutoResponder-Test'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return res.status(response.status).json({
          error: `HTTP ${response.status}: ${response.statusText}`
        });
      }

      const text = await response.text();

      return res.json({
        result: text.substring(0, 500) + (text.length > 500 ? '...' : ''),
        status: response.status,
        statusText: response.statusText
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        return res.status(408).json({ error: 'Request timed out after 10 seconds' });
      }

      return res.status(500).json({
        error: fetchError.message || 'Failed to fetch URL'
      });
    }
  } catch (error: any) {
    logger.error('❌ Error testing HTTP trigger:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Script import endpoint - upload a script file
apiRouter.post('/scripts/import', requirePermission('settings', 'write'), express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  try {
    const filename = req.headers['x-filename'] as string;

    if (!filename) {
      return res.status(400).json({ error: 'Filename header (x-filename) is required' });
    }

    // Security: Validate filename
    const sanitizedFilename = path.basename(filename); // Remove any path components
    const ext = path.extname(sanitizedFilename).toLowerCase();
    const validExtensions = ['.js', '.mjs', '.py', '.sh'];
    
    if (!validExtensions.includes(ext)) {
      return res.status(400).json({ error: `Invalid file extension. Allowed: ${validExtensions.join(', ')}` });
    }

    // Prevent system script overwrite
    if (sanitizedFilename === 'upgrade-watchdog.sh') {
      return res.status(400).json({ error: 'Cannot overwrite system script' });
    }

    const scriptsDir = getScriptsDirectory();
    const filePath = path.join(scriptsDir, sanitizedFilename);

    // Ensure scripts directory exists
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }

    // Write file
    fs.writeFileSync(filePath, req.body);
    
    // Set executable permissions (Unix-like systems)
    if (process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o755);
    }

    logger.info(`✅ Script imported: ${sanitizedFilename}`);
    res.json({ success: true, filename: sanitizedFilename, path: `/data/scripts/${sanitizedFilename}` });
  } catch (error: any) {
    logger.error('❌ Error importing script:', error);
    res.status(500).json({ error: error.message || 'Failed to import script' });
  }
});

// Script export endpoint - download selected scripts as zip
apiRouter.post('/scripts/export', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const { scripts } = req.body;

    if (!Array.isArray(scripts) || scripts.length === 0) {
      return res.status(400).json({ error: 'Scripts array is required' });
    }

    const scriptsDir = getScriptsDirectory();
    const archiver = (await import('archiver')).default;
    const archive = archiver('zip', { zlib: { level: 9 } });

    res.attachment('scripts-export.zip');
    archive.pipe(res);

    for (const scriptPath of scripts) {
      // Validate script path
      if (!scriptPath.startsWith('/data/scripts/') || scriptPath.includes('..')) {
        logger.warn(`⚠️  Skipping invalid script path: ${scriptPath}`);
        continue;
      }

      const filename = path.basename(scriptPath);
      const filePath = path.join(scriptsDir, filename);

      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: filename });
      } else {
        logger.warn(`⚠️  Script not found: ${filename}`);
      }
    }

    await archive.finalize();
    logger.info(`✅ Exported ${scripts.length} script(s) as zip`);
  } catch (error: any) {
    logger.error('❌ Error exporting scripts:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Failed to export scripts' });
    }
  }
});

// Script delete endpoint
apiRouter.delete('/scripts/:filename', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const filename = req.params.filename;

    // Security: Validate filename
    const sanitizedFilename = path.basename(filename);
    
    // Prevent deletion of system scripts
    if (sanitizedFilename === 'upgrade-watchdog.sh') {
      return res.status(400).json({ error: 'Cannot delete system script' });
    }

    const scriptsDir = getScriptsDirectory();
    const filePath = path.join(scriptsDir, sanitizedFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Script not found' });
    }

    fs.unlinkSync(filePath);
    logger.info(`✅ Script deleted: ${sanitizedFilename}`);
    res.json({ success: true, filename: sanitizedFilename });
  } catch (error: any) {
    logger.error('❌ Error deleting script:', error);
    res.status(500).json({ error: error.message || 'Failed to delete script' });
  }
});

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

    // Stop virtual node server
    const virtualNodeServer = (global as any).virtualNodeServer;
    if (virtualNodeServer) {
      try {
        virtualNodeServer.stop();
        logger.debug('✅ Virtual node server stopped');
      } catch (error) {
        logger.error('Error stopping virtual node server:', error);
      }
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

// Data migration: Set channel field to 'dm' for existing auto-responder triggers without channel
function migrateAutoResponderTriggers() {
  try {
    const triggersStr = databaseService.getSetting('autoResponderTriggers');
    if (!triggersStr) {
      return; // No triggers to migrate
    }

    const triggers = JSON.parse(triggersStr);
    if (!Array.isArray(triggers)) {
      return;
    }

    let migrationCount = 0;
    const migratedTriggers = triggers.map((trigger: any) => {
      if (trigger.channel === undefined || trigger.channel === null) {
        migrationCount++;
        return { ...trigger, channel: 'dm' };
      }
      return trigger;
    });

    if (migrationCount > 0) {
      databaseService.setSetting('autoResponderTriggers', JSON.stringify(migratedTriggers));
      logger.info(`✅ Migrated ${migrationCount} auto-responder trigger(s) to default channel 'dm'`);
    }
  } catch (error) {
    logger.error('❌ Failed to migrate auto-responder triggers:', error);
  }
}

// Run migration on startup
migrateAutoResponderTriggers();

const server = app.listen(PORT, () => {
  logger.debug(`MeshMonitor server running on port ${PORT}`);
  logger.debug(`Environment: ${env.nodeEnv}`);
  
  // Log environment variable sources in development
  if (env.isDevelopment) {
    logger.info(`🔧 Meshtastic Node IP: ${env.meshtasticNodeIp} ${env.meshtasticNodeIpProvided ? '📄 (from .env)' : '⚙️ (default)'}`);
    logger.info(`🔧 Meshtastic TCP Port: ${env.meshtasticTcpPort} ${env.meshtasticTcpPortProvided ? '📄 (from .env)' : '⚙️ (default)'}`);
    
    // Log scripts directory location in development
    const scriptsDir = getScriptsDirectory();
    logger.info(`📜 Auto-responder scripts directory: ${scriptsDir}`);
    logger.info(`   Place your test scripts (.js, .mjs, .py, .sh) in this directory`);
  }
});

// Configure server timeouts to prevent hanging requests
server.setTimeout(30000); // 30 seconds
server.keepAliveTimeout = 65000; // 65 seconds (must be > setTimeout)
server.headersTimeout = 66000; // 66 seconds (must be > keepAliveTimeout)