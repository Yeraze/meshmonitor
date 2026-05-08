import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import databaseService, { DbMessage } from '../services/database.js';
import { MeshMessage } from '../types/message.js';
import meshtasticManager from './meshtasticManager.js';
import { MeshtasticManager } from './meshtasticManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import protobufService from './protobufService.js';

// Make meshtasticManager available globally for routes that need it
(global as any).meshtasticManager = meshtasticManager;
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import { normalizeTriggerPatterns } from '../utils/autoResponderUtils.js';
import { getSessionMiddleware } from './auth/sessionConfig.js';
import { initializeWebSocket } from './services/webSocketService.js';
import { initializeOIDC } from './auth/oidcAuth.js';
import { optionalAuth, requireAuth, requirePermission, requireAdmin, hasPermission } from './auth/authMiddleware.js';
import { transformChannel } from './utils/channelView.js';
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
import { securityDigestService } from './services/securityDigestService.js';
import { solarMonitoringService } from './services/solarMonitoringService.js';
import { newsService } from './services/newsService.js';
import { inactiveNodeNotificationService } from './services/inactiveNodeNotificationService.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
import { getUserNotificationPreferencesAsync, saveUserNotificationPreferencesAsync, applyNodeNamePrefixAsync } from './utils/notificationFiltering.js';
import { upgradeService } from './services/upgradeService.js';
import { enhanceNodeForClient, filterNodesByChannelPermission, checkNodeChannelAccess, getEffectiveDbNodePosition } from './utils/nodeEnhancer.js';
import { dynamicCspMiddleware, refreshTileHostnameCache } from './middleware/dynamicCsp.js';
import { generateAnalyticsScript, AnalyticsProvider } from './utils/analyticsScriptGenerator.js';
import { rewriteHtml } from './utils/htmlRewriter.js';
import { migrateAutomationChannels } from './utils/automationChannelMigration.js';
import { safeFetch, SsrfBlockedError } from './utils/ssrfGuard.js';
import { resolveRequestSourceId } from './utils/sourceResolver.js';
import { PortNum } from './constants/meshtastic.js';
import settingsRoutes, { setSettingsCallbacks } from './routes/settingsRoutes.js';
import { applyManagerSettings } from './applyManagerSettings.js';

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
 * In production, uses DATA_DIR env var (set by desktop sidecar) or defaults to /data.
 */
const getScriptsDirectory = (): string => {
  let scriptsDir: string;

  if (env.isDevelopment) {
    const projectRoot = path.resolve(__dirname, '../../');
    scriptsDir = path.join(projectRoot, 'data', 'scripts');
  } else {
    scriptsDir = path.join(process.env.DATA_DIR || '/data', 'scripts');
  }

  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
    logger.info(`📁 Created scripts directory: ${scriptsDir}`);
  }

  return scriptsDir;
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
// frameguard (X-Frame-Options) is disabled when IFRAME_ALLOWED_ORIGINS is set;
// iframe embedding policy is then enforced via CSP frame-ancestors instead.
const iframeEmbeddingEnabled = env.iframeAllowedOrigins.length > 0;
const frameguardConfig = iframeEmbeddingEnabled
  ? false as const
  : { action: 'deny' as const };

const helmetConfig =
  env.isProduction && env.cookieSecure
    ? {
        contentSecurityPolicy: false, // Handled by dynamicCspMiddleware
        hsts: {
          maxAge: 31536000, // 1 year
          includeSubDomains: true,
          preload: true,
        },
        frameguard: frameguardConfig,
        noSniff: true,
        xssFilter: true,
        // Send origin as Referer for cross-origin requests (e.g. map tile fetches).
        // Helmet defaults to no-referrer which violates OSM tile usage policy.
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
      }
    : {
        // Development or HTTP-only: no HSTS
        contentSecurityPolicy: false, // Handled by dynamicCspMiddleware
        hsts: false, // Disable HSTS when not using secure cookies or in development
        crossOriginOpenerPolicy: false, // Disable COOP for HTTP - browser ignores it on non-HTTPS anyway
        frameguard: frameguardConfig,
        noSniff: true,
        xssFilter: true,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
      };

app.use(helmet(helmetConfig));

// Dynamic CSP middleware - adds custom tile server hostnames from database,
// and sets frame-ancestors from IFRAME_ALLOWED_ORIGINS when configured.
app.use(dynamicCspMiddleware(env.isProduction, env.cookieSecure, env.iframeAllowedOrigins));

// Security: CORS configuration with allowed origins
const getAllowedOrigins = () => {
  const origins = [...env.allowedOrigins];
  // Always allow localhost in development
  if (env.isDevelopment) {
    origins.push('http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080');
  }
  return origins.length > 0 ? origins : ['http://localhost:3000'];
};

// Embed origin cache (refreshes every 60 seconds)
let embedOriginsCache: string[] = [];
let embedOriginsCacheTime = 0;
const EMBED_ORIGINS_CACHE_TTL = 60000;

/** Convert protobuf bytes (Uint8Array, Buffer, byte array, or object) to base64 string */
function bytesToBase64(key: any): string {
  if (key instanceof Uint8Array || Buffer.isBuffer(key)) {
    return Buffer.from(key).toString('base64');
  }
  if (key && typeof key === 'object' && key.type === 'Buffer' && Array.isArray(key.data)) {
    return Buffer.from(key.data).toString('base64');
  }
  if (Array.isArray(key)) {
    return Buffer.from(key).toString('base64');
  }
  if (typeof key === 'string') {
    return key;
  }
  // Handle generic iterables/objects with byte data (e.g., protobuf Bytes wrappers)
  if (key && typeof key === 'object') {
    try {
      return Buffer.from(Object.values(key) as number[]).toString('base64');
    } catch {
      // fall through
    }
  }
  logger.warn('Unknown admin key format:', typeof key, key);
  return '';
}

function refreshEmbedOriginsCache(): void {
  databaseService.embedProfiles.getAllAsync().then(profiles => {
    embedOriginsCache = [...new Set(
      profiles.filter(p => p.enabled).flatMap(p => p.allowedOrigins)
    )];
    embedOriginsCacheTime = Date.now();
  }).catch(() => {
    // On error, keep stale cache
  });
}

function getEmbedAllowedOrigins(): string[] {
  if (Date.now() - embedOriginsCacheTime < EMBED_ORIGINS_CACHE_TTL) {
    return embedOriginsCache;
  }
  // Fire async lookup, use stale cache until it resolves
  refreshEmbedOriginsCache();
  return embedOriginsCache;
}

app.use(
  cors({
    origin: (origin, callback) => {
      const allowedOrigins = getAllowedOrigins();

      // Allow requests with no origin (mobile apps, Postman, same-origin)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }

      // Check embed profile origins
      const embedOrigins = getEmbedAllowedOrigins();
      if (embedOrigins.includes(origin) || embedOrigins.includes('*')) {
        return callback(null, true);
      }

      logger.warn(`CORS request blocked from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
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
        databaseService.auditLogAsync(
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
    // Wait for database initialization (critical for PostgreSQL/MySQL where repos are async)
    await databaseService.waitForReady();

    // Per-source scheduler settings are applied to each manager inside the
    // `for (const source of enabledSources)` loop below via applyManagerSettings().
    // Globally-scoped schedulers (Announce, Timer, DistanceDelete, RemoteAdminScanner,
    // TimeSync) self-bootstrap inside their start*Scheduler methods — no action here.

    // NOTE: We no longer mark existing nodes as welcomed on startup.
    // This is now handled when autoWelcomeEnabled is first changed to 'true'
    // via the settings endpoint. This prevents welcoming existing nodes when
    // the feature is enabled after nodes are already in the database.

    // Clear any runtime IP/port overrides from previous sessions
    // These are temporary settings that should reset on container restart
    await databaseService.settings.setSetting('meshtasticNodeIpOverride', '');
    await databaseService.settings.setSetting('meshtasticTcpPortOverride', '');

    // Auto-create default source if none exist
    const sourceCount = await databaseService.sources.getSourceCount();
    if (sourceCount === 0) {
      const env = getEnvironmentConfig();
      if (env.meshtasticNodeIp) {
        await databaseService.sources.createSource({
          id: uuidv4(),
          name: 'Default',
          type: 'meshtastic_tcp',
          config: { host: env.meshtasticNodeIp, port: env.meshtasticTcpPort },
          enabled: true,
        });
        logger.info(`📡 Auto-created default source from environment config`);
      }
    }

    // Assign legacy NULL sourceId rows to the default source (Phase 2 data migration).
    // Safe to run every startup — updates 0 rows after the first run.
    const allSources = await databaseService.sources.getAllSources();
    if (allSources.length > 0) {
      await databaseService.sources.assignNullSourceIds(allSources[0].id);
      logger.debug(`Assigned NULL sourceId rows to default source ${allSources[0].id}`);
    }

    // Start all enabled sources via the registry.
    // The first TCP source also configures the legacy singleton so that all
    // existing non-poll endpoints (which import meshtasticManager directly)
    // continue to work without modification.
    const enabledSources = await databaseService.sources.getEnabledSources();
    let firstTcpSourceConfigured = false;

    for (const source of enabledSources) {
      if (source.type === 'meshtastic_tcp') {
        const cfg = source.config as any;

        // Respect per-source autoConnect flag — when explicitly false, the
        // source is enabled but should not connect automatically; the user
        // must click the manual Connect button to start monitoring.
        if (cfg?.autoConnect === false) {
          logger.info(`Skipping auto-connect for source ${source.id} (${source.name}) — autoConnect disabled`);
          continue;
        }

        try {
          if (!firstTcpSourceConfigured) {
            // Configure the legacy singleton for the first source, then let the
            // registry start it (addManager calls start() → connect()).
            // All legacy API routes use this singleton directly.
            meshtasticManager.configureSource({
              host: cfg.host,
              port: cfg.port,
              heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
              virtualNode: cfg.virtualNode,
            }, source.id);
            await applyManagerSettings(meshtasticManager, source.id, databaseService);
            await sourceManagerRegistry.addManager(meshtasticManager);
            firstTcpSourceConfigured = true;
            logger.debug(`Started primary source manager via singleton: ${source.id}`);
          } else {
            // Additional sources get their own manager instances
            const manager = new MeshtasticManager(source.id, {
              host: cfg.host,
              port: cfg.port,
              heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
              virtualNode: cfg.virtualNode,
            });
            await applyManagerSettings(manager, source.id, databaseService);
            await sourceManagerRegistry.addManager(manager);
          }
        } catch (err) {
          // Don't let one failed source block others from registering.
          // The manager's internal retry logic will reconnect when reachable.
          logger.error(`Failed to start source ${source.id} (${source.name}); continuing with other sources:`, err);
        }
      }
    }

    if (!firstTcpSourceConfigured) {
      // No sources configured — use legacy singleton with env-var config
      await meshtasticManager.connect();
      logger.debug('Meshtastic manager connected (legacy mode, no sources configured)');
    } else {
      logger.debug(`Started ${enabledSources.length} source manager(s)`);
    }

    // Auto-connect MeshCore if enabled via environment variables
    if (process.env.MESHCORE_ENABLED === 'true') {
      const meshcoreConfig = meshcoreManager.getEnvConfig();
      if (meshcoreConfig) {
        logger.info('[MeshCore] Auto-connecting on startup...');
        const connected = await meshcoreManager.connect();
        if (connected) {
          logger.info('[MeshCore] Auto-connected successfully on startup');
        } else {
          logger.warn('[MeshCore] Auto-connect on startup failed — use the MeshCore tab to retry');
        }
      } else {
        logger.warn('[MeshCore] MESHCORE_ENABLED=true but no serial port or TCP host configured');
      }
    }

    // Initialize backup scheduler
    backupSchedulerService.initialize(meshtasticManager);
    logger.debug('Backup scheduler initialized');

    // Initialize duplicate key scanner
    duplicateKeySchedulerService.start();
    logger.debug('Duplicate key scanner initialized');

    // Initialize security digest scheduler
    securityDigestService.initialize(databaseService);
    logger.debug('Security digest service initialized');

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
    const inactiveThresholdHoursRaw = parseInt(await databaseService.settings.getSetting('inactiveNodeThresholdHours') || '24', 10);
    const inactiveCheckIntervalMinutesRaw = parseInt(
      await databaseService.settings.getSetting('inactiveNodeCheckIntervalMinutes') || '60',
      10
    );
    const inactiveCooldownHoursRaw = parseInt(await databaseService.settings.getSetting('inactiveNodeCooldownHours') || '24', 10);

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

    // Auto-delete-by-distance scheduler is now started per-source inside
    // MeshtasticManager.startDistanceDeleteScheduler() as part of the normal
    // scheduler stagger after configComplete.

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
setInterval(async () => {
  try {
    // Long migrations (e.g. on big MySQL telemetry tables) can keep the DB
    // unready well past the first tick — wait before touching repos.
    await databaseService.waitForReady();
    // Get favorite telemetry storage days from settings (defaults to 7 if not set)
    const favoriteDaysStr = await databaseService.settings.getSetting('favoriteTelemetryStorageDays');
    const favoriteDays = favoriteDaysStr ? parseInt(favoriteDaysStr) : 7;
    const purgedCount = await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, favoriteDays);
    if (purgedCount > 0) {
      logger.debug(`⏰ Hourly telemetry purge completed: removed ${purgedCount} records`);
    }
  } catch (error) {
    logger.error('Error during telemetry purge:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Run initial purge on startup
setTimeout(async () => {
  try {
    // Wait for DB ready: on a fresh upgrade, schema migrations (e.g. 032 dedupe
    // on a large MySQL telemetry table) can run longer than this 5s delay,
    // and accessing databaseService.settings before init throws.
    await databaseService.waitForReady();
    // Get favorite telemetry storage days from settings (defaults to 7 if not set)
    const favoriteDaysStr = await databaseService.settings.getSetting('favoriteTelemetryStorageDays');
    const favoriteDays = favoriteDaysStr ? parseInt(favoriteDaysStr) : 7;
    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, favoriteDays);
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
  const autoUpgradeImmediate = await databaseService.settings.getSetting('autoUpgradeImmediate') === 'true';
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
      databaseService.auditLogAsync(
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
import meshcoreManager from './meshcoreManager.js';
import embedProfileRoutes from './routes/embedProfileRoutes.js';
import { createEmbedCspMiddleware } from './middleware/embedMiddleware.js';
import embedPublicRoutes from './routes/embedPublicRoutes.js';
import firmwareUpdateRoutes from './routes/firmwareUpdateRoutes.js';
import sourceRoutes from './routes/sourceRoutes.js';
import unifiedRoutes from './routes/unifiedRoutes.js';
import analysisRoutes from './routes/analysisRoutes.js';
import { firmwareUpdateService } from './services/firmwareUpdateService.js';
import { createGeoJsonRouter } from './routes/geojsonRoutes.js';
import { GeoJsonService } from './services/geojsonService.js';
import { MapStyleService } from './services/mapStyleService.js';
import { createMapStyleRouter } from './routes/mapStyleRoutes.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Health check endpoint (for upgrade watchdog and monitoring)
apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: packageJson.version,
    uptime: Date.now() - serverStartTime,
    databaseType: databaseService.drizzleDbType,
    firmwareOtaEnabled: process.env.IS_DESKTOP !== 'true',
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

// Settings routes (GET/POST/DELETE /settings)
apiRouter.use('/settings', settingsRoutes);

// Embed profile admin routes (admin only)
apiRouter.use('/embed-profiles', embedProfileRoutes);

// Firmware OTA update routes (admin only)
apiRouter.use('/firmware', firmwareUpdateRoutes);

// Sources management routes
apiRouter.use('/sources', sourceRoutes);

// Unified cross-source views
apiRouter.use('/unified', unifiedRoutes);

// Cross-source analysis workspace
apiRouter.use('/analysis', analysisRoutes);

// GeoJSON overlay layer routes
const geojsonDataDir = path.join(process.env.DATA_DIR || '/data', 'geojson');
const geojsonService = new GeoJsonService(geojsonDataDir);
const geojsonRouter = createGeoJsonRouter(geojsonService);
apiRouter.use('/geojson', geojsonRouter);

// MapLibre GL style routes
const mapStyleDataDir = path.join(process.env.DATA_DIR || '/data', 'styles');
const mapStyleService = new MapStyleService(mapStyleDataDir);
const mapStyleRouter = createMapStyleRouter(mapStyleService);
apiRouter.use('/map-styles', mapStyleRouter);

// Wire up side-effect callbacks for settingsRoutes
setSettingsCallbacks({
  refreshTileHostnameCache,
  setTracerouteInterval: (interval) => meshtasticManager.setTracerouteInterval(interval),
  setRemoteAdminScannerInterval: (interval, sourceId) => {
    const mgr = sourceId
      ? (sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager;
    mgr.setRemoteAdminScannerInterval(interval);
  },
  setLocalStatsInterval: (interval) => meshtasticManager.setLocalStatsInterval(interval),
  setKeyRepairSettings: (settings) => meshtasticManager.setKeyRepairSettings(settings),
  restartInactiveNodeService: (threshold, check, cooldown) =>
    inactiveNodeNotificationService.start(threshold, check, cooldown),
  stopInactiveNodeService: () => inactiveNodeNotificationService.stop(),
  restartAnnounceScheduler: (sourceId?: string | null) => {
    if (sourceId) {
      const mgr = sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager | undefined;
      mgr?.restartAnnounceScheduler();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers() as (typeof meshtasticManager)[]) {
        mgr.restartAnnounceScheduler();
      }
    }
  },
  restartTimerScheduler: (sourceId?: string | null) => {
    if (sourceId) {
      const mgr = sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager | undefined;
      mgr?.restartTimerScheduler();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers() as (typeof meshtasticManager)[]) {
        mgr.restartTimerScheduler();
      }
    }
  },
  restartGeofenceEngine: (sourceId?: string | null) => {
    if (sourceId) {
      const mgr = sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager | undefined;
      mgr?.restartGeofenceEngine();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers() as (typeof meshtasticManager)[]) {
        mgr.restartGeofenceEngine();
      }
    }
  },
  handleAutoWelcomeEnabled: () => { databaseService.handleAutoWelcomeEnabledAsync().catch(() => {}); return 0; },
  invalidateHtmlCache,
  restartAutoDeleteByDistanceService: (intervalHours: number) =>
    autoDeleteByDistanceService.start(intervalHours),
  stopAutoDeleteByDistanceService: () => autoDeleteByDistanceService.stop(),
});

// API Routes
/**
 * GET /api/nodes
 * Returns all nodes in the mesh
 */
apiRouter.get('/nodes', optionalAuth(), async (req, res) => {
  try {
    const nodesSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const allNodes = await meshtasticManager.getAllNodesAsync(nodesSourceId);
    const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();

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
    const activeNodesSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const allDbNodes = await databaseService.nodes.getActiveNodes(days, activeNodesSourceId);

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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Allow hours parameter for future use, but default to fetching ALL position history
    // This ensures we capture movement that may have happened long ago
    // Validate hours: must be positive integer, max 8760 (1 year)
    const rawHours = req.query.hours ? parseInt(req.query.hours as string) : null;
    const hoursParam = rawHours !== null && !isNaN(rawHours) && rawHours > 0
      ? Math.min(rawHours, 8760)
      : null;
    const cutoffTime = hoursParam ? Date.now() - hoursParam * 60 * 60 * 1000 : 0;

    // Check privacy for position history — scope to caller's source so the
    // privacy setting reflects this source's node (same nodeNum may exist in
    // multiple sources with different privacy flags).
    const posHistSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : undefined;
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = await databaseService.nodes.getNode(nodeNum, posHistSourceId);
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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

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
apiRouter.post('/nodes/:nodeId/favorite', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { isFavorite, syncToDevice = true, destinationNodeNum, sourceId: favSourceId } = req.body;

    if (typeof isFavorite !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'isFavorite must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for isFavorite parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof favSourceId !== 'string' || favSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
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

    // Update favorite status in database — manual action always locks
    await databaseService.nodes.setNodeFavorite(nodeNum, isFavorite, favSourceId, true);

    // If manually unfavoriting, remove from the per-source auto-favorite tracking list.
    // The per-source manager reads/writes this list via settings.{get,set}SettingForSource
    // scoped to its own sourceId — touching the global key here would leave the per-source
    // list stale and let the sweep re-process the node.
    if (!isFavorite) {
      const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(favSourceId, 'autoFavoriteNodes') || '[]';
      const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
      if (autoFavoriteNodes.includes(nodeNum)) {
        const updated = autoFavoriteNodes.filter(n => n !== nodeNum);
        await databaseService.settings.setSourceSetting(favSourceId, 'autoFavoriteNodes', JSON.stringify(updated));
      }
    }

    // Phase 7: broadcast via the owning source manager's per-source virtual node.
    try {
      if (favSourceId) {
        const mgr = sourceManagerRegistry.getManager(favSourceId) as any;
        if (mgr && typeof mgr.broadcastNodeInfoUpdate === 'function') {
          await mgr.broadcastNodeInfoUpdate(nodeNum);
        }
      } else {
        for (const mgr of sourceManagerRegistry.getAllManagers() as any[]) {
          if (typeof mgr.broadcastNodeInfoUpdate === 'function') {
            await mgr.broadcastNodeInfoUpdate(nodeNum);
          }
        }
      }
    } catch (error) {
      logger.error(`⚠️ Failed to broadcast favorite update to virtual node clients for node ${nodeNum}:`, error);
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      const favManager = (favSourceId ? (sourceManagerRegistry.getManager(favSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
      try {
        if (isFavorite) {
          await favManager.sendFavoriteNode(nodeNum, destinationNodeNum);
        } else {
          await favManager.sendRemoveFavoriteNode(nodeNum, destinationNodeNum);
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

// Toggle favorite lock status (lock/unlock a node from auto-favorite automation)
apiRouter.post('/nodes/:nodeId/favorite-lock', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { locked, sourceId: lockSourceId } = req.body;

    if (typeof locked !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'locked must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for locked parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof lockSourceId !== 'string' || lockSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Convert nodeId (hex string like !a1b2c3d4) to nodeNum (integer)
    const nodeNumStr = nodeId.replace('!', '');

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

    await databaseService.nodes.setNodeFavoriteLocked(nodeNum, locked, lockSourceId);

    // If unlocking, also add to the per-source auto-favorite tracking list if the node is
    // currently favorited on this source, so automation on this source can manage it going
    // forward. Must read/write the per-source key that the sweep actually consults.
    if (!locked) {
      const node = await databaseService.nodes.getNode(nodeNum, lockSourceId);
      if (node?.isFavorite) {
        const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(lockSourceId, 'autoFavoriteNodes') || '[]';
        const autoFavoriteNodes: number[] = JSON.parse(autoFavoriteNodesJson);
        if (!autoFavoriteNodes.includes(nodeNum)) {
          autoFavoriteNodes.push(nodeNum);
          await databaseService.settings.setSourceSetting(lockSourceId, 'autoFavoriteNodes', JSON.stringify(autoFavoriteNodes));
        }
      }
    }

    logger.info(`${locked ? '🔒' : '🔓'} Node ${nodeNum} favorite lock set to: ${locked}`);

    res.json({
      success: true,
      nodeNum,
      locked,
    });
  } catch (error) {
    logger.error('Error setting node favorite lock:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node favorite lock',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Get auto-favorite status (local role, firmware, managed nodes)
apiRouter.get('/auto-favorite/status', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const afSourceId = req.query.sourceId as string | undefined;
    const afManager = afSourceId ? (sourceManagerRegistry.getManager(afSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    // Prefer the manager's in-memory local node (populated at connect time). This avoids
    // the legacy global 'localNodeNum' settings key, which is clobbered across sources.
    const localNodeNumInt = afManager.getLocalNodeInfo()?.nodeNum;
    const localNode = localNodeNumInt ? await databaseService.nodes.getNode(localNodeNumInt, afManager.sourceId) : null;
    const firmwareVersion = afManager.getLocalNodeInfo()?.firmwareVersion || null;
    const supportsFavorites = afManager.supportsFavorites();

    // Read the per-source tracking list (manager writes via setSourceSetting on
    // the same key — global getSetting would return stale/empty data here).
    const autoFavoriteNodesJson = await databaseService.settings.getSettingForSource(afManager.sourceId, 'autoFavoriteNodes') || '[]';
    const autoFavoriteNodeNums: number[] = JSON.parse(autoFavoriteNodesJson);

    // Get node details for each auto-favorited node (scoped to this source)
    const autoFavoriteNodes = (await Promise.all(autoFavoriteNodeNums
      .map(async nodeNum => {
        const node = await databaseService.nodes.getNode(nodeNum, afManager.sourceId);
        if (!node) return null;
        return {
          nodeNum: node.nodeNum,
          nodeId: node.nodeId,
          longName: node.longName,
          shortName: node.shortName,
          role: node.role,
          hopsAway: node.hopsAway,
          lastHeard: node.lastHeard,
          favoriteLocked: Boolean(node.favoriteLocked),
        };
      })))
      .filter(Boolean);

    res.json({
      localNodeRole: localNode?.role ?? null,
      firmwareVersion,
      supportsFavorites,
      autoFavoriteNodes,
    });
  } catch (error) {
    logger.error('Error fetching auto-favorite status:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to fetch auto-favorite status',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set node ignored status (with optional device sync)
apiRouter.post('/nodes/:nodeId/ignored', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
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

    // Per-source blocklist: accept sourceId from body, else fall back to the
    // first source this caller has nodes:write on.
    const ignoreSourceId = await resolveRequestSourceId(req, 'nodes', 'write');
    if (!ignoreSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide a sourceId, or ensure your account has nodes:write on at least one enabled source',
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
    await databaseService.setNodeIgnoredAsync(nodeNum, isIgnored, ignoreSourceId);

    // Phase 7: broadcast via the owning source manager's per-source virtual node.
    try {
      if (ignoreSourceId) {
        const mgr = sourceManagerRegistry.getManager(ignoreSourceId) as any;
        if (mgr && typeof mgr.broadcastNodeInfoUpdate === 'function') {
          await mgr.broadcastNodeInfoUpdate(nodeNum);
        }
      } else {
        for (const mgr of sourceManagerRegistry.getAllManagers() as any[]) {
          if (typeof mgr.broadcastNodeInfoUpdate === 'function') {
            await mgr.broadcastNodeInfoUpdate(nodeNum);
          }
        }
      }
    } catch (error) {
      logger.error(`⚠️ Failed to broadcast ignored update to virtual node clients for node ${nodeNum}:`, error);
    }

    // Sync to device if requested
    let deviceSyncStatus: 'success' | 'failed' | 'skipped' = 'skipped';
    let deviceSyncError: string | undefined;

    if (syncToDevice) {
      const ignoreManager = (ignoreSourceId ? (sourceManagerRegistry.getManager(ignoreSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
      try {
        if (isIgnored) {
          await ignoreManager.sendIgnoredNode(nodeNum, destinationNodeNum);
        } else {
          await ignoreManager.sendRemoveIgnoredNode(nodeNum, destinationNodeNum);
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

// Get per-source ignored nodes list. If `?sourceId=X` is omitted, returns the
// first enabled source the caller has nodes:read on.
apiRouter.get('/ignored-nodes', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const listSourceId = await resolveRequestSourceId(req, 'nodes', 'read');
    if (!listSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide ?sourceId=, or ensure your account has nodes:read on at least one enabled source',
      };
      res.status(400).json(errorResponse);
      return;
    }
    const ignoredNodes = await databaseService.ignoredNodes.getIgnoredNodesAsync(listSourceId);
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

// Remove a node from the per-source ignore list. If `?sourceId=X` is omitted,
// operates on the first enabled source the caller has nodes:write on.
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

    const deleteSourceId = await resolveRequestSourceId(req, 'nodes', 'write');
    if (!deleteSourceId) {
      const errorResponse: ApiErrorResponse = {
        error: 'No permitted source',
        code: 'MISSING_SOURCE_ID',
        details: 'Provide ?sourceId=, or ensure your account has nodes:write on at least one enabled source',
      };
      res.status(400).json(errorResponse);
      return;
    }

    const nodeNum = parseInt(nodeNumStr, 16);

    // Remove from the per-source blocklist + clear the live mirror flag on
    // the matching nodes row. Other sources' blocklists are untouched by design.
    await databaseService.ignoredNodes.removeIgnoredNodeAsync(nodeNum, deleteSourceId);
    try {
      await databaseService.setNodeIgnoredAsync(nodeNum, false, deleteSourceId);
    } catch {
      // Node may not exist in nodes table for this source — OK, table-level removal already succeeded.
    }

    res.json({ success: true, nodeNum, sourceId: deleteSourceId });
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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
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
    const poGetSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? (req.query.sourceId as string)
      : 'default';
    const override = await databaseService.getNodePositionOverrideAsync(nodeNum, poGetSourceId);

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
apiRouter.post('/nodes/:nodeId/position-override', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { enabled, latitude, longitude, altitude, isPrivate, sourceId: poSourceId } = req.body;

    if (typeof poSourceId !== 'string' || poSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request body must include a sourceId string',
      };
      res.status(400).json(errorResponse);
      return;
    }

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
    await databaseService.setNodePositionOverrideAsync(
      nodeNum,
      enabled,
      poSourceId,
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
apiRouter.delete('/nodes/:nodeId/position-override', requirePermission('nodes', 'write', { sourceIdFrom: 'query' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const poDelSourceId = req.query.sourceId as string | undefined;

    if (typeof poDelSourceId !== 'string' || poDelSourceId.length === 0) {
      const errorResponse: ApiErrorResponse = {
        error: 'sourceId is required',
        code: 'MISSING_SOURCE_ID',
        details: 'Request must include sourceId as a query parameter',
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

    // Clear position override in database
    await databaseService.clearNodePositionOverrideAsync(nodeNum, poDelSourceId);

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

    const { sourceId: bodySourceId } = (req.body || {}) as { sourceId?: string };
    const querySourceId = typeof req.query.sourceId === 'string' && req.query.sourceId
      ? (req.query.sourceId as string)
      : undefined;
    const scanSourceId = querySourceId ?? bodySourceId;
    const scanManager = (scanSourceId
      ? (sourceManagerRegistry.getManager(scanSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);

    // Check if the node exists on the scoped source (same nodeNum may exist
    // on other sources that aren't the scan target).
    const node = await databaseService.nodes.getNode(parsedNodeNum, scanSourceId);
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
    const result = await scanManager.scanNodeForRemoteAdmin(parsedNodeNum);

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
apiRouter.get('/nodes/security-issues', optionalAuth(), async (_req, res) => {
  try {
    const nodes = await databaseService.getNodesWithKeySecurityIssuesAsync();
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

    const { sourceId: warnSourceId } = req.body || {};
    const warnManager = (warnSourceId ? (sourceManagerRegistry.getManager(warnSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);

    // Verify the node actually has a security issue on the target source
    // (security flags are per-source — the same nodeNum may be safe on another source).
    const node = await databaseService.nodes.getNode(nodeNum, warnSourceId);
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
    const messageId = await warnManager.sendTextMessage(
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
    // Duplicate detection is scoped per-source — a node on source A sharing a
    // public key with a node on source B is NOT treated as a duplicate, because
    // they may legitimately be the same physical device surfaced by two
    // transports. This matches the background scheduler in
    // duplicateKeySchedulerService which also iterates per-source, and the
    // updateNodeSecurityFlags helper requires a sourceId for correctness under
    // the composite (nodeNum, sourceId) primary key.
    const { detectDuplicateKeys } = await import('../services/lowEntropyKeyService.js');

    const managers = sourceManagerRegistry.getAllManagers() as any[];
    const sourceIds: string[] = managers.length > 0 ? managers.map(m => m.sourceId) : ['default'];

    let totalScanned = 0;
    let totalDuplicateGroups = 0;
    const affectedNodes: number[] = [];

    for (const sourceId of sourceIds) {
      const nodesWithKeys = await databaseService.nodes.getNodesWithPublicKeys(sourceId);
      totalScanned += nodesWithKeys.length;

      const allSourceNodes = await databaseService.nodes.getAllNodes(sourceId);

      // Clear existing duplicate flags for this source
      for (const node of allSourceNodes) {
        if (node.duplicateKeyDetected) {
          const details = node.keyIsLowEntropy ? 'Known low-entropy key detected' : undefined;
          await databaseService.nodes.updateNodeSecurityFlags(
            Number(node.nodeNum),
            false,
            details,
            sourceId,
          );
        }
      }

      const duplicates = detectDuplicateKeys(nodesWithKeys);
      totalDuplicateGroups += duplicates.size;

      const sourceNodeMap = new Map<number, typeof allSourceNodes[0]>(
        allSourceNodes.map(n => [Number(n.nodeNum), n])
      );

      for (const [keyHash, nodeNums] of duplicates) {
        for (const nodeNum of nodeNums) {
          const node = sourceNodeMap.get(Number(nodeNum));
          if (!node) continue;

          const otherNodes = nodeNums.filter(n => n !== nodeNum);
          const details = node.keyIsLowEntropy
            ? `Known low-entropy key; Key shared with nodes: ${otherNodes.join(', ')}`
            : `Key shared with nodes: ${otherNodes.join(', ')}`;

          await databaseService.nodes.updateNodeSecurityFlags(
            Number(nodeNum),
            true,
            details,
            sourceId,
          );
          affectedNodes.push(Number(nodeNum));
        }
        logger.info(`🔐 [${sourceId}] Detected ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
      }
    }

    res.json({
      success: true,
      duplicatesFound: totalDuplicateGroups,
      affectedNodes,
      totalNodesScanned: totalScanned,
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
    const messagesSourceId = req.query.sourceId as string | undefined;
    let messages = await meshtasticManager.getRecentMessages(limit, messagesSourceId);

    // MM-SEC-3: pre-compute the channels this caller may read so we can
    // strip messages from hidden channels even when the caller has the
    // generic `channel_0:read` permission.
    const isAdmin = req.user?.isAdmin === true;
    const authorizedChannelIds = new Set<number>();
    if (isAdmin) {
      for (let id = 0; id <= 7; id++) authorizedChannelIds.add(id);
    } else if (req.user) {
      for (let id = 0; id <= 7; id++) {
        const channelResource = `channel_${id}` as import('../types/permission.js').ResourceType;
        if (await hasPermission(req.user, channelResource, 'read')) authorizedChannelIds.add(id);
      }
    }

    // Filter messages based on permissions.
    // - DMs (channel -1) require `messages:read`.
    // - Channel messages require BOTH the legacy `channel_0:read` gate
    //   above AND a per-channel `channel_${id}:read` for the message's
    //   actual channel.
    messages = messages.filter(msg => {
      if (msg.channel === -1) return hasMessagesRead;
      return hasChannelsRead && (isAdmin || authorizedChannelIds.has(msg.channel));
    });

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
    portnum: msg.portnum ?? undefined,
    timestamp: new Date(msg.rxTime ?? msg.timestamp),
    hopStart: msg.hopStart ?? undefined,
    hopLimit: msg.hopLimit ?? undefined,
    relayNode: msg.relayNode ?? undefined,
    replyId: msg.replyId ?? undefined,
    emoji: msg.emoji ?? undefined,
    viaMqtt: Boolean((msg as any).viaMqtt),
    rxSnr: msg.rxSnr ?? undefined,
    rxRssi: msg.rxRssi ?? undefined,
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
    // Optional source scope — when provided, messages are filtered to that
    // source. Without it, the legacy unscoped behavior is preserved so older
    // clients still work.
    const sourceIdParam = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;

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

    // Fetch limit+1 to accurately detect if more messages exist. When a sourceId
    // is provided, bypass the sync facade (which doesn't accept sourceId) and
    // go directly through the repository so the query is source-scoped.
    const dbMessages = sourceIdParam
      ? (await databaseService.messages.getMessagesByChannel(messageChannel, limit + 1, offset, sourceIdParam)) as DbMessage[]
      : await databaseService.getMessagesByChannelAsync(messageChannel, limit + 1, offset);
    const hasMore = dbMessages.length > limit;
    // Return only the requested limit
    const messages = dbMessages.slice(0, limit).map(transformDbMessageToMeshMessage);
    res.json({ messages, hasMore });
  } catch (error) {
    logger.error('Error fetching channel messages:', error);
    res.status(500).json({ error: 'Failed to fetch channel messages' });
  }
});

apiRouter.get('/messages/direct/:nodeId1/:nodeId2', requirePermission('messages', 'read'), async (req, res) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    // Validate and clamp limit (1-500) and offset (0-50000) to prevent abuse
    const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 100, 500));
    const offset = Math.max(0, Math.min(parseInt(req.query.offset as string) || 0, 50000));
    // Optional source scope — DM threads are per-source (each source has its
    // own view of a node pair). When omitted, returns DMs across every source.
    const sourceIdParam = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    // Fetch limit+1 to accurately detect if more messages exist
    const dbMessages = await databaseService.messages.getDirectMessages(nodeId1, nodeId2, limit + 1, offset, sourceIdParam) as DbMessage[];
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
    const { messageIds, channelId, nodeId, beforeTimestamp, allDMs, sourceId: markReadSourceId } = req.body;
    const markReadManager = markReadSourceId ? (sourceManagerRegistry.getManager(markReadSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;

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
      await databaseService.markMessagesAsReadAsync(messageIds, userId);
      markedCount = messageIds.length;
    } else if (allDMs) {
      // Mark ALL DMs as read
      const localNodeInfo = markReadManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = await databaseService.markAllDMMessagesAsReadAsync(localNodeInfo.nodeId, userId);
    } else if (channelId !== undefined) {
      // Mark all messages in a channel as read (specific channel permission already checked above)
      markedCount = await databaseService.markChannelMessagesAsReadAsync(channelId, userId, beforeTimestamp);
    } else if (nodeId) {
      // Mark all DMs with a node as read (permission already checked above)
      const localNodeInfo = markReadManager.getLocalNodeInfo();
      if (!localNodeInfo) {
        return res.status(500).json({ error: 'Local node not connected' });
      }
      markedCount = await databaseService.markDMMessagesAsReadAsync(localNodeInfo.nodeId, nodeId, userId, beforeTimestamp);
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
    // Optional sourceId scoping — multi-source views must only see unread
    // counts for messages their own source ingested. Without this an inactive
    // source can keep a badge lit for messages that aren't visible in the
    // current source's tab.
    const unreadSourceId = typeof req.query.sourceId === 'string' && req.query.sourceId.length > 0
      ? req.query.sourceId
      : undefined;
    const unreadManager = unreadSourceId
      ? (sourceManagerRegistry.getManager(unreadSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager;
    const localNodeInfo = unreadManager.getLocalNodeInfo();

    const result: {
      channels?: { [channelId: number]: number };
      directMessages?: { [nodeId: string]: number };
    } = {};

    // Load mute preferences for the current user (if authenticated)
    let mutedChannelIds: Set<number> = new Set();
    let mutedDMNodeIds: Set<string> = new Set();
    if (userId) {
      const { getUserNotificationPreferencesAsync } = await import('./utils/notificationFiltering.js');
      const prefs = await getUserNotificationPreferencesAsync(userId);
      if (prefs) {
        const now = Date.now();
        for (const rule of (prefs.mutedChannels ?? [])) {
          if (rule.muteUntil === null || rule.muteUntil > now) {
            mutedChannelIds.add(rule.channelId);
          }
        }
        for (const rule of (prefs.mutedDMs ?? [])) {
          if (rule.muteUntil === null || rule.muteUntil > now) {
            mutedDMNodeIds.add(rule.nodeUuid);
          }
        }
      }
    }

    // Get channel unread counts if user has channels permission
    // Only count incoming messages (exclude messages sent by our node)
    if (hasChannelsRead) {
      const rawCounts = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId, unreadSourceId);

      // MM-SEC-3: filter by per-channel read permission as well as mute prefs.
      // The bare `channel_0:read` gate above lets a viewer reach this handler
      // but they must not learn unread counts for channels they cannot read.
      const isAdmin = req.user?.isAdmin === true;
      const channels: { [channelId: number]: number } = {};
      for (const [channelIdStr, count] of Object.entries(rawCounts)) {
        const channelId = Number(channelIdStr);
        if (mutedChannelIds.has(channelId)) continue;
        if (!isAdmin && req.user) {
          const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
          if (!(await hasPermission(req.user, channelResource, 'read'))) continue;
        } else if (!req.user && !isAdmin) {
          continue;
        }
        channels[channelId] = count as number;
      }
      result.channels = channels;
    }

    // Get DM unread counts if user has messages permission (batch query)
    if (hasMessagesRead && localNodeInfo) {
      const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId, unreadSourceId);
      const allNodes = await unreadManager.getAllNodesAsync(unreadSourceId);
      const visibleNodes = await filterNodesByChannelPermission(allNodes, req.user);
      const visibleNodeIds = new Set(visibleNodes.map(n => n.user?.id).filter(Boolean));
      const directMessages: { [nodeId: string]: number } = {};
      for (const [nodeId, count] of Object.entries(allUnreadDMs)) {
        // Filter out muted DMs
        if (visibleNodeIds.has(nodeId) && count > 0 && !mutedDMNodeIds.has(nodeId)) {
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

// Get Virtual Node server status per source (requires authentication)
apiRouter.get('/virtual-node/status', requireAuth(), (_req, res) => {
  try {
    const managers = sourceManagerRegistry.getAllManagers() as any[];
    const sources = managers.map((mgr) => {
      const vn = mgr.virtualNodeServer;
      const status = mgr.getStatus?.();
      const sourceId = status?.sourceId ?? mgr.sourceId;
      const sourceName = status?.sourceName ?? sourceId;
      if (!vn) {
        return {
          sourceId,
          sourceName,
          enabled: false,
          isRunning: false,
          allowAdminCommands: false,
          clientCount: 0,
          clients: [],
        };
      }
      return {
        sourceId,
        sourceName,
        enabled: true,
        isRunning: vn.isRunning(),
        allowAdminCommands: vn.isAdminCommandsAllowed(),
        clientCount: vn.getClientCount(),
        clients: vn.getClientDetails(),
      };
    });

    res.json({ sources });
  } catch (error) {
    logger.error('Error getting virtual node status:', error);
    res.status(500).json({ error: 'Failed to get virtual node status' });
  }
});

// MM-SEC-6: legacy `/api/channels/debug` removed.
// The route was a `SELECT *` pass-through gated on the unrelated
// `messages:read` permission, so any user with `messages:read` (granted to
// anonymous in the standard public-viewer config) received the raw `psk`
// column for every channel — bypassing the per-channel `channel_${id}:read`
// gate and `transformChannel` projection that MM-SEC-2 established as the
// pattern for read-class channel endpoints. The route had no UI consumers;
// `/api/channels` and `/api/channels/all` cover the legitimate use case.

// Get all channels (unfiltered, for export/config purposes)
// MM-SEC-2: Per-row permission gate + transformChannel projection so the
// raw `psk` column never appears in any HTTP response. Anonymous callers
// only see channels they have `channel_${id}:read` for; admins see all.
apiRouter.get('/channels/all', optionalAuth(), async (req, res) => {
  try {
    const allChannelsSourceId = req.query.sourceId as string | undefined;
    const allChannels = await databaseService.channels.getAllChannels(allChannelsSourceId);
    const isAdmin = req.user?.isAdmin === true;

    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read')) {
        accessible.push(channel);
      }
    }

    logger.debug(`📡 Serving ${accessible.length} channels (per-row filtered, of ${allChannels.length} total)`);
    res.json(accessible.map(transformChannel));
  } catch (error) {
    logger.error('Error fetching all channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

apiRouter.get('/channels', optionalAuth(), async (req, res) => {
  try {
    const channelsSourceId = req.query.sourceId as string | undefined;
    const allChannels = await databaseService.channels.getAllChannels(channelsSourceId);
    const isAdmin = req.user?.isAdmin === true;

    // Per-row permission gate (MM-SEC-2). Build the authorized set first.
    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read')) {
        accessible.push(channel);
      }
    }

    // Channel 0 will be created automatically when device config syncs
    // It should have an empty name as per Meshtastic protocol

    // Filter accessible channels to only show configured ones
    // Meshtastic supports channels 0-7 (8 total)
    const filteredChannels = accessible.filter(channel => {
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
    res.json(filteredChannels.map(transformChannel));
  } catch (error) {
    logger.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// Export a specific channel configuration
apiRouter.get('/channels/:id/export', requireAuth(), async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // MM-SEC-4: gate per-channel. Export includes the raw PSK, so the caller
    // must have read permission for the SPECIFIC channel they're exporting,
    // not just channel_0.
    const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'read'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'read' },
      });
    }

    const channel = await databaseService.channels.getChannelById(channelId);
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

/**
 * Detect channel moves/swaps by comparing PSKs before and after a change.
 * Returns an array of {from, to} slot pairs indicating where channels moved.
 */
function detectChannelMoves(
  before: { id: number; psk?: string | null }[],
  after: { id: number; psk?: string | null }[]
): { from: number; to: number }[] {
  const moves: { from: number; to: number }[] = [];

  for (const oldCh of before) {
    if (!oldCh.psk || oldCh.psk === '') continue;
    const newCh = after.find(ch => ch.psk === oldCh.psk && ch.id !== oldCh.id);
    if (newCh) {
      // This PSK moved from oldCh.id to newCh.id
      // Avoid duplicates (swap would register A→B and B→A)
      if (!moves.find(m => m.from === newCh.id && m.to === oldCh.id)) {
        moves.push({ from: oldCh.id, to: newCh.id });
      }
    }
  }

  return moves;
}

/**
 * Snapshot channel slots and migrate messages after a channel configuration change.
 * Call snapshotBefore() before applying changes, then migrateIfNeeded() after.
 */
async function snapshotChannelsBeforeChange() {
  return (await databaseService.channels.getAllChannels()).map(ch => ({ id: ch.id, psk: ch.psk }));
}

async function migrateMessagesIfChannelsMoved(beforeSnapshot: { id: number; psk?: string | null }[]) {
  try {
    const afterSnapshot = (await databaseService.channels.getAllChannels()).map(ch => ({ id: ch.id, psk: ch.psk }));
    const moves = detectChannelMoves(beforeSnapshot, afterSnapshot);
    if (moves.length > 0) {
      logger.info(`📦 Detected channel move(s): ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
      await databaseService.messages.migrateMessagesForChannelMoves(moves);
      await migrateAutomationChannels(
        moves,
        (key) => databaseService.settings.getSetting(key),
        (key, value) => databaseService.settings.setSetting(key, value)
      );
    }
  } catch (error) {
    logger.error('📦 Failed to migrate messages after channel change:', error);
    // Don't fail the channel operation — message migration is best-effort
  }
}

// Update a channel configuration
apiRouter.put('/channels/:id', requireAuth(), async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0 || channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID. Must be between 0-7' });
    }

    // MM-SEC-4: per-channel write gate — caller needs write permission for
    // the SPECIFIC channel they're modifying, not just channel_0.
    const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'write' },
      });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision, sourceId: chanSourceId } = req.body;

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
    const existingChannel = await databaseService.channels.getChannelById(channelId);
    if (!existingChannel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Snapshot channels before change for message migration
    const beforeSnapshot = await snapshotChannelsBeforeChange();

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

    // Update channel in database. Scope to the requesting source so each
    // source's channel row is independent. `allowBlankName: true` lets the
    // user clear a stored channel name — without it, the ingest-protection
    // coalesce in upsertChannel silently keeps the old name (#1567 backfire).
    await databaseService.channels.upsertChannel(
      updatedChannelData,
      typeof chanSourceId === 'string' && chanSourceId.length > 0 ? chanSourceId : undefined,
      { allowBlankName: true },
    );

    // Send channel configuration to Meshtastic device
    const chanUpdateManager = (chanSourceId
      ? (sourceManagerRegistry.getManager(chanSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    try {
      await chanUpdateManager.setChannelConfig(channelId, {
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

    // Migrate messages if channel PSK moved to a different slot
    await migrateMessagesIfChannelsMoved(beforeSnapshot);

    const updatedChannel = await databaseService.channels.getChannelById(channelId);
    logger.info(`✅ Updated channel ${channelId}: ${name}`);
    res.json({ success: true, channel: updatedChannel });
  } catch (error) {
    logger.error('Error updating channel:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Delete a channel's messages and database record
apiRouter.delete('/channels/:id', requireAuth(), async (req, res) => {
  try {
    const channelId = parseInt(req.params.id);
    if (isNaN(channelId) || channelId < 0 || channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID (0-7)' });
    }
    if (channelId === 0) {
      return res.status(400).json({ error: 'Cannot delete primary channel' });
    }

    // MM-SEC-4: per-channel write gate.
    const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: channelResource, action: 'write' },
      });
    }

    // sourceId is required so the channel and its messages are removed from a single source
    const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
    if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '' || typeof rawSourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const deleteChannelSourceId: string = rawSourceId;

    // Purge messages for this channel (scoped to the chosen source)
    const deletedCount = await databaseService.messages.purgeChannelMessages(channelId, deleteChannelSourceId);
    // Delete the channel record (scoped to the chosen source)
    await databaseService.channels.deleteChannel(channelId, deleteChannelSourceId);

    logger.info(`🗑️ Deleted channel ${channelId} (source=${deleteChannelSourceId}): ${deletedCount} messages purged`);
    res.json({ success: true, message: `Channel ${channelId} deleted`, sourceId: deleteChannelSourceId, messagesDeleted: deletedCount });
  } catch (error) {
    logger.error('Error deleting channel:', error);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// Import a channel configuration to a specific slot
apiRouter.post('/channels/:slotId/import', requireAuth(), async (req, res) => {
  try {
    const slotId = parseInt(req.params.slotId);
    if (isNaN(slotId) || slotId < 0 || slotId > 7) {
      return res.status(400).json({ error: 'Invalid slot ID. Must be between 0-7' });
    }

    // MM-SEC-4: per-channel write gate. Importing a channel into slot N
    // overwrites slot N — caller needs write permission for that slot.
    const slotResource = `channel_${slotId}` as import('../types/permission.js').ResourceType;
    if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, slotResource, 'write'))) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        code: 'FORBIDDEN',
        required: { resource: slotResource, action: 'write' },
      });
    }

    const { channel, sourceId: importSourceId } = req.body;

    if (!channel || typeof channel !== 'object') {
      return res.status(400).json({ error: 'Invalid import data. Expected channel object' });
    }

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = channel;

    // Validate name type/length but allow empty string (parity with PUT /channels/:id;
    // Meshtastic protocol allows blank slot-0 names — display falls back to "Primary").
    if (typeof name !== 'string') {
      return res.status(400).json({ error: 'Channel name must be a string' });
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

    // Snapshot channels before change for message migration
    const beforeSnapshot = await snapshotChannelsBeforeChange();

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
    await databaseService.channels.upsertChannel(importedChannelData);

    // Send channel configuration to Meshtastic device
    const importManager = (importSourceId
      ? (sourceManagerRegistry.getManager(importSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    try {
      await importManager.setChannelConfig(slotId, {
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

    // Migrate messages if channel PSK moved to a different slot
    await migrateMessagesIfChannelsMoved(beforeSnapshot);

    const importedChannel = await databaseService.channels.getChannelById(slotId);
    logger.info(`✅ Imported channel to slot ${slotId}: ${name}`);
    res.json({ success: true, channel: importedChannel });
  } catch (error) {
    logger.error('Error importing channel:', error);
    res.status(500).json({ error: 'Failed to import channel' });
  }
});

// Reorder device channel slots (drag-and-drop)
apiRouter.post('/channels/reorder', requireAuth(), async (req, res) => {
  try {
    const { newOrder, sourceId: reorderSourceId } = req.body;

    // Validate: newOrder must be an array of 8 slot indices [0-7], each used exactly once
    if (!Array.isArray(newOrder) || newOrder.length !== 8) {
      return res.status(400).json({ error: 'newOrder must be an array of 8 slot indices' });
    }
    const sorted = [...newOrder].sort();
    if (sorted.some((v, i) => v !== i)) {
      return res.status(400).json({ error: 'newOrder must contain each slot index 0-7 exactly once' });
    }

    // Check if anything actually changed
    const isIdentity = newOrder.every((v: number, i: number) => v === i);
    if (isIdentity) {
      return res.json({ success: true, requiresReboot: false });
    }

    // MM-SEC-4: per-channel write gate. Reorder rewrites every slot whose
    // contents change; for each one, the caller must have write permission.
    // (Affected set is symmetric for permutations, so checking the destination
    // slots covers the source slots too.)
    if (!req.user?.isAdmin) {
      const affectedSlots = new Set<number>();
      for (let i = 0; i < newOrder.length; i++) {
        if (newOrder[i] !== i) {
          affectedSlots.add(i);
          affectedSlots.add(newOrder[i] as number);
        }
      }
      for (const slot of affectedSlots) {
        const slotResource = `channel_${slot}` as import('../types/permission.js').ResourceType;
        if (!(req.user && await hasPermission(req.user, slotResource, 'write'))) {
          return res.status(403).json({
            error: 'Insufficient permissions',
            code: 'FORBIDDEN',
            required: { resource: slotResource, action: 'write' },
            message: `Reorder requires write permission for every affected channel slot (missing: channel_${slot})`,
          });
        }
      }
    }

    const allChannels = await databaseService.channels.getAllChannels();

    // Build the new channel configs based on the reorder mapping
    // newOrder[newSlot] = oldSlot — means "new slot i gets the channel from old slot newOrder[i]"
    const channelsBySlot = new Map(allChannels.map(ch => [ch.id, ch]));

    // Begin edit settings transaction
    const reorderManager = (reorderSourceId
      ? (sourceManagerRegistry.getManager(reorderSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    logger.info(`🔄 Beginning channel reorder: ${newOrder.join(',')}`);
    await reorderManager.beginEditSettings();
    // Pacing: device firmware silently drops admin packets that arrive too soon
    // after BeginEditSettings on TCP PhoneAPI. See /channels/import-config for details.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (let newSlot = 0; newSlot < 8; newSlot++) {
      const oldSlot = newOrder[newSlot];
      if (oldSlot === newSlot) continue; // No change for this slot

      const sourceChannel = channelsBySlot.get(oldSlot);
      // Slot 0 is always primary, others secondary
      const role = newSlot === 0 ? 1 : (sourceChannel?.role === 1 ? 2 : (sourceChannel?.role ?? 0));

      if (sourceChannel && sourceChannel.role !== 0) {
        await reorderManager.setChannelConfig(newSlot, {
          name: sourceChannel.name || '',
          psk: sourceChannel.psk || undefined,
          role,
          uplinkEnabled: sourceChannel.uplinkEnabled ?? true,
          downlinkEnabled: sourceChannel.downlinkEnabled ?? true,
          positionPrecision: sourceChannel.positionPrecision ?? undefined,
        });

        // Update database
        await databaseService.channels.upsertChannel({
          id: newSlot,
          name: sourceChannel.name || '',
          psk: sourceChannel.psk,
          role,
          uplinkEnabled: sourceChannel.uplinkEnabled,
          downlinkEnabled: sourceChannel.downlinkEnabled,
          positionPrecision: sourceChannel.positionPrecision,
        });
      } else {
        // Empty/disabled slot
        await reorderManager.setChannelConfig(newSlot, {
          name: '',
          psk: undefined,
          role: 0,
        });
        await databaseService.channels.upsertChannel({
          id: newSlot,
          name: '',
          psk: null,
          role: 0,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Pacing: leave time for the last SetChannel to be processed before commit.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Commit to device
    await reorderManager.commitEditSettings();
    logger.info(`✅ Channel reorder committed`);

    // Migrate messages — derive moves directly from newOrder mapping
    // newOrder[newSlot] = oldSlot, so messages on oldSlot should move to newSlot
    const moves: { from: number; to: number }[] = [];
    for (let newSlot = 0; newSlot < 8; newSlot++) {
      const oldSlot = newOrder[newSlot];
      if (oldSlot !== newSlot) {
        moves.push({ from: oldSlot, to: newSlot });
      }
    }
    if (moves.length > 0) {
      logger.info(`📦 Channel reorder message migration: ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
      try {
        await databaseService.messages.migrateMessagesForChannelMoves(moves);
      } catch (error) {
        logger.error('📦 Failed to migrate messages after channel reorder:', error);
      }
      try {
        await databaseService.auth.migratePermissionsForChannelMoves(moves);
        logger.info(`🔑 Permission migration complete for channel reorder`);
      } catch (error) {
        logger.error('🔑 Failed to migrate permissions after channel reorder:', error);
      }
    }

    res.json({ success: true, requiresReboot: true });
  } catch (error) {
    logger.error('Error reordering channels:', error);
    res.status(500).json({ error: 'Failed to reorder channels' });
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
    const { channelIds, includeLoraConfig, sourceId: encodeUrlSourceId } = req.body;
    const encodeUrlManager = encodeUrlSourceId ? (sourceManagerRegistry.getManager(encodeUrlSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Get selected channels from database
    const channelResults = await Promise.all(
      channelIds.map((id: number) => databaseService.channels.getChannelById(id))
    );
    const channels = channelResults
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
      const deviceConfig = await encodeUrlManager.getDeviceConfig();
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
    const { url: configUrl, sourceId: configSourceId } = req.body;

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
    const configImportManager = (configSourceId
      ? (sourceManagerRegistry.getManager(configSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    try {
      logger.info(`🔄 Beginning edit settings transaction for import`);
      await configImportManager.beginEditSettings();
      // Allow device time to enter edit mode and ack back before sending config messages.
      // Empirically: 500ms is too short — device firmware silently drops the first
      // SetChannel that follows BeginEditSettings on TCP PhoneAPI under contention.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      logger.info(`✅ Edit settings transaction started`);
    } catch (error) {
      logger.error(`❌ Failed to begin edit settings transaction:`, error);
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start configuration transaction: ${errMsg}`);
    }

    // Snapshot channels before change for message migration
    const beforeSnapshot = await snapshotChannelsBeforeChange();

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
          await configImportManager.setChannelConfig(i, {
            name: channel.name || '',
            psk: channel.psk === 'none' ? undefined : channel.psk,
            role: role,
            uplinkEnabled: channel.uplinkEnabled,
            downlinkEnabled: channel.downlinkEnabled,
            positionPrecision: channel.positionPrecision,
          });

          // Allow device time to process channel config before sending the next message
          await new Promise((resolve) => setTimeout(resolve, 1000));
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
        await configImportManager.setLoRaConfig(loraConfigToImport);
        // LoRa config triggers heavier processing (frequency calculations, radio reconfiguration)
        // so allow extra time before committing
        await new Promise((resolve) => setTimeout(resolve, 1500));
        loraImported = true;
        requiresReboot = true; // LoRa config requires reboot when committed
        logger.info(`✅ Imported LoRa config`);
      } catch (error) {
        logger.error(`❌ Failed to import LoRa config:`, error);
      }
    }

    // Migrate messages before device reboots — build "after" from decoded config
    // since the DB won't be updated until device reconnects
    if (decoded.channels && decoded.channels.length > 0) {
      const afterSnapshot = decoded.channels.map((ch: any, i: number) => ({
        id: i,
        psk: ch.psk === 'none' ? null : (ch.psk || null),
      }));
      const moves = detectChannelMoves(beforeSnapshot, afterSnapshot);
      if (moves.length > 0) {
        logger.info(`📦 Detected channel move(s) from config import: ${moves.map(m => `${m.from}→${m.to}`).join(', ')}`);
        try {
          await databaseService.messages.migrateMessagesForChannelMoves(moves);
          await migrateAutomationChannels(
            moves,
            (key) => databaseService.settings.getSetting(key),
            (key, value) => databaseService.settings.setSetting(key, value)
          );
        } catch (error) {
          logger.error('📦 Failed to migrate messages after config import:', error);
        }
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
      await configImportManager.commitEditSettings();
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
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to import configuration: ${errMsg}` });
  }
});

apiRouter.get('/stats', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const statsSourceId = req.query.sourceId as string | undefined;
    const messageCount = await databaseService.messages.getMessageCount(statsSourceId);
    const nodeCount = await databaseService.nodes.getNodeCount(statsSourceId);
    const channelCount = await databaseService.channels.getChannelCount(statsSourceId);
    const messagesByDay = await databaseService.getMessagesByDayAsync(7, statsSourceId);

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

apiRouter.post('/export', requireAdmin(), async (_req, res) => {
  try {
    const data = await databaseService.exportDataAsync();
    res.json(data);
  } catch (error) {
    logger.error('Error exporting data:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

apiRouter.post('/import', requireAdmin(), async (req, res) => {
  try {
    const data = req.body;
    await databaseService.importDataAsync(data);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error importing data:', error);
    res.status(500).json({ error: 'Failed to import data' });
  }
});

apiRouter.post('/cleanup/messages', requireAdmin(), async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const cleanupSourceId = req.body.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupOldMessagesAsync(days, cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Failed to cleanup messages' });
  }
});

apiRouter.post('/cleanup/nodes', requireAdmin(), async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 30;
    const cleanupSourceId = req.body.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupInactiveNodesAsync(days, cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up nodes:', error);
    res.status(500).json({ error: 'Failed to cleanup nodes' });
  }
});

apiRouter.post('/cleanup/channels', requireAdmin(), async (req, res) => {
  try {
    const cleanupSourceId = req.body?.sourceId as string | undefined;
    const deletedCount = await databaseService.cleanupInvalidChannelsAsync(cleanupSourceId);
    res.json({ deletedCount });
  } catch (error) {
    logger.error('Error cleaning up channels:', error);
    res.status(500).json({ error: 'Failed to cleanup channels' });
  }
});

// Send message endpoint
apiRouter.post('/messages/send', optionalAuth(), async (req, res) => {
  try {
    const { text, channel, destination, replyId, emoji, sourceId: reqSourceId } = req.body;
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

    // For DMs, use the channel we last heard the target node on (from NodeInfo).
    // Scope the lookup to the source that will actually send the message so the
    // channel reflects the correct mesh — a node may be on different channels
    // across sources.
    if (destinationNum) {
      const targetNode = await databaseService.nodes.getNode(destinationNum, reqSourceId);
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

    // Route to the correct source manager when sourceId is provided
    const activeManager = (reqSourceId
      ? (sourceManagerRegistry.getManager(reqSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);

    // Send the message to the mesh network (with optional destination for DMs, replyId, and emoji flag)
    // Note: sendTextMessage() now handles saving the message to the database
    // Pass userId so sent messages are automatically marked as read for the sender
    await activeManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Traceroute endpoint
apiRouter.post('/traceroute', requirePermission('traceroute', 'write'), async (req, res) => {
  try {
    const { destination, sourceId: traceSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel — scope to this source so the channel
    // reflects the mesh this traceroute will actually traverse.
    const node = await databaseService.nodes.getNode(destinationNum, traceSourceId);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const traceManager = (traceSourceId
      ? (sourceManagerRegistry.getManager(traceSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    await traceManager.sendTraceroute(destinationNum, channel);
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
    const { destination, sourceId: posSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel (scoped to this source)
    const node = await databaseService.nodes.getNode(destinationNum, posSourceId);
    // Use explicit channel from request if provided and valid (0-7), otherwise fall back to node's stored channel
    const channel = (typeof req.body.channel === 'number' && req.body.channel >= 0 && req.body.channel <= 7)
      ? req.body.channel
      : (node?.channel ?? 0);

    const posManager = (posSourceId
      ? (sourceManagerRegistry.getManager(posSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    const { packetId, requestId } = await posManager.sendPositionRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = posManager.getLocalNodeInfo();
    logger.info(
      `📍 localNodeInfo for system message: ${
        localNodeInfo ? `nodeId=${localNodeInfo.nodeId}, nodeNum=${localNodeInfo.nodeNum}` : 'NULL'
      }`
    );

    const isBroadcast = destinationNum === 0xFFFFFFFF;

    if (localNodeInfo) {
      // Create a system message to record the position request using the actual packet ID and requestId
      const messageId = `${packetId}`;
      const timestamp = Date.now();

      // For DMs (channel 0), store as channel -1 to show in DM conversation
      const messageChannel = channel === 0 ? -1 : channel;

      logger.info(
        `📍 Inserting position request system message to database: ${messageId} (channel: ${messageChannel}, packetId: ${packetId}, requestId: ${requestId}, broadcast: ${isBroadcast})`
      );
      await databaseService.messages.insertMessage({
        id: messageId,
        fromNodeNum: localNodeInfo.nodeNum,
        toNodeNum: destinationNum,
        fromNodeId: localNodeInfo.nodeId,
        toNodeId: `!${destinationNum.toString(16).padStart(8, '0')}`,
        text: isBroadcast ? 'Position broadcast sent' : 'Position exchange requested',
        channel: messageChannel,
        portnum: PortNum.TEXT_MESSAGE_APP, // Shows in DM view (DM filter requires TEXT_MESSAGE_APP)
        // Broadcast packets don't get ACKed, so omit requestId to avoid permanent pending state
        ...(isBroadcast ? {} : { requestId: requestId }),
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

// NodeInfo request endpoint (Exchange Node Info - triggers key exchange)
apiRouter.post('/nodeinfo/request', requirePermission('messages', 'write'), async (req, res) => {
  try {
    const { destination, sourceId: niSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel (scoped to this source)
    const node = await databaseService.nodes.getNode(destinationNum, niSourceId);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const niManager = (niSourceId
      ? (sourceManagerRegistry.getManager(niSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    const { packetId, requestId } = await niManager.sendNodeInfoRequest(destinationNum, channel);

    // Get local node info to create system message
    const localNodeInfo = niManager.getLocalNodeInfo();
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
      await databaseService.messages.insertMessage({
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
// Rate limit: one request per destination every 180 seconds (firmware limit is ~3 minutes)
const neighborInfoRequestTimestamps = new Map<number, number>();
const NEIGHBOR_INFO_RATE_LIMIT_MS = 180_000;

apiRouter.post('/neighborinfo/request', requirePermission('traceroute', 'write'), async (req, res) => {
  try {
    const { destination } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Eligibility check: only allow requests to local node or 0-hop nodes
    const { sourceId: neighborSourceId } = req.body;
    const neighborManager = (neighborSourceId
      ? (sourceManagerRegistry.getManager(neighborSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    const localNodeNum = neighborManager.getLocalNodeInfo()?.nodeNum;
    // Scope to the target source so hopsAway/channel reflect this mesh
    const node = await databaseService.nodes.getNode(destinationNum, neighborSourceId);
    const isLocalNode = localNodeNum != null && Number(destinationNum) === Number(localNodeNum);
    const isDirectNode = node != null && node.hopsAway != null && Number(node.hopsAway) === 0;

    if (!isLocalNode && !isDirectNode) {
      return res.status(403).json({
        error: 'Neighbor info requests are only allowed for the local node or directly-heard (0-hop) nodes',
        eligible: false,
      });
    }

    // Rate limiting per destination
    const lastRequest = neighborInfoRequestTimestamps.get(Number(destinationNum));
    const now = Date.now();
    if (lastRequest) {
      if ((now - lastRequest) < NEIGHBOR_INFO_RATE_LIMIT_MS) {
        const retryAfter = Math.ceil((NEIGHBOR_INFO_RATE_LIMIT_MS - (now - lastRequest)) / 1000);
        return res.status(429).json({
          error: 'Rate limited: firmware limits neighbor info responses to once per 3 minutes',
          retryAfter,
        });
      }
      // Expired entry — clean up
      neighborInfoRequestTimestamps.delete(Number(destinationNum));
    }

    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const { packetId, requestId } = await neighborManager.sendNeighborInfoRequest(destinationNum, channel);
    neighborInfoRequestTimestamps.set(Number(destinationNum), now);

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
    const { destination, telemetryType, sourceId: telSourceId } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Destination node number is required' });
    }

    // Validate telemetry type if provided
    const validTypes = ['device', 'environment', 'airQuality', 'power'];
    if (telemetryType && !validTypes.includes(telemetryType)) {
      return res.status(400).json({ error: `Invalid telemetry type. Must be one of: ${validTypes.join(', ')}` });
    }

    const destinationNum = typeof destination === 'string' ? parseInt(destination, 16) : destination;

    // Look up the node to get its channel (scoped to this source)
    const node = await databaseService.nodes.getNode(destinationNum, telSourceId);
    const channel = node?.channel ?? 0; // Default to 0 if node not found or channel not set

    const telManager = (telSourceId
      ? (sourceManagerRegistry.getManager(telSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    const { packetId, requestId } = await telManager.sendTelemetryRequest(
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
apiRouter.get('/traceroutes/recent', async (req, res) => {
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
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      // Ensure a reasonable minimum
      limit = Math.max(limit, 100);
    }

    const recentSourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    const allTraceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, recentSourceId);

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
    // Scope to a specific source when provided so multi-source deployments
    // don't conflate traceroute history for the same node pair across
    // unrelated transports (e.g. local TCP vs MQTT).
    const historySourceId = req.query.sourceId as string | undefined;

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

    const traceroutes = await databaseService.traceroutes.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit, historySourceId);

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

// Get longest active route segment (within last 7 days), scoped per source.
apiRouter.get('/route-segments/longest-active', requirePermission('info', 'read'), async (req, res) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    const segment = await databaseService.traceroutes.getLongestActiveRouteSegment(segSourceId);
    if (!segment) {
      res.json(null);
      return;
    }

    // Enrich with node names, scoped to the same source as the segment so
    // display data doesn't bleed between sources.
    const fromNode = await databaseService.nodes.getNode(segment.fromNodeNum, segSourceId);
    const toNode = await databaseService.nodes.getNode(segment.toNodeNum, segSourceId);

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

// Get record holder route segment, scoped per source.
apiRouter.get('/route-segments/record-holder', requirePermission('info', 'read'), async (req, res) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    const segment = await databaseService.traceroutes.getRecordHolderRouteSegment(segSourceId);
    if (!segment) {
      res.json(null);
      return;
    }

    // Enrich with node names, scoped to the same source as the segment.
    const fromNode = await databaseService.nodes.getNode(segment.fromNodeNum, segSourceId);
    const toNode = await databaseService.nodes.getNode(segment.toNodeNum, segSourceId);

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

// Clear record holder route segment, scoped per source so clearing one source
// doesn't wipe another source's record holder.
apiRouter.delete('/route-segments/record-holder', requirePermission('info', 'write'), async (req, res) => {
  try {
    const segSourceId = req.query.sourceId as string | undefined;
    await databaseService.clearRecordHolderSegmentAsync(segSourceId);
    res.json({ success: true, message: 'Record holder cleared' });
  } catch (error) {
    logger.error('Error clearing record holder:', error);
    res.status(500).json({ error: 'Failed to clear record holder' });
  }
});

// Helper to get effective position (respecting overrides) — see
// `getEffectiveDbNodePosition` in utils/nodeEnhancer for the canonical impl.
const getEffectivePosition = (node: Awaited<ReturnType<typeof databaseService.nodes.getNode>>) =>
  getEffectiveDbNodePosition(node);

// Get all neighbor info (latest per node pair)
apiRouter.get('/neighbor-info', requirePermission('info', 'read'), async (req, res) => {
  try {
    const neighborInfoSourceId = req.query.sourceId as string | undefined;
    const neighborInfo = databaseService.getLatestNeighborInfoPerNodeScoped(neighborInfoSourceId);

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    // Build a set of all link keys for bidirectionality detection
    const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

    // Enrich with node names, bidirectionality, and filter by node age.
    // Scope node lookups to the same source as the neighbor info query so
    // name/position/lastHeard data match the mesh the caller is viewing.
    const enrichedNeighborInfo = (await Promise.all(neighborInfo
      .map(async ni => {
        const node = await databaseService.nodes.getNode(ni.nodeNum, neighborInfoSourceId);
        const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum, neighborInfoSourceId);
        const nodePos = getEffectivePosition(node);
        const neighborPos = getEffectivePosition(neighbor);

        return {
          ...ni,
          nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
          nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
          neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
          bidirectional: linkKeys.has(`${ni.neighborNodeNum}-${ni.nodeNum}`),
          nodeLatitude: nodePos.latitude,
          nodeLongitude: nodePos.longitude,
          neighborLatitude: neighborPos.latitude,
          neighborLongitude: neighborPos.longitude,
          node,
          neighbor,
        };
      })))
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
apiRouter.get('/neighbor-info/:nodeNum', requirePermission('info', 'read'), async (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum);
    const neighborSourceId = req.query.sourceId as string | undefined;
    const neighborInfo = await databaseService.getNeighborsForNodeAsync(nodeNum, neighborSourceId);

    // Enrich with node names. Scope to the same source as the neighbor
    // query so position/name data matches the mesh the caller is viewing.
    const enrichedNeighborInfo = await Promise.all(neighborInfo.map(async ni => {
      const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum, neighborSourceId);
      const neighborPos = getEffectivePosition(neighbor);

      return {
        ...ni,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
      };
    }));

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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const telSourceId = req.query.sourceId as string | undefined;

    // Calculate cutoff timestamp for filtering
    const cutoffTime = Date.now() - hoursParam * 60 * 60 * 1000;

    // Check if node has private position override
    const nodeNum = parseInt(nodeId.replace('!', ''), 16);
    const node = await databaseService.nodes.getNode(nodeNum, telSourceId);
    const isPrivate = node?.positionOverrideIsPrivate === true;
    const canViewPrivate = !!req.user && await hasPermission(req.user, 'nodes_private', 'read');

    let telemetry: any[];
    // For PostgreSQL/MySQL, use async repo directly
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      const limit = Math.min(hoursParam * 60, 5000);
      telemetry = await databaseService.telemetry.getTelemetryByNode(nodeId, limit, cutoffTime, undefined, 0, undefined, telSourceId);
    } else {
      // Use averaged query for graph data to reduce data points
      // Dynamic bucketing automatically adjusts interval based on time range:
      // - 0-24h: 3-minute intervals (high detail)
      // - 1-7d: 30-minute intervals (medium detail)
      // - 7d+: 2-hour intervals (low detail, full coverage)
      telemetry = await databaseService.getTelemetryByNodeAveragedAsync(nodeId, cutoffTime, undefined, hoursParam, telSourceId);
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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const hoursParam = req.query.hours ? parseInt(req.query.hours as string) : 24;
    const ratesSourceId = req.query.sourceId as string | undefined;

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

      // Fetch telemetry for each packet type and calculate rates
      for (const type of packetTypes) {
        const telemetry = await databaseService.telemetry.getTelemetryByNode(
          nodeId, 5000, cutoffTime, undefined, 0, type, ratesSourceId
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
    } else {
      rates = await databaseService.getPacketRatesAsync(nodeId, packetTypes, cutoffTime, ratesSourceId);
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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
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

    // Check channel-based access for this node
    if (!await checkNodeChannelAccess(nodeId, req.user)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
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
apiRouter.delete('/telemetry/:nodeId/:telemetryType', requireAuth(), requirePermission('info', 'write'), async (req, res) => {
  try {
    const { nodeId, telemetryType } = req.params;

    logger.info(`Purging telemetry data for node ${nodeId}, type ${telemetryType}`);

    const deleted = await databaseService.telemetry.deleteTelemetryByNodeAndType(nodeId, telemetryType);

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
    const telAvailSourceId = req.query.sourceId as string | undefined;
    const allNodes = await databaseService.nodes.getAllNodes(telAvailSourceId);
    // Filter nodes based on channel read permissions
    const nodes = await filterNodesByChannelPermission(allNodes, (req as any).user);

    const nodesWithTelemetry: string[] = [];
    const nodesWithWeather: string[] = [];
    const nodesWithEstimatedPosition: string[] = [];

    const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);
    const estimatedPositionTypes = new Set(['estimated_latitude', 'estimated_longitude']);

    // Efficient bulk query: get all telemetry types for all nodes at once
    const nodeTelemetryTypes = await databaseService.getAllNodesTelemetryTypesAsync();

    nodes.forEach(node => {
      const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
      if (telemetryTypes && telemetryTypes.length > 0) {
        nodesWithTelemetry.push(node.nodeId);

        // Check if any telemetry type is weather-related
        const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
        if (hasWeather) {
          nodesWithWeather.push(node.nodeId);
        }

        // Check if node has estimated position telemetry AND doesn't have a known position.
        // A user-set override counts as a known position — we don't want to draw an
        // uncertainty circle on a node the user has explicitly placed (issue #2847).
        const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
        const eff = getEffectiveDbNodePosition(node);
        const hasRealPosition = eff.latitude != null && eff.longitude != null;
        if (hasEstimatedPosition && !hasRealPosition) {
          nodesWithEstimatedPosition.push(node.nodeId);
        }
      }
    });

    // Check for PKC-enabled nodes
    const nodesWithPKC: string[] = [];

    // Get the local node ID to ensure it's always marked as secure
    const localNodeNumStr = await databaseService.settings.getSetting('localNodeNum');
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
apiRouter.get('/connection', optionalAuth(), async (req, res) => {
  try {
    const connSourceId = req.query.sourceId as string | undefined;
    // When the caller explicitly names a sourceId but no manager is registered
    // for it (e.g. autoConnect=false, or user manually disconnected via
    // /api/sources/:id/disconnect — issue #2773), return a stable
    // "not connected" response instead of silently falling back to the legacy
    // singleton. The singleton is the primary source's manager and would
    // otherwise leak its state across sources.
    if (connSourceId && !sourceManagerRegistry.getManager(connSourceId)) {
      res.json({
        connected: false,
        nodeResponsive: false,
        configuring: false,
        userDisconnected: false,
      });
      return;
    }
    const connManager = (connSourceId ? (sourceManagerRegistry.getManager(connSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const status = await connManager.getConnectionStatus();
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
apiRouter.get('/device/tx-status', optionalAuth(), async (req, res) => {
  try {
    const txSourceId = req.query.sourceId as string | undefined;
    const txManager = (txSourceId ? (sourceManagerRegistry.getManager(txSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const deviceConfig = await txManager.getDeviceConfig();
    const txEnabled = deviceConfig?.lora?.txEnabled !== false; // Default to true if undefined
    res.json({ txEnabled });
  } catch (error) {
    logger.error('Error getting TX status:', error);
    res.status(500).json({ error: 'Failed to get TX status' });
  }
});

// Get security keys (public and private) for the local node.
// MM-SEC-5: gated on `requireAdmin()` because the response includes the
// device's PKI private key. Any holder of that key can decrypt PKI DMs the
// local node receives and forge signed packets from it.
apiRouter.get('/device/security-keys', requireAdmin(), async (req, res) => {
  try {
    const skSourceId = req.query.sourceId as string | undefined;
    const skManager = (skSourceId ? (sourceManagerRegistry.getManager(skSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const keys = skManager.getSecurityKeys();
    res.json(keys);
  } catch (error) {
    logger.error('Error getting security keys:', error);
    res.status(500).json({ error: 'Failed to get security keys' });
  }
});

// Consolidated polling endpoint - reduces multiple API calls to one
apiRouter.get('/poll', optionalAuth(), async (req, res) => {
  logger.debug('🔔 [POLL] Endpoint called');
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
      deviceNodeNums?: number[];
    } = {};

    // Optional sourceId scoping — when provided, use the matching manager and filter DB queries
    const pollSourceId = (req.query.sourceId as string | undefined) || undefined;
    const activeManager = (pollSourceId
      ? (sourceManagerRegistry.getManager(pollSourceId) ?? meshtasticManager)
      : meshtasticManager) as typeof meshtasticManager;

    // Pre-compute shared values used across multiple sections
    const user = (req as any).user;
    const userId = req.user?.id ?? null;
    const localNodeInfo = activeManager.getLocalNodeInfo();
    // Nodes are stored per-source (composite PK (nodeNum, sourceId) since migration
    // 029). Scope strictly to this source so two sources with overlapping meshes
    // each show only what they have actually heard. When no sourceId is given
    // (legacy/no-source callers), fall back to the global unscoped query.
    const allMemoryNodes = await activeManager.getAllNodesAsync(pollSourceId);
    const filteredMemoryNodes = await filterNodesByChannelPermission(allMemoryNodes, user);

    // Load full permission set once to avoid N sequential DB queries per permission check
    const userPermissionSet = (user && !user.isAdmin && userId)
      ? await databaseService.getUserPermissionSetAsync(userId, pollSourceId)
      : null;
    // In-memory permission check using the pre-loaded permission set
    const checkPerm = (resource: string, action: 'read' | 'write'): boolean => {
      if (!user) return false;
      if (user.isAdmin) return true;
      return (userPermissionSet as Record<string, { read: boolean; write: boolean }> | null)?.[resource]?.[action] ?? false;
    };

    const hasChannelsRead = checkPerm('channel_0', 'read');
    const hasMessagesRead = checkPerm('messages', 'read');
    const hasInfoRead = checkPerm('info', 'read');
    const canViewPrivate = checkPerm('nodes_private', 'read');

    // 1. Connection status (always available)
    // If the caller named a sourceId but the registry has no manager for it
    // (autoConnect=false, or user manually disconnected via
    // /api/sources/:id/disconnect — issue #2773), report a clean disconnected
    // state rather than leaking the legacy singleton's status.
    const sourceIdRequestedButNoManager =
      !!pollSourceId && !sourceManagerRegistry.getManager(pollSourceId);
    if (sourceIdRequestedButNoManager) {
      result.connection = {
        connected: false,
        nodeResponsive: false,
        configuring: false,
        userDisconnected: false,
      };
    } else {
      try {
        const connectionStatus = await activeManager.getConnectionStatus();
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
    }

    // 2. Nodes (always available with optionalAuth, filtered by channel permissions)
    try {
      const estimatedPositions = await databaseService.getAllNodesEstimatedPositionsAsync();
      result.nodes = await Promise.all(filteredMemoryNodes.map(node => enhanceNodeForClient(node, user, estimatedPositions, canViewPrivate)));
    } catch (error) {
      logger.error('Error fetching nodes in poll:', error);
      result.nodes = [];
    }

    // 3. Messages (requires any channel permission OR messages permission)
    try {
      if (hasChannelsRead || hasMessagesRead) {
        // Scope messages to the requesting source. Per-source tabs must only
        // see messages their own source actually ingested — cross-source
        // visibility belongs in the dedicated unified views (/unified/messages).
        // When no sourceId is provided (legacy single-source clients), fall
        // back to the global fetch.
        // Exclude traceroute responses from the poll window. The UI filters
        // them out of message lists (they render from the `traceroutes`
        // table), so including them only wastes slots in the fixed-size
        // window and evicts real DMs (issue #2741).
        const dbMessagesRaw = pollSourceId
          ? await databaseService.messages.getMessages(100, 0, pollSourceId, [PortNum.TRACEROUTE_APP])
          : await databaseService.messages.getMessages(100, 0, undefined, [PortNum.TRACEROUTE_APP]);

        let messages: MeshMessage[] = dbMessagesRaw.map(
          msg => transformDbMessageToMeshMessage(msg as any as DbMessage)
        );

        // MM-SEC-3: pre-compute the per-channel authorized set so a caller
        // with `channel_0:read` no longer sees messages from hidden channels.
        // Sibling sections (channels, unread-counts) already do this — bring
        // messages in line.
        const isAdminCaller = user?.isAdmin === true;
        const authorizedChannelIds = new Set<number>();
        if (isAdminCaller) {
          for (let id = 0; id <= 7; id++) authorizedChannelIds.add(id);
        } else if (user) {
          for (let id = 0; id <= 7; id++) {
            if (checkPerm(`channel_${id}`, 'read')) authorizedChannelIds.add(id);
          }
        }

        // Filter:
        // - DMs (channel -1) require `messages:read`.
        // - Channel messages require BOTH `hasChannelsRead` AND
        //   per-channel `channel_${id}:read` for the message's actual channel.
        messages = messages.filter(msg => {
          if (msg.channel === -1) return hasMessagesRead;
          return hasChannelsRead && (isAdminCaller || authorizedChannelIds.has(msg.channel));
        });

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
      // Only count incoming messages (exclude messages sent by our node).
      // Scope to the requesting source so per-source tabs only count messages
      // their own source ingested (issue: badge stays lit for messages that
      // aren't visible in the current tab).
      const allUnreadChannels = await databaseService.getUnreadCountsByChannelAsync(userId, localNodeInfo?.nodeId, pollSourceId);

      // Filter channels based on per-channel read permission
      const filteredUnreadChannels: { [channelId: number]: number } = {};
      for (const [channelIdStr, count] of Object.entries(allUnreadChannels)) {
        const channelId = parseInt(channelIdStr);
        const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = checkPerm(channelResource, 'read');

        if (hasChannelRead) {
          filteredUnreadChannels[channelId] = count;
        }
      }
      unreadResult.channels = filteredUnreadChannels;

      // Batch DM unread counts (single query instead of N+1)
      if (hasMessagesRead && localNodeInfo) {
        const allUnreadDMs = await databaseService.getBatchUnreadDMCountsAsync(localNodeInfo.nodeId, userId, pollSourceId);
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
      const allChannels = await databaseService.channels.getAllChannels(pollSourceId);

      // Filter channels async
      const filteredChannels: typeof allChannels = [];
      for (const channel of allChannels) {
        // Exclude disabled channels (role === 0)
        if (channel.role === 0) {
          continue;
        }

        // Check per-channel read permission
        const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
        const hasChannelRead = checkPerm(channelResource, 'read');

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

      // MM-SEC-2: project through transformChannel so the raw `psk` column
      // never reaches the response, even though the per-channel permission
      // gate above already filters out hidden channels.
      result.channels = filteredChannels.map(transformChannel);
    } catch (error) {
      logger.error('Error fetching channels in poll:', error);
    }

    // 6. Telemetry availability (requires info:read permission, filtered by channel permissions)
    try {
      if (hasInfoRead) {
        // Use DB nodes for telemetry (has telemetryTypes), filtered by channel permissions
        const allDbNodes = await databaseService.nodes.getAllNodes(pollSourceId);
        const dbNodes = await filterNodesByChannelPermission(allDbNodes, req.user);

        const nodesWithTelemetry: string[] = [];
        const nodesWithWeather: string[] = [];
        const nodesWithEstimatedPosition: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);
        const estimatedPositionTypes = new Set(['estimated_latitude', 'estimated_longitude']);

        // Use scoped repo call when sourceId provided (bypasses shared cache)
        const nodeTelemetryTypes = pollSourceId
          ? await databaseService.telemetry.getAllNodesTelemetryTypes(pollSourceId)
          : await databaseService.getAllNodesTelemetryTypesAsync();

        dbNodes.forEach(node => {
          const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
          if (telemetryTypes && telemetryTypes.length > 0) {
            nodesWithTelemetry.push(node.nodeId);

            const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
            if (hasWeather) {
              nodesWithWeather.push(node.nodeId);
            }

            // Only show uncertainty circle for nodes currently using estimated position.
            // A user-set override counts as a known position (issue #2847).
            const hasEstimatedPosition = telemetryTypes.some(t => estimatedPositionTypes.has(t));
            const eff = getEffectiveDbNodePosition(node);
            const hasRealPosition = eff.latitude != null && eff.longitude != null;
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
      // Use the active manager's local node info — source-scoped, not the global settings key
      const managerNodeInfo = activeManager.getLocalNodeInfo();

      const deviceMetadata = managerNodeInfo ? {
        firmwareVersion: managerNodeInfo.firmwareVersion,
        rebootCount: managerNodeInfo.rebootCount,
      } : undefined;

      const pollLocalNodeInfo = managerNodeInfo ? {
        nodeId: managerNodeInfo.nodeId,
        longName: managerNodeInfo.longName,
        shortName: managerNodeInfo.shortName,
      } : undefined;

      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: env.meshtasticNodeIp } : {}),
        meshtasticTcpPort: env.meshtasticTcpPort,
        meshtasticUseTls: false,
        baseUrl: BASE_URL,
        deviceMetadata: deviceMetadata,
        localNodeInfo: pollLocalNodeInfo,
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
        const config = await activeManager.getDeviceConfig();
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
      const tracerouteIntervalMinutes = parseInt(await databaseService.settings.getSetting('tracerouteIntervalMinutes') || '5');
      const maxNodeAgeHours = parseInt(await databaseService.settings.getSetting('maxNodeAgeHours') || '24');
      const traceroutesPerHour = tracerouteIntervalMinutes > 0 ? 60 / tracerouteIntervalMinutes : 12;
      let limit = Math.ceil(traceroutesPerHour * maxNodeAgeHours * 1.1);
      limit = Math.max(limit, 100);

      const allTraceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, pollSourceId);
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

    // 10. Device node numbers (nodes in the connected radio's local database)
    result.deviceNodeNums = activeManager.getDeviceNodeNums();

    res.json(result);
  } catch (error) {
    logger.error('Error in consolidated poll endpoint:', error);
    res.status(500).json({ error: 'Failed to fetch polling data' });
  }
});

// User-initiated disconnect endpoint
apiRouter.post('/connection/disconnect', requirePermission('connection', 'write'), async (req, res) => {
  try {
    const { sourceId: disconnectSourceId } = req.body;
    const disconnectManager = (disconnectSourceId
      ? (sourceManagerRegistry.getManager(disconnectSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    await disconnectManager.userDisconnect();

    // Audit log
    databaseService.auditLogAsync(
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
    const { sourceId: reconnectSourceId } = req.body;
    const reconnectManager = (reconnectSourceId
      ? (sourceManagerRegistry.getManager(reconnectSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    const success = await reconnectManager.userReconnect();

    // Audit log
    databaseService.auditLogAsync(
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
apiRouter.get('/connection/info', requireAuth(), async (req, res) => {
  try {
    const ciSourceId = req.query.sourceId as string | undefined;
    const ciManager = (ciSourceId ? (sourceManagerRegistry.getManager(ciSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const status = await ciManager.getConnectionStatus();
    const env = getEnvironmentConfig();
    const ipOverride = await databaseService.settings.getSetting('meshtasticNodeIpOverride');
    const portOverride = await databaseService.settings.getSetting('meshtasticTcpPortOverride');

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
    const { sourceId: connConfigSourceId } = req.body;
    const connConfigManager = (connConfigSourceId
      ? (sourceManagerRegistry.getManager(connConfigSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    await connConfigManager.setNodeIpOverride(nodeIp);

    // Audit log
    databaseService.auditLogAsync(
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
    // Get the local node number from settings to include rebootCount.
    // Accepts ?sourceId= so multi-source deployments resolve the local node
    // (and reboot count / display names) for the specific source the caller
    // is rendering, rather than whichever source happened to write the
    // global localNodeNum setting last.
    const configSourceId = req.query.sourceId as string | undefined;
    const localNodeNumStr = await databaseService.settings.getSettingForSource(
      configSourceId ?? null,
      'localNodeNum',
    );

    let deviceMetadata = undefined;
    let localNodeInfo = undefined;
    if (localNodeNumStr) {
      const localNodeNum = parseInt(localNodeNumStr, 10);
      const currentNode = await databaseService.nodes.getNode(localNodeNum, configSourceId);

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
apiRouter.get('/device-config', requirePermission('configuration', 'read'), async (req, res) => {
  try {
    const dcSourceId = req.query.sourceId as string | undefined;
    const dcManager = (dcSourceId ? (sourceManagerRegistry.getManager(dcSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const config = await dcManager.getDeviceConfig();
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
    const backupSourceId = req.query.sourceId as string | undefined;
    const backupManager = backupSourceId ? (sourceManagerRegistry.getManager(backupSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    logger.info(`📦 Device backup requested (save=${saveToFile})...`);

    // Generate YAML backup using the device backup service
    const yamlBackup = await deviceBackupService.generateBackup(backupManager);

    // Get node ID for filename
    const localNodeInfo = backupManager.getLocalNodeInfo();
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
    const enabled = await databaseService.settings.getSetting('backup_enabled') === 'true';
    const maxBackups = parseInt(await databaseService.settings.getSetting('backup_maxBackups') || '7', 10);
    const backupTime = await databaseService.settings.getSetting('backup_time') || '02:00';

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
    await databaseService.settings.setSetting('backup_enabled', enabled.toString());
    await databaseService.settings.setSetting('backup_maxBackups', maxBackups.toString());
    await databaseService.settings.setSetting('backup_time', backupTime);

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
    databaseService.auditLogAsync(
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
    databaseService.auditLogAsync(
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
    databaseService.auditLogAsync(
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
    const enabled = await databaseService.settings.getSetting('system_backup_enabled') === 'true';
    const maxBackups = parseInt(await databaseService.settings.getSetting('system_backup_maxBackups') || '7', 10);
    const backupTime = await databaseService.settings.getSetting('system_backup_time') || '03:00';

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
    await databaseService.settings.setSetting('system_backup_enabled', enabled.toString());
    await databaseService.settings.setSetting('system_backup_maxBackups', maxBackups.toString());
    await databaseService.settings.setSetting('system_backup_time', backupTime);

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
apiRouter.get('/maintenance/status', requirePermission('configuration', 'read'), async (_req, res) => {
  try {
    const status = await databaseMaintenanceService.getStatus();
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
apiRouter.post('/nodes/refresh', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    logger.debug('🔄 Manual node database refresh requested...');

    const { sourceId: refreshSourceId } = req.body || {};
    const refreshManager = (refreshSourceId
      ? (sourceManagerRegistry.getManager(refreshSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    // Trigger full node database refresh
    await refreshManager.refreshNodeDatabase();

    const nodeCount = await databaseService.nodes.getNodeCount();
    const channelCount = await databaseService.channels.getChannelCount();

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
apiRouter.post('/channels/refresh', requirePermission('messages', 'write'), async (req, res) => {
  try {
    logger.debug('🔄 Manual channel refresh requested...');

    const { sourceId: chanRefreshSourceId } = req.body;
    const chanRefreshManager = (chanRefreshSourceId
      ? (sourceManagerRegistry.getManager(chanRefreshSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    // Trigger full node database refresh (includes channels)
    await chanRefreshManager.refreshNodeDatabase();

    const channelCount = await databaseService.channels.getChannelCount();

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
    const { intervalMinutes, sourceId: traceIntervalSourceId } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 0 || intervalMinutes > 60) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 0 and 60 minutes (0 = disabled).' });
    }

    const traceIntervalManager = (traceIntervalSourceId
      ? (sourceManagerRegistry.getManager(traceIntervalSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    traceIntervalManager.setTracerouteInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting traceroute interval:', error);
    res.status(500).json({ error: 'Failed to set traceroute interval' });
  }
});

// Get auto-traceroute node filter settings
apiRouter.get('/settings/traceroute-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const traceNodesSourceId = req.query.sourceId as string | undefined;
    const settings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesSourceId);
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
      expirationHours, sortByHops,
      filterLastHeardEnabled, filterLastHeardHours,
      filterHopsEnabled, filterHopsMin, filterHopsMax,
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
      // Length cap + catastrophic-backtracking pattern check to prevent ReDoS
      if (filterNameRegex.length > 200) {
        return res.status(400).json({ error: 'filterNameRegex too long (max 200 characters).' });
      }
      if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(filterNameRegex)) {
        return res.status(400).json({ error: 'filterNameRegex too complex or may cause performance issues.' });
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

    // Validate expirationHours (optional, must be an integer between 0 and 168; 0 = always retraceroute)
    let validatedExpirationHours: number | undefined;
    if (expirationHours !== undefined) {
      if (!Number.isInteger(expirationHours) || expirationHours < 0 || expirationHours > 168) {
        return res.status(400).json({ error: 'Invalid expirationHours value. Must be an integer between 0 and 168.' });
      }
      validatedExpirationHours = expirationHours;
    }

    // Validate filterLastHeardEnabled (optional boolean)
    let validatedFilterLastHeardEnabled: boolean | undefined;
    try {
      validatedFilterLastHeardEnabled = validateOptionalBoolean(filterLastHeardEnabled, 'filterLastHeardEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate filterLastHeardHours (optional, must be integer >= 1)
    let validatedFilterLastHeardHours: number | undefined;
    if (filterLastHeardHours !== undefined) {
      if (!Number.isInteger(filterLastHeardHours) || filterLastHeardHours < 1) {
        return res.status(400).json({ error: 'Invalid filterLastHeardHours value. Must be an integer >= 1.' });
      }
      validatedFilterLastHeardHours = filterLastHeardHours;
    }

    // Validate filterHopsEnabled (optional boolean)
    let validatedFilterHopsEnabled: boolean | undefined;
    try {
      validatedFilterHopsEnabled = validateOptionalBoolean(filterHopsEnabled, 'filterHopsEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate filterHopsMin/Max (optional, must be integers >= 0, min <= max)
    let validatedFilterHopsMin: number | undefined;
    let validatedFilterHopsMax: number | undefined;
    if (filterHopsMin !== undefined) {
      if (!Number.isInteger(filterHopsMin) || filterHopsMin < 0) {
        return res.status(400).json({ error: 'Invalid filterHopsMin value. Must be a non-negative integer.' });
      }
      validatedFilterHopsMin = filterHopsMin;
    }
    if (filterHopsMax !== undefined) {
      if (!Number.isInteger(filterHopsMax) || filterHopsMax < 0) {
        return res.status(400).json({ error: 'Invalid filterHopsMax value. Must be a non-negative integer.' });
      }
      validatedFilterHopsMax = filterHopsMax;
    }
    if (validatedFilterHopsMin !== undefined && validatedFilterHopsMax !== undefined && validatedFilterHopsMin > validatedFilterHopsMax) {
      return res.status(400).json({ error: 'filterHopsMin cannot be greater than filterHopsMax.' });
    }

    // Update all settings (scoped to source when provided)
    const traceNodesPostSourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
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
      filterLastHeardEnabled: validatedFilterLastHeardEnabled,
      filterLastHeardHours: validatedFilterLastHeardHours,
      filterHopsEnabled: validatedFilterHopsEnabled,
      filterHopsMin: validatedFilterHopsMin,
      filterHopsMax: validatedFilterHopsMax,
    }, traceNodesPostSourceId);

    // Get the updated settings to return (includes resolved default values)
    const updatedSettings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesPostSourceId);

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
apiRouter.get('/settings/traceroute-log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const traceLogSourceId = req.query.sourceId as string | undefined;
    const log = await databaseService.getAutoTracerouteLogAsync(10, traceLogSourceId);
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
apiRouter.get('/settings/time-sync-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const sourceId = (req.query.sourceId as string | undefined) || undefined;
    const settings = await databaseService.getTimeSyncFilterSettingsAsync(sourceId);
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
    const sourceId = (req.query.sourceId as string | undefined) || (req.body.sourceId as string | undefined) || undefined;

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
    }, sourceId);

    // Update the meshtastic manager interval if connected
    const timeSyncSourceId = sourceId;
    const timeSyncManager = timeSyncSourceId ? (sourceManagerRegistry.getManager(timeSyncSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    if (intervalMinutes !== undefined) {
      timeSyncManager.setTimeSyncInterval(enabled ? Number(intervalMinutes) : 0);
    } else if (enabled !== undefined) {
      // If only enabled/disabled changed, use existing interval (per-source with global fallback)
      const intervalStr = await databaseService.settings.getSettingForSource(timeSyncSourceId ?? null, 'autoTimeSyncIntervalMinutes');
      const parsed = intervalStr ? parseInt(intervalStr, 10) : NaN;
      const currentInterval = isNaN(parsed) ? 15 : parsed;
      timeSyncManager.setTimeSyncInterval(enabled ? currentInterval : 0);
    }

    // Get the updated settings to return
    const updatedSettings = await databaseService.getTimeSyncFilterSettingsAsync(sourceId);

    res.json({
      success: true,
      ...updatedSettings,
    });
  } catch (error) {
    logger.error('Error updating auto time sync settings:', error);
    res.status(500).json({ error: 'Failed to update auto time sync settings' });
  }
});

// Get auto-ping settings and active sessions
apiRouter.get('/settings/auto-ping', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const autoPingSourceId = req.query.sourceId as string | undefined;
    const autoPingManager = autoPingSourceId ? (sourceManagerRegistry.getManager(autoPingSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    // Per-source settings layered on top of globals (source override wins)
    const sourceOverrides = autoPingSourceId
      ? await databaseService.settings.getSourceSettings(autoPingSourceId)
      : {};
    const readSetting = async (key: string): Promise<string | null> => {
      if (key in sourceOverrides) return sourceOverrides[key];
      return await databaseService.settings.getSetting(key);
    };
    const settings = {
      autoPingEnabled: (await readSetting('autoPingEnabled')) === 'true',
      autoPingIntervalSeconds: parseInt((await readSetting('autoPingIntervalSeconds')) || '30', 10),
      autoPingMaxPings: parseInt((await readSetting('autoPingMaxPings')) || '20', 10),
      autoPingTimeoutSeconds: parseInt((await readSetting('autoPingTimeoutSeconds')) || '60', 10),
    };
    const sessions = await autoPingManager.getAutoPingSessions();
    res.json({ settings, sessions });
  } catch (error) {
    logger.error('Error fetching auto-ping settings:', error);
    res.status(500).json({ error: 'Failed to fetch auto-ping settings' });
  }
});

// Update auto-ping settings
apiRouter.post('/settings/auto-ping', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const { autoPingEnabled, autoPingIntervalSeconds, autoPingMaxPings, autoPingTimeoutSeconds } = req.body;
    const autoPingSourceId = req.query.sourceId as string | undefined;
    const writeSetting = async (key: string, value: string) => {
      if (autoPingSourceId) {
        await databaseService.settings.setSourceSetting(autoPingSourceId, key, value);
      } else {
        await databaseService.settings.setSetting(key, value);
      }
    };
    const sourceOverrides = autoPingSourceId
      ? await databaseService.settings.getSourceSettings(autoPingSourceId)
      : {};
    const readSetting = async (key: string): Promise<string | null> => {
      if (key in sourceOverrides) return sourceOverrides[key];
      return await databaseService.settings.getSetting(key);
    };

    if (autoPingEnabled !== undefined) {
      await writeSetting('autoPingEnabled', String(autoPingEnabled));
      sourceOverrides['autoPingEnabled'] = String(autoPingEnabled);
    }
    if (autoPingIntervalSeconds !== undefined) {
      const val = parseInt(String(autoPingIntervalSeconds), 10);
      if (isNaN(val) || val < 10) {
        return res.status(400).json({ error: 'Interval must be at least 10 seconds.' });
      }
      await writeSetting('autoPingIntervalSeconds', String(val));
      sourceOverrides['autoPingIntervalSeconds'] = String(val);
    }
    if (autoPingMaxPings !== undefined) {
      const val = parseInt(String(autoPingMaxPings), 10);
      if (isNaN(val) || val < 1 || val > 100) {
        return res.status(400).json({ error: 'Max pings must be between 1 and 100.' });
      }
      await writeSetting('autoPingMaxPings', String(val));
      sourceOverrides['autoPingMaxPings'] = String(val);
    }
    if (autoPingTimeoutSeconds !== undefined) {
      const val = parseInt(String(autoPingTimeoutSeconds), 10);
      if (isNaN(val) || val < 10) {
        return res.status(400).json({ error: 'Timeout must be at least 10 seconds.' });
      }
      await writeSetting('autoPingTimeoutSeconds', String(val));
      sourceOverrides['autoPingTimeoutSeconds'] = String(val);
    }

    const settings = {
      autoPingEnabled: (await readSetting('autoPingEnabled')) === 'true',
      autoPingIntervalSeconds: parseInt((await readSetting('autoPingIntervalSeconds')) || '30', 10),
      autoPingMaxPings: parseInt((await readSetting('autoPingMaxPings')) || '20', 10),
      autoPingTimeoutSeconds: parseInt((await readSetting('autoPingTimeoutSeconds')) || '60', 10),
    };

    res.json({ success: true, settings });
  } catch (error) {
    logger.error('Error updating auto-ping settings:', error);
    res.status(500).json({ error: 'Failed to update auto-ping settings' });
  }
});

// Force-stop an active auto-ping session
apiRouter.post('/auto-ping/stop/:nodeNum', requirePermission('settings', 'write'), (req, res) => {
  try {
    const nodeNum = parseInt(req.params.nodeNum, 10);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'Invalid node number.' });
    }
    const { sourceId: stopPingSourceId } = req.body || {};
    const stopPingManager = stopPingSourceId ? (sourceManagerRegistry.getManager(stopPingSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    stopPingManager.stopAutoPingSession(nodeNum, 'force_stopped');
    res.json({ success: true });
  } catch (error) {
    logger.error('Error stopping auto-ping session:', error);
    res.status(500).json({ error: 'Failed to stop auto-ping session' });
  }
});

// Get auto key repair log (recent key repair attempts with success/fail status)
apiRouter.get('/settings/key-repair-log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const krSourceId = req.query.sourceId as string | undefined;
    const log = await databaseService.getKeyRepairLogAsync(50, krSourceId);
    res.json({
      success: true,
      log,
    });
  } catch (error) {
    logger.error('Error fetching auto key repair log:', error);
    res.status(500).json({ error: 'Failed to fetch auto key repair log' });
  }
});

// Auto-delete-by-distance log
apiRouter.get('/settings/distance-delete/log', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const distLogSourceId = req.query.sourceId as string | undefined;
    const entries = await databaseService.misc.getDistanceDeleteLog(10, distLogSourceId);
    res.json(entries);
  } catch (error) {
    logger.error('Error fetching distance-delete log:', error);
    res.status(500).json({ error: 'Failed to fetch log' });
  }
});

// Auto-delete-by-distance run now
apiRouter.post('/settings/distance-delete/run-now', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const distDelSourceId =
      (req.body && req.body.sourceId) ||
      (req.query.sourceId as string | undefined) ||
      undefined;
    const result = await autoDeleteByDistanceService.runNow(distDelSourceId);
    res.json(result);
  } catch (error) {
    logger.error('Error running distance-delete:', error);
    res.status(500).json({ error: 'Failed to run distance delete' });
  }
});

// Note: GET/POST/DELETE /settings routes are in routes/settingsRoutes.ts

// Mark all nodes as welcomed (for auto-welcome feature)
apiRouter.post('/settings/mark-all-welcomed', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const sourceId = (req.query.sourceId as string | undefined) ?? (req.body?.sourceId as string | undefined) ?? null;
    const count = await databaseService.markAllNodesAsWelcomedAsync(sourceId);
    logger.info(`👋 Manually marked ${count} nodes as welcomed via API${sourceId ? ` (source=${sourceId})` : ''}`);

    // Audit log
    databaseService.auditLogAsync(
      req.user!.id,
      'mark_all_welcomed',
      'nodes',
      `Marked ${count} nodes as welcomed${sourceId ? ` for source ${sourceId}` : ''}`,
      req.ip || null,
      null,
      JSON.stringify({ count, sourceId })
    );

    res.json({ success: true, count, message: `Marked ${count} nodes as welcomed` });
  } catch (error) {
    logger.error('Error marking all nodes as welcomed:', error);
    res.status(500).json({ error: 'Failed to mark nodes as welcomed' });
  }
});

// User Map Preferences endpoints

// Get user's map preferences
apiRouter.get('/user/map-preferences', optionalAuth(), async (req, res) => {
  try {
    // Anonymous users get null (will fall back to defaults in frontend)
    if (!req.user || req.user.username === 'anonymous') {
      return res.json({ preferences: null });
    }

    const preferences = await databaseService.getMapPreferencesAsync(req.user.id);
    res.json({ preferences });
  } catch (error) {
    logger.error('Error fetching user map preferences:', error);
    res.status(500).json({ error: 'Failed to fetch map preferences' });
  }
});

// Save user's map preferences
apiRouter.post('/user/map-preferences', requireAuth(), async (req, res) => {
  try {
    // Prevent saving preferences for anonymous user
    if (req.user!.username === 'anonymous') {
      return res.status(403).json({ error: 'Cannot save preferences for anonymous user' });
    }

    const { mapTileset, showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showMeshCoreNodes, showAnimations, showAccuracyRegions, showEstimatedPositions, positionHistoryHours } = req.body;

    // Validate boolean values
    const booleanFields = { showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showMeshCoreNodes, showAnimations, showAccuracyRegions, showEstimatedPositions };
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
    await databaseService.saveMapPreferencesAsync(req.user!.id, {
      mapTileset,
      showPaths,
      showNeighborInfo,
      showRoute,
      showMotion,
      showMqttNodes,
      showMeshCoreNodes,
      showAnimations,
      showAccuracyRegions,
      showEstimatedPositions,
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
apiRouter.get('/themes', optionalAuth(), async (_req, res) => {
  try {
    const themes = await databaseService.misc.getAllCustomThemes();
    res.json({ themes });
  } catch (error) {
    logger.error('Error fetching custom themes:', error);
    res.status(500).json({ error: 'Failed to fetch custom themes' });
  }
});

// Get a specific theme by slug
apiRouter.get('/themes/:slug', optionalAuth(), async (req, res) => {
  try {
    const { slug } = req.params;
    const theme = await databaseService.misc.getCustomThemeBySlug(slug);

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
apiRouter.post('/themes', requirePermission('themes', 'write'), async (req, res) => {
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
    const existingTheme = await databaseService.misc.getCustomThemeBySlug(slug);
    if (existingTheme) {
      return res.status(409).json({ error: 'Theme with this slug already exists' });
    }

    // Validate theme definition
    if (!databaseService.validateThemeDefinition(definition)) {
      return res
        .status(400)
        .json({ error: 'Invalid theme definition. All required color variables must be valid hex codes' });
    }

    // Create the theme
    const theme = await databaseService.misc.createCustomTheme(name, slug, JSON.stringify(definition), req.user!.id);

    // Audit log
    databaseService.auditLogAsync(
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
apiRouter.put('/themes/:slug', requirePermission('themes', 'write'), async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, definition } = req.body;

    // Get existing theme for audit log
    const existingTheme = await databaseService.misc.getCustomThemeBySlug(slug);
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
          .json({ error: 'Invalid theme definition. All required color variables must be valid hex codes' });
      }
      updates.definition = definition;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    // Update the theme
    const repoUpdates: Record<string, string> = {};
    if (updates.name) repoUpdates.name = updates.name;
    if (updates.definition) repoUpdates.definition = JSON.stringify(updates.definition);
    await databaseService.misc.updateCustomTheme(slug, repoUpdates);

    // Audit log
    databaseService.auditLogAsync(
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
apiRouter.delete('/themes/:slug', requirePermission('themes', 'write'), async (req, res) => {
  try {
    const { slug } = req.params;

    // Get theme for audit log before deletion
    const theme = await databaseService.misc.getCustomThemeBySlug(slug);
    if (!theme) {
      return res.status(404).json({ error: 'Theme not found' });
    }

    if (theme.is_builtin) {
      return res.status(403).json({ error: 'Cannot delete built-in themes' });
    }

    // Delete the theme
    await databaseService.misc.deleteCustomTheme(slug);

    // Audit log
    databaseService.auditLogAsync(
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
apiRouter.post('/announce/send', requirePermission('automation', 'write'), async (req, res) => {
  try {
    const { sourceId: announceSourceId } = req.body;
    const announceManager = (announceSourceId
      ? (sourceManagerRegistry.getManager(announceSourceId) as typeof meshtasticManager ?? meshtasticManager)
      : meshtasticManager);
    await announceManager.sendAutoAnnouncement();
    // Update last announcement time (per-source when known)
    if (announceSourceId) {
      await databaseService.settings.setSourceSetting(announceSourceId, 'lastAnnouncementTime', Date.now().toString());
    } else {
      await databaseService.settings.setSetting('lastAnnouncementTime', Date.now().toString());
    }
    res.json({ success: true, message: 'Announcement sent successfully' });
  } catch (error) {
    logger.error('Error sending announcement:', error);
    res.status(500).json({ error: 'Failed to send announcement' });
  }
});

apiRouter.get('/announce/last', requirePermission('automation', 'read'), async (req, res) => {
  try {
    const announceLastSourceId = (req.query.sourceId as string) || null;
    const lastAnnouncementTime = await databaseService.settings.getSettingForSource(announceLastSourceId, 'lastAnnouncementTime');
    res.json({ lastAnnouncementTime: lastAnnouncementTime ? parseInt(lastAnnouncementTime) : null });
  } catch (error) {
    logger.error('Error fetching last announcement time:', error);
    res.status(500).json({ error: 'Failed to fetch last announcement time' });
  }
});

// Announce preview endpoint - expands message template with real values
apiRouter.get('/announce/preview', requirePermission('automation', 'read'), async (req, res) => {
  try {
    const message = req.query.message as string;
    if (!message) {
      return res.status(400).json({ error: 'Missing message parameter' });
    }
    const previewSourceId = req.query.sourceId as string | undefined;
    const previewManager = previewSourceId ? (sourceManagerRegistry.getManager(previewSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager;
    const preview = await previewManager.previewAnnouncementMessage(message);
    res.json({ preview });
  } catch (error) {
    logger.error('Error generating announcement preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// Danger zone endpoints
apiRouter.post('/purge/nodes', requireAdmin(), async (req, res) => {
  try {
    const nodeCount = await databaseService.nodes.getNodeCount();
    await databaseService.purgeAllNodesAsync();
    // Trigger a node refresh after purging
    const { sourceId: purgeNodesSourceId } = req.body || {};
    const purgeNodesManager = (purgeNodesSourceId ? (sourceManagerRegistry.getManager(purgeNodesSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await purgeNodesManager.refreshNodeDatabase();

    // Audit log
    databaseService.auditLogAsync(
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

apiRouter.post('/purge/telemetry', requireAdmin(), async (req, res) => {
  try {
    await databaseService.purgeAllTelemetryAsync();

    // Audit log
    databaseService.auditLogAsync(
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

apiRouter.post('/purge/messages', requireAdmin(), async (req, res) => {
  try {
    const messageCount = await databaseService.messages.getMessageCount();
    await databaseService.messages.deleteAllMessages();

    // Audit log
    databaseService.auditLogAsync(
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

apiRouter.post('/purge/traceroutes', requireAdmin(), async (req, res) => {
  try {
    await databaseService.traceroutes.deleteAllTraceroutes();
    await databaseService.traceroutes.deleteAllRouteSegments();

    // Audit log
    databaseService.auditLogAsync(
      req.user!.id,
      'traceroutes_purged',
      'traceroute',
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
apiRouter.get('/config/current', requirePermission('configuration', 'read'), (req, res) => {
  try {
    const ccSourceId = req.query.sourceId as string | undefined;
    const ccManager = (ccSourceId ? (sourceManagerRegistry.getManager(ccSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const config = ccManager.getCurrentConfig();
    res.json(config);
  } catch (error) {
    logger.error('Error getting current config:', error);
    res.status(500).json({ error: 'Failed to get current configuration' });
  }
});

apiRouter.post('/config/device', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgDevSourceId, ...config } = req.body;
    const cfgDevManager = (cfgDevSourceId ? (sourceManagerRegistry.getManager(cfgDevSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgDevManager.setDeviceConfig(config);
    res.json({ success: true, message: 'Device configuration sent' });
  } catch (error) {
    logger.error('Error setting device config:', error);
    res.status(500).json({ error: 'Failed to set device configuration' });
  }
});

apiRouter.post('/config/network', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgNetSourceId, ...config } = req.body;
    const cfgNetManager = (cfgNetSourceId ? (sourceManagerRegistry.getManager(cfgNetSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgNetManager.setNetworkConfig(config);
    res.json({ success: true, message: 'Network configuration sent' });
  } catch (error) {
    logger.error('Error setting network config:', error);
    res.status(500).json({ error: 'Failed to set network configuration' });
  }
});

apiRouter.post('/config/lora', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgLoraSourceId, ...config } = req.body;
    const cfgLoraManager = (cfgLoraSourceId ? (sourceManagerRegistry.getManager(cfgLoraSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);

    // IMPORTANT: Always force txEnabled to true
    // MeshMonitor users need TX enabled to send messages
    // Ignore any incoming configuration that tries to disable TX
    const loraConfigToSet = {
      ...config,
      txEnabled: true,
    };

    logger.info(`⚙️ Setting LoRa config with txEnabled defaulted: txEnabled=${loraConfigToSet.txEnabled}`);
    await cfgLoraManager.setLoRaConfig(loraConfigToSet);
    res.json({ success: true, message: 'LoRa configuration sent' });
  } catch (error) {
    logger.error('Error setting LoRa config:', error);
    res.status(500).json({ error: 'Failed to set LoRa configuration' });
  }
});

apiRouter.post('/config/position', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgPosSourceId, ...config } = req.body;
    const cfgPosManager = (cfgPosSourceId ? (sourceManagerRegistry.getManager(cfgPosSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgPosManager.setPositionConfig(config);
    res.json({ success: true, message: 'Position configuration sent' });
  } catch (error) {
    logger.error('Error setting position config:', error);
    res.status(500).json({ error: 'Failed to set position configuration' });
  }
});

apiRouter.post('/config/mqtt', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgMqttSourceId, ...config } = req.body;
    const cfgMqttManager = (cfgMqttSourceId ? (sourceManagerRegistry.getManager(cfgMqttSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgMqttManager.setMQTTConfig(config);
    res.json({ success: true, message: 'MQTT configuration sent' });
  } catch (error) {
    logger.error('Error setting MQTT config:', error);
    res.status(500).json({ error: 'Failed to set MQTT configuration' });
  }
});

apiRouter.post('/config/neighborinfo', requirePermission('configuration', 'write'), async (req, res) => {
  logger.debug('🔍 DEBUG: /config/neighborinfo endpoint called with body:', JSON.stringify(req.body));
  try {
    const { sourceId: cfgNiSourceId, ...config } = req.body;
    const cfgNiManager = (cfgNiSourceId ? (sourceManagerRegistry.getManager(cfgNiSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgNiManager.setNeighborInfoConfig(config);
    res.json({ success: true, message: 'NeighborInfo configuration sent' });
  } catch (error) {
    logger.error('Error setting NeighborInfo config:', error);
    res.status(500).json({ error: 'Failed to set NeighborInfo configuration' });
  }
});

apiRouter.post('/config/power', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgPwrSourceId, ...config } = req.body;
    const cfgPwrManager = (cfgPwrSourceId ? (sourceManagerRegistry.getManager(cfgPwrSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgPwrManager.setPowerConfig(config);
    res.json({ success: true, message: 'Power configuration sent' });
  } catch (error) {
    logger.error('Error setting power config:', error);
    res.status(500).json({ error: 'Failed to set power configuration' });
  }
});

apiRouter.post('/config/display', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgDispSourceId, ...config } = req.body;
    const cfgDispManager = (cfgDispSourceId ? (sourceManagerRegistry.getManager(cfgDispSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgDispManager.setDisplayConfig(config);
    res.json({ success: true, message: 'Display configuration sent' });
  } catch (error) {
    logger.error('Error setting display config:', error);
    res.status(500).json({ error: 'Failed to set display configuration' });
  }
});

apiRouter.post('/config/module/telemetry', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgTelSourceId, ...config } = req.body;
    const cfgTelManager = (cfgTelSourceId ? (sourceManagerRegistry.getManager(cfgTelSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgTelManager.setTelemetryConfig(config);
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
    const { sourceId: cfgModSourceId, ...config } = req.body;
    const cfgModManager = (cfgModSourceId ? (sourceManagerRegistry.getManager(cfgModSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);

    // Validate moduleType
    const validModuleTypes = ['extnotif', 'storeforward', 'rangetest', 'cannedmsg', 'audio',
      'remotehardware', 'detectionsensor', 'paxcounter', 'serial', 'ambientlighting'];
    if (!validModuleTypes.includes(moduleType)) {
      res.status(400).json({ error: `Invalid module type: ${moduleType}` });
      return;
    }

    await cfgModManager.setGenericModuleConfig(moduleType, config);
    res.json({ success: true, message: `${moduleType} configuration sent` });
  } catch (error) {
    logger.error(`Error setting ${req.params.moduleType} config:`, error);
    res.status(500).json({ error: `Failed to set ${req.params.moduleType} configuration` });
  }
});

apiRouter.post('/config/owner', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { longName, shortName, isUnmessagable, isLicensed, sourceId: ownerSourceId } = req.body;
    if (!longName || !shortName) {
      res.status(400).json({ error: 'longName and shortName are required' });
      return;
    }
    const ownerManager = (ownerSourceId ? (sourceManagerRegistry.getManager(ownerSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await ownerManager.setNodeOwner(longName, shortName, isUnmessagable, isLicensed);
    res.json({ success: true, message: 'Node owner updated' });
  } catch (error) {
    logger.error('Error setting node owner:', error);
    res.status(500).json({ error: 'Failed to set node owner' });
  }
});

apiRouter.post('/config/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType, sourceId: cfgReqSourceId } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    const cfgReqManager = (cfgReqSourceId ? (sourceManagerRegistry.getManager(cfgReqSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgReqManager.requestConfig(configType);
    res.json({ success: true, message: 'Config request sent' });
  } catch (error) {
    logger.error('Error requesting config:', error);
    res.status(500).json({ error: 'Failed to request configuration' });
  }
});

apiRouter.post('/config/module/request', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { configType, sourceId: cfgModReqSourceId } = req.body;
    if (configType === undefined) {
      res.status(400).json({ error: 'configType is required' });
      return;
    }
    const cfgModReqManager = (cfgModReqSourceId ? (sourceManagerRegistry.getManager(cfgModReqSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await cfgModReqManager.requestModuleConfig(configType);
    res.json({ success: true, message: 'Module config request sent' });
  } catch (error) {
    logger.error('Error requesting module config:', error);
    res.status(500).json({ error: 'Failed to request module configuration' });
  }
});

apiRouter.post('/device/reboot', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { seconds: rebootSeconds, sourceId: rebootSourceId } = req.body || {};
    const seconds = rebootSeconds || 10;
    const rebootManager = (rebootSourceId ? (sourceManagerRegistry.getManager(rebootSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    await rebootManager.rebootDevice(seconds);
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
    const { nodeNum, configType, channelIndex, sourceId: adminLoadSourceId } = req.body;

    if (!configType) {
      return res.status(400).json({ error: 'configType is required' });
    }

    const adminLoadManager = (adminLoadSourceId ? (sourceManagerRegistry.getManager(adminLoadSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (adminLoadManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = adminLoadManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    let config: any = null;

    try {
      if (isLocalNode) {
        // Local node - use existing config or request it
        let currentConfig = adminLoadManager.getCurrentConfig();
        
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
          'neighborinfo': { type: 9, isModule: true }, // NEIGHBORINFO_CONFIG (module)
          'statusmessage': { type: 13, isModule: true }, // STATUSMESSAGE_CONFIG (module)
          'trafficmanagement': { type: 14, isModule: true } // TRAFFICMANAGEMENT_CONFIG (module)
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
              'statusmessage': 'statusmessage',
              'trafficmanagement': 'trafficManagement'
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
              await adminLoadManager.requestModuleConfig(configInfo.type);
            } else {
              await adminLoadManager.requestConfig(configInfo.type);
            }
            // Wait a bit for response
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            logger.warn(`Failed to request ${configType} config:`, error);
          }

          // Check again
          const retryConfig = adminLoadManager.getCurrentConfig();
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
                nodeInfoBroadcastSecs: finalConfig.deviceConfig.device.nodeInfoBroadcastSecs,
                rebroadcastMode: finalConfig.deviceConfig.device.rebroadcastMode,
                tzdef: finalConfig.deviceConfig.device.tzdef,
                doubleTapAsButtonPress: finalConfig.deviceConfig.device.doubleTapAsButtonPress,
                disableTripleClick: finalConfig.deviceConfig.device.disableTripleClick,
                ledHeartbeatDisabled: finalConfig.deviceConfig.device.ledHeartbeatDisabled,
                buzzerMode: finalConfig.deviceConfig.device.buzzerMode,
                buttonGpio: finalConfig.deviceConfig.device.buttonGpio,
                buzzerGpio: finalConfig.deviceConfig.device.buzzerGpio,
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
              // If fixedPosition is enabled, get the coordinates from the node's stored position.
              // Scope to adminLoadSourceId so multi-source deployments resolve the correct
              // copy of the local node — otherwise we might pull fixedPosition coords from a
              // stale row on a different source that shares the same nodeNum.
              // Use the effective position so a user-set override takes precedence over the
              // device-reported lat/lon — that's the position the user wants displayed and
              // pushed back to the device when saving the config (issue #2847).
              if (finalConfig.deviceConfig.position.fixedPosition && localNodeNum) {
                const nodeData = await databaseService.nodes.getNode(localNodeNum, adminLoadSourceId);
                const eff = getEffectiveDbNodePosition(nodeData);
                if (eff.latitude != null && eff.longitude != null) {
                  config.fixedLatitude = eff.latitude;
                  config.fixedLongitude = eff.longitude;
                }
                if (eff.altitude != null) {
                  config.fixedAltitude = eff.altitude;
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
                adminKeys: localAdminKeys.map((key: any) => bytesToBase64(key)),
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
          case 'trafficmanagement':
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
              'statusmessage': 'statusmessage',
              'trafficmanagement': 'trafficManagement'
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
          'statusmessage': { type: 13, isModule: true }, // STATUSMESSAGE_CONFIG (module)
          'trafficmanagement': { type: 14, isModule: true } // TRAFFICMANAGEMENT_CONFIG (module)
        };

        const configInfo = configTypeMap[configType];
        if (!configInfo) {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Request config from remote node
        const remoteConfig = await adminLoadManager.requestRemoteConfig(
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
              nodeInfoBroadcastSecs: remoteConfig.nodeInfoBroadcastSecs,
              rebroadcastMode: remoteConfig.rebroadcastMode,
              tzdef: remoteConfig.tzdef,
              doubleTapAsButtonPress: remoteConfig.doubleTapAsButtonPress,
              disableTripleClick: remoteConfig.disableTripleClick,
              ledHeartbeatDisabled: remoteConfig.ledHeartbeatDisabled,
              buzzerMode: remoteConfig.buzzerMode,
              buttonGpio: remoteConfig.buttonGpio,
              buzzerGpio: remoteConfig.buzzerGpio,
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
            // If fixedPosition is enabled, get the coordinates from the node's stored position.
            // Scope to adminLoadSourceId so the remote node lookup resolves the row
            // belonging to the source the admin is operating on. Honor any user-set
            // position override so the displayed/saved fixed coords match the user's
            // intent rather than the device's stale value (issue #2847).
            if (remoteConfig.fixedPosition) {
              const nodeData = await databaseService.nodes.getNode(destinationNodeNum, adminLoadSourceId);
              const eff = getEffectiveDbNodePosition(nodeData);
              if (eff.latitude != null && eff.longitude != null) {
                config.fixedLatitude = eff.latitude;
                config.fixedLongitude = eff.longitude;
              }
              if (eff.altitude != null) {
                config.fixedAltitude = eff.altitude;
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
              adminKeys: remoteAdminKeys.map((key: any) => bytesToBase64(key)),
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
          case 'statusmessage':
          case 'trafficmanagement':
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
          await adminLoadManager.requestConfig(0); // CHANNEL_CONFIG = 0
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
    const { nodeNum, sourceId: espSourceId } = req.body;

    const espManager = (espSourceId ? (sourceManagerRegistry.getManager(espSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (espManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = espManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // Local node doesn't need session passkey
      return res.json({ success: true, message: 'Local node does not require session passkey' });
    }

    // Check if we already have a valid session passkey
    let sessionPasskey = espManager.getSessionPasskey(destinationNodeNum);
    if (!sessionPasskey) {
      logger.debug(`Requesting session passkey for remote node ${destinationNodeNum}`);
      sessionPasskey = await espManager.requestRemoteSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        return res.status(500).json({ error: `Failed to obtain session passkey for remote node ${destinationNodeNum}` });
      }
    }

    // Return status with expiry info
    const status = espManager.getSessionPasskeyStatus(destinationNodeNum);
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
    const { nodeNum, sourceId: spsSourceId } = req.body;

    const spsManager = (spsSourceId ? (sourceManagerRegistry.getManager(spsSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (spsManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = spsManager.getLocalNodeInfo()?.nodeNum || 0;
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

    const status = spsManager.getSessionPasskeyStatus(destinationNodeNum);
    return res.json({ success: true, isLocalNode: false, ...status });
  } catch (error: any) {
    logger.error('Error getting session passkey status:', error);
    res.status(500).json({ error: error.message || 'Failed to get session passkey status' });
  }
});

// Admin get channel endpoint - requires admin role
apiRouter.post('/admin/get-channel', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, channelIndex, sourceId: gcSourceId } = req.body;

    if (channelIndex === undefined) {
      return res.status(400).json({ error: 'channelIndex is required' });
    }

    const gcManager = (gcSourceId ? (sourceManagerRegistry.getManager(gcSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (gcManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = gcManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, get from database
      const channel = await databaseService.channels.getChannelById(channelIndex);
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
      const channel = await gcManager.requestRemoteChannel(destinationNodeNum, channelIndex);
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
    const { nodeNum, sourceId: loSourceId } = req.body;

    const loManager = (loSourceId ? (sourceManagerRegistry.getManager(loSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (loManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = loManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, use cached info and database (public key is obtained from security config at connection)
      const localNodeInfo = loManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get the public key from database if available (stored from security config).
        // Scope the lookup to loSourceId so we read the local node row for this
        // specific source, not a possibly-stale row with the same nodeNum on
        // another source.
        let publicKeyBase64: string | undefined;
        if (localNodeInfo.nodeNum) {
          const nodeData = await databaseService.nodes.getNode(localNodeInfo.nodeNum, loSourceId);
          publicKeyBase64 = nodeData?.publicKey || undefined;
        }
        return res.json({ owner: {
          longName: localNodeInfo.longName || '' ,
          shortName: localNodeInfo.shortName || '' ,
          isUnmessagable: false,
          isLicensed: false,
          publicKey: publicKeyBase64
        }});
      } else {
        return res.status(404).json({ error: 'Local node information not available' });
      }
    } else {
      // For remote node, request owner info
      const owner = await loManager.requestRemoteOwner(destinationNodeNum);
      if (owner) {
        return res.json({ owner: {
          longName: owner.longName || '' ,
          shortName: owner.shortName || '' ,
          isUnmessagable: owner.isUnmessagable || false,
          isLicensed: owner.isLicensed || false
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
    const { nodeNum, sourceId: gdmSourceId } = req.body;

    const gdmManager = (gdmSourceId ? (sourceManagerRegistry.getManager(gdmSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (gdmManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = gdmManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    if (isLocalNode) {
      // For local node, return cached device metadata from local node info
      const localNodeInfo = gdmManager.getLocalNodeInfo();
      if (localNodeInfo) {
        // Get node data from database for additional info.
        // Scope to gdmSourceId so multi-source deployments read the row
        // belonging to the source whose device metadata is being requested.
        const nodeData = localNodeInfo.nodeNum ? await databaseService.nodes.getNode(localNodeInfo.nodeNum, gdmSourceId) : null;
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
      const metadata = await gdmManager.requestRemoteDeviceMetadata(destinationNodeNum);
      if (metadata) {
        // Successfully retrieved metadata - update hasRemoteAdmin flag and save metadata
        try {
          await databaseService.updateNodeRemoteAdminStatusAsync(
            destinationNodeNum,
            true,
            JSON.stringify(metadata),
            gdmManager.sourceId
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
    const { nodeNum, seconds = 10, sourceId: arSourceId } = req.body;

    const arManager = (arSourceId ? (sourceManagerRegistry.getManager(arSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (arManager.getLocalNodeInfo()?.nodeNum || 0);

    await arManager.sendRebootCommand(destinationNodeNum, Number(seconds));

    logger.info(`✅ Sent reboot command to node ${destinationNodeNum} (in ${seconds} seconds)`);
    res.json({ success: true, message: `Reboot command sent (node will reboot in ${seconds} seconds)` });
  } catch (error: any) {
    logger.error('Error sending reboot command:', error);
    res.status(500).json({ error: error.message || 'Failed to send reboot command' });
  }
});

// Admin suppressed ghosts endpoint - list currently suppressed ghost nodes
apiRouter.get('/admin/suppressed-ghosts', requireAdmin(), async (_req, res) => {
  try {
    const suppressed = await databaseService.getSuppressedGhostNodesAsync();
    res.json({ success: true, suppressedNodes: suppressed });
  } catch (error: any) {
    logger.error('Error getting suppressed ghosts:', error);
    res.status(500).json({ error: error.message || 'Failed to get suppressed ghosts' });
  }
});

// Admin unsuppress ghost endpoint - manually unsuppress a ghost node
apiRouter.delete('/admin/suppressed-ghosts/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    await databaseService.unsuppressGhostNodeAsync(nodeNum);
    res.json({ success: true, message: `Unsuppressed node !${nodeNum.toString(16).padStart(8, '0')}` });
  } catch (error: any) {
    logger.error('Error unsuppressing ghost:', error);
    res.status(500).json({ error: error.message || 'Failed to unsuppress ghost' });
  }
});

// Admin set-time endpoint - sets time on a node to current server time
apiRouter.post('/admin/set-time', requireAdmin(), async (req, res) => {
  try {
    const { nodeNum, sourceId: astSourceId } = req.body;

    const astManager = (astSourceId ? (sourceManagerRegistry.getManager(astSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (astManager.getLocalNodeInfo()?.nodeNum || 0);

    await astManager.sendSetTimeCommand(destinationNodeNum);

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
    const { nodeNum, channelIds, includeLoraConfig, sourceId: aecSourceId } = req.body;

    if (!Array.isArray(channelIds)) {
      return res.status(400).json({ error: 'channelIds must be an array' });
    }

    const aecManager = (aecSourceId ? (sourceManagerRegistry.getManager(aecSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (aecManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = aecManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Get channels from local or remote node
    const channels = [];
    for (const channelId of channelIds) {
      if (isLocalNode) {
        const channel = await databaseService.channels.getChannelById(channelId);
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
        const channel = await aecManager.requestRemoteChannel(destinationNodeNum, channelId);
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
        const deviceConfig = await aecManager.getDeviceConfig();
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
        const loraConfigData = await aecManager.requestRemoteConfig(destinationNodeNum, 5, false); // LORA_CONFIG = 5
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
    const { nodeNum, url: configUrl, sourceId: aicSourceId } = req.body;

    if (!configUrl || typeof configUrl !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }

    const aicManager = (aicSourceId ? (sourceManagerRegistry.getManager(aicSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (aicManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = aicManager.getLocalNodeInfo()?.nodeNum || 0;
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
        await aicManager.beginEditSettings();
        // Pacing: device firmware silently drops admin packets that arrive too soon
        // after BeginEditSettings on TCP PhoneAPI. See /channels/import-config for details.
        await new Promise((resolve) => setTimeout(resolve, 2000));
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
            await aicManager.setChannelConfig(i, {
              name: channel.name || '',
              psk: channel.psk === 'none' ? undefined : channel.psk,
              role: role,
              uplinkEnabled: channel.uplinkEnabled,
              downlinkEnabled: channel.downlinkEnabled,
              positionPrecision: channel.positionPrecision,
            });
            // Pacing between admin packets — same firmware drop pattern.
            await new Promise((resolve) => setTimeout(resolve, 1000));
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
          await aicManager.setLoRaConfig(loraConfigToImport);
          // Pacing: LoRa config triggers heavier device processing; allow extra time
          // before commit so the device has finished applying it.
          await new Promise((resolve) => setTimeout(resolve, 1500));
          loraImported = true;
          requiresReboot = true;
        } catch (error) {
          logger.error(`❌ Failed to import LoRa config:`, error);
        }
      }

      await aicManager.commitEditSettings();
    } else {
      // For remote node, use admin commands via aicManager
      // Ensure session passkey
      let sessionPasskey = aicManager.getSessionPasskey(destinationNodeNum);
      if (!sessionPasskey) {
        sessionPasskey = await aicManager.requestRemoteSessionPasskey(destinationNodeNum);
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
            await aicManager.sendAdminCommand(adminMessage, destinationNodeNum);
            importedChannels.push({ index: i, name: channel.name || '(unnamed)' });
            // Pacing between admin commands — remote node travels via radio so
            // gaps are mostly airtime-bound, but the device-side admin handler
            // exhibits the same drop pattern as local TCP under burst.
            await new Promise(resolve => setTimeout(resolve, 1000));
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
          await aicManager.sendAdminCommand(adminMessage, destinationNodeNum);
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
    const { command, nodeNum, sourceId: acSourceId, ...params } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    const acManager = (acSourceId ? (sourceManagerRegistry.getManager(acSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (acManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = acManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    // Get or request session passkey for remote nodes
    let sessionPasskey: Uint8Array | null = null;
    if (!isLocalNode) {
      sessionPasskey = acManager.getSessionPasskey(destinationNodeNum);
      if (sessionPasskey) {
        logger.info(`🔑 Using cached session passkey for admin command to remote node ${destinationNodeNum}`);
      } else {
        logger.info(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one for admin command...`);
        sessionPasskey = await acManager.requestRemoteSessionPasskey(destinationNodeNum);
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
        adminMessage = protobufService.createRebootMessage(params.seconds || 10, sessionPasskey || undefined);
        break;
      case 'setOwner':
        if (!params.longName || !params.shortName) {
          return res.status(400).json({ error: 'longName and shortName are required for setOwner' });
        }
        adminMessage = protobufService.createSetOwnerMessage(
          params.longName,
          params.shortName,
          params.isUnmessagable,
          sessionPasskey || undefined,
          params.isLicensed
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
          await acManager.sendAdminCommand(setPositionMsg, destinationNodeNum);

          // Immediately update the local node's position in the database so it's correct
          // before any stale position broadcast arrives from the device firmware.
          if (isLocalNode && localNodeNum) {
            const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
            await databaseService.nodes.upsertNode({
              nodeNum: localNodeNum,
              nodeId: localNodeId,
              latitude,
              longitude,
              altitude: altitude || 0,
              positionTimestamp: Date.now(),
            });
            logger.info(`⚙️ Updated local node ${localNodeId} position in database: lat=${latitude}, lon=${longitude}`);
          }
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
      case 'setStatusMessageConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setStatusMessageConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('statusmessage', params.config, sessionPasskey || undefined);
        break;
      case 'setTrafficManagementConfig':
        if (!params.config) {
          return res.status(400).json({ error: 'config is required for setTrafficManagementConfig' });
        }
        adminMessage = protobufService.createSetModuleConfigMessageGeneric('trafficmanagement', params.config, sessionPasskey || undefined);
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
            const existingKeys = acManager.getSecurityKeys();
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
    await acManager.sendAdminCommand(adminMessage, destinationNodeNum);

    // For setSecurityConfig on the local node, update the cached config immediately
    // so the frontend reads back the correct values before the next config sync
    if (command === 'setSecurityConfig' && isLocalNode && params.config) {
      acManager.updateCachedDeviceConfig('security', {
        isManaged: params.config.isManaged,
        serialEnabled: params.config.serialEnabled,
        debugLogApiEnabled: params.config.debugLogApiEnabled,
        adminChannelEnabled: params.config.adminChannelEnabled
      });
    }

    // For setFixedPosition on the local node, immediately update the database
    // so it's correct before any stale position broadcast arrives from the device firmware.
    if (command === 'setFixedPosition' && isLocalNode && localNodeNum) {
      const localNodeId = `!${localNodeNum.toString(16).padStart(8, '0')}`;
      await databaseService.nodes.upsertNode({
        nodeNum: localNodeNum,
        nodeId: localNodeId,
        latitude: params.latitude,
        longitude: params.longitude,
        altitude: params.altitude || 0,
        positionTimestamp: Date.now(),
      });
      logger.info(`⚙️ Updated local node ${localNodeId} position in database: lat=${params.latitude}, lon=${params.longitude}`);
    }

    // If command succeeded on a remote node, update hasRemoteAdmin flag
    if (!isLocalNode) {
      try {
        await databaseService.updateNodeRemoteAdminStatusAsync(
          destinationNodeNum,
          true,
          null,  // Don't overwrite existing metadata, just set the flag
          acManager.sourceId
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
    const { seconds: purgeSeconds, sourceId: purgeSourceId } = req.body || {};
    const seconds = purgeSeconds || 0;
    const purgeManager = (purgeSourceId ? (sourceManagerRegistry.getManager(purgeSourceId) as typeof meshtasticManager ?? meshtasticManager) : meshtasticManager);

    // Purge the device's node database
    await purgeManager.purgeNodeDb(seconds);

    // Also purge the local database
    logger.info('🗑️ Purging local node database');
    await databaseService.purgeAllNodesAsync();
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
apiRouter.get('/status', optionalAuth(), async (_req, res) => {
  const connectionStatus = await meshtasticManager.getConnectionStatus();
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
      nodes: await databaseService.nodes.getNodeCount(),
      messages: await databaseService.messages.getMessageCount(),
      channels: await databaseService.channels.getChannelCount(),
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
      const autoUpgradeImmediate = await databaseService.settings.getSetting('autoUpgradeImmediate') === 'true';
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
              databaseService.auditLogAsync(
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
apiRouter.post(
  '/push/subscribe',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req, res) => {
    try {
      const { subscription, sourceId } = req.body;

      if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid subscription data' });
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      // Validate source exists
      const source = await databaseService.sources.getSource(sourceId);
      if (!source) {
        return res.status(400).json({ error: `Unknown sourceId: ${sourceId}` });
      }

      const userId = req.session?.userId;
      const userAgent = req.headers['user-agent'];

      await pushNotificationService.saveSubscription(userId, subscription, userAgent, sourceId);

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error saving push subscription:', error);
      res.status(500).json({ error: error.message || 'Failed to save subscription' });
    }
  }
);

// Unsubscribe from push notifications
apiRouter.post(
  '/push/unsubscribe',
  optionalAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req, res) => {
    try {
      const { endpoint, sourceId } = req.body;

      if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
      }
      if (!sourceId || typeof sourceId !== 'string') {
        return res.status(400).json({ error: 'sourceId is required' });
      }

      await pushNotificationService.removeSubscription(endpoint);

      res.json({ success: true });
    } catch (error: any) {
      logger.error('Error removing push subscription:', error);
      res.status(500).json({ error: error.message || 'Failed to remove subscription' });
    }
  }
);

// Test push notification (admin only)
apiRouter.post('/push/test', requireAdmin(), async (req, res) => {
  try {
    const userId = req.session?.userId;

    // Get local node name for prefix
    const localNodeInfo = meshtasticManager.getLocalNodeInfo();
    const localNodeName = localNodeInfo?.longName || null;

    // Apply prefix if user has it enabled
    const baseBody = 'This is a test push notification from MeshMonitor';
    const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);

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
apiRouter.get(
  '/push/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'query' }),
  async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sourceId = typeof req.query.sourceId === 'string' && req.query.sourceId
      ? req.query.sourceId
      : undefined;

    const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);

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
        mutedChannels: [],
        mutedDMs: [],
      });
    }
  } catch (error: any) {
    logger.error('Error loading notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to load preferences' });
  }
  }
);

// Save notification preferences (unified for Web Push and Apprise)
apiRouter.post(
  '/push/preferences',
  requireAuth(),
  requirePermission('messages', 'read', { sourceIdFrom: 'body' }),
  async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId
      ? req.body.sourceId
      : undefined;

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
      mutedChannels,
      mutedDMs,
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

    // Validate mutedChannels
    if (mutedChannels !== undefined && !Array.isArray(mutedChannels)) {
      return res.status(400).json({ error: 'mutedChannels must be an array' });
    }
    if (mutedChannels && mutedChannels.some((r: any) =>
      typeof r !== 'object' || r === null ||
      typeof r.channelId !== 'number' ||
      (r.muteUntil !== null && typeof r.muteUntil !== 'number')
    )) {
      return res.status(400).json({ error: 'mutedChannels entries must have channelId (number) and muteUntil (number|null)' });
    }

    // Validate mutedDMs
    if (mutedDMs !== undefined && !Array.isArray(mutedDMs)) {
      return res.status(400).json({ error: 'mutedDMs must be an array' });
    }
    if (mutedDMs && mutedDMs.some((r: any) =>
      typeof r !== 'object' || r === null ||
      typeof r.nodeUuid !== 'string' ||
      (r.muteUntil !== null && typeof r.muteUntil !== 'number')
    )) {
      return res.status(400).json({ error: 'mutedDMs entries must have nodeUuid (string) and muteUntil (number|null)' });
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
      mutedChannels: mutedChannels ?? [],
      mutedDMs: mutedDMs ?? [],
    };

    const success = await saveUserNotificationPreferencesAsync(userId, prefs, sourceId);

    if (success) {
      logger.info(
        `✅ Saved notification preferences for user ${userId} source=${sourceId ?? '(default)'} (WebPush: ${enableWebPush}, Apprise: ${enableApprise})`
      );
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to save preferences' });
    }
  } catch (error: any) {
    logger.error('Error saving notification preferences:', error);
    res.status(500).json({ error: error.message || 'Failed to save preferences' });
  }
  }
);

// ==========================================
// Apprise Notification Endpoints
// ==========================================

// Get Apprise status (admin only)
apiRouter.get('/apprise/status', requireAdmin(), async (_req, res) => {
  try {
    const isAvailable = appriseNotificationService.isAvailable();
    res.json({
      available: isAvailable,
      enabled: await databaseService.settings.getSetting('apprise_enabled') === 'true',
      url: await databaseService.settings.getSetting('apprise_url') || 'http://localhost:8000',
    });
  } catch (error: any) {
    logger.error('Error getting Apprise status:', error);
    res.status(500).json({ error: error.message || 'Failed to get Apprise status' });
  }
});

// Send test Apprise notification (admin only)
apiRouter.post(
  '/apprise/test',
  requireAdmin(),
  requirePermission('settings', 'write', { sourceIdFrom: 'body' }),
  async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const sourceId = typeof req.body?.sourceId === 'string' && req.body.sourceId
      ? req.body.sourceId
      : undefined;
    if (!sourceId) {
      return res.status(400).json({ success: false, message: 'sourceId is required' });
    }

    // Resolve source for sourceName
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) {
      return res.status(400).json({ success: false, message: `Unknown sourceId: ${sourceId}` });
    }

    // Get user's Apprise URLs from their preferences (per-source)
    const prefs = await getUserNotificationPreferencesAsync(userId, sourceId);
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
    const body = await applyNodeNamePrefixAsync(userId, baseBody, localNodeName);

    // Send to user's configured URLs
    const success = await appriseNotificationService.sendNotificationToUrls(
      {
        title: 'Test Notification',
        body,
        type: 'info',
        sourceId,
        sourceName: source.name ?? sourceId,
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
  }
);

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
apiRouter.put('/apprise/enabled', requireAdmin(), async (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }

    await databaseService.settings.setSetting('apprise_enabled', enabled ? 'true' : 'false');
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
  // Strip HTML tags. A single pass is not enough because a stripped tag can
  // leave a new tag behind (e.g. `<scr<script>ipt>` → `<script>`), so loop
  // until the replacement is a fixed point.
  let stripped = value;
  // Bound the loop so a pathological input can't keep us iterating forever.
  for (let i = 0; i < 10; i++) {
    const next = stripped.replace(/<[^>]*>/g, '');
    if (next === stripped) break;
    stripped = next;
  }
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
  app.get(`${BASE_URL}/api/scripts`, apiLimiter, scriptsEndpoint);
}
app.get('/api/scripts', apiLimiter, scriptsEndpoint);

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
      const allPatterns = normalizeTriggerPatterns(trigger);
      // Cap the number of candidate patterns to prevent user input from
      // driving an unbounded match loop.
      const MAX_PATTERNS = 100;
      const patterns = allPatterns.slice(0, MAX_PATTERNS);

      // Try each pattern until one matches
      for (const patternStr of patterns) {
        // ReDoS guard: reject overly long patterns and classic catastrophic-
        // backtracking shapes before compiling. Script-trigger patterns are
        // admin-authored but CodeQL flags the regex compile below as
        // user-controlled, so we enforce the same bounds the UI does.
        if (patternStr.length > 500) {
          return res.status(400).json({ error: 'Trigger pattern too long (max 500 characters).' });
        }
        if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(patternStr)) {
          return res.status(400).json({ error: 'Trigger pattern too complex or may cause performance issues.' });
        }
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
            // Guard against prototype-pollution / remote-property-injection:
            // only accept simple identifier-style names, never `__proto__` etc.
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) {
              return;
            }
            Object.defineProperty(extractedParams, param.name, {
              value: triggerMatch[index + 1],
              enumerable: true,
              writable: true,
              configurable: true,
            });
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

    const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';

    switch (ext) {
      case 'js':
      case 'mjs':
        interpreter = useSystemBin ? 'node' : '/usr/local/bin/node';
        break;
      case 'py':
        interpreter = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
        break;
      case 'sh':
        interpreter = useSystemBin ? 'sh' : '/bin/sh';
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
    const meshtasticIp = process.env.MESHTASTIC_NODE_IP || process.env.MESHTASTIC_IP || process.env.NODE_IP || '127.0.0.1';
    const meshtasticPort = process.env.MESHTASTIC_NODE_PORT || process.env.MESHTASTIC_PORT || process.env.NODE_PORT || '4403';
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
        timeout: 30000,
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
          error: 'Script execution timed out after 30 seconds',
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
      const response = await safeFetch(url, {
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

      if (fetchError instanceof SsrfBlockedError) {
        logger.warn(`HTTP test blocked by SSRF guard (${fetchError.reason}): ${url}`);
        return res.status(400).json({ error: 'URL target not allowed' });
      }

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
      const resolvedScriptsDir = path.resolve(scriptsDir);
      const filePath = path.resolve(path.join(scriptsDir, sanitizedFilename));

      // Defense in depth: reject any filename that, after resolution, would
      // escape the scripts directory (e.g. symlink tricks or odd basename edge
      // cases). path.basename() already stripped path components above.
      if (!filePath.startsWith(resolvedScriptsDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

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

// Public embed config API (must come BEFORE apiRouter to avoid rate limiter and CSRF)
// CSP middleware is applied per-route inside the router (needs req.params.profileId)
if (BASE_URL) {
  app.use(`${BASE_URL}/api/embed`, embedPublicRoutes);
}
app.use('/api/embed', embedPublicRoutes);

// Mount API router - this must come before static file serving
// Apply rate limiting and CSRF protection to all API routes (except csrf-token endpoint)
if (BASE_URL) {
  app.use(`${BASE_URL}/api`, apiLimiter, csrfProtection, apiRouter);
} else {
  app.use('/api', apiLimiter, csrfProtection, apiRouter);
}

// Function to rewrite HTML with BASE_URL at runtime
// Cache for rewritten HTML to avoid repeated file reads
let cachedHtml: string | null = null;
let cachedRewrittenHtml: string | null = null;
let cachedEmbedHtml: string | null = null;
let cachedRewrittenEmbedHtml: string | null = null;

export function invalidateHtmlCache(): void {
  cachedRewrittenHtml = null;
  cachedRewrittenEmbedHtml = null;
}

async function getAnalyticsScript(): Promise<string> {
  try {
    const provider = (await databaseService.settings.getSetting('analyticsProvider') || 'none') as AnalyticsProvider;
    if (provider === 'none') return '';
    const configStr = await databaseService.settings.getSetting('analyticsConfig') || '{}';
    const config = JSON.parse(configStr);
    return generateAnalyticsScript(provider, config);
  } catch {
    return '';
  }
}

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

  // Serve embed page (before SPA fallback)
  app.get(`${BASE_URL}/embed/:profileId`, createEmbedCspMiddleware(), async (_req: express.Request, res: express.Response) => {
    if (!cachedRewrittenEmbedHtml) {
      const embedHtmlPath = path.join(buildPath, 'embed.html');
      if (!fs.existsSync(embedHtmlPath)) {
        return res.status(404).send('Embed page not found');
      }
      cachedEmbedHtml = fs.readFileSync(embedHtmlPath, 'utf-8');
      const embedAnalyticsScript = await getAnalyticsScript();
      cachedRewrittenEmbedHtml = rewriteHtml(cachedEmbedHtml, BASE_URL, embedAnalyticsScript);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(cachedRewrittenEmbedHtml);
  });

  // Catch all handler for SPA routing - but exclude /api
  app.get(`${BASE_URL}`, async (_req: express.Request, res: express.Response) => {
    // Use cached HTML if available, otherwise read and cache
    if (!cachedRewrittenHtml) {
      const htmlPath = path.join(buildPath, 'index.html');
      cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
      const analyticsScript = await getAnalyticsScript();
      cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
    }
    res.type('html').send(cachedRewrittenHtml);
  });
  // Use a route pattern that Express 5 can handle
  app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
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
      const analyticsScript = await getAnalyticsScript();
      cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
    }
    res.type('html').send(cachedRewrittenHtml);
  });
} else {
  // Normal static file serving for root deployment.
  //
  // IMPORTANT: `index: false` disables express.static's automatic index.html
  // serving. We handle index.html ourselves (below) so we can inject the
  // configured analytics script into <head>. Without this flag, a request
  // for `/` would be served by static middleware with the raw index.html,
  // bypassing analytics injection entirely — which is the bug that caused
  // GA4 tags to silently not appear on root deployments.
  app.use(express.static(buildPath, { index: false }));

  // Serve embed page (before SPA fallback)
  app.get('/embed/:profileId', createEmbedCspMiddleware(), async (_req: express.Request, res: express.Response) => {
    if (!cachedRewrittenEmbedHtml) {
      const embedHtmlPath = path.join(buildPath, 'embed.html');
      if (!fs.existsSync(embedHtmlPath)) {
        return res.status(404).send('Embed page not found');
      }
      cachedEmbedHtml = fs.readFileSync(embedHtmlPath, 'utf-8');
      const embedAnalyticsScript = await getAnalyticsScript();
      cachedRewrittenEmbedHtml = rewriteHtml(cachedEmbedHtml, BASE_URL, embedAnalyticsScript);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(cachedRewrittenEmbedHtml);
  });

  // Catch all handler for SPA routing - skip API routes
  app.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Skip if this is an API route
    if (req.path.startsWith('/api')) {
      return next();
    }
    // Serve cached rewritten HTML (with analytics injected)
    if (!cachedRewrittenHtml) {
      const htmlPath = path.join(buildPath, 'index.html');
      cachedHtml = fs.readFileSync(htmlPath, 'utf-8');
      const analyticsScript = await getAnalyticsScript();
      cachedRewrittenHtml = rewriteHtml(cachedHtml, BASE_URL, analyticsScript);
    }
    res.type('html').send(cachedRewrittenHtml);
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

  const shutdownDependencies = (): void => {
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
  };

  // SIGTERM can arrive during startup (e.g. while long migrations run on a
  // big MySQL telemetry table) before app.listen() has assigned `server`.
  // Don't crash on undefined here — just close the rest and exit.
  if (server) {
    server.close(() => {
      logger.debug('✅ HTTP server closed');
      shutdownDependencies();
    });
  } else {
    logger.info('HTTP server not yet started — skipping server.close()');
    shutdownDependencies();
  }

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
async function migrateAutoResponderTriggers() {
  try {
    await databaseService.waitForReady();
    const triggersStr = await databaseService.settings.getSetting('autoResponderTriggers');
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
      await databaseService.settings.setSetting('autoResponderTriggers', JSON.stringify(migratedTriggers));
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

  // Eagerly load Meshtastic protobuf definitions so source-independent routes
  // (e.g. /api/channels/decode-url) work even before any source manager has started.
  try {
    const { loadProtobufDefinitions } = await import('./protobufLoader.js');
    await loadProtobufDefinitions();
    logger.info('✅ Protobuf definitions loaded');
  } catch (error) {
    logger.error('❌ Failed to load protobuf definitions:', error);
  }

  // Eagerly populate embed origins cache so first CORS check works
  refreshEmbedOriginsCache();

  server = app.listen(PORT, () => {
    logger.debug(`MeshMonitor server running on port ${PORT}`);
    logger.debug(`Environment: ${env.nodeEnv}`);

    // Initialize WebSocket server for real-time updates
    initializeWebSocket(server, sessionMiddleware);

    // Start firmware release polling (periodic GitHub checks)
    firmwareUpdateService.startPolling();

    // Send server start notification
    (async () => {
      try {
        const enabledFeatures: string[] = ['WebSocket']; // WebSocket is always enabled
      if (env.oidcEnabled) enabledFeatures.push('OIDC');
      if (env.accessLogEnabled) enabledFeatures.push('Access Logging');
      if (pushNotificationService.isAvailable()) enabledFeatures.push('Web Push');
      if (appriseNotificationService.isAvailable()) enabledFeatures.push('Apprise');

      // Phase C: dispatch server-start per source so per-source subscribers/permissions apply
      const enabledSources = await databaseService.sources.getEnabledSources();
      if (enabledSources.length === 0) {
        logger.debug('No enabled sources — skipping server-start notification');
      }
      for (const src of enabledSources) {
        await serverEventNotificationService.notifyServerStart(
          { version: packageJson.version, features: enabledFeatures },
          src.id,
          src.name
        );
      }
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
