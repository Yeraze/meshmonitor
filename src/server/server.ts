import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService, { DbMessage } from '../services/database.js';
import { MeshMessage } from '../types/message.js';
import meshtasticManager from './meshtasticManager.js';
import meshtasticProtobufService from './meshtasticProtobufService.js';
import protobufService from './protobufService.js';
import { VirtualNodeServer } from './virtualNodeServer.js';

// Make meshtasticManager available globally for routes that need it
(global as any).meshtasticManager = meshtasticManager;
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import { normalizeTriggerPatterns } from '../utils/autoResponderUtils.js';
import { getSessionMiddleware } from './auth/sessionConfig.js';
import { initializeWebSocket } from './services/webSocketService.js';
import { initializeOIDC } from './auth/oidcAuth.js';
import { optionalAuth, requireAuth, requirePermission, requireAdmin, hasPermission } from './auth/authMiddleware.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { setupAccessLogger } from './middleware/accessLogger.js';
import { getEnvironmentConfig, resetEnvironmentConfig } from './config/environment.js';
import { pushNotificationService } from './services/pushNotificationService.js';
import { appriseNotificationService } from './services/appriseNotificationService.js';
import { deviceBackupService } from './services/deviceBackupService.js';
import { backupFileService } from './services/backupFileService.js';
import { backupSchedulerService } from './services/backupSchedulerService.js';
import { databaseMaintenanceService } from './services/databaseMaintenanceService.js';
import { systemBackupService } from './services/systemBackupService.js';
import { systemRestoreService } from './services/systemRestoreService.js';
import { duplicateKeySchedulerService } from './services/duplicateKeySchedulerService.js';
import { solarMonitoringService } from './services/solarMonitoringService.js';
import { newsService } from './services/newsService.js';
import { inactiveNodeNotificationService } from './services/inactiveNodeNotificationService.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';
import { getUserNotificationPreferencesAsync, saveUserNotificationPreferencesAsync, applyNodeNamePrefix } from './utils/notificationFiltering.js';
import { upgradeService } from './services/upgradeService.js';
import { enhanceNodeForClient, filterNodesByChannelPermission } from './utils/nodeEnhancer.js';
import { dynamicCspMiddleware, refreshTileHostnameCache } from './middleware/dynamicCsp.js';
import { PortNum } from './constants/meshtastic.js';

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
JSON.stringify = function (value, replacer?: any, space?: any) {
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
// CSP is handled dynamically by dynamicCspMiddleware to support custom tile servers
const helmetConfig =
  env.isProduction && env.cookieSecure
    ? {
        contentSecurityPolicy: false, // Handled by dynamicCspMiddleware
        hsts: {
          maxAge: 31536000, // 1 year
          includeSubDomains: true,
          preload: true,
        },
        frameguard: {
          action: 'deny' as const,
        },
        noSniff: true,
        xssFilter: true,
      }
    : {
        // Development or HTTP-only: no HSTS
        contentSecurityPolicy: false, // Handled by dynamicCspMiddleware
        hsts: false, // Disable HSTS when not using secure cookies or in development
        crossOriginOpenerPolicy: false, // Disable COOP for HTTP - browser ignores it on non-HTTPS anyway
        frameguard: {
          action: 'deny' as const,
        },
        noSniff: true,
        xssFilter: true,
      };

app.use(helmet(helmetConfig));

// Dynamic CSP middleware - adds custom tile server hostnames from database
app.use(dynamicCspMiddleware(env.isProduction, env.cookieSecure));

// Security: CORS configuration with allowed origins
const getAllowedOrigins = () => {
  const origins = [...env.allowedOrigins];
  // Always allow localhost in development
  if (env.isDevelopment) {
    origins.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080');
  }
  return origins.length > 0 ? origins : ['http://localhost:3000'];
};

app.use(
  cors({
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
    optionsSuccessStatus: 200,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization'],
  })
);

// Access logging for fail2ban (optional, configured via ACCESS_LOG_ENABLED)
const accessLogger = setupAccessLogger();
if (accessLogger) {
  app.use(accessLogger);
}

// Security: Request body size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true, parameterLimit: 1000 }));

// Session middleware (shared with WebSocket for authentication)
const sessionMiddleware = getSessionMiddleware();
app.use(sessionMiddleware);

// Security: CSRF protection middleware
import { csrfTokenMiddleware, csrfProtection, csrfTokenEndpoint } from './middleware/csrf.js';
app.use(csrfTokenMiddleware); // Generate and attach tokens to all requests
// csrfProtection applied to API routes below (after CSRF token endpoint)

// Initialize OIDC if configured
initializeOIDC()
  .then(enabled => {
    if (enabled) {
      logger.debug('✅ OIDC authentication enabled');
    } else {
      logger.debug('ℹ️  OIDC authentication disabled (not configured)');
    }
  })
  .catch(error => {
    logger.error('Failed to initialize OIDC:', error);
  });

// Function to initialize virtual node server after config capture is complete
async function initializeOrRefreshVirtualNodeServer(): Promise<void> {
  // If already initialized, refresh all connected clients with fresh config
  // This handles physical node reconnection: clients get updated channel/config data
  // through the proper sendInitialConfig() flow (fixes #1567)
  if ((global as any).virtualNodeServer) {
    logger.info('Virtual node server already initialized, refreshing connected clients with fresh config');
    try {
      await ((global as any).virtualNodeServer as VirtualNodeServer).refreshAllClients();
    } catch (error) {
      logger.error('❌ Failed to refresh virtual node clients:', error);
    }
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
// On first connection: starts the virtual node server
// On reconnection: refreshes all connected clients with fresh config data
meshtasticManager.registerConfigCaptureCompleteCallback(initializeOrRefreshVirtualNodeServer);

// ========== Bootstrap Restore Logic ==========
// Check for RESTORE_FROM_BACKUP environment variable and restore if set
// This MUST happen before services start (per ARCHITECTURE_LESSONS.md)
// IMPORTANT: We mark restore as started immediately to prevent race conditions
// with createAdminIfNeeded() in database.ts
systemRestoreService.markRestoreStarted();
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
        systemRestoreService.markRestoreComplete();
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
            migrationRequired: result.migrationRequired || false,
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
  } finally {
    // CRITICAL: Always mark restore as complete, regardless of outcome
    // This allows createAdminIfNeeded() to proceed
    systemRestoreService.markRestoreComplete();
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
        logger.debug(
          `✅ Loaded saved traceroute interval: ${intervalMinutes} minutes${intervalMinutes === 0 ? ' (disabled)' : ''}`
        );
      }
    }

    // Load auto key repair settings
    const keyRepairEnabled = databaseService.getSetting('autoKeyManagementEnabled');
    const keyRepairInterval = databaseService.getSetting('autoKeyManagementIntervalMinutes');
    const keyRepairMaxExchanges = databaseService.getSetting('autoKeyManagementMaxExchanges');
    const keyRepairAutoPurge = databaseService.getSetting('autoKeyManagementAutoPurge');

    meshtasticManager.setKeyRepairSettings({
      enabled: keyRepairEnabled === 'true',
      intervalMinutes: keyRepairInterval ? parseInt(keyRepairInterval) : 5,
      maxExchanges: keyRepairMaxExchanges ? parseInt(keyRepairMaxExchanges) : 3,
      autoPurge: keyRepairAutoPurge === 'true'
    });
    logger.debug('✅ Loaded auto key repair settings');

    // Load remote admin scanner interval
    const remoteAdminScannerInterval = databaseService.getSetting('remoteAdminScannerIntervalMinutes');
    if (remoteAdminScannerInterval !== null) {
      const intervalMinutes = parseInt(remoteAdminScannerInterval);
      if (!isNaN(intervalMinutes) && intervalMinutes >= 0 && intervalMinutes <= 60) {
        meshtasticManager.setRemoteAdminScannerInterval(intervalMinutes);
        logger.debug(
          `✅ Loaded saved remote admin scanner interval: ${intervalMinutes} minutes${intervalMinutes === 0 ? ' (disabled)' : ''}`
        );
      }
    }

    // NOTE: We no longer mark existing nodes as welcomed on startup.
    // This is now handled when autoWelcomeEnabled is first changed to 'true'
    // via the settings endpoint. This prevents welcoming existing nodes when
    // the feature is enabled after nodes are already in the database.

    // Clear any runtime IP/port overrides from previous sessions
    // These are temporary settings that should reset on container restart
    await databaseService.setSettingAsync('meshtasticNodeIpOverride', '');
    await databaseService.setSettingAsync('meshtasticTcpPortOverride', '');

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

    // Initialize news service (fetches news from meshmonitor.org)
    newsService.initialize();
    logger.debug('News service initialized');

    // Initialize database maintenance service
    databaseMaintenanceService.initialize();
    logger.debug('Database maintenance service initialized');

    // Start inactive node notification service with validation
    const inactiveThresholdHoursRaw = parseInt(databaseService.getSetting('inactiveNodeThresholdHours') || '24', 10);
    const inactiveCheckIntervalMinutesRaw = parseInt(
      databaseService.getSetting('inactiveNodeCheckIntervalMinutes') || '60',
      10
    );
    const inactiveCooldownHoursRaw = parseInt(databaseService.getSetting('inactiveNodeCooldownHours') || '24', 10);

    // Validate and use defaults if invalid values are found in database
    const inactiveThresholdHours =
      !isNaN(inactiveThresholdHoursRaw) && inactiveThresholdHoursRaw >= 1 && inactiveThresholdHoursRaw <= 720
        ? inactiveThresholdHoursRaw
        : 24;
    const inactiveCheckIntervalMinutes =
      !isNaN(inactiveCheckIntervalMinutesRaw) &&
      inactiveCheckIntervalMinutesRaw >= 1 &&
      inactiveCheckIntervalMinutesRaw <= 1440
        ? inactiveCheckIntervalMinutesRaw
        : 60;
    const inactiveCooldownHours =
      !isNaN(inactiveCooldownHoursRaw) && inactiveCooldownHoursRaw >= 1 && inactiveCooldownHoursRaw <= 720
        ? inactiveCooldownHoursRaw
        : 24;

    // Log warning if invalid values were found and corrected
    if (
      inactiveThresholdHours !== inactiveThresholdHoursRaw ||
      inactiveCheckIntervalMinutes !== inactiveCheckIntervalMinutesRaw ||
      inactiveCooldownHours !== inactiveCooldownHoursRaw
    ) {
      logger.warn(
        `⚠️  Invalid inactive node notification settings found in database, using defaults (threshold: ${inactiveThresholdHours}h, check: ${inactiveCheckIntervalMinutes}min, cooldown: ${inactiveCooldownHours}h)`
      );
    }

    inactiveNodeNotificationService.start(inactiveThresholdHours, inactiveCheckIntervalMinutes, inactiveCooldownHours);
    logger.info('✅ Inactive node notification service started');

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

// ==========================================
// Scheduled Auto-Upgrade Check
// ==========================================
// Check for updates every 4 hours server-side to enable unattended upgrades
// This allows auto-upgrade to work without requiring a frontend to be open
const AUTO_UPGRADE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function checkForAutoUpgrade(): Promise<void> {
  // Skip if version check is disabled
  if (env.versionCheckDisabled) {
    return;
  }

  // Skip if auto-upgrade is not enabled
  if (!upgradeService.isEnabled()) {
    return;
  }

  // Skip if autoUpgradeImmediate is not enabled
  const autoUpgradeImmediate = databaseService.getSetting('autoUpgradeImmediate') === 'true';
  if (!autoUpgradeImmediate) {
    return;
  }

  try {
    logger.debug('🔄 Running scheduled auto-upgrade check...');

    // Fetch latest release from GitHub
    const response = await fetch('https://api.github.com/repos/Yeraze/meshmonitor/releases/latest');

    if (!response.ok) {
      logger.warn(`GitHub API returned ${response.status} for scheduled version check`);
      return;
    }

    const release = await response.json();
    const currentVersion = packageJson.version;
    const latestVersionRaw = release.tag_name;

    // Strip 'v' prefix from version strings for comparison
    const latestVersion = latestVersionRaw.replace(/^v/, '');
    const current = currentVersion.replace(/^v/, '');

    // Simple semantic version comparison
    const isNewerVersion = compareVersions(latestVersion, current) > 0;

    if (!isNewerVersion) {
      logger.debug(`✓ Already on latest version (${currentVersion})`);
      return;
    }

    // Check if Docker image exists for this version
    const imageReady = await checkDockerImageExists(latestVersion, release.published_at);

    if (!imageReady) {
      logger.debug(`⏳ Update available (${latestVersion}) but Docker image not ready yet`);
      return;
    }

    // Check if an upgrade is already in progress
    const inProgress = await upgradeService.isUpgradeInProgress();
    if (inProgress) {
      logger.debug('ℹ️ Scheduled auto-upgrade skipped: upgrade already in progress');
      return;
    }

    // Trigger the upgrade
    logger.info(`🚀 Scheduled auto-upgrade: triggering upgrade to ${latestVersion}`);
    const upgradeResult = await upgradeService.triggerUpgrade(
      { targetVersion: latestVersion, backup: true },
      currentVersion,
      'system-scheduled-auto-upgrade'
    );

    if (upgradeResult.success) {
      logger.info(`✅ Scheduled auto-upgrade triggered successfully: ${upgradeResult.upgradeId}`);
      databaseService.auditLog(
        null,
        'auto_upgrade_triggered',
        'system',
        `Scheduled auto-upgrade initiated: ${currentVersion} → ${latestVersion}`,
        null
      );
    } else {
      if (upgradeResult.message === 'An upgrade is already in progress') {
        logger.debug('ℹ️ Scheduled auto-upgrade skipped: upgrade started by another process');
      } else {
        logger.warn(`⚠️ Scheduled auto-upgrade failed to trigger: ${upgradeResult.message}`);
      }
    }
  } catch (error) {
    logger.error('❌ Error during scheduled auto-upgrade check:', error);
  }
}

// Schedule periodic auto-upgrade check (every 4 hours)
setInterval(() => {
  checkForAutoUpgrade().catch(error => {
    logger.error('Error in scheduled auto-upgrade check:', error);
  });
}, AUTO_UPGRADE_CHECK_INTERVAL_MS);

// Run initial auto-upgrade check after a delay to allow system to stabilize
setTimeout(() => {
  checkForAutoUpgrade().catch(error => {
    logger.error('Error in initial auto-upgrade check:', error);
  });
}, 60 * 1000); // Wait 1 minute after startup

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
import mfaRoutes from './routes/mfaRoutes.js';
import channelDatabaseRoutes from './routes/channelDatabaseRoutes.js';
import newsRoutes from './routes/newsRoutes.js';
import tileServerRoutes from './routes/tileServerTest.js';
import v1Router from './routes/v1/index.js';
import meshcoreRoutes from './routes/meshcoreRoutes.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Health check endpoint (for upgrade watchdog and monitoring)
apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: packageJson.version,
    uptime: Date.now() - serverStartTime,
    databaseType: databaseService.drizzleDbType,
  });
});

// Server info endpoint (returns timezone and other server configuration)
apiRouter.get('/server-info', (_req, res) => {
  res.json({
    timezone: env.timezone,
    timezoneProvided: env.timezoneProvided,
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
      note: 'The rate limiter uses req.ip to identify clients',
    });
  });

}

// Authentication routes
apiRouter.use('/auth', authRoutes);

// API Token management routes (requires auth)
apiRouter.use('/token', apiTokenRoutes);

// MFA management routes (requires auth)
apiRouter.use('/mfa', mfaRoutes);

// v1 API routes (requires API token)
apiRouter.use('/v1', v1Router);

// User management routes (admin only)
apiRouter.use('/users', userRoutes);

// Audit log routes (admin only)
apiRouter.use('/audit', auditRoutes);

// Channel database routes (admin only, session-based)
apiRouter.use('/channel-database', channelDatabaseRoutes);

// Security routes (requires security:read)
apiRouter.use('/security', securityRoutes);

// Packet log routes (requires channels:read AND messages:read)
apiRouter.use('/packets', optionalAuth(), packetRoutes);

// Solar monitoring routes
apiRouter.use('/solar', optionalAuth(), solarRoutes);

// News routes (public feed, authenticated status endpoints)
apiRouter.use('/news', newsRoutes);

// Upgrade routes (requires authentication)
apiRouter.use('/upgrade', upgradeRoutes);

// Message routes (requires appropriate write permissions)
apiRouter.use('/messages', optionalAuth(), messageRoutes);

// MeshCore routes (for MeshCore device monitoring)
// Authentication handled per-route in meshcoreRoutes.ts
// Enable with MESHCORE_ENABLED=true in .env
if (process.env.MESHCORE_ENABLED === 'true') {
  apiRouter.use('/meshcore', meshcoreRoutes);
}

// Link preview routes
apiRouter.use('/', linkPreviewRoutes);

// Script content proxy routes (for User Scripts Gallery)
apiRouter.use('/', scriptContentRoutes);

// Tile server testing routes (for Custom Tileset Manager autodetect)
apiRouter.use('/tile-server', optionalAuth(), tileServerRoutes);

// API Routes
/**
 * GET /api/nodes
 * Returns all nodes in the mesh
 */
apiRouter.get('/nodes', optionalAuth(), async (req, res) => {
  try {
    const allNodes = meshtasticManager.getAllNodes();
    const estimatedPositions = databaseService.getAllNodesEstimatedPositions();

    // Filter nodes based on channel read permissions
    const filteredNodes = await filterNodesByChannelPermission(allNodes, (req as any).user);
    const enhancedNodes = await Promise.all(filteredNodes.map(node => enhanceNodeForClient(node, (req as any).user, estimatedPositions)));
    res.json(enhancedNodes);
  } catch (error) {
    logger.error('Error fetching nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

apiRouter.get('/nodes/active', optionalAuth(), async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const allDbNodes = databaseService.getActiveNodes(days);

    // Filter nodes based on channel read permissions
    const dbNodes = await filterNodesByChannelPermission(allDbNodes, (req as any).user);

    // Map raw DB nodes to DeviceInfo format then enhance
    const maskedNodes = await Promise.all(dbNodes.map(async node => {
      // Map basic fields
      const deviceInfo: any = {
        nodeNum: node.nodeNum,
        user: { id: node.nodeId, longName: node.longName, shortName: node.shortName },
        mobile: node.mobile,
        positionOverrideEnabled: Boolean(node.positionOverrideEnabled),
        latitudeOverride: node.latitudeOverride,
        longitudeOverride: node.longitudeOverride,
        altitudeOverride: node.altitudeOverride,
        positionOverrideIsPrivate: Boolean(node.positionOverrideIsPrivate)
      };

      if (node.latitude && node.longitude) {
        deviceInfo.position = { latitude: node.latitude, longitude: node.longitude, altitude: node.altitude };
      }

      return enhanceNodeForClient(deviceInfo, (req as any).user);
    }));

    res.json(maskedNodes);
  } catch (error) {
    logger.error('Error fetching active nodes:', error);
    res.status(500).json({ error: 'Failed to fetch active nodes' });
  }
});

// Get position history for a node (for mobile node visualization)
apiRouter.get('/nodes/:nodeId/position-history', optionalAuth(), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Allow hours parameter for future use, but default to fetching ALL position history
    // This ensures we capture movement that may have happened long ago
    // Validate hours: must be positive integer, max 8760 (1 year)
    const rawHours = req.query.hours ? parseInt(req.query.hours as string) : null;
    const hoursParam = rawHours !== null && !isNaN(rawHours) && rawHours > 0
      ? Math.min(rawHours, 8760)
      : null;
    const cutoffTime = hoursParam ? Date.now() - hoursParam * 60 * 60 * 1000 : 0;

    // Check privacy for position history
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = databaseService.getNode(nodeNum);
    const isPrivate = node?.positionOverrideIsPrivate === true;
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');
    if (isPrivate && !canViewPrivate) {
      res.json([]);
      return;
    }

    // Get only position-related telemetry (lat/lon/alt/speed/track) for the node - much more efficient!
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(nodeId, 1500, cutoffTime);

    // Group by timestamp to get lat/lon pairs with optional speed/track
    const positionMap = new Map<number, { lat?: number; lon?: number; alt?: number; groundSpeed?: number; groundTrack?: number }>();

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
      } else if (t.telemetryType === 'ground_speed') {
        pos.groundSpeed = t.value;
      } else if (t.telemetryType === 'ground_track') {
        pos.groundTrack = t.value;
      }
    });

    // Convert to array of positions, filter incomplete ones
    const positions = Array.from(positionMap.entries())
      .filter(([_timestamp, pos]) => pos.lat !== undefined && pos.lon !== undefined)
      .map(([timestamp, pos]) => ({
        timestamp,
        latitude: pos.lat!,
        longitude: pos.lon!,
        altitude: pos.alt,
        groundSpeed: pos.groundSpeed,
        groundTrack: pos.groundTrack,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(positions);
  } catch (error) {
    logger.error('Error fetching position history:', error);
    res.status(500).json({ error: 'Failed to fetch position history' });
  }
});

// Alternative endpoint with limit parameter for fetching positions
apiRouter.get('/nodes/:nodeId/positions', optionalAuth(), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 2000;

    // Get only position-related telemetry (lat/lon/alt) for the node
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(nodeId, limit);

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
        altitude: pos.alt,
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
    const { isFavorite, syncToDevice = true, destinationNodeNum } = req.body;

    if (typeof isFavorite !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isFavorite must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isFavorite parameter',
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
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Update favorite status in database
    databaseService.setNodeFavorite(nodeNum, isFavorite);

    // Broadcast updated NodeInfo to virtual node clients
    const virtualNodeServer = (global as any).virtualNodeServer;
    if (virtualNodeServer) {
      try {
        // Fetch the updated node from database
        const node = databaseService.getNode(nodeNum);
        if (node) {
          // Create NodeInfo message with updated favorite status
          const nodeInfoMessage = await meshtasticProtobufService.createNodeInfo({
            nodeNum: node.nodeNum,
            user: {
              id: node.nodeId,
              longName: node.longName || 'Unknown',
              shortName: node.shortName || '????',
              hwModel: node.hwModel || 0,
              role: node.role,
              publicKey: node.publicKey,
            },
            position:
              node.latitude && node.longitude
                ? {
                    latitude: node.latitude,
                    longitude: node.longitude,
                    altitude: node.altitude || 0,
                    time: node.lastHeard || Math.floor(Date.now() / 1000),
                  }
                : undefined,
            deviceMetrics:
              node.batteryLevel !== undefined ||
              node.voltage !== undefined ||
              node.channelUtilization !== undefined ||
              node.airUtilTx !== undefined
                ? {
                    batteryLevel: node.batteryLevel,
                    voltage: node.voltage,
                    channelUtilization: node.channelUtilization,
                    airUtilTx: node.airUtilTx,
                  }
                : undefined,
            snr: node.snr,
            lastHeard: node.lastHeard,
            hopsAway: node.hopsAway,
            isFavorite: isFavorite,
          });

          if (nodeInfoMessage) {
            await virtualNodeServer.broadcastToClients(nodeInfoMessage);
            logger.debug(`✅ Broadcasted favorite status update to virtual node clients for node ${nodeNum}`);
          }
        }
      } catch (error) {
        logger.error(`⚠️ Failed to broadcast favorite update to virtual node clients for node ${nodeNum}:`, error);
        // Don't fail the request if broadcast fails
      }
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      try {
        if (isFavorite) {
          await meshtasticManager.sendFavoriteNode(nodeNum, destinationNodeNum);
        } else {
          await meshtasticManager.sendRemoveFavoriteNode(nodeNum, destinationNodeNum);
        }
        deviceSyncStatus = 'success';
        logger.debug(`✅ Synced favorite status to device for node ${nodeNum}`);
      } catch (error) {
        // Special handling for firmware version incompatibility
        if (error instanceof Error && error.message === 'FIRMWARE_NOT_SUPPORTED') {
          deviceSyncStatus = 'skipped';
          logger.debug(
            `ℹ️ Device sync skipped for node ${nodeNum}: firmware does not support favorites (requires >= 2.7.0)`
          );
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
        error: deviceSyncError,
      },
    });
  } catch (error) {
    logger.error('Error setting node favorite:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node favorite',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set node ignored status (with optional device sync)
apiRouter.post('/nodes/:nodeId/ignored', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { isIgnored, syncToDevice = true, destinationNodeNum } = req.body;

    if (typeof isIgnored !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isIgnored must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isIgnored parameter',
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
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Update ignored status in database
    databaseService.setNodeIgnored(nodeNum, isIgnored);

    // Broadcast updated NodeInfo to virtual node clients
    const virtualNodeServer = (global as any).virtualNodeServer;
    if (virtualNodeServer) {
      try {
        // Fetch the updated node from database
        const node = databaseService.getNode(nodeNum);
        if (node) {
          // Create NodeInfo message with updated ignored status
          const nodeInfoMessage = await meshtasticProtobufService.createNodeInfo({
            nodeNum: node.nodeNum,
            user: {
              id: node.nodeId,
              longName: node.longName || 'Unknown',
              shortName: node.shortName || '????',
              hwModel: node.hwModel || 0,
              role: node.role,
              publicKey: node.publicKey,
            },
            position:
              node.latitude && node.longitude
                ? {
                    latitude: node.latitude,
                    longitude: node.longitude,
                    altitude: node.altitude || 0,
                    time: node.lastHeard || Math.floor(Date.now() / 1000),
                  }
                : undefined,
            deviceMetrics:
              node.batteryLevel !== undefined ||
              node.voltage !== undefined ||
              node.channelUtilization !== undefined ||
              node.airUtilTx !== undefined
                ? {
                    batteryLevel: node.batteryLevel,
                    voltage: node.voltage,
                    channelUtilization: node.channelUtilization,
                    airUtilTx: node.airUtilTx,
                  }
                : undefined,
            snr: node.snr,
            lastHeard: node.lastHeard,
            hopsAway: node.hopsAway,
            isIgnored: isIgnored,
          });

          if (nodeInfoMessage) {
            await virtualNodeServer.broadcastToClients(nodeInfoMessage);
            logger.debug(`✅ Broadcasted ignored status update to virtual node clients for node ${nodeNum}`);
          }
        }
      } catch (error) {
        logger.error(`⚠️ Failed to broadcast ignored update to virtual node clients for node ${nodeNum}:`, error);
        // Don't fail the request if broadcast fails
      }
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      try {
        if (isIgnored) {
          await meshtasticManager.sendIgnoredNode(nodeNum, destinationNodeNum);
        } else {
          await meshtasticManager.sendRemoveIgnoredNode(nodeNum, destinationNodeNum);
        }
        deviceSyncStatus = 'success';
        logger.debug(`✅ Synced ignored status to device for node ${nodeNum}`);
      } catch (error) {
        // Special handling for firmware version incompatibility
        if (error instanceof Error && error.message === 'FIRMWARE_NOT_SUPPORTED') {
          deviceSyncStatus = 'skipped';
          logger.debug(
            `ℹ️ Device sync skipped for node ${nodeNum}: firmware does not support ignored nodes (requires >= 2.7.0)`
          );
          // Don't set deviceSyncError - this is expected behavior for pre-2.7 firmware
        } else {
          deviceSyncStatus = 'failed';
          deviceSyncError = error instanceof Error ? error.message : 'Unknown error';
          logger.error(`⚠️ Failed to sync ignored status to device for node ${nodeNum}:`, error);
        }
        // Don't fail the whole request if device sync fails
      }
    }

    res.json({
      success: true,
      nodeNum,
      isIgnored,
      deviceSync: {
        status: deviceSyncStatus,
        error: deviceSyncError,
      },
    });
  } catch (error) {
    logger.error('Error setting node ignored:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node ignored',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Get persistent ignored nodes list
apiRouter.get('/ignored-nodes', requirePermission('nodes', 'read'), async (_req, res) => {
  try {
    const ignoredNodes = await databaseService.getIgnoredNodesAsync();
    res.json(ignoredNodes);
  } catch (error) {
    logger.error('Error fetching ignored nodes:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to fetch ignored nodes',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Remove node from persistent ignore list and un-ignore it
apiRouter.delete('/ignored-nodes/:nodeId', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Remove from persistent ignore list
    await databaseService.removeIgnoredNodeAsync(nodeNum);

    // Also un-ignore the node record if it still exists
    try {
      databaseService.setNodeIgnored(nodeNum, false);
    } catch {
      // Node may not exist in nodes table - that's OK
    }

    res.json({ success: true, nodeNum });
  } catch (error) {
    logger.error('Error removing ignored node:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to remove ignored node',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Get node position override
apiRouter.get('/nodes/:nodeId/position-override', optionalAuth(), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);
    const override = databaseService.getNodePositionOverride(nodeNum);

    if (!override) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `Node ${nodeId} not found in database`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    // CRITICAL: Mask coordinates for private overrides if user lacks permission
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');
    if (override.isPrivate && !canViewPrivate) {
      const masked = { ...override };
      delete masked.latitude;
      delete masked.longitude;
      delete masked.altitude;
      res.json(masked);
      return;
    }

    res.json(override);
  } catch (error) {
    logger.error('Error getting node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to get node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set node position override
apiRouter.post('/nodes/:nodeId/position-override', requirePermission('nodes', 'write'), (req, res) => {
  try {
    const { nodeId } = req.params;
    const { enabled, latitude, longitude, altitude, isPrivate } = req.body;

    // Validate enabled parameter
    if (typeof enabled !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'enabled must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for enabled parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate isPrivate parameter if provided
    if (isPrivate !== undefined && typeof isPrivate !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isPrivate must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isPrivate parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate coordinates if enabled
    if (enabled) {
      if (typeof latitude !== 'number' || latitude < -90 || latitude > 90) {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid latitude',
          code: 'INVALID_LATITUDE',
          details: 'Latitude must be a number between -90 and 90',
        };
        res.status(400).json(errorResponse);
        return;
      }

      if (typeof longitude !== 'number' || longitude < -180 || longitude > 180) {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid longitude',
          code: 'INVALID_LONGITUDE',
          details: 'Longitude must be a number between -180 and 180',
        };
        res.status(400).json(errorResponse);
        return;
      }

      if (altitude !== undefined && typeof altitude !== 'number') {
        const errorResponse: ApiErrorResponse = {
          error: 'Invalid altitude',
          code: 'INVALID_ALTITUDE',
          details: 'Altitude must be a number',
        };
        res.status(400).json(errorResponse);
        return;
      }
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Set position override in database
    databaseService.setNodePositionOverride(
      nodeNum,
      enabled,
      enabled ? latitude : undefined,
      enabled ? longitude : undefined,
      enabled ? altitude : undefined,
      enabled ? isPrivate : undefined
    );

    res.json({
      success: true,
      nodeNum,
      enabled,
      latitude: enabled ? latitude : null,
      longitude: enabled ? longitude : null,
      altitude: enabled ? altitude : null,
      isPrivate: enabled ? isPrivate : false,
    });
  } catch (error) {
    logger.error('Error setting node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Delete node position override
apiRouter.delete('/nodes/:nodeId/position-override', requirePermission('nodes', 'write'), (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Clear position override in database
    databaseService.clearNodePositionOverride(nodeNum);

    res.json({
      success: true,
      nodeNum,
      message: 'Position override cleared',
    });
  } catch (error) {
    logger.error('Error clearing node position override:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to clear node position override',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Delete neighbor info for a node
apiRouter.delete('/nodes/:nodeId/neighbors', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

    // Validate hex string format (must be exactly 8 hex characters)
    if (!/^[0-9a-fA-F]{8}$/.test(nodeNumStr)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeId format',
        code: 'INVALID_NODE_ID',
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Delete neighbor info from database
    const deletedCount = await databaseService.deleteNeighborInfoForNodeAsync(nodeNum);

    res.json({
      success: true,
      nodeNum,
      deletedCount,
      message: `Deleted ${deletedCount} neighbor records`,
    });
  } catch (error) {
    logger.error('Error deleting neighbor info:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to delete neighbor info',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Manually scan a node for remote admin capability
apiRouter.post('/nodes/:nodeNum/scan-remote-admin', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { nodeNum } = req.params;
    const parsedNodeNum = parseInt(nodeNum, 10);

    if (isNaN(parsedNodeNum)) {
      const errorResponse: ApiErrorResponse = {
        error: 'Invalid nodeNum format',
        code: 'INVALID_NODE_NUM',
        details: 'nodeNum must be a valid integer',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Check if the node exists
    const node = databaseService.getNode(parsedNodeNum);
    if (!node) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node not found',
        code: 'NODE_NOT_FOUND',
        details: `No node found with nodeNum ${parsedNodeNum}`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    logger.info(`Manual remote admin scan requested for node ${parsedNodeNum}`);

    // Perform the scan
    const result = await meshtasticManager.scanNodeForRemoteAdmin(parsedNodeNum);

    res.json({
      success: true,
      nodeNum: parsedNodeNum,
      hasRemoteAdmin: result.hasRemoteAdmin,
      metadata: result.metadata,
    });
  } catch (error) {
    logger.error('Error scanning node for remote admin:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to scan node for remote admin',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
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
      details: error instanceof Error ? error.message : 'Unknown error occurred',
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
        details: 'nodeId must be in format !XXXXXXXX (8 hex characters)',
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
        details: `No node found with ID ${nodeId}`,
      };
      res.status(404).json(errorResponse);
      return;
    }

    if (!node.keyIsLowEntropy && !node.duplicateKeyDetected) {
      const errorResponse: ApiErrorResponse = {
        error: 'Node has no security issues',
        code: 'NO_SECURITY_ISSUE',
        details: 'This node does not have any detected key security issues',
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
      0, // Channel 0
      nodeNum // Destination
    );

    logger.info(`🔐 Sent key security warning to node ${nodeId} (${node.longName || 'Unknown'})`);

    res.json({
      success: true,
      nodeNum,
      nodeId,
      messageId,
      messageSent: warningMessage,
    });
  } catch (error) {
    logger.error('Error sending key warning:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to send key warning',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
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
          keySecurityIssueDetails: node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined,
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
          keySecurityIssueDetails: details,
        });
      }
      logger.info(`🔐 Detected ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
    }

    res.json({
      success: true,
      duplicatesFound: duplicates.size,
      affectedNodes: Array.from(duplicates.values()).flat(),
      totalNodesScanned: nodesWithKeys.length,
    });
  } catch (error) {
    logger.error('Error scanning for duplicate keys:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to scan for duplicate keys',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

apiRouter.get('/messages', optionalAuth(), async (req, res) => {
  try {
    // Check if user has either any channel permission or messages permission
    const hasChannelsRead = req.user?.isAdmin || await hasPermission(req.user!, 'channel_0', 'read');
    const hasMessagesRead = req.user?.isAdmin || await hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' },
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

// Helper function to transform DbMessage to MeshMessage format
// This mirrors the transformation in meshtasticManager.getRecentMessages()
function transformDbMessageToMeshMessage(msg: DbMessage): MeshMessage {
  return {
    id: msg.id,
    from: msg.fromNodeId,
    to: msg.toNodeId,
    fromNodeId: msg.fromNodeId,
    toNodeId: msg.toNodeId,
    text: msg.text,
    channel: msg.channel,
    portnum: msg.portnum,
    timestamp: new Date(msg.rxTime ?? msg.timestamp),
    hopStart: msg.hopStart,
    hopLimit: msg.hopLimit,
    relayNode: msg.relayNode,
    replyId: msg.replyId,
    emoji: msg.emoji,
    rxSnr: msg.rxSnr,
    rxRssi: msg.rxRssi,
    requestId: (msg as any).requestId,
    wantAck: Boolean((msg as any).wantAck),
    ackFailed: Boolean((msg as any).ackFailed),
    routingErrorReceived: Boolean((msg as any).routingErrorReceived),
    deliveryState: (msg as any).deliveryState,
    acknowledged:
      msg.channel === -1
        ? (msg as any).deliveryState === 'confirmed'
          ? true
          : undefined
        : (msg as any).deliveryState === 'delivered' || (msg as any).deliveryState === 'confirmed'
        ? true
        : undefined,
    decryptedBy: msg.decryptedBy ?? (msg as any).decrypted_by ?? null,
  };
}

apiRouter.get('/messages/channel/:channel', optionalAuth(), async (req, res) => {
  try {
    const requestedChannel = parseInt(req.params.channel);
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));

    // Check if this is a Primary channel request and map to channel 0 messages
    let messageChannel = requestedChannel;
    // In Meshtastic, channel 0 is always the Primary channel
    // If the requested channel is 0, use it directly
    if (requestedChannel === 0) {
      messageChannel = 0;
    }

    // Check per-channel read permission
    const channelResource = `channel_${messageChannel}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !await hasPermission(req.user!, channelResource, 'read')) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'read' },
      });
    }

    // Fetch limit+1 to accurately detect if more messages exist
    const dbMessages = databaseService.getMessagesByChannel(messageChannel, limit + 1, offset);
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

apiRouter.get('/messages/direct/:nodeId1/:nodeId2', requirePermission('messages', 'read'), (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));
    // Fetch limit+1 to accurately detect if more messages exist
    const dbMessages = databaseService.getDirectMessages(nodeId1, nodeId2, limit + 1, offset);
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching direct messages:', error);
    res.status(500).json({ error: 'Failed to fetch direct messages' });
  }
});

// Mark messages as read
apiRouter.post('/messages/mark-read', optionalAuth(), async (req, res) => {
  try {
    const { messageIds, channelId, nodeId, beforeTimestamp, allDMs } = req.body;

    // If marking by channelId, check per-channel read permission
    if (channelId !== undefined && channelId !== null && channelId !== -1) {
      const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !await hasPermission(req.user!, channelResource, 'read')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'read' },
        });
      }
    }

    // If marking by nodeId (DMs) or allDMs, check messages permission
    if ((nodeId && channelId === -1) || allDMs) {
      const hasMessagesRead = req.user?.isAdmin || await hasPermission(req.user!, 'messages', 'read');
      if (!hasMessagesRead) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'read' },
        });
      }
    }

    const userId = req.user?.id ?? null;
    let markedCount = 0;

    if (messageIds && Array.isArray(messageIds)) {
      // Mark specific messages as read
      databaseService.markMessagesAsRead(messageIds, userId);
      markedCount = messageIds.length;
    } else if (allDMs) {
      // Mark ALL DMs as read
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = databaseService.markAllDMMessagesAsRead(localNodeInfo.nodeId, userId);
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
      return res.status(400).json({ error: 'Must provide messageIds, channelId, nodeId, or allDMs' });
    }

    res.json({ marked: markedCount });
  } catch (error) {
    logger.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Get unread message counts
apiRouter.get('/messages/unread-counts', optionalAuth(), async (req, res) => {
  try {
    // Check if user has either any channel permission or messages permission
    const hasChannelsRead = req.user?.isAdmin || await hasPermission(req.user!, 'channel_0', 'read');
    const hasMessagesRead = req.user?.isAdmin || await hasPermission(req.user!, 'messages', 'read');

    if (!hasChannelsRead && !hasMessagesRead) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: 'channel_0 or messages', action: 'read' },
      });
    }

    const userId = req.user?.id ?? null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();

    const result: {
      channels?: { [channelId: number]: number };
      directMessages?: { [nodeId: string]: number };
    } = {};

    // Get channel unread counts if user has channels permission
    // Only count incoming messages (exclude messages sent by our node)
    if (hasChannelsRead) {
      result.channels = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId);
    }

    // Get DM unread counts if user has messages permission (batch query)
    if (hasMessagesRead && localNodeInfo) {
      const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId);
      const allNodes = meshtasticManager.getAllNodes();
      const visibleNodes = await filterNodesByChannelPermission(allNodes, req.user);
      const visibleNodeIds = new Set(visibleNodes.map(n => n.user?.id).filter(Boolean));
      const directMessages: { [nodeId: string]: number } = {};
      for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
        if (visibleNodeIds.has(nodeId) && count > 0) {
          directMessages[nodeId] = count;
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
        clients: [],
      });
    }

    const isRunning = virtualNodeServer.isRunning();
    const clientCount = virtualNodeServer.getClientCount();
    const clients = virtualNodeServer.getClientDetails();

    res.json({
      enabled: true,
      isRunning,
      clientCount,
      clients,
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
    logger.debug(
      `🔍 All channels in DB:`,
      allChannels.map(ch => ({ id: ch.id, name: ch.name }))
    );
    logger.debug(
      `🔍 Filtered channels:`,
      filteredChannels.map(ch => ({ id: ch.id, name: ch.name }))
    );
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
      downlinkEnabled: channel.downlinkEnabled,
    });

    // Create export data with metadata
    // Normalize boolean values to ensure consistent export format (handle any numeric 0/1 values)
    const normalizeBoolean = (value: any): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
      return !!value;
    };

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      channel: {
        id: channel.id,
        name: channel.name,
        psk: channel.psk,
        role: channel.role,
        uplinkEnabled: normalizeBoolean(channel.uplinkEnabled),
        downlinkEnabled: normalizeBoolean(channel.downlinkEnabled),
        positionPrecision: channel.positionPrecision,
      },
    };

    // Set filename header
    const filename = `meshmonitor-channel-${channel.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    // Use pretty-printed JSON for consistency with other exports
    res.send(JSON.stringify(exportData, null, 2));
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
    if (
      positionPrecision !== undefined &&
      positionPrecision !== null &&
      (typeof positionPrecision !== 'number' || positionPrecision < 0 || positionPrecision > 32)
    ) {
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
      name: name !== undefined && name !== null ? name : existingChannel.name,
      psk: psk !== undefined && psk !== null ? psk : existingChannel.psk,
      role: role !== undefined && role !== null ? role : existingChannel.role,
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : existingChannel.uplinkEnabled,
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : existingChannel.downlinkEnabled,
      positionPrecision:
        positionPrecision !== undefined && positionPrecision !== null
          ? positionPrecision
          : existingChannel.positionPrecision,
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
        positionPrecision: updatedChannelData.positionPrecision,
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
    // Normalize boolean values - handle both boolean (true/false) and numeric (1/0) formats
    const normalizeBoolean = (value: any, defaultValue: boolean = true): boolean => {
      if (value === undefined || value === null) {
        return defaultValue;
      }
      // Handle boolean values
      if (typeof value === 'boolean') {
        return value;
      }
      // Handle numeric values (0/1)
      if (typeof value === 'number') {
        return value !== 0;
      }
      // Handle string values ("true"/"false", "1"/"0")
      if (typeof value === 'string') {
        return value.toLowerCase() === 'true' || value === '1';
      }
      // Default to truthy check
      return !!value;
    };

    const importedChannelData = {
      id: slotId,
      name,
      psk: psk || undefined,
      role: role !== null && role !== undefined ? role : undefined,
      uplinkEnabled: normalizeBoolean(uplinkEnabled, true),
      downlinkEnabled: normalizeBoolean(downlinkEnabled, true),
      positionPrecision: positionPrecision !== null && positionPrecision !== undefined ? positionPrecision : undefined,
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
        positionPrecision: importedChannelData.positionPrecision,
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
          positionPrecision: ch.positionPrecision,
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
          configOkToMqtt: deviceConfig.lora.configOkToMqtt,
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
            positionPrecision: channel.positionPrecision,
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
          txEnabled: true,
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
      logger.info(
        `💾 Committing all configuration changes (${importedChannels.length} channels${
          loraImported ? ' + LoRa config' : ''
        })...`
      );
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
        loraConfig: loraImported,
      },
      requiresReboot,
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
      messagesByDay,
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
    let meshChannel = channel !== undefined && channel >= 0 && channel <= 7 ? channel : 0;

    // For DMs, use the channel we last heard the target node on (from NodeInfo)
    // This ensures we send on a channel the target node has configured
    if (destinationNum) {
      const targetNode = databaseService.getNode(destinationNum);
      if (targetNode && targetNode.channel !== undefined && targetNode.channel !== null) {
        meshChannel = targetNode.channel;
        logger.info(`📨 DM to ${destination} - Using target node's channel: ${meshChannel}`);
      } else {
        logger.info(`📨 DM to ${destination} - Target node channel unknown, using default channel: ${meshChannel}`);
      }
    }

    logger.info(
      `📨 Sending message - Received channel: ${channel}, Using meshChannel: ${meshChannel}, Text: "${text.substring(
        0,
        50
      )}${text.length > 50 ? '...' : ''}"`
    );

    // Check permissions based on whether this is a DM or channel message
    if (destinationNum) {
      // Direct message - check 'messages' write permission
      if (!req.user?.isAdmin && !await hasPermission(req.user!, 'messages', 'write')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'write' },
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelResource = `channel_${meshChannel}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !await hasPermission(req.user!, channelResource, 'write')) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'write' },
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
    res.json({
      success: true,
      message: `Traceroute request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
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
    logger.info(
      `📍 localNodeInfo for system message: ${
        localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'
      }`
    );

    if (localNodeInfo) {
      // Create a system message to record the position request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = channel === 0 ? -1 : channel;

      logger.info(
        `📍 Inserting position request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId})`
      );
      databaseService.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: 'Position exchange requested',
        channel: messageChannel,
        portnum: PortNum.TEXT_MESSAGE_APP, // Shows in DM view (DM filter requires TEXT_MESSAGE_APP)
        requestId: requestId, // Store requestId for ACK matching
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: timestamp,
      });
      logger.info(`📍 Position request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for position request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `Position request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error) {
    logger.error('Error sending position request:', error);
    res.status(500).json({ error: 'Failed to send position request' });
  }
});

// NodeInfo request endpoint (Exchange User Info - triggers key exchange)
apiRouter.post('/nodeinfo/request', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel
    const node = databaseService.getNode(destinationNum);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const { packetId, requestId } = await meshtasticManager.sendNodeInfoRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    logger.info(
      `📇 localNodeInfo for system message: ${
        localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'
      }`
    );

    if (localNodeInfo) {
      // Create a system message to record the nodeinfo request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = channel === 0 ? -1 : channel;

      logger.info(
        `📇 Inserting nodeinfo request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId})`
      );
      databaseService.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: 'User info exchange requested',
        channel: messageChannel,
        portnum: PortNum.TEXT_MESSAGE_APP, // Shows in DM view (DM filter requires TEXT_MESSAGE_APP)
        requestId: requestId, // Store requestId for ACK matching
        timestamp: timestamp,
        rxTime: timestamp,
        createdAt: timestamp,
      });
      logger.info(`📇 NodeInfo request system message inserted successfully`);
    } else {
      logger.warn(`⚠️ Could not create system message for nodeinfo request - localNodeInfo is null`);
    }

    res.json({
      success: true,
      message: `NodeInfo request sent to ${destinationNum.toString(16)} on channel ${channel}`,
    });
  } catch (error) {
    logger.error('Error sending nodeinfo request:', error);
    res.status(500).json({ error: 'Failed to send nodeinfo request' });
  }
});

// NeighborInfo request endpoint (request neighbor info from remote node)
apiRouter.post('/neighborinfo/request', requirePermission('traceroute', 'write'), async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel
    const node = databaseService.getNode(destinationNum);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const { packetId, requestId } = await meshtasticManager.sendNeighborInfoRequest(destinationNum, channel);

    logger.info(`🏠 NeighborInfo request sent to ${destinationNum.toString(16)} on channel ${channel}, packetId=${packetId}, requestId=${requestId}`);

    res.json({
      success: true,
      message: `NeighborInfo request sent to ${destinationNum.toString(16)} on channel ${channel}`,
      packetId,
      requestId
    });
  } catch (error) {
    logger.error('Error sending neighborinfo request:', error);
    res.status(500).json({ error: 'Failed to send neighborinfo request' });
  }
});

// Telemetry request endpoint (request telemetry from remote node)
apiRouter.post('/telemetry/request', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { destination, telemetryType } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    // Validate telemetry type if provided
    const validTypes = ['device', 'environment', 'airQuality', 'power'];
    if (telemetryType && !validTypes.includes(telemetryType)) {
      return res.status(400).json({ error: `Invalid telemetry type. Must be one of: ${validTypes.join(', ')}` });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel
    const node = databaseService.getNode(destinationNum);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const { packetId, requestId } = await meshtasticManager.sendTelemetryRequest(
      destinationNum,
      channel,
      telemetryType as 'device' | 'environment' | 'airQuality' | 'power' | undefined
    );

    const typeLabel = telemetryType || 'device';
    logger.info(`📊 Telemetry request (${typeLabel}) sent to ${destinationNum.toString(16)} on channel ${channel}, packetId=${packetId}, requestId=${requestId}`);

    res.json({
      success: true,
      message: `Telemetry request (${typeLabel}) sent to ${destinationNum.toString(16)} on channel ${channel}`,
      packetId,
      requestId
    });
  } catch (error) {
    logger.error('Error sending telemetry request:', error);
    res.status(500).json({ error: 'Failed to send telemetry request' });
  }
});

// Get recent traceroutes (last 24 hours)
apiRouter.get('/traceroutes/recent', (req, res) => {
  try {
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Calculate dynamic default limit based on settings:
    // Auto-traceroutes per hour * Max Node Age (hours) * 1.1 (padding for manual traceroutes)
    let limit: number;
    if (req.query.limit) {
      // Use explicit limit if provided
      limit = parseInt(req.query.limit as string);
    } else {
      // Calculate dynamic default based on traceroute settings
      const tracerouteIntervalMinutes = parseInt(databaseService.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      // Ensure a reasonable minimum
      limit = Math.max(limit, 100);
    }

    const allTraceroutes = databaseService.getAllTraceroutes(limit);

    const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

    const traceroutesWithHops = recentTraceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          // Verify routeArray is actually an array before accessing .length
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
          // If routeArray is not an array, hopCount remains 999
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
apiRouter.get('/traceroutes/history/:fromNodeNum/:toNodeNum', async (req, res) => {
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
    if (fromNodeNum < 0 || fromNodeNum > 0xffffffff || toNodeNum < 0 || toNodeNum > 0xffffffff) {
      res.status(400).json({ error: 'Node numbers must be between 0 and 4294967295' });
      return;
    }

    // Validate limit parameter
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: 'Limit must be between 1 and 1000' });
      return;
    }

    const traceroutes = await databaseService.getTraceroutesByNodesAsync(fromNodeNum, toNodeNum, limit);

    const traceroutesWithHops = traceroutes.map(tr => {
      let hopCount = 999;
      try {
        if (tr.route) {
          const routeArray = JSON.parse(tr.route);
          // Verify routeArray is actually an array before accessing .length
          if (Array.isArray(routeArray)) {
            hopCount = routeArray.length;
          }
          // If routeArray is not an array, hopCount remains 999
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
apiRouter.get('/route-segments/longest-active', requirePermission('info', 'read'), async (_req, res) => {
  try {
    const segment = await databaseService.getLongestActiveRouteSegmentAsync();
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
      toNodeName: toNode?.longName || segment.toNodeId,
    };

    res.json(enrichedSegment);
  } catch (error) {
    logger.error('Error fetching longest active route segment:', error);
    res.status(500).json({ error: 'Failed to fetch longest active route segment' });
  }
});

// Get record holder route segment
apiRouter.get('/route-segments/record-holder', requirePermission('info', 'read'), async (_req, res) => {
  try {
    const segment = await databaseService.getRecordHolderRouteSegmentAsync();
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
      toNodeName: toNode?.longName || segment.toNodeId,
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

// Helper to get effective position (respecting overrides)
const getEffectivePosition = (node: ReturnType<typeof databaseService.getNode>) => {
  if (!node) return { latitude: undefined, longitude: undefined };

  // Check for position override first
  // Note: SQLite returns 1 for boolean true, PostgreSQL/MySQL return true via Drizzle
  // Using truthy check handles both cases (1 and true are both truthy)
  if (node.positionOverrideEnabled && node.latitudeOverride != null && node.longitudeOverride != null) {
    return { latitude: node.latitudeOverride, longitude: node.longitudeOverride };
  }

  // Fall back to regular position
  return { latitude: node.latitude, longitude: node.longitude };
};

// Get all neighbor info (latest per node pair)
apiRouter.get('/neighbor-info', requirePermission('info', 'read'), (_req, res) => {
  try {
    const neighborInfo = databaseService.getLatestNeighborInfoPerNode();

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = databaseService.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    // Enrich with node names and filter by node age
    const enrichedNeighborInfo = neighborInfo
      .map(ni => {
        const node = databaseService.getNode(ni.nodeNum);
        const neighbor = databaseService.getNode(ni.neighborNodeNum);
        const nodePos = getEffectivePosition(node);
        const neighborPos = getEffectivePosition(neighbor);

        return {
          ...ni,
          nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
          nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
          neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          nodeLatitude: nodePos.latitude,
          nodeLongitude: nodePos.longitude,
          neighborLatitude: neighborPos.latitude,
          neighborLongitude: neighborPos.longitude,
          node,
          neighbor,
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
      const neighborPos = getEffectivePosition(neighbor);

      return {
        ...ni,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
      };
    });

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info for node:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info for node' });
  }
});

// Get direct neighbor RSSI statistics from zero-hop packets
// This helps identify which nodes we've heard directly (no relays)
apiRouter.get('/direct-neighbors', requirePermission('info', 'read'), async (req, res) => {
  try {
    const hoursBack = parseInt(req.query.hours as string) || 24;
    const stats = await databaseService.getDirectNeighborStatsAsync(hoursBack);

    res.json({
      success: true,
      data: stats,
      count: Object.keys(stats).length
    });
  } catch (error) {
    logger.error('Error getting direct neighbor stats:', error);
    res.status(500).json({ error: 'Failed to fetch direct neighbor statistics' });
  }
});

// Get telemetry data for a node
apiRouter.get('/telemetry/:nodeId', optionalAuth(), async (req, res) => {
  try {
    // Allow users with info read OR dashboard read (dashboard needs telemetry data)
    if (
      !req.user?.isAdmin &&
      !await hasPermission(req.user!, 'info', 'read') &&
      !await hasPermission(req.user!, 'dashboard', 'read')
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Check if node has private position override
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = databaseService.getNode(nodeNum);
    const isPrivate = node?.positionOverrideIsPrivate === true;
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');

    let telemetry: any[];
    // For PostgreSQL/MySQL, use async repo directly
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.telemetryRepo) {
        const limit = Math.min(hoursParam * 60, 5000);
        telemetry = await databaseService.telemetryRepo.getTelemetryByNode(nodeId, limit, cutoffTime);
      } else {
        telemetry = [];
      }
    } else {
      // Use averaged query for graph data to reduce data points
      // Dynamic bucketing automatically adjusts interval based on time range:
      // - 0-24h: 3-minute intervals (high detail)
      // - 1-7d: 30-minute intervals (medium detail)
      // - 7d+: 2-hour intervals (low detail, full coverage)
      telemetry = databaseService.getTelemetryByNodeAveraged(nodeId, cutoffTime, undefined, hoursParam);
    }

    // Filter out location telemetry if private and unauthorized
    let processedTelemetry = telemetry;
    if (isPrivate && !canViewPrivate) {
      processedTelemetry = telemetry.filter(t =>
        !['latitude', 'longitude', 'altitude'].includes(t.telemetryType)
      );
    }

    res.json(processedTelemetry);
  } catch (error) {
    logger.error('Error fetching telemetry:', error);
    res.status(500).json({ error: 'Failed to fetch telemetry' });
  }
});

// Get packet rate statistics (packets per minute) for a node
apiRouter.get('/telemetry/:nodeId/rates', optionalAuth(), async (req, res) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !await hasPermission(req.user!, 'info', 'read') &&
      !await hasPermission(req.user!, 'dashboard', 'read')
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // The 7 packet statistics types we want rates for
    const packetTypes = [
      'numPacketsRx',
      'numPacketsRxBad',
      'numRxDupe',
      'numPacketsTx',
      'numTxDropped',
      'numTxRelay',
      'numTxRelayCanceled',
    ];

    let rates: Record<string, Array<{ timestamp: number; ratePerMinute: number }>>;

    // For PostgreSQL/MySQL, calculate rates from raw telemetry
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      rates = {};
      for (const type of packetTypes) {
        rates[type] = [];
      }

      if (databaseService.telemetryRepo) {
        // Fetch telemetry for each packet type and calculate rates
        for (const type of packetTypes) {
          const telemetry = await databaseService.telemetryRepo.getTelemetryByNode(
            nodeId, 5000, cutoffTime, undefined, 0, type
          );

          // Sort by timestamp ascending for rate calculation
          telemetry.sort((a, b) => a.timestamp - b.timestamp);

          // Calculate rates from consecutive samples
          for (let i = 1; i < telemetry.length; i++) {
            const prev = telemetry[i - 1];
            const curr = telemetry[i];
            const timeDiffMs = curr.timestamp - prev.timestamp;
            const valueDiff = curr.value - prev.value;

            if (timeDiffMs > 0 && valueDiff >= 0) {
              const timeDiffMinutes = timeDiffMs / 60000;
              const ratePerMinute = valueDiff / timeDiffMinutes;
              rates[type].push({
                timestamp: curr.timestamp,
                ratePerMinute: Math.round(ratePerMinute * 100) / 100,
              });
            }
          }
        }
      }
    } else {
      rates = databaseService.getPacketRates(nodeId, packetTypes, cutoffTime);
    }

    res.json(rates);
  } catch (error) {
    logger.error('Error fetching packet rates:', error);
    res.status(500).json({ error: 'Failed to fetch packet rates' });
  }
});

// Get smart hops statistics (min/max/avg hop counts over time) for a node
apiRouter.get('/telemetry/:nodeId/smarthops', optionalAuth(), async (req, res) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !await hasPermission(req.user!, 'info', 'read') &&
      !await hasPermission(req.user!, 'dashboard', 'read')
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;
    // Validate and clamp hours (1-168, default 24)
    const hoursParam = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));
    // Validate and clamp interval (5-60 minutes, default 15)
    const intervalParam = Math.max(5, Math.min(60, parseInt(req.query.interval as string) || 15));

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Get smart hops statistics
    const stats = await databaseService.getSmartHopsStatsAsync(nodeId, cutoffTime, intervalParam);

    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Error fetching smart hops stats:', error);
    res.status(500).json({ error: 'Failed to fetch smart hops statistics' });
  }
});

// Get link quality history for a node
apiRouter.get('/telemetry/:nodeId/linkquality', optionalAuth(), async (req, res) => {
  try {
    // Allow users with info read OR dashboard read
    if (
      !req.user?.isAdmin &&
      !await hasPermission(req.user!, 'info', 'read') &&
      !await hasPermission(req.user!, 'dashboard', 'read')
    ) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { nodeId } = req.params;
    // Validate and clamp hours (1-168, default 24)
    const hoursParam = Math.max(1, Math.min(168, parseInt(req.query.hours as string) || 24));

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Get link quality history
    const history = await databaseService.getLinkQualityHistoryAsync(nodeId, cutoffTime);

    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Error fetching link quality history:', error);
    res.status(500).json({ error: 'Failed to fetch link quality history' });
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
apiRouter.get('/telemetry/available/nodes', requirePermission('info', 'read'), async (req, res) => {
  try {
    const allNodes = databaseService.getAllNodes();
    // Filter nodes based on channel read permissions
    const nodes = await filterNodesByChannelPermission(allNodes, (req as any).user);

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

        // Check if node has estimated position telemetry AND doesn't have real GPS coordinates
        // Only show uncertainty circle for nodes currently using estimated position
        const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
        const hasRealPosition = !!(node.latitude && node.longitude);
        if (hasEstimatedPosition && !hasRealPosition) {
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
      pkc: nodesWithPKC,
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

// Get security keys (public and private) for the local node
// Private key is sensitive - requires authentication
apiRouter.get('/device/security-keys', requireAuth(), async (_req, res) => {
  try {
    const keys = meshtasticManager.getSecurityKeys();
    res.json(keys);
  } catch (error) {
    logger.error('Error getting security keys:', error);
    res.status(500).json({ error: 'Failed to get security keys' });
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
      traceroutes?: any[];
    } = {};

    // Pre-compute shared values used across multiple sections
    const user = (req as any).user;
    const userId = req.user?.id ?? null;
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const allMemoryNodes = meshtasticManager.getAllNodes();
    const filteredMemoryNodes = await filterNodesByChannelPermission(allMemoryNodes, user);
    const hasChannelsRead = req.user?.isAdmin || await hasPermission(req.user!, 'channel_0', 'read');
    const hasMessagesRead = req.user?.isAdmin || await hasPermission(req.user!, 'messages', 'read');
    const hasInfoRead = req.user?.isAdmin || await hasPermission(req.user!, 'info', 'read');
    const canViewPrivate = user ? await hasPermission(user, 'nodes_private', 'read') : false;

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

    // 2. Nodes (always available with optionalAuth, filtered by channel permissions)
    try {
      const estimatedPositions = databaseService.getAllNodesEstimatedPositions();
      result.nodes = await Promise.all(filteredMemoryNodes.map(node => enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate)));
    } catch (error) {
      logger.error('Error fetching nodes in poll:', error);
      result.nodes = [];
    }

    // 3. Messages (requires any channel permission OR messages permission)
    try {
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
      const unreadResult: {
        channels?: { [channelId: number]: number };
        directMessages?: { [nodeId: string]: number };
      } = {};

      // Get unread counts for all channels first
      // Only count incoming messages (exclude messages sent by our node)
      const allUnreadChannels = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId);

      // Filter channels based on per-channel read permission
      const filteredUnreadChannels: { [channelId: number]: number } = {};
      for (const [channelIdStr, count] of Object.entries(allUnreadChannels)) {
        const channelId = parseInt(channelIdStr);
        const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = req.user?.isAdmin || await hasPermission(req.user!, channelResource, 'read');

        if (hasChannelRead) {
          filteredUnreadChannels[channelId] = count;
        }
      }
      unreadResult.channels = filteredUnreadChannels;

      // Batch DM unread counts (single query instead of N+1)
      if (hasMessagesRead && localNodeInfo) {
        const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId);
        const visibleNodeIds = new Set(filteredMemoryNodes.map(n => n.user?.id).filter(Boolean));
        const directMessages: { [nodeId: string]: number } = {};
        for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
          if (visibleNodeIds.has(nodeId) && count > 0) {
            directMessages[nodeId] = count;
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

      // Filter channels async
      const filteredChannels: typeof allChannels = [];
      for (const channel of allChannels) {
        // Exclude disabled channels (role === 0)
        if (channel.role === 0) {
          continue;
        }

        // Check per-channel read permission
        const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = req.user?.isAdmin || await hasPermission(req.user!, channelResource, 'read');

        if (!hasChannelRead) {
          continue; // User doesn't have permission to see this channel
        }

        // Show channel 0 (Primary channel) if user has permission
        if (channel.id === 0) {
          filteredChannels.push(channel);
          continue;
        }

        // Show channels 1-7 if they have a PSK configured (indicating they're in use)
        if (channel.id >= 1 && channel.id <= 7 && channel.psk) {
          filteredChannels.push(channel);
          continue;
        }

        // Show channels with a role defined (PRIMARY, SECONDARY)
        if (channel.role !== null && channel.role !== undefined) {
          filteredChannels.push(channel);
        }
      }

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

    // 6. Telemetry availability (requires info:read permission, filtered by channel permissions)
    try {
      if (hasInfoRead) {
        // Use DB nodes for telemetry (has telemetryTypes), filtered by channel permissions
        const allDbNodes = databaseService.getAllNodes();
        const dbNodes = await filterNodesByChannelPermission(allDbNodes, req.user);

        const nodesWithTelemetry: string[] = [];
        const nodesWithWeather: string[] = [];
        const nodesWithEstimatedPosition: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);
        const estimatedPositionTypes = new Set(['estimated_latitude', 'estimated_longitude']);

        const nodeTelemetryTypes = databaseService.getAllNodesTelemetryTypes();

        dbNodes.forEach(node => {
          const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
          if (telemetryTypes && telemetryTypes.length > 0) {
            nodesWithTelemetry.push(node.nodeId);

            const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
            if (hasWeather) {
              nodesWithWeather.push(node.nodeId);
            }

            // Only show uncertainty circle for nodes currently using estimated position
            const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
            const hasRealPosition = !!(node.latitude && node.longitude);
            if (hasEstimatedPosition && !hasRealPosition) {
              nodesWithEstimatedPosition.push(node.nodeId);
            }
          }
        });

        const nodesWithPKC: string[] = [];
        dbNodes.forEach(node => {
          if (node.hasPKC || node.publicKey) {
            nodesWithPKC.push(node.nodeId);
          }
        });

        result.telemetryNodes = {
          nodes: nodesWithTelemetry,
          weather: nodesWithWeather,
          estimatedPosition: nodesWithEstimatedPosition,
          pkc: nodesWithPKC,
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
            rebootCount: currentNode.rebootCount,
          };

          localNodeInfo = {
            nodeId: currentNode.nodeId,
            longName: currentNode.longName,
            shortName: currentNode.shortName,
          };
        }
      }

      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL,
        deviceMetadata: deviceMetadata,
        localNodeInfo: localNodeInfo,
      };
    } catch (error) {
      logger.error('Error in config section of poll:', error);
      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL,
      };
    }

    // 8. Device config (requires configuration:read permission)
    try {
      const hasConfigRead = req.user?.isAdmin || await hasPermission(req.user!, 'configuration', 'read');
      if (hasConfigRead) {
        const config = await meshtasticManager.getDeviceConfig();
        if (config) {
          // Hide node address from anonymous users
          if (!req.session.userId && config.basic) {
            const { nodeAddress, ...basicWithoutNodeAddress } = config.basic;
            result.deviceConfig = {
              ...config,
              basic: basicWithoutNodeAddress,
            };
          } else {
            result.deviceConfig = config;
          }
        }
      }
    } catch (error) {
      logger.error('Error fetching device config in poll:', error);
    }

    // 9. Recent traceroutes (for dashboard widget and node view)
    try {
      const hoursParam = 24;
      const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

      // Calculate dynamic default limit based on settings
      const tracerouteIntervalMinutes = parseInt(databaseService.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(databaseService.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      let limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);

      const allTraceroutes = databaseService.getAllTraceroutes(limit);
      const recentTraceroutes = allTraceroutes.filter(tr => tr.timestamp >= cutoffTime);

      // Add hopCount for each traceroute
      const traceroutesWithHops = recentTraceroutes.map(tr => {
        let hopCount = 999;
        try {
          if (tr.route) {
            const routeArray = JSON.parse(tr.route);
            // Verify routeArray is actually an array before accessing .length
            if (Array.isArray(routeArray)) {
              hopCount = routeArray.length;
            }
            // If routeArray is not an array, hopCount remains 999
          }
        } catch (e) {
          hopCount = 999;
        }
        return { ...tr, hopCount };
      });

      result.traceroutes = traceroutesWithHops;
    } catch (error) {
      logger.error('Error fetching traceroutes in poll:', error);
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
      status: success ? 'connecting' : 'disconnected',
    });
  } catch (error) {
    logger.error('Error reconnecting:', error);
    res.status(500).json({ error: 'Failed to reconnect' });
  }
});

// Get detailed connection info (authenticated users only)
apiRouter.get('/connection/info', requireAuth(), (_req, res) => {
  try {
    const status = meshtasticManager.getConnectionStatus();
    const env = getEnvironmentConfig();
    const ipOverride = databaseService.getSetting('meshtasticNodeIpOverride');
    const portOverride = databaseService.getSetting('meshtasticTcpPortOverride');

    res.json({
      ...status,
      defaultIp: env.meshtasticNodeIp,
      defaultPort: env.meshtasticTcpPort,
      isOverridden: !!(ipOverride || portOverride),
      tcpPort: portOverride ? parseInt(portOverride, 10) : env.meshtasticTcpPort
    });
  } catch (error) {
    logger.error('Error getting connection info:', error);
    res.status(500).json({ error: 'Failed to get connection info' });
  }
});

// Configure connection IP address (admin only)
apiRouter.post('/connection/configure', requireAdmin(), async (req, res) => {
  try {
    const { nodeIp } = req.body;

    // Validate IP format (IPv4 address or hostname, with optional port)
    // Accepts: 192.168.1.100, 192.168.1.100:4403, hostname, hostname:4403
    const ipRegex = /^(?:(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)|[\w.-]+)(?::\d{1,5})?$/;
    if (!nodeIp || !ipRegex.test(nodeIp)) {
      return res.status(400).json({ error: 'Invalid IP address or hostname' });
    }

    // Validate port range if specified
    const portMatch = nodeIp.match(/:(\d+)$/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) {
        return res.status(400).json({ error: 'Port must be between 1 and 65535' });
      }
    }

    // Set the override
    await meshtasticManager.setNodeIpOverride(nodeIp);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'connection_address_changed',
      'connection',
      JSON.stringify({ address: nodeIp }),
      req.ip || null
    );

    res.json({
      success: true,
      message: 'Node address updated. Reconnecting...',
      nodeIp
    });
  } catch (error) {
    logger.error('Error configuring connection:', error);
    res.status(500).json({ error: 'Failed to configure connection' });
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
          rebootCount: currentNode.rebootCount,
        };

        // Include local node identity information for anonymous users
        localNodeInfo = {
          nodeId: currentNode.nodeId,
          longName: currentNode.longName,
          shortName: currentNode.shortName,
        };
      }
    }

    res.json({
      ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false, // We're using TCP, not TLS
      baseUrl: BASE_URL,
      deviceMetadata: deviceMetadata,
      localNodeInfo: localNodeInfo,
    });
  } catch (error) {
    logger.error('Error in /api/config:', error);
    res.json({
      ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
      meshtasticTcpPort: env.meshtasticTcpPort,
      meshtasticUseTls: false,
      baseUrl: BASE_URL,
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      backupTime,
    });
  } catch (error) {
    logger.error('❌ Error getting backup settings:', error);
    res.status(500).json({
      error: 'Failed to get backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      message: 'System backup created successfully',
    });
  } catch (error) {
    logger.error('❌ Error creating system backup:', error);
    res.status(500).json({
      error: 'Failed to create system backup',
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      gzipOptions: { level: 9 },
    });

    archive.on('error', err => {
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
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
      backupTime,
    });
  } catch (error) {
    logger.error('❌ Error getting system backup settings:', error);
    res.status(500).json({
      error: 'Failed to get system backup settings',
      details: error instanceof Error ? error.message : 'Unknown error',
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
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ==========================================
// Database Maintenance Endpoints
// ==========================================

// Get database maintenance status
apiRouter.get('/maintenance/status', requirePermission('configuration', 'read'), (_req, res) => {
  try {
    const status = databaseMaintenanceService.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('❌ Error getting maintenance status:', error);
    res.status(500).json({
      error: 'Failed to get maintenance status',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Get current database size
apiRouter.get('/maintenance/size', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const size = await databaseMaintenanceService.getDatabaseSizeAsync();
    res.json({
      size,
      formatted: databaseMaintenanceService.formatBytes(size),
    });
  } catch (error) {
    logger.error('❌ Error getting database size:', error);
    res.status(500).json({
      error: 'Failed to get database size',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Manually trigger database maintenance
apiRouter.post('/maintenance/run', requirePermission('configuration', 'write'), async (_req, res) => {
  try {
    logger.info('🔧 Manual database maintenance requested...');
    const stats = await databaseMaintenanceService.runMaintenance();
    res.json({
      success: true,
      stats,
      message: `Maintenance complete: deleted ${stats.messagesDeleted + stats.traceroutesDeleted + stats.routeSegmentsDeleted + stats.neighborInfoDeleted} records, saved ${databaseMaintenanceService.formatBytes(stats.sizeBefore - stats.sizeAfter)}`,
    });
  } catch (error) {
    logger.error('❌ Error running maintenance:', error);
    res.status(500).json({
      error: 'Failed to run maintenance',
      details: error instanceof Error ? error.message : 'Unknown error',
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
      message: `Refreshed ${nodeCount} nodes and ${channelCount} channels`,
    });
  } catch (error) {
    logger.error('❌ Failed to refresh nodes:', error);
    res.status(500).json({
      error: 'Failed to refresh node database',
      details: error instanceof Error ? error.message : 'Unknown error',
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
      message: `Refreshed ${channelCount} channels`,
    });
  } catch (error) {
    logger.error('❌ Failed to refresh channels:', error);
    res.status(500).json({
      error: 'Failed to refresh channel database',
      details: error instanceof Error ? error.message : 'Unknown error',
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
apiRouter.get('/settings/traceroute-nodes', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const settings = await databaseService.getTracerouteFilterSettingsAsync();
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to fetch auto-traceroute node filter' });
  }
});

// Update auto-traceroute node filter settings
apiRouter.post('/settings/traceroute-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const {
      enabled, nodeNums, filterChannels, filterRoles, filterHwModels, filterNameRegex,
      filterNodesEnabled, filterChannelsEnabled, filterRolesEnabled, filterHwModelsEnabled, filterRegexEnabled,
      expirationHours, sortByHops
    } = req.body;

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

    // Validate optional filter arrays
    const validateIntArray = (arr: unknown, name: string): number[] => {
      if (arr === undefined || arr === null) return [];
      if (!Array.isArray(arr)) {
        throw new Error(`Invalid ${name} value. Must be an array.`);
      }
      for (const item of arr) {
        if (!Number.isInteger(item) || item < 0) {
          throw new Error(`All ${name} values must be non-negative integers.`);
        }
      }
      return arr as number[];
    };

    let validatedChannels: number[];
    let validatedRoles: number[];
    let validatedHwModels: number[];
    try {
      validatedChannels = validateIntArray(filterChannels, 'filterChannels');
      validatedRoles = validateIntArray(filterRoles, 'filterRoles');
      validatedHwModels = validateIntArray(filterHwModels, 'filterHwModels');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate regex if provided
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      // Test that regex is valid
      try {
        new RegExp(filterNameRegex);
        validatedRegex = filterNameRegex;
      } catch {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a valid regular expression.' });
      }
    }

    // Validate individual filter enabled flags (optional booleans, default to true)
    const validateOptionalBoolean = (value: unknown, name: string): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${name} value. Must be a boolean.`);
      }
      return value;
    };

    let validatedFilterNodesEnabled: boolean | undefined;
    let validatedFilterChannelsEnabled: boolean | undefined;
    let validatedFilterRolesEnabled: boolean | undefined;
    let validatedFilterHwModelsEnabled: boolean | undefined;
    let validatedFilterRegexEnabled: boolean | undefined;
    let validatedSortByHops: boolean | undefined;
    try {
      validatedFilterNodesEnabled = validateOptionalBoolean(filterNodesEnabled, 'filterNodesEnabled');
      validatedFilterChannelsEnabled = validateOptionalBoolean(filterChannelsEnabled, 'filterChannelsEnabled');
      validatedFilterRolesEnabled = validateOptionalBoolean(filterRolesEnabled, 'filterRolesEnabled');
      validatedFilterHwModelsEnabled = validateOptionalBoolean(filterHwModelsEnabled, 'filterHwModelsEnabled');
      validatedFilterRegexEnabled = validateOptionalBoolean(filterRegexEnabled, 'filterRegexEnabled');
      validatedSortByHops = validateOptionalBoolean(sortByHops, 'sortByHops');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate expirationHours (optional, must be a positive integer between 1 and 168)
    let validatedExpirationHours: number | undefined;
    if (expirationHours !== undefined) {
      if (!Number.isInteger(expirationHours) || expirationHours < 1 || expirationHours > 168) {
        return res.status(400).json({ error: 'Invalid expirationHours value. Must be an integer between 1 and 168.' });
      }
      validatedExpirationHours = expirationHours;
    }

    // Update all settings
    await databaseService.setTracerouteFilterSettingsAsync({
      enabled,
      nodeNums,
      filterChannels: validatedChannels,
      filterRoles: validatedRoles,
      filterHwModels: validatedHwModels,
      filterNameRegex: validatedRegex,
      filterNodesEnabled: validatedFilterNodesEnabled,
      filterChannelsEnabled: validatedFilterChannelsEnabled,
      filterRolesEnabled: validatedFilterRolesEnabled,
      filterHwModelsEnabled: validatedFilterHwModelsEnabled,
      filterRegexEnabled: validatedFilterRegexEnabled,
      expirationHours: validatedExpirationHours,
      sortByHops: validatedSortByHops,
    });

    // Get the updated settings to return (includes resolved default values)
    const updatedSettings = await databaseService.getTracerouteFilterSettingsAsync();

    res.json({
      success: true,
      ...updatedSettings,
    });
  } catch (error) {
    logger.error('Error updating auto-traceroute node filter:', error);
    res.status(500).json({ error: 'Failed to update auto-traceroute node filter' });
  }
});

// Get auto-traceroute log (recent auto-traceroute attempts with success/fail status)
apiRouter.get('/settings/traceroute-log', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const log = await databaseService.getAutoTracerouteLogAsync(10);
    res.json({
      success: true,
      log,
    });
  } catch (error) {
    logger.error('Error fetching auto-traceroute log:', error);
    res.status(500).json({ error: 'Failed to fetch auto-traceroute log' });
  }
});

// Get auto time sync settings
apiRouter.get('/settings/time-sync-nodes', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const settings = await databaseService.getTimeSyncFilterSettingsAsync();
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching auto time sync settings:', error);
    res.status(500).json({ error: 'Failed to fetch auto time sync settings' });
  }
});

// Update auto time sync settings
apiRouter.post('/settings/time-sync-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { enabled, nodeNums, filterEnabled, expirationHours, intervalMinutes } = req.body;

    // Validate input
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }

    if (nodeNums !== undefined && !Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }

    // Validate all node numbers are valid integers
    if (nodeNums) {
      for (const nodeNum of nodeNums) {
        if (!Number.isInteger(nodeNum) || nodeNum < 0) {
          return res.status(400).json({ error: 'All node numbers must be positive integers.' });
        }
      }
    }

    if (filterEnabled !== undefined && typeof filterEnabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid filterEnabled value. Must be a boolean.' });
    }

    if (expirationHours !== undefined) {
      const hours = Number(expirationHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
        return res.status(400).json({ error: 'Expiration hours must be an integer between 1 and 24.' });
      }
    }

    if (intervalMinutes !== undefined) {
      const minutes = Number(intervalMinutes);
      if (!Number.isInteger(minutes) || (minutes !== 0 && (minutes < 15 || minutes > 1440))) {
        return res.status(400).json({ error: 'Interval must be 0 (disabled) or between 15 and 1440 minutes.' });
      }
    }

    // Update settings
    await databaseService.setTimeSyncFilterSettingsAsync({
      enabled,
      nodeNums,
      filterEnabled,
      expirationHours: expirationHours !== undefined ? Number(expirationHours) : undefined,
      intervalMinutes: intervalMinutes !== undefined ? Number(intervalMinutes) : undefined,
    });

    // Update the meshtastic manager interval if connected
    if (intervalMinutes !== undefined) {
      meshtasticManager.setTimeSyncInterval(enabled ? Number(intervalMinutes) : 0);
    } else if (enabled !== undefined) {
      // If only enabled/disabled changed, use existing interval
      const currentInterval = databaseService.getAutoTimeSyncIntervalMinutes();
      meshtasticManager.setTimeSyncInterval(enabled ? currentInterval : 0);
    }

    // Get the updated settings to return
    const updatedSettings = await databaseService.getTimeSyncFilterSettingsAsync();

    res.json({
      success: true,
      ...updatedSettings,
    });
  } catch (error) {
    logger.error('Error updating auto time sync settings:', error);
    res.status(500).json({ error: 'Failed to update auto time sync settings' });
  }
});

// Get auto key repair log (recent key repair attempts with success/fail status)
apiRouter.get('/settings/key-repair-log', requirePermission('settings', 'read'), (_req, res) => {
  try {
    const log = databaseService.getKeyRepairLog(50);
    res.json({
      success: true,
      log,
    });
  } catch (error) {
    logger.error('Error fetching auto key repair log:', error);
    res.status(500).json({ error: 'Failed to fetch auto key repair log' });
  }
});

// Helper functions for tile URL validation
function validateTileUrl(url: string): boolean {
  // Must contain {z}, {x}, {y} placeholders
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    return false;
  }

  // Basic URL validation - replace placeholders with test values
  try {
    const testUrl = url.replace(/{z}/g, '0').replace(/{x}/g, '0').replace(/{y}/g, '0').replace(/{s}/g, 'a');

    const parsedUrl = new URL(testUrl);

    // Only allow http and https protocols
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function validateCustomTilesets(tilesets: any[]): boolean {
  if (!Array.isArray(tilesets)) {
    return false;
  }

  for (const tileset of tilesets) {
    // Check required fields exist and have correct types
    if (
      typeof tileset.id !== 'string' ||
      typeof tileset.name !== 'string' ||
      typeof tileset.url !== 'string' ||
      typeof tileset.attribution !== 'string' ||
      typeof tileset.maxZoom !== 'number' ||
      typeof tileset.description !== 'string' ||
      typeof tileset.createdAt !== 'number' ||
      typeof tileset.updatedAt !== 'number'
    ) {
      return false;
    }

    // Validate ID format (must start with 'custom-')
    if (!tileset.id.startsWith('custom-')) {
      return false;
    }

    // Validate string lengths
    if (
      tileset.name.length > 100 ||
      tileset.url.length > 500 ||
      tileset.attribution.length > 200 ||
      tileset.description.length > 200
    ) {
      return false;
    }

    // Validate maxZoom range
    if (tileset.maxZoom < 1 || tileset.maxZoom > 22) {
      return false;
    }

    // Validate tile URL format
    if (!validateTileUrl(tileset.url)) {
      return false;
    }
  }

  return true;
}

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
    const validKeys = [
      'maxNodeAgeHours',
      'tracerouteIntervalMinutes',
      'temperatureUnit',
      'distanceUnit',
      'positionHistoryLineStyle',
      'telemetryVisualizationHours',
      'telemetryFavorites',
      'telemetryCustomOrder',
      'dashboardWidgets',
      'dashboardSolarVisibility',
      'autoAckEnabled',
      'autoAckRegex',
      'autoAckMessage',
      'autoAckMessageDirect',
      'autoAckChannels',
      'autoAckDirectMessages',
      'autoAckUseDM',
      'autoAckSkipIncompleteNodes',
      'autoAckTapbackEnabled',
      'autoAckReplyEnabled',
      'autoAckDirectEnabled',
      'autoAckDirectTapbackEnabled',
      'autoAckDirectReplyEnabled',
      'autoAckMultihopEnabled',
      'autoAckMultihopTapbackEnabled',
      'autoAckMultihopReplyEnabled',
      'autoAckTestMessages',
      'customTapbackEmojis',
      'autoAnnounceEnabled',
      'autoAnnounceIntervalHours',
      'autoAnnounceMessage',
      'autoAnnounceChannelIndex',
      'autoAnnounceOnStart',
      'autoAnnounceUseSchedule',
      'autoAnnounceSchedule',
      'autoWelcomeEnabled',
      'autoWelcomeMessage',
      'autoWelcomeTarget',
      'autoWelcomeWaitForName',
      'autoWelcomeMaxHops',
      'autoResponderEnabled',
      'autoResponderTriggers',
      'autoResponderSkipIncompleteNodes',
      'timerTriggers',
      'preferredSortField',
      'preferredSortDirection',
      'preferredDashboardSortOption',
      'timeFormat',
      'dateFormat',
      'mapTileset',
      'packet_log_enabled',
      'packet_log_max_count',
      'packet_log_max_age_hours',
      'solarMonitoringEnabled',
      'solarMonitoringLatitude',
      'solarMonitoringLongitude',
      'solarMonitoringAzimuth',
      'solarMonitoringDeclination',
      'mapPinStyle',
      'favoriteTelemetryStorageDays',
      'theme',
      'customTilesets',
      'hideIncompleteNodes',
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
      'autoUpgradeImmediate',
      'maintenanceEnabled',
      'maintenanceTime',
      'messageRetentionDays',
      'tracerouteRetentionDays',
      'routeSegmentRetentionDays',
      'neighborInfoRetentionDays',
      'autoKeyManagementEnabled',
      'autoKeyManagementIntervalMinutes',
      'autoKeyManagementMaxExchanges',
      'autoKeyManagementAutoPurge',
      'remoteAdminScannerIntervalMinutes',
      'remoteAdminScannerExpirationHours',
      'tracerouteScheduleEnabled',
      'tracerouteScheduleStart',
      'tracerouteScheduleEnd',
      'remoteAdminScheduleEnabled',
      'remoteAdminScheduleStart',
      'remoteAdminScheduleEnd',
      'geofenceTriggers',
    ];
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
      const validChannels = channelList.map(c => parseInt(c.trim())).filter(n => !isNaN(n) && n >= 0 && n < 8); // Max 8 channels in Meshtastic

      filteredSettings.autoAckChannels = validChannels.join(',');
    }

    // Validate inactive node notification settings
    if ('inactiveNodeThresholdHours' in filteredSettings) {
      const threshold = parseInt(filteredSettings.inactiveNodeThresholdHours, 10);
      if (isNaN(threshold) || threshold < 1 || threshold > 720) {
        return res.status(400).json({ error: 'inactiveNodeThresholdHours must be between 1 and 720 hours' });
      }
    }

    if ('inactiveNodeCheckIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.inactiveNodeCheckIntervalMinutes, 10);
      if (isNaN(interval) || interval < 1 || interval > 1440) {
        return res.status(400).json({ error: 'inactiveNodeCheckIntervalMinutes must be between 1 and 1440 minutes' });
      }
    }

    if ('inactiveNodeCooldownHours' in filteredSettings) {
      const cooldown = parseInt(filteredSettings.inactiveNodeCooldownHours, 10);
      if (isNaN(cooldown) || cooldown < 1 || cooldown > 720) {
        return res.status(400).json({ error: 'inactiveNodeCooldownHours must be between 1 and 720 hours' });
      }
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
            return res
              .status(400)
              .json({ error: 'Each trigger must have id, trigger, responseType, and response fields' });
          }

          // Validate trigger is string or non-empty array
          if (Array.isArray(trigger.trigger) && trigger.trigger.length === 0) {
            return res.status(400).json({ error: 'Trigger array cannot be empty' });
          }
          if (!Array.isArray(trigger.trigger) && typeof trigger.trigger !== 'string') {
            return res.status(400).json({ error: 'Trigger must be a string or array of strings' });
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

    // Validate timerTriggers JSON
    if ('timerTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.timerTriggers);

        // Validate that it's an array
        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'timerTriggers must be an array' });
        }

        // Validate each timer trigger
        for (const trigger of triggers) {
          // Basic required fields
          if (!trigger.id || !trigger.name || !trigger.cronExpression) {
            return res
              .status(400)
              .json({ error: 'Each timer trigger must have id, name, and cronExpression fields' });
          }

          // Validate response type (default to 'script' for backward compatibility)
          const responseType = trigger.responseType || 'script';
          if (responseType !== 'script' && responseType !== 'text') {
            return res.status(400).json({ error: 'responseType must be "script" or "text"' });
          }

          // Validate based on response type
          if (responseType === 'script') {
            if (!trigger.scriptPath) {
              return res.status(400).json({ error: 'Script timer triggers must have a scriptPath' });
            }
            // Validate script paths
            if (!trigger.scriptPath.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Timer script path must start with /data/scripts/' });
            }
            if (trigger.scriptPath.includes('..')) {
              return res.status(400).json({ error: 'Timer script path cannot contain ..' });
            }
            const ext = trigger.scriptPath.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res.status(400).json({ error: 'Timer script must have .js, .mjs, .py, or .sh extension' });
            }
          } else if (responseType === 'text') {
            if (!trigger.response || typeof trigger.response !== 'string' || trigger.response.trim().length === 0) {
              return res.status(400).json({ error: 'Text timer triggers must have a non-empty response message' });
            }
          }

          // Validate cron expression format (basic validation - detailed validation happens in scheduler)
          if (typeof trigger.cronExpression !== 'string' || trigger.cronExpression.trim().length === 0) {
            return res.status(400).json({ error: 'cronExpression must be a non-empty string' });
          }

          // Validate enabled is boolean
          if (trigger.enabled !== undefined && typeof trigger.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for timerTriggers' });
      }
    }

    // Validate geofenceTriggers JSON
    if ('geofenceTriggers' in filteredSettings) {
      try {
        const triggers = JSON.parse(filteredSettings.geofenceTriggers);

        if (!Array.isArray(triggers)) {
          return res.status(400).json({ error: 'geofenceTriggers must be an array' });
        }

        for (const trigger of triggers) {
          // Required fields
          if (!trigger.id || !trigger.name || !trigger.shape || !trigger.event || !trigger.responseType || trigger.channel === undefined) {
            return res.status(400).json({ error: 'Each geofence trigger must have id, name, shape, event, responseType, and channel fields' });
          }

          // Validate enabled is boolean
          if (trigger.enabled !== undefined && typeof trigger.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
          }

          // Validate shape
          if (trigger.shape.type === 'circle') {
            if (!trigger.shape.center || typeof trigger.shape.center.lat !== 'number' || typeof trigger.shape.center.lng !== 'number') {
              return res.status(400).json({ error: 'Circle geofence must have a center with lat and lng' });
            }
            if (trigger.shape.center.lat < -90 || trigger.shape.center.lat > 90) {
              return res.status(400).json({ error: 'Circle center latitude must be between -90 and 90' });
            }
            if (trigger.shape.center.lng < -180 || trigger.shape.center.lng > 180) {
              return res.status(400).json({ error: 'Circle center longitude must be between -180 and 180' });
            }
            if (typeof trigger.shape.radiusKm !== 'number' || trigger.shape.radiusKm <= 0) {
              return res.status(400).json({ error: 'Circle geofence must have a positive radiusKm' });
            }
          } else if (trigger.shape.type === 'polygon') {
            if (!Array.isArray(trigger.shape.vertices) || trigger.shape.vertices.length < 3) {
              return res.status(400).json({ error: 'Polygon geofence must have at least 3 vertices' });
            }
            for (const v of trigger.shape.vertices) {
              if (typeof v.lat !== 'number' || typeof v.lng !== 'number') {
                return res.status(400).json({ error: 'Each polygon vertex must have numeric lat and lng' });
              }
              if (v.lat < -90 || v.lat > 90 || v.lng < -180 || v.lng > 180) {
                return res.status(400).json({ error: 'Polygon vertex coordinates out of range' });
              }
            }
          } else {
            return res.status(400).json({ error: 'Shape type must be "circle" or "polygon"' });
          }

          // Validate event
          if (!['entry', 'exit', 'while_inside'].includes(trigger.event)) {
            return res.status(400).json({ error: 'event must be "entry", "exit", or "while_inside"' });
          }

          // Validate whileInsideIntervalMinutes
          if (trigger.event === 'while_inside') {
            if (typeof trigger.whileInsideIntervalMinutes !== 'number' || trigger.whileInsideIntervalMinutes < 1) {
              return res.status(400).json({ error: 'whileInsideIntervalMinutes must be >= 1 when event is "while_inside"' });
            }
          }

          // Validate responseType and response/scriptPath
          if (trigger.responseType !== 'text' && trigger.responseType !== 'script') {
            return res.status(400).json({ error: 'Geofence responseType must be "text" or "script"' });
          }

          if (trigger.responseType === 'text') {
            if (!trigger.response || typeof trigger.response !== 'string' || trigger.response.trim().length === 0) {
              return res.status(400).json({ error: 'Text geofence triggers must have a non-empty response message' });
            }
          } else if (trigger.responseType === 'script') {
            if (!trigger.scriptPath) {
              return res.status(400).json({ error: 'Script geofence triggers must have a scriptPath' });
            }
            if (!trigger.scriptPath.startsWith('/data/scripts/')) {
              return res.status(400).json({ error: 'Geofence script path must start with /data/scripts/' });
            }
            if (trigger.scriptPath.includes('..')) {
              return res.status(400).json({ error: 'Geofence script path cannot contain ..' });
            }
            const ext = trigger.scriptPath.split('.').pop()?.toLowerCase();
            if (!ext || !['js', 'mjs', 'py', 'sh'].includes(ext)) {
              return res.status(400).json({ error: 'Geofence script must have .js, .mjs, .py, or .sh extension' });
            }
          }

          // Validate channel ('dm', 'none', or number 0-7)
          if (trigger.channel !== 'dm' && trigger.channel !== 'none' && (typeof trigger.channel !== 'number' || trigger.channel < 0 || trigger.channel > 7)) {
            return res.status(400).json({ error: 'Geofence channel must be "dm", "none", or a number between 0 and 7' });
          }

          // Validate nodeFilter
          if (trigger.nodeFilter) {
            if (trigger.nodeFilter.type !== 'all' && trigger.nodeFilter.type !== 'selected') {
              return res.status(400).json({ error: 'nodeFilter type must be "all" or "selected"' });
            }
            if (trigger.nodeFilter.type === 'selected') {
              if (!Array.isArray(trigger.nodeFilter.nodeNums) || trigger.nodeFilter.nodeNums.length === 0) {
                return res.status(400).json({ error: 'Selected node filter must include at least one node number' });
              }
            }
          }
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for geofenceTriggers' });
      }
    }

    // Validate customTilesets JSON
    if ('customTilesets' in filteredSettings) {
      try {
        const tilesets = JSON.parse(filteredSettings.customTilesets);

        // Validate that it's an array
        if (!Array.isArray(tilesets)) {
          return res.status(400).json({ error: 'customTilesets must be an array' });
        }

        // Validate array length (max 50 custom tilesets)
        if (tilesets.length > 50) {
          return res.status(400).json({ error: 'Maximum 50 custom tilesets allowed' });
        }

        // Validate each tileset
        if (!validateCustomTilesets(tilesets)) {
          return res
            .status(400)
            .json({ error: 'Invalid custom tileset configuration. Check field types, lengths, and URL format.' });
        }
      } catch (error) {
        return res.status(400).json({ error: 'Invalid JSON format for customTilesets' });
      }
    }

    // Save to database
    databaseService.setSettings(filteredSettings);

    // Refresh CSP cache if custom tilesets were updated
    if ('customTilesets' in filteredSettings) {
      refreshTileHostnameCache();
      logger.debug('🗺️ Refreshed CSP tile hostname cache after customTilesets update');
    }

    // Handle auto-welcome being enabled for the first time
    if ('autoWelcomeEnabled' in filteredSettings) {
      // Check if the setting changed from disabled (not 'true') to enabled ('true')
      const wasEnabled = currentSettings['autoWelcomeEnabled'] === 'true';
      const nowEnabled = filteredSettings['autoWelcomeEnabled'] === 'true';
      
      // If changing from disabled to enabled, mark existing nodes as welcomed
      // This prevents a "thundering herd" of welcome messages when the feature is first enabled
      if (!wasEnabled && nowEnabled) {
        logger.info('👋 Auto-welcome being enabled - marking existing nodes as welcomed...');
        const markedCount = databaseService.handleAutoWelcomeEnabled();
        if (markedCount > 0) {
          logger.info(`✅ Marked ${markedCount} existing node(s) as welcomed to prevent spam`);
        }
      }
    }

    // Apply traceroute interval if changed
    if ('tracerouteIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.tracerouteIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        meshtasticManager.setTracerouteInterval(interval);
      }
    }

    // Apply remote admin scanner interval if changed
    if ('remoteAdminScannerIntervalMinutes' in filteredSettings) {
      const interval = parseInt(filteredSettings.remoteAdminScannerIntervalMinutes);
      if (!isNaN(interval) && interval >= 0 && interval <= 60) {
        meshtasticManager.setRemoteAdminScannerInterval(interval);
      }
    }

    // Apply auto key repair settings if changed
    const keyRepairSettings = [
      'autoKeyManagementEnabled',
      'autoKeyManagementIntervalMinutes',
      'autoKeyManagementMaxExchanges',
      'autoKeyManagementAutoPurge',
    ];
    const keyRepairSettingsChanged = keyRepairSettings.some(key => key in filteredSettings);
    if (keyRepairSettingsChanged) {
      meshtasticManager.setKeyRepairSettings({
        enabled: filteredSettings.autoKeyManagementEnabled === 'true' ||
          (filteredSettings.autoKeyManagementEnabled === undefined &&
           databaseService.getSetting('autoKeyManagementEnabled') === 'true'),
        intervalMinutes: parseInt(
          filteredSettings.autoKeyManagementIntervalMinutes ||
          databaseService.getSetting('autoKeyManagementIntervalMinutes') || '5'
        ),
        maxExchanges: parseInt(
          filteredSettings.autoKeyManagementMaxExchanges ||
          databaseService.getSetting('autoKeyManagementMaxExchanges') || '3'
        ),
        autoPurge: filteredSettings.autoKeyManagementAutoPurge === 'true' ||
          (filteredSettings.autoKeyManagementAutoPurge === undefined &&
           databaseService.getSetting('autoKeyManagementAutoPurge') === 'true'),
      });
      logger.info('✅ Auto key repair settings updated');
    }

    // Restart inactive node notification service if any inactive node settings changed
    const inactiveNodeSettings = [
      'inactiveNodeThresholdHours',
      'inactiveNodeCheckIntervalMinutes',
      'inactiveNodeCooldownHours',
    ];
    const inactiveNodeSettingsChanged = inactiveNodeSettings.some(key => key in filteredSettings);
    if (inactiveNodeSettingsChanged) {
      const threshold = parseInt(
        filteredSettings.inactiveNodeThresholdHours || databaseService.getSetting('inactiveNodeThresholdHours') || '24',
        10
      );
      const checkInterval = parseInt(
        filteredSettings.inactiveNodeCheckIntervalMinutes ||
          databaseService.getSetting('inactiveNodeCheckIntervalMinutes') ||
          '60',
        10
      );
      const cooldown = parseInt(
        filteredSettings.inactiveNodeCooldownHours || databaseService.getSetting('inactiveNodeCooldownHours') || '24',
        10
      );

      if (
        !isNaN(threshold) &&
        threshold > 0 &&
        !isNaN(checkInterval) &&
        checkInterval > 0 &&
        !isNaN(cooldown) &&
        cooldown > 0
      ) {
        inactiveNodeNotificationService.stop();
        inactiveNodeNotificationService.start(threshold, checkInterval, cooldown);
        logger.info(
          `✅ Inactive node notification service restarted (threshold: ${threshold}h, check: ${checkInterval}min, cooldown: ${cooldown}h)`
        );
      }
    }

    // Restart announce scheduler if announce settings changed
    const announceSettings = [
      'autoAnnounceEnabled',
      'autoAnnounceIntervalHours',
      'autoAnnounceUseSchedule',
      'autoAnnounceSchedule',
    ];
    const announceSettingsChanged = announceSettings.some(key => key in filteredSettings);
    if (announceSettingsChanged) {
      meshtasticManager.restartAnnounceScheduler();
    }

    // Restart timer scheduler if timer triggers changed
    if ('timerTriggers' in filteredSettings) {
      meshtasticManager.restartTimerScheduler();
    }

    // Restart geofence engine if geofence triggers changed
    if ('geofenceTriggers' in filteredSettings) {
      meshtasticManager.restartGeofenceEngine();
    }

    // Audit log with before/after values
    const changedSettings: Record<string, { before: string | undefined; after: string }> = {};
    Object.keys(filteredSettings).forEach(key => {
      if (currentSettings[key] !== filteredSettings[key]) {
        changedSettings[key] = {
          before: currentSettings[key],
          after: filteredSettings[key],
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

// Mark all nodes as welcomed (for auto-welcome feature)
apiRouter.post('/settings/mark-all-welcomed', requirePermission('settings', 'write'), (req, res) => {
  try {
    const count = databaseService.markAllNodesAsWelcomed();
    logger.info(`👋 Manually marked ${count} nodes as welcomed via API`);

    // Audit log
    databaseService.auditLog(
      req.user!.id,
      'mark_all_welcomed',
      'nodes',
      `Marked ${count} nodes as welcomed`,
      req.ip || null,
      null,
      JSON.stringify({ count })
    );

    res.json({ success: true, count, message: `Marked ${count} nodes as welcomed` });
  } catch (error) {
    logger.error('Error marking all nodes as welcomed:', error);
    res.status(500).json({ error: 'Failed to mark nodes as welcomed' });
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

// User Map Preferences endpoints

// Get user's map preferences
apiRouter.get('/user/map-preferences', optionalAuth(), (req, res) => {
  try {
    // For PostgreSQL/MySQL, map preferences not yet implemented
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      return res.json({ preferences: null });
    }

    // Anonymous users get null (will fall back to defaults in frontend)
    if (!req.user || req.user.username === 'anonymous') {
      return res.json({ preferences: null });
    }

    const preferences = databaseService.userModel.getMapPreferences(req.user.id);
    res.json({ preferences });
  } catch (error) {
    logger.error('Error fetching user map preferences:', error);
    res.status(500).json({ error: 'Failed to fetch map preferences' });
  }
});

// Save user's map preferences
apiRouter.post('/user/map-preferences', requireAuth(), (req, res) => {
  try {
    // For PostgreSQL/MySQL, map preferences not yet implemented
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      return res.json({ success: true, message: 'Map preferences not yet implemented for PostgreSQL' });
    }

    // Prevent saving preferences for anonymous user
    if (req.user!.username === 'anonymous') {
      return res.status(403).json({ error: 'Cannot save preferences for anonymous user' });
    }

    const { mapTileset, showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showAnimations, positionHistoryHours } = req.body;

    // Validate boolean values
    const booleanFields = { showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showAnimations };
    for (const [key, value] of Object.entries(booleanFields)) {
      if (value !== undefined && typeof value !== 'boolean') {
        return res.status(400).json({ error: `${key} must be a boolean` });
      }
    }

    // Validate mapTileset (optional string)
    if (mapTileset !== undefined && mapTileset !== null && typeof mapTileset !== 'string') {
      return res.status(400).json({ error: 'mapTileset must be a string or null' });
    }

    // Validate positionHistoryHours (optional number or null)
    if (positionHistoryHours !== undefined && positionHistoryHours !== null && typeof positionHistoryHours !== 'number') {
      return res.status(400).json({ error: 'positionHistoryHours must be a number or null' });
    }

    // Save preferences
    databaseService.userModel.saveMapPreferences(req.user!.id, {
      mapTileset,
      showPaths,
      showNeighborInfo,
      showRoute,
      showMotion,
      showMqttNodes,
      showAnimations,
      positionHistoryHours,
    });

    res.json({ success: true, message: 'Map preferences saved successfully' });
  } catch (error) {
    logger.error('Error saving user map preferences:', error);
    res.status(500).json({ error: 'Failed to save map preferences' });
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
      return res
        .status(400)
        .json({ error: 'Slug must start with "custom-" and contain only lowercase letters, numbers, and hyphens' });
    }

    // Check if theme already exists
    const existingTheme = databaseService.getCustomThemeBySlug(slug);
    if (existingTheme) {
      return res.status(409).json({ error: 'Theme with this slug already exists' });
    }

    // Validate theme definition
    if (!databaseService.validateThemeDefinition(definition)) {
      return res
        .status(400)
        .json({ error: 'Invalid theme definition. All 26 color variables must be valid hex codes' });
    }

    // Create the theme
    const theme = databaseService.createCustomTheme(name, slug, definition, req.user!.id);

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
        return res
          .status(400)
          .json({ error: 'Invalid theme definition. All 26 color variables must be valid hex codes' });
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

apiRouter.post('/config/network', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setNetworkConfig(config);
    res.json({ success: true, message: 'Network configuration sent' });
  } catch (error) {
    logger.error('Error setting network config:', error);
    res.status(500).json({ error: 'Failed to set network configuration' });
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
      txEnabled: true,
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

apiRouter.post('/config/power', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setPowerConfig(config);
    res.json({ success: true, message: 'Power configuration sent' });
  } catch (error) {
    logger.error('Error setting power config:', error);
    res.status(500).json({ error: 'Failed to set power configuration' });
  }
});

apiRouter.post('/config/display', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setDisplayConfig(config);
    res.json({ success: true, message: 'Display configuration sent' });
  } catch (error) {
    logger.error('Error setting display config:', error);
    res.status(500).json({ error: 'Failed to set display configuration' });
  }
});

apiRouter.post('/config/module/telemetry', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const config = req.body;
    await meshtasticManager.setTelemetryConfig(config);
    res.json({ success: true, message: 'Telemetry configuration sent' });
  } catch (error) {
    logger.error('Error setting telemetry config:', error);
    res.status(500).json({ error: 'Failed to set telemetry configuration' });
  }
});

// Generic module config endpoint - handles extnotif, storeforward, rangetest, cannedmsg, audio,
// remotehardware, detectionsensor, paxcounter, serial, ambientlighting
apiRouter.post('/config/module/:moduleType', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { moduleType } = req.params;
    const config = req.body;

    // Validate moduleType
    const validModuleTypes = ['extnotif', 'storeforward', 'rangetest', 'cannedmsg', 'audio',
      'remotehardware', 'detectionsensor', 'paxcounter', 'serial', 'ambientlighting'];
    if (!validModuleTypes.includes(moduleType)) {
      res.status(400).json({ error: `Invalid module type: ${moduleType}` });
      return;
    }

    await meshtasticManager.setGenericModuleConfig(moduleType, config);
    res.json({ success: true, message: `${moduleType} configuration sent` });
  } catch (error) {
    logger.error(`Error setting ${req.params.moduleType} config:`, error);
    res.status(500).json({ error: `Failed to set ${req.params.moduleType} configuration` });
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

// Admin commands endpoint - requires admin role
// Admin load config endpoint - requires admin role
apiRouter.post('/admin/load-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, configType, channelIndex } = req.body;

    if (!configType) {
      return res.status(400).json({ error: 'configType is required' });
    }

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    let config: any = null;

    try {
      if (isLocalNode) {
        // Local node - use existing config or request it
        let currentConfig = meshtasticManager.getCurrentConfig();
        
        // Map config types to their numeric values (same as remote node mapping)
        const configTypeMap: { [key: string]: { type: number; isModule: boolean } } = {
          'device': { type: 0, isModule: false },  // DEVICE_CONFIG
          'position': { type: 1, isModule: false }, // POSITION_CONFIG
          'network': { type: 3, isModule: false },  // NETWORK_CONFIG
          'lora': { type: 5, isModule: false },      // LORA_CONFIG
          'bluetooth': { type: 6, isModule: false }, // BLUETOOTH_CONFIG
          'security': { type: 7, isModule: false },  // SECURITY_CONFIG
          'mqtt': { type: 0, isModule: true },        // MQTT_CONFIG (module)
          'telemetry': { type: 5, isModule: true },  // TELEMETRY_CONFIG (module)
          'neighborinfo': { type: 9, isModule: true } // NEIGHBORINFO_CONFIG (module)
        };

        const configInfo = configTypeMap[configType];
        if (!configInfo && configType !== 'channel') {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Check if we need to request the specific config type
        let needsRequest = false;
        if (configInfo) {
          if (configInfo.isModule) {
            // Module configs
            const moduleConfigMap: { [key: string]: string } = {
              'mqtt': 'mqtt',
              'serial': 'serial',
              'extnotif': 'externalNotification',
              'storeforward': 'storeForward',
              'rangetest': 'rangeTest',
              'telemetry': 'telemetry',
              'cannedmsg': 'cannedMessage',
              'audio': 'audio',
              'remotehardware': 'remoteHardware',
              'neighborinfo': 'neighborInfo',
              'ambientlighting': 'ambientLighting',
              'detectionsensor': 'detectionSensor',
              'paxcounter': 'paxcounter',
              'statusmessage': 'statusmessage'
            };
            const moduleKey = moduleConfigMap[configType];
            if (moduleKey && !currentConfig?.moduleConfig?.[moduleKey]) needsRequest = true;
          } else {
            // Device configs
            const deviceConfigMap: { [key: string]: string } = {
              'device': 'device',
              'position': 'position',
              'power': 'power',
              'network': 'network',
              'display': 'display',
              'lora': 'lora',
              'bluetooth': 'bluetooth',
              'security': 'security',
              'sessionkey': 'sessionkey',
              'deviceui': 'deviceui'
            };
            const deviceKey = deviceConfigMap[configType];
            if (deviceKey && !currentConfig?.deviceConfig?.[deviceKey]) needsRequest = true;
          }
        }
        
        if (needsRequest && configInfo) {
          // Try to request the specific config type
          logger.info(`Config type '${configType}' not available, requesting from device...`);
          try {
            if (configInfo.isModule) {
              await meshtasticManager.requestModuleConfig(configInfo.type);
            } else {
              await meshtasticManager.requestConfig(configInfo.type);
            }
            // Wait a bit for response
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            logger.warn(`Failed to request ${configType} config:`, error);
          }
          
          // Check again
          const retryConfig = meshtasticManager.getCurrentConfig();
          if (!retryConfig) {
            return res.status(404).json({ error: `Device configuration not yet loaded. Please ensure the device is connected and try again in a few seconds.` });
          }
          // Use the retried config
          currentConfig = retryConfig;
        }
        
        const finalConfig = currentConfig;
        
        switch (configType) {
          case 'device':
            if (finalConfig.deviceConfig?.device) {
              config = {
                role: finalConfig.deviceConfig.device.role,
                nodeInfoBroadcastSecs: finalConfig.deviceConfig.device.nodeInfoBroadcastSecs
              };
            } else {
              return res.status(404).json({ error: 'Device config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'lora':
            if (finalConfig.deviceConfig?.lora) {
              config = {
                usePreset: finalConfig.deviceConfig.lora.usePreset,
                modemPreset: finalConfig.deviceConfig.lora.modemPreset,
                bandwidth: finalConfig.deviceConfig.lora.bandwidth,
                spreadFactor: finalConfig.deviceConfig.lora.spreadFactor,
                codingRate: finalConfig.deviceConfig.lora.codingRate,
                frequencyOffset: finalConfig.deviceConfig.lora.frequencyOffset,
                overrideFrequency: finalConfig.deviceConfig.lora.overrideFrequency,
                region: finalConfig.deviceConfig.lora.region,
                hopLimit: finalConfig.deviceConfig.lora.hopLimit,
                txPower: finalConfig.deviceConfig.lora.txPower,
                channelNum: finalConfig.deviceConfig.lora.channelNum,
                sx126xRxBoostedGain: finalConfig.deviceConfig.lora.sx126xRxBoostedGain,
                ignoreMqtt: finalConfig.deviceConfig.lora.ignoreMqtt,
                configOkToMqtt: finalConfig.deviceConfig.lora.configOkToMqtt
              };
            } else {
              return res.status(404).json({ error: 'LoRa config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'position':
            if (finalConfig.deviceConfig?.position) {
              config = {
                positionBroadcastSecs: finalConfig.deviceConfig.position.positionBroadcastSecs,
                positionBroadcastSmartEnabled: finalConfig.deviceConfig.position.positionBroadcastSmartEnabled,
                fixedPosition: finalConfig.deviceConfig.position.fixedPosition,
                fixedAltitude: finalConfig.deviceConfig.position.fixedAltitude,
                gpsUpdateInterval: finalConfig.deviceConfig.position.gpsUpdateInterval,
                positionFlags: finalConfig.deviceConfig.position.positionFlags,
                rxGpio: finalConfig.deviceConfig.position.rxGpio,
                txGpio: finalConfig.deviceConfig.position.txGpio,
                broadcastSmartMinimumDistance: finalConfig.deviceConfig.position.broadcastSmartMinimumDistance,
                broadcastSmartMinimumIntervalSecs: finalConfig.deviceConfig.position.broadcastSmartMinimumIntervalSecs,
                gpsEnGpio: finalConfig.deviceConfig.position.gpsEnGpio,
                gpsMode: finalConfig.deviceConfig.position.gpsMode,
                // Fixed lat/lng are not in PositionConfig protobuf - they're stored as the node's position
                // When fixedPosition is true, fetch from database
                fixedLatitude: 0,
                fixedLongitude: 0
              };
              // If fixedPosition is enabled, get the coordinates from the node's stored position
              if (finalConfig.deviceConfig.position.fixedPosition && localNodeNum) {
                const nodeData = databaseService.getNode(localNodeNum);
                if (nodeData?.latitude && nodeData?.longitude) {
                  config.fixedLatitude = nodeData.latitude;
                  config.fixedLongitude = nodeData.longitude;
                }
                if (nodeData?.altitude) {
                  config.fixedAltitude = nodeData.altitude;
                }
              }
            } else {
              return res.status(404).json({ error: 'Position config not available. The device may not have sent its configuration yet.' });
            }
            break;
          case 'mqtt':
            if (finalConfig.moduleConfig?.mqtt) {
              config = {
                enabled: finalConfig.moduleConfig.mqtt.enabled || false,
                address: finalConfig.moduleConfig.mqtt.address || '',
                username: finalConfig.moduleConfig.mqtt.username || '',
                password: finalConfig.moduleConfig.mqtt.password || '',
                encryptionEnabled: finalConfig.moduleConfig.mqtt.encryptionEnabled !== false,
                jsonEnabled: finalConfig.moduleConfig.mqtt.jsonEnabled || false,
                root: finalConfig.moduleConfig.mqtt.root || ''
              };
            } else {
              // MQTT config might not exist if it's not configured, return empty config
              config = {
                enabled: false,
                address: '',
                username: '',
                password: '',
                encryptionEnabled: true,
                jsonEnabled: false,
                root: ''
              };
            }
            break;
          case 'security':
            if (finalConfig.deviceConfig?.security) {
              // Convert admin keys from Uint8Array to base64 strings for UI
              const localAdminKeys = finalConfig.deviceConfig.security.adminKey || [];
              config = {
                adminKeys: localAdminKeys.map((key: any) => {
                  if (key instanceof Uint8Array || Buffer.isBuffer(key)) {
                    return Buffer.from(key).toString('base64');
                  }
                  // Handle JSON-serialized Buffer objects (e.g., { type: 'Buffer', data: [...] })
                  if (key && typeof key === 'object' && key.type === 'Buffer' && Array.isArray(key.data)) {
                    return Buffer.from(key.data).toString('base64');
                  }
                  // Handle array of bytes
                  if (Array.isArray(key)) {
                    return Buffer.from(key).toString('base64');
                  }
                  // Already a string (base64)
                  if (typeof key === 'string') {
                    return key;
                  }
                  // Fallback - try to convert
                  logger.warn('Unknown admin key format:', typeof key, key);
                  return String(key);
                }),
                isManaged: finalConfig.deviceConfig.security.isManaged,
                serialEnabled: finalConfig.deviceConfig.security.serialEnabled,
                debugLogApiEnabled: finalConfig.deviceConfig.security.debugLogApiEnabled,
                adminChannelEnabled: finalConfig.deviceConfig.security.adminChannelEnabled
              };
            } else {
              return res.status(404).json({ error: 'Security config not available. The device may not have sent its configuration yet.' });
            }
            break;
          // Additional device configs - return raw config for now
          case 'power':
          case 'network':
          case 'display':
          case 'bluetooth':
          case 'sessionkey':
          case 'deviceui':
            const deviceConfigKey = configType === 'sessionkey' ? 'sessionkey' : configType;
            if (finalConfig.deviceConfig?.[deviceConfigKey]) {
              config = finalConfig.deviceConfig[deviceConfigKey];
            } else {
              return res.status(404).json({ error: `${configType} config not available. The device may not have sent its configuration yet.` });
            }
            break;
          // Additional module configs - return raw config for now
          case 'serial':
          case 'extnotif':
          case 'storeforward':
          case 'rangetest':
          case 'telemetry':
          case 'cannedmsg':
          case 'audio':
          case 'remotehardware':
          case 'neighborinfo':
          case 'ambientlighting':
          case 'detectionsensor':
          case 'paxcounter':
          case 'statusmessage':
            const moduleConfigMap: { [key: string]: string } = {
              'serial': 'serial',
              'extnotif': 'externalNotification',
              'storeforward': 'storeForward',
              'rangetest': 'rangeTest',
              'telemetry': 'telemetry',
              'cannedmsg': 'cannedMessage',
              'audio': 'audio',
              'remotehardware': 'remoteHardware',
              'neighborinfo': 'neighborInfo',
              'ambientlighting': 'ambientLighting',
              'detectionsensor': 'detectionSensor',
              'paxcounter': 'paxcounter',
              'statusmessage': 'statusmessage'
            };
            const moduleKey = moduleConfigMap[configType];
            if (moduleKey && finalConfig.moduleConfig?.[moduleKey]) {
              config = finalConfig.moduleConfig[moduleKey];
            } else {
              // Module configs might not exist if not configured, return empty/default config
              config = { enabled: false };
            }
            break;
        }
      } else {
        // Remote node - request config with session passkey
        logger.info(`Requesting ${configType} config from remote node ${destinationNodeNum}`);
        
        // Map config types to their numeric values (same as local node mapping)
        const configTypeMap: { [key: string]: { type: number; isModule: boolean } } = {
          'device': { type: 0, isModule: false },  // DEVICE_CONFIG
          'position': { type: 1, isModule: false }, // POSITION_CONFIG
          'power': { type: 2, isModule: false },    // POWER_CONFIG
          'network': { type: 3, isModule: false },  // NETWORK_CONFIG
          'display': { type: 4, isModule: false },  // DISPLAY_CONFIG
          'lora': { type: 5, isModule: false },     // LORA_CONFIG
          'bluetooth': { type: 6, isModule: false }, // BLUETOOTH_CONFIG
          'security': { type: 7, isModule: false }, // SECURITY_CONFIG
          'sessionkey': { type: 8, isModule: false }, // SESSIONKEY_CONFIG
          'deviceui': { type: 9, isModule: false }, // DEVICEUI_CONFIG
          'mqtt': { type: 0, isModule: true },      // MQTT_CONFIG (module)
          'serial': { type: 1, isModule: true },    // SERIAL_CONFIG (module)
          'extnotif': { type: 2, isModule: true },  // EXTNOTIF_CONFIG (module)
          'storeforward': { type: 3, isModule: true }, // STOREFORWARD_CONFIG (module)
          'rangetest': { type: 4, isModule: true },  // RANGETEST_CONFIG (module)
          'telemetry': { type: 5, isModule: true }, // TELEMETRY_CONFIG (module)
          'cannedmsg': { type: 6, isModule: true }, // CANNEDMSG_CONFIG (module)
          'audio': { type: 7, isModule: true },     // AUDIO_CONFIG (module)
          'remotehardware': { type: 8, isModule: true }, // REMOTEHARDWARE_CONFIG (module)
          'neighborinfo': { type: 9, isModule: true }, // NEIGHBORINFO_CONFIG (module)
          'ambientlighting': { type: 10, isModule: true }, // AMBIENTLIGHTING_CONFIG (module)
          'detectionsensor': { type: 11, isModule: true }, // DETECTIONSENSOR_CONFIG (module)
          'paxcounter': { type: 12, isModule: true }, // PAXCOUNTER_CONFIG (module)
          'statusmessage': { type: 13, isModule: true } // STATUSMESSAGE_CONFIG (module)
        };

        const configInfo = configTypeMap[configType];
        if (!configInfo) {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Request config from remote node
        const remoteConfig = await meshtasticManager.requestRemoteConfig(
          destinationNodeNum,
          configInfo.type,
          configInfo.isModule
        );

        if (!remoteConfig) {
          return res.status(404).json({ error: `Config type '${configType}' not received from remote node ${destinationNodeNum}. The node may not be reachable or may not have responded.` });
        }

        // Format the response based on config type
        switch (configType) {
          case 'device':
            config = {
              role: remoteConfig.role,
              nodeInfoBroadcastSecs: remoteConfig.nodeInfoBroadcastSecs
            };
            break;
          case 'lora':
            config = {
              usePreset: remoteConfig.usePreset,
              modemPreset: remoteConfig.modemPreset,
              bandwidth: remoteConfig.bandwidth,
              spreadFactor: remoteConfig.spreadFactor,
              codingRate: remoteConfig.codingRate,
              frequencyOffset: remoteConfig.frequencyOffset,
              overrideFrequency: remoteConfig.overrideFrequency,
              region: remoteConfig.region,
              hopLimit: remoteConfig.hopLimit,
              txPower: remoteConfig.txPower,
              channelNum: remoteConfig.channelNum,
              sx126xRxBoostedGain: remoteConfig.sx126xRxBoostedGain,
              ignoreMqtt: remoteConfig.ignoreMqtt,
              configOkToMqtt: remoteConfig.configOkToMqtt
            };
            break;
          case 'position':
            config = {
              positionBroadcastSecs: remoteConfig.positionBroadcastSecs,
              positionBroadcastSmartEnabled: remoteConfig.positionBroadcastSmartEnabled,
              fixedPosition: remoteConfig.fixedPosition,
              fixedAltitude: remoteConfig.fixedAltitude,
              gpsUpdateInterval: remoteConfig.gpsUpdateInterval,
              positionFlags: remoteConfig.positionFlags,
              rxGpio: remoteConfig.rxGpio,
              txGpio: remoteConfig.txGpio,
              broadcastSmartMinimumDistance: remoteConfig.broadcastSmartMinimumDistance,
              broadcastSmartMinimumIntervalSecs: remoteConfig.broadcastSmartMinimumIntervalSecs,
              gpsEnGpio: remoteConfig.gpsEnGpio,
              gpsMode: remoteConfig.gpsMode,
              // Fixed lat/lng are not in PositionConfig protobuf - they're stored as the node's position
              fixedLatitude: 0,
              fixedLongitude: 0
            };
            // If fixedPosition is enabled, get the coordinates from the node's stored position
            if (remoteConfig.fixedPosition) {
              const nodeData = databaseService.getNode(destinationNodeNum);
              if (nodeData?.latitude && nodeData?.longitude) {
                config.fixedLatitude = nodeData.latitude;
                config.fixedLongitude = nodeData.longitude;
              }
              if (nodeData?.altitude) {
                config.fixedAltitude = nodeData.altitude;
              }
            }
            break;
          case 'mqtt':
            config = {
              enabled: remoteConfig.enabled || false,
              address: remoteConfig.address || '',
              username: remoteConfig.username || '',
              password: remoteConfig.password || '',
              encryptionEnabled: remoteConfig.encryptionEnabled !== false,
              jsonEnabled: remoteConfig.jsonEnabled || false,
              root: remoteConfig.root || ''
            };
            break;
          case 'security':
            // Convert admin keys from Uint8Array to base64 strings for UI
            const remoteAdminKeys = remoteConfig.adminKey || [];
            config = {
              adminKeys: remoteAdminKeys.map((key: any) => {
                if (key instanceof Uint8Array || Buffer.isBuffer(key)) {
                  return Buffer.from(key).toString('base64');
                }
                // Handle JSON-serialized Buffer objects (e.g., { type: 'Buffer', data: [...] })
                if (key && typeof key === 'object' && key.type === 'Buffer' && Array.isArray(key.data)) {
                  return Buffer.from(key.data).toString('base64');
                }
                // Handle array of bytes
                if (Array.isArray(key)) {
                  return Buffer.from(key).toString('base64');
                }
                // Already a string (base64)
                if (typeof key === 'string') {
                  return key;
                }
                // Fallback - try to convert
                logger.warn('Unknown admin key format:', typeof key, key);
                return String(key);
              }),
              isManaged: remoteConfig.isManaged,
              serialEnabled: remoteConfig.serialEnabled,
              debugLogApiEnabled: remoteConfig.debugLogApiEnabled,
              adminChannelEnabled: remoteConfig.adminChannelEnabled
            };
            break;
          // Additional device configs - return raw config
          case 'power':
          case 'network':
          case 'display':
          case 'bluetooth':
          case 'sessionkey':
          case 'deviceui':
            config = remoteConfig;
            break;
          // Additional module configs - return raw config
          case 'serial':
          case 'extnotif':
          case 'storeforward':
          case 'rangetest':
          case 'telemetry':
          case 'cannedmsg':
          case 'audio':
          case 'remotehardware':
          case 'neighborinfo':
          case 'ambientlighting':
          case 'detectionsensor':
          case 'paxcounter':
            config = remoteConfig || { enabled: false };
            break;
        }
      }

      // Handle channel config (works for both local and remote)
      if (configType === 'channel') {
        if (channelIndex === undefined) {
          return res.status(400).json({ error: 'channelIndex is required for channel config' });
        }
        if (isLocalNode) {
          // Request channel config
          await meshtasticManager.requestConfig(0); // CHANNEL_CONFIG = 0
          // Note: Channel config loading requires waiting for response, which is complex
          // For now, return a placeholder
          config = {
            name: '',
            psk: '',
            role: channelIndex === 0 ? 1 : 0,
            uplinkEnabled: false,
            downlinkEnabled: false,
            positionPrecision: 32
          };
        } else {
          // Remote node channel config not yet supported
          return res.status(501).json({ error: 'Channel config loading from remote nodes is not yet supported' });
        }
      }

      if (!config && configType !== 'channel') {
        return res.status(400).json({ error: `Unknown config type: ${configType}` });
      }

      res.json({ config });
    } catch (error: any) {
      logger.error(`Error loading ${configType} config:`, error);
      res.status(500).json({ error: `Failed to load ${configType} config: ${error.message}` });
    }
  } catch (error: any) {
    logger.error('Error in load-config endpoint:', error);
    res.status(500).json({ error: error.message || 'Failed to load config' });
  }
});

// Admin ensure session passkey endpoint - requires admin role
// This ensures we have a valid session passkey before making multiple requests
apiRouter.post('/admin/ensure-session-passkey', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // Local node doesn't need session passkey
      return res.json({ success: true, message: 'Local node does not require session passkey' });
    }

    // Check if we already have a valid session passkey
    let sessionPasskey = meshtasticManager.getSessionPasskey(destinationNodeNum);
    if (!sessionPasskey) {
      logger.debug(`Requesting session passkey for remote node ${destinationNodeNum}`);
      sessionPasskey = await meshtasticManager.requestRemoteSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        return res.status(500).json({ error: `Failed to obtain session passkey for remote node ${destinationNodeNum}` });
      }
    }

    // Return status with expiry info
    const status = meshtasticManager.getSessionPasskeyStatus(destinationNodeNum);
    return res.json({
      success: true,
      message: 'Session passkey available',
      ...status
    });
  } catch (error: any) {
    logger.error('Error ensuring session passkey:', error);
    res.status(500).json({ error: error.message || 'Failed to ensure session passkey' });
  }
});

// Admin get session passkey status - requires admin role
// This just checks the status without triggering a new request
apiRouter.post('/admin/session-passkey-status', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      return res.json({
        success: true,
        isLocalNode: true,
        hasPasskey: true,
        expiresAt: null,
        remainingSeconds: null
      });
    }

    const status = meshtasticManager.getSessionPasskeyStatus(destinationNodeNum);
    return res.json({ success: true, isLocalNode: false, ...status });
  } catch (error: any) {
    logger.error('Error getting session passkey status:', error);
    res.status(500).json({ error: error.message || 'Failed to get session passkey status' });
  }
});

// Admin get channel endpoint - requires admin role
apiRouter.post('/admin/get-channel', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, channelIndex } = req.body;

    if (channelIndex === undefined) {
      return res.status(400).json({ error: 'channelIndex is required' });
    }

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, get from database
      const channel = databaseService.getChannelById(channelIndex);
      if (channel) {
        return res.json({ channel: {
          name: channel.name || '',
          psk: channel.psk || '',
          role: channel.role !== undefined ? channel.role : (channelIndex === 0 ? 1 : 0),
          uplinkEnabled: channel.uplinkEnabled !== undefined ? channel.uplinkEnabled : false,
          downlinkEnabled: channel.downlinkEnabled !== undefined ? channel.downlinkEnabled : false,
          positionPrecision: channel.positionPrecision !== undefined ? channel.positionPrecision : 32
        }});
      } else {
        return res.json({ channel: {
          name: '',
          psk: '',
          role: channelIndex === 0 ? 1 : 0,
          uplinkEnabled: false,
          downlinkEnabled: false,
          positionPrecision: 32
        }});
      }
    } else {
      // For remote node, request channel
      const channel = await meshtasticManager.requestRemoteChannel(destinationNodeNum, channelIndex);
      if (channel) {
        // Convert channel response to our format
        // Protobuf may use snake_case or camelCase depending on how it's decoded
        const settings = channel.settings || {};
        
        // Handle both camelCase and snake_case field names
        const name = settings.name || '';
        const psk = settings.psk;
        const pskString = psk ? (Buffer.isBuffer(psk) ? Buffer.from(psk).toString('base64') : (typeof psk === 'string' ? psk : Buffer.from(psk).toString('base64'))) : '';
        
        // Handle both camelCase and snake_case for boolean fields
        const uplinkEnabled = settings.uplinkEnabled !== undefined ? settings.uplinkEnabled : 
                             (settings.uplink_enabled !== undefined ? settings.uplink_enabled : true);
        const downlinkEnabled = settings.downlinkEnabled !== undefined ? settings.downlinkEnabled : 
                               (settings.downlink_enabled !== undefined ? settings.downlink_enabled : true);
        
        // Handle module settings (may be moduleSettings or module_settings)
        const moduleSettings = settings.moduleSettings || settings.module_settings || {};
        const positionPrecision = moduleSettings.positionPrecision !== undefined ? moduleSettings.positionPrecision :
                                 (moduleSettings.position_precision !== undefined ? moduleSettings.position_precision : 32);
        
        logger.debug(`📡 Converting channel ${channelIndex} from remote node ${destinationNodeNum}`, {
          name,
          hasPsk: !!psk,
          role: channel.role,
          uplinkEnabled,
          downlinkEnabled,
          positionPrecision,
          settingsKeys: Object.keys(settings),
          moduleSettingsKeys: Object.keys(moduleSettings)
        });
        
        return res.json({ channel: {
          name: name,
          psk: pskString,
          role: channel.role !== undefined ? channel.role : (channelIndex === 0 ? 1 : 0),
          uplinkEnabled: uplinkEnabled,
          downlinkEnabled: downlinkEnabled,
          positionPrecision: positionPrecision
        }});
      } else {
        // Channel not received - could be timeout, doesn't exist, or not configured
        // Return 404 but with a more descriptive message
        logger.debug(`⚠️ Channel ${channelIndex} not received from remote node ${destinationNodeNum} (timeout or not configured)`);
        return res.status(404).json({ error: `Channel ${channelIndex} not received from remote node ${destinationNodeNum}. The channel may not exist, may be disabled, or the request timed out.` });
      }
    }
  } catch (error: any) {
    logger.error('Error getting channel:', error);
    res.status(500).json({ error: error.message || 'Failed to get channel' });
  }
});

// Admin load owner endpoint - requires admin role
apiRouter.post('/admin/load-owner', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, use cached info and database (public key is obtained from security config at connection)
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get the public key from database if available (stored from security config)
        let publicKeyBase64: string | undefined;
        if (localNodeInfo.nodeNum) {
          const nodeData = databaseService.getNode(localNodeInfo.nodeNum);
          publicKeyBase64 = nodeData?.publicKey || undefined;
        }
        return res.json({ owner: {
          longName: localNodeInfo.longName || '' ,
          shortName: localNodeInfo.shortName || '' ,
          isUnmessagable: false,
          publicKey: publicKeyBase64
        }});
      } else {
        return res.status(404).json({ error: 'Local node information not available' });
      }
    } else {
      // For remote node, request owner info
      const owner = await meshtasticManager.requestRemoteOwner(destinationNodeNum);
      if (owner) {
        return res.json({ owner: {
          longName: owner.longName || '' ,
          shortName: owner.shortName || '' ,
          isUnmessagable: owner.isUnmessagable || false
        }});
      } else {
        return res.status(404).json({ error: `Owner info not received from remote node ${destinationNodeNum}` });
      }
    }
  } catch (error: any) {
    logger.error('Error getting owner:', error);
    res.status(500).json({ error: error.message || 'Failed to get owner info' });
  }
});

// Admin get device metadata endpoint - requires admin role
apiRouter.post('/admin/get-device-metadata', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, return cached device metadata from local node info
      const localNodeInfo = meshtasticManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get node data from database for additional info
        const nodeData = localNodeInfo.nodeNum ? databaseService.getNode(localNodeInfo.nodeNum) : null;
        return res.json({
          deviceMetadata: {
            firmwareVersion: localNodeInfo.firmwareVersion || 'Unknown',
            hwModel: nodeData?.hwModel || 0,
            role: nodeData?.role || 0,
            hasWifi: false,  // Not tracked for local node
            hasBluetooth: false,
            hasEthernet: false,
            canShutdown: false,
            hasRemoteHardware: false,
            deviceStateVersion: 0,
            positionFlags: 0
          }
        });
      } else {
        return res.status(404).json({ error: 'Local node information not available' });
      }
    } else {
      // For remote node, request device metadata
      const metadata = await meshtasticManager.requestRemoteDeviceMetadata(destinationNodeNum);
      if (metadata) {
        // Successfully retrieved metadata - update hasRemoteAdmin flag and save metadata
        try {
          await databaseService.updateNodeRemoteAdminStatusAsync(
            destinationNodeNum,
            true,
            JSON.stringify(metadata)
          );
          logger.info(`✅ Updated hasRemoteAdmin=true and saved metadata for node ${destinationNodeNum}`);
        } catch (dbError) {
          logger.error(`Failed to save remote admin status for node ${destinationNodeNum}:`, dbError);
          // Continue with response even if database update fails
        }

        return res.json({
          deviceMetadata: {
            firmwareVersion: metadata.firmwareVersion || 'Unknown',
            deviceStateVersion: metadata.deviceStateVersion || 0,
            canShutdown: metadata.canShutdown || false,
            hasWifi: metadata.hasWifi || false,
            hasBluetooth: metadata.hasBluetooth || false,
            hasEthernet: metadata.hasEthernet || false,
            role: metadata.role || 0,
            positionFlags: metadata.positionFlags || 0,
            hwModel: metadata.hwModel || 0,
            hasRemoteHardware: metadata.hasRemoteHardware || false
          }
        });
      } else {
        return res.status(404).json({ error: `Device metadata not received from remote node ${destinationNodeNum}` });
      }
    }
  } catch (error: any) {
    logger.error('Error getting device metadata:', error);
    res.status(500).json({ error: error.message || 'Failed to get device metadata' });
  }
});

// Admin reboot endpoint - sends reboot command to a node
apiRouter.post('/admin/reboot', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, seconds = 5 } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);

    await meshtasticManager.sendRebootCommand(destinationNodeNum, Number(seconds));

    logger.info(`✅ Sent reboot command to node ${destinationNodeNum} (in ${seconds} seconds)`);
    res.json({ success: true, message: `Reboot command sent (node will reboot in ${seconds} seconds)` });
  } catch (error: any) {
    logger.error('Error sending reboot command:', error);
    res.status(500).json({ error: error.message || 'Failed to send reboot command' });
  }
});

// Admin set-time endpoint - sets time on a node to current server time
apiRouter.post('/admin/set-time', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum } = req.body;

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);

    await meshtasticManager.sendSetTimeCommand(destinationNodeNum);

    logger.info(`✅ Sent set-time command to node ${destinationNodeNum}`);
    res.json({ success: true, message: 'Time sync command sent successfully' });
  } catch (error: any) {
    logger.error('Error sending set-time command:', error);
    res.status(500).json({ error: error.message || 'Failed to send set-time command' });
  }
});

// Admin commands endpoint - requires admin role
// Admin endpoint: Export configuration for remote nodes
apiRouter.post('/admin/export-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, channelIds, includeLoraConfig } = req.body;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Get channels from local or remote node
    const channels = [];
    for (const channelId of channelIds) {
      if (isLocalNode) {
        const channel = databaseService.getChannelById(channelId);
        if (channel) {
          channels.push({
            psk: channel.psk ? channel.psk : 'none',
            name: channel.name,
            uplinkEnabled: channel.uplinkEnabled,
            downlinkEnabled: channel.downlinkEnabled,
            positionPrecision: channel.positionPrecision,
          });
        }
      } else {
        // For remote node, fetch channel
        const channel = await meshtasticManager.requestRemoteChannel(destinationNodeNum, channelId);
        if (channel) {
          const settings = channel.settings || {};
          const name = settings.name || '';
          const psk = settings.psk;
          let pskString = '';
          if (psk) {
            if (Buffer.isBuffer(psk)) {
              pskString = psk.toString('base64');
            } else if (psk instanceof Uint8Array) {
              pskString = Buffer.from(psk).toString('base64');
            } else if (typeof psk === 'string') {
              pskString = psk;
            } else {
              try {
                pskString = Buffer.from(psk as any).toString('base64');
              } catch (e) {
                logger.warn(`Failed to convert PSK for channel ${channelId}:`, e);
              }
            }
          }
          const moduleSettings = settings.moduleSettings || settings.module_settings || {};
          channels.push({
            psk: pskString && pskString !== 'AQ==' ? pskString : 'none',
            name: name,
            uplinkEnabled: settings.uplinkEnabled !== undefined ? settings.uplinkEnabled : 
                          (settings.uplink_enabled !== undefined ? settings.uplink_enabled : true),
            downlinkEnabled: settings.downlinkEnabled !== undefined ? settings.downlinkEnabled : 
                            (settings.downlink_enabled !== undefined ? settings.downlink_enabled : true),
            positionPrecision: moduleSettings.positionPrecision !== undefined ? moduleSettings.positionPrecision :
                              (moduleSettings.position_precision !== undefined ? moduleSettings.position_precision : 32),
          });
        }
      }
    }

    if (channels.length === 0) {
      return res.status(400).json({ error: 'No valid channels selected' });
    }

    // Get LoRa config if requested
    let loraConfig = undefined;
    if (includeLoraConfig) {
      if (isLocalNode) {
        const deviceConfig = await meshtasticManager.getDeviceConfig();
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
            txEnabled: true,
            txPower: deviceConfig.lora.txPower,
            channelNum: deviceConfig.lora.channelNum,
            sx126xRxBoostedGain: deviceConfig.lora.sx126xRxBoostedGain,
            configOkToMqtt: deviceConfig.lora.configOkToMqtt,
          };
        }
      } else {
        // For remote node, fetch LoRa config
        const loraConfigData = await meshtasticManager.requestRemoteConfig(destinationNodeNum, 5, false); // LORA_CONFIG = 5
        if (loraConfigData) {
          loraConfig = {
            usePreset: loraConfigData.usePreset,
            modemPreset: loraConfigData.modemPreset,
            bandwidth: loraConfigData.bandwidth,
            spreadFactor: loraConfigData.spreadFactor,
            codingRate: loraConfigData.codingRate,
            frequencyOffset: loraConfigData.frequencyOffset,
            region: loraConfigData.region,
            hopLimit: loraConfigData.hopLimit,
            txEnabled: true,
            txPower: loraConfigData.txPower,
            channelNum: loraConfigData.channelNum,
            sx126xRxBoostedGain: loraConfigData.sx126xRxBoostedGain,
            configOkToMqtt: loraConfigData.configOkToMqtt,
          };
        }
      }
    }

    const url = channelUrlService.encodeUrl(channels, loraConfig);

    if (!url) {
      return res.status(500).json({ error: 'Failed to encode URL' });
    }

    res.json({ url });
  } catch (error) {
    logger.error('Error exporting configuration:', error);
    res.status(500).json({ error: 'Failed to export configuration' });
  }
});

// Admin endpoint: Import configuration for remote nodes
apiRouter.post('/admin/import-config', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, url: configUrl } = req.body;

    if (!configUrl || typeof configUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    logger.info(`📥 Importing configuration from URL to node ${destinationNodeNum}: ${configUrl}`);

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Decode the URL to get channels and lora config
    const decoded = channelUrlService.decodeUrl(configUrl);

    if (!decoded || (!decoded.channels && !decoded.loraConfig)) {
      return res.status(400).json({ error: 'Invalid or empty configuration URL' });
    }

    logger.info(`📥 Decoded ${decoded.channels?.length || 0} channels, LoRa config: ${!!decoded.loraConfig}`);

    const importedChannels = [];
    let loraImported = false;
    let requiresReboot = false;

    if (isLocalNode) {
      // Use existing local import logic
      try {
        await meshtasticManager.beginEditSettings();
      } catch (error) {
        logger.error(`❌ Failed to begin edit settings transaction:`, error);
        throw new Error('Failed to start configuration transaction');
      }

      // Import channels
      if (decoded.channels && decoded.channels.length > 0) {
        for (let i = 0; i < decoded.channels.length; i++) {
          const channel = decoded.channels[i];
          try {
            let role = channel.role;
            if (role === undefined) {
              role = i === 0 ? 1 : 2;
            }
            await meshtasticManager.setChannelConfig(i, {
              name: channel.name || '',
              psk: channel.psk === 'none' ? undefined : channel.psk,
              role: role,
              uplinkEnabled: channel.uplinkEnabled,
              downlinkEnabled: channel.downlinkEnabled,
              positionPrecision: channel.positionPrecision,
            });
            importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
          } catch (error) {
            logger.error(`❌ Failed to import channel ${i}:`, error);
          }
        }
      }

      // Import LoRa config
      if (decoded.loraConfig) {
        try {
          const loraConfigToImport = {
            ...decoded.loraConfig,
            txEnabled: true,
          };
          await meshtasticManager.setLoRaConfig(loraConfigToImport);
          loraImported = true;
          requiresReboot = true;
        } catch (error) {
          logger.error(`❌ Failed to import LoRa config:`, error);
        }
      }

      await meshtasticManager.commitEditSettings();
    } else {
      // For remote node, use admin commands via meshtasticManager
      // Ensure session passkey
      let sessionPasskey = meshtasticManager.getSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        sessionPasskey = await meshtasticManager.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          throw new Error(`Failed to obtain session passkey for remote node ${destinationNodeNum}`);
        }
      }

      // Import channels using admin commands
      if (decoded.channels && decoded.channels.length > 0) {
        for (let i = 0; i < decoded.channels.length; i++) {
          const channel = decoded.channels[i];
          try {
            let role = channel.role;
            if (role === undefined) {
              role = i === 0 ? 1 : 2;
            }
            const adminMessage = protobufService.createSetChannelMessage(i, {
              name: channel.name || '',
              psk: channel.psk === 'none' ? undefined : channel.psk,
              role: role,
              uplinkEnabled: channel.uplinkEnabled,
              downlinkEnabled: channel.downlinkEnabled,
              positionPrecision: channel.positionPrecision,
            }, sessionPasskey);
            await meshtasticManager.sendAdminCommand(adminMessage, destinationNodeNum);
            importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
            // Small delay between channel updates for remote nodes
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch (error) {
            logger.error(`❌ Failed to import channel ${i}:`, error);
          }
        }
      }

      // Import LoRa config using admin command
      if (decoded.loraConfig) {
        try {
          const loraConfigToImport = {
            ...decoded.loraConfig,
            txEnabled: true,
          };
          const adminMessage = protobufService.createSetLoRaConfigMessage(loraConfigToImport, sessionPasskey);
          await meshtasticManager.sendAdminCommand(adminMessage, destinationNodeNum);
          loraImported = true;
          requiresReboot = true;
        } catch (error) {
          logger.error(`❌ Failed to import LoRa config:`, error);
        }
      }
    }

    res.json({
      success: true,
      imported: {
        channels: importedChannels.length,
        channelDetails: importedChannels,
        loraConfig: loraImported,
      },
      requiresReboot,
    });
  } catch (error: any) {
    logger.error('Error importing configuration:', error);
    res.status(500).json({ error: error.message || 'Failed to import configuration' });
  }
});

apiRouter.post('/admin/commands', requireAdmin(), async (req, res) => {
  try {
    const { command, nodeNum, ...params } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (meshtasticManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = meshtasticManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    // Get or request session passkey for remote nodes
    let sessionPasskey: Uint8Array | null = null;
    if (!isLocalNode) {
      sessionPasskey = meshtasticManager.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for admin command to remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one for admin command...`);
        sessionPasskey = await meshtasticManager.requestRemoteSessionPasskey(destinationNodeNum);
        if (!sessionPasskey) {
          logger.error(`❌ Failed to obtain session passkey for remote node ${destinationNodeNum} after 45s`);
          return res.status(500).json({ error: `Failed to obtain session passkey for remote node ${destinationNodeNum}. The node may be unreachable or not responding.` });
        }
      }
    }

    let adminMessage: Uint8Array;

    // Create the appropriate admin message based on command type
    switch (command) {
      case 'reboot':
        adminMessage = protobufService.createRebootMessage(params.seconds || 5, sessionPasskey || undefined);
        break;
      case 'setOwner':
        if (!params.longName || !params.shortName) {
          return res.status(400).json({ error: 'longName and shortName are required for setOwner' });
        }
        adminMessage = protobufService.createSetOwnerMessage(
          params.longName,
          params.shortName,
          params.isUnmessagable,
          sessionPasskey || undefined
        );
        break;
      case 'setChannel':
        if (params.channelIndex === undefined || !params.config) {
          return res.status(400).json({ error: 'channelIndex and config are required for setChannel' });
        }
        adminMessage = protobufService.createSetChannelMessage(
          params.channelIndex,
          params.config,
          sessionPasskey || undefined
        );
        break;
      case 'setDeviceConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setDeviceConfig' });
        }
        adminMessage = protobufService.createSetDeviceConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setLoRaConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setLoRaConfig' });
        }
        adminMessage = protobufService.createSetLoRaConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setPositionConfig': {
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setPositionConfig' });
        }
        // Extract position coordinates from config - these must be sent via a separate
        // setFixedPosition admin message, as Config.PositionConfig has no lat/lon/alt fields.
        // Per protobuf docs, set_fixed_position automatically sets fixedPosition=true on the device.
        // No delay needed: the local node queues both packets and the mesh protocol guarantees
        // FIFO delivery from the same source, with natural spacing from radio transmission time.
        const { latitude, longitude, altitude, ...positionConfig } = params.config;
        if (latitude !== undefined && longitude !== undefined && positionConfig.fixedPosition) {
          const setPositionMsg = protobufService.createSetFixedPositionMessage(
            latitude,
            longitude,
            altitude || 0,
            sessionPasskey || undefined
          );
          await meshtasticManager.sendAdminCommand(setPositionMsg, destinationNodeNum);
        }
        adminMessage = protobufService.createSetPositionConfigMessage(positionConfig, sessionPasskey || undefined);
        break;
      }
      case 'setMQTTConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setMQTTConfig' });
        }
        adminMessage = protobufService.createSetMQTTConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setBluetoothConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setBluetoothConfig' });
        }
        adminMessage = protobufService.createSetDeviceConfigMessageGeneric('bluetooth', params.config, sessionPasskey || undefined);
        break;
      case 'setNetworkConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNetworkConfig' });
        }
        adminMessage = protobufService.createSetNetworkConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setNeighborInfoConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setNeighborInfoConfig' });
        }
        adminMessage = protobufService.createSetNeighborInfoConfigMessage(params.config, sessionPasskey || undefined);
        break;
      case 'setTelemetryConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTelemetryConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('telemetry', params.config, sessionPasskey || undefined);
        break;
      case 'setSecurityConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setSecurityConfig' });
        }
        // IMPORTANT: Preserve existing public/private keys when updating security config
        // If we don't include them, the firmware may reset them to empty/random values
        // Only do this for LOCAL node - for remote nodes we don't have their private key
        {
          let configToSend = params.config;
          if (isLocalNode) {
            const existingKeys = meshtasticManager.getSecurityKeys();
            configToSend = {
              ...params.config,
              // Include existing keys if not explicitly provided
              publicKey: params.config.publicKey || existingKeys.publicKey,
              privateKey: params.config.privateKey || existingKeys.privateKey
            };
            logger.debug('Preserving existing public/private keys for local node security config update');
          } else {
            // For remote nodes, explicitly exclude publicKey/privateKey to let firmware preserve them
            // We don't have the remote node's private key, so we can't include it
            const { publicKey, privateKey, ...remoteConfig } = params.config;
            configToSend = remoteConfig;
            logger.debug('Excluding publicKey/privateKey from remote node security config update');
          }
          adminMessage = protobufService.createSetSecurityConfigMessage(configToSend, sessionPasskey || undefined);
        }
        break;
      case 'setFixedPosition':
        if (params.latitude === undefined || params.longitude === undefined) {
          return res.status(400).json({ error: 'latitude and longitude are required for setFixedPosition' });
        }
        adminMessage = protobufService.createSetFixedPositionMessage(
          params.latitude,
          params.longitude,
          params.altitude || 0,
          sessionPasskey || undefined
        );
        break;
      case 'purgeNodeDb':
        adminMessage = protobufService.createPurgeNodeDbMessage(params.seconds || 0, sessionPasskey || undefined);
        break;
      case 'beginEditSettings':
        adminMessage = protobufService.createBeginEditSettingsMessage(sessionPasskey || undefined);
        break;
      case 'commitEditSettings':
        adminMessage = protobufService.createCommitEditSettingsMessage(sessionPasskey || undefined);
        break;
      case 'removeNode':
        if (params.nodeNum === undefined) {
          return res.status(400).json({ error: 'nodeNum is required for removeNode' });
        }
        adminMessage = protobufService.createRemoveNodeMessage(params.nodeNum, sessionPasskey || undefined);
        break;
      case 'setFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for setFavoriteNode' });
        }
        adminMessage = protobufService.createSetFavoriteNodeMessage(params.favoriteNodeNum, sessionPasskey || undefined);
        break;
      case 'removeFavoriteNode':
        // Use favoriteNodeNum to avoid collision with destination nodeNum
        if (params.favoriteNodeNum === undefined) {
          return res.status(400).json({ error: 'favoriteNodeNum is required for removeFavoriteNode' });
        }
        adminMessage = protobufService.createRemoveFavoriteNodeMessage(params.favoriteNodeNum, sessionPasskey || undefined);
        break;
      case 'setIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for setIgnoredNode' });
        }
        adminMessage = protobufService.createSetIgnoredNodeMessage(params.targetNodeNum, sessionPasskey || undefined);
        break;
      case 'removeIgnoredNode':
        // Use targetNodeNum to avoid collision with destination nodeNum
        if (params.targetNodeNum === undefined) {
          return res.status(400).json({ error: 'targetNodeNum is required for removeIgnoredNode' });
        }
        adminMessage = protobufService.createRemoveIgnoredNodeMessage(params.targetNodeNum, sessionPasskey || undefined);
        break;
      default:
        return res.status(400).json({ error: `Unknown command: ${command}` });
    }

    // Send the admin command
    await meshtasticManager.sendAdminCommand(adminMessage, destinationNodeNum);

    // If command succeeded on a remote node, update hasRemoteAdmin flag
    if (!isLocalNode) {
      try {
        await databaseService.updateNodeRemoteAdminStatusAsync(
          destinationNodeNum,
          true,
          null  // Don't overwrite existing metadata, just set the flag
        );
        logger.info(`✅ Updated hasRemoteAdmin=true for node ${destinationNodeNum} after successful '${command}' command`);
      } catch (dbError) {
        logger.error(`Failed to update hasRemoteAdmin for node ${destinationNodeNum}:`, dbError);
        // Continue with response even if database update fails
      }
    }

    res.json({
      success: true,
      message: `Admin command '${command}' sent to node ${destinationNodeNum}`
    });
  } catch (error: any) {
    logger.error('Error executing admin command:', error);
    res.status(500).json({ error: error.message || 'Failed to execute admin command' });
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

    res.json({
      success: true,
      message: `Node database purged (both device and local)${seconds > 0 ? ` in ${seconds} seconds` : ''}`,
    });
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
apiRouter.get('/system/status', requirePermission('dashboard', 'read'), async (_req, res) => {
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

  // Get database info
  const databaseType = databaseService.getDatabaseType();
  const databaseVersion = await databaseService.getDatabaseVersion();

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
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    },
    database: {
      type: databaseType.charAt(0).toUpperCase() + databaseType.slice(1), // Capitalize
      version: databaseVersion,
    },
  });
});

// Health check endpoint
apiRouter.get('/health', optionalAuth(), (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    nodeEnv: env.nodeEnv,
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
      localNode: localNode
        ? {
            nodeNum: localNode.nodeNum,
            nodeId: localNode.nodeId,
            longName: localNode.longName,
            shortName: localNode.shortName,
          }
        : null,
    },
    statistics: {
      nodes: databaseService.getNodeCount(),
      messages: databaseService.getMessageCount(),
      channels: databaseService.getChannelCount(),
    },
    uptime: process.uptime(),
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
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.docker.distribution.manifest.v2+json',
            },
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
        logger.info(
          `✓ Image for ${version} assumed ready (${Math.round(
            minutesSincePublish
          )} minutes since release, API check failed)`
        );
        return true;
      } else {
        logger.info(
          `⏳ Image for ${version} still building (${Math.round(minutesSincePublish)}/30 minutes since release)`
        );
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
        logger.info(
          `✓ Image for ${version} assumed ready (${Math.round(
            minutesSincePublish
          )} minutes since release, error during check)`
        );
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
  if (env.versionCheckDisabled) {
    return res.status(404).send();
  }
  try {
    // Check cache first
    if (versionCheckCache && Date.now() - versionCheckCache.timestamp < VERSION_CHECK_CACHE_MS) {
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

    // Check if auto-upgrade immediate is enabled and trigger upgrade automatically
    let autoUpgradeTriggered = false;
    if (updateAvailable && upgradeService.isEnabled()) {
      const autoUpgradeImmediate = databaseService.getSetting('autoUpgradeImmediate') === 'true';
      if (autoUpgradeImmediate) {
        // Check if an upgrade is already in progress before triggering
        try {
          const inProgress = await upgradeService.isUpgradeInProgress();
          if (inProgress) {
            logger.debug(`ℹ️ Auto-upgrade skipped: upgrade already in progress`);
          } else {
            logger.info(`🚀 Auto-upgrade immediate enabled, triggering upgrade to ${latestVersion}`);
            const upgradeResult = await upgradeService.triggerUpgrade(
              { targetVersion: latestVersion, backup: true },
              currentVersion,
              'system-auto-upgrade'
            );
            if (upgradeResult.success) {
              autoUpgradeTriggered = true;
              logger.info(`✅ Auto-upgrade triggered successfully: ${upgradeResult.upgradeId}`);
              databaseService.auditLog(
                null,
                'auto_upgrade_triggered',
                'system',
                `Auto-upgrade initiated: ${currentVersion} → ${latestVersion}`,
                null
              );
            } else {
              // Check if failure was due to upgrade already in progress (race condition)
              if (upgradeResult.message === 'An upgrade is already in progress') {
                logger.debug(`ℹ️ Auto-upgrade skipped: upgrade started by another process`);
              } else {
                logger.warn(`⚠️ Auto-upgrade failed to trigger: ${upgradeResult.message}`);
              }
            }
          }
        } catch (upgradeError) {
          logger.error('❌ Error triggering auto-upgrade:', upgradeError);
        }
      }
    }

    const result = {
      updateAvailable,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseName: release.name,
      publishedAt: release.published_at,
      imageReady,
      autoUpgradeTriggered,
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
      action: 'restart',
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
      action: 'shutdown',
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
apiRouter.get('/push/vapid-key', optionalAuth(), async (_req, res) => {
  const publicKey = await pushNotificationService.getPublicKeyAsync();
  const status = await pushNotificationService.getVapidStatusAsync();

  res.json({
    publicKey,
    status,
  });
});

// Get push notification status
apiRouter.get('/push/status', optionalAuth(), async (_req, res) => {
  const status = await pushNotificationService.getVapidStatusAsync();
  res.json(status);
});

// Update VAPID subject (admin only)
apiRouter.put('/push/vapid-subject', requireAdmin(), async (req, res) => {
  try {
    const { subject } = req.body;

    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'Subject is required and must be a string' });
    }

    await pushNotificationService.updateVapidSubject(subject);
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

    // Get local node name for prefix
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Apply prefix if user has it enabled
    const baseBody = 'This is a test push notification from MeshMonitor';
    const body = applyNodeNamePrefix(userId, baseBody, localNodeName);

    const result = await pushNotificationService.sendToUser(userId, {
      title: 'Test Notification',
      body,
      icon: '/logo.png',
      badge: '/logo.png',
      tag: 'test-notification',
    });

    res.json({
      success: true,
      sent: result.sent,
      failed: result.failed,
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

    const prefs = await getUserNotificationPreferencesAsync(userId);

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
        notifyOnMqtt: true,
        notifyOnNewNode: true,
        notifyOnTraceroute: true,
        notifyOnInactiveNode: false,
        notifyOnServerEvents: false,
        prefixWithNodeName: false,
        monitoredNodes: [],
        whitelist: ['Hi', 'Help'],
        blacklist: ['Test', 'Copy'],
        appriseUrls: [],
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

    const {
      enableWebPush,
      enableApprise,
      enabledChannels,
      enableDirectMessages,
      notifyOnEmoji,
      notifyOnMqtt,
      notifyOnNewNode,
      notifyOnTraceroute,
      notifyOnInactiveNode,
      notifyOnServerEvents,
      prefixWithNodeName,
      monitoredNodes,
      whitelist,
      blacklist,
      appriseUrls,
    } = req.body;

    // Validate input
    if (
      typeof enableWebPush !== 'boolean' ||
      typeof enableApprise !== 'boolean' ||
      !Array.isArray(enabledChannels) ||
      typeof enableDirectMessages !== 'boolean' ||
      typeof notifyOnEmoji !== 'boolean' ||
      typeof notifyOnMqtt !== 'boolean' ||
      typeof notifyOnNewNode !== 'boolean' ||
      typeof notifyOnTraceroute !== 'boolean' ||
      typeof notifyOnInactiveNode !== 'boolean' ||
      typeof notifyOnServerEvents !== 'boolean' ||
      typeof prefixWithNodeName !== 'boolean' ||
      !Array.isArray(whitelist) ||
      !Array.isArray(blacklist)
    ) {
      return res.status(400).json({ error: 'Invalid preferences data' });
    }

    // Validate monitoredNodes is an array of strings
    if (monitoredNodes !== undefined && !Array.isArray(monitoredNodes)) {
      return res.status(400).json({ error: 'monitoredNodes must be an array' });
    }

    // Validate each element is a string
    if (monitoredNodes && monitoredNodes.some((id: any) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'monitoredNodes must be an array of strings' });
    }

    // Validate appriseUrls is an array of strings if provided
    if (appriseUrls !== undefined && !Array.isArray(appriseUrls)) {
      return res.status(400).json({ error: 'appriseUrls must be an array' });
    }
    if (appriseUrls && appriseUrls.some((url: any) => typeof url !== 'string')) {
      return res.status(400).json({ error: 'appriseUrls must be an array of strings' });
    }

    const prefs = {
      enableWebPush,
      enableApprise,
      enabledChannels,
      enableDirectMessages,
      notifyOnEmoji,
      notifyOnMqtt: notifyOnMqtt ?? true,
      notifyOnNewNode,
      notifyOnTraceroute,
      notifyOnInactiveNode: notifyOnInactiveNode ?? false,
      notifyOnServerEvents: notifyOnServerEvents ?? false,
      prefixWithNodeName: prefixWithNodeName ?? false,
      monitoredNodes: monitoredNodes ?? [],
      whitelist,
      blacklist,
      appriseUrls: appriseUrls ?? [],
    };

    const success = await saveUserNotificationPreferencesAsync(userId, prefs);

    if (success) {
      logger.info(
        `✅ Saved notification preferences for user ${userId} (WebPush: ${enableWebPush}, Apprise: ${enableApprise})`
      );
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
      url: databaseService.getSetting('apprise_url') || 'http://localhost:8000',
    });
  } catch (error: any) {
    logger.error('Error getting Apprise status:', error);
    res.status(500).json({ error: error.message || 'Failed to get Apprise status' });
  }
});

// Send test Apprise notification (admin only)
apiRouter.post('/apprise/test', requireAdmin(), async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // Get user's Apprise URLs from their preferences
    const prefs = await getUserNotificationPreferencesAsync(userId);
    if (!prefs || !prefs.appriseUrls || prefs.appriseUrls.length === 0) {
      return res.json({
        success: false,
        message: 'No Apprise URLs configured in your notification preferences',
      });
    }

    // Get local node name for prefix
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Apply prefix if user has it enabled
    const baseBody = 'This is a test notification from MeshMonitor via Apprise';
    const body = applyNodeNamePrefix(userId, baseBody, localNodeName);

    // Send to user's configured URLs
    const success = await appriseNotificationService.sendNotificationToUrls(
      {
        title: 'Test Notification',
        body,
        type: 'info',
      },
      prefs.appriseUrls
    );

    if (success) {
      res.json({ success: true, message: 'Test notification sent successfully' });
    } else {
      res.json({ success: false, message: 'Failed to send notification - check your Apprise URLs' });
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
      'apprise',
      'apprises',

      // Chat & Messaging
      'discord',
      'slack',
      'msteams',
      'teams',
      'guilded',
      'revolt',
      'matrix',
      'matrixs',
      'mmost',
      'mmosts',
      'rocket',
      'rockets',
      'ryver',
      'zulip',
      'twist',
      'gchat',
      'flock',

      // Instant Messaging & Social
      'telegram',
      'tgram',
      'signal',
      'signals',
      'whatsapp',
      'line',
      'mastodon',
      'mastodons',
      'misskey',
      'misskeys',
      'bluesky',
      'reddit',
      'twitter',

      // Team Communication
      'workflows',
      'wxteams',
      'wecombot',
      'feishu',
      'lark',
      'dingtalk',

      // Push Notifications
      'pushover',
      'pover',
      'pushbullet',
      'pbul',
      'pushed',
      'pushme',
      'pushplus',
      'pushdeer',
      'pushdeers',
      'pushy',
      'prowl',
      'simplepush',
      'spush',
      'popcorn',
      'push',

      // Notification Services
      'ntfy',
      'ntfys',
      'gotify',
      'gotifys',
      'join',
      'ifttt',
      'notica',
      'notifiarr',
      'notifico',
      'onesignal',
      'kumulos',
      'bark',
      'barks',
      'chanify',
      'serverchan',
      'schan',
      'qq',
      'wxpusher',

      // Incident Management & Monitoring
      'pagerduty',
      'pagertree',
      'opsgenie',
      'spike',
      'splunk',
      'victorops',
      'signl4',

      // Email Services
      'mailto',
      'email',
      'smtp',
      'smtps',
      'ses',
      'mailgun',
      'sendgrid',
      'smtp2go',
      'sparkpost',
      'o365',
      'resend',
      'sendpulse',

      // SMS Services
      'bulksms',
      'bulkvs',
      'burstsms',
      'clickatell',
      'clicksend',
      'd7sms',
      'freemobile',
      'httpsms',
      'atalk',

      // Cloud/IoT/Home
      'fcm',
      'hassio',
      'hassios',
      'homeassistant',
      'parsep',
      'parseps',
      'aws',
      'sns',

      // Media Centers
      'kodi',
      'kodis',
      'xbmc',
      'xbmcs',
      'emby',
      'embys',
      'enigma2',
      'enigma2s',

      // Collaboration & Productivity
      'ncloud',
      'nclouds',
      'nctalk',
      'nctalks',
      'office365',

      // Streaming & Gaming
      'streamlabs',
      'strmlabs',

      // Specialized
      'lametric',
      'synology',
      'synologys',
      'vapid',
      'mqtt',
      'mqtts',
      'rsyslog',
      'syslog',
      'dapnet',
      'aprs',
      'growl',
      'pjet',
      'pjets',
      'psafer',
      'psafers',
      'spugpush',
      'pushsafer',

      // Generic webhooks & protocols
      'webhook',
      'webhooks',
      'json',
      'xml',
      'form',
      'http',
      'https',
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
        allowedSchemes: ALLOWED_SCHEMES,
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

/**
 * Script metadata interface for enhanced script display
 */
interface ScriptMetadata {
  path: string;           // Full path like /data/scripts/filename.py
  filename: string;       // Just the filename
  name?: string;          // Human-readable name from mm_meta
  emoji?: string;         // Emoji icon from mm_meta
  language: string;       // Inferred from extension or mm_meta
}

/**
 * Sanitize metadata value to prevent XSS
 * Strips HTML tags and limits length
 */
const sanitizeMetadataValue = (value: string, maxLength: number = 100): string => {
  // Strip HTML tags
  const stripped = value.replace(/<[^>]*>/g, '');
  // Limit length
  return stripped.substring(0, maxLength).trim();
};

/**
 * Parse mm_meta block from script content
 * Format:
 * # mm_meta:
 * #   name: Script Display Name
 * #   emoji: 📡
 * #   language: Python
 */
const parseScriptMetadata = (content: string, _filename: string): Partial<ScriptMetadata> => {
  const metadata: Partial<ScriptMetadata> = {};

  // Look for mm_meta block - supports both # and // comment styles
  const metaMatch = content.match(/^[#\/]{1,2}\s*mm_meta:\s*\n((?:[#\/]{1,2}\s+\w+:.*\n?)+)/m);

  if (metaMatch) {
    const metaBlock = metaMatch[1];

    // Parse name (sanitize to prevent XSS, max 100 chars)
    const nameMatch = metaBlock.match(/^[#\/]{1,2}\s+name:\s*(.+)$/m);
    if (nameMatch) {
      metadata.name = sanitizeMetadataValue(nameMatch[1], 100);
    }

    // Parse emoji (sanitize, limit to 10 chars for emoji sequences)
    const emojiMatch = metaBlock.match(/^[#\/]{1,2}\s+emoji:\s*(.+)$/m);
    if (emojiMatch) {
      metadata.emoji = sanitizeMetadataValue(emojiMatch[1], 10);
    }

    // Parse language (sanitize, max 20 chars)
    const langMatch = metaBlock.match(/^[#\/]{1,2}\s+language:\s*(.+)$/m);
    if (langMatch) {
      metadata.language = sanitizeMetadataValue(langMatch[1], 20);
    }
  }

  return metadata;
};

/**
 * Get language display name from file extension
 */
const getLanguageFromExtension = (filename: string): string => {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.py': return 'Python';
    case '.js': return 'JavaScript';
    case '.mjs': return 'JavaScript';
    case '.sh': return 'Shell';
    default: return 'Script';
  }
};

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

    const scriptFiles = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return validExtensions.includes(ext);
      })
      .filter(file => file !== 'upgrade-watchdog.sh') // Exclude system scripts
      .sort();

    // Build script metadata for each file
    const scripts: ScriptMetadata[] = scriptFiles.map(file => {
      const filePath = path.join(scriptsDir, file);
      const scriptPath = `/data/scripts/${file}`;

      // Start with defaults
      const script: ScriptMetadata = {
        path: scriptPath,
        filename: file,
        language: getLanguageFromExtension(file),
      };

      // Try to read and parse metadata from file
      try {
        // Only read first 1KB to find metadata block (performance optimization)
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
        fs.closeSync(fd);

        const content = buffer.toString('utf8', 0, bytesRead);
        const metadata = parseScriptMetadata(content, file);

        if (metadata.name) script.name = metadata.name;
        if (metadata.emoji) script.emoji = metadata.emoji;
        if (metadata.language) script.language = metadata.language;
      } catch (readError) {
        // Silently ignore read errors - script will just use defaults
        logger.debug(`📜 Could not read metadata from ${file}: ${readError}`);
      }

      return script;
    });

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
// Supports triggerType: 'auto-responder' (default), 'geofence', or 'timer'
apiRouter.post('/scripts/test', requirePermission('settings', 'read'), async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      script,
      triggerType = 'auto-responder',
      // Auto-responder specific
      trigger,
      testMessage,
      scriptArgs,
      // Geofence specific
      geofenceName,
      geofenceId,
      eventType,
      nodeLat,
      nodeLon,
      // Timer specific
      timerName,
      timerId,
      // Mock node info (optional)
      mockNode,
    } = req.body;

    // Validate based on trigger type
    if (triggerType === 'auto-responder') {
      if (!script || !trigger || !testMessage) {
        return res.status(400).json({ error: 'Missing required fields: script, trigger, testMessage' });
      }
    } else if (triggerType === 'geofence') {
      if (!script) {
        return res.status(400).json({ error: 'Missing required field: script' });
      }
    } else if (triggerType === 'timer') {
      if (!script) {
        return res.status(400).json({ error: 'Missing required field: script' });
      }
    } else {
      return res.status(400).json({ error: `Invalid triggerType: ${triggerType}. Expected 'auto-responder', 'geofence', or 'timer'` });
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

    let matchedPattern: string | null = null;
    let extractedParams: Record<string, string> = {};

    // Auto-responder: Extract parameters from test message using trigger pattern
    if (triggerType === 'auto-responder') {
      const patterns = normalizeTriggerPatterns(trigger);

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
              const paramName =
                colonPos !== -1 ? patternStr.substring(startPos, colonPos) : patternStr.substring(startPos, endPos);
              const paramPattern = colonPos !== -1 ? patternStr.substring(colonPos + 1, endPos) : undefined;

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
                  replacement: `(${paramRegex})`,
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
        interpreter = isDev ? 'python' : '/opt/apprise-venv/bin/python3';
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

    // Prepare base environment variables
    const scriptEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };

    // Default mock node info
    const mockNodeNum = mockNode?.nodeNum?.toString() || '12345';
    const mockShortName = mockNode?.shortName || 'TEST';
    const mockLongName = mockNode?.longName || 'Test Node';
    const mockNodeLat = mockNode?.lat?.toString() || nodeLat?.toString() || '37.7749';
    const mockNodeLon = mockNode?.lon?.toString() || nodeLon?.toString() || '-122.4194';

    // Set environment variables based on trigger type
    if (triggerType === 'auto-responder') {
      scriptEnv.MESSAGE = testMessage;
      scriptEnv.FROM_NODE = mockNodeNum;
      scriptEnv.FROM_SHORT_NAME = mockShortName;
      scriptEnv.FROM_LONG_NAME = mockLongName;
      scriptEnv.PACKET_ID = '99999';
      scriptEnv.TRIGGER = Array.isArray(trigger) ? trigger.join(', ') : trigger;
      // Add extracted parameters as PARAM_* environment variables
      Object.entries(extractedParams).forEach(([key, value]) => {
        scriptEnv[`PARAM_${key}`] = value;
      });
    } else if (triggerType === 'geofence') {
      scriptEnv.GEOFENCE_NAME = geofenceName || 'Test Geofence';
      scriptEnv.GEOFENCE_ID = geofenceId || 'test-geofence-id';
      scriptEnv.GEOFENCE_EVENT = eventType || 'entry';
      scriptEnv.EVENT = eventType || 'entry';
      scriptEnv.NODE_LAT = mockNodeLat;
      scriptEnv.NODE_LON = mockNodeLon;
      scriptEnv.NODE_NUM = mockNodeNum;
      scriptEnv.NODE_ID = mockNodeNum;
      scriptEnv.SHORT_NAME = mockShortName;
      scriptEnv.LONG_NAME = mockLongName;
      scriptEnv.DISTANCE_TO_CENTER = '0.5'; // Test distance in km
    } else if (triggerType === 'timer') {
      scriptEnv.TIMER_NAME = timerName || 'Test Timer';
      scriptEnv.TIMER_ID = timerId || 'test-timer-id';
      scriptEnv.TIMER_SCRIPT = script;
    }

    // Common environment variables for all trigger types
    // When Virtual Node is enabled, route scripts through it to avoid opening a
    // second TCP connection to the physical node (which kills MeshMonitor's connection)
    let meshtasticIp: string;
    let meshtasticPort: string;
    if (env.enableVirtualNode) {
      meshtasticIp = '127.0.0.1';
      meshtasticPort = String(env.virtualNodePort);
    } else {
      meshtasticIp = process.env.MESHTASTIC_NODE_IP || process.env.MESHTASTIC_IP || process.env.NODE_IP || '127.0.0.1';
      meshtasticPort = process.env.MESHTASTIC_NODE_PORT || process.env.MESHTASTIC_PORT || process.env.NODE_PORT || '4403';
    }
    scriptEnv.IP = meshtasticIp;
    scriptEnv.PORT = meshtasticPort;
    scriptEnv.MESHTASTIC_IP = meshtasticIp;
    scriptEnv.MESHTASTIC_PORT = meshtasticPort;
    scriptEnv.VERSION = process.env.VERSION || 'test';

    // Build script arguments if provided
    const scriptArgList: string[] = [resolvedPath];
    if (scriptArgs) {
      // Token expansion for script args (basic expansion for test)
      let expandedArgs = scriptArgs
        .replace(/\{IP\}/g, scriptEnv.IP)
        .replace(/\{PORT\}/g, scriptEnv.PORT)
        .replace(/\{VERSION\}/g, scriptEnv.VERSION)
        .replace(/\{NODE_ID\}/g, mockNodeNum)
        .replace(/\{NODE_NUM\}/g, mockNodeNum)
        .replace(/\{SHORT_NAME\}/g, mockShortName)
        .replace(/\{LONG_NAME\}/g, mockLongName);

      if (triggerType === 'geofence') {
        expandedArgs = expandedArgs
          .replace(/\{GEOFENCE_NAME\}/g, scriptEnv.GEOFENCE_NAME)
          .replace(/\{EVENT\}/g, scriptEnv.GEOFENCE_EVENT)
          .replace(/\{NODE_LAT\}/g, mockNodeLat)
          .replace(/\{NODE_LON\}/g, mockNodeLon);
      }

      // Split args respecting both single and double quotes
      const argParts = expandedArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      scriptArgList.push(...argParts.map((arg: string) => arg.replace(/^["']|["']$/g, '')));
    }

    try {
      const { stdout, stderr } = await execFileAsync(interpreter, scriptArgList, {
        timeout: 10000,
        env: scriptEnv,
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      const executionTimeMs = Date.now() - startTime;
      const output = stdout.trim();
      const errorOutput = stderr.trim();

      // Parse JSON output to extract "would send" messages
      let wouldSendMessages: string[] = [];
      let returnValue: unknown = null;

      if (output) {
        try {
          const parsed = JSON.parse(output);
          returnValue = parsed;
          // Look for response/responses fields that indicate messages to send
          if (parsed.response) {
            wouldSendMessages = Array.isArray(parsed.response) ? parsed.response : [parsed.response];
          } else if (parsed.responses) {
            wouldSendMessages = Array.isArray(parsed.responses) ? parsed.responses : [parsed.responses];
          } else if (typeof parsed === 'string') {
            wouldSendMessages = [parsed];
          }
        } catch {
          // Not JSON - the output itself might be the message
          if (output && output !== '(no output)') {
            wouldSendMessages = [output];
          }
        }
      }

      return res.json({
        success: true,
        stdout: output || '(no output)',
        stderr: errorOutput || undefined,
        wouldSendMessages,
        returnValue,
        extractedParams: triggerType === 'auto-responder' ? extractedParams : undefined,
        matchedPattern: triggerType === 'auto-responder' ? matchedPattern : undefined,
        executionTimeMs,
      });
    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;

      // Handle execution errors
      if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
        return res.status(408).json({
          success: false,
          error: 'Script execution timed out after 10 seconds',
          executionTimeMs,
        });
      }

      // Handle Windows EPERM errors gracefully (process may have already terminated)
      if (error.code === 'EPERM' && process.platform === 'win32') {
        // On Windows, EPERM can occur when trying to kill a process that's already dead
        // If we got stdout/stderr before the error, return that
        if (error.stdout || error.stderr) {
          const output = error.stdout?.toString().trim() || '';
          let wouldSendMessages: string[] = [];
          let returnValue: unknown = null;

          if (output) {
            try {
              const parsed = JSON.parse(output);
              returnValue = parsed;
              if (parsed.response) {
                wouldSendMessages = Array.isArray(parsed.response) ? parsed.response : [parsed.response];
              } else if (parsed.responses) {
                wouldSendMessages = Array.isArray(parsed.responses) ? parsed.responses : [parsed.responses];
              }
            } catch {
              if (output) wouldSendMessages = [output];
            }
          }

          return res.json({
            success: true,
            stdout: output || '(no output)',
            stderr: error.stderr?.toString().trim() || undefined,
            wouldSendMessages,
            returnValue,
            extractedParams: triggerType === 'auto-responder' ? extractedParams : undefined,
            matchedPattern: triggerType === 'auto-responder' ? matchedPattern : undefined,
            executionTimeMs,
          });
        }
        // Otherwise, return a more user-friendly error
        return res.status(500).json({
          success: false,
          error: 'Script execution completed but encountered a cleanup error (this is usually harmless)',
          stderr: error.stderr?.toString() || undefined,
          executionTimeMs,
        });
      }

      return res.status(500).json({
        success: false,
        error: error.message || 'Script execution failed',
        stderr: error.stderr?.toString() || undefined,
        executionTimeMs,
      });
    }
  } catch (error: any) {
    const executionTimeMs = Date.now() - startTime;
    logger.error('❌ Error testing script:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      executionTimeMs,
    });
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
          Accept: 'text/plain, text/*, application/json',
          'User-Agent': 'MeshMonitor/AutoResponder-Test',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return res.status(response.status).json({
          error: `HTTP ${response.status}: ${response.statusText}`,
        });
      }

      const text = await response.text();

      return res.json({
        result: text.substring(0, 500) + (text.length > 500 ? '...' : ''),
        status: response.status,
        statusText: response.statusText,
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        return res.status(408).json({ error: 'Request timed out after 10 seconds' });
      }

      return res.status(500).json({
        error: fetchError.message || 'Failed to fetch URL',
      });
    }
  } catch (error: any) {
    logger.error('❌ Error testing HTTP trigger:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// Script import endpoint - upload a script file
apiRouter.post(
  '/scripts/import',
  requirePermission('settings', 'write'),
  express.raw({ type: '*/*', limit: '5mb' }),
  async (req, res) => {
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
  }
);

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
    // CORS detection script
    .replace(/src="\/cors-detection\.js"/g, `src="${baseUrl}/cors-detection.js"`)
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
  // Handle JSON parsing errors with a helpful message
  if (err instanceof SyntaxError && 'body' in err) {
    logger.warn('JSON parsing error:', err.message);
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body. Please check your JSON syntax.',
    });
  }

  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: env.isDevelopment ? err.message : 'Something went wrong',
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

// Module-level server variable for graceful shutdown
let server: ReturnType<typeof app.listen>;

// Wrap server startup in async IIFE to wait for database before accepting requests
(async () => {
  try {
    // Wait for database initialization to complete BEFORE starting server
    // This is critical for PostgreSQL/MySQL where Drizzle repositories are initialized async
    await databaseService.waitForReady();
    logger.info('✅ Database ready, starting HTTP server...');
  } catch (error) {
    logger.error('❌ Database initialization failed:', error);
    process.exit(1);
  }

  server = app.listen(PORT, () => {
    logger.debug(`MeshMonitor server running on port ${PORT}`);
    logger.debug(`Environment: ${env.nodeEnv}`);

    // Initialize WebSocket server for real-time updates
    initializeWebSocket(server, sessionMiddleware);

    // Send server start notification
    (async () => {
      try {
        const enabledFeatures: string[] = ['WebSocket']; // WebSocket is always enabled
      if (env.oidcEnabled) enabledFeatures.push('OIDC');
      if (env.enableVirtualNode) enabledFeatures.push('Virtual Node');
      if (env.accessLogEnabled) enabledFeatures.push('Access Logging');
      if (pushNotificationService.isAvailable()) enabledFeatures.push('Web Push');
      if (appriseNotificationService.isAvailable()) enabledFeatures.push('Apprise');

      serverEventNotificationService.notifyServerStart({
        version: packageJson.version,
        features: enabledFeatures,
      });
    } catch (error) {
      logger.error('Failed to send server start notification:', error);
    }
  })();

  // Log environment variable sources in development
  if (env.isDevelopment) {
    logger.info(
      `🔧 Meshtastic Node IP: ${env.meshtasticNodeIp} ${
        env.meshtasticNodeIpProvided ? '📄 (from .env)' : '⚙️ (default)'
      }`
    );
    logger.info(
      `🔧 Meshtastic TCP Port: ${env.meshtasticTcpPort} ${
        env.meshtasticTcpPortProvided ? '📄 (from .env)' : '⚙️ (default)'
      }`
    );

    // Log scripts directory location in development
    const scriptsDir = getScriptsDirectory();
    logger.info(`📜 Auto-responder scripts directory: ${scriptsDir}`);

    // Check if directory has any scripts
    try {
      const files = fs.readdirSync(scriptsDir);
      const scriptFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.js', '.mjs', '.py', '.sh'].includes(ext);
      });

      if (scriptFiles.length > 0) {
        logger.info(`   Found ${scriptFiles.length} script(s): ${scriptFiles.join(', ')}`);
      } else {
        logger.info(`   No scripts found. Place your test scripts (.js, .mjs, .py, .sh) in this directory`);
      }
    } catch (error) {
      logger.warn(`   Could not read scripts directory: ${error}`);
    }
  }
  });

  // Configure server timeouts to prevent hanging requests
  server.setTimeout(30000); // 30 seconds
  server.keepAliveTimeout = 65000; // 65 seconds (must be > setTimeout)
  server.headersTimeout = 66000; // 66 seconds (must be > keepAliveTimeout)
})();
