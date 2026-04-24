/**
 * Centralized Environment Configuration
 *
 * Single source of truth for all environment variables and their defaults.
 * Parses environment variables once at startup, validates them, and provides
 * type-safe access with provenance tracking (whether explicitly set or defaulted).
 *
 * Benefits:
 * - Prevents inconsistent default handling across files
 * - Makes it obvious what can be configured
 * - Tracks whether values were explicitly provided or defaulted
 * - Centralizes validation and warnings
 */

import crypto from 'crypto';
import path from 'path';
import { logger } from '../../utils/logger.js';

/**
 * Parse boolean environment variable
 * - undefined → defaultValue
 * - 'true' → true
 * - 'false' → false
 * - anything else → defaultValue with warning
 */
function parseBoolean(
  name: string,
  envValue: string | undefined,
  defaultValue: boolean
): { value: boolean; wasProvided: boolean } {
  if (envValue === undefined) {
    return { value: defaultValue, wasProvided: false };
  }

  if (envValue === 'true') {
    return { value: true, wasProvided: true };
  }

  if (envValue === 'false') {
    return { value: false, wasProvided: true };
  }

  logger.warn(`⚠️  Invalid ${name} value: "${envValue}". Expected 'true' or 'false'. Using default: ${defaultValue}`);
  return { value: defaultValue, wasProvided: false };
}

/**
 * Parse integer environment variable
 */
function parseInt32(
  name: string,
  envValue: string | undefined,
  defaultValue: number
): { value: number; wasProvided: boolean } {
  if (envValue === undefined) {
    return { value: defaultValue, wasProvided: false };
  }

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed)) {
    logger.warn(`⚠️  Invalid ${name} value: "${envValue}". Expected integer. Using default: ${defaultValue}`);
    return { value: defaultValue, wasProvided: false };
  }

  return { value: parsed, wasProvided: true };
}

/**
 * Parse a rate limit environment variable.
 * Accepts positive integers (normal limit), or special values to disable:
 *   "unlimited" (case-insensitive), "0", "-1" → returns 0 (sentinel for disabled)
 * In express-rate-limit v7+, max:0 blocks all requests, so callers must
 * use `skip: () => true` when the value is 0.
 */
function parseRateLimit(
  name: string,
  envValue: string | undefined,
  defaultValue: number
): { value: number; wasProvided: boolean } {
  if (envValue === undefined) {
    return { value: defaultValue, wasProvided: false };
  }

  const trimmed = envValue.trim();

  // Special "unlimited" keyword (case-insensitive)
  if (trimmed.toLowerCase() === 'unlimited') {
    logger.info(`ℹ️  ${name} set to "unlimited" — rate limiting disabled for this category`);
    return { value: 0, wasProvided: true };
  }

  const parsed = parseInt(trimmed, 10);
  if (isNaN(parsed)) {
    logger.warn(`⚠️  Invalid ${name} value: "${envValue}". Expected integer or "unlimited". Using default: ${defaultValue}`);
    return { value: defaultValue, wasProvided: false };
  }

  // 0 or negative → treat as "disable"
  if (parsed <= 0) {
    logger.info(`ℹ️  ${name} set to ${parsed} — rate limiting disabled for this category`);
    return { value: 0, wasProvided: true };
  }

  return { value: parsed, wasProvided: true };
}

/**
 * Parse trust proxy setting
 * Supports: 'true', 'false', numbers (1, 2, etc.), or IP/CIDR strings
 * See: https://expressjs.com/en/guide/behind-proxies.html
 */
function parseTrustProxy(
  _name: string,
  envValue: string | undefined,
  defaultValue: boolean | number | string
): { value: boolean | number | string; wasProvided: boolean } {
  if (envValue === undefined) {
    return { value: defaultValue, wasProvided: false };
  }

  // Handle boolean values
  if (envValue === 'true') {
    return { value: true, wasProvided: true };
  }
  if (envValue === 'false') {
    return { value: false, wasProvided: true };
  }

  // Handle numeric values (1, 2, etc.)
  const parsed = parseInt(envValue, 10);
  if (!isNaN(parsed)) {
    return { value: parsed, wasProvided: true };
  }

  // Otherwise treat as string (IP address or CIDR notation)
  return { value: envValue, wasProvided: true };
}

/**
 * Parse string with allowed values
 */
function parseEnum<T extends string>(
  name: string,
  envValue: string | undefined,
  allowedValues: readonly T[],
  defaultValue: T
): { value: T; wasProvided: boolean } {
  if (envValue === undefined) {
    return { value: defaultValue, wasProvided: false };
  }

  if (allowedValues.includes(envValue as T)) {
    return { value: envValue as T, wasProvided: true };
  }

  logger.warn(`⚠️  Invalid ${name} value: "${envValue}". Allowed values: ${allowedValues.join(', ')}. Using default: ${defaultValue}`);
  return { value: defaultValue, wasProvided: false };
}

/**
 * Environment configuration interface
 */
export interface EnvironmentConfig {
  // Node environment
  nodeEnv: 'production' | 'development';
  nodeEnvProvided: boolean;
  isDevelopment: boolean;
  isProduction: boolean;

  // Server
  port: number;
  portProvided: boolean;
  baseUrl: string;
  baseUrlProvided: boolean;
  allowedOrigins: string[];
  allowedOriginsProvided: boolean;
  iframeAllowedOrigins: string[];
  iframeAllowedOriginsProvided: boolean;
  trustProxy: boolean | number | string;
  trustProxyProvided: boolean;
  versionCheckDisabled: boolean;

  // Session/Security
  sessionSecret: string;
  sessionSecretProvided: boolean;
  sessionCookieName: string;
  sessionCookieNameProvided: boolean;
  sessionMaxAge: number;
  sessionMaxAgeProvided: boolean;
  sessionRolling: boolean;
  sessionRollingProvided: boolean;
  cookieSecure: boolean;
  cookieSecureProvided: boolean;
  cookieSameSite: 'strict' | 'lax' | 'none';
  cookieSameSiteProvided: boolean;

  // Database
  databasePath: string;
  databasePathProvided: boolean;
  databaseUrl: string | undefined;
  databaseUrlProvided: boolean;
  databaseType: 'sqlite' | 'postgres' | 'mysql';

  // Meshtastic
  meshtasticNodeIp: string;
  meshtasticNodeIpProvided: boolean;
  meshtasticTcpPort: number;
  meshtasticTcpPortProvided: boolean;
  meshtasticStaleConnectionTimeout: number;
  meshtasticStaleConnectionTimeoutProvided: boolean;
  meshtasticConnectTimeoutMs: number;
  meshtasticConnectTimeoutMsProvided: boolean;
  meshtasticReconnectInitialDelayMs: number;
  meshtasticReconnectInitialDelayMsProvided: boolean;
  meshtasticReconnectMaxDelayMs: number;
  meshtasticReconnectMaxDelayMsProvided: boolean;
  meshtasticModuleConfigDelayMs: number;
  meshtasticModuleConfigDelayMsProvided: boolean;
  timezone: string;
  timezoneProvided: boolean;

  // OIDC
  oidcIssuer: string | undefined;
  oidcIssuerProvided: boolean;
  oidcClientId: string | undefined;
  oidcClientIdProvided: boolean;
  oidcClientSecret: string | undefined;
  oidcClientSecretProvided: boolean;
  oidcRedirectUri: string | undefined;
  oidcRedirectUriProvided: boolean;
  oidcScopes: string;
  oidcScopesProvided: boolean;
  oidcAutoCreateUsers: boolean;
  oidcAutoCreateUsersProvided: boolean;
  oidcAllowHttp: boolean;
  oidcAllowHttpProvided: boolean;
  oidcEnabled: boolean;

  // Authentication
  disableLocalAuth: boolean;
  disableLocalAuthProvided: boolean;
  disableAnonymous: boolean;
  disableAnonymousProvided: boolean;
  adminUsername: string;
  adminUsernameProvided: boolean;

  // Proxy Authentication
  proxyAuthEnabled: boolean;
  proxyAuthEnabledProvided: boolean;
  proxyAuthAutoProvision: boolean;
  proxyAuthAutoProvisionProvided: boolean;
  proxyAuthAdminGroups: string[];
  proxyAuthAdminEmails: string[];
  proxyAuthNormalUserGroups: string[];
  proxyAuthJwtGroupsClaim: string;
  proxyAuthHeaderEmail: string | undefined;
  proxyAuthHeaderGroups: string | undefined;
  proxyAuthLogoutUrl: string | undefined;
  proxyAuthAuditLogging: boolean;
  proxyAuthAuditLoggingProvided: boolean;

  // Rate Limiting
  rateLimitApi: number;
  rateLimitApiProvided: boolean;
  rateLimitAuth: number;
  rateLimitAuthProvided: boolean;
  rateLimitMessages: number;
  rateLimitMessagesProvided: boolean;

  // Push Notifications (VAPID)
  vapidPublicKey: string | undefined;
  vapidPublicKeyProvided: boolean;
  vapidPrivateKey: string | undefined;
  vapidPrivateKeyProvided: boolean;
  vapidSubject: string | undefined;
  vapidSubjectProvided: boolean;
  pushNotificationTtl: number;
  pushNotificationTtlProvided: boolean;

  // Access Logging (for fail2ban)
  accessLogEnabled: boolean;
  accessLogEnabledProvided: boolean;
  accessLogPath: string;
  accessLogPathProvided: boolean;
  accessLogFormat: 'combined' | 'common' | 'tiny';
  accessLogFormatProvided: boolean;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logLevelProvided: boolean;
}

/**
 * Parse and validate all environment variables
 */
export function loadEnvironmentConfig(): EnvironmentConfig {
  // Node environment
  const nodeEnv = parseEnum('NODE_ENV', process.env.NODE_ENV, ['production', 'development'] as const, 'development');

  // Server
  const port = parseInt32('PORT', process.env.PORT, 3001);

  // BASE_URL validation and normalization
  const baseUrlRaw = process.env.BASE_URL;
  let baseUrl = baseUrlRaw || '';
  let baseUrlProvided = baseUrlRaw !== undefined;

  // Ensure BASE_URL starts with /
  if (baseUrl && !baseUrl.startsWith('/')) {
    logger.warn(`BASE_URL should start with '/'. Fixing: ${baseUrl} -> /${baseUrl}`);
    baseUrl = `/${baseUrl}`;
  }

  // Validate against path traversal attempts
  if (baseUrl.includes('../') || baseUrl.includes('..\\') || baseUrl.includes('/..')) {
    logger.error(`Invalid BASE_URL: path traversal detected in '${baseUrl}'. Using default.`);
    baseUrl = '';
    baseUrlProvided = false;
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
        logger.error(`Invalid BASE_URL: path traversal segment detected. Using default.`);
        baseUrl = '';
        baseUrlProvided = false;
        break;
      }

      if (!validSegment.test(segment)) {
        logger.warn(`BASE_URL contains invalid characters in segment: ${segment}. Only alphanumeric, hyphens, and underscores are allowed.`);
      }
    }

    // Log multi-segment paths for visibility
    if (baseUrl && segments.length > 1) {
      logger.debug(`Using multi-segment BASE_URL: ${baseUrl} (${segments.length} segments)`);
    }
  }

  const allowedOriginsRaw = process.env.ALLOWED_ORIGINS;
  const allowedOrigins = {
    value: allowedOriginsRaw
      ? allowedOriginsRaw.split(',').map(o => o.trim()).filter(o => o.length > 0)
      : ['http://localhost:8080', 'http://localhost:3001'],
    wasProvided: allowedOriginsRaw !== undefined
  };
  const iframeAllowedOriginsRaw = process.env.IFRAME_ALLOWED_ORIGINS;
  const iframeAllowedOrigins = {
    value: iframeAllowedOriginsRaw
      ? iframeAllowedOriginsRaw.split(',').map(o => o.trim()).filter(o => o.length > 0)
      : [],
    wasProvided: iframeAllowedOriginsRaw !== undefined
  };
  const trustProxy = parseTrustProxy('TRUST_PROXY', process.env.TRUST_PROXY, false);

  // Session/Security
  const sessionSecretRaw = process.env.SESSION_SECRET;
  let sessionSecret: string;
  let sessionSecretProvided: boolean;

  if (sessionSecretRaw) {
    sessionSecret = sessionSecretRaw;
    sessionSecretProvided = true;
  } else {
    // Auto-generate SESSION_SECRET with warning in production
    sessionSecret = crypto.randomBytes(32).toString('hex');
    sessionSecretProvided = false;

    if (nodeEnv.value === 'production') {
      logger.warn('');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn('⚠️  SESSION_SECRET NOT SET - USING AUTO-GENERATED SECRET');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn('   For basic/home use, this is OK. Sessions will work.');
      logger.warn('   ');
      logger.warn('   For production deployments with HTTPS, set SESSION_SECRET:');
      logger.warn('   SESSION_SECRET=$(openssl rand -hex 32)');
      logger.warn('   ');
      logger.warn('   ⚠️  Sessions will be reset on each container restart!');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn('');
    }
  }

  const sessionCookieName = {
    value: process.env.SESSION_COOKIE_NAME || 'meshmonitor.sid',
    wasProvided: process.env.SESSION_COOKIE_NAME !== undefined
  };
  const sessionMaxAge = parseInt32('SESSION_MAX_AGE', process.env.SESSION_MAX_AGE, 86400000); // 24 hours
  const sessionRolling = parseBoolean('SESSION_ROLLING', process.env.SESSION_ROLLING, true); // Reset session expiry on activity
  const cookieSecure = parseBoolean('COOKIE_SECURE', process.env.COOKIE_SECURE, false);
  const cookieSameSite = parseEnum('COOKIE_SAMESITE', process.env.COOKIE_SAMESITE, ['strict', 'lax', 'none'] as const, 'lax');

  // Warn about COOKIE_SECURE defaults
  if (!cookieSecure.wasProvided && nodeEnv.value === 'production') {
    logger.warn('⚠️  COOKIE_SECURE not set - defaulting to false for HTTP compatibility');
    logger.warn('   If using HTTPS, set COOKIE_SECURE=true for better security');
  }

  // Warn about potential secure cookie issues
  if (cookieSecure.value && nodeEnv.value !== 'production') {
    logger.warn('');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('⚠️  COOKIE CONFIGURATION WARNING');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('   Secure cookies are enabled but NODE_ENV is not "production".');
    logger.warn('   ');
    logger.warn('   If you\'re accessing via HTTP (not HTTPS), session cookies');
    logger.warn('   will NOT be sent by the browser, causing authentication to fail.');
    logger.warn('   ');
    logger.warn('   Solutions:');
    logger.warn('   1. Access the application via HTTPS');
    logger.warn('   2. Set COOKIE_SECURE=false for HTTP access (less secure)');
    logger.warn('   3. Set NODE_ENV=production only if using HTTPS');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('');
  }

  // Database
  const databasePath = {
    value: process.env.DATABASE_PATH || '/data/meshmonitor.db',
    wasProvided: process.env.DATABASE_PATH !== undefined
  };

  // DATABASE_URL for PostgreSQL support
  const databaseUrl = {
    value: process.env.DATABASE_URL,
    wasProvided: process.env.DATABASE_URL !== undefined
  };

  // Determine database type from DATABASE_URL
  let databaseType: 'sqlite' | 'postgres' | 'mysql' = 'sqlite';
  if (databaseUrl.value) {
    const url = databaseUrl.value.toLowerCase();
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      databaseType = 'postgres';
      logger.info('📦 Database: PostgreSQL (configured via DATABASE_URL)');
    } else if (url.startsWith('mysql://') || url.startsWith('mariadb://')) {
      databaseType = 'mysql';
      logger.info('📦 Database: MySQL/MariaDB (configured via DATABASE_URL)');
    } else {
      logger.warn(`⚠️  DATABASE_URL provided but not recognized as PostgreSQL or MySQL. Using SQLite.`);
      logger.warn(`   Supported URL prefixes: postgres://, postgresql://, mysql://, mariadb://`);
    }
  } else {
    logger.debug('📦 Database: SQLite (default)');
  }

  const versionCheckDisabled = process.env.VERSION_CHECK_DISABLED == "true";

  // Meshtastic
  const meshtasticNodeIp = {
    value: process.env.MESHTASTIC_NODE_IP || '192.168.1.100',
    wasProvided: process.env.MESHTASTIC_NODE_IP !== undefined
  };
  const meshtasticTcpPort = parseInt32('MESHTASTIC_TCP_PORT', process.env.MESHTASTIC_TCP_PORT, 4403);
  const meshtasticStaleConnectionTimeout = parseInt32(
    'MESHTASTIC_STALE_CONNECTION_TIMEOUT',
    process.env.MESHTASTIC_STALE_CONNECTION_TIMEOUT,
    300000 // 5 minutes default (in milliseconds)
  );
  const meshtasticConnectTimeoutMs = parseInt32(
    'MESHTASTIC_CONNECT_TIMEOUT_MS',
    process.env.MESHTASTIC_CONNECT_TIMEOUT_MS,
    60000 // 60 seconds default
  );
  const meshtasticReconnectInitialDelayMs = parseInt32(
    'MESHTASTIC_RECONNECT_INITIAL_DELAY_MS',
    process.env.MESHTASTIC_RECONNECT_INITIAL_DELAY_MS,
    60000 // 60 seconds default
  );
  const meshtasticReconnectMaxDelayMs = parseInt32(
    'MESHTASTIC_RECONNECT_MAX_DELAY_MS',
    process.env.MESHTASTIC_RECONNECT_MAX_DELAY_MS,
    60000 // 60 seconds default
  );
  const meshtasticModuleConfigDelayMs = parseInt32(
    'MESHTASTIC_MODULE_CONFIG_DELAY_MS',
    process.env.MESHTASTIC_MODULE_CONFIG_DELAY_MS,
    1000 // 1 second default
  );
  const timezoneRaw = process.env.TZ || 'UTC';
  let timezone = { value: timezoneRaw, wasProvided: process.env.TZ !== undefined };

  // Validate timezone is supported by Intl
  if (timezone.wasProvided) {
    try {
      // Test if timezone is valid by attempting to format a date with it
      new Date().toLocaleString('en-US', { timeZone: timezone.value });
    } catch (error) {
      logger.warn(`⚠️  Invalid timezone '${timezone.value}' provided in TZ environment variable.`);
      logger.warn(`   Falling back to UTC. Use standard IANA timezone names (e.g., 'Europe/London', 'America/New_York').`);
      timezone = { value: 'UTC', wasProvided: false };
    }
  }

  // Virtual Node

  // OIDC
  const oidcIssuer = {
    value: process.env.OIDC_ISSUER,
    wasProvided: process.env.OIDC_ISSUER !== undefined
  };
  const oidcClientId = {
    value: process.env.OIDC_CLIENT_ID,
    wasProvided: process.env.OIDC_CLIENT_ID !== undefined
  };
  const oidcClientSecret = {
    value: process.env.OIDC_CLIENT_SECRET,
    wasProvided: process.env.OIDC_CLIENT_SECRET !== undefined
  };
  const oidcRedirectUri = {
    value: process.env.OIDC_REDIRECT_URI,
    wasProvided: process.env.OIDC_REDIRECT_URI !== undefined
  };
  const oidcScopes = {
    value: process.env.OIDC_SCOPES || 'openid profile email',
    wasProvided: process.env.OIDC_SCOPES !== undefined
  };
  const oidcAutoCreateUsers = parseBoolean('OIDC_AUTO_CREATE_USERS', process.env.OIDC_AUTO_CREATE_USERS, true);
  const oidcAllowHttp = parseBoolean('OIDC_ALLOW_HTTP', process.env.OIDC_ALLOW_HTTP, false);

  const oidcEnabled = !!(oidcIssuer.value && oidcClientId.value && oidcClientSecret.value);

  if (oidcIssuer.wasProvided || oidcClientId.wasProvided || oidcClientSecret.wasProvided) {
    if (!oidcEnabled) {
      logger.warn('⚠️  Partial OIDC configuration detected. All three are required: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET');
    }
  }

  if (oidcAllowHttp.value && oidcIssuer.value) {
    logger.warn('');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('⚠️  SECURITY WARNING: OIDC_ALLOW_HTTP is enabled');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('   HTTP OIDC issuers are allowed. This is INSECURE!');
    logger.warn('   Only use this for testing with mock OIDC providers.');
    logger.warn('   NEVER use this in production.');
    logger.warn('═══════════════════════════════════════════════════════════');
    logger.warn('');
  }

  // Authentication
  const disableLocalAuth = parseBoolean('DISABLE_LOCAL_AUTH', process.env.DISABLE_LOCAL_AUTH, false);
  const disableAnonymous = parseBoolean('DISABLE_ANONYMOUS', process.env.DISABLE_ANONYMOUS, false);
  const adminUsername = {
    value: process.env.ADMIN_USERNAME || 'admin',
    wasProvided: process.env.ADMIN_USERNAME !== undefined
  };

  // ============ PROXY AUTHENTICATION ============
  const proxyAuthEnabled = parseBoolean('PROXY_AUTH_ENABLED', process.env.PROXY_AUTH_ENABLED, false);
  const proxyAuthAutoProvision = parseBoolean('PROXY_AUTH_AUTO_PROVISION', process.env.PROXY_AUTH_AUTO_PROVISION, false);
  const proxyAuthAuditLogging = parseBoolean('PROXY_AUTH_AUDIT_LOGGING', process.env.PROXY_AUTH_AUDIT_LOGGING, true);

  // Parse comma-separated lists
  const proxyAuthAdminGroups = (process.env.PROXY_AUTH_ADMIN_GROUPS || '')
    .split(',')
    .map(g => g.trim())
    .filter(Boolean);

  const proxyAuthAdminEmails = (process.env.PROXY_AUTH_ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  const proxyAuthNormalUserGroups = (process.env.PROXY_AUTH_NORMAL_USER_GROUPS || '')
    .split(',')
    .map(g => g.trim())
    .filter(Boolean);

  const proxyAuthJwtGroupsClaim = process.env.PROXY_AUTH_JWT_GROUPS_CLAIM || 'groups';
  const proxyAuthHeaderEmail = process.env.PROXY_AUTH_HEADER_EMAIL || undefined;
  const proxyAuthHeaderGroups = process.env.PROXY_AUTH_HEADER_GROUPS || undefined;
  const proxyAuthLogoutUrl = process.env.PROXY_AUTH_LOGOUT_URL || undefined;

  // Warning if enabled without TRUST_PROXY (warn in all environments)
  if (proxyAuthEnabled.value && !trustProxy.wasProvided) {
    logger.warn('⚠️  PROXY_AUTH_ENABLED is true but TRUST_PROXY is not configured!');
    logger.warn('   Proxy authentication requires TRUST_PROXY to prevent header spoofing.');
    logger.warn('   Set TRUST_PROXY=true or TRUST_PROXY=1 to trust the reverse proxy.');
  }

  // Rate Limiting
  // Defaults: API=1000/15min (~1req/sec), Auth=5/15min, Messages=30/min
  const rateLimitApi = parseRateLimit('RATE_LIMIT_API', process.env.RATE_LIMIT_API, nodeEnv.value === 'development' ? 10000 : 1000);
  const rateLimitAuth = parseRateLimit('RATE_LIMIT_AUTH', process.env.RATE_LIMIT_AUTH, nodeEnv.value === 'development' ? 100 : 5);
  const rateLimitMessages = parseRateLimit('RATE_LIMIT_MESSAGES', process.env.RATE_LIMIT_MESSAGES, nodeEnv.value === 'development' ? 100 : 30);

  // Push Notifications (VAPID) - optional, can be stored in database instead
  const vapidPublicKey = {
    value: process.env.VAPID_PUBLIC_KEY,
    wasProvided: process.env.VAPID_PUBLIC_KEY !== undefined
  };
  const vapidPrivateKey = {
    value: process.env.VAPID_PRIVATE_KEY,
    wasProvided: process.env.VAPID_PRIVATE_KEY !== undefined
  };
  const vapidSubject = {
    value: process.env.VAPID_SUBJECT,
    wasProvided: process.env.VAPID_SUBJECT !== undefined
  };
  // TTL (Time To Live) for push notifications in seconds
  // Default: 3600 seconds (1 hour) - prevents old notifications from flooding when device comes online
  const pushNotificationTtl = parseInt32('PUSH_NOTIFICATION_TTL', process.env.PUSH_NOTIFICATION_TTL, 3600);

  // Validate TTL is in recommended range (5 minutes to 24 hours)
  if (pushNotificationTtl.value < 300 || pushNotificationTtl.value > 86400) {
    logger.warn(`⚠️  PUSH_NOTIFICATION_TTL out of recommended range (300-86400 seconds). Using default: 3600`);
    pushNotificationTtl.value = 3600;
    pushNotificationTtl.wasProvided = false;
  }

  // Access Logging (for fail2ban)
  const accessLogEnabled = parseBoolean('ACCESS_LOG_ENABLED', process.env.ACCESS_LOG_ENABLED, false);
  const accessLogPath = {
    value: process.env.ACCESS_LOG_PATH || '/data/logs/access.log',
    wasProvided: process.env.ACCESS_LOG_PATH !== undefined
  };

  // Validate ACCESS_LOG_PATH for security
  if (accessLogPath.value.includes('../') || !path.isAbsolute(accessLogPath.value)) {
    logger.warn(`Invalid ACCESS_LOG_PATH: ${accessLogPath.value}. Must be absolute path without path traversal.`);
    accessLogPath.value = '/data/logs/access.log';
    accessLogPath.wasProvided = false;
  }

  const accessLogFormat = parseEnum('ACCESS_LOG_FORMAT', process.env.ACCESS_LOG_FORMAT, ['combined', 'common', 'tiny'] as const, 'combined');

  // Logging
  const logLevelDefault: 'debug' | 'info' | 'warn' | 'error' = nodeEnv.value === 'development' ? 'debug' : 'info';
  const logLevel = parseEnum('LOG_LEVEL', process.env.LOG_LEVEL?.toLowerCase(), ['debug', 'info', 'warn', 'error'] as const, logLevelDefault);

  // Log effective environment configuration at startup
  const src = (provided: boolean) => provided ? 'env' : 'default';
  logger.info('📋 Environment configuration:');
  logger.info(`   NODE_ENV: ${nodeEnv.value} (${src(nodeEnv.wasProvided)})`);
  logger.info(`   PORT: ${port.value} (${src(port.wasProvided)})`);
  logger.info(`   BASE_URL: ${baseUrl || '/'} (${src(baseUrlProvided)})`);
  logger.info(`   LOG_LEVEL: ${logLevel.value} (${src(logLevel.wasProvided)})`);
  logger.info(`   TZ: ${timezone.value} (${src(timezone.wasProvided)})`);
  logger.info(`   ALLOWED_ORIGINS: ${allowedOrigins.value || '*'} (${src(allowedOrigins.wasProvided)})`);
  logger.info(`   IFRAME_ALLOWED_ORIGINS: ${iframeAllowedOrigins.value.length > 0 ? iframeAllowedOrigins.value.join(',') : '(not set - iframe embedding blocked)'} (${src(iframeAllowedOrigins.wasProvided)})`);
  logger.info(`   TRUST_PROXY: ${trustProxy.value} (${src(trustProxy.wasProvided)})`);
  logger.info(`   VERSION_CHECK_DISABLED: ${versionCheckDisabled}`);
  logger.info('   --- Session/Security ---');
  logger.info(`   SESSION_SECRET: ${sessionSecretProvided ? '***provided***' : '(auto-generated)'}`);
  logger.info(`   SESSION_COOKIE_NAME: ${sessionCookieName.value} (${src(sessionCookieName.wasProvided)})`);
  logger.info(`   SESSION_MAX_AGE: ${sessionMaxAge.value}ms (${src(sessionMaxAge.wasProvided)})`);
  logger.info(`   SESSION_ROLLING: ${sessionRolling.value} (${src(sessionRolling.wasProvided)})`);
  logger.info(`   COOKIE_SECURE: ${cookieSecure.value} (${src(cookieSecure.wasProvided)})`);
  logger.info(`   COOKIE_SAMESITE: ${cookieSameSite.value} (${src(cookieSameSite.wasProvided)})`);
  logger.info('   --- Database ---');
  logger.info(`   DATABASE_TYPE: ${databaseType}`);
  if (databaseUrl.wasProvided) {
    logger.info(`   DATABASE_URL: ***provided*** (${databaseType})`);
  } else {
    logger.info(`   DATABASE_PATH: ${databasePath.value} (${src(databasePath.wasProvided)})`);
  }
  logger.info('   --- Meshtastic ---');
  logger.info(`   MESHTASTIC_NODE_IP: ${meshtasticNodeIp.value} (${src(meshtasticNodeIp.wasProvided)})`);
  logger.info(`   MESHTASTIC_TCP_PORT: ${meshtasticTcpPort.value} (${src(meshtasticTcpPort.wasProvided)})`);
  logger.info(`   MESHTASTIC_STALE_CONNECTION_TIMEOUT: ${meshtasticStaleConnectionTimeout.value}ms (${src(meshtasticStaleConnectionTimeout.wasProvided)})`);
  logger.info(`   MESHTASTIC_CONNECT_TIMEOUT_MS: ${meshtasticConnectTimeoutMs.value}ms (${src(meshtasticConnectTimeoutMs.wasProvided)})`);
  logger.info(`   MESHTASTIC_RECONNECT_INITIAL_DELAY_MS: ${meshtasticReconnectInitialDelayMs.value}ms (${src(meshtasticReconnectInitialDelayMs.wasProvided)})`);
  logger.info(`   MESHTASTIC_RECONNECT_MAX_DELAY_MS: ${meshtasticReconnectMaxDelayMs.value}ms (${src(meshtasticReconnectMaxDelayMs.wasProvided)})`);
  logger.info(`   MESHTASTIC_MODULE_CONFIG_DELAY_MS: ${meshtasticModuleConfigDelayMs.value}ms (${src(meshtasticModuleConfigDelayMs.wasProvided)})`);
  if (oidcEnabled) {
    logger.info('   --- OIDC ---');
    logger.info(`   OIDC_ISSUER: ${oidcIssuer.value ? '***provided***' : 'not set'}`);
    logger.info(`   OIDC_CLIENT_ID: ${oidcClientId.value ? '***provided***' : 'not set'}`);
    logger.info(`   OIDC_AUTO_CREATE_USERS: ${oidcAutoCreateUsers.value} (${src(oidcAutoCreateUsers.wasProvided)})`);
  }
  logger.info('   --- Authentication ---');
  logger.info(`   DISABLE_ANONYMOUS: ${disableAnonymous.value} (${src(disableAnonymous.wasProvided)})`);
  logger.info(`   DISABLE_LOCAL_AUTH: ${disableLocalAuth.value} (${src(disableLocalAuth.wasProvided)})`);
  if (adminUsername.wasProvided) {
    logger.info(`   ADMIN_USERNAME: ${adminUsername.value} (env)`);
  }
  if (proxyAuthEnabled.value) {
    logger.info('   --- Proxy Authentication ---');
    logger.info(`   PROXY_AUTH_ENABLED: ${proxyAuthEnabled.value}`);
    logger.info(`   PROXY_AUTH_AUTO_PROVISION: ${proxyAuthAutoProvision.value}`);
    logger.info(`   PROXY_AUTH_ADMIN_GROUPS: ${proxyAuthAdminGroups.length > 0 ? proxyAuthAdminGroups.join(', ') : 'not set'}`);
    logger.info(`   PROXY_AUTH_ADMIN_EMAILS: ${proxyAuthAdminEmails.length > 0 ? '***configured***' : 'not set'}`);
    logger.info(`   PROXY_AUTH_NORMAL_USER_GROUPS: ${proxyAuthNormalUserGroups.length > 0 ? proxyAuthNormalUserGroups.join(', ') : 'not set (all proxy users allowed)'}`);
    logger.info(`   PROXY_AUTH_JWT_GROUPS_CLAIM: ${proxyAuthJwtGroupsClaim}`);
    logger.info(`   PROXY_AUTH_AUDIT_LOGGING: ${proxyAuthAuditLogging.value}`);
    if (proxyAuthLogoutUrl) {
      logger.info(`   PROXY_AUTH_LOGOUT_URL: ${proxyAuthLogoutUrl}`);
    }
  }
  logger.info('   --- Rate Limiting ---');
  logger.info(`   RATE_LIMIT_API: ${rateLimitApi.value} req/min (${src(rateLimitApi.wasProvided)})`);
  logger.info(`   RATE_LIMIT_AUTH: ${rateLimitAuth.value} req/min (${src(rateLimitAuth.wasProvided)})`);
  logger.info(`   RATE_LIMIT_MESSAGES: ${rateLimitMessages.value} req/min (${src(rateLimitMessages.wasProvided)})`);
  if (vapidPublicKey.wasProvided) {
    logger.info('   --- Push Notifications ---');
    logger.info(`   VAPID keys: ***provided***`);
    logger.info(`   PUSH_NOTIFICATION_TTL: ${pushNotificationTtl.value}s (${src(pushNotificationTtl.wasProvided)})`);
  }
  if (accessLogEnabled.value) {
    logger.info('   --- Access Logging ---');
    logger.info(`   ACCESS_LOG_PATH: ${accessLogPath.value} (${src(accessLogPath.wasProvided)})`);
    logger.info(`   ACCESS_LOG_FORMAT: ${accessLogFormat.value} (${src(accessLogFormat.wasProvided)})`);
  }

  return {
    // Node environment
    nodeEnv: nodeEnv.value,
    nodeEnvProvided: nodeEnv.wasProvided,
    isDevelopment: nodeEnv.value !== 'production',
    isProduction: nodeEnv.value === 'production',

    // Server
    port: port.value,
    portProvided: port.wasProvided,
    baseUrl,
    baseUrlProvided,
    allowedOrigins: allowedOrigins.value,
    allowedOriginsProvided: allowedOrigins.wasProvided,
    iframeAllowedOrigins: iframeAllowedOrigins.value,
    iframeAllowedOriginsProvided: iframeAllowedOrigins.wasProvided,
    trustProxy: trustProxy.value,
    trustProxyProvided: trustProxy.wasProvided,
    versionCheckDisabled: versionCheckDisabled,

    // Session/Security
    sessionSecret,
    sessionSecretProvided,
    sessionCookieName: sessionCookieName.value,
    sessionCookieNameProvided: sessionCookieName.wasProvided,
    sessionMaxAge: sessionMaxAge.value,
    sessionMaxAgeProvided: sessionMaxAge.wasProvided,
    sessionRolling: sessionRolling.value,
    sessionRollingProvided: sessionRolling.wasProvided,
    cookieSecure: cookieSecure.value,
    cookieSecureProvided: cookieSecure.wasProvided,
    cookieSameSite: cookieSameSite.value,
    cookieSameSiteProvided: cookieSameSite.wasProvided,

    // Database
    databasePath: databasePath.value,
    databasePathProvided: databasePath.wasProvided,
    databaseUrl: databaseUrl.value,
    databaseUrlProvided: databaseUrl.wasProvided,
    databaseType,

    // Meshtastic
    meshtasticNodeIp: meshtasticNodeIp.value,
    meshtasticNodeIpProvided: meshtasticNodeIp.wasProvided,
    meshtasticTcpPort: meshtasticTcpPort.value,
    meshtasticTcpPortProvided: meshtasticTcpPort.wasProvided,
    meshtasticStaleConnectionTimeout: meshtasticStaleConnectionTimeout.value,
    meshtasticStaleConnectionTimeoutProvided: meshtasticStaleConnectionTimeout.wasProvided,
    meshtasticConnectTimeoutMs: meshtasticConnectTimeoutMs.value,
    meshtasticConnectTimeoutMsProvided: meshtasticConnectTimeoutMs.wasProvided,
    meshtasticReconnectInitialDelayMs: meshtasticReconnectInitialDelayMs.value,
    meshtasticReconnectInitialDelayMsProvided: meshtasticReconnectInitialDelayMs.wasProvided,
    meshtasticReconnectMaxDelayMs: meshtasticReconnectMaxDelayMs.value,
    meshtasticReconnectMaxDelayMsProvided: meshtasticReconnectMaxDelayMs.wasProvided,
    meshtasticModuleConfigDelayMs: meshtasticModuleConfigDelayMs.value,
    meshtasticModuleConfigDelayMsProvided: meshtasticModuleConfigDelayMs.wasProvided,
    timezone: timezone.value,
    timezoneProvided: timezone.wasProvided,

    // OIDC
    oidcIssuer: oidcIssuer.value,
    oidcIssuerProvided: oidcIssuer.wasProvided,
    oidcClientId: oidcClientId.value,
    oidcClientIdProvided: oidcClientId.wasProvided,
    oidcClientSecret: oidcClientSecret.value,
    oidcClientSecretProvided: oidcClientSecret.wasProvided,
    oidcRedirectUri: oidcRedirectUri.value,
    oidcRedirectUriProvided: oidcRedirectUri.wasProvided,
    oidcScopes: oidcScopes.value,
    oidcScopesProvided: oidcScopes.wasProvided,
    oidcAutoCreateUsers: oidcAutoCreateUsers.value,
    oidcAutoCreateUsersProvided: oidcAutoCreateUsers.wasProvided,
    oidcAllowHttp: oidcAllowHttp.value,
    oidcAllowHttpProvided: oidcAllowHttp.wasProvided,
    oidcEnabled,

    // Authentication
    disableLocalAuth: disableLocalAuth.value,
    disableLocalAuthProvided: disableLocalAuth.wasProvided,
    disableAnonymous: disableAnonymous.value,
    disableAnonymousProvided: disableAnonymous.wasProvided,
    adminUsername: adminUsername.value,
    adminUsernameProvided: adminUsername.wasProvided,

    // Proxy Authentication
    proxyAuthEnabled: proxyAuthEnabled.value,
    proxyAuthEnabledProvided: proxyAuthEnabled.wasProvided,
    proxyAuthAutoProvision: proxyAuthAutoProvision.value,
    proxyAuthAutoProvisionProvided: proxyAuthAutoProvision.wasProvided,
    proxyAuthAdminGroups,
    proxyAuthAdminEmails,
    proxyAuthNormalUserGroups,
    proxyAuthJwtGroupsClaim,
    proxyAuthHeaderEmail,
    proxyAuthHeaderGroups,
    proxyAuthLogoutUrl,
    proxyAuthAuditLogging: proxyAuthAuditLogging.value,
    proxyAuthAuditLoggingProvided: proxyAuthAuditLogging.wasProvided,

    // Rate Limiting
    rateLimitApi: rateLimitApi.value,
    rateLimitApiProvided: rateLimitApi.wasProvided,
    rateLimitAuth: rateLimitAuth.value,
    rateLimitAuthProvided: rateLimitAuth.wasProvided,
    rateLimitMessages: rateLimitMessages.value,
    rateLimitMessagesProvided: rateLimitMessages.wasProvided,

    // Push Notifications (VAPID)
    vapidPublicKey: vapidPublicKey.value,
    vapidPublicKeyProvided: vapidPublicKey.wasProvided,
    vapidPrivateKey: vapidPrivateKey.value,
    vapidPrivateKeyProvided: vapidPrivateKey.wasProvided,
    vapidSubject: vapidSubject.value,
    vapidSubjectProvided: vapidSubject.wasProvided,
    pushNotificationTtl: pushNotificationTtl.value,
    pushNotificationTtlProvided: pushNotificationTtl.wasProvided,

    // Access Logging (for fail2ban)
    accessLogEnabled: accessLogEnabled.value,
    accessLogEnabledProvided: accessLogEnabled.wasProvided,
    accessLogPath: accessLogPath.value,
    accessLogPathProvided: accessLogPath.wasProvided,
    accessLogFormat: accessLogFormat.value,
    accessLogFormatProvided: accessLogFormat.wasProvided,

    // Logging
    logLevel: logLevel.value,
    logLevelProvided: logLevel.wasProvided
  };
}

// Singleton instance - loaded once at startup
let environmentConfig: EnvironmentConfig | null = null;

/**
 * Get environment configuration (loads once, then caches)
 */
export function getEnvironmentConfig(): EnvironmentConfig {
  if (!environmentConfig) {
    environmentConfig = loadEnvironmentConfig();
  }
  return environmentConfig;
}

/**
 * Reset environment configuration (for testing only)
 */
export function resetEnvironmentConfig(): void {
  environmentConfig = null;
}
