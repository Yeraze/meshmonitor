/**
 * PermissionTestHelper
 *
 * A lightweight test-only helper that delegates all permission operations
 * to AuthRepository (Drizzle ORM). Contains zero raw SQL.
 *
 * Use this in route/integration tests that need to set up permission data
 * in a real SQLite database without depending on the deleted PermissionModel class.
 *
 * This helper is NOT intended for production use.
 */

import { AuthRepository } from '../../db/repositories/auth.js';
import {
  Permission,
  PermissionInput,
  PermissionSet,
  ResourceType,
  PermissionAction,
  DEFAULT_USER_PERMISSIONS,
  ADMIN_PERMISSIONS
} from '../../types/permission.js';

export class PermissionTestHelper {
  private authRepo: AuthRepository;

  constructor(authRepo: AuthRepository) {
    this.authRepo = authRepo;
  }

  /**
   * Grant a permission to a user (delete-then-insert for idempotency).
   * Replaces any existing permission for the same user+resource.
   */
  // TODO: when AuthRepository gains deletePermissionForResource(userId, resource), replace the delete-all-then-reinsert dance here.
  async grant(input: PermissionInput): Promise<Permission> {
    // Fetch all existing permissions for this user
    const existing = await this.authRepo.getPermissionsForUser(input.userId);
    const others = existing.filter(p => p.resource !== input.resource);

    // Delete all, then re-insert the others plus the new one
    await this.authRepo.deletePermissionsForUser(input.userId);
    for (const p of others) {
      await this.authRepo.createPermission({
        userId: p.userId,
        resource: p.resource,
        canViewOnMap: p.canViewOnMap,
        canRead: p.canRead,
        canWrite: p.canWrite,
        grantedAt: p.grantedAt,
        grantedBy: p.grantedBy ?? null,
      });
    }

    await this.authRepo.createPermission({
      userId: input.userId,
      resource: input.resource,
      canViewOnMap: input.canViewOnMap ?? false,
      canRead: input.canRead,
      canWrite: input.canWrite,
      grantedBy: input.grantedBy ?? null,
    });

    const permission = await this.findByUserAndResource(input.userId, input.resource);
    if (!permission) {
      throw new Error('Failed to grant permission');
    }
    return permission;
  }

  /**
   * Revoke all permissions for a user
   */
  async revokeAll(userId: number): Promise<void> {
    await this.authRepo.deletePermissionsForUser(userId);
  }

  /**
   * Check if a user has a specific permission
   */
  async check(userId: number, resource: ResourceType, action: PermissionAction): Promise<boolean> {
    const perms = await this.authRepo.getPermissionsForUser(userId);
    const perm = perms.find(p => p.resource === resource);
    if (!perm) return false;
    if (action === 'viewOnMap') return Boolean(perm.canViewOnMap);
    if (action === 'read') return Boolean(perm.canRead);
    return Boolean(perm.canWrite);
  }

  /**
   * Get all permissions for a user as an array
   */
  async getUserPermissions(userId: number): Promise<Permission[]> {
    const rows = await this.authRepo.getPermissionsForUser(userId);
    return rows
      .map(row => this.mapRow(row))
      .sort((a, b) => a.resource.localeCompare(b.resource));
  }

  /**
   * Get permissions as a PermissionSet (keyed by resource)
   */
  async getUserPermissionSet(userId: number): Promise<PermissionSet> {
    const permissions = await this.getUserPermissions(userId);
    const set: PermissionSet = {};
    permissions.forEach(perm => {
      set[perm.resource] = {
        viewOnMap: perm.canViewOnMap,
        read: perm.canRead,
        write: perm.canWrite
      };
    });
    return set;
  }

  /**
   * Find a single permission by user + resource
   */
  async findByUserAndResource(userId: number, resource: ResourceType): Promise<Permission | null> {
    const perms = await this.authRepo.getPermissionsForUser(userId);
    const row = perms.find(p => p.resource === resource);
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Grant the default permission set for a new user
   */
  async grantDefaultPermissions(userId: number, isAdmin: boolean = false, grantedBy?: number): Promise<void> {
    const permissionSet = isAdmin ? ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS;
    for (const [resource, perms] of Object.entries(permissionSet)) {
      await this.grant({
        userId,
        resource: resource as ResourceType,
        canViewOnMap: perms.viewOnMap ?? false,
        canRead: perms.read,
        canWrite: perms.write,
        grantedBy
      });
    }
  }

  /**
   * Update multiple permissions for a user atomically
   */
  async updateUserPermissions(userId: number, permissionSet: PermissionSet, grantedBy?: number): Promise<void> {
    for (const [resource, perms] of Object.entries(permissionSet)) {
      await this.grant({
        userId,
        resource: resource as ResourceType,
        canViewOnMap: perms.viewOnMap ?? false,
        canRead: perms.read,
        canWrite: perms.write,
        grantedBy
      });
    }
  }

  private mapRow(row: any): Permission {
    return {
      id: row.id,
      userId: row.userId,
      resource: row.resource as ResourceType,
      canViewOnMap: Boolean(row.canViewOnMap),
      canRead: Boolean(row.canRead),
      canWrite: Boolean(row.canWrite),
      grantedAt: row.grantedAt,
      grantedBy: row.grantedBy || null
    };
  }
}
