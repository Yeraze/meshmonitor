/**
 * UserTestHelper
 *
 * A lightweight test-only helper that delegates all user operations
 * to AuthRepository (Drizzle ORM). Contains zero raw SQL.
 *
 * Provides a UserModel-compatible API so existing test call sites
 * (userModel.create, userModel.findById, etc.) work without renaming.
 *
 * This helper is NOT intended for production use.
 */

import bcrypt from 'bcrypt';
import { AuthRepository } from '../../db/repositories/auth.js';
import { User, CreateUserInput, UpdateUserInput } from '../../types/auth.js';

const SALT_ROUNDS = 12;

/**
 * Map a DbUser (authMethod field) to the legacy User shape (authProvider field).
 * All other camelCase fields are identical between the two interfaces.
 */
function mapDbUserToUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash ?? null,
    email: row.email ?? null,
    displayName: row.displayName ?? null,
    // DbUser uses authMethod; legacy User uses authProvider
    authProvider: (row.authProvider ?? row.authMethod ?? 'local') as User['authProvider'],
    oidcSubject: row.oidcSubject ?? null,
    isAdmin: Boolean(row.isAdmin),
    isActive: Boolean(row.isActive),
    passwordLocked: Boolean(row.passwordLocked),
    mfaEnabled: Boolean(row.mfaEnabled),
    mfaSecret: row.mfaSecret ?? null,
    mfaBackupCodes: row.mfaBackupCodes ?? null,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
    createdBy: row.createdBy ?? null,
  };
}

export class UserTestHelper {
  constructor(private authRepo: AuthRepository) {}

  // ── create ───────────────────────────────────────────────────────────────

  async create(input: CreateUserInput): Promise<User> {
    let passwordHash: string | null = null;

    if (input.authProvider === 'local' && input.password) {
      passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    }

    const id = await this.authRepo.createUser({
      username: input.username,
      passwordHash,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
      authMethod: input.authProvider,          // DbUser field name
      oidcSubject: input.oidcSubject ?? null,
      isAdmin: input.isAdmin ?? false,
      isActive: true,
      createdAt: Date.now(),
    });

    const user = await this.findById(id);
    if (!user) throw new Error('Failed to create user');
    return user;
  }

  // ── finders ──────────────────────────────────────────────────────────────

  async findById(id: number): Promise<User | null> {
    const row = await this.authRepo.getUserById(id);
    return row ? mapDbUserToUser(row) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const row = await this.authRepo.getUserByUsername(username);
    return row ? mapDbUserToUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    // AuthRepository.getUserByEmail uses exact-match; replicate the legacy
    // case-insensitive behaviour by scanning all users (test-only, no perf concern).
    const rows = await this.authRepo.getAllUsers();
    const row = rows.find(r => r.email?.toLowerCase() === email.toLowerCase());
    return row ? mapDbUserToUser(row) : null;
  }

  async findAll(): Promise<User[]> {
    const rows = await this.authRepo.getAllUsers();
    return rows.map(mapDbUserToUser);
  }

  // ── update / delete ──────────────────────────────────────────────────────

  async update(id: number, input: UpdateUserInput & { mfaEnabled?: boolean; mfaSecret?: string | null; mfaBackupCodes?: string | null }): Promise<User | null> {
    await this.authRepo.updateUser(id, input as any);
    return this.findById(id);
  }

  async delete(id: number): Promise<void> {
    // Mirrors legacy UserModel.delete() — soft-delete (sets is_active = 0)
    await this.authRepo.updateUser(id, { isActive: false } as any);
  }

  // ── password ─────────────────────────────────────────────────────────────

  async updatePassword(userId: number, newPassword: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user || user.authProvider !== 'local') {
      throw new Error('Cannot update password for non-local user');
    }
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.authRepo.updateUser(userId, { passwordHash } as any);
  }

  // ── authenticate ─────────────────────────────────────────────────────────

  async authenticate(username: string, password: string): Promise<User | null> {
    const user = await this.findByUsername(username);
    if (!user || !user.isActive) return null;
    if (user.authProvider !== 'local' || !user.passwordHash) return null;

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return null;

    // Update lastLoginAt
    await this.authRepo.updateUser(user.id, { lastLoginAt: Date.now() } as any);
    return user;
  }

  // ── OIDC migration ───────────────────────────────────────────────────────

  async migrateToOIDC(
    id: number,
    oidcSubject: string,
    email?: string,
    displayName?: string
  ): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) throw new Error('User not found');
    if (user.authProvider === 'oidc') throw new Error('User is already using OIDC authentication');

    await this.authRepo.updateUser(id, {
      authMethod: 'oidc',
      oidcSubject,
      passwordHash: null,
      // Only override email/displayName if provided; otherwise preserve existing
      ...(email !== undefined ? { email } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      lastLoginAt: Date.now(),
    } as any);

    return this.findById(id);
  }
}
