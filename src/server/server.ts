import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
// Side-effect only: patches JSON.stringify to handle BigInt. Must run before
// anything else in the app can serialize a value that might contain one.
import './utils/jsonBigIntReplacer.js';
import databaseService from '../services/database.js';
import meshtasticManager, { fallbackManager } from './meshtasticManager.js';
import { MeshtasticManager } from './meshtasticManager.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { resolveSourceManager } from './utils/resolveSourceManager.js';

// Make meshtasticManager available globally for routes that need it
(global as any).meshtasticManager = meshtasticManager;
import { createRequire } from 'module';
import { logger } from '../utils/logger.js';
import { setDiscardInvalidPositions, parseDiscardInvalidPositions } from '../utils/positionIngestConfig.js';
import { setNoIndexEnabled, parseNoIndexEnabled } from '../utils/robotsConfig.js';
import { robotsTagMiddleware } from './middleware/robotsTag.js';
import { getSessionMiddleware } from './auth/sessionConfig.js';
import { initializeWebSocket } from './services/webSocketService.js';
import { initializeOIDC } from './auth/oidcAuth.js';
import { optionalAuth } from './auth/authMiddleware.js';
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
import { versionCheckService } from './services/versionCheckService.js';
import { dynamicCspMiddleware, refreshTileHostnameCache } from './middleware/dynamicCsp.js';
import settingsRoutes, { setSettingsCallbacks } from './routes/settingsRoutes.js';
import { bootstrapSources } from './bootstrapSources.js';
import { migrateAutoResponderTriggers } from './services/autoResponderTriggerMigration.js';
import { configureStaticServing, invalidateHtmlCache } from './staticServing.js';
// Re-exported for backward compatibility — server.ts used to define
// invalidateHtmlCache locally and `export function` it. No current importer
// reaches through server.ts for it (verified via grep as part of #3502 PR3),
// but the re-export is a free safety net against a hidden/dynamic import.
export { invalidateHtmlCache };
import { installProcessSafetyNet } from './processSafetyNet.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

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
import { isMeshtasticManager } from './sourceManagerTypes.js';
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
import pollRoutes from './routes/pollRoutes.js';
import configRoutes from './routes/configRoutes.js';
import userPreferencesRoutes from './routes/userPreferencesRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import nodesRoutes from './routes/nodesRoutes.js';

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

// Admin routes (all requireAdmin(); config load/export/import, channel/owner
// load, device metadata, reboot/set-time, suppressed-ghost mgmt, commands)
apiRouter.use('/admin', adminRoutes);

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

// Node CRUD/favorite/ignore/position-override/notes/etc endpoints
// (incl. /auto-favorite/status and /auto-ping/stop/:nodeNum). Mounted at
// '/' — appended after the existing '/'-mounted routers per #3502 PR3
// mount-placement rules (none of nodesRoutes' paths overlap an existing
// '/'-mounted module's paths).
apiRouter.use('/', nodesRoutes);

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

// Note: GET/POST/DELETE/etc /nodes routes (incl. /auto-favorite/status and
// /auto-ping/stop/:nodeNum) are in routes/nodesRoutes.ts

// Note: GET/POST/DELETE /settings routes are in routes/settingsRoutes.ts

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

// Static asset + SPA-catch-all serving (implementation moved to
// staticServing.ts as part of #3502 PR3 composition-root teardown).
// Must come after the API router mount above.
configureStaticServing(app);

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

// Run the auto-responder-trigger channel-backfill migration on startup
// (implementation moved to services/autoResponderTriggerMigration.ts).
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
