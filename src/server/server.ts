import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import databaseService from '../services/database.js';
import { ALL_SOURCES } from '../db/repositories/index.js';
import meshtasticManager, { fallbackManager } from './meshtasticManager.js';
import { MeshtasticManager } from './meshtasticManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { resolveSourceManager } from './utils/resolveSourceManager.js';
import { validateFilterNameRegexOnSave } from './utils/filterNameRegex.js';
import { pivotPositionHistory } from './utils/positionHistoryPivot.js';
import protobufService from './protobufService.js';

// Make meshtasticManager available globally for routes that need it
(global as any).meshtasticManager = meshtasticManager;
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import { setDiscardInvalidPositions, parseDiscardInvalidPositions } from '../utils/positionIngestConfig.js';
import { setNoIndexEnabled, parseNoIndexEnabled } from '../utils/robotsConfig.js';
import { robotsTagMiddleware, robotsTxtHandler } from './middleware/robotsTag.js';
import { getSessionMiddleware } from './auth/sessionConfig.js';
import { initializeWebSocket } from './services/webSocketService.js';
import { initializeOIDC } from './auth/oidcAuth.js';
import { optionalAuth, requirePermission, requireAdmin, hasPermission } from './auth/authMiddleware.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { setupAccessLogger } from './middleware/accessLogger.js';
import { getEnvironmentConfig, resetEnvironmentConfig } from './config/environment.js';
import { pushNotificationService } from './services/pushNotificationService.js';
import { appriseNotificationService } from './services/appriseNotificationService.js';
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
import { versionCheckService } from './services/versionCheckService.js';
import { enhanceNodeForClient, filterNodesByChannelPermission, checkNodeChannelAccess, getEffectiveDbNodePosition } from './utils/nodeEnhancer.js';
import { dynamicCspMiddleware, refreshTileHostnameCache } from './middleware/dynamicCsp.js';
import { generateAnalyticsScript, AnalyticsProvider } from './utils/analyticsScriptGenerator.js';
import { rewriteHtml } from './utils/htmlRewriter.js';
import { resolveRequestSourceId } from './utils/sourceResolver.js';
import { getRoutingErrorName } from './constants/meshtastic.js';
import { CONFIG_TYPE_MAP, MODULE_FIELD_BY_ID, DEVICE_FIELD_BY_ID } from './constants/configTypes.js';
import settingsRoutes, { setSettingsCallbacks } from './routes/settingsRoutes.js';
import { bootstrapSources } from './bootstrapSources.js';
import { installProcessSafetyNet } from './processSafetyNet.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file in development mode
// dotenv/config automatically loads .env from project root
// This must run before getEnvironmentConfig() is called
if (process.env.NODE_ENV !== 'production') {
   
  require('dotenv/config');
  // Reset cached environment config to ensure .env values are loaded
  resetEnvironmentConfig();
  logger.debug('📄 Loaded .env file from project root (if present)');
}

// Load environment configuration (after .env is loaded)
const env = getEnvironmentConfig();

const app = express();
const PORT = env.port;
const BASE_URL = env.baseUrl;

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
} else {
  // Secure default: do NOT trust proxy headers unless TRUST_PROXY is explicitly set.
  // Trusting them by default lets a direct-connected client spoof X-Forwarded-For to
  // rotate req.ip past the auth brute-force limiter and poison audit attribution.
  app.set('trust proxy', false);
  if (env.isProduction) {
    logger.warn('⚠️  TRUST_PROXY not set — using the direct socket IP for rate limiting and audit logs.');
    logger.warn('   If MeshMonitor is behind a reverse proxy (nginx, Traefik, Caddy, Cloudflare), set TRUST_PROXY=1 (or the hop count / subnet) so client IPs resolve correctly.');
    logger.warn('   See: https://expressjs.com/en/guide/behind-proxies.html');
  }
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

// Optional "discourage indexing" header (issue #4202). When the global
// `noIndexEnabled` setting is on, tag every response with
// `X-Robots-Tag: noindex, nofollow`. No-op otherwise.
app.use(robotsTagMiddleware);

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
void (async () => {
  try {
    const restoreFromBackup = systemRestoreService.shouldRestore();

    if (restoreFromBackup) {
      logger.debug('🔄 RESTORE_FROM_BACKUP environment variable detected');
      logger.debug(`📦 Attempting to restore from: ${restoreFromBackup}`);

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
        void databaseService.auditLogAsync(
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

    // Bootstrap all enabled sources (or auto-create a Default source from env
    // when none exist). Extracted into bootstrapSources() for testability — see
    // WP1 of issue #3962 Phase 2 and src/server/bootstrapSources.ts.
    // NOTE: Per-source scheduler settings are applied inside bootstrapSources
    // via applyManagerSettings(). Globally-scoped schedulers self-bootstrap
    // inside their own start*Scheduler methods.
    await bootstrapSources({
      db: databaseService,
      env: { meshtasticNodeIp: env.meshtasticNodeIp, meshtasticTcpPort: env.meshtasticTcpPort },
      registry: sourceManagerRegistry,
      makeMeshtastic: (id, cfg) => new MeshtasticManager(id, cfg),
      // WP3: pass the concrete fallback instance (not the Proxy alias).
      // fallbackManager.connect() is called only when no tcp source auto-connects
      // (S4: all-MeshCore / all-disabled-tcp / autoConnect:false installs).
      // The Proxy alias (meshtasticManager default export) is kept for
      // (global as any) and backupSchedulerService so those consumers track
      // the live primary without per-file edits (WP4 will migrate them).
      fallbackManager: fallbackManager,
    });

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

    // Start the Automation Engine (#3653) — loads enabled automations and
    // subscribes to the event bus so they fire on live mesh traffic.
    await startAutomationEngine();

    // Seed the global "discard invalid GPS positions" ingest gate from settings
    // (default ON = discard, the historical behavior). Refreshed live on save via
    // the setDiscardInvalidPositions callback registered below.
    setDiscardInvalidPositions(
      parseDiscardInvalidPositions(await databaseService.settings.getSetting('discardInvalidPositions')),
    );

    // Seed the global "discourage indexing" gate from settings (default OFF).
    // Refreshed live on save via the setNoIndexEnabled callback registered below.
    setNoIndexEnabled(
      parseNoIndexEnabled(await databaseService.settings.getSetting('noIndexEnabled')),
    );

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
  registry: sourceManagerRegistry,
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
  registry: sourceManagerRegistry,
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
  registry: sourceManagerRegistry,
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
// Version Check (detection / notification only)
// ==========================================
// A single server-side poller checks GitHub for new releases every 6 hours
// (first check ~60s after boot), caches the result for the /version/check
// endpoint, and fires the `upgrade-available` automation event headlessly.
// In-app upgrade *execution* was retired in v4.13 — this never triggers an
// upgrade. Skipped entirely when VERSION_CHECK_DISABLED is set.
setTimeout(async () => {
  try {
    await databaseService.waitForReady();
    versionCheckService.start();
  } catch (error) {
    logger.error('Error starting version-check service:', error);
  }
}, 10 * 1000);

// Create router for API routes
const apiRouter = express.Router();

// Import route handlers
import authRoutes from './routes/authRoutes.js';
import automationRoutes from './routes/automationRoutes.js';
import { startAutomationEngine } from './services/automation/automationEngineSingleton.js';
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
import mqttPacketRoutes from './routes/mqttPacketRoutes.js';
// meshcoreConfigFromSource / ensureMeshCoreManagerStarted moved to bootstrapSources.ts
import { isMeshCoreManager, isMeshtasticManager } from './sourceManagerTypes.js';
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
import sourceRoutes from './routes/sourceRoutes.js';
import unifiedRoutes from './routes/unifiedRoutes.js';
import analysisRoutes from './routes/analysisRoutes.js';
import elevationRoutes from './routes/elevationRoutes.js';
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
import dataExchangeRoutes from './routes/dataExchangeRoutes.js';
import serverInfoRoutes from './routes/serverInfoRoutes.js';
import scriptRoutes, { scriptsEndpoint, getScriptsDirectory } from './routes/scriptRoutes.js';
import deviceRoutes from './routes/deviceRoutes.js';
import systemRoutes, { setSystemCallbacks } from './routes/systemRoutes.js';
import channelRoutes from './routes/channelRoutes.js';
import { requireSourceId } from './utils/requireSourceId.js';
import pollRoutes from './routes/pollRoutes.js';
import configRoutes from './routes/configRoutes.js';
import userPreferencesRoutes from './routes/userPreferencesRoutes.js';

// CSRF token endpoint (must be before CSRF protection middleware)
apiRouter.get('/csrf-token', csrfTokenEndpoint);

// Health check endpoints (for upgrade watchdog and monitoring)
apiRouter.use('/health', healthRoutes);

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

// MQTT Packet Monitor routes — nested under `/api/sources/:id/mqtt/packets`
// so each request resolves the retention log bound to a specific source.
// No source-type check (mirrors meshcore): retained rows stay readable while
// a source is disconnected or reconfigured. See
// docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §2.11/§2.12.
apiRouter.use('/sources/:id/mqtt/packets', mqttPacketRoutes);

// Link preview routes
apiRouter.use('/', linkPreviewRoutes);

// Script content proxy routes (for User Scripts Gallery)
apiRouter.use('/', scriptContentRoutes);

// Tile server testing routes (for Custom Tileset Manager autodetect)
apiRouter.use('/tile-server', optionalAuth(), tileServerRoutes);

// Settings routes (GET/POST/DELETE /settings)
apiRouter.use('/settings', settingsRoutes);

// Configuration routes (GET /config, GET /config/current, POST /config/*)
apiRouter.use('/config', configRoutes);

// User preferences routes (GET/POST /user/map-preferences)
apiRouter.use('/user', userPreferencesRoutes);

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

// Terrain link elevation profile (#4111 Phase 1)
apiRouter.use('/elevation', elevationRoutes);

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
apiRouter.use('/automations', automationRoutes);
// Mounted at '/' because these routers contain mixed top-level paths
// (e.g. /traceroute, /telemetry/:nodeId, /device/tx-status, /virtual-node/status).
apiRouter.use('/', meshRequestRoutes);
apiRouter.use('/', telemetryRoutes);
apiRouter.use('/', deviceStatusRoutes);
apiRouter.use('/', statusRoutes);
apiRouter.use('/', serverInfoRoutes);
apiRouter.use('/', dataExchangeRoutes);
// Mounted at '/' because these routers contain mixed top-level paths
// (/device-config, /device/*, /system/*, /status, /version/check).
apiRouter.use('/', deviceRoutes);
apiRouter.use('/', systemRoutes);
apiRouter.use('/channels', channelRoutes);
// Mounted at '/' because the script routes use mixed top-level paths
// (/scripts/*, /http/test). The public /api/scripts listing endpoint is
// mounted separately on the app below (bypasses CSRF).
apiRouter.use('/', scriptRoutes);

// Consolidated polling endpoint (GET /poll). Mounted at '/' — appended after
// the existing '/'-mounted routers per #3502 PR1 mount-placement rules.
apiRouter.use('/', pollRoutes);

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
      const base = sourceManagerRegistry.getManager(sourceId);
      if (base && isMeshtasticManager(base)) base.restartAnnounceScheduler();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)) {
        mgr.restartAnnounceScheduler();
      }
    }
  },
  restartTimerScheduler: (sourceId?: string | null) => {
    if (sourceId) {
      const base = sourceManagerRegistry.getManager(sourceId);
      if (base && isMeshtasticManager(base)) base.restartTimerScheduler();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)) {
        mgr.restartTimerScheduler();
      }
    }
  },
  restartGeofenceEngine: (sourceId?: string | null) => {
    if (sourceId) {
      const base = sourceManagerRegistry.getManager(sourceId);
      if (base && isMeshtasticManager(base)) base.restartGeofenceEngine();
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)) {
        mgr.restartGeofenceEngine();
      }
    }
  },
  setAutomationAirtimeCutoffThreshold: (threshold: number, sourceId?: string | null) => {
    if (sourceId) {
      const base = sourceManagerRegistry.getManager(sourceId);
      if (base && isMeshtasticManager(base)) base.setAutomationAirtimeCutoffThreshold(threshold);
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)) {
        mgr.setAutomationAirtimeCutoffThreshold(threshold);
      }
    }
  },
  setAutomationAirtimeCutoffSource: (source: string, sourceId?: string | null) => {
    if (sourceId) {
      const base = sourceManagerRegistry.getManager(sourceId);
      if (base && isMeshtasticManager(base)) base.setAutomationAirtimeCutoffSource(source);
    } else {
      for (const mgr of sourceManagerRegistry.getAllManagers().filter(isMeshtasticManager)) {
        mgr.setAutomationAirtimeCutoffSource(source);
      }
    }
  },
  handleAutoWelcomeEnabled: () => { databaseService.handleAutoWelcomeEnabledAsync().catch(() => {}); return 0; },
  invalidateHtmlCache,
  setDiscardInvalidPositions: (enabled) => setDiscardInvalidPositions(enabled),
  setNoIndexEnabled: (enabled) => setNoIndexEnabled(enabled),
  // Auto-delete-by-distance is per-source (#3901): route the restart/stop to
  // the owning source manager so each source schedules against its own settings.
  // There is no global singleton — a null sourceId is a no-op.
  restartAutoDeleteByDistanceService: (sourceId?: string | null) => {
    if (!sourceId) return;
    const mgr = sourceManagerRegistry.getManager(sourceId);
    mgr?.startDistanceDeleteScheduler().catch((err: unknown) =>
      logger.error(`Failed to restart auto-delete-by-distance scheduler for source ${sourceId}:`, err));
  },
  stopAutoDeleteByDistanceService: (sourceId?: string | null) => {
    if (!sourceId) return;
    const mgr = sourceManagerRegistry.getManager(sourceId);
    mgr?.stopDistanceDeleteScheduler();
  },
});

// Wire up side-effect callbacks for systemRoutes (server-lifecycle shutdown).
// gracefulShutdown is a hoisted function declaration defined later in this file.
setSystemCallbacks({
  gracefulShutdown,
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

    // Filter nodes based on channel read permissions — scope the permission
    // lookup to the requested source so a guest with channel access on one
    // source can't see another source's nodes (#3745).
    const filteredNodes = await filterNodesByChannelPermission(allNodes, (req as any).user, nodesSourceId);
    const enhancedNodes = await Promise.all(filteredNodes.map(node => enhanceNodeForClient(node, (req as any).user, estimatedPositions)));

    // Append MeshCore contacts/localNodes so the aggregate dashboard map can
    // render them alongside Meshtastic nodes. MeshCore stores lastSeen in ms;
    // dashboard age-cutoff expects seconds, so we down-convert here.
    const allMeshcoreManagers = sourceManagerRegistry.getAllManagers().filter(isMeshCoreManager);
    const meshcoreManagers = nodesSourceId
      ? allMeshcoreManagers.filter(m => m.sourceId === nodesSourceId)
      : allMeshcoreManagers;
    // By default MeshCore nodes are only appended when they have a position
    // (the aggregate dashboard map use-case). Consumers that need the full node
    // list regardless of position — e.g. the notification monitored-node picker,
    // so battery-powered companions without a GPS fix can still be selected —
    // pass includeAllMeshcore=true to drop the position gate.
    const includeAllMeshcore = req.query.includeAllMeshcore === 'true';
    const meshcoreNodes: any[] = [];
    for (const mgr of meshcoreManagers) {
      for (const n of await mgr.getAllNodes()) {
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
    const allDbNodes = await databaseService.nodes.getActiveNodes(days, activeNodesSourceId ?? ALL_SOURCES); // intentional cross-source when sourceId omitted

    // Filter nodes based on channel read permissions (source-scoped, #3745)
    const dbNodes = await filterNodesByChannelPermission(allDbNodes, (req as any).user, activeNodesSourceId);

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
import {
  findCopyCandidates, copyNodeInfo, isNodeInfoField, NODE_INFO_FIELDS,
  type NodeInfoField,
} from './services/nodeInfoCopyService.js';

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
    const { fromSourceId, toSourceId, pushToNodeDb, fields } = req.body ?? {};
    if (!fromSourceId || !toSourceId) {
      return res.status(400).json({ error: 'fromSourceId and toSourceId are required' });
    }
    // #4244: optional per-field selection. Reject unknown names rather than
    // silently ignoring them, so a client typo surfaces instead of quietly
    // copying nothing.
    let selectedFields: NodeInfoField[] | undefined;
    if (fields !== undefined) {
      if (!Array.isArray(fields) || !fields.every(isNodeInfoField)) {
        return res.status(400).json({
          error: `fields must be an array of: ${NODE_INFO_FIELDS.join(', ')}`,
        });
      }
      selectedFields = fields;
    }
    const result = await copyNodeInfo(
      nodeNum, fromSourceId, toSourceId, !!pushToNodeDb, selectedFields,
    );
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

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
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

    // Backward-pagination cursor (#3791). When supplied, only fixes strictly
    // older than this timestamp are returned, letting the client walk the whole
    // history one bounded 1500-row page at a time. Must be a positive integer.
    const rawBefore = req.query.before ? parseInt(req.query.before as string) : null;
    const beforeTimestamp = rawBefore !== null && !isNaN(rawBefore) && rawBefore > 0
      ? rawBefore
      : undefined;

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
    const positionTelemetry = await databaseService.getPositionTelemetryByNodeAsync(nodeId, 1500, cutoffTime, beforeTimestamp);

    // Pivot the per-metric telemetry rows into per-fix position objects.
    // Per-fix receive metadata (SNR + hop info, issue #3492) stamped on the
    // lat/lon rows is surfaced so the map history tooltip can show
    // "Heard directly (0 hops)" + SNR for direct hears (issue #3590).
    const positions = pivotPositionHistory(positionTelemetry);

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

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
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

    logger.debug(`${locked ? '🔒' : '🔓'} Node ${nodeNum} favorite lock set to: ${locked}`);

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
apiRouter.get('/nodes/:nodeId/position-override', optionalAuth(), requireSourceId('query'), async (req, res) => {
  try {
    const { nodeId } = req.params;

    // Check channel-based access for this node (source-scoped, #3745)
    if (!await checkNodeChannelAccess(nodeId, req.user, req.query.sourceId as string | undefined)) {
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
    // sourceId presence validated by requireSourceId('query')
    const poGetSourceId = req.query.sourceId as string;
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

// Set the per-node "Hide from Map" toggle (issue #3549). Display-only: suppresses
// the node's marker on every map view while leaving it visible everywhere else.
apiRouter.post('/nodes/:nodeId/hide-from-map', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { hideFromMap, sourceId: hfmSourceId, allSources } = req.body;

    if (typeof hideFromMap !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'hideFromMap must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for hideFromMap parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    // `allSources` is optional, but if present it must be a real boolean —
    // otherwise a stray `"true"` string would silently fall through to the
    // per-source path (the branch below tests `=== true`). Reject the
    // ambiguity rather than guess.
    if (allSources !== undefined && typeof allSources !== 'boolean') {
      const errorResponse: ApiErrorResponse = {
        error: 'allSources must be a boolean',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected boolean value for optional allSources parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof hfmSourceId !== 'string' || hfmSourceId.length === 0) {
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

    // #4137: unified/cross-source views toggle the logical node, not one
    // source's row. hideFromMap is map-visibility metadata (not a
    // security-sensitive field), so requiring write permission on the
    // request's anchor sourceId is a sufficient permission check even
    // though the write fans out to every source's row for this nodeNum —
    // sourceId above remains required and stays the RBAC anchor either way.
    if (allSources === true) {
      await databaseService.setNodeHideFromMapAllSourcesAsync(nodeNum, hideFromMap);
    } else {
      await databaseService.setNodeHideFromMapAsync(nodeNum, hideFromMap, hfmSourceId);
    }

    res.json({
      success: true,
      nodeNum,
      hideFromMap,
    });
  } catch (error) {
    logger.error('Error setting node hideFromMap:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node hideFromMap',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Set the free-text per-node notes annotation (issue #3921). MeshMonitor-local
// only — never synced to the mesh. An empty string clears the note.
const MAX_NODE_NOTES_LENGTH = 2000;
apiRouter.post('/nodes/:nodeId/notes', requirePermission('nodes', 'write', { sourceIdFrom: 'body' }), async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { notes, sourceId: notesSourceId } = req.body;

    if (typeof notes !== 'string') {
      const errorResponse: ApiErrorResponse = {
        error: 'notes must be a string',
        code: 'INVALID_PARAMETER_TYPE',
        details: 'Expected string value for notes parameter',
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (notes.length > MAX_NODE_NOTES_LENGTH) {
      const errorResponse: ApiErrorResponse = {
        error: 'notes is too long',
        code: 'INVALID_PARAMETER',
        details: `notes must be at most ${MAX_NODE_NOTES_LENGTH} characters`,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (typeof notesSourceId !== 'string' || notesSourceId.length === 0) {
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

    await databaseService.setNodeNotesAsync(nodeNum, notes, notesSourceId);

    res.json({
      success: true,
      nodeNum,
      notes,
    });
  } catch (error) {
    logger.error('Error setting node notes:', error);
    const errorResponse: ApiErrorResponse = {
      error: 'Failed to set node notes',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error occurred',
    };
    res.status(500).json(errorResponse);
  }
});

// Delete neighbor info for a node
apiRouter.delete('/nodes/:nodeId/neighbors', requirePermission('nodes', 'write', { sourceIdFrom: 'query', requireSourceId: true }), async (req, res) => {
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

    // Delete neighbor info from database (scoped to the required source;
    // requireSourceId already validated presence + string type)
    const deletedCount = await databaseService.deleteNeighborInfoForNodeAsync(nodeNum, req.query.sourceId as string);

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

    logger.debug(`Manual remote admin scan requested for node ${parsedNodeNum}`);

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

    logger.debug(`🔐 Sent key security warning to node ${nodeId} (${node.longName || 'Unknown'})`);

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

    // Duplicate key detection is Meshtastic-only — MeshCore nodes don't use the
    // shared `nodes` table and have no Meshtastic PKI model to scan.
    const managers = sourceManagerRegistry.getAllManagers().filter(m => m.sourceType !== 'meshcore');
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
        logger.debug(`🔐 [${sourceId}] Detected ${nodeNums.length} nodes sharing key hash ${keyHash.substring(0, 16)}...`);
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

// Device configuration endpoint
// ==========================================
// Refresh nodes from device endpoint
apiRouter.post('/nodes/refresh', requirePermission('nodes', 'write'), async (req, res) => {
  try {
    logger.debug('🔄 Manual node database refresh requested...');

    const { sourceId: refreshSourceId } = req.body || {};
    const refreshManager = (resolveSourceManager(refreshSourceId));
    // Trigger full node database refresh
    await refreshManager.refreshNodeDatabase();

    const nodeCount = await databaseService.nodes.getNodeCount(
      typeof refreshSourceId === 'string' && refreshSourceId.length > 0 ? refreshSourceId : ALL_SOURCES,
    );
    const channelCount = await databaseService.channels.getChannelCount(
      typeof refreshSourceId === 'string' && refreshSourceId.length > 0 ? refreshSourceId : ALL_SOURCES,
    );

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

    // Current stored settings — needed to decide whether the regex must be
    // hard-validated (see validateFilterNameRegexOnSave / #3934).
    const traceNodesPostSourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
    const currentTraceSettings = await databaseService.getTracerouteFilterSettingsAsync(traceNodesPostSourceId);

    // Validate regex if provided — only hard-validate (RE2) when it will actually
    // be applied or the pattern changed, so a stored RE2-incompatible pattern
    // can't permanently brick the automation (#3934, mirrors #3806).
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      const regexWillBeApplied =
        enabled &&
        (filterRegexEnabled !== undefined ? filterRegexEnabled === true : currentTraceSettings.filterRegexEnabled);
      const regexResult = validateFilterNameRegexOnSave(filterNameRegex, {
        willBeApplied: regexWillBeApplied,
        storedRegex: currentTraceSettings.filterNameRegex,
      });
      if ('error' in regexResult) {
        return res.status(400).json({ error: regexResult.error });
      }
      validatedRegex = regexResult.regex;
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

    // Update all settings (scoped to source when provided; sourceId resolved above)
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

    // sourceId is required here; resolve it up-front so we can read the current
    // stored settings for the regex guard below.
    const sourceId = (req.query.sourceId as string | undefined) || (req.body?.sourceId as string | undefined);
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId is required for remote LocalStats filter settings.' });
    }
    const currentRemoteSettings = await databaseService.getRemoteLocalStatsFilterSettingsAsync(sourceId);

    // Validate regex — only hard-validate (RE2) when it will actually be applied
    // or the pattern changed, so a stored RE2-incompatible pattern can't
    // permanently brick the automation (#3934, mirrors #3806).
    let validatedRegex = '.*';
    if (filterNameRegex !== undefined && filterNameRegex !== null) {
      if (typeof filterNameRegex !== 'string') {
        return res.status(400).json({ error: 'Invalid filterNameRegex value. Must be a string.' });
      }
      const regexWillBeApplied =
        enabled &&
        (filterRegexEnabled !== undefined ? filterRegexEnabled === true : currentRemoteSettings.filterRegexEnabled);
      const regexResult = validateFilterNameRegexOnSave(filterNameRegex, {
        willBeApplied: regexWillBeApplied,
        storedRegex: currentRemoteSettings.filterNameRegex,
      });
      if ('error' in regexResult) {
        return res.status(400).json({ error: regexResult.error });
      }
      validatedRegex = regexResult.regex;
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
    const entries = await databaseService.distanceDeleteLog.getDistanceDeleteLog(10, distLogSourceId);
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
    void databaseService.auditLogAsync(
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

    void databaseService.auditLogAsync(
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
    logger.debug(`👋 Manually marked ${count} nodes as welcomed via API${sourceId ? ` (source=${sourceId})` : ''}`);

    // Audit log
    void databaseService.auditLogAsync(
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
          logger.debug(`Config type '${configType}' not available, requesting from device...`);
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
                configOkToMqtt: finalConfig.deviceConfig.lora.configOkToMqtt,
                femLnaMode: finalConfig.deviceConfig.lora.femLnaMode
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
        logger.debug(`Requesting ${configType} config from remote node ${destinationNodeNum}`);
        
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
              configOkToMqtt: remoteConfig.configOkToMqtt,
              femLnaMode: remoteConfig.femLnaMode
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
      // For local node, get from database (scoped to source — #3712)
      const gcScopedSourceId = typeof gcSourceId === 'string' && gcSourceId.length > 0 ? gcSourceId : undefined;
      const channel = await databaseService.channels.getChannelById(channelIndex, gcScopedSourceId);
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
        // #3684: read the persisted User capability flags so the Config tab's
        // "Unmessageable"/"Licensed" checkboxes reflect the local node's actual
        // setting instead of always showing unchecked. nodeNum may be absent
        // before the local node row exists — fall back to false in that case.
        let isUnmessagable = false;
        let isLicensed = false;
        if (localNodeInfo.nodeNum) {
          const nodeData = await databaseService.nodes.getNode(localNodeInfo.nodeNum, loSourceId);
          publicKeyBase64 = nodeData?.publicKey || undefined;
          isUnmessagable = nodeData?.isUnmessagable ?? false;
          isLicensed = nodeData?.isLicensed ?? false;
        }
        return res.json({ owner: {
          longName: localNodeInfo.longName || '' ,
          shortName: localNodeInfo.shortName || '' ,
          isUnmessagable,
          isLicensed,
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
          logger.debug(`✅ Updated hasRemoteAdmin=true and saved metadata for node ${destinationNodeNum}`);
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

    logger.debug(`✅ Sent reboot command to node ${destinationNodeNum} (in ${seconds} seconds)`);
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

    logger.debug(`✅ Sent set-time command to node ${destinationNodeNum}`);
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
    const aecScopedSourceId = typeof aecSourceId === 'string' && aecSourceId.length > 0 ? aecSourceId : undefined;
    const channels = [];
    for (const channelId of channelIds) {
      if (isLocalNode) {
        // Scoped to source (#3712) so the local-node export path reads this
        // source's channel row, not the first matching source.
        const channel = await databaseService.channels.getChannelById(channelId, aecScopedSourceId);
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

    logger.debug(`📥 Importing configuration from URL to node ${destinationNodeNum}: ${configUrl}`);

    const channelUrlService = (await import('./services/channelUrlService.js')).default;

    // Decode the URL to get channels and lora config
    const decoded = channelUrlService.decodeUrl(configUrl);

    if (!decoded || (!decoded.channels && !decoded.loraConfig)) {
      return res.status(400).json({ error: 'Invalid or empty configuration URL' });
    }

    logger.debug(`📥 Decoded ${decoded.channels?.length || 0} channels, LoRa config: ${!!decoded.loraConfig}`);

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
        logger.debug(`🔑 Using cached session passkey for admin command to remote node ${destinationNodeNum}`);
      } else {
        logger.debug(`🔑 No cached passkey for remote node ${destinationNodeNum}, requesting new one for admin command...`);
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
            logger.debug(`⚙️ Updated local node ${localNodeId} position in database: lat=${latitude}, lon=${longitude}`);
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
      logger.debug(`⚙️ Updated local node ${localNodeId} position in database: lat=${params.latitude}, lon=${params.longitude}`);
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
        logger.debug(`✅ Updated hasRemoteAdmin=true for node ${destinationNodeNum} after successful '${command}' command`);
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

// Serve static files from the React app build
const buildPath = path.join(__dirname, '../../dist');

// Public endpoint to list available scripts (no CSRF or auth required).
// Implementation lives in ./routes/scriptRoutes.ts (imported as scriptsEndpoint)
// and is mounted directly on the app below to bypass the apiRouter's CSRF guard.
if (BASE_URL) {
  app.get(`${BASE_URL}/api/scripts`, apiLimiter, scriptsEndpoint);
}
app.get('/api/scripts', apiLimiter, scriptsEndpoint);


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
    const content = fs.readFileSync(manifestPath, 'utf-8');
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

  // Serve robots.txt (before SPA fallback) — dynamic body gated on noIndexEnabled (#4202)
  app.get(`${BASE_URL}/robots.txt`, robotsTxtHandler);

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

  // Serve robots.txt (before SPA fallback) — dynamic body gated on noIndexEnabled (#4202)
  app.get('/robots.txt', robotsTxtHandler);

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
let isShuttingDown = false;
function gracefulShutdown(reason: string, exitCode = 0): void {
  if (isShuttingDown) {
    logger.warn(`🛑 Shutdown already in progress — ignoring duplicate request: ${reason}`);
    return;
  }
  isShuttingDown = true;
  logger.info(`🛑 Initiating graceful shutdown: ${reason} (exit ${exitCode})`);

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
    process.exit(exitCode);
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

// Last-resort handlers: log full context and route through gracefulShutdown (exit 1).
installProcessSafetyNet({ shutdown: gracefulShutdown });

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
void migrateAutoResponderTriggers();

// Module-level server variable for graceful shutdown
let server: ReturnType<typeof app.listen>;

// Wrap server startup in async IIFE to wait for database before accepting requests
void (async () => {
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
    void (async () => {
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
    logger.debug(
      `🔧 Meshtastic Node IP: ${env.meshtasticNodeIp} ${
        env.meshtasticNodeIpProvided ? '📄 (from .env)' : '⚙️ (default)'
      }`
    );
    logger.debug(
      `🔧 Meshtastic TCP Port: ${env.meshtasticTcpPort} ${
        env.meshtasticTcpPortProvided ? '📄 (from .env)' : '⚙️ (default)'
      }`
    );

    // Log scripts directory location in development
    const scriptsDir = getScriptsDirectory();
    logger.debug(`📜 Auto-responder scripts directory: ${scriptsDir}`);

    // Check if directory has any scripts
    try {
      const files = fs.readdirSync(scriptsDir);
      const scriptFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.js', '.mjs', '.py', '.sh'].includes(ext);
      });

      if (scriptFiles.length > 0) {
        logger.debug(`   Found ${scriptFiles.length} script(s): ${scriptFiles.join(', ')}`);
      } else {
        logger.debug(`   No scripts found. Place your test scripts (.js, .mjs, .py, .sh) in this directory`);
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
