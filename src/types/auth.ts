/**
 * Authentication and User Management Types
 */

export type AuthProvider = 'local' | 'oidc';

export interface User {
  id: number;
  username: string;
  passwordHash: string | null; // NULL for OIDC users
  email: string | null;
  displayName: string | null;
  authProvider: AuthProvider;
  oidcSubject: string | null; // OIDC sub claim
  isAdmin: boolean;
  isActive: boolean;
  passwordLocked: boolean; // Prevents password changes when true
  mfaEnabled: boolean; // Whether TOTP MFA is enabled
  mfaSecret: string | null; // NEVER sent to frontend
  mfaBackupCodes: string | null; // NEVER sent to frontend
  createdAt: number; // Unix timestamp
  lastLoginAt: number | null; // Unix timestamp
  createdBy: number | null; // User ID who created this account
}

export interface CreateUserInput {
  username: string;
  password?: string; // Required for local auth
  email?: string;
  displayName?: string;
  authProvider: AuthProvider;
  oidcSubject?: string; // Required for OIDC auth
  isAdmin?: boolean;
  createdBy?: number;
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  isActive?: boolean;
  passwordLocked?: boolean;
}

export interface UserSession {
  userId: number;
  username: string;
  authProvider: AuthProvider;
  isAdmin: boolean;
}

export interface AuthStatus {
  user: User | null;
  permissions: Record<string, { read: boolean; write: boolean }>;
}

export interface APIToken {
  id: number;
  userId: number;
  tokenHash: string;
  prefix: string; // First 8 chars for display (e.g., "mm_v1_ab")
  isActive: boolean;
  createdAt: number; // Unix timestamp
  lastUsedAt: number | null; // Unix timestamp
  createdBy: number; // User ID who created the token
  revokedAt: number | null; // Unix timestamp
  revokedBy: number | null; // User ID who revoked the token
}

export interface CreateAPITokenInput {
  userId: number;
  createdBy: number;
}

export interface APITokenInfo {
  id: number;
  prefix: string;
  isActive: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

// Extend Express Request to include user
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
