/**
 * Embed Profile Repository Tests
 *
 * Tests for the EmbedProfileRepository CRUD operations.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EmbedProfileRepository } from './embedProfiles.js';
import type { EmbedProfileInput } from './embedProfiles.js';
import * as schema from '../schema/index.js';

describe('EmbedProfileRepository', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: EmbedProfileRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create the embed_profiles table
    db.exec(`
      CREATE TABLE IF NOT EXISTS embed_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        channels TEXT NOT NULL DEFAULT '[]',
        tileset TEXT NOT NULL DEFAULT 'osm',
        defaultLat REAL NOT NULL DEFAULT 0,
        defaultLng REAL NOT NULL DEFAULT 0,
        defaultZoom INTEGER NOT NULL DEFAULT 10,
        showTooltips INTEGER NOT NULL DEFAULT 1,
        showPopups INTEGER NOT NULL DEFAULT 1,
        showLegend INTEGER NOT NULL DEFAULT 1,
        showPaths INTEGER NOT NULL DEFAULT 0,
        showNeighborInfo INTEGER NOT NULL DEFAULT 0,
        showMqttNodes INTEGER NOT NULL DEFAULT 1,
        pollIntervalSeconds INTEGER NOT NULL DEFAULT 30,
        allowedOrigins TEXT NOT NULL DEFAULT '[]',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    drizzleDb = drizzle(db, { schema });
    repo = new EmbedProfileRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  it('should export EmbedProfileRepository class', () => {
    expect(EmbedProfileRepository).toBeDefined();
    expect(repo).toBeInstanceOf(EmbedProfileRepository);
  });

  it('should return empty array when no profiles exist', async () => {
    const profiles = await repo.getAllAsync();
    expect(profiles).toEqual([]);
  });

  it('should create and retrieve a profile', async () => {
    const input: EmbedProfileInput = {
      id: 'test-id-1',
      name: 'Test Profile',
      enabled: true,
      channels: [0, 1],
      tileset: 'osm',
      defaultLat: 37.7749,
      defaultLng: -122.4194,
      defaultZoom: 12,
      showTooltips: true,
      showPopups: true,
      showLegend: true,
      showPaths: false,
      showNeighborInfo: false,
      showMqttNodes: true,
      pollIntervalSeconds: 30,
      allowedOrigins: ['https://example.com'],
    };

    const created = await repo.createAsync(input);
    expect(created.id).toBe('test-id-1');
    expect(created.name).toBe('Test Profile');
    expect(created.enabled).toBe(true);
    expect(created.channels).toEqual([0, 1]);
    expect(created.allowedOrigins).toEqual(['https://example.com']);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBeGreaterThan(0);

    const fetched = await repo.getByIdAsync('test-id-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('Test Profile');
    expect(fetched!.channels).toEqual([0, 1]);
    expect(fetched!.allowedOrigins).toEqual(['https://example.com']);
  });

  it('should return null for non-existent profile', async () => {
    const result = await repo.getByIdAsync('nonexistent');
    expect(result).toBeNull();
  });

  it('should update a profile', async () => {
    const input: EmbedProfileInput = {
      id: 'test-id-2',
      name: 'Original Name',
      enabled: true,
      channels: [0],
      tileset: 'osm',
      defaultLat: 0,
      defaultLng: 0,
      defaultZoom: 10,
      showTooltips: true,
      showPopups: true,
      showLegend: true,
      showPaths: false,
      showNeighborInfo: false,
      showMqttNodes: true,
      pollIntervalSeconds: 30,
      allowedOrigins: [],
    };

    await repo.createAsync(input);

    const updated = await repo.updateAsync('test-id-2', {
      name: 'Updated Name',
      channels: [0, 1, 2],
      showPaths: true,
    });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Updated Name');
    expect(updated!.channels).toEqual([0, 1, 2]);
    expect(updated!.showPaths).toBe(true);
    // Unchanged fields should remain
    expect(updated!.enabled).toBe(true);
    expect(updated!.tileset).toBe('osm');
  });

  it('should return null when updating non-existent profile', async () => {
    const result = await repo.updateAsync('nonexistent', { name: 'New Name' });
    expect(result).toBeNull();
  });

  it('should delete a profile', async () => {
    const input: EmbedProfileInput = {
      id: 'test-id-3',
      name: 'To Delete',
      enabled: true,
      channels: [],
      tileset: 'osm',
      defaultLat: 0,
      defaultLng: 0,
      defaultZoom: 10,
      showTooltips: true,
      showPopups: true,
      showLegend: true,
      showPaths: false,
      showNeighborInfo: false,
      showMqttNodes: true,
      pollIntervalSeconds: 30,
      allowedOrigins: [],
    };

    await repo.createAsync(input);
    const deleted = await repo.deleteAsync('test-id-3');
    expect(deleted).toBe(true);

    const fetched = await repo.getByIdAsync('test-id-3');
    expect(fetched).toBeNull();
  });

  it('should return false when deleting non-existent profile', async () => {
    const result = await repo.deleteAsync('nonexistent');
    expect(result).toBe(false);
  });

  it('should deserialize boolean fields correctly from SQLite integers', async () => {
    // Insert directly with SQLite integers for booleans
    db.exec(`
      INSERT INTO embed_profiles (id, name, enabled, channels, tileset, defaultLat, defaultLng, defaultZoom,
        showTooltips, showPopups, showLegend, showPaths, showNeighborInfo, showMqttNodes,
        pollIntervalSeconds, allowedOrigins, createdAt, updatedAt)
      VALUES ('bool-test', 'Bool Test', 0, '[1,2]', 'osm', 0, 0, 10,
        0, 1, 1, 0, 0, 1, 30, '["http://localhost"]', 1000, 2000)
    `);

    const profile = await repo.getByIdAsync('bool-test');
    expect(profile).not.toBeNull();
    expect(profile!.enabled).toBe(false);
    expect(profile!.showTooltips).toBe(false);
    expect(profile!.showPopups).toBe(true);
    expect(profile!.channels).toEqual([1, 2]);
    expect(profile!.allowedOrigins).toEqual(['http://localhost']);
  });
});
