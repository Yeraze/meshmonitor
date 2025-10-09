/**
 * Authentication and User Management Types
 */

export type AuthProvider = 'local' | 'oidc';

export interface User {
  id: number;
  username: string;
  passwordHash: string | null;  // NULL for OIDC users
  email: string | null;
  displayName: string | null;
  authProvider: AuthProvider;
  oidcSubject: string | null;   // OIDC sub claim
  isAdmin: boolean;
  isActive: boolean;
  createdAt: number;             // Unix timestamp
  lastLoginAt: number | null;    // Unix timestamp
  createdBy: number | null;      // User ID who created this account
}

export interface CreateUserInput {
  username: string;
  password?: string;             // Required for local auth
  email?: string;
  displayName?: string;
  authProvider: AuthProvider;
  oidcSubject?: string;          // Required for OIDC auth
  isAdmin?: boolean;
  createdBy?: number;
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
  isActive?: boolean;
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

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}
