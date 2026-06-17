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
import { resolveSourceManager } from './utils/resolveSourceManager.js';
import { canonicalMessageTime, messageReceivedAt } from './utils/messageTime.js';
import { scriptDependencyEnv } from './utils/scriptRunner.js';
import { getDependencyStatus, installDependencies } from './services/scriptDependencyService.js';
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
import { positionEstimationScheduler } from './services/positionEstimationScheduler.js';
import { autoFavoriteManagementScheduler } from './services/autoFavoriteManagementService.js';
import { systemRestoreService } from './services/systemRestoreService.js';
import { duplicateKeySchedulerService } from './services/duplicateKeySchedulerService.js';
import { waypointRebroadcastSchedulerService } from './services/waypointRebroadcastSchedulerService.js';
import { securityDigestService } from './services/securityDigestService.js';
import { solarMonitoringService } from './services/solarMonitoringService.js';
import { newsService } from './services/newsService.js';
import { inactiveNodeNotificationService } from './services/inactiveNodeNotificationService.js';
import { lowBatteryNotificationService } from './services/lowBatteryNotificationService.js';
import { serverEventNotificationService } from './services/serverEventNotificationService.js';
import { autoDeleteByDistanceService } from './services/autoDeleteByDistanceService.js';
import { upgradeService } from './services/upgradeService.js';
import { enhanceNodeForClient, filterNodesByChannelPermission, checkNodeChannelAccess, getEffectiveDbNodePosition } from './utils/nodeEnhancer.js';
import { dynamicCspMiddleware, refreshTileHostnameCache } from './middleware/dynamicCsp.js';
import { generateAnalyticsScript, AnalyticsProvider } from './utils/analyticsScriptGenerator.js';
import { rewriteHtml } from './utils/htmlRewriter.js';
import { migrateAutomationChannels } from './utils/automationChannelMigration.js';
import { safeFetch, SsrfBlockedError } from './utils/ssrfGuard.js';
import { resolveRequestSourceId } from './utils/sourceResolver.js';
import { parseDestinationNum } from './utils/parseDestination.js';
import { PortNum, modemPresetChannelName, getRoutingErrorName } from './constants/meshtastic.js';
import { isValidModuleConfigType } from './constants/moduleConfig.js';
import { CONFIG_TYPE_MAP, MODULE_FIELD_BY_ID, DEVICE_FIELD_BY_ID } from './constants/configTypes.js';
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
    const enabledSourcesRaw = await databaseService.sources.getEnabledSources();
    // Sort so mqtt_broker sources start before mqtt_bridge sources — bridges
    // resolve their parent broker via the registry, and while they can
    // attach later via the deferred 'manager-started' event, starting in
    // order keeps the happy path racefree.
    const typeStartOrder = (t: string) =>
      t === 'mqtt_broker' ? 0 : t === 'mqtt_bridge' ? 2 : 1;
    const enabledSources = [...enabledSourcesRaw].sort(
      (a, b) => typeStartOrder(a.type) - typeStartOrder(b.type),
    );
    let firstTcpSourceConfigured = false;

    for (const source of enabledSources) {
      if (source.type === 'mqtt_broker' || source.type === 'mqtt_bridge') {
        try {
          const manager = buildMqttManagerForSource(
            source.id,
            source.name,
            source.type,
            source.config,
          );
          await sourceManagerRegistry.addManager(manager);
          logger.info(`Started MQTT ${source.type} source ${source.id} (${source.name})`);
        } catch (err) {
          logger.error(`Failed to start MQTT source ${source.id} (${source.name}):`, err);
        }
        continue;
      }

      if (source.type === 'meshcore') {
        // Slice 1 of multi-source MeshCore: spin up a per-source manager
        // and connect it. Companion-USB only — other transports will be
        // wired in slice 2.
        const cfg = source.config as any;
        if (cfg?.autoConnect === false) {
          logger.info(`Skipping auto-connect for MeshCore source ${source.id} (${source.name}) — autoConnect disabled`);
          continue;
        }

        try {
          const mcConfig = meshcoreConfigFromSource(source);
          if (!mcConfig) {
            logger.warn(`MeshCore source ${source.id} (${source.name}) has incomplete config; skipping auto-connect`);
            continue;
          }
          const manager = meshcoreManagerRegistry.getOrCreate(source);
          const connected = await manager.connect(mcConfig);
          if (connected) {
            logger.info(`[MeshCore:${source.id}] Auto-connected source ${source.name}`);
          } else {
            logger.warn(`[MeshCore:${source.id}] Auto-connect failed for source ${source.name}`);
          }
        } catch (err) {
          logger.error(`Failed to start MeshCore source ${source.id} (${source.name}); continuing with other sources:`, err);
        }
        continue;
      }

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
              mqttLink: cfg.mqttLink,
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
              mqttLink: cfg.mqttLink,
            });
            await applyManagerSettings(manager, source.id, databaseService);
            await sourceManagerRegistry.addManager(manager);
          }
        } catch (err) {
          // Don't let one failed source block others from registering.
          // The manager's internal retry logic will reconnect when reachable.
          logger.error(`Failed to start source ${source.id} (${source.name}); continuing with other sources:`, err);
        }
        continue;
      }

      // Unknown source type — most likely a leftover row from a deprecated
      // type (e.g. the pre-#3003 'mqtt' subscriber type). Surface a warning
      // so it shows up in logs; the source will appear in the dashboard
      // sidebar as never-connected until the user deletes it.
      logger.warn(
        `Source ${source.id} (${source.name}) has unknown type "${source.type}" — no manager will be started. Delete the source if it is no longer needed.`,
      );
    }

    if (!firstTcpSourceConfigured) {
      // No sources configured — use legacy singleton with env-var config
      await meshtasticManager.connect();
      logger.debug('Meshtastic manager connected (legacy mode, no sources configured)');
    } else {
      logger.debug(`Started ${enabledSources.length} source manager(s)`);
    }

    // Initialize backup scheduler
    backupSchedulerService.initialize(meshtasticManager);
    logger.debug('Backup scheduler initialized');

    // Initialize duplicate key scanner
    duplicateKeySchedulerService.start();
    logger.debug('Duplicate key scanner initialized');

    waypointRebroadcastSchedulerService.start();

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

    // Initialize position estimation scheduler (global, batch — issue #3271)
    positionEstimationScheduler.initialize();
    logger.debug('Position estimation scheduler initialized');

    // Initialize automated remote favorites management scheduler (issue #2608)
    autoFavoriteManagementScheduler.initialize();
    logger.debug('Auto-favorite management scheduler initialized');

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

    // Start low battery notification service with validation.
    // Per-user threshold is read from notification preferences at check time;
    // only the check interval and cooldown are global admin settings here.
    const lowBatteryCheckIntervalMinutesRaw = parseInt(
      await databaseService.settings.getSetting('lowBatteryCheckIntervalMinutes') || '60',
      10
    );
    const lowBatteryCooldownHoursRaw = parseInt(await databaseService.settings.getSetting('lowBatteryCooldownHours') || '24', 10);

    const lowBatteryCheckIntervalMinutes =
      !isNaN(lowBatteryCheckIntervalMinutesRaw) &&
      lowBatteryCheckIntervalMinutesRaw >= 1 &&
      lowBatteryCheckIntervalMinutesRaw <= 1440
        ? lowBatteryCheckIntervalMinutesRaw
        : 60;
    const lowBatteryCooldownHours =
      !isNaN(lowBatteryCooldownHoursRaw) && lowBatteryCooldownHoursRaw >= 1 && lowBatteryCooldownHoursRaw <= 720
        ? lowBatteryCooldownHoursRaw
        : 24;

    if (
      lowBatteryCheckIntervalMinutes !== lowBatteryCheckIntervalMinutesRaw ||
      lowBatteryCooldownHours !== lowBatteryCooldownHoursRaw
    ) {
      logger.warn(
        `⚠️  Invalid low battery notification settings found in database, using defaults (check: ${lowBatteryCheckIntervalMinutes}min, cooldown: ${lowBatteryCooldownHours}h)`
      );
    }

    lowBatteryNotificationService.start(lowBatteryCheckIntervalMinutes, lowBatteryCooldownHours);
    logger.info('✅ Low battery notification service started');

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
// MeshCore local-node telemetry poller
// ==========================================
// Sample every connected MeshCore COMPANION manager every
// MESHCORE_TELEMETRY_INTERVAL_MS (default 5 minutes). All commands hit the
// locally-attached node only — no RF — so the poller is safe to run on a
// fixed cadence regardless of mesh topology. Exposed back to the request
// handlers as `meshcoreTelemetryPoller` so the Info endpoint can serve the
// last cached snapshot without forcing a synchronous bridge round-trip.
export const meshcoreTelemetryPoller = new MeshCoreTelemetryPoller({
  registry: meshcoreManagerRegistry,
  database: databaseService,
});
setMeshCoreTelemetryPoller(meshcoreTelemetryPoller);
setTimeout(async () => {
  try {
    await databaseService.waitForReady();
    meshcoreTelemetryPoller.start();
    // Run one immediately so the Info page has data without waiting a
    // full interval after first connect.
    meshcoreTelemetryPoller.pollOnce().catch((err) =>
      logger.warn('[MeshCorePoller] Initial poll failed:', err),
    );
  } catch (error) {
    logger.error('Failed to start MeshCore telemetry poller:', error);
  }
}, 7000); // Slightly after the initial telemetry purge so the DB is settled.

// ==========================================
// MeshCore remote-telemetry scheduler
// ==========================================
// Periodically issues `req_telemetry_sync` against each opt-in remote
// node. Unlike the local-node poller above, this DOES transmit on the
// air, so it honours a per-source 60s minimum via the shared
// `MeshCoreManager.lastMeshTxAt` primitive and only fires when a node's
// own `telemetryIntervalMinutes` cadence has elapsed.
export const meshcoreRemoteTelemetryScheduler = new MeshCoreRemoteTelemetryScheduler({
  registry: meshcoreManagerRegistry,
  database: databaseService,
});
setMeshCoreRemoteTelemetryScheduler(meshcoreRemoteTelemetryScheduler);
setTimeout(async () => {
  try {
    await databaseService.waitForReady();
    meshcoreRemoteTelemetryScheduler.start();
  } catch (error) {
    logger.error('Failed to start MeshCore remote-telemetry scheduler:', error);
  }
}, 8000); // After local poller so we never race the first per-manager TX.

// MeshCore Room Sync Scheduler — periodically re-logins to room servers
// with saved credentials to trigger post push-sync.
const meshcoreRoomSyncScheduler = new MeshCoreRoomSyncScheduler({
  registry: meshcoreManagerRegistry,
  credentialStore: getMeshCoreCredentialStore(),
});
setMeshCoreRoomSyncScheduler(meshcoreRoomSyncScheduler);
setTimeout(async () => {
  try {
    await databaseService.waitForReady();
    meshcoreRoomSyncScheduler.start();
  } catch (error) {
    logger.error('Failed to start MeshCore room-sync scheduler:', error);
  }
}, 10000); // After telemetry scheduler.

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

  // Skip if the DatabaseService hasn't finished initializing repositories yet.
  // The initial-check setTimeout fires 60s after process start; on installs
  // with long-running migrations (e.g. PG migration 030 rebuilding hundreds
  // of thousands of route_segments rows) that timer can fire mid-migration
  // and crash on the `settings` getter with `Database not initialized`.
  // The next 4-hour interval tick will retry once the DB is up.
  if (!databaseService.isDatabaseReady()) {
    logger.debug('Skipping auto-upgrade check: database not ready yet (migrations in progress)');
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

// Boot-time upgrade reconciliation: resolve any pending upgrade_history row
// left behind by the previous container before the 60-second auto-upgrade
// check timer fires. Without this, the pending row sits until it ages past
// STALE_TIMEOUT_MS (30 min) and is wrongly marked failed, eventually tripping
// the circuit breaker even though the watchdog succeeded (issue #3228).
setTimeout(async () => {
  try {
    if (upgradeService.isEnabled()) {
      await databaseService.waitForReady();
      await upgradeService.syncPendingUpgradeStatusOnBoot();
    }
  } catch (error) {
    logger.error('Error in boot-time upgrade status sync:', error);
  }
}, 10 * 1000); // 10 seconds — well before the 60-second auto-upgrade check

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
import { meshcoreManagerRegistry, meshcoreConfigFromSource } from './meshcoreRegistry.js';
import { MeshCoreTelemetryPoller, setMeshCoreTelemetryPoller } from './services/meshcoreTelemetryPoller.js';
import {
  MeshCoreRemoteTelemetryScheduler,
  setMeshCoreRemoteTelemetryScheduler,
} from './services/meshcoreRemoteTelemetryScheduler.js';
import {
  MeshCoreRoomSyncScheduler,
  setMeshCoreRoomSyncScheduler,
} from './services/meshcoreRoomSyncScheduler.js';
import { getMeshCoreCredentialStore } from './services/meshcoreCredentialStore.js';
import embedProfileRoutes from './routes/embedProfileRoutes.js';
import { createEmbedCspMiddleware } from './middleware/embedMiddleware.js';
import embedPublicRoutes from './routes/embedPublicRoutes.js';
import firmwareUpdateRoutes from './routes/firmwareUpdateRoutes.js';
import sourceRoutes, { buildMqttManagerForSource } from './routes/sourceRoutes.js';
import unifiedRoutes from './routes/unifiedRoutes.js';
import analysisRoutes from './routes/analysisRoutes.js';
import { firmwareUpdateService } from './services/firmwareUpdateService.js';
import { createGeoJsonRouter } from './routes/geojsonRoutes.js';
import { GeoJsonService } from './services/geojsonService.js';
import { MapStyleService } from './services/mapStyleService.js';
import { createMapStyleRouter } from './routes/mapStyleRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import cleanupRoutes from './routes/cleanupRoutes.js';
import maintenanceRoutes from './routes/maintenanceRoutes.js';
import themeRoutes from './routes/themeRoutes.js';
import purgeRoutes from './routes/purgeRoutes.js';
import tracerouteRoutes from './routes/tracerouteRoutes.js';
import routeSegmentRoutes from './routes/routeSegmentRoutes.js';
import neighborInfoRoutes from './routes/neighborInfoRoutes.js';
import ignoredNodeRoutes from './routes/ignoredNodeRoutes.js';
import announceRoutes from './routes/announceRoutes.js';
import { backupRouter, systemBackupRouter } from './routes/backupRoutes.js';
import { pushRouter, appriseRouter } from './routes/notificationRoutes.js';
import meshRequestRoutes from './routes/meshRequestRoutes.js';
import telemetryRoutes from './routes/telemetryRoutes.js';
import connectionRoutes from './routes/connectionRoutes.js';
import deviceStatusRoutes from './routes/deviceStatusRoutes.js';
import statusRoutes from './routes/statusRoutes.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Health check endpoints (for upgrade watchdog and monitoring)
apiRouter.use('/health', healthRoutes);

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
apiRouter.use('/users', optionalAuth(), userRoutes);

// Audit log routes (admin only)
apiRouter.use('/audit', optionalAuth(), auditRoutes);

// Channel database routes (admin only, session-based)
apiRouter.use('/channel-database', optionalAuth(), channelDatabaseRoutes);

// Security routes (requires security:read)
apiRouter.use('/security', optionalAuth(), securityRoutes);

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

// MeshCore routes — nested under `/api/sources/:id/meshcore/*` so each
// request resolves the manager bound to a specific source. The legacy
// un-nested `/api/meshcore/*` mount was dropped in slice 3 along with
// the global `meshcore` permission resource; the new frontend talks to
// the per-source surface only.
apiRouter.use('/sources/:id/meshcore', meshcoreRoutes);

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
apiRouter.use('/cleanup', cleanupRoutes);
apiRouter.use('/maintenance', maintenanceRoutes);
apiRouter.use('/themes', themeRoutes);
apiRouter.use('/purge', purgeRoutes);
apiRouter.use('/traceroutes', tracerouteRoutes);
apiRouter.use('/route-segments', routeSegmentRoutes);
apiRouter.use('/neighbor-info', neighborInfoRoutes);
apiRouter.use('/ignored-nodes', ignoredNodeRoutes);
apiRouter.use('/announce', announceRoutes);
apiRouter.use('/backup', backupRouter);
apiRouter.use('/system/backup', systemBackupRouter);
apiRouter.use('/push', pushRouter);
apiRouter.use('/apprise', appriseRouter);
apiRouter.use('/connection', connectionRoutes);
// Mounted at '/' because these routers contain mixed top-level paths
// (e.g. /traceroute, /telemetry/:nodeId, /device/tx-status, /virtual-node/status).
apiRouter.use('/', meshRequestRoutes);
apiRouter.use('/', telemetryRoutes);
apiRouter.use('/', deviceStatusRoutes);
apiRouter.use('/', statusRoutes);

// Wire up side-effect callbacks for settingsRoutes
setSettingsCallbacks({
  refreshTileHostnameCache,
  setTracerouteInterval: (interval) => meshtasticManager.setTracerouteInterval(interval),
  setRemoteAdminScannerInterval: (interval, sourceId) => {
    const mgr = resolveSourceManager(sourceId);
    mgr.setRemoteAdminScannerInterval(interval);
  },
  setLocalStatsInterval: (interval) => meshtasticManager.setLocalStatsInterval(interval),
  setKeyRepairSettings: (settings) => meshtasticManager.setKeyRepairSettings(settings),
  restartInactiveNodeService: (threshold, check, cooldown) =>
    inactiveNodeNotificationService.start(threshold, check, cooldown),
  stopInactiveNodeService: () => inactiveNodeNotificationService.stop(),
  restartLowBatteryService: (check, cooldown) =>
    lowBatteryNotificationService.start(check, cooldown),
  stopLowBatteryService: () => lowBatteryNotificationService.stop(),
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
  setAutomationAirtimeCutoffThreshold: (threshold: number, sourceId?: string | null) => {
    if (sourceId) {
      const mgr = sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager | undefined;
      mgr?.setAutomationAirtimeCutoffThreshold(threshold);
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers() as (typeof meshtasticManager)[]) {
        mgr.setAutomationAirtimeCutoffThreshold(threshold);
      }
    }
  },
  setAutomationAirtimeCutoffSource: (source: string, sourceId?: string | null) => {
    if (sourceId) {
      const mgr = sourceManagerRegistry.getManager(sourceId) as typeof meshtasticManager | undefined;
      mgr?.setAutomationAirtimeCutoffSource(source);
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers() as (typeof meshtasticManager)[]) {
        mgr.setAutomationAirtimeCutoffSource(source);
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

    // Append MeshCore contacts/localNodes so the aggregate dashboard map can
    // render them alongside Meshtastic nodes. MeshCore stores lastSeen in ms;
    // dashboard age-cutoff expects seconds, so we down-convert here.
    const meshcoreManagers = nodesSourceId
      ? (meshcoreManagerRegistry.get(nodesSourceId) ? [meshcoreManagerRegistry.get(nodesSourceId)!] : [])
      : meshcoreManagerRegistry.list();
    // By default MeshCore nodes are only appended when they have a position
    // (the aggregate dashboard map use-case). Consumers that need the full node
    // list regardless of position — e.g. the notification monitored-node picker,
    // so battery-powered companions without a GPS fix can still be selected —
    // pass includeAllMeshcore=true to drop the position gate.
    const includeAllMeshcore = req.query.includeAllMeshcore === 'true';
    const meshcoreNodes: any[] = [];
    for (const mgr of meshcoreManagers) {
      for (const n of mgr.getAllNodes()) {
        const hasPosition = n.latitude != null && n.longitude != null && !(n.latitude === 0 && n.longitude === 0);
        if (!hasPosition && !includeAllMeshcore) continue;
        const lastHeard = typeof n.lastHeard === 'number'
          ? Math.floor(n.lastHeard / 1000)
          : Math.floor(Date.now() / 1000);
        const pubKey = n.publicKey || '';
        const nodeId = `mc:${mgr.sourceId}:${pubKey.substring(0, 12)}`;
        meshcoreNodes.push({
          nodeId,
          nodeNum: 0,
          sourceId: mgr.sourceId,
          isMeshCore: true,
          isIgnored: false,
          isFavorite: false,
          user: { id: nodeId, longName: n.name, shortName: (n.name || '').substring(0, 4) },
          longName: n.name,
          shortName: (n.name || '').substring(0, 4),
          ...(hasPosition
            ? {
                latitude: n.latitude,
                longitude: n.longitude,
                position: { latitude: n.latitude, longitude: n.longitude },
              }
            : {}),
          lastHeard,
          hopsAway: 0,
          role: 0,
        });
      }
    }

    res.json([...enhancedNodes, ...meshcoreNodes]);
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

// Copy NodeInfo from another source
import { findCopyCandidates, copyNodeInfo } from './services/nodeInfoCopyService.js';

apiRouter.get('/nodes/:nodeNum/copy-candidates', requirePermission('nodes', 'read'), async (req, res) => {
  try {
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId query parameter is required' });
    }
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'nodeNum must be a number' });
    }
    const candidates = await findCopyCandidates(nodeNum, sourceId);
    res.json({ success: true, data: candidates });
  } catch (error) {
    logger.error('Error getting copy candidates:', error);
    res.status(500).json({ error: 'Failed to retrieve copy candidates' });
  }
});

apiRouter.post('/nodes/:nodeNum/copy-nodeinfo', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    const nodeNum = Number(req.params.nodeNum);
    if (isNaN(nodeNum)) {
      return res.status(400).json({ error: 'nodeNum must be a number' });
    }
    const { fromSourceId, toSourceId, pushToNodeDb } = req.body ?? {};
    if (!fromSourceId || !toSourceId) {
      return res.status(400).json({ error: 'fromSourceId and toSourceId are required' });
    }
    const result = await copyNodeInfo(nodeNum, fromSourceId, toSourceId, !!pushToNodeDb);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('Error copying node info:', error);
    const status = error.message?.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message || 'Failed to copy node info' });
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
      const favManager = resolveSourceManager(favSourceId);
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
    const afManager = resolveSourceManager(afSourceId);
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
      const ignoreManager = resolveSourceManager(ignoreSourceId);
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
    const scanManager = (resolveSourceManager(scanSourceId));

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
    const warnManager = resolveSourceManager(warnSourceId);

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
    const hasChannelsRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'channel_0', 'read') : false);
    const hasMessagesRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);

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
    timestamp: new Date(canonicalMessageTime(msg)),
    // Server-side ingest time — robust against sender-clock drift, used by
    // the client for sort order (issue #3187). Falls back to `timestamp` for
    // pre-migration rows where `createdAt` was never written.
    receivedAt: new Date(messageReceivedAt(msg)),
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
    sourceIp: (msg as any).sourceIp ?? (msg as any).source_ip ?? null,
    sourcePath: (msg as any).sourcePath ?? (msg as any).source_path ?? null,
    spoofSuspected: Boolean((msg as any).spoofSuspected),
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
    if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read') : false)) {
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
    const markReadManager = resolveSourceManager(markReadSourceId);

    // If marking by channelId, check per-channel read permission
    if (channelId !== undefined && channelId !== null && channelId !== -1) {
      const channelResource = `channel_${channelId}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'read') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'read' },
        });
      }
    }

    // If marking by nodeId (DMs) or allDMs, check messages permission
    if ((nodeId && channelId === -1) || allDMs) {
      const hasMessagesRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);
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
    const hasChannelsRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'channel_0', 'read') : false);
    const hasMessagesRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'messages', 'read') : false);

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
    const unreadManager = resolveSourceManager(unreadSourceId);
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

    // MM-SEC-2 follow-up: include the raw `psk` only for callers with write
    // permission to the specific channel (or admins). Without this, the
    // channel-config edit dialog and Info popup can't display the existing
    // key for the operator who is allowed to change it. See issue #2951.
    const projected = await Promise.all(accessible.map(async (channel) => {
      const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
      const includePsk = isAdmin || (req.user
        ? await hasPermission(req.user, channelResource, 'write', allChannelsSourceId)
        : false);
      return transformChannel(channel, { includePsk });
    }));

    logger.debug(`📡 Serving ${accessible.length} channels (per-row filtered, of ${allChannels.length} total)`);
    res.json(projected);
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

    // Resolve the source's persisted modem preset (if scoped to one source)
    // so empty-name slot 0 displays as "MediumFast"/"LongFast"/etc. via
    // transformChannel's `displayName` field. Matches the unified picker
    // and the firmware-derived label MQTT gateways publish under.
    let channelsPresetName: string | null = null;
    if (channelsSourceId) {
      try {
        const raw = await databaseService.settings.getSetting(`lora.preset.${channelsSourceId}`);
        const n = raw != null ? Number(raw) : NaN;
        if (Number.isFinite(n)) channelsPresetName = modemPresetChannelName(n);
      } catch (err) {
        logger.debug(`Failed to load preset for source ${channelsSourceId}:`, err);
      }
    }

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

    // MM-SEC-2 follow-up: include the raw `psk` only for callers with write
    // permission to the specific channel (or admins). Without this, the
    // channel-config edit dialog can't display the existing key for the
    // operator who is allowed to change it. See issue #2951.
    const projected = await Promise.all(filteredChannels.map(async (channel) => {
      const channelResource = `channel_${channel.id}` as import('../types/permission.js').ResourceType;
      const includePsk = isAdmin || (req.user
        ? await hasPermission(req.user, channelResource, 'write', channelsSourceId)
        : false);
      return transformChannel(channel, { includePsk, presetName: channelsPresetName });
    }));

    logger.debug(`📡 Serving ${filteredChannels.length} filtered channels (from ${allChannels.length} total)`);
    res.json(projected);
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
    if (isNaN(channelId) || channelId < 0) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // The 0-7 slot cap is a Meshtastic-only convention; MeshCore devices
    // expose a device-dependent number of channels (see phase-1 plan).
    // Resolve the source type early so we can gate the cap accordingly.
    const { sourceId: chanSourceId } = req.body;
    const sourceRowForType = (typeof chanSourceId === 'string' && chanSourceId.length > 0)
      ? await databaseService.sources.getSource(chanSourceId)
      : null;
    const sourceType = sourceRowForType?.type ?? 'meshtastic_tcp';

    if (sourceType !== 'meshcore' && channelId > 7) {
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

    const { name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision } = req.body;

    // Validate name if provided (allow empty names for unnamed channels).
    // Meshtastic caps channel names at 11 chars; MeshCore allows up to 31.
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') {
        return res.status(400).json({ error: 'Channel name must be a string' });
      }
      const maxLen = sourceType === 'meshcore' ? 31 : 11;
      if (name.length > maxLen) {
        return res.status(400).json({ error: `Channel name must be ${maxLen} characters or less` });
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

    // MeshCore channels are created on-device (setChannel + syncChannelsFromDevice),
    // so there is no pre-existing DB row when adding a new slot. Skip the
    // existence check for MeshCore; enforce 404 only for Meshtastic, which
    // always pre-creates 8 slots.
    const existingChannel = sourceType !== 'meshcore'
      ? await databaseService.channels.getChannelById(channelId)
      : null;
    if (sourceType !== 'meshcore' && !existingChannel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Snapshot channels before change for message migration
    const beforeSnapshot = await snapshotChannelsBeforeChange();

    // Prepare the updated channel data
    const updatedChannelData = {
      id: channelId,
      name: name !== undefined && name !== null ? name : (existingChannel?.name ?? ''),
      psk: psk !== undefined && psk !== null ? psk : (existingChannel?.psk ?? null),
      role: role !== undefined && role !== null ? role : (existingChannel?.role ?? null),
      uplinkEnabled: uplinkEnabled !== undefined ? uplinkEnabled : (existingChannel?.uplinkEnabled ?? null),
      downlinkEnabled: downlinkEnabled !== undefined ? downlinkEnabled : (existingChannel?.downlinkEnabled ?? null),
      positionPrecision:
        positionPrecision !== undefined && positionPrecision !== null
          ? positionPrecision
          : (existingChannel?.positionPrecision ?? null),
    };

    if (sourceType === 'meshcore') {
      // MeshCore write path: push the channel to the device first, then
      // re-sync the DB from the device (the manager's setChannel handles
      // both — including base64↔hex secret conversion).
      //
      // MeshCore managers live in their own registry (meshcoreManagerRegistry),
      // separate from the Meshtastic one. resolveSourceManager only knows
      // about the Meshtastic registry and silently falls back to the global
      // meshtasticManager singleton on a miss, which has no setChannel and
      // surfaces as a runtime TypeError.
      const mcManager = meshcoreManagerRegistry.get(chanSourceId);
      if (!mcManager || typeof mcManager.setChannel !== 'function') {
        return res.status(503).json({
          error: 'MeshCore source not connected or not registered',
          message: `No active MeshCore manager for source ${chanSourceId}. Connect the source and retry.`,
        });
      }

      // Convert the base64 PSK to hex for the meshcore.js wire format.
      // Reject anything that doesn't decode to exactly 16 bytes (AES-128).
      const incomingPskBase64 = updatedChannelData.psk;
      let secretHex: string;
      try {
        const bytes = Buffer.from(incomingPskBase64 ?? '', 'base64');
        if (bytes.length !== 16) {
          return res.status(400).json({
            error: `MeshCore channel secret must decode to exactly 16 bytes (got ${bytes.length})`,
          });
        }
        secretHex = bytes.toString('hex');
      } catch {
        return res.status(400).json({ error: 'Invalid MeshCore channel secret (expected base64 of 16 bytes)' });
      }

      try {
        await mcManager.setChannel(channelId, updatedChannelData.name, secretHex);
        logger.info(`✅ MeshCore: pushed channel ${channelId} to device + re-synced DB`);
      } catch (deviceError) {
        logger.error(`⚠️ MeshCore: failed to push channel ${channelId} to device:`, deviceError);
        return res.status(502).json({
          error: 'Failed to write channel to MeshCore device',
          message: deviceError instanceof Error ? deviceError.message : String(deviceError),
        });
      }

      const updatedChannel = await databaseService.channels.getChannelById(channelId, chanSourceId);
      return res.json({ success: true, channel: updatedChannel });
    }

    // Meshtastic write path.
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
    const chanUpdateManager = (resolveSourceManager(chanSourceId));
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
    if (isNaN(channelId) || channelId < 0) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    // sourceId is required so the channel and its messages are removed from a single source
    const rawSourceId = (req.body && req.body.sourceId) ?? (req.query && req.query.sourceId);
    if (rawSourceId === undefined || rawSourceId === null || rawSourceId === '' || typeof rawSourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const deleteChannelSourceId: string = rawSourceId;

    // Same 0-7 cap softening as the PUT route — MeshCore allows higher idx.
    const sourceRowForType = await databaseService.sources.getSource(deleteChannelSourceId);
    const sourceType = sourceRowForType?.type ?? 'meshtastic_tcp';
    if (sourceType !== 'meshcore' && channelId > 7) {
      return res.status(400).json({ error: 'Invalid channel ID (0-7)' });
    }
    if (sourceType !== 'meshcore' && channelId === 0) {
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

    if (sourceType === 'meshcore') {
      // MeshCore: push delete to the device first, then re-sync the DB.
      // MeshCore managers are in their own registry — see PUT route comment.
      const mcManager = meshcoreManagerRegistry.get(deleteChannelSourceId);
      if (!mcManager || typeof mcManager.deleteChannel !== 'function') {
        return res.status(503).json({
          error: 'MeshCore source not connected or not registered',
          message: `No active MeshCore manager for source ${deleteChannelSourceId}. Connect the source and retry.`,
        });
      }
      try {
        await mcManager.deleteChannel(channelId);
      } catch (deviceError) {
        logger.error(`⚠️ MeshCore: failed to delete channel ${channelId} on device:`, deviceError);
        return res.status(502).json({
          error: 'Failed to delete channel on MeshCore device',
          message: deviceError instanceof Error ? deviceError.message : String(deviceError),
        });
      }
      logger.info(`🗑️ MeshCore: deleted channel ${channelId} on device + re-synced DB (source=${deleteChannelSourceId})`);
      return res.json({ success: true, message: `Channel ${channelId} deleted`, sourceId: deleteChannelSourceId });
    }

    // Meshtastic path.
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
    const importManager = (resolveSourceManager(importSourceId));
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

    // Resolve the target source manager first so the channel lookup below can
    // be scoped to THIS source. MeshCore and Meshtastic channels share the
    // `channels` table and both use slot ids 0-7, so an unscoped
    // getAllChannels() returns rows from every source; the slot-keyed Map then
    // collapses same-id rows and a MeshCore channel can win the slot being
    // reordered — silently overwriting a Meshtastic channel with a MeshCore
    // one (and vice-versa). Scoping to reorderManager.sourceId keeps the
    // reorder confined to the source the user is actually editing.
    const reorderManager = (resolveSourceManager(reorderSourceId));
    const reorderSourceScope = reorderManager.sourceId;

    const allChannels = await databaseService.channels.getAllChannels(reorderSourceScope);

    // Build the new channel configs based on the reorder mapping
    // newOrder[newSlot] = oldSlot — means "new slot i gets the channel from old slot newOrder[i]"
    const channelsBySlot = new Map(allChannels.map(ch => [ch.id, ch]));

    // Begin edit settings transaction
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

        // Update database (scoped to this source; reorder is an authoritative
        // user write, so allow blank names to overwrite)
        await databaseService.channels.upsertChannel({
          id: newSlot,
          name: sourceChannel.name || '',
          psk: sourceChannel.psk,
          role,
          uplinkEnabled: sourceChannel.uplinkEnabled,
          downlinkEnabled: sourceChannel.downlinkEnabled,
          positionPrecision: sourceChannel.positionPrecision,
        }, reorderSourceScope, { allowBlankName: true });
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
        }, reorderSourceScope, { allowBlankName: true });
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
    const encodeUrlManager = resolveSourceManager(encodeUrlSourceId);

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
    const configImportManager = (resolveSourceManager(configSourceId));
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

    // Convert destination nodeId to nodeNum if provided. Accepts an 8-hex
    // nodeId (`!ad8c9eff`) or a 64-hex publicKey; rejects anything else with
    // 400 so a long-string input can't overflow PG bigint (issue #3186).
    let destinationNum: number | undefined = undefined;
    if (destination) {
      const resolved = await parseDestinationNum(destination, reqSourceId, databaseService);
      if (resolved === null) {
        return res.status(400).json({ error: `Invalid destination: ${destination}` });
      }
      destinationNum = resolved;
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
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, 'messages', 'write') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: 'messages', action: 'write' },
        });
      }
    } else {
      // Channel message - check per-channel write permission
      const channelResource = `channel_${meshChannel}` as import('../types/permission.js').ResourceType;
      if (!req.user?.isAdmin && !(req.user ? await hasPermission(req.user, channelResource, 'write') : false)) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: { resource: channelResource, action: 'write' },
        });
      }
    }

    // Route to the correct source manager when sourceId is provided
    const activeManager = (resolveSourceManager(reqSourceId));

    // Send the message to the mesh network (with optional destination for DMs, replyId, and emoji flag)
    // Note: sendTextMessage() now handles saving the message to the database
    // Pass userId so sent messages are automatically marked as read for the sender.
    // Attribution: req.ip honors X-Forwarded-For when 'trust proxy' is configured.
    await activeManager.sendTextMessage(text, meshChannel, destinationNum, replyId, emoji, req.user?.id, {
      sourceIp: req.ip ?? null,
      sourcePath: 'http_api',
    });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * Resolve the connection host/port for an `/api/poll` or `/api/config` caller
 * scoped to a particular sourceId. Returns the active source's `config.host`
 * and `config.port` when the source is `meshtastic_tcp`, the env default when
 * no sourceId was supplied (legacy single-source callers), and `null` host
 * when the source is non-TCP (BLE/serial/virtual/MQTT/meshcore) — those
 * cannot be reached via the OTA CLI's `--host` argument and the firmware UI
 * must not present them as a flash target. See issue #2981.
 */
async function resolveSourceConnectionConfig(
  sourceId: string | undefined
): Promise<{
  host: string | null;
  port: number | null;
  sourceType: string | null;
  isEnvDefault: boolean;
}> {
  if (!sourceId) {
    return {
      host: env.meshtasticNodeIp,
      port: env.meshtasticTcpPort,
      sourceType: null,
      isEnvDefault: true,
    };
  }
  try {
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) {
      return {
        host: env.meshtasticNodeIp,
        port: env.meshtasticTcpPort,
        sourceType: null,
        isEnvDefault: true,
      };
    }
    if (source.type === 'meshtastic_tcp') {
      const cfg = (source.config ?? {}) as { host?: string; port?: number };
      return {
        host: cfg.host || null,
        port: cfg.port ?? env.meshtasticTcpPort,
        sourceType: source.type,
        isEnvDefault: false,
      };
    }
    // Non-TCP sources (mqtt, meshcore, BLE/serial via future managers) can't
    // be flashed over IP — surface a null host so the UI disables OTA rather
    // than silently shipping the env default.
    return { host: null, port: null, sourceType: source.type, isEnvDefault: false };
  } catch (error) {
    logger.error(`Failed to resolve source connection config for ${sourceId}:`, error);
    return {
      host: env.meshtasticNodeIp,
      port: env.meshtasticTcpPort,
      sourceType: null,
      isEnvDefault: true,
    };
  }
}

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
    const activeManager = resolveSourceManager(pollSourceId);

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
      // is gated. The per-channel permission gate above already filters out
      // hidden channels; here we additionally include the actual key only
      // for callers with write permission to that specific channel (admins
      // automatically). See issue #2951 — the channel-config UI needs the
      // existing PSK to display in the edit dialog for authorized operators.
      result.channels = filteredChannels.map((channel) => {
        const includePsk = checkPerm(`channel_${channel.id}`, 'write');
        return transformChannel(channel, { includePsk });
      });
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
        const nodesUnmapped: string[] = [];

        const weatherTypes = new Set(['temperature', 'humidity', 'pressure']);

        // Use scoped repo call when sourceId provided (bypasses shared cache)
        const nodeTelemetryTypes = pollSourceId
          ? await databaseService.telemetry.getAllNodesTelemetryTypes(pollSourceId)
          : await databaseService.getAllNodesTelemetryTypesAsync();
        // Global estimated positions (pooled across all Meshtastic sources, #3271).
        const estimatedRows = await databaseService.getAllEstimatedPositionsAsync();
        const estimatedPositionMap = new Map(estimatedRows.map(r => [r.nodeId, r]));
        const estimatedUncertainty: Record<string, number> = {};

        dbNodes.forEach(node => {
          const telemetryTypes = nodeTelemetryTypes.get(node.nodeId);
          if (telemetryTypes && telemetryTypes.length > 0) {
            nodesWithTelemetry.push(node.nodeId);

            const hasWeather = telemetryTypes.some(t => weatherTypes.has(t));
            if (hasWeather) {
              nodesWithWeather.push(node.nodeId);
            }
          }

          // Estimated-position / unmapped status is independent of telemetry.
          // A user-set override counts as a known position (issue #2847).
          const eff = getEffectiveDbNodePosition(node);
          const hasRealPosition = eff.latitude != null && eff.longitude != null;
          const estimate = estimatedPositionMap.get(node.nodeId);
          const hasEstimatedPosition = estimate !== undefined;
          if (hasEstimatedPosition && !hasRealPosition) {
            nodesWithEstimatedPosition.push(node.nodeId);
            if (estimate.uncertaintyKm != null) {
              estimatedUncertainty[node.nodeId] = estimate.uncertaintyKm;
            }
          }
          if (!hasRealPosition && !hasEstimatedPosition) {
            nodesUnmapped.push(node.nodeId);
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
          estimatedUncertainty,
          unmapped: nodesUnmapped,
          unmappedCount: nodesUnmapped.length,
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
        hasWifi: managerNodeInfo.hasWifi,
        hasEthernet: managerNodeInfo.hasEthernet,
        hasBluetooth: managerNodeInfo.hasBluetooth,
        // True when the node is reached via a bridge/proxy (no native IP) and
        // therefore cannot do OTA firmware updates. See isLocalNodeBridged().
        isBridged: activeManager.isLocalNodeBridged(),
      } : undefined;

      const pollLocalNodeInfo = managerNodeInfo ? {
        nodeId: managerNodeInfo.nodeId,
        longName: managerNodeInfo.longName,
        shortName: managerNodeInfo.shortName,
      } : undefined;

      // Source-scoped connection config (issue #2981). When the caller passes
      // a sourceId, return that source's host/port so OTA firmware updates
      // flash the right node instead of the env default (192.168.1.100).
      const conn = await resolveSourceConnectionConfig(pollSourceId);

      result.config = {
        ...(req.session.userId ? { meshtasticNodeIp: conn.host ?? '' } : {}),
        meshtasticTcpPort: conn.port ?? env.meshtasticTcpPort,
        meshtasticUseTls: false,
        meshtasticSourceType: conn.sourceType,
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
      const hasConfigRead = req.user?.isAdmin || (req.user ? await hasPermission(req.user, 'configuration', 'read') : false);
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

    // Source-scoped connection config (issue #2981).
    const conn = await resolveSourceConnectionConfig(configSourceId);

    res.json({
      ...(req.session.userId ? { meshtasticNodeIp: conn.host ?? '' } : {}),
      meshtasticTcpPort: conn.port ?? env.meshtasticTcpPort,
      meshtasticUseTls: false, // We're using TCP, not TLS
      meshtasticSourceType: conn.sourceType,
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
    const dcManager = resolveSourceManager(dcSourceId);
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
    const backupManager = resolveSourceManager(backupSourceId);
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

// ==========================================
// Refresh nodes from device endpoint
apiRouter.post('/nodes/refresh', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    logger.debug('🔄 Manual node database refresh requested...');

    const { sourceId: refreshSourceId } = req.body || {};
    const refreshManager = (resolveSourceManager(refreshSourceId));
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
    const chanRefreshManager = (resolveSourceManager(chanRefreshSourceId));
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

    const traceIntervalManager = (resolveSourceManager(traceIntervalSourceId));
    traceIntervalManager.setTracerouteInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting traceroute interval:', error);
    res.status(500).json({ error: 'Failed to set traceroute interval' });
  }
});

// Apply the remote LocalStats automation interval to the live manager (issue #3398).
// Persistence happens via the generic /api/settings POST; this applies it without
// requiring a reconnect.
apiRouter.post('/settings/remote-localstats-interval', requirePermission('settings', 'write'), (req, res) => {
  try {
    const { intervalMinutes, sourceId: rlsIntervalSourceId } = req.body;
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 0 || intervalMinutes > 1440) {
      return res.status(400).json({ error: 'Invalid interval. Must be between 0 and 1440 minutes (0 = disabled).' });
    }
    const rlsIntervalManager = (resolveSourceManager(rlsIntervalSourceId));
    rlsIntervalManager.setRemoteLocalStatsInterval(intervalMinutes);
    res.json({ success: true, intervalMinutes });
  } catch (error) {
    logger.error('Error setting remote LocalStats interval:', error);
    res.status(500).json({ error: 'Failed to set remote LocalStats interval' });
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

// Get remote LocalStats automation node filter settings (issue #3398)
apiRouter.get('/settings/remote-localstats-nodes', requirePermission('settings', 'read'), async (req, res) => {
  try {
    const sourceId = req.query.sourceId as string | undefined;
    const settings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);
    res.json(settings);
  } catch (error) {
    logger.error('Error fetching remote LocalStats node filter:', error);
    res.status(500).json({ error: 'Failed to fetch remote LocalStats node filter' });
  }
});

// Update remote LocalStats automation node filter settings (issue #3398)
apiRouter.post('/settings/remote-localstats-nodes', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const {
      enabled, nodeNums, filterRoles, filterNameRegex,
      filterNodesEnabled, filterRolesEnabled, filterFavoriteEnabled, filterRegexEnabled,
      filterLastHeardEnabled, filterLastHeardHours,
    } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled value. Must be a boolean.' });
    }
    if (!Array.isArray(nodeNums)) {
      return res.status(400).json({ error: 'Invalid nodeNums value. Must be an array.' });
    }
    for (const nodeNum of nodeNums) {
      if (!Number.isInteger(nodeNum) || nodeNum < 0) {
        return res.status(400).json({ error: 'All node numbers must be positive integers.' });
      }
    }

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

    let validatedRoles: number[];
    try {
      validatedRoles = validateIntArray(filterRoles, 'filterRoles');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    // Validate regex (ReDoS-guarded, mirrors the traceroute route)
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      if (filterNameRegex.length > 200) {
        return res.status(400).json({ error: 'filterNameRegex too long (max 200 characters).' });
      }
      if (/(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/.test(filterNameRegex)) {
        return res.status(400).json({ error: 'filterNameRegex too complex or may cause performance issues.' });
      }
      try {
        new RegExp(filterNameRegex);
        validatedRegex = filterNameRegex;
      } catch {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a valid regular expression.' });
      }
    }

    const validateOptionalBoolean = (value: unknown, name: string): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') {
        throw new Error(`Invalid ${name} value. Must be a boolean.`);
      }
      return value;
    };

    let validatedFilterNodesEnabled: boolean | undefined;
    let validatedFilterRolesEnabled: boolean | undefined;
    let validatedFilterFavoriteEnabled: boolean | undefined;
    let validatedFilterRegexEnabled: boolean | undefined;
    let validatedFilterLastHeardEnabled: boolean | undefined;
    try {
      validatedFilterNodesEnabled = validateOptionalBoolean(filterNodesEnabled, 'filterNodesEnabled');
      validatedFilterRolesEnabled = validateOptionalBoolean(filterRolesEnabled, 'filterRolesEnabled');
      validatedFilterFavoriteEnabled = validateOptionalBoolean(filterFavoriteEnabled, 'filterFavoriteEnabled');
      validatedFilterRegexEnabled = validateOptionalBoolean(filterRegexEnabled, 'filterRegexEnabled');
      validatedFilterLastHeardEnabled = validateOptionalBoolean(filterLastHeardEnabled, 'filterLastHeardEnabled');
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }

    let validatedFilterLastHeardHours: number | undefined;
    if (filterLastHeardHours !== undefined) {
      if (!Number.isInteger(filterLastHeardHours) || filterLastHeardHours < 1) {
        return res.status(400).json({ error: 'Invalid filterLastHeardHours value. Must be an integer >= 1.' });
      }
      validatedFilterLastHeardHours = filterLastHeardHours;
    }

    const sourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required for remote LocalStats filter settings.' });
    }

    await databaseService.setRemoteLocalStatsFilterSettingsAsync({
      enabled,
      nodeNums,
      filterRoles: validatedRoles,
      filterNameRegex: validatedRegex,
      filterNodesEnabled: validatedFilterNodesEnabled,
      filterRolesEnabled: validatedFilterRolesEnabled,
      filterFavoriteEnabled: validatedFilterFavoriteEnabled,
      filterRegexEnabled: validatedFilterRegexEnabled,
      filterLastHeardEnabled: validatedFilterLastHeardEnabled,
      filterLastHeardHours: validatedFilterLastHeardHours,
    }, sourceId);

    const updatedSettings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);
    res.json({ success: true, ...updatedSettings });
  } catch (error) {
    logger.error('Error updating remote LocalStats node filter:', error);
    res.status(500).json({ error: 'Failed to update remote LocalStats node filter' });
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
    const timeSyncManager = resolveSourceManager(timeSyncSourceId);
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
    const autoPingManager = resolveSourceManager(autoPingSourceId);
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
    const stopPingManager = resolveSourceManager(stopPingSourceId);
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

// Position estimation (global, batch — issue #3271)
apiRouter.get('/settings/position-estimation/status', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    const status = await positionEstimationScheduler.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error fetching position estimation status:', error);
    res.status(500).json({ error: 'Failed to fetch position estimation status' });
  }
});

apiRouter.post('/settings/position-estimation/run-now', requirePermission('settings', 'write'), async (req, res) => {
  try {
    const result = await positionEstimationScheduler.runNow();
    databaseService.auditLogAsync(
      req.user!.id,
      'position_estimation_run',
      'settings',
      `Ran position estimation: ${result.estimatedNodeCount} node(s) estimated`,
      req.ip || null,
      null,
      JSON.stringify(result)
    );
    res.json(result);
  } catch (error) {
    logger.error('Error running position estimation:', error);
    const message = error instanceof Error && /in progress/.test(error.message)
      ? 'Position estimation already in progress'
      : 'Failed to run position estimation';
    res.status(message.includes('in progress') ? 409 : 500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Automated Remote Favorites Management (issue #2608)
// Per-source, per-target config for keeping favorites up to date on remote
// infrastructure nodes via Remote Admin. Admin-only.
// ---------------------------------------------------------------------------

const AUTO_FAVORITE_DEFAULTS = {
  enabled: false,
  useNeighborInfo: true,
  useTraceroutes: true,
  intervalHours: 24,
  maxNewPerCycle: 1,
  maxRefavoritePerCycle: 1,
  maxNeighborAgeHours: 24,
  eligibleRoles: [2, 11, 12], // Router, Router Late, Client Base
};

apiRouter.get('/admin/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const sourceId = (req.query.sourceId as string) || undefined;
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }

    const config = await databaseService.autoFavoriteTargets.getTarget(sourceId, targetNodeNum);
    const assignments = config
      ? await databaseService.autoFavoriteTargets.getAssignments(sourceId, targetNodeNum)
      : [];

    if (!config) {
      return res.json({
        configured: false,
        sourceId,
        targetNodeNum,
        ...AUTO_FAVORITE_DEFAULTS,
        lastRunAt: null,
        lastNeighborRequestAt: null,
        assignments: [],
      });
    }

    res.json({
      configured: true,
      sourceId,
      targetNodeNum,
      enabled: config.enabled,
      useNeighborInfo: config.useNeighborInfo,
      useTraceroutes: config.useTraceroutes,
      intervalHours: config.intervalHours,
      maxNewPerCycle: config.maxNewPerCycle,
      maxRefavoritePerCycle: config.maxRefavoritePerCycle,
      maxNeighborAgeHours: config.maxNeighborAgeHours,
      eligibleRoles: (() => { try { return JSON.parse(config.eligibleRoles); } catch { return AUTO_FAVORITE_DEFAULTS.eligibleRoles; } })(),
      lastRunAt: config.lastRunAt ?? null,
      lastNeighborRequestAt: config.lastNeighborRequestAt ?? null,
      assignments: assignments.map((a) => ({
        favoriteNodeNum: a.favoriteNodeNum,
        discoverySource: a.discoverySource ?? null,
        firstAssignedAt: a.firstAssignedAt,
        lastAssignedAt: a.lastAssignedAt,
        lastAckStatus: a.lastAckStatus ?? null,
        lastAckAt: a.lastAckAt ?? null,
      })),
    });
  } catch (error) {
    logger.error('Error fetching auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to fetch auto-favorite config' });
  }
});

apiRouter.put('/admin/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const { sourceId } = req.body ?? {};
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }

    const b = req.body ?? {};
    const clampInt = (v: any, def: number, min: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= min ? n : def;
    };
    const roles = Array.isArray(b.eligibleRoles)
      ? b.eligibleRoles.map((r: any) => Number(r)).filter((r: number) => Number.isFinite(r))
      : AUTO_FAVORITE_DEFAULTS.eligibleRoles;

    await databaseService.autoFavoriteTargets.upsertTarget({
      sourceId,
      targetNodeNum,
      enabled: b.enabled === true,
      useNeighborInfo: b.useNeighborInfo !== false,
      useTraceroutes: b.useTraceroutes !== false,
      intervalHours: clampInt(b.intervalHours, AUTO_FAVORITE_DEFAULTS.intervalHours, 1),
      maxNeighborAgeHours: clampInt(b.maxNeighborAgeHours, AUTO_FAVORITE_DEFAULTS.maxNeighborAgeHours, 0),
      maxNewPerCycle: clampInt(b.maxNewPerCycle, AUTO_FAVORITE_DEFAULTS.maxNewPerCycle, 0),
      maxRefavoritePerCycle: clampInt(b.maxRefavoritePerCycle, AUTO_FAVORITE_DEFAULTS.maxRefavoritePerCycle, 0),
      eligibleRoles: JSON.stringify(roles),
    });

    databaseService.auditLogAsync(
      req.user!.id,
      'auto_favorite_config',
      'admin',
      `Updated auto-favorite config for target ${targetNodeNum} (source ${sourceId}): enabled=${b.enabled === true}`,
      req.ip || null,
      null,
      null
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Error saving auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to save auto-favorite config' });
  }
});

apiRouter.delete('/admin/auto-favorite-targets/:nodeNum', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const sourceId = (req.query.sourceId as string) || (req.body && req.body.sourceId) || undefined;
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    await databaseService.autoFavoriteTargets.deleteTarget(sourceId, targetNodeNum);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting auto-favorite target config:', error);
    res.status(500).json({ error: 'Failed to delete auto-favorite config' });
  }
});

apiRouter.post('/admin/auto-favorite-targets/:nodeNum/run', requireAdmin(), async (req, res) => {
  try {
    const targetNodeNum = Number(req.params.nodeNum);
    const { sourceId } = req.body ?? {};
    if (!Number.isFinite(targetNodeNum)) {
      return res.status(400).json({ error: 'Invalid nodeNum' });
    }
    if (!sourceId || typeof sourceId !== 'string') {
      return res.status(400).json({ error: 'sourceId is required' });
    }
    const result = await autoFavoriteManagementScheduler.runCycleNow(sourceId, targetNodeNum);
    res.json(result);
  } catch (error) {
    logger.error('Error running auto-favorite cycle:', error);
    res.status(500).json({ error: 'Failed to run auto-favorite cycle' });
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

    const { mapTileset, showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, positionHistoryPointsOnly, positionHistoryHours, mapMaxAgeHours } = req.body;

    // Validate boolean values
    const booleanFields = { showPaths, showNeighborInfo, showRoute, showMotion, showMqttNodes, showUdpNodes, showRfNodes, showMeshCoreNodes, showWaypoints, showAnimations, showAccuracyRegions, showEstimatedPositions, positionHistoryPointsOnly };
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

    // Validate mapMaxAgeHours (optional number or null)
    if (mapMaxAgeHours !== undefined && mapMaxAgeHours !== null && typeof mapMaxAgeHours !== 'number') {
      return res.status(400).json({ error: 'mapMaxAgeHours must be a number or null' });
    }

    // Save preferences
    await databaseService.saveMapPreferencesAsync(req.user!.id, {
      mapTileset,
      showPaths,
      showNeighborInfo,
      showRoute,
      showMotion,
      showMqttNodes,
      showUdpNodes,
      showRfNodes,
      showMeshCoreNodes,
      showWaypoints,
      showAnimations,
      showAccuracyRegions,
      showEstimatedPositions,
      positionHistoryPointsOnly,
      positionHistoryHours,
      mapMaxAgeHours,
    });

    res.json({ success: true, message: 'Map preferences saved successfully' });
  } catch (error) {
    logger.error('Error saving user map preferences:', error);
    res.status(500).json({ error: 'Failed to save map preferences' });
  }
});

// Configuration endpoints
// GET current configuration
apiRouter.get('/config/current', requirePermission('configuration', 'read'), (req, res) => {
  try {
    const ccSourceId = req.query.sourceId as string | undefined;
    const ccManager = resolveSourceManager(ccSourceId);
    const config = ccManager.getCurrentConfig();
    // Surface bridged-node status alongside the config so the configuration UI
    // can advise that a bridged node (no native IP) needs MQTT Client Proxy.
    res.json({ ...config, isBridged: ccManager.isLocalNodeBridged() });
  } catch (error) {
    logger.error('Error getting current config:', error);
    res.status(500).json({ error: 'Failed to get current configuration' });
  }
});

apiRouter.post('/config/device', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { sourceId: cfgDevSourceId, ...config } = req.body;
    const cfgDevManager = resolveSourceManager(cfgDevSourceId);
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
    const cfgNetManager = resolveSourceManager(cfgNetSourceId);
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
    const cfgLoraManager = resolveSourceManager(cfgLoraSourceId);

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
    const cfgPosManager = resolveSourceManager(cfgPosSourceId);
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
    const cfgMqttManager = resolveSourceManager(cfgMqttSourceId);
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
    const cfgNiManager = resolveSourceManager(cfgNiSourceId);
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
    const cfgPwrManager = resolveSourceManager(cfgPwrSourceId);
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
    const cfgDispManager = resolveSourceManager(cfgDispSourceId);
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
    const cfgTelManager = resolveSourceManager(cfgTelSourceId);
    await cfgTelManager.setTelemetryConfig(config);
    res.json({ success: true, message: 'Telemetry configuration sent' });
  } catch (error) {
    logger.error('Error setting telemetry config:', error);
    res.status(500).json({ error: 'Failed to set telemetry configuration' });
  }
});

// Generic module config endpoint - handles extnotif, storeforward, rangetest, cannedmsg, audio,
// remotehardware, detectionsensor, paxcounter, serial, ambientlighting, statusmessage, trafficmanagement
apiRouter.post('/config/module/:moduleType', requirePermission('configuration', 'write'), async (req, res) => {
  try {
    const { moduleType } = req.params;
    const { sourceId: cfgModSourceId, ...config } = req.body;
    const cfgModManager = resolveSourceManager(cfgModSourceId);

    // Validate moduleType against the shared allow-list (kept in sync with
    // protobufService.createSetModuleConfigMessageGeneric's configFieldMap). See #3464.
    if (!isValidModuleConfigType(moduleType)) {
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
    const ownerManager = resolveSourceManager(ownerSourceId);
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
    const cfgReqManager = resolveSourceManager(cfgReqSourceId);
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
    const cfgModReqManager = resolveSourceManager(cfgModReqSourceId);
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
    const rebootManager = resolveSourceManager(rebootSourceId);
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

    const adminLoadManager = resolveSourceManager(adminLoadSourceId);
    const destinationNodeNum = nodeNum !== undefined ? Number(nodeNum) : (adminLoadManager.getLocalNodeInfo()?.nodeNum || 0);
    const localNodeNum = adminLoadManager.getLocalNodeInfo()?.nodeNum || 0;
    const isLocalNode = destinationNodeNum === 0 || destinationNodeNum === localNodeNum;

    let config: any = null;

    try {
      if (isLocalNode) {
        // Local node - use existing config or request it
        let currentConfig = adminLoadManager.getCurrentConfig();
        
        // Canonical config/module type registry (see configTypes.ts). Previously
        // this local-node branch used an incomplete inline copy that omitted
        // power/display/serial/etc., so a local GET of those configs 400'd with
        // "Unknown config type"; using the full registry resolves that.
        const configInfo = CONFIG_TYPE_MAP[configType];
        if (!configInfo && configType !== 'channel') {
          return res.status(400).json({ error: `Unknown config type: ${configType}` });
        }

        // Check if we need to request the specific config type
        let needsRequest = false;
        if (configInfo) {
          if (configInfo.isModule) {
            const moduleKey = MODULE_FIELD_BY_ID[configType];
            if (moduleKey && !currentConfig?.moduleConfig?.[moduleKey]) needsRequest = true;
          } else {
            const deviceKey = DEVICE_FIELD_BY_ID[configType];
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
            const moduleKey = MODULE_FIELD_BY_ID[configType];
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
        
        // Canonical config/module type registry (see configTypes.ts).
        const configInfo = CONFIG_TYPE_MAP[configType];
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

    const espManager = resolveSourceManager(espSourceId);
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

    const spsManager = resolveSourceManager(spsSourceId);
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

    const gcManager = resolveSourceManager(gcSourceId);
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

    const loManager = resolveSourceManager(loSourceId);
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

    const gdmManager = resolveSourceManager(gdmSourceId);
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
            // Capability flags captured from the local node's DeviceMetadata
            // (undefined until metadata arrives — coerce to false for the wire).
            hasWifi: localNodeInfo.hasWifi ?? false,
            hasBluetooth: localNodeInfo.hasBluetooth ?? false,
            hasEthernet: localNodeInfo.hasEthernet ?? false,
            isBridged: gdmManager.isLocalNodeBridged(),
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

    const arManager = resolveSourceManager(arSourceId);
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

    const astManager = resolveSourceManager(astSourceId);
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

    const aecManager = resolveSourceManager(aecSourceId);
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

    const aicManager = resolveSourceManager(aicSourceId);
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

    const acManager = resolveSourceManager(acSourceId);
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

    // Send the admin command. For favorite changes to a REMOTE node we wait for
    // the destination's routing ACK (admin packets set want_response) so the UI
    // can confirm the remote node actually processed it. Everything else (and
    // local-node favorites) fires as before.
    const isFavoriteCommand = command === 'setFavoriteNode' || command === 'removeFavoriteNode';
    let favoriteAck: { acked: boolean; errorReason: number | null; timedOut: boolean } | null = null;
    if (isFavoriteCommand && !isLocalNode) {
      favoriteAck = await acManager.sendAdminCommandAwaitAck(adminMessage, destinationNodeNum);
    } else {
      await acManager.sendAdminCommand(adminMessage, destinationNodeNum);
    }

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
      message: `Admin command '${command}' sent to node ${destinationNodeNum}`,
      ...(favoriteAck ? {
        ack: {
          acked: favoriteAck.acked,
          timedOut: favoriteAck.timedOut,
          errorReason: favoriteAck.errorReason,
          status: favoriteAck.timedOut
            ? 'timeout'
            : (favoriteAck.acked ? 'confirmed' : getRoutingErrorName(favoriteAck.errorReason ?? -1)),
        }
      } : {})
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
    const purgeManager = resolveSourceManager(purgeSourceId);

    // Purge the device's node database
    await purgeManager.purgeNodeDb(seconds);

    // Also purge the local database (scoped to the source we just told the
    // device to wipe — purging globally on a per-source admin command would
    // wipe siblings)
    logger.info('🗑️ Purging local node database');
    await databaseService.purgeAllNodesAsync(purgeSourceId);
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
      // Protocol discriminator. Defaults to 'meshtastic' for backwards
      // compatibility. When 'meshcore', adds MESHCORE_* env vars so a
      // MeshCore-targeting script can branch on which stack invoked it.
      protocol = 'meshtastic',
      meshcoreSourceId,
      meshcoreDeviceType,
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

        // Length cap on the assembled regex so a pathological combination of
        // param patterns (each up to /[^\s]+/) plus a long pattern string can't
        // produce a multi-kilobyte regex that the engine spends real CPU
        // compiling. Triggers are admin-configured and 100 chars max each, so
        // 2000 chars is generous headroom. Closes CodeQL js/regex-injection #32.
        if (regexPattern.length > 2000) {
          continue;
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

    // Protocol discriminator. Leaves the MESHTASTIC_* vars in place
    // (harmless for MeshCore scripts) but adds MESHCORE_* so scripts
    // can branch on which stack invoked them.
    if (protocol === 'meshcore') {
      scriptEnv.MESHCORE_SOURCE_ID = String(meshcoreSourceId || 'test-source');
      scriptEnv.MESHCORE_DEVICE_TYPE = String(meshcoreDeviceType || 'companion');
    }

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
        env: { ...scriptEnv, ...scriptDependencyEnv(ext, scriptEnv) },
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
    // archiver v8 exposes only named class exports; @types/archiver still ships v7 types.
    const { ZipArchive } = (await import('archiver')) as unknown as {
      ZipArchive: new (opts: import('archiver').ArchiverOptions) => import('archiver').Archiver;
    };
    const archive = new ZipArchive({ zlib: { level: 9 } });

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

// Script dependency management (Option A): declare deps via manifests in the
// scripts directory (requirements.txt / package.json) and install them next to
// the scripts. Status is settings:read; installing runs third-party code so it
// requires settings:write.
apiRouter.get('/scripts/dependencies', requirePermission('settings', 'read'), async (_req, res) => {
  try {
    res.json(await getDependencyStatus());
  } catch (error) {
    logger.error('[API] Error getting script dependency status:', error);
    res.status(500).json({ error: 'Failed to get script dependency status' });
  }
});

apiRouter.post('/scripts/dependencies/install', requirePermission('settings', 'write'), async (_req, res) => {
  try {
    const result = await installDependencies();
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    logger.error('[API] Error installing script dependencies:', error);
    res.status(500).json({ success: false, log: '', error: 'Failed to install script dependencies' });
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
