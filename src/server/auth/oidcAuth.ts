/**
 * OIDC Authentication Module
 *
 * Handles OpenID Connect authentication flow
 */

import * as client from 'openid-client';
import { User } from '../../types/auth.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { getNestedValue, normalizeGroups, resolveGroupRole } from './claims.js';

let oidcConfig: client.Configuration | null = null;
let isInitialized = false;
let oidcWantedButFailed = false;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
const RETRY_DELAY_MS = 30_000; // Retry every 30 seconds on failure
const MAX_RETRIES = 10;
let retryCount = 0;

/**
 * Initialize OIDC client
 */
export async function initializeOIDC(): Promise<boolean> {
  if (isInitialized && oidcConfig !== null) {
    return true;
  }

  const env = getEnvironmentConfig();

  if (!env.oidcEnabled) {
    logger.info('ℹ️  OIDC not configured (missing OIDC_ISSUER, OIDC_CLIENT_ID, or OIDC_CLIENT_SECRET)');
    isInitialized = true;
    return false;
  }

  const issuer = env.oidcIssuer!;
  const clientId = env.oidcClientId!;
  const clientSecret = env.oidcClientSecret!;

  try {
    logger.debug('🔐 Initializing OIDC client...');

    const issuerUrl = new URL(issuer);

    // Discover OIDC configuration
    oidcConfig = await client.discovery(
      issuerUrl,
      clientId,
      undefined,
      client.ClientSecretPost(clientSecret)
    );

    logger.debug('✅ OIDC client initialized successfully');
    isInitialized = true;
    oidcWantedButFailed = false;
    retryCount = 0;
    return true;
  } catch (error) {
    logger.error('❌ Failed to initialize OIDC client:', error);
    oidcWantedButFailed = true;
    isInitialized = true;
    scheduleRetry();
    return false;
  }
}

/**
 * Schedule a retry of OIDC initialization after a transient failure
 */
function scheduleRetry(): void {
  if (retryTimeout) return; // Already scheduled
  if (retryCount >= MAX_RETRIES) {
    logger.error(`❌ OIDC initialization failed after ${MAX_RETRIES} retries — giving up. Restart the server to try again.`);
    return;
  }

  retryCount++;
  logger.info(`🔄 Scheduling OIDC retry ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s...`);
  retryTimeout = setTimeout(async () => {
    retryTimeout = null;
    isInitialized = false; // Allow re-initialization
    await initializeOIDC();
  }, RETRY_DELAY_MS);
}

/**
 * Clean up pending retry timers for graceful shutdown
 */
export function cleanupOIDC(): void {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
}

/**
 * Check if OIDC is enabled and initialized
 * Returns true if OIDC is configured (even if init temporarily failed and is retrying)
 */
export function isOIDCEnabled(): boolean {
  return oidcConfig !== null || oidcWantedButFailed;
}

/**
 * Get OIDC configuration
 */
export function getOIDCConfig(): client.Configuration | null {
  return oidcConfig;
}

/**
 * Generate authorization URL for OIDC login
 */
export async function generateAuthorizationUrl(
  redirectUri: string,
  state: string,
  codeVerifier: string,
  nonce: string
): Promise<string> {
  if (!oidcConfig) {
    throw new Error('OIDC not initialized');
  }

  const env = getEnvironmentConfig();
  const scopeArray = env.oidcScopes.split(' ');

  const codeChallenge = client.calculatePKCECodeChallenge(codeVerifier);

  const authUrl = client.buildAuthorizationUrl(oidcConfig, {
    redirect_uri: redirectUri,
    scope: scopeArray.join(' '),
    state,
    nonce,
    code_challenge: await codeChallenge,
    code_challenge_method: 'S256'
  });

  return authUrl.href;
}

/**
 * Handle OIDC callback and create/update user
 */
export async function handleOIDCCallback(
  callbackUrl: URL,
  expectedState: string,
  codeVerifier: string,
  expectedNonce: string
): Promise<User> {
  if (!oidcConfig) {
    throw new Error('OIDC not initialized');
  }

  try {
    // Extract state from callback URL for validation
    const state = callbackUrl.searchParams.get('state');

    // Validate state
    if (state !== expectedState) {
      throw new Error('Invalid state parameter');
    }

    // Exchange code for tokens
    // Pass the full callback URL with all parameters (including iss if present)
    const tokenResponse = await client.authorizationCodeGrant(
      oidcConfig,
      callbackUrl,
      {
        pkceCodeVerifier: codeVerifier,
        expectedState,
        expectedNonce
      }
    );

    // Validate and decode ID token
    const idTokenClaims = tokenResponse.claims();

    if (!idTokenClaims) {
      throw new Error('No ID token claims received');
    }

    const sub = idTokenClaims.sub;
    const email = idTokenClaims.email as string | undefined;
    const name = idTokenClaims.name as string | undefined;
    const preferredUsername = idTokenClaims.preferred_username as string | undefined;

    // Create username from claims
    const username = preferredUsername || email?.split('@')[0] || sub.substring(0, 20);

    // Native OIDC group → role mapping (no proxy required). Resolve the groups
    // claim (dot-notation supported, e.g. realm_access.roles for Keycloak) and
    // derive admin/allowed using the same helpers proxy auth uses.
    const env = getEnvironmentConfig();
    const groups = normalizeGroups(getNestedValue(idTokenClaims, env.oidcGroupsClaim));
    const groupRole = resolveGroupRole(groups, {
      adminGroups: env.oidcAdminGroups,
      allowedGroups: env.oidcAllowedGroups,
    });

    // Allowed-groups gate: applies to every user (incl. existing ones) so
    // revoking a group blocks the next login. Admins always pass (mirrors
    // proxy auth's isNormalProxyUserAllowed).
    if (!groupRole.allowed) {
      logger.warn(`❌ OIDC login denied for '${username}': not in any allowed group (OIDC_ALLOWED_GROUPS)`);
      throw new Error('OIDC login denied: user is not a member of an allowed group');
    }

    // Check if user exists by OIDC subject
    let user: User | null = null;
    user = await databaseService.auth.getUserByOidcSubject(sub) as User | null;

    if (user) {
      // Update existing user
      const updateFields: Parameters<typeof databaseService.auth.updateUser>[1] = {
        email: email || user.email || undefined,
        displayName: name || user.displayName || undefined,
        lastLoginAt: Date.now()
      };
      // When admin groups are configured, admin status tracks group membership
      // on every login (promote AND demote). When not configured, leave isAdmin
      // untouched so manual promotion / the first-login bootstrap is preserved.
      if (groupRole.adminGroupsConfigured && groupRole.isAdmin !== user.isAdmin) {
        updateFields.isAdmin = groupRole.isAdmin;
        logger.info(`🔐 OIDC group sync: '${user.username}' admin ${user.isAdmin} → ${groupRole.isAdmin}`);
      }
      await databaseService.auth.updateUser(user.id, updateFields);
      user = await databaseService.findUserByIdAsync(user.id) as User;

      logger.debug(`✅ OIDC user logged in: ${user.username}`);
    } else {
      // Auto-create new user if enabled
      if (!env.oidcAutoCreateUsers) {
        throw new Error('OIDC user not found and auto-creation is disabled');
      }

      // Check if a native-login user exists with the same username or email
      let existingUser: User | null = null;
      existingUser = await databaseService.findUserByUsernameAsync(username) as User | null;
      // If no match by username, try matching by email (if provided)
      if (!existingUser && email) {
        const allUsers = await databaseService.auth.getAllUsers();
        const foundUser = allUsers.find(u => u.email === email);
        existingUser = foundUser ? foundUser as unknown as User : null;
      }

      if (existingUser && existingUser.authProvider === 'local') {
        // Migrate existing native-login user to OIDC
        logger.info(`🔄 Migrating existing native-login user '${existingUser.username}' to OIDC`);

        const migrateFields: Parameters<typeof databaseService.auth.updateUser>[1] = {
          authMethod: 'oidc',
          oidcSubject: sub,
          email: email || existingUser.email,
          displayName: name || existingUser.displayName,
          passwordHash: null // Clear password for OIDC users
        };
        // When admin groups are configured, the migrated user's admin status is
        // group-driven from the first OIDC login. Otherwise keep their existing
        // isAdmin (don't silently demote a local admin being migrated).
        if (groupRole.adminGroupsConfigured) {
          migrateFields.isAdmin = groupRole.isAdmin;
        }
        await databaseService.auth.updateUser(existingUser.id, migrateFields);
        user = await databaseService.findUserByIdAsync(existingUser.id) as User;

        // Audit log
        databaseService.auditLogAsync(
          user!.id,
          'user_migrated_to_oidc',
          'users',
          JSON.stringify({ userId: user!.id, username: user!.username, oidcSubject: sub }),
          null
        );

        logger.debug(`✅ User migrated to OIDC: ${user!.username}`);
      } else {
        // First-OIDC-login bootstrap: if no OIDC user has been created yet,
        // promote this one to admin so the deployment isn't locked out when
        // local auth is disabled (issue #2749).
        const allUsersForBootstrap = await databaseService.auth.getAllUsers();
        const isFirstOidcUser = !allUsersForBootstrap.some(u => u.authMethod === 'oidc');
        // When admin groups are configured, admin is purely group-driven (the
        // IdP is authoritative). Otherwise fall back to the first-OIDC-login
        // bootstrap so the deployment isn't locked out when local auth is
        // disabled (issue #2749).
        const grantAdmin = groupRole.adminGroupsConfigured ? groupRole.isAdmin : isFirstOidcUser;

        const userId = await databaseService.auth.createUser({
          username,
          email: email || null,
          displayName: name || null,
          authMethod: 'oidc',
          oidcSubject: sub,
          isAdmin: grantAdmin,
          isActive: true,
          passwordHash: null,
          passwordLocked: false,
          createdAt: Date.now(),
          lastLoginAt: Date.now()
        });
        user = await databaseService.findUserByIdAsync(userId) as User;

        if (grantAdmin) {
          // Grant full permissions to the bootstrap admin (mirrors the
          // resource list used by createAdminIfNeeded).
          const allResources = [
            'dashboard', 'nodes', 'messages', 'settings', 'configuration', 'info',
            'automation', 'connection', 'traceroute', 'audit', 'security', 'themes',
            'channel_0', 'channel_1', 'channel_2', 'channel_3',
            'channel_4', 'channel_5', 'channel_6', 'channel_7',
            'nodes_private', 'packetmonitor'
          ];
          for (const resource of allResources) {
            await databaseService.auth.createPermission({
              userId,
              resource,
              canRead: true,
              canWrite: true,
              canDelete: true,
              grantedBy: null,
              grantedAt: Date.now()
            });
          }
          const reason = groupRole.adminGroupsConfigured ? 'admin group membership' : 'first-OIDC-login bootstrap';
          logger.warn(`🔐 OIDC admin granted to '${user!.username}' (${reason})`);
        } else {
          // Grant default permissions
          const defaultResources = ['dashboard', 'nodes', 'messages', 'settings', 'info', 'traceroute'];
          for (const resource of defaultResources) {
            await databaseService.auth.createPermission({
              userId,
              resource,
              canRead: true,
              canWrite: false,
              grantedBy: null,
              grantedAt: Date.now()
            });
          }
        }

        logger.debug(`✅ OIDC user auto-created: ${user!.username}${grantAdmin ? ' (admin)' : ''}`);

        // Audit log
        databaseService.auditLogAsync(
          user!.id,
          grantAdmin ? 'oidc_user_created_admin' : 'oidc_user_created',
          'users',
          JSON.stringify({ userId: user!.id, username, oidcSubject: sub, isAdmin: grantAdmin }),
          null
        );
      }
    }

    return user!;
  } catch (error) {
    logger.error('OIDC callback error:', error);
    throw error;
  }
}

/**
 * Generate random string for state/nonce/code verifier
 */
export function generateRandomString(length: number = 32): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);

  for (let i = 0; i < length; i++) {
    result += charset[randomValues[i] % charset.length];
  }

  return result;
}
