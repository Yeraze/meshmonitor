import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './044_add_nodes_private_permission.js';

describe('Migration 043: nodes_private permission', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Setup initial schema for permissions
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        granted_at INTEGER NOT NULL,
        granted_by INTEGER,
        CHECK (resource IN (
          'dashboard', 'nodes', 'messages', 'settings',
          'configuration', 'info', 'automation'
        ))
      )
    `);
    
    // Setup users table for foreign key
    db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)`);
    db.prepare('INSERT INTO users (id) VALUES (?)').run(1);
  });

  afterEach(() => {
    db.close();
  });

  it('should successfully add nodes_private to the resource CHECK constraint', () => {
    // Initial state: nodes_private should be invalid
    expect(() => {
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, granted_at)
        VALUES (?, ?, ?, ?)
      `).run(1, 'nodes_private', 1, Date.now());
    }).toThrow(/CHECK constraint failed/);

    // Run migration
    migration.up(db);

    // Now nodes_private should be valid
    expect(() => {
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, granted_at)
        VALUES (?, ?, ?, ?)
      `).run(1, 'nodes_private', 1, Date.now());
    }).not.toThrow();
  });

  it('should be reversible (down)', () => {
    migration.up(db);
    migration.down(db);

    // After down, it should be invalid again
    expect(() => {
      db.prepare(`
        INSERT INTO permissions (user_id, resource, can_read, granted_at)
        VALUES (?, ?, ?, ?)
      `).run(1, 'nodes_private', 1, Date.now());
    }).toThrow(/CHECK constraint failed/);
  });
});
