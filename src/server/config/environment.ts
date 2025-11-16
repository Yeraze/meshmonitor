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
  trustProxy: boolean | number | string;
  trustProxyProvided: boolean;

  // Session/Security
  sessionSecret: string;
  sessionSecretProvided: boolean;
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

  // Meshtastic
  meshtasticNodeIp: string;
  meshtasticNodeIpProvided: boolean;
  meshtasticTcpPort: number;
  meshtasticTcpPortProvided: boolean;
  meshtasticStaleConnectionTimeout: number;
  meshtasticStaleConnectionTimeoutProvided: boolean;
  timezone: string;
  timezoneProvided: boolean;

  // Virtual Node
  enableVirtualNode: boolean;
  enableVirtualNodeProvided: boolean;
  virtualNodePort: number;
  virtualNodePortProvided: boolean;
  virtualNodeAllowAdminCommands: boolean;
  virtualNodeAllowAdminCommandsProvided: boolean;

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
  const enableVirtualNode = parseBoolean('ENABLE_VIRTUAL_NODE', process.env.ENABLE_VIRTUAL_NODE, false);
  const virtualNodePort = parseInt32('VIRTUAL_NODE_PORT', process.env.VIRTUAL_NODE_PORT, 4404);
  const virtualNodeAllowAdminCommands = parseBoolean('VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS', process.env.VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS, false);

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

  // Rate Limiting
  // Defaults: API=1000/15min (~1req/sec), Auth=5/15min, Messages=30/min
  const rateLimitApi = parseInt32('RATE_LIMIT_API', process.env.RATE_LIMIT_API, nodeEnv.value === 'development' ? 10000 : 1000);
  const rateLimitAuth = parseInt32('RATE_LIMIT_AUTH', process.env.RATE_LIMIT_AUTH, nodeEnv.value === 'development' ? 100 : 5);
  const rateLimitMessages = parseInt32('RATE_LIMIT_MESSAGES', process.env.RATE_LIMIT_MESSAGES, nodeEnv.value === 'development' ? 100 : 30);

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
    trustProxy: trustProxy.value,
    trustProxyProvided: trustProxy.wasProvided,

    // Session/Security
    sessionSecret,
    sessionSecretProvided,
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

    // Meshtastic
    meshtasticNodeIp: meshtasticNodeIp.value,
    meshtasticNodeIpProvided: meshtasticNodeIp.wasProvided,
    meshtasticTcpPort: meshtasticTcpPort.value,
    meshtasticTcpPortProvided: meshtasticTcpPort.wasProvided,
    meshtasticStaleConnectionTimeout: meshtasticStaleConnectionTimeout.value,
    meshtasticStaleConnectionTimeoutProvided: meshtasticStaleConnectionTimeout.wasProvided,
    timezone: timezone.value,
    timezoneProvided: timezone.wasProvided,

    // Virtual Node
    enableVirtualNode: enableVirtualNode.value,
    enableVirtualNodeProvided: enableVirtualNode.wasProvided,
    virtualNodePort: virtualNodePort.value,
    virtualNodePortProvided: virtualNodePort.wasProvided,
    virtualNodeAllowAdminCommands: virtualNodeAllowAdminCommands.value,
    virtualNodeAllowAdminCommandsProvided: virtualNodeAllowAdminCommands.wasProvided,

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
    accessLogFormatProvided: accessLogFormat.wasProvided
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
