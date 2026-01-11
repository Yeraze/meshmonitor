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

let oidcConfig: client.Configuration | null = null;
let isInitialized = false;

/**
 * Initialize OIDC client
 */
export async function initializeOIDC(): Promise<boolean> {
  if (isInitialized) {
    return oidcConfig !== null;
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
    return true;
  } catch (error) {
    logger.error('❌ Failed to initialize OIDC client:', error);
    isInitialized = true;
    return false;
  }
}

/**
 * Check if OIDC is enabled and initialized
 */
export function isOIDCEnabled(): boolean {
  return oidcConfig !== null;
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

    // Check if user exists by OIDC subject - use async method for PostgreSQL
    let user: User | null = null;
    if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
      if (databaseService.authRepo) {
        user = await databaseService.authRepo.getUserByOidcSubject(sub) as User | null;
      }
    } else {
      user = databaseService.userModel.findByOIDCSubject(sub);
    }

    if (user) {
      // Update existing user
      if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
        if (databaseService.authRepo) {
          await databaseService.authRepo.updateUser(user.id, {
            email: email || user.email || undefined,
            displayName: name || user.displayName || undefined,
            lastLoginAt: Date.now()
          });
          user = await databaseService.findUserByIdAsync(user.id) as User;
        }
      } else {
        user = databaseService.userModel.update(user.id, {
          email: email || user.email || undefined,
          displayName: name || user.displayName || undefined
        })!;
        // Update last login
        databaseService.userModel.updateLastLogin(user.id);
      }

      logger.debug(`✅ OIDC user logged in: ${user.username}`);
    } else {
      // Auto-create new user if enabled
      const env = getEnvironmentConfig();

      if (!env.oidcAutoCreateUsers) {
        throw new Error('OIDC user not found and auto-creation is disabled');
      }

      // Check if a native-login user exists with the same username or email
      let existingUser: User | null = null;
      if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
        existingUser = await databaseService.findUserByUsernameAsync(username) as User | null;
        // If no match by username, try matching by email (if provided)
        if (!existingUser && email && databaseService.authRepo) {
          // Try to find by email - get all users and filter
          const allUsers = await databaseService.authRepo.getAllUsers();
          const foundUser = allUsers.find(u => u.email === email);
          existingUser = foundUser ? foundUser as unknown as User : null;
        }
      } else {
        existingUser = databaseService.userModel.findByUsername(username);
        // If no match by username, try matching by email (if provided)
        if (!existingUser && email) {
          existingUser = databaseService.userModel.findByEmail(email);
        }
      }

      if (existingUser && existingUser.authProvider === 'local') {
        // Migrate existing native-login user to OIDC
        logger.info(`🔄 Migrating existing native-login user '${existingUser.username}' to OIDC`);

        if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
          if (databaseService.authRepo) {
            await databaseService.authRepo.updateUser(existingUser.id, {
              authMethod: 'oidc',
              oidcSubject: sub,
              email: email || existingUser.email,
              displayName: name || existingUser.displayName,
              passwordHash: null // Clear password for OIDC users
            });
            user = await databaseService.findUserByIdAsync(existingUser.id) as User;
          }
        } else {
          user = databaseService.userModel.migrateToOIDC(
            existingUser.id,
            sub,
            email,
            name
          )!;
        }

        // Audit log
        databaseService.auditLog(
          user!.id,
          'user_migrated_to_oidc',
          'users',
          JSON.stringify({ userId: user!.id, username: user!.username, oidcSubject: sub }),
          null
        );

        logger.debug(`✅ User migrated to OIDC: ${user!.username}`);
      } else {
        // Create new user
        if (databaseService.drizzleDbType === 'postgres' || databaseService.drizzleDbType === 'mysql') {
          if (databaseService.authRepo) {
            const userId = await databaseService.authRepo.createUser({
              username,
              email: email || null,
              displayName: name || null,
              authMethod: 'oidc',
              oidcSubject: sub,
              isAdmin: false,
              isActive: true,
              passwordHash: null,
              passwordLocked: false,
              createdAt: Date.now(),
              lastLoginAt: Date.now()
            });
            user = await databaseService.findUserByIdAsync(userId) as User;

            // Grant default permissions
            const defaultResources = ['nodes', 'messages', 'telemetry', 'traceroutes', 'channels', 'map', 'settings'];
            for (const resource of defaultResources) {
              await databaseService.authRepo.createPermission({
                userId,
                resource,
                canRead: true,
                canWrite: false,
                grantedBy: null,
                grantedAt: Date.now()
              });
            }
          }
        } else {
          user = await databaseService.userModel.create({
            username,
            email,
            displayName: name,
            authProvider: 'oidc',
            oidcSubject: sub,
            isAdmin: false
          });

          // Grant default permissions
          databaseService.permissionModel.grantDefaultPermissions(user.id, false);
        }

        logger.debug(`✅ OIDC user auto-created: ${user!.username}`);

        // Audit log
        databaseService.auditLog(
          user!.id,
          'oidc_user_created',
          'users',
          JSON.stringify({ userId: user!.id, username, oidcSubject: sub }),
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
