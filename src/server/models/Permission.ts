/**
 * Permission Model
 *
 * Handles permission data operations including granting, revoking, and checking permissions
 */

import Database from 'better-sqlite3';
import {
  Permission,
  PermissionInput,
  PermissionSet,
  ResourceType,
  PermissionAction,
  DEFAULT_USER_PERMISSIONS,
  ADMIN_PERMISSIONS
} from '../../types/permission.js';

export class PermissionModel {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Grant a permission to a user
   */
  grant(input: PermissionInput): Permission {
    const stmt = this.db.prepare(`
      INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, resource) DO UPDATE SET
        can_view_on_map = excluded.can_view_on_map,
        can_read = excluded.can_read,
        can_write = excluded.can_write,
        granted_at = excluded.granted_at,
        granted_by = excluded.granted_by
    `);

    stmt.run(
      input.userId,
      input.resource,
      input.canViewOnMap ? 1 : 0,
      input.canRead ? 1 : 0,
      input.canWrite ? 1 : 0,
      Date.now(),
      input.grantedBy || null
    );

    const permission = this.findByUserAndResource(input.userId, input.resource);
    if (!permission) {
      throw new Error('Failed to grant permission');
    }

    return permission;
  }

  /**
   * Revoke a permission from a user
   */
  revoke(userId: number, resource: ResourceType): void {
    const stmt = this.db.prepare(`
      DELETE FROM permissions
      WHERE user_id = ? AND resource = ?
    `);

    stmt.run(userId, resource);
  }

  /**
   * Revoke all permissions for a user
   */
  revokeAll(userId: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM permissions
      WHERE user_id = ?
    `);

    stmt.run(userId);
  }

  /**
   * Check if a user has a specific permission
   */
  check(userId: number, resource: ResourceType, action: PermissionAction): boolean {
    const stmt = this.db.prepare(`
      SELECT can_view_on_map as canViewOnMap, can_read as canRead, can_write as canWrite
      FROM permissions
      WHERE user_id = ? AND resource = ?
    `);

    const row = stmt.get(userId, resource) as any;
    if (!row) return false;

    if (action === 'viewOnMap') {
      return Boolean(row.canViewOnMap);
    } else if (action === 'read') {
      return Boolean(row.canRead);
    } else {
      return Boolean(row.canWrite);
    }
  }

  /**
   * Get all permissions for a user
   */
  getUserPermissions(userId: number): Permission[] {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, resource, can_view_on_map as canViewOnMap,
        can_read as canRead, can_write as canWrite,
        granted_at as grantedAt, granted_by as grantedBy
      FROM permissions
      WHERE user_id = ?
      ORDER BY resource
    `);

    const rows = stmt.all(userId) as any[];
    return rows.map(row => this.mapRowToPermission(row));
  }

  /**
   * Get permissions as a PermissionSet
   */
  getUserPermissionSet(userId: number): PermissionSet {
    const permissions = this.getUserPermissions(userId);
    const permissionSet: PermissionSet = {};

    permissions.forEach(perm => {
      permissionSet[perm.resource] = {
        viewOnMap: perm.canViewOnMap,
        read: perm.canRead,
        write: perm.canWrite
      };
    });

    return permissionSet;
  }

  /**
   * Find permission by user and resource
   */
  findByUserAndResource(userId: number, resource: ResourceType): Permission | null {
    const stmt = this.db.prepare(`
      SELECT
        id, user_id as userId, resource, can_view_on_map as canViewOnMap,
        can_read as canRead, can_write as canWrite,
        granted_at as grantedAt, granted_by as grantedBy
      FROM permissions
      WHERE user_id = ? AND resource = ?
    `);

    const row = stmt.get(userId, resource) as any;
    if (!row) return null;

    return this.mapRowToPermission(row);
  }

  /**
   * Grant default permissions to a new user
   */
  grantDefaultPermissions(userId: number, isAdmin: boolean = false, grantedBy?: number): void {
    const permissionSet = isAdmin ? ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS;

    Object.entries(permissionSet).forEach(([resource, perms]) => {
      this.grant({
        userId,
        resource: resource as ResourceType,
        canViewOnMap: perms.viewOnMap ?? false,
        canRead: perms.read,
        canWrite: perms.write,
        grantedBy
      });
    });
  }

  /**
   * Update multiple permissions for a user
   */
  updateUserPermissions(userId: number, permissionSet: PermissionSet, grantedBy?: number): void {
    // Use a transaction for atomic updates
    const transaction = this.db.transaction(() => {
      Object.entries(permissionSet).forEach(([resource, perms]) => {
        this.grant({
          userId,
          resource: resource as ResourceType,
          canViewOnMap: perms.viewOnMap ?? false,
          canRead: perms.read,
          canWrite: perms.write,
          grantedBy
        });
      });
    });

    transaction();
  }

  /**
   * Get all users with a specific permission
   */
  getUsersWithPermission(resource: ResourceType, action: PermissionAction): number[] {
    // Validate action to prevent SQL injection
    if (action !== 'read' && action !== 'write') {
      throw new Error(`Invalid action: ${action}`);
    }

    const column = action === 'read' ? 'can_read' : 'can_write';

    const stmt = this.db.prepare(`
      SELECT DISTINCT user_id as userId
      FROM permissions
      WHERE resource = ? AND ${column} = 1
    `);

    const rows = stmt.all(resource) as any[];
    return rows.map(row => row.userId);
  }

  /**
   * Map database row to Permission object
   */
  private mapRowToPermission(row: any): Permission {
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
