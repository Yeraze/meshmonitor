import BetterSqlite3Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { calculateDistance } from '../utils/distance.js';
import { isNodeComplete } from '../utils/nodeHelpers.js';
import { logger } from '../utils/logger.js';
import { getEnvironmentConfig } from '../server/config/environment.js';

import { registry } from '../db/migrations.js';
import { validateThemeDefinition as validateTheme } from '../utils/themeValidation.js';
import { isSourceyResource } from '../types/permission.js';
// Drizzle ORM imports for dual-database support
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import * as drizzleSchema from '../db/schema/index.js';
import { createPostgresDriver } from '../db/drivers/postgres.js';
import { createMySQLDriver } from '../db/drivers/mysql.js';
import { getDatabaseConfig, Database } from '../db/index.js';
import type { Pool as PgPool } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import {
  SettingsRepository,
  ChannelsRepository,
  NodesRepository,
  MessagesRepository,
  TelemetryRepository,
  AuthRepository,
  TraceroutesRepository,
  NeighborsRepository,
  NotificationsRepository,
  MiscRepository,
  ChannelDatabaseRepository,
  IgnoredNodesRepository,
  EmbedProfileRepository,
  SourcesRepository,
} from '../db/repositories/index.js';
import type { DatabaseType, DbPacketLog as DbTypesPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../db/types.js';

// Configuration constants for traceroute history
const TRACEROUTE_HISTORY_LIMIT = 50;
const PENDING_TRACEROUTE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface DbNode {
  nodeNum: number;
  nodeId: string;
  longName: string;
  shortName: string;
  hwModel: number;
  role?: number;
  hopsAway?: number;
  lastMessageHops?: number; // Hops from most recent packet (hopStart - hopLimit)
  viaMqtt?: boolean;
  macaddr?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  batteryLevel?: number;
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  lastHeard?: number;
  snr?: number;
  rssi?: number;
  lastTracerouteRequest?: number;
  firmwareVersion?: string;
  channel?: number;
  isFavorite?: boolean;
  favoriteLocked?: boolean;
  isIgnored?: boolean;
  mobile?: number; // 0 = not mobile, 1 = mobile (moved >100m)
  rebootCount?: number;
  publicKey?: string;
  hasPKC?: boolean;
  lastPKIPacket?: number;
  keyIsLowEntropy?: boolean;
  duplicateKeyDetected?: boolean;
  keyMismatchDetected?: boolean;
  lastMeshReceivedKey?: string | null;
  keySecurityIssueDetails?: string;
  welcomedAt?: number;
  // Position precision tracking (Migration 020)
  positionChannel?: number; // Which channel the position came from
  positionPrecisionBits?: number; // Position precision (0-32 bits, higher = more precise)
  positionGpsAccuracy?: number; // GPS accuracy in meters
  positionHdop?: number; // Horizontal Dilution of Precision
  positionTimestamp?: number; // When this position was received (for upgrade/downgrade logic)
  // Position override (Migration 040, updated in Migration 047 to boolean)
  positionOverrideEnabled?: boolean; // false = disabled, true = enabled
  latitudeOverride?: number; // Override latitude
  longitudeOverride?: number; // Override longitude
  altitudeOverride?: number; // Override altitude
  positionOverrideIsPrivate?: boolean; // Override privacy (false = public, true = private)
  // Remote admin discovery (Migration 055)
  hasRemoteAdmin?: boolean; // Has remote admin access
  lastRemoteAdminCheck?: number; // Unix timestamp ms of last check
  remoteAdminMetadata?: string; // JSON string of metadata response
  sourceId?: string; // Composite key component (Phase 3)
  createdAt: number;
  updatedAt: number;
}

export interface DbMessage {
  id: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number;
  requestId?: number;
  timestamp: number;
  rxTime?: number;
  hopStart?: number;
  hopLimit?: number;
  relayNode?: number;
  replyId?: number;
  emoji?: number;
  viaMqtt?: boolean;
  rxSnr?: number;
  rxRssi?: number;
  createdAt: number;
  ackFailed?: boolean;
  deliveryState?: string;
  wantAck?: boolean;
  routingErrorReceived?: boolean;
  ackFromNode?: number;
  decryptedBy?: 'node' | 'server' | null;
}

export interface DbChannel {
  id: number;
  name: string;
  psk?: string;
  role?: number; // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision?: number; // Location precision bits (0-32)
  createdAt: number;
  updatedAt: number;
}

export interface DbTelemetry {
  id?: number;
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  unit?: string;
  createdAt: number;
  packetTimestamp?: number; // Original timestamp from the packet (may be inaccurate if node has wrong time)
  packetId?: number; // Meshtastic meshPacket.id for deduplication
  // Position precision tracking metadata (Migration 020)
  channel?: number; // Which channel this telemetry came from
  precisionBits?: number; // Position precision bits (for latitude/longitude telemetry)
  gpsAccuracy?: number; // GPS accuracy in meters (for position telemetry)
}

export interface DbTraceroute {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;
  routeBack: string;
  snrTowards: string;
  snrBack: string;
  timestamp: number;
  createdAt: number;
}

export interface DbRouteSegment {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  distanceKm: number;
  isRecordHolder: boolean;
  timestamp: number;
  createdAt: number;
}

export interface DbNeighborInfo {
  id?: number;
  nodeNum: number;
  neighborNodeNum: number;
  snr?: number;
  lastRxTime?: number;
  timestamp: number;
  createdAt: number;
}

export interface DbPushSubscription {
  id?: number;
  userId?: number;
  /** TODO Phase B: required — source this subscription is scoped to */
  sourceId?: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

// Re-export DbPacketLog from canonical db/types location
export type DbPacketLog = DbTypesPacketLog;
export type { DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode };

export interface DbCustomTheme {
  id?: number;
  name: string;
  slug: string;
  definition: string; // JSON string of theme colors
  is_builtin: number; // SQLite uses 0/1 for boolean
  created_by?: number;
  created_at: number;
  updated_at: number;
}

export interface ThemeDefinition {
  base: string;
  mantle: string;
  crust: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  lavender: string;
  blue: string;
  sapphire: string;
  sky: string;
  teal: string;
  green: string;
  yellow: string;
  peach: string;
  maroon: string;
  red: string;
  mauve: string;
  pink: string;
  flamingo: string;
  rosewater: string;
  // Optional chat bubble color overrides
  chatBubbleSentBg?: string;
  chatBubbleSentText?: string;
  chatBubbleReceivedBg?: string;
  chatBubbleReceivedText?: string;
}

class DatabaseService {
  public db: BetterSqlite3Database.Database;
  private isInitialized = false;


  // Cache for telemetry types per node (expensive GROUP BY query)
  private telemetryTypesCache: Map<string, string[]> | null = null;
  private telemetryTypesCacheTime: number = 0;
  private static readonly TELEMETRY_TYPES_CACHE_TTL_MS = 60000; // 60 seconds

  // Drizzle ORM database and repositories (for async operations and PostgreSQL/MySQL support)
  private drizzleDatabase: Database | null = null;
  public drizzleDbType: DatabaseType = 'sqlite';
  private postgresPool: import('pg').Pool | null = null;
  private mysqlPool: import('mysql2/promise').Pool | null = null;

  // Promise that resolves when async initialization (PostgreSQL/MySQL) is complete
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private isReady = false;

  // In-memory caches for PostgreSQL/MySQL (sync method compatibility)
  // These caches allow sync methods like getSetting() and getNode() to work
  // with async databases by caching data loaded at startup
  private settingsCache: Map<string, string> = new Map();
  private nodesCache: Map<string, DbNode> = new Map();

  /**
   * Phase 3B: Build composite cache key from nodeNum + sourceId.
   * The nodes table PK is (nodeNum, sourceId) post-migration 029.
   */
  private cacheKey(nodeNum: number, sourceId: string): string {
    return `${nodeNum}:${sourceId}`;
  }

  /**
   * Phase 3B: Iterate cache, optionally filtered by sourceId.
   */
  private *iterateCache(sourceId?: string): IterableIterator<DbNode> {
    for (const node of this.nodesCache.values()) {
      if (sourceId && node.sourceId !== sourceId) continue;
      yield node;
    }
  }
  private channelsCache: Map<number, DbChannel> = new Map();
  private _traceroutesCache: DbTraceroute[] = [];
  private _traceroutesByNodesCache: Map<string, DbTraceroute[]> = new Map();
  private cacheInitialized = false;

  // Track nodes that have already had their "new node" notification sent
  // to avoid duplicate notifications when node data is updated incrementally
  private newNodeNotifiedSet: Set<number> = new Set();

  // Ghost node suppression: nodeNum → expiresAt timestamp
  // Prevents resurrection of ghost nodes after reboot detection
  private suppressedGhostNodes: Map<number, number> = new Map();

  /**
   * Get the Drizzle database instance for direct access if needed
   */
  getDrizzleDb(): Database | null {
    return this.drizzleDatabase;
  }

  /**
   * Get the PostgreSQL pool for direct queries (returns null for non-PostgreSQL)
   */
  getPostgresPool(): import('pg').Pool | null {
    return this.postgresPool;
  }

  /**
   * Get the MySQL pool for direct queries (returns null for non-MySQL)
   */
  getMySQLPool(): import('mysql2/promise').Pool | null {
    return this.mysqlPool;
  }

  /**
   * Get the current database type (sqlite, postgres, or mysql)
   */
  getDatabaseType(): DatabaseType {
    return this.drizzleDbType;
  }

  /**
   * Get database version string
   */
  async getDatabaseVersion(): Promise<string> {
    try {
      if (this.drizzleDbType === 'postgres' && this.postgresPool) {
        // eslint-disable-next-line no-restricted-syntax -- system diagnostic query, not domain data
        const result = await this.postgresPool.query('SELECT version()');
        const fullVersion = result.rows?.[0]?.version || 'Unknown';
        // Extract just the version number from "PostgreSQL 16.2 (Debian 16.2-1.pgdg120+2) on x86_64-pc-linux-gnu..."
        const match = fullVersion.match(/PostgreSQL\s+([\d.]+)/);
        return match ? match[1] : fullVersion.split(' ').slice(0, 2).join(' ');
      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        // eslint-disable-next-line no-restricted-syntax -- system diagnostic query, not domain data
        const [rows] = await this.mysqlPool.query('SELECT version() as version');
        return (rows as any[])?.[0]?.version || 'Unknown';
      } else if (this.db) {
        // eslint-disable-next-line no-restricted-syntax -- bootstrap: SQLite builtin probe (Task 2.9)
        const result = this.db.prepare('SELECT sqlite_version() as version').get() as { version: string } | undefined;
        return result?.version || 'Unknown';
      }
      return 'Unknown';
    } catch (error) {
      logger.error('[DatabaseService] Failed to get database version:', error);
      return 'Unknown';
    }
  }

  /**
   * Wait for the database to be fully initialized
   * For SQLite, this resolves immediately
   * For PostgreSQL/MySQL, this waits for async schema creation and repo initialization
   */
  async waitForReady(): Promise<void> {
    if (this.isReady) {
      return;
    }
    return this.readyPromise;
  }

  /**
   * Check if the database is ready (sync check)
   */
  isDatabaseReady(): boolean {
    return this.isReady;
  }

  // Repositories - will be initialized after Drizzle connection
  public settingsRepo: SettingsRepository | null = null;
  public channelsRepo: ChannelsRepository | null = null;
  public nodesRepo: NodesRepository | null = null;
  public messagesRepo: MessagesRepository | null = null;
  public telemetryRepo: TelemetryRepository | null = null;
  public authRepo: AuthRepository | null = null;
  public traceroutesRepo: TraceroutesRepository | null = null;
  public neighborsRepo: NeighborsRepository | null = null;
  public notificationsRepo: NotificationsRepository | null = null;
  public miscRepo: MiscRepository | null = null;
  public channelDatabaseRepo: ChannelDatabaseRepository | null = null;
  public ignoredNodesRepo: IgnoredNodesRepository | null = null;
  public embedProfileRepo: EmbedProfileRepository | null = null;
  public sourcesRepo: SourcesRepository | null = null;

  /**
   * Typed repository accessors — throw if database not initialized.
   * Prefer these over the nullable public fields.
   */
  get nodes(): NodesRepository {
    if (!this.nodesRepo) throw new Error('Database not initialized');
    return this.nodesRepo;
  }

  get messages(): MessagesRepository {
    if (!this.messagesRepo) throw new Error('Database not initialized');
    return this.messagesRepo;
  }

  get channels(): ChannelsRepository {
    if (!this.channelsRepo) throw new Error('Database not initialized');
    return this.channelsRepo;
  }

  get settings(): SettingsRepository {
    if (!this.settingsRepo) throw new Error('Database not initialized');
    return this.settingsRepo;
  }

  get telemetry(): TelemetryRepository {
    if (!this.telemetryRepo) throw new Error('Database not initialized');
    return this.telemetryRepo;
  }

  get traceroutes(): TraceroutesRepository {
    if (!this.traceroutesRepo) throw new Error('Database not initialized');
    return this.traceroutesRepo;
  }

  get neighbors(): NeighborsRepository {
    if (!this.neighborsRepo) throw new Error('Database not initialized');
    return this.neighborsRepo;
  }

  get auth(): AuthRepository {
    if (!this.authRepo) throw new Error('Database not initialized');
    return this.authRepo;
  }

  get notifications(): NotificationsRepository {
    if (!this.notificationsRepo) throw new Error('Database not initialized');
    return this.notificationsRepo;
  }

  get misc(): MiscRepository {
    if (!this.miscRepo) throw new Error('Database not initialized');
    return this.miscRepo;
  }

  get channelDatabase(): ChannelDatabaseRepository {
    if (!this.channelDatabaseRepo) throw new Error('Database not initialized');
    return this.channelDatabaseRepo;
  }

  get ignoredNodes(): IgnoredNodesRepository {
    if (!this.ignoredNodesRepo) throw new Error('Database not initialized');
    return this.ignoredNodesRepo;
  }

  get embedProfiles(): EmbedProfileRepository {
    if (!this.embedProfileRepo) throw new Error('Database not initialized');
    return this.embedProfileRepo;
  }

  get sources(): SourcesRepository {
    if (!this.sourcesRepo) throw new Error('Database not initialized');
    return this.sourcesRepo;
  }

  constructor() {
    logger.debug('🔧🔧🔧 DatabaseService constructor called');

    // Initialize the ready promise - will be resolved when async initialization is complete
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Check database type FIRST before any initialization
    const dbConfig = getDatabaseConfig();
    const dbPath = getEnvironmentConfig().databasePath;

    // For PostgreSQL or MySQL, skip SQLite initialization entirely
    if (dbConfig.type === 'postgres' || dbConfig.type === 'mysql') {
      logger.info(`📦 Using ${dbConfig.type === 'postgres' ? 'PostgreSQL' : 'MySQL'} database - skipping SQLite initialization`);

      // Set drizzleDbType IMMEDIATELY so sync methods know we're using PostgreSQL/MySQL
      // This is critical for methods like getSetting that check this before the async init completes
      this.drizzleDbType = dbConfig.type;

      // Create a dummy SQLite db object that will throw helpful errors if used
      // This ensures code that accidentally uses this.db will fail fast
      this.db = new Proxy({} as BetterSqlite3Database.Database, {
        get: (_target, prop) => {
          if (prop === 'exec' || prop === 'prepare' || prop === 'pragma') {
            return () => {
              throw new Error(`SQLite method '${String(prop)}' called but using ${dbConfig.type} database. Use Drizzle repositories instead.`);
            };
          }
          return undefined;
        },
      });

      // All user operations now route through AuthRepository (async)

      // Initialize Drizzle repositories (async) - this will create the schema
      // The readyPromise will be resolved when this completes
      this.initializeDrizzleRepositoriesForPostgres(dbPath);

      // Skip SQLite-specific initialization
      this.isInitialized = true;
      return;
    }

    // SQLite initialization (existing code)
    logger.debug('Initializing SQLite database at:', dbPath);

    // Validate database directory access
    const dbDir = path.dirname(dbPath);
    try {
      // Ensure the directory exists
      if (!fs.existsSync(dbDir)) {
        logger.debug(`Creating database directory: ${dbDir}`);
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Verify directory is writable
      fs.accessSync(dbDir, fs.constants.W_OK | fs.constants.R_OK);

      // If database file exists, verify it's readable and writable
      if (fs.existsSync(dbPath)) {
        fs.accessSync(dbPath, fs.constants.W_OK | fs.constants.R_OK);
      }
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      logger.error('❌ DATABASE STARTUP ERROR ❌');
      logger.error('═══════════════════════════════════════════════════════════');
      logger.error('Failed to access database directory or file');
      logger.error('');
      logger.error(`Database path: ${dbPath}`);
      logger.error(`Database directory: ${dbDir}`);
      logger.error('');

      if (err.code === 'EACCES' || err.code === 'EPERM') {
        logger.error('PERMISSION DENIED - The database directory or file is not writable.');
        logger.error('');
        logger.error('For Docker deployments:');
        logger.error('  1. Check that your volume mount exists and is writable');
        logger.error('  2. Verify permissions on the host directory:');
        logger.error(`     chmod -R 755 /path/to/your/data/directory`);
        logger.error('  3. Example volume mount in docker-compose.yml:');
        logger.error('     volumes:');
        logger.error('       - ./meshmonitor-data:/data');
        logger.error('');
        logger.error('For bare metal deployments:');
        logger.error('  1. Ensure the data directory exists and is writable:');
        logger.error(`     mkdir -p ${dbDir}`);
        logger.error(`     chmod 755 ${dbDir}`);
      } else if (err.code === 'ENOENT') {
        logger.error('DIRECTORY NOT FOUND - Failed to create database directory.');
        logger.error('');
        logger.error('This usually means the parent directory does not exist or is not writable.');
        logger.error(`Check that the parent directory exists: ${path.dirname(dbDir)}`);
      } else {
        logger.error(`Error: ${err.message}`);
        logger.error(`Error code: ${err.code || 'unknown'}`);
      }

      logger.error('═══════════════════════════════════════════════════════════');
      throw new Error(`Database directory access check failed: ${err.message}`);
    }

    // Now attempt to open the database with better error handling
    this.db = this.openSqliteDatabase(dbPath, dbDir);

    // All user operations now route through AuthRepository (async)

    // Initialize Drizzle ORM and repositories
    // This uses the same database file but through Drizzle for async operations
    this.initializeDrizzleRepositories(dbPath);

    this.initialize();
    // Channel 0 will be created automatically when the device syncs its configuration
    // Always ensure broadcast node exists for channel messages
    this.ensureBroadcastNode();
    // Ensure admin user exists for authentication
    this.ensureAdminUser();

    // SQLite is ready immediately after sync initialization
    this.isReady = true;
    this.readyResolve();
  }

  /**
   * Initialize Drizzle ORM and all repositories
   * This provides async database operations and supports both SQLite and PostgreSQL
   */
  private initializeDrizzleRepositories(dbPath: string): void {
    // Note: We call this synchronously but handle async PostgreSQL init via Promise
    this.initializeDrizzleRepositoriesAsync(dbPath).catch((error) => {
      logger.warn('[DatabaseService] Failed to initialize Drizzle repositories:', error);
      logger.warn('[DatabaseService] Async repository methods will not be available');
    });
  }

  /**
   * Initialize Drizzle ORM for PostgreSQL/MySQL with proper ready promise handling
   * This is used when NOT using SQLite - it sets up the async repos and resolves/rejects the readyPromise
   */
  private initializeDrizzleRepositoriesForPostgres(dbPath: string): void {
    this.initializeDrizzleRepositoriesAsync(dbPath)
      .then(() => {
        logger.info('[DatabaseService] PostgreSQL/MySQL initialization complete - database is ready');
        this.isReady = true;
        this.readyResolve();
        // Ensure admin and anonymous users exist (same as SQLite path)
        this.ensureAdminUser();
      })
      .catch((error) => {
        logger.error('[DatabaseService] Failed to initialize PostgreSQL/MySQL:', error);
        this.readyReject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * Async initialization of Drizzle ORM repositories
   */
  private async initializeDrizzleRepositoriesAsync(_dbPath: string): Promise<void> {
    try {
      logger.debug('[DatabaseService] Initializing Drizzle ORM repositories');

      // Check database configuration to determine which driver to use
      const dbConfig = getDatabaseConfig();
      let drizzleDb: Database;

      if (dbConfig.type === 'postgres' && dbConfig.postgresUrl) {
        // Use PostgreSQL driver
        logger.info('[DatabaseService] Using PostgreSQL driver for Drizzle repositories');
        const { db, pool } = await createPostgresDriver({
          connectionString: dbConfig.postgresUrl,
          maxConnections: dbConfig.postgresMaxConnections || 10,
          ssl: dbConfig.postgresSsl || false,
        });
        drizzleDb = db;
        this.postgresPool = pool;
        this.drizzleDbType = 'postgres';

        // Create PostgreSQL schema if tables don't exist
        await this.createPostgresSchema(pool);
      } else if (dbConfig.type === 'mysql' && dbConfig.mysqlUrl) {
        // Use MySQL driver
        logger.info('[DatabaseService] Using MySQL driver for Drizzle repositories');
        const { db, pool } = await createMySQLDriver({
          connectionString: dbConfig.mysqlUrl,
          maxConnections: dbConfig.mysqlMaxConnections || 10,
        });
        drizzleDb = db;
        this.mysqlPool = pool;
        this.drizzleDbType = 'mysql';

        // Create MySQL schema if tables don't exist
        await this.createMySQLSchema(pool);
      } else {
        // Use SQLite driver (default).
        // Bind Drizzle to the existing better-sqlite3 connection (this.db) so
        // sync repository methods and raw sync paths observe schema changes
        // (CREATE TABLE, migrations) immediately on the same connection — and
        // so this branch runs synchronously (no awaits before repo init below).
        drizzleDb = drizzleSqlite(this.db, { schema: drizzleSchema });
        this.drizzleDbType = 'sqlite';
      }

      this.drizzleDatabase = drizzleDb;

      // Initialize all repositories
      this.settingsRepo = new SettingsRepository(drizzleDb, this.drizzleDbType);
      this.channelsRepo = new ChannelsRepository(drizzleDb, this.drizzleDbType);
      this.nodesRepo = new NodesRepository(drizzleDb, this.drizzleDbType);
      this.messagesRepo = new MessagesRepository(drizzleDb, this.drizzleDbType);
      this.telemetryRepo = new TelemetryRepository(drizzleDb, this.drizzleDbType);
      // Auth repo for all backends - Migration 012 aligned SQLite schema with Drizzle definitions
      this.authRepo = new AuthRepository(drizzleDb, this.drizzleDbType);
      this.traceroutesRepo = new TraceroutesRepository(drizzleDb, this.drizzleDbType);
      this.neighborsRepo = new NeighborsRepository(drizzleDb, this.drizzleDbType);
      this.notificationsRepo = new NotificationsRepository(drizzleDb, this.drizzleDbType);
      this.miscRepo = new MiscRepository(drizzleDb, this.drizzleDbType);
      this.channelDatabaseRepo = new ChannelDatabaseRepository(drizzleDb, this.drizzleDbType);
      this.ignoredNodesRepo = new IgnoredNodesRepository(drizzleDb, this.drizzleDbType);
      this.embedProfileRepo = new EmbedProfileRepository(drizzleDb, this.drizzleDbType);
      this.sourcesRepo = new SourcesRepository(drizzleDb, this.drizzleDbType);

      logger.info('[DatabaseService] Drizzle repositories initialized successfully');

      // Load caches for PostgreSQL/MySQL to enable sync method compatibility
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        await this.loadCachesFromDatabase();
      }
    } catch (error) {
      // Log but don't fail - repositories are optional during migration period
      logger.warn('[DatabaseService] Failed to initialize Drizzle repositories:', error);
      logger.warn('[DatabaseService] Async repository methods will not be available');
      throw error;
    }
  }

  /**
   * Load settings and nodes caches from database for sync method compatibility
   * This enables getSetting() and getNode() to work with PostgreSQL/MySQL
   */
  private async loadCachesFromDatabase(): Promise<void> {
    try {
      logger.info('[DatabaseService] Loading caches for sync method compatibility...');

      // Load all settings into cache
      if (this.settingsRepo) {
        const settings = await this.settingsRepo.getAllSettings();
        this.settingsCache.clear();
        for (const [key, value] of Object.entries(settings)) {
          this.settingsCache.set(key, value);
        }
        logger.info(`[DatabaseService] Loaded ${this.settingsCache.size} settings into cache`);
      }

      // Load all nodes into cache
      if (this.nodesRepo) {
        const nodes = await this.nodesRepo.getAllNodes();
        this.nodesCache.clear();
        for (const node of nodes) {
          // Convert from repo DbNode to local DbNode (null -> undefined conversion is safe)
          // The types only differ in null vs undefined for optional fields
          const localNode: DbNode = {
            nodeNum: node.nodeNum,
            nodeId: node.nodeId,
            longName: node.longName ?? '',
            shortName: node.shortName ?? '',
            hwModel: node.hwModel ?? 0,
            role: node.role ?? undefined,
            hopsAway: node.hopsAway ?? undefined,
            lastMessageHops: node.lastMessageHops ?? undefined,
            viaMqtt: node.viaMqtt ?? undefined,
            macaddr: node.macaddr ?? undefined,
            latitude: node.latitude ?? undefined,
            longitude: node.longitude ?? undefined,
            altitude: node.altitude ?? undefined,
            batteryLevel: node.batteryLevel ?? undefined,
            voltage: node.voltage ?? undefined,
            channelUtilization: node.channelUtilization ?? undefined,
            airUtilTx: node.airUtilTx ?? undefined,
            lastHeard: node.lastHeard ?? undefined,
            snr: node.snr ?? undefined,
            rssi: node.rssi ?? undefined,
            lastTracerouteRequest: node.lastTracerouteRequest ?? undefined,
            firmwareVersion: node.firmwareVersion ?? undefined,
            channel: node.channel ?? undefined,
            isFavorite: node.isFavorite ?? undefined,
            favoriteLocked: node.favoriteLocked ?? undefined,
            isIgnored: node.isIgnored ?? undefined,
            mobile: node.mobile ?? undefined,
            rebootCount: node.rebootCount ?? undefined,
            publicKey: node.publicKey ?? undefined,
            hasPKC: node.hasPKC ?? undefined,
            lastPKIPacket: node.lastPKIPacket ?? undefined,
            keyIsLowEntropy: node.keyIsLowEntropy ?? undefined,
            duplicateKeyDetected: node.duplicateKeyDetected ?? undefined,
            keyMismatchDetected: node.keyMismatchDetected ?? undefined,
            keySecurityIssueDetails: node.keySecurityIssueDetails ?? undefined,
            welcomedAt: node.welcomedAt ?? undefined,
            positionChannel: node.positionChannel ?? undefined,
            positionPrecisionBits: node.positionPrecisionBits ?? undefined,
            positionGpsAccuracy: node.positionGpsAccuracy ?? undefined,
            positionHdop: node.positionHdop ?? undefined,
            positionTimestamp: node.positionTimestamp ?? undefined,
            positionOverrideEnabled: node.positionOverrideEnabled ?? undefined,
            latitudeOverride: node.latitudeOverride ?? undefined,
            longitudeOverride: node.longitudeOverride ?? undefined,
            altitudeOverride: node.altitudeOverride ?? undefined,
            positionOverrideIsPrivate: node.positionOverrideIsPrivate ?? undefined,
            hasRemoteAdmin: node.hasRemoteAdmin ?? undefined,
            lastRemoteAdminCheck: node.lastRemoteAdminCheck ?? undefined,
            remoteAdminMetadata: node.remoteAdminMetadata ?? undefined,
            sourceId: (node as any).sourceId ?? 'default',
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
          };
          this.nodesCache.set(this.cacheKey(localNode.nodeNum, localNode.sourceId ?? 'default'), localNode);
        }
        // Count nodes with welcomedAt set for auto-welcome diagnostics
        const nodesWithWelcome = Array.from(this.nodesCache.values()).filter(n => n.welcomedAt !== null && n.welcomedAt !== undefined);
        logger.info(`[DatabaseService] Loaded ${this.nodesCache.size} nodes into cache (${nodesWithWelcome.length} previously welcomed)`);
      }

      // Load all channels into cache
      if (this.channelsRepo) {
        const channels = await this.channelsRepo.getAllChannels();
        this.channelsCache.clear();
        for (const channel of channels) {
          this.channelsCache.set(channel.id, channel);
        }
        logger.info(`[DatabaseService] Loaded ${this.channelsCache.size} channels into cache`);
      }

      // Load recent messages into cache for delivery state updates
      if (this.messagesRepo) {
        const messages = await this.messagesRepo.getMessages(500);
        this._messagesCache = messages.map(m => this.convertRepoMessage(m));
        logger.info(`[DatabaseService] Loaded ${this._messagesCache.length} messages into cache`);
      }

      // Load neighbor info into cache
      if (this.neighborsRepo) {
        const neighbors = await this.neighborsRepo.getAllNeighborInfo();
        this._neighborsCache = neighbors.map(n => this.convertRepoNeighborInfo(n));
        logger.info(`[DatabaseService] Loaded ${this._neighborsCache.length} neighbor records into cache`);
      }

      this.cacheInitialized = true;
      logger.info('[DatabaseService] Caches loaded successfully');
    } catch (error) {
      logger.error('[DatabaseService] Failed to load caches:', error);
      // Don't throw - caches are best-effort
    }
  }

  private initialize(): void {
    if (this.isInitialized) return;

    // Pre-3.7 detection: check BEFORE createTables() so we can distinguish
    // an existing pre-v3.7 database from a fresh install.
    // If settings table already exists at this point, it's from a previous installation.
    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (see Task 2.9)
    const settingsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
    ).all();
    if (settingsExists.length > 0) {
      // Check for v3.7+ markers: either the old migration_077 key (pre-clean-break)
      // or the new migration_078 key (post-clean-break baseline)
      // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (see Task 2.9)
      const v37Key = this.db.prepare(
        "SELECT value FROM settings WHERE key IN ('migration_077_ignored_nodes_nodenum_bigint', 'migration_078_create_embed_profiles')"
      ).get();
      if (!v37Key) {
        logger.error('This version requires MeshMonitor v3.7 or later.');
        logger.error('Please upgrade to v3.7 first, then upgrade to this version.');
        throw new Error('Database is pre-v3.7. Please upgrade to v3.7 first.');
      }
    }

    this.createTables();
    this.migrateSchema();
    this.createIndexes();
    this.runDataMigrations();

    // Run all registered SQLite migrations via the migration registry
    for (const migration of registry.getAll()) {
      if (!migration.sqlite) continue;

      try {
        if (migration.selfIdempotent) {
          // Old-style migrations (001-046) handle their own idempotency
          migration.sqlite(this.db,
            (key: string) => this.getSetting(key),
            (key: string, value: string) => this.setSetting(key, value)
          );
        } else if (migration.settingsKey) {
          // New-style migrations use settings key guard
          if (this.getSetting(migration.settingsKey) !== 'completed') {
            logger.debug(`Running migration ${String(migration.number).padStart(3, '0')}: ${migration.name}...`);
            migration.sqlite(this.db,
              (key: string) => this.getSetting(key),
              (key: string, value: string) => this.setSetting(key, value)
            );
            this.setSetting(migration.settingsKey, 'completed');
            logger.debug(`Migration ${String(migration.number).padStart(3, '0')} completed successfully`);
          }
        }
      } catch (error) {
        logger.error(`Error running migration ${String(migration.number).padStart(3, '0')} (${migration.name}):`, error);
        throw error;
      }
    }
    this.ensureAutomationDefaults();
    this.warmupCaches();
    this.isInitialized = true;
  }

  // Warm up caches on startup to avoid cold cache latency on first request
  private warmupCaches(): void {
    try {
      logger.debug('🔥 Warming up database caches...');
      // Pre-populate the telemetry types cache
      this.getAllNodesTelemetryTypes();
      logger.debug('✅ Cache warmup complete');
    } catch (error) {
      // Cache warmup failure is non-critical - cache will populate on first request
      logger.warn('⚠️ Cache warmup failed (non-critical):', error);
    }
  }

  private ensureAutomationDefaults(): void {
    logger.debug('Ensuring automation default settings...');
    try {
      // Only set defaults if they don't exist
      const automationSettings = {
        autoAckEnabled: 'false',
        autoAckRegex: '^(test|ping)',
        autoAckUseDM: 'false',
        autoAckTapbackEnabled: 'false',
        autoAckReplyEnabled: 'true',
        // New direct/multihop settings - default to true for backward compatibility
        autoAckDirectEnabled: 'true',
        autoAckDirectTapbackEnabled: 'true',
        autoAckDirectReplyEnabled: 'true',
        autoAckMultihopEnabled: 'true',
        autoAckMultihopTapbackEnabled: 'true',
        autoAckMultihopReplyEnabled: 'true',
        autoAnnounceEnabled: 'false',
        autoAnnounceIntervalHours: '6',
        autoAnnounceMessage: 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}',
        autoAnnounceChannelIndexes: '[0]',
        autoAnnounceOnStart: 'false',
        autoAnnounceUseSchedule: 'false',
        autoAnnounceSchedule: '0 */6 * * *',
        tracerouteIntervalMinutes: '0',
        autoUpgradeImmediate: 'false',
        autoTimeSyncEnabled: 'false',
        autoTimeSyncIntervalMinutes: '15',
        autoTimeSyncExpirationHours: '24',
        autoTimeSyncNodeFilterEnabled: 'false'
      };

      Object.entries(automationSettings).forEach(([key, defaultValue]) => {
        const existing = this.getSetting(key);
        if (existing === null) {
          this.setSetting(key, defaultValue);
          logger.debug(`✅ Set default for ${key}: ${defaultValue}`);
        }
      });

      logger.debug('✅ Automation defaults ensured');
    } catch (error) {
      logger.error('❌ Failed to ensure automation defaults:', error);
      throw error;
    }
  }


  private ensureBroadcastNode(): void {
    logger.debug('🔍 ensureBroadcastNode() called');
    try {
      const broadcastNodeNum = 4294967295; // 0xFFFFFFFF
      const broadcastNodeId = '!ffffffff';

      const existingNode = this.getNode(broadcastNodeNum);
      logger.debug('🔍 getNode(4294967295) returned:', existingNode);

      if (!existingNode) {
        logger.debug('🔍 No broadcast node found, creating it');
        this.upsertNode({
          nodeNum: broadcastNodeNum,
          nodeId: broadcastNodeId,
          longName: 'Broadcast',
          shortName: 'BCAST'
        });

        // Verify it was created
        const verify = this.getNode(broadcastNodeNum);
        logger.debug('🔍 After upsert, getNode(4294967295) returns:', verify);
      } else {
        logger.debug(`✅ Broadcast node already exists`);
      }
    } catch (error) {
      logger.error('❌ Error in ensureBroadcastNode:', error);
    }
  }

  private createTables(): void {
    logger.debug('Creating database tables (v3.7 complete schema)...');

    // ============================================================
    // CORE TABLES (matches 001_v37_baseline.ts exactly)
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT UNIQUE NOT NULL,
        longName TEXT,
        shortName TEXT,
        hwModel INTEGER,
        role INTEGER,
        hopsAway INTEGER,
        lastMessageHops INTEGER,
        viaMqtt INTEGER,
        macaddr TEXT,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        batteryLevel INTEGER,
        voltage REAL,
        channelUtilization REAL,
        airUtilTx REAL,
        lastHeard INTEGER,
        snr REAL,
        rssi INTEGER,
        lastTracerouteRequest INTEGER,
        firmwareVersion TEXT,
        channel INTEGER,
        isFavorite INTEGER DEFAULT 0,
        favoriteLocked INTEGER DEFAULT 0,
        isIgnored INTEGER DEFAULT 0,
        mobile INTEGER DEFAULT 0,
        rebootCount INTEGER,
        publicKey TEXT,
        lastMeshReceivedKey TEXT,
        hasPKC INTEGER,
        lastPKIPacket INTEGER,
        keyIsLowEntropy INTEGER,
        duplicateKeyDetected INTEGER,
        keyMismatchDetected INTEGER,
        keySecurityIssueDetails TEXT,
        isExcessivePackets INTEGER DEFAULT 0,
        packetRatePerHour INTEGER,
        packetRateLastChecked INTEGER,
        isTimeOffsetIssue INTEGER DEFAULT 0,
        timeOffsetSeconds INTEGER,
        welcomedAt INTEGER,
        positionChannel INTEGER,
        positionPrecisionBits INTEGER,
        positionGpsAccuracy REAL,
        positionHdop REAL,
        positionTimestamp INTEGER,
        positionOverrideEnabled INTEGER DEFAULT 0,
        latitudeOverride REAL,
        longitudeOverride REAL,
        altitudeOverride REAL,
        positionOverrideIsPrivate INTEGER DEFAULT 0,
        hasRemoteAdmin INTEGER DEFAULT 0,
        lastRemoteAdminCheck INTEGER,
        remoteAdminMetadata TEXT,
        lastTimeSync INTEGER,
        autoTracerouteEnabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        text TEXT NOT NULL,
        channel INTEGER NOT NULL DEFAULT 0,
        portnum INTEGER,
        requestId INTEGER,
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        relayNode INTEGER,
        replyId INTEGER,
        emoji INTEGER,
        viaMqtt INTEGER,
        rxSnr REAL,
        rxRssi REAL,
        ackFailed INTEGER,
        routingErrorReceived INTEGER,
        deliveryState TEXT,
        wantAck INTEGER,
        ackFromNode INTEGER,
        createdAt INTEGER NOT NULL,
        decrypted_by TEXT
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        psk TEXT,
        role INTEGER,
        uplinkEnabled INTEGER NOT NULL DEFAULT 1,
        downlinkEnabled INTEGER NOT NULL DEFAULT 1,
        positionPrecision INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        telemetryType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        createdAt INTEGER NOT NULL,
        packetTimestamp INTEGER,
        packetId INTEGER,
        channel INTEGER,
        precisionBits INTEGER,
        gpsAccuracy REAL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // ============================================================
    // ROUTING TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        route TEXT,
        routeBack TEXT,
        snrTowards TEXT,
        snrBack TEXT,
        routePositions TEXT,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        distanceKm REAL NOT NULL,
        isRecordHolder INTEGER DEFAULT 0,
        fromLatitude REAL,
        fromLongitude REAL,
        toLatitude REAL,
        toLongitude REAL,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        neighborNodeNum INTEGER NOT NULL,
        snr REAL,
        lastRxTime INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    // ============================================================
    // AUTH TABLES (snake_case column names for SQLite)
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        email TEXT,
        display_name TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        oidc_subject TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        password_locked INTEGER DEFAULT 0,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        mfa_secret TEXT,
        mfa_backup_codes TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        created_by INTEGER
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        resource TEXT NOT NULL,
        can_view_on_map INTEGER NOT NULL DEFAULT 0,
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        granted_at INTEGER NOT NULL,
        granted_by INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        value_before TEXT,
        value_after TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        created_by INTEGER,
        revoked_at INTEGER,
        revoked_by INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // ============================================================
    // NOTIFICATION TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS read_messages (
        message_id TEXT NOT NULL PRIMARY KEY,
        user_id INTEGER,
        read_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        endpoint TEXT NOT NULL,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        enable_web_push INTEGER DEFAULT 1,
        enable_direct_messages INTEGER DEFAULT 1,
        notify_on_emoji INTEGER DEFAULT 0,
        notify_on_new_node INTEGER DEFAULT 1,
        notify_on_traceroute INTEGER DEFAULT 1,
        notify_on_inactive_node INTEGER DEFAULT 0,
        notify_on_server_events INTEGER DEFAULT 0,
        prefix_with_node_name INTEGER DEFAULT 0,
        enable_apprise INTEGER DEFAULT 1,
        apprise_urls TEXT,
        enabled_channels TEXT,
        monitored_nodes TEXT,
        whitelist TEXT,
        blacklist TEXT,
        notify_on_mqtt INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // ============================================================
    // PACKET LOG
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packet_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        packet_id INTEGER,
        timestamp INTEGER NOT NULL,
        from_node INTEGER NOT NULL,
        from_node_id TEXT,
        to_node INTEGER,
        to_node_id TEXT,
        channel INTEGER,
        portnum INTEGER NOT NULL,
        portnum_name TEXT,
        encrypted INTEGER NOT NULL,
        snr REAL,
        rssi REAL,
        hop_limit INTEGER,
        hop_start INTEGER,
        relay_node INTEGER,
        payload_size INTEGER,
        want_ack INTEGER,
        priority INTEGER,
        payload_preview TEXT,
        metadata TEXT,
        direction TEXT,
        created_at INTEGER,
        decrypted_by TEXT,
        decrypted_channel_id INTEGER,
        transport_mechanism INTEGER
      );
    `);

    // ============================================================
    // BACKUP & UPGRADE TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeId TEXT,
        nodeNum INTEGER,
        filename TEXT NOT NULL,
        filePath TEXT NOT NULL,
        fileSize INTEGER,
        backupType TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backupPath TEXT NOT NULL,
        backupType TEXT NOT NULL,
        schemaVersion INTEGER,
        appVersion TEXT,
        totalSize INTEGER,
        tableCount INTEGER,
        rowCount INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS upgrade_history (
        id TEXT PRIMARY KEY,
        fromVersion TEXT NOT NULL,
        toVersion TEXT NOT NULL,
        deploymentMethod TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        currentStep TEXT,
        logs TEXT,
        backupPath TEXT,
        startedAt INTEGER,
        completedAt INTEGER,
        initiatedBy TEXT,
        errorMessage TEXT,
        rollbackAvailable INTEGER
      );
    `);

    // ============================================================
    // UI TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        definition TEXT NOT NULL,
        is_builtin INTEGER DEFAULT 0,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    // Column name must match baseline 001 (user_id, snake_case). Older bootstraps
    // used camelCase `userId`, which diverged from the baseline once #2681 moved
    // the repo to Drizzle — the Drizzle schema reads `user_id` (matching the
    // baseline), so a legacy `userId NOT NULL` column makes inserts fail with
    // `NOT NULL constraint failed: user_map_preferences.userId` on the first
    // POST /api/user/map-preferences. See #2713.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_map_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        centerLat REAL,
        centerLng REAL,
        zoom REAL,
        selectedLayer TEXT,
        showAccuracyRegions INTEGER DEFAULT 0,
        showEstimatedPositions INTEGER DEFAULT 1,
        showMeshCoreNodes INTEGER DEFAULT 0,
        sortBy TEXT DEFAULT 'name',
        sortDirection TEXT DEFAULT 'asc',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
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
      );
    `);

    // ============================================================
    // SOLAR ESTIMATES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS solar_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL UNIQUE,
        watt_hours REAL NOT NULL,
        fetched_at INTEGER NOT NULL,
        created_at INTEGER
      );
    `);

    // ============================================================
    // AUTOMATION TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        to_node_num INTEGER NOT NULL,
        to_node_name TEXT,
        success INTEGER,
        created_at INTEGER
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_state (
        nodeNum INTEGER PRIMARY KEY,
        attemptCount INTEGER DEFAULT 0,
        lastAttemptTime INTEGER,
        exhausted INTEGER DEFAULT 0,
        startedAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodeNum INTEGER NOT NULL,
        nodeName TEXT,
        action TEXT NOT NULL,
        success INTEGER,
        created_at INTEGER,
        sourceId TEXT
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at INTEGER
      );
    `);

    // ============================================================
    // CHANNEL DATABASE
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_database (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        psk TEXT NOT NULL,
        psk_length INTEGER NOT NULL,
        description TEXT,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        enforce_name_validation INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
        last_decrypted_at INTEGER,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_database_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        channel_database_id INTEGER NOT NULL,
        can_view_on_map INTEGER NOT NULL DEFAULT 0,
        can_read INTEGER NOT NULL DEFAULT 0,
        granted_by INTEGER,
        granted_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (channel_database_id) REFERENCES channel_database(id) ON DELETE CASCADE,
        FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // ============================================================
    // IGNORED NODES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ignored_nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL,
        longName TEXT,
        shortName TEXT,
        ignoredAt INTEGER NOT NULL,
        ignoredBy TEXT
      );
    `);

    // ============================================================
    // GEOFENCE COOLDOWNS
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS geofence_cooldowns (
        triggerId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        firedAt INTEGER NOT NULL,
        PRIMARY KEY (triggerId, nodeNum)
      );
    `);

    // ============================================================
    // MESHCORE TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meshcore_nodes (
        publicKey TEXT PRIMARY KEY,
        name TEXT,
        advType INTEGER,
        txPower INTEGER,
        maxTxPower INTEGER,
        radioFreq REAL,
        radioBw REAL,
        radioSf INTEGER,
        radioCr INTEGER,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        batteryMv INTEGER,
        uptimeSecs INTEGER,
        rssi INTEGER,
        snr REAL,
        lastHeard INTEGER,
        hasAdminAccess INTEGER DEFAULT 0,
        lastAdminCheck INTEGER,
        isLocalNode INTEGER DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meshcore_messages (
        id TEXT PRIMARY KEY,
        fromPublicKey TEXT NOT NULL,
        toPublicKey TEXT,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        rssi INTEGER,
        snr INTEGER,
        messageType TEXT DEFAULT 'text',
        delivered INTEGER DEFAULT 0,
        deliveredAt INTEGER,
        createdAt INTEGER NOT NULL
      );
    `);

    // ============================================================
    // NEWS TABLES
    // ============================================================

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS news_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedData TEXT NOT NULL,
        fetchedAt INTEGER NOT NULL,
        sourceUrl TEXT NOT NULL
      );
    `);

    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_news_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        lastSeenNewsId TEXT,
        dismissedNewsIds TEXT,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Create index for efficient upgrade history queries
    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations (Task 2.9)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_upgrade_history_timestamp
      ON upgrade_history(startedAt DESC);
    `);

    // Create index for efficient traceroute queries
    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_traceroutes_nodes
      ON traceroutes(fromNodeNum, toNodeNum, timestamp DESC);
    `);

    logger.debug('Database tables created successfully');
  }

  private migrateSchema(): void {
    // Legacy ALTER TABLE migrations are no longer needed.
    // All columns are now created in createTables() with the full v3.7 schema.
    // This method is kept as a no-op for compatibility — will be removed in Chunk 5.
    logger.debug('migrateSchema: skipped (full schema created in createTables)');
  }

  private createIndexes(): void {
    // eslint-disable-next-line no-restricted-syntax -- bootstrap: runs before migrations
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_nodeId ON nodes(nodeId);
      CREATE INDEX IF NOT EXISTS idx_nodes_lastHeard ON nodes(lastHeard);
      CREATE INDEX IF NOT EXISTS idx_nodes_updatedAt ON nodes(updatedAt);

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_fromNodeId ON messages(fromNodeId);
      CREATE INDEX IF NOT EXISTS idx_telemetry_nodeId ON telemetry(nodeId);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
      CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry(telemetryType);
      -- Composite index for position history queries (nodeId + telemetryType + timestamp)
      CREATE INDEX IF NOT EXISTS idx_telemetry_position_lookup ON telemetry(nodeId, telemetryType, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_toNodeId ON messages(toNodeId);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_createdAt ON messages(createdAt);

      CREATE INDEX IF NOT EXISTS idx_route_segments_distance ON route_segments(distanceKm DESC);
      CREATE INDEX IF NOT EXISTS idx_route_segments_timestamp ON route_segments(timestamp);
      CREATE INDEX IF NOT EXISTS idx_route_segments_recordholder ON route_segments(isRecordHolder);
    `);
  }

  private runDataMigrations(): void {
    // Migration: Calculate distances for all existing traceroutes
    const migrationKey = 'route_segments_migration_v1';
    const migrationCompleted = this.getSetting(migrationKey);

    if (migrationCompleted === 'completed') {
      logger.debug('✅ Route segments migration already completed');
      return;
    }

    logger.debug('🔄 Running route segments migration...');

    try {
      // Get ALL traceroutes from the database (bootstrap: runDataMigrations)
      const allTraceroutes = this.traceroutes.getAllTraceroutesSync() as unknown as DbTraceroute[];

      logger.debug(`📊 Processing ${allTraceroutes.length} traceroutes for distance calculation...`);

      let processedCount = 0;
      let segmentsCreated = 0;

      for (const traceroute of allTraceroutes) {
        try {
          // Parse the route arrays
          const route = traceroute.route ? JSON.parse(traceroute.route) : [];
          const routeBack = traceroute.routeBack ? JSON.parse(traceroute.routeBack) : [];

          // Process forward route segments
          for (let i = 0; i < route.length - 1; i++) {
            const fromNodeNum = route[i];
            const toNodeNum = route[i + 1];

            const fromNode = this.getNode(fromNodeNum);
            const toNode = this.getNode(toNodeNum);

            // Only calculate distance if both nodes have position data
            if (fromNode?.latitude && fromNode?.longitude &&
                toNode?.latitude && toNode?.longitude) {

              const distanceKm = calculateDistance(
                fromNode.latitude, fromNode.longitude,
                toNode.latitude, toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now()
              };

              this.insertRouteSegment(segment, (traceroute as any).sourceId ?? undefined);
              this.updateRecordHolderSegment(segment, (traceroute as any).sourceId ?? undefined);
              segmentsCreated++;
            }
          }

          // Process return route segments
          for (let i = 0; i < routeBack.length - 1; i++) {
            const fromNodeNum = routeBack[i];
            const toNodeNum = routeBack[i + 1];

            const fromNode = this.getNode(fromNodeNum);
            const toNode = this.getNode(toNodeNum);

            // Only calculate distance if both nodes have position data
            if (fromNode?.latitude && fromNode?.longitude &&
                toNode?.latitude && toNode?.longitude) {

              const distanceKm = calculateDistance(
                fromNode.latitude, fromNode.longitude,
                toNode.latitude, toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now()
              };

              this.insertRouteSegment(segment, (traceroute as any).sourceId ?? undefined);
              this.updateRecordHolderSegment(segment, (traceroute as any).sourceId ?? undefined);
              segmentsCreated++;
            }
          }

          processedCount++;

          // Log progress every 100 traceroutes
          if (processedCount % 100 === 0) {
            logger.debug(`   Processed ${processedCount}/${allTraceroutes.length} traceroutes...`);
          }
        } catch (error) {
          logger.error(`   Error processing traceroute ${traceroute.id}:`, error);
          // Continue with next traceroute
        }
      }

      // Mark migration as completed
      this.setSetting(migrationKey, 'completed');
      logger.debug(`✅ Migration completed! Processed ${processedCount} traceroutes, created ${segmentsCreated} route segments`);

    } catch (error) {
      logger.error('❌ Error during route segments migration:', error);
      // Don't mark as completed if there was an error
    }
  }

  // Ghost node suppression methods
  suppressGhostNode(nodeNum: number, durationMs: number = 30 * 60 * 1000): void {
    const expiresAt = Date.now() + durationMs;
    this.suppressedGhostNodes.set(nodeNum, expiresAt);
    logger.info(`👻 Suppressed ghost node !${nodeNum.toString(16).padStart(8, '0')} for ${Math.round(durationMs / 60000)} minutes`);
  }

  unsuppressGhostNode(nodeNum: number): void {
    if (this.suppressedGhostNodes.delete(nodeNum)) {
      logger.info(`👻 Unsuppressed ghost node !${nodeNum.toString(16).padStart(8, '0')}`);
    }
  }

  isNodeSuppressed(nodeNum: number | undefined | null): boolean {
    if (nodeNum === undefined || nodeNum === null) return false;
    const expiresAt = this.suppressedGhostNodes.get(nodeNum);
    if (expiresAt === undefined) return false;
    if (Date.now() >= expiresAt) {
      this.suppressedGhostNodes.delete(nodeNum);
      logger.debug(`👻 Ghost suppression expired for !${nodeNum.toString(16).padStart(8, '0')}`);
      return false;
    }
    return true;
  }

  getSuppressedGhostNodes(): Array<{ nodeNum: number; nodeId: string; expiresAt: number; remainingMs: number }> {
    const now = Date.now();
    const result: Array<{ nodeNum: number; nodeId: string; expiresAt: number; remainingMs: number }> = [];
    for (const [nodeNum, expiresAt] of this.suppressedGhostNodes) {
      if (now < expiresAt) {
        result.push({
          nodeNum,
          nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
          expiresAt,
          remainingMs: expiresAt - now,
        });
      } else {
        this.suppressedGhostNodes.delete(nodeNum);
      }
    }
    return result;
  }

  // Node operations
  upsertNode(nodeData: Partial<DbNode>): void {
    logger.debug(`DEBUG: upsertNode called with nodeData:`, JSON.stringify(nodeData));
    logger.debug(`DEBUG: nodeNum type: ${typeof nodeData.nodeNum}, value: ${nodeData.nodeNum}`);
    logger.debug(`DEBUG: nodeId type: ${typeof nodeData.nodeId}, value: ${nodeData.nodeId}`);
    if (nodeData.nodeNum === undefined || nodeData.nodeNum === null || !nodeData.nodeId) {
      logger.error('Cannot upsert node: missing nodeNum or nodeId');
      logger.error('STACK TRACE FOR FAILED UPSERT:');
      logger.error(new Error().stack);
      return;
    }

    // Ghost suppression: block creation of suppressed nodes but allow updates to existing ones
    if (this.isNodeSuppressed(nodeData.nodeNum)) {
      // Check if this node already exists (in cache for Postgres/MySQL, in DB for SQLite)
      const suppressedSourceId = (nodeData as any).sourceId ?? 'default';
      const existsInCache = (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql')
        ? this.nodesCache.has(this.cacheKey(nodeData.nodeNum, suppressedSourceId))
        : !!this.getNode(nodeData.nodeNum);
      if (!existsInCache) {
        logger.debug(`👻 Suppressed ghost node creation for !${nodeData.nodeNum.toString(16).padStart(8, '0')}`);
        return;
      }
    }

    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.nodesRepo) {
        // Update cache optimistically
        const upsertSourceId = (nodeData as any).sourceId ?? 'default';
        const existingNode = this.nodesCache.get(this.cacheKey(nodeData.nodeNum, upsertSourceId));
        const now = Date.now();
        const updatedNode: DbNode = {
          nodeNum: nodeData.nodeNum,
          nodeId: nodeData.nodeId,
          longName: nodeData.longName ?? existingNode?.longName ?? '',
          shortName: nodeData.shortName ?? existingNode?.shortName ?? '',
          hwModel: nodeData.hwModel ?? existingNode?.hwModel ?? 0,
          role: nodeData.role ?? existingNode?.role,
          hopsAway: nodeData.hopsAway ?? existingNode?.hopsAway,
          lastMessageHops: nodeData.lastMessageHops ?? existingNode?.lastMessageHops,
          viaMqtt: nodeData.viaMqtt ?? existingNode?.viaMqtt,
          macaddr: nodeData.macaddr ?? existingNode?.macaddr,
          latitude: nodeData.latitude ?? existingNode?.latitude,
          longitude: nodeData.longitude ?? existingNode?.longitude,
          altitude: nodeData.altitude ?? existingNode?.altitude,
          batteryLevel: nodeData.batteryLevel ?? existingNode?.batteryLevel,
          voltage: nodeData.voltage ?? existingNode?.voltage,
          channelUtilization: nodeData.channelUtilization ?? existingNode?.channelUtilization,
          airUtilTx: nodeData.airUtilTx ?? existingNode?.airUtilTx,
          lastHeard: nodeData.lastHeard ?? existingNode?.lastHeard,
          snr: nodeData.snr ?? existingNode?.snr,
          rssi: nodeData.rssi ?? existingNode?.rssi,
          lastTracerouteRequest: nodeData.lastTracerouteRequest ?? existingNode?.lastTracerouteRequest,
          firmwareVersion: nodeData.firmwareVersion ?? existingNode?.firmwareVersion,
          channel: nodeData.channel ?? existingNode?.channel,
          isFavorite: nodeData.isFavorite ?? existingNode?.isFavorite,
          favoriteLocked: nodeData.favoriteLocked ?? existingNode?.favoriteLocked,
          isIgnored: nodeData.isIgnored ?? existingNode?.isIgnored,
          mobile: nodeData.mobile ?? existingNode?.mobile,
          rebootCount: nodeData.rebootCount ?? existingNode?.rebootCount,
          publicKey: nodeData.publicKey ?? existingNode?.publicKey,
          hasPKC: nodeData.hasPKC ?? existingNode?.hasPKC,
          lastPKIPacket: nodeData.lastPKIPacket ?? existingNode?.lastPKIPacket,
          keyIsLowEntropy: nodeData.keyIsLowEntropy ?? existingNode?.keyIsLowEntropy,
          duplicateKeyDetected: nodeData.duplicateKeyDetected ?? existingNode?.duplicateKeyDetected,
          keyMismatchDetected: nodeData.keyMismatchDetected ?? existingNode?.keyMismatchDetected,
          // For keySecurityIssueDetails, allow explicit clearing by checking if property was set
          keySecurityIssueDetails: 'keySecurityIssueDetails' in nodeData
            ? (nodeData.keySecurityIssueDetails || undefined)
            : existingNode?.keySecurityIssueDetails,
          welcomedAt: nodeData.welcomedAt ?? existingNode?.welcomedAt,
          positionChannel: nodeData.positionChannel ?? existingNode?.positionChannel,
          positionPrecisionBits: nodeData.positionPrecisionBits ?? existingNode?.positionPrecisionBits,
          positionGpsAccuracy: nodeData.positionGpsAccuracy ?? existingNode?.positionGpsAccuracy,
          positionHdop: nodeData.positionHdop ?? existingNode?.positionHdop,
          positionTimestamp: nodeData.positionTimestamp ?? existingNode?.positionTimestamp,
          positionOverrideEnabled: nodeData.positionOverrideEnabled ?? existingNode?.positionOverrideEnabled,
          latitudeOverride: nodeData.latitudeOverride ?? existingNode?.latitudeOverride,
          longitudeOverride: nodeData.longitudeOverride ?? existingNode?.longitudeOverride,
          altitudeOverride: nodeData.altitudeOverride ?? existingNode?.altitudeOverride,
          positionOverrideIsPrivate: nodeData.positionOverrideIsPrivate ?? existingNode?.positionOverrideIsPrivate,
          // Remote admin discovery - preserve existing values
          hasRemoteAdmin: existingNode?.hasRemoteAdmin,
          lastRemoteAdminCheck: existingNode?.lastRemoteAdminCheck,
          remoteAdminMetadata: existingNode?.remoteAdminMetadata,
          sourceId: upsertSourceId,
          createdAt: existingNode?.createdAt ?? now,
          updatedAt: now,
        };
        this.nodesCache.set(this.cacheKey(nodeData.nodeNum, upsertSourceId), updatedNode);

        // Fire and forget async version - pass the full merged node to avoid race conditions
        // where a subsequent update (like welcomedAt) could be overwritten
        this.nodesRepo.upsertNode(updatedNode).catch(err => {
          logger.error('Failed to upsert node:', err);
        });

        // For newly discovered nodes, check per-source ignore list and restore status
        if (!existingNode && nodeData.nodeNum !== 4294967295) {
          // Check if this node was previously ignored on this source
          if (this.ignoredNodesRepo) {
            this.ignoredNodes.isNodeIgnoredAsync(nodeData.nodeNum, upsertSourceId).then(wasIgnored => {
              if (wasIgnored) {
                logger.debug(`Restoring ignored status for returning node ${nodeData.nodeNum} on source ${upsertSourceId}`);
                updatedNode.isIgnored = true;
                this.nodesCache.set(this.cacheKey(nodeData.nodeNum!, upsertSourceId), updatedNode);
                if (this.nodesRepo) {
                  this.nodesRepo.setNodeIgnored(nodeData.nodeNum!, true, upsertSourceId).catch(err => {
                    logger.error('Failed to restore ignored status:', err);
                  });
                }
              }
            }).catch(err => logger.error('Failed to check per-source ignore list:', err));
          }
        }

        // Send new node notification when a node becomes complete (has longName, shortName, hwModel)
        // This defers the notification until we have meaningful info instead of just a raw node ID
        const wasComplete = existingNode ? isNodeComplete(existingNode) : false;
        if (nodeData.nodeNum !== 4294967295 && !wasComplete &&
            !this.newNodeNotifiedSet.has(nodeData.nodeNum) && isNodeComplete(updatedNode)) {
          this.newNodeNotifiedSet.add(nodeData.nodeNum);
          const newNodeSourceId = (updatedNode as any).sourceId ?? (nodeData as any).sourceId ?? 'default';
          import('../server/services/notificationService.js').then(async ({ notificationService }) => {
            let sourceName = newNodeSourceId;
            try {
              const src = await this.sources.getSource(newNodeSourceId);
              if (src?.name) sourceName = src.name;
            } catch { /* fall back to id */ }
            await notificationService.notifyNewNode(
              updatedNode.nodeId!,
              updatedNode.longName!,
              updatedNode.shortName!,
              updatedNode.hwModel ?? undefined,
              updatedNode.hopsAway,
              newNodeSourceId,
              sourceName
            );
          }).catch(err => logger.error('Failed to send new node notification:', err));
        }
      }
      return;
    }

    // Post-migration 029: existence check and UPDATE must be scoped per-source
    // when a sourceId is supplied. Omitting the scope would cause an upsert on
    // source A to overwrite source B's row for the same nodeNum.
    const upsertSourceIdSqlite = (nodeData as any).sourceId as string | undefined;
    const existingNode = upsertSourceIdSqlite
      ? this.getNode(nodeData.nodeNum, upsertSourceIdSqlite)
      : this.getNode(nodeData.nodeNum);

    let wasIgnored = false;
    if (!existingNode) {
      // Check if this node was previously ignored on this source (per-source blocklist).
      // Delegates to IgnoredNodesRepository so the raw SQL stays inside Drizzle-managed code.
      if (this.ignoredNodesRepo && upsertSourceIdSqlite) {
        wasIgnored = this.ignoredNodesRepo.isNodeIgnoredSqlite(nodeData.nodeNum, upsertSourceIdSqlite);
      }
    }

    // Delegate to the repository's sync upsert — eliminates raw SQL.
    this.nodesRepo!.upsertNodeSqlite(nodeData, wasIgnored);

    if (!existingNode && wasIgnored) {
      logger.debug(`Restored ignored status for returning node ${nodeData.nodeNum}`);
    }

    // Send new node notification when a node becomes complete (has longName, shortName, hwModel)
    // This defers the notification until we have meaningful info instead of just a raw node ID
    // For SQLite, build the merged node state to check completeness (COALESCE merges in SQL)
    if (nodeData.nodeNum !== 4294967295 && !this.newNodeNotifiedSet.has(nodeData.nodeNum)) {
      const wasComplete = existingNode ? isNodeComplete(existingNode) : false;
      if (!wasComplete) {
        const mergedNode = {
          nodeId: nodeData.nodeId ?? existingNode?.nodeId,
          longName: nodeData.longName ?? existingNode?.longName,
          shortName: nodeData.shortName ?? existingNode?.shortName,
          hwModel: nodeData.hwModel ?? existingNode?.hwModel,
        };
        if (isNodeComplete(mergedNode)) {
          this.newNodeNotifiedSet.add(nodeData.nodeNum);
          const newNodeSourceId = (nodeData as any).sourceId ?? (existingNode as any)?.sourceId ?? 'default';
          import('../server/services/notificationService.js').then(async ({ notificationService }) => {
            let sourceName = newNodeSourceId;
            try {
              const src = await this.sources.getSource(newNodeSourceId);
              if (src?.name) sourceName = src.name;
            } catch { /* fall back to id */ }
            await notificationService.notifyNewNode(
              mergedNode.nodeId!,
              mergedNode.longName!,
              mergedNode.shortName!,
              mergedNode.hwModel ?? undefined,
              nodeData.hopsAway ?? existingNode?.hopsAway,
              newNodeSourceId,
              sourceName
            );
          }).catch(err => logger.error('Failed to send new node notification:', err));
        }
      }
    }
  }

  getNode(nodeNum: number, sourceId?: string): DbNode | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getNode(${nodeNum}) called before cache initialized`);
        return null;
      }
      // When sourceId is provided, use the composite cache key directly.
      if (sourceId) {
        return this.nodesCache.get(this.cacheKey(nodeNum, sourceId)) ?? null;
      }
      // Legacy fallback: iterate cache to find first match by nodeNum
      // (used by callers that haven't been threaded through Phase 3 yet).
      for (const node of this.nodesCache.values()) {
        if (node.nodeNum === nodeNum) return node;
      }
      return null;
    }
    // SQLite: delegate to Drizzle sync variant
    return this.nodesRepo!.getNodeSqlite(nodeNum, sourceId) as unknown as DbNode | null;
  }

  getAllNodes(sourceId?: string): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getAllNodes() called before cache initialized');
        return [];
      }
      return Array.from(this.iterateCache(sourceId));
    }
    // SQLite: delegate to Drizzle sync variant
    return this.nodesRepo!.getAllNodesSqlite(sourceId) as unknown as DbNode[];
  }

  /**
   * @deprecated Use databaseService.nodes.getAllNodes() directly. Kept for internal/test compatibility.
   */
  async getAllNodesAsync(): Promise<DbNode[]> {
    return this.nodes.getAllNodes() as unknown as DbNode[];
  }

  getActiveNodes(sinceDays: number = 7): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getActiveNodes() called before cache initialized');
        return [];
      }
      const cutoff = Math.floor(Date.now() / 1000) - (sinceDays * 24 * 60 * 60);
      return Array.from(this.iterateCache())
        .filter(node => node.lastHeard !== undefined && node.lastHeard !== null && node.lastHeard > cutoff)
        .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
    }

    // SQLite: delegate to Drizzle sync variant
    return this.nodesRepo!.getActiveNodesSqlite(sinceDays) as unknown as DbNode[];
  }

  /**
   * Update the lastMessageHops for a node (calculated from hopStart - hopLimit of received packets).
   * Phase 3C: scoped per-source — sourceId is required.
   */
  updateNodeMessageHops(nodeNum: number, hops: number, sourceId: string): void {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.lastMessageHops = hops;
        cachedNode.updatedAt = now;
      }
      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.updateNodeMessageHops(nodeNum, hops, sourceId).catch((err: Error) => {
          logger.error('Failed to update node message hops:', err);
        });
      }
      return;
    }
    // SQLite: delegate to Drizzle sync variant
    this.nodesRepo!.updateNodeMessageHopsSqlite(nodeNum, hops, sourceId);
  }

  /**
   * Mark all existing nodes as welcomed to prevent thundering herd on startup
   * Should be called when Auto-Welcome is enabled during server initialization
   */
  markAllNodesAsWelcomed(sourceId?: string | null): number {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      let count = 0;
      for (const node of this.iterateCache(sourceId ?? undefined)) {
        if (node.welcomedAt === undefined || node.welcomedAt === null) {
          node.welcomedAt = now;
          node.updatedAt = now;
          count++;
        }
      }
      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.markAllNodesAsWelcomed(sourceId ?? null).catch((err: Error) => {
          logger.error('Failed to mark all nodes as welcomed:', err);
        });
      }
      return count;
    }
    void now;
    return this.nodesRepo!.markAllNodesAsWelcomedSqlite(sourceId ?? null);
  }

  /**
   * Atomically mark a specific node as welcomed if not already welcomed.
   * This prevents race conditions where multiple processes try to welcome the same node.
   * Returns true if the node was marked, false if already welcomed.
   */
  markNodeAsWelcomedIfNotAlready(nodeNum: number, nodeId: string, sourceId: string): boolean {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode && cachedNode.nodeId === nodeId && (cachedNode.welcomedAt === undefined || cachedNode.welcomedAt === null)) {
        cachedNode.welcomedAt = now;
        cachedNode.updatedAt = now;
        // Persist to database and log result
        if (this.nodesRepo) {
          this.nodesRepo.markNodeAsWelcomedIfNotAlready(nodeNum, nodeId, sourceId)
            .then((marked) => {
              if (marked) {
                logger.info(`✅ Persisted welcomedAt=${now} to database for node ${nodeId}`);
              }
            })
            .catch((err: Error) => {
              logger.error(`❌ Failed to persist welcomedAt for node ${nodeId}:`, err);
            });
        }
        return true;
      }
      return false;
    }
    void now;
    return this.nodesRepo!.markNodeAsWelcomedIfNotAlreadySqlite(nodeNum, nodeId, sourceId);
  }

  /**
   * Handle auto-welcome being enabled for the first time.
   * This marks all existing nodes as welcomed to prevent a "thundering herd" of welcome messages.
   * Should only be called when autoWelcomeEnabled changes from disabled to enabled.
   */
  handleAutoWelcomeEnabled(): number {
    const migrationKey = 'auto_welcome_first_enabled';
    const migrationCompleted = this.getSetting(migrationKey);

    // If migration already ran, don't run it again
    if (migrationCompleted === 'completed') {
      logger.debug('✅ Auto-welcome first-enable migration already completed');
      return 0;
    }

    logger.info('👋 Auto-welcome enabled for the first time - marking existing nodes as welcomed...');
    const markedCount = this.markAllNodesAsWelcomed();
    
    if (markedCount > 0) {
      logger.info(`✅ Marked ${markedCount} existing node(s) as welcomed to prevent spam`);
    } else {
      logger.debug('No existing nodes to mark as welcomed');
    }

    // Mark migration as completed so it doesn't run again
    this.setSetting(migrationKey, 'completed');
    return markedCount;
  }

  /**
   * Get nodes with key security issues (low-entropy or duplicate keys)
   */
  /**
   * Get nodes with key security issues (low-entropy or duplicate keys) - async version
   * Works with PostgreSQL, MySQL, and SQLite through the repository pattern
   */
  async getNodesWithKeySecurityIssuesAsync(sourceId?: string): Promise<DbNode[]> {
    if (this.drizzleDbType !== 'sqlite') {
      const nodes = await this.nodes.getNodesWithKeySecurityIssues(sourceId);
      return nodes as unknown as DbNode[];
    }
    // SQLite fallback via repository
    return this.nodesRepo!.getNodesWithKeySecurityIssuesSqlite(sourceId) as unknown as DbNode[];
  }

  /**
   * Get all nodes that have public keys (for duplicate detection)
   */
  getNodesWithPublicKeys(): Array<{ nodeNum: number; publicKey: string | null }> {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: Array<{ nodeNum: number; publicKey: string | null }> = [];
      for (const node of this.iterateCache()) {
        if (node.publicKey && node.publicKey !== '') {
          result.push({ nodeNum: node.nodeNum, publicKey: node.publicKey });
        }
      }
      return result;
    }

    return this.nodesRepo!.getNodesWithPublicKeysSqlite();
  }

  /**
   * Update security flags for a node by nodeNum (doesn't require nodeId)
   * Used by duplicate key scanner which needs to update nodes that may not have nodeIds yet
   */
  /**
   * Update security flags for a node, scoped per-source (post-migration 029).
   */
  updateNodeSecurityFlags(nodeNum: number, duplicateKeyDetected: boolean, keySecurityIssueDetails: string | undefined, sourceId: string): void {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.duplicateKeyDetected = duplicateKeyDetected;
        cachedNode.keySecurityIssueDetails = keySecurityIssueDetails;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.updateNodeSecurityFlags(nodeNum, duplicateKeyDetected, keySecurityIssueDetails, sourceId).catch(err => {
          logger.error(`Failed to update node security flags in database:`, err);
        });
      }
      return;
    }

    // SQLite: synchronous update, always scoped by sourceId per migration 029.
    this.nodesRepo!.updateNodeSecurityFlagsSqlite(nodeNum, duplicateKeyDetected, keySecurityIssueDetails, sourceId);
  }

  updateNodeLowEntropyFlag(nodeNum: number, keyIsLowEntropy: boolean, details: string | undefined, sourceId: string): void {
    const node = this.getNode(nodeNum, sourceId);
    if (!node) return;

    // Combine low-entropy details with existing duplicate details if needed
    let combinedDetails = details || '';

    if (keyIsLowEntropy && details) {
      // Setting low-entropy flag: combine with any existing duplicate info
      if (node.duplicateKeyDetected && node.keySecurityIssueDetails) {
        const existingDetails = node.keySecurityIssueDetails;
        if (existingDetails.includes('Key shared with')) {
          combinedDetails = `${details}; ${existingDetails}`;
        } else {
          combinedDetails = details;
        }
      }
    } else if (!keyIsLowEntropy) {
      // Clearing low-entropy flag: preserve only duplicate-related info
      if (node.duplicateKeyDetected && node.keySecurityIssueDetails) {
        const existingDetails = node.keySecurityIssueDetails;
        // Only keep details if they're about key sharing (duplicate detection)
        if (existingDetails.includes('Key shared with')) {
          combinedDetails = existingDetails.replace(/Known low-entropy key[;,]?\s*/gi, '').trim();
        } else {
          // If no duplicate info, clear details entirely
          combinedDetails = '';
        }
      } else {
        // No duplicate flag, clear details entirely
        combinedDetails = '';
      }
    }

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.keyIsLowEntropy = keyIsLowEntropy;
        cachedNode.keySecurityIssueDetails = combinedDetails || undefined;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.updateNodeLowEntropyFlag(nodeNum, keyIsLowEntropy, combinedDetails || undefined, sourceId).catch(err => {
          logger.error(`Failed to update node low entropy flag in database:`, err);
        });
      }
      return;
    }

    // SQLite: synchronous update, scoped per-source.
    this.nodesRepo!.updateNodeLowEntropyFlagSqlite(nodeNum, keyIsLowEntropy, combinedDetails || null, sourceId);
  }

  /**
   * Get packet counts per node for the last hour (for spam detection)
   * Returns an array of { nodeNum, packetCount }
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  getPacketCountsPerNodeLastHour(): Array<{ nodeNum: number; packetCount: number }> {
    const oneHourAgo = Date.now() - 3600000;

    // For PostgreSQL/MySQL, use async method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Return empty array and caller should use async version
      logger.warn('getPacketCountsPerNodeLastHour() called for non-SQLite database - use async version');
      return [];
    }

    // Get local node number to exclude internal traffic
    const localNodeNumStr = this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    return this.miscRepo!.getPacketCountsPerNodeSinceSync({
      since: oneHourAgo,
      localNodeNum,
    });
  }

  /**
   * Get packet counts per node for the last hour (async version)
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  async getPacketCountsPerNodeLastHourAsync(sourceId?: string): Promise<Array<{ nodeNum: number; packetCount: number }>> {
    const oneHourAgo = Date.now() - 3600000;

    // Get local node number (per-source if provided) to exclude internal traffic
    const localNodeNumStr = sourceId
      ? await this.settings.getSettingForSource(sourceId, 'localNodeNum')
      : this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    return this.miscRepo!.getPacketCountsPerNodeSince({
      since: oneHourAgo,
      localNodeNum,
      sourceId,
    });
  }

  /**
   * Get top N broadcasters by packet count in the last hour
   * Returns node info with packet counts, sorted by count descending
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  async getTopBroadcastersAsync(limit: number = 5, sourceId?: string): Promise<Array<{ nodeNum: number; shortName: string | null; longName: string | null; packetCount: number }>> {
    const oneHourAgo = Date.now() - 3600000;

    // Get local node number to exclude internal traffic
    const localNodeNumStr = this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    return this.miscRepo!.getTopBroadcastersSince({
      since: oneHourAgo,
      limit,
      localNodeNum,
      sourceId,
    });
  }

  /**
   * Update the spam detection flags for a node, scoped per-source.
   */
  updateNodeSpamFlags(nodeNum: number, isExcessivePackets: boolean, packetRatePerHour: number, sourceId: string): void {
    const now = Math.floor(Date.now() / 1000);

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        (cachedNode as any).isExcessivePackets = isExcessivePackets;
        (cachedNode as any).packetRatePerHour = packetRatePerHour;
        (cachedNode as any).packetRateLastChecked = now;
        cachedNode.updatedAt = Date.now();
      }

      // Fire-and-forget database update
      this.updateNodeSpamFlagsAsync(nodeNum, isExcessivePackets, packetRatePerHour, now, sourceId).catch(err => {
        logger.error(`Failed to update node spam flags in database:`, err);
      });
      return;
    }

    // SQLite: synchronous update
    this.nodesRepo!.updateNodeSpamFlagsSqlite(nodeNum, isExcessivePackets, packetRatePerHour, now, sourceId);
  }

  /**
   * Update the spam detection flags for a node (async), scoped per-source.
   */
  async updateNodeSpamFlagsAsync(nodeNum: number, isExcessivePackets: boolean, packetRatePerHour: number, lastChecked: number, sourceId: string): Promise<void> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      await this.nodesRepo!.updateNodeExcessivePacketsAsync(
        nodeNum,
        isExcessivePackets,
        packetRatePerHour,
        lastChecked,
        sourceId
      );
      return;
    }

    // SQLite: synchronous update
    this.nodesRepo!.updateNodeSpamFlagsSqlite(nodeNum, isExcessivePackets, packetRatePerHour, lastChecked, sourceId);
  }

  /**
   * Get all nodes with excessive packet rates (for security page)
   */
  getNodesWithExcessivePackets(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.iterateCache()) {
        if ((node as any).isExcessivePackets) {
          result.push(node);
        }
      }
      return result;
    }

    return this.nodesRepo!.getNodesWithExcessivePacketsSqlite() as unknown as DbNode[];
  }

  /**
   * Get all nodes with excessive packet rates (async)
   */
  async getNodesWithExcessivePacketsAsync(sourceId?: string): Promise<DbNode[]> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.iterateCache(sourceId)) {
        if ((node as any).isExcessivePackets) {
          result.push(node);
        }
      }
      return result;
    }

    if (sourceId) {
      return this.nodesRepo!.getNodesWithExcessivePacketsSqlite(sourceId) as unknown as DbNode[];
    }
    return this.getNodesWithExcessivePackets();
  }

  /**
   * Update the time offset detection flags for a node (sync facade).
   * sourceId is required post-migration 029 since (nodeNum, sourceId) is the PK.
   */
  updateNodeTimeOffsetFlags(nodeNum: number, isTimeOffsetIssue: boolean, timeOffsetSeconds: number | null, sourceId: string): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        (cachedNode as any).isTimeOffsetIssue = isTimeOffsetIssue;
        (cachedNode as any).timeOffsetSeconds = timeOffsetSeconds;
        cachedNode.updatedAt = Date.now();
      }

      // Fire-and-forget database update
      this.updateNodeTimeOffsetFlagsAsync(nodeNum, isTimeOffsetIssue, timeOffsetSeconds, sourceId).catch(err => {
        logger.error(`Failed to update node time offset flags in database:`, err);
      });
      return;
    }

    // SQLite: synchronous update, scoped by sourceId
    this.nodesRepo!.updateNodeTimeOffsetFlagsSqlite(nodeNum, isTimeOffsetIssue, timeOffsetSeconds, sourceId);
  }

  /**
   * Update the time offset detection flags for a node (async).
   * sourceId is required post-migration 029.
   */
  async updateNodeTimeOffsetFlagsAsync(nodeNum: number, isTimeOffsetIssue: boolean, timeOffsetSeconds: number | null, sourceId: string): Promise<void> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      await this.nodesRepo!.updateNodeTimeOffsetAsync(
        nodeNum,
        isTimeOffsetIssue,
        timeOffsetSeconds,
        sourceId
      );
      return;
    }

    // SQLite
    this.nodesRepo!.updateNodeTimeOffsetFlagsSqlite(nodeNum, isTimeOffsetIssue, timeOffsetSeconds, sourceId);
  }

  /**
   * Get all nodes with time offset issues (for security page)
   */
  getNodesWithTimeOffsetIssues(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.iterateCache()) {
        if ((node as any).isTimeOffsetIssue) {
          result.push(node);
        }
      }
      return result;
    }

    return this.nodesRepo!.getNodesWithTimeOffsetIssuesSqlite() as unknown as DbNode[];
  }

  /**
   * Get all nodes with time offset issues (async)
   */
  async getNodesWithTimeOffsetIssuesAsync(sourceId?: string): Promise<DbNode[]> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.iterateCache(sourceId)) {
        if ((node as any).isTimeOffsetIssue) {
          result.push(node);
        }
      }
      return result;
    }

    if (sourceId) {
      return this.nodesRepo!.getNodesWithTimeOffsetIssuesSqlite(sourceId) as unknown as DbNode[];
    }
    return this.getNodesWithTimeOffsetIssues();
  }

  /**
   * Get the latest telemetry record with non-null packetTimestamp per node
   */
  async getLatestPacketTimestampsPerNodeAsync(sourceId?: string): Promise<Array<{ nodeNum: number; timestamp: number; packetTimestamp: number }>> {
    // Jan 1 2020 in ms — anything earlier is not a valid Meshtastic timestamp
    // (nodes without GPS/NTP often report 0 or boot-relative seconds)
    const MIN_VALID_TIMESTAMP_MS = 1577836800000;

    return this.telemetry.getLatestPacketTimestampsPerNode(MIN_VALID_TIMESTAMP_MS, sourceId);
  }

  // Message operations
  // Returns true if the message was actually inserted (not a duplicate)
  insertMessage(messageData: DbMessage): boolean {
    // For PostgreSQL/MySQL, fire-and-forget async insert
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Check cache for duplicate before inserting
      const existsInCache = this._messagesCache.some(m => m.id === messageData.id);
      if (existsInCache) {
        return false;
      }
      if (this.messagesRepo) {
        this.messagesRepo.insertMessage(messageData).catch((error) => {
          logger.error(`[DatabaseService] Failed to insert message: ${error}`);
        });
      }
      // Also add to cache immediately so delivery state updates can find it
      this._messagesCache.unshift(messageData);
      // Keep cache size reasonable
      if (this._messagesCache.length > 500) {
        this._messagesCache.pop();
      }
      return true;
    }

    // SQLite synchronous path - delegate to MessagesRepository Drizzle sync variant.
    // INSERT OR IGNORE semantics preserved via onConflictDoNothing().
    if (this.messagesRepo) {
      return this.messagesRepo.insertMessageSqlite(messageData as any);
    }
    return false;
  }

  getMessage(id: string): DbMessage | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.find(m => m.id === id) ?? null;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      const msg = this.messagesRepo.getMessageSqlite(id);
      return msg ? this.convertRepoMessage(msg as any) : null;
    }
    return null;
  }

  getMessageByRequestId(requestId: number): DbMessage | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.find(m => m.requestId === requestId) ?? null;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      const msg = this.messagesRepo.getMessageByRequestIdSqlite(requestId);
      return msg ? this.convertRepoMessage(msg as any) : null;
    }
    return null;
  }

  async getMessageByRequestIdAsync(requestId: number): Promise<DbMessage | null> {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        const msg = await this.messagesRepo.getMessageByRequestId(requestId);
        return msg ? this.convertRepoMessage(msg) : null;
      }
      return null;
    }
    // For SQLite, use sync method
    return this.getMessageByRequestId(requestId);
  }

  async getMessagesAsync(limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        const messages = await this.messagesRepo.getMessages(limit, offset);
        return messages.map(msg => this.convertRepoMessage(msg));
      }
      return [];
    }
    // For SQLite, use sync method
    return this.getMessages(limit, offset);
  }

  // Internal cache for messages (used for PostgreSQL sync compatibility)
  private _messagesCache: DbMessage[] = [];
  private _messagesCacheChannel: Map<number, DbMessage[]> = new Map();

  // Helper to convert repo DbMessage to local DbMessage (null -> undefined)
  private convertRepoMessage(msg: import('../db/types.js').DbMessage): DbMessage {
    return {
      id: msg.id,
      fromNodeNum: msg.fromNodeNum,
      toNodeNum: msg.toNodeNum,
      fromNodeId: msg.fromNodeId,
      toNodeId: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      timestamp: msg.timestamp,
      createdAt: msg.createdAt,
      portnum: msg.portnum ?? undefined,
      requestId: msg.requestId ?? undefined,
      rxTime: msg.rxTime ?? undefined,
      hopStart: msg.hopStart ?? undefined,
      hopLimit: msg.hopLimit ?? undefined,
      relayNode: msg.relayNode ?? undefined,
      replyId: msg.replyId ?? undefined,
      emoji: msg.emoji ?? undefined,
      viaMqtt: msg.viaMqtt ?? undefined,
      rxSnr: msg.rxSnr ?? undefined,
      rxRssi: msg.rxRssi ?? undefined,
      ackFailed: msg.ackFailed ?? undefined,
      deliveryState: msg.deliveryState ?? undefined,
      wantAck: msg.wantAck ?? undefined,
      routingErrorReceived: msg.routingErrorReceived ?? undefined,
      ackFromNode: msg.ackFromNode ?? undefined,
    };
  }

  getMessages(limit: number = 100, offset: number = 0): DbMessage[] {
    // For PostgreSQL/MySQL, use async repo and cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        // Fire async query and update cache in background
        this.messagesRepo.getMessages(limit, offset).then(messages => {
          // Build a map of current delivery states to preserve local updates
          // (async DB update may not have completed yet)
          const currentDeliveryStates = new Map<number, { deliveryState: string; ackFailed: boolean }>();
          for (const msg of this._messagesCache) {
            const requestId = (msg as any).requestId;
            const deliveryState = (msg as any).deliveryState;
            // Only preserve non-pending states (they're local updates that may not be in DB yet)
            if (requestId && deliveryState && deliveryState !== 'pending') {
              currentDeliveryStates.set(requestId, {
                deliveryState,
                ackFailed: (msg as any).ackFailed ?? false
              });
            }
          }
          // Convert and merge, preserving local delivery state updates
          this._messagesCache = messages.map(m => {
            const converted = this.convertRepoMessage(m);
            const requestId = (converted as any).requestId;
            const preserved = requestId ? currentDeliveryStates.get(requestId) : undefined;
            if (preserved && (!(converted as any).deliveryState || (converted as any).deliveryState === 'pending')) {
              (converted as any).deliveryState = preserved.deliveryState;
              (converted as any).ackFailed = preserved.ackFailed;
            }
            return converted;
          });
        }).catch(err => logger.debug('Failed to fetch messages:', err));
      }
      return this._messagesCache;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      const rows = this.messagesRepo.getMessagesSqlite(limit, offset);
      return rows.map(msg => this.convertRepoMessage(msg as any));
    }
    return [];
  }

  getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0): DbMessage[] {
    // For PostgreSQL/MySQL, use async repo and cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        // Fire async query and update cache in background
        this.messagesRepo.getMessagesByChannel(channel, limit, offset).then(messages => {
          // Build a map of current delivery states to preserve local updates
          const currentCache = this._messagesCacheChannel.get(channel) || [];
          const currentDeliveryStates = new Map<number, { deliveryState: string; ackFailed: boolean }>();
          for (const msg of currentCache) {
            const requestId = (msg as any).requestId;
            const deliveryState = (msg as any).deliveryState;
            if (requestId && deliveryState && deliveryState !== 'pending') {
              currentDeliveryStates.set(requestId, {
                deliveryState,
                ackFailed: (msg as any).ackFailed ?? false
              });
            }
          }
          // Convert and merge, preserving local delivery state updates
          const updatedCache = messages.map(m => {
            const converted = this.convertRepoMessage(m);
            const requestId = (converted as any).requestId;
            const preserved = requestId ? currentDeliveryStates.get(requestId) : undefined;
            if (preserved && (!(converted as any).deliveryState || (converted as any).deliveryState === 'pending')) {
              (converted as any).deliveryState = preserved.deliveryState;
              (converted as any).ackFailed = preserved.ackFailed;
            }
            return converted;
          });
          this._messagesCacheChannel.set(channel, updatedCache);
        }).catch(err => logger.debug('Failed to fetch channel messages:', err));
      }
      return this._messagesCacheChannel.get(channel) || [];
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      const rows = this.messagesRepo.getMessagesByChannelSqlite(channel, limit, offset);
      return rows.map(msg => this.convertRepoMessage(msg as any));
    }
    return [];
  }

  // Direct messages methods moved to MessagesRepository (databaseService.messages.getDirectMessages)

  getMessagesAfterTimestamp(timestamp: number): DbMessage[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache
        .filter(m => m.timestamp > timestamp)
        .sort((a, b) => a.timestamp - b.timestamp);
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      const rows = this.messagesRepo.getMessagesAfterTimestampSqlite(timestamp);
      return rows.map(msg => this.convertRepoMessage(msg as any));
    }
    return [];
  }

  async searchMessagesAsync(options: {
    query: string;
    caseSensitive?: boolean;
    scope?: 'all' | 'channels' | 'dms';
    channels?: number[];
    fromNodeId?: string;
    startDate?: number;
    endDate?: number;
    limit?: number;
    offset?: number;
  }): Promise<{ messages: DbMessage[]; total: number }> {
    const result = await this.messages.searchMessages(options);
    return {
      messages: result.messages.map(msg => this.convertRepoMessage(msg)),
      total: result.total,
    };
  }

  // Statistics
  getMessageCount(): number {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.length;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.getMessageCountSqlite();
    }
    return 0;
  }

  getNodeCount(): number {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getNodeCount() called before cache initialized`);
        return 0;
      }
      return this.nodesCache.size;
    }
    return this.nodesRepo!.getNodeCountSqlite();
  }

  getTelemetryCount(): number {
    // For PostgreSQL/MySQL, telemetry is not cached and count is only used for stats
    // Return 0 as telemetry count is not critical for operation
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }
    return this.telemetry.getTelemetryCountSync();
  }

  /** @deprecated Use databaseService.telemetry.getTelemetryCount() instead */
  async getTelemetryCountAsync(): Promise<number> {
    return this.telemetry.getTelemetryCount();
  }

  getTelemetryCountByNode(nodeId: string, sinceTimestamp?: number, beforeTimestamp?: number, telemetryType?: string): number {
    // For PostgreSQL/MySQL, telemetry count is async - return 0 for now
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }
    return this.telemetry.getTelemetryCountByNodeSync(nodeId, sinceTimestamp, beforeTimestamp, telemetryType);
  }

  /** @deprecated Use databaseService.telemetry.getTelemetryCountByNode() instead */
  async getTelemetryCountByNodeAsync(
    nodeId: string,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    telemetryType?: string
  ): Promise<number> {
    return this.telemetry.getTelemetryCountByNode(nodeId, sinceTimestamp, beforeTimestamp, telemetryType);
  }

  /**
   * Update node mobility status based on position telemetry
   * Checks if a node has moved more than 100 meters based on its last 500 position records
   * @param nodeId The node ID to check
   * @returns The updated mobility status (0 = stationary, 1 = mobile)
   */
  updateNodeMobility(nodeId: string): number {
    try {
      // For PostgreSQL/MySQL, mobility detection requires async telemetry queries
      // Use updateNodeMobilityAsync instead
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        return 0;
      }

      // Get last 500 position telemetry records for this node
      // Using a larger limit ensures we capture movement over a longer time period
      const positionTelemetry = this.getPositionTelemetryByNode(nodeId, 500);

      const latitudes = positionTelemetry.filter(t => t.telemetryType === 'latitude');
      const longitudes = positionTelemetry.filter(t => t.telemetryType === 'longitude');

      let isMobile = 0;

      // Need at least 2 position records to detect movement
      if (latitudes.length >= 2 && longitudes.length >= 2) {
        const latValues = latitudes.map(t => t.value);
        const lonValues = longitudes.map(t => t.value);

        const minLat = Math.min(...latValues);
        const maxLat = Math.max(...latValues);
        const minLon = Math.min(...lonValues);
        const maxLon = Math.max(...lonValues);

        // Calculate distance between min/max corners using Haversine formula
        const R = 6371; // Earth's radius in km
        const dLat = (maxLat - minLat) * Math.PI / 180;
        const dLon = (maxLon - minLon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(minLat * Math.PI / 180) * Math.cos(maxLat * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If movement is greater than 100 meters (0.1 km), mark as mobile
        isMobile = distance > 0.1 ? 1 : 0;

        logger.debug(`📍 Node ${nodeId} mobility check: ${latitudes.length} positions, distance=${distance.toFixed(3)}km, mobile=${isMobile}`);
      }

      // Update the mobile flag in the database
      this.nodesRepo!.updateNodeMobilitySqlite(nodeId, isMobile);

      return isMobile;
    } catch (error) {
      logger.error(`Failed to update mobility for node ${nodeId}:`, error);
      return 0; // Default to non-mobile on error
    }
  }

  /**
   * Async version of updateNodeMobility - works for all database backends
   * Detects if a node has moved more than 100 meters based on position history
   * @param nodeId The node ID to check
   * @returns The updated mobility status (0 = stationary, 1 = mobile)
   */
  async updateNodeMobilityAsync(nodeId: string): Promise<number> {
    try {
      // Get last 500 position telemetry records for this node
      // Using a larger limit ensures we capture movement over a longer time period
      // (50 was too small - nodes parked for a while would show only recent stationary positions)
      const positionTelemetry = this.telemetryRepo
        ? await this.telemetryRepo.getPositionTelemetryByNode(nodeId, 500)
        : this.getPositionTelemetryByNode(nodeId, 500);

      const latitudes = positionTelemetry.filter(t => t.telemetryType === 'latitude');
      const longitudes = positionTelemetry.filter(t => t.telemetryType === 'longitude');

      let isMobile = 0;

      // Need at least 2 position records to detect movement
      if (latitudes.length >= 2 && longitudes.length >= 2) {
        const latValues = latitudes.map(t => t.value);
        const lonValues = longitudes.map(t => t.value);

        const minLat = Math.min(...latValues);
        const maxLat = Math.max(...latValues);
        const minLon = Math.min(...lonValues);
        const maxLon = Math.max(...lonValues);

        // Calculate distance between min/max corners using Haversine formula
        const R = 6371; // Earth's radius in km
        const dLat = (maxLat - minLat) * Math.PI / 180;
        const dLon = (maxLon - minLon) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(minLat * Math.PI / 180) * Math.cos(maxLat * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If movement is greater than 100 meters (0.1 km), mark as mobile
        isMobile = distance > 0.1 ? 1 : 0;

        logger.debug(`📍 Node ${nodeId} mobility check: ${latitudes.length} positions, distance=${distance.toFixed(3)}km, mobile=${isMobile}`);
      }

      // Update the mobile flag in the database using repository
      if (this.nodesRepo) {
        await this.nodesRepo.updateNodeMobility(nodeId, isMobile);
      }

      // Also update the cache so getAllNodes() returns the updated value
      for (const [key, cachedNode] of this.nodesCache.entries()) {
        if (cachedNode.nodeId === nodeId) {
          cachedNode.mobile = isMobile;
          this.nodesCache.set(key, cachedNode);
          break;
        }
      }

      return isMobile;
    } catch (error) {
      logger.error(`Failed to update mobility for node ${nodeId}:`, error);
      return 0; // Default to non-mobile on error
    }
  }

  getMessagesByDay(days: number = 7): Array<{ date: string; count: number }> {
    // For PostgreSQL/MySQL, return empty array - stats are async
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.getMessagesByDaySqlite(days);
    }
    return [];
  }

  async getMessagesByDayAsync(days: number = 7, sourceId?: string): Promise<Array<{ date: string; count: number }>> {
    if (this.messagesRepo) {
      return this.messagesRepo.getMessagesByDay(days, sourceId);
    }
    return [];
  }

  // Cleanup operations
  cleanupOldMessages(days: number = 30): number {
    // For PostgreSQL/MySQL, fire-and-forget async cleanup
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.cleanupOldMessages(days).catch(err => {
          logger.debug('Failed to cleanup old messages:', err);
        });
      }
      return 0;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.cleanupOldMessagesSqlite(days);
    }
    return 0;
  }

  cleanupInactiveNodes(days: number = 30): number {
    // For PostgreSQL/MySQL, fire-and-forget async cleanup
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.nodesRepo) {
        const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
        this.nodesRepo.deleteInactiveNodes(cutoff).catch(err => {
          logger.debug('Failed to cleanup inactive nodes:', err);
        });
      }
      return 0;
    }

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    // Skip nodes that are ignored - they should persist even if inactive
    return this.nodesRepo!.deleteInactiveNodesSqlite(cutoff);
  }

  // Message deletion operations
  deleteMessage(id: string): boolean {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.deleteMessage(id).catch(err => {
          logger.debug('Failed to delete message:', err);
        });
      }
      return true;
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.deleteMessageSqlite(id);
    }
    return false;
  }

  purgeChannelMessages(channel: number, sourceId?: string): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.purgeChannelMessages(channel, sourceId).catch(err => {
          logger.debug('Failed to purge channel messages:', err);
        });
      }
      return 0;
    }

    // SQLite: dispatch to Drizzle-backed repo sync helper. Column names come
    // from the schema, so the `sourceId` vs `source_id` mismatch that caused
    // issue #2631 on SQLite can't recur.
    if (this.messagesRepo) {
      return this.messagesRepo.purgeChannelMessagesSqlite(channel, sourceId);
    }
    return 0;
  }

  purgeDirectMessages(nodeNum: number, sourceId?: string): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.purgeDirectMessages(nodeNum, sourceId).catch(err => {
          logger.debug('Failed to purge direct messages:', err);
        });
      }
      return 0;
    }

    // SQLite: dispatch to Drizzle-backed repo sync helper.
    if (this.messagesRepo) {
      return this.messagesRepo.purgeDirectMessagesSqlite(nodeNum, sourceId);
    }
    return 0;
  }

  purgeNodeTraceroutes(nodeNum: number): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.deleteTraceroutesForNode(nodeNum).catch(err => {
          logger.debug('Failed to purge node traceroutes:', err);
        });
      }
      return 0;
    }

    // Delete all traceroutes involving this node (either as source or destination)
    return this.traceroutes.deleteTraceroutesInvolvingNodeSync(nodeNum);
  }

  purgeNodeTelemetry(nodeNum: number): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        this.telemetryRepo.deleteTelemetryByNode(nodeNum).catch(err => {
          logger.debug('Failed to purge node telemetry:', err);
        });
      }
      return 0;
    }

    // Delete all telemetry data for this node
    return this.telemetry.deleteTelemetryByNodeSync(nodeNum);
  }

  deleteNode(nodeNum: number, sourceId: string): {
    messagesDeleted: number;
    traceroutesDeleted: number;
    telemetryDeleted: number;
    nodeDeleted: boolean;
  } {
    // For PostgreSQL/MySQL, update cache and fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Remove from cache immediately (scoped lookup)
      const key = this.cacheKey(nodeNum, sourceId);
      const existed = this.nodesCache.has(key);
      if (existed) {
        this.nodesCache.delete(key);
      }

      // Fire-and-forget async deletion of all associated data
      this.deleteNodeAsync(nodeNum, sourceId).catch(err => {
        logger.error(`Failed to delete node ${nodeNum}@${sourceId} from database:`, err);
      });

      // Return immediately with cache-based result
      // Actual counts not available in sync method for PostgreSQL
      return {
        messagesDeleted: 0, // Unknown in sync mode
        traceroutesDeleted: 0,
        telemetryDeleted: 0,
        nodeDeleted: existed
      };
    }

    // SQLite: synchronous deletion
    // Delete all data associated with the node and then the node itself

    // Delete DMs to/from this node
    const dmsDeleted = this.purgeDirectMessages(nodeNum);

    // Also delete broadcast/channel messages FROM this node
    // (messages the deleted node sent to public channels).
    // SQLite: delegate to Drizzle sync variant.
    const broadcastDeleted = this.messagesRepo
      ? this.messagesRepo.deleteBroadcastMessagesFromNodeSqlite(nodeNum)
      : 0;

    const messagesDeleted = dmsDeleted + broadcastDeleted;
    const traceroutesDeleted = this.purgeNodeTraceroutes(nodeNum);
    const telemetryDeleted = this.purgeNodeTelemetry(nodeNum);

    // Delete route segments where this node is involved
    this.traceroutes.deleteRouteSegmentsInvolvingNodeSync(nodeNum);

    // Delete neighbor_info records where this node is involved (either as source or neighbor)
    if (this.neighborsRepo) {
      this.neighborsRepo.deleteNeighborInfoInvolvingNode(nodeNum).catch(err =>
        logger.debug('Failed to delete neighbor info involving node:', err)
      );
    }

    // Delete the node from the nodes table (scoped to sourceId)
    const nodeDeleted = this.nodesRepo!.deleteNodeSqlite(nodeNum, sourceId);

    return {
      messagesDeleted,
      traceroutesDeleted,
      telemetryDeleted,
      nodeDeleted
    };
  }



  // Helper function to convert BigInt values to numbers
  private normalizeBigInts(obj: any): any {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'bigint') {
      return Number(obj);
    }

    if (typeof obj === 'object') {
      const normalized: any = Array.isArray(obj) ? [] : {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          normalized[key] = this.normalizeBigInts(obj[key]);
        }
      }
      return normalized;
    }

    return obj;
  }

  /**
   * Attempt to open a SQLite database, with automatic recovery from stale WAL/SHM files.
   *
   * After a version upgrade (e.g. new Node.js or better-sqlite3), the shared memory
   * file (.db-shm) left by the previous version may be incompatible, causing
   * SQLITE_IOERR_SHMSIZE. This method detects that error, removes the stale .db-shm
   * file, and retries the open — SQLite reconstructs what it needs from the WAL.
   */
  private openSqliteDatabase(dbPath: string, dbDir: string): BetterSqlite3Database.Database {
    const attemptOpen = (): BetterSqlite3Database.Database => {
      const db = new BetterSqlite3Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      return db;
    };

    try {
      return attemptOpen();
    } catch (error: unknown) {
      const err = error as Error & { code?: string };

      // Stale SHM file from a previous version — remove it and retry
      const shmPath = `${dbPath}-shm`;
      const isShmError = err.code === 'SQLITE_IOERR_SHMSIZE' || err.code === 'SQLITE_IOERR_SHMMAP';
      if (isShmError) {
        logger.warn('⚠️  SQLite SHM file appears stale (common after upgrades)');
        logger.warn(`   Removing ${shmPath} and retrying — data is safe in the WAL`);
        fs.rmSync(shmPath, { force: true });
        try {
          return attemptOpen();
        } catch (retryError: unknown) {
          const retryErr = retryError as Error & { code?: string };
          logger.error('❌ DATABASE OPEN ERROR ❌');
          logger.error('═══════════════════════════════════════════════════════════');
          logger.error(`Failed to open SQLite database at: ${dbPath}`);
          logger.error(`Retry after SHM removal also failed: ${retryErr.message}`);
          throw retryError;
        }
      }

      // Other errors — log diagnostics
      logger.error('❌ DATABASE OPEN ERROR ❌');
      logger.error('═══════════════════════════════════════════════════════════');
      logger.error(`Failed to open SQLite database at: ${dbPath}`);
      logger.error('');

      if (err.code === 'SQLITE_CANTOPEN') {
        logger.error('SQLITE_CANTOPEN - Unable to open database file.');
        logger.error('');
        logger.error('Common causes:');
        logger.error('  1. Directory permissions - the database directory is not writable');
        logger.error('  2. Missing volume mount - check your docker-compose.yml');
        logger.error('  3. Disk space - ensure the filesystem is not full');
        logger.error('  4. File locked by another process');
        logger.error('');
        logger.error('Troubleshooting steps:');
        logger.error('  1. Check directory permissions:');
        logger.error(`     ls -la ${dbDir}`);
        logger.error('  2. Check disk space:');
        logger.error('     df -h');
        logger.error('  3. Verify Docker volume mount (if using Docker):');
        logger.error('     docker compose config | grep volumes -A 5');
      } else {
        logger.error(`Error: ${err.message}`);
        logger.error(`Error code: ${err.code || 'unknown'}`);
      }

      throw error;
    }
  }

  close(): void {
    // For PostgreSQL/MySQL, we don't have a direct close method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug('Closing PostgreSQL/MySQL connection');
      return;
    }

    if (this.db) {
      // Checkpoint WAL to prevent stale SHM files after container restarts/upgrades
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (error) {
        logger.warn('WAL checkpoint failed during shutdown:', error);
      }
      this.db.close();
    }
  }

  // Export/Import functionality
  exportData(): { nodes: DbNode[]; messages: DbMessage[] } {
    return {
      nodes: this.getAllNodes(),
      messages: this.getMessages(10000) // Export last 10k messages
    };
  }

  importData(data: { nodes: DbNode[]; messages: DbMessage[] }): void {
    // For PostgreSQL/MySQL, this method is not supported (use dedicated backup/restore)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error('importData is not supported for PostgreSQL/MySQL. Use dedicated backup/restore functionality.');
    }

    const transaction = this.db.transaction(() => {
      // Clear existing data
      if (this.messagesRepo) {
        this.messagesRepo.deleteAllMessagesSqlite();
      }
      this.nodesRepo!.truncateNodesSqlite();

      // Import nodes via repository
      for (const node of data.nodes) {
        this.nodesRepo!.importNodeSqlite(node);
      }

      // Import messages — delegate to the Drizzle-backed sync variant so
      // column mapping matches the schema. insertMessageSqlite uses INSERT
      // OR IGNORE which is safe on re-import (no duplicate-key failures).
      if (this.messagesRepo) {
        for (const message of data.messages) {
          this.messagesRepo.insertMessageSqlite(message as any);
        }
      }
    });

    transaction();
  }

  // Channel operations
  upsertChannel(channelData: { id?: number; name: string; psk?: string; role?: number; uplinkEnabled?: boolean; downlinkEnabled?: boolean; positionPrecision?: number }): void {
    const now = Date.now();

    // Defensive checks for channel roles:
    // 1. Channel 0 must NEVER be DISABLED (role=0) - it must be PRIMARY (role=1)
    // 2. Channels 1-7 must NEVER be PRIMARY (role=1) - they can only be SECONDARY (role=2) or DISABLED (role=0)
    // A mesh network requires exactly ONE PRIMARY channel, and Channel 0 is conventionally PRIMARY
    if (channelData.id === 0 && channelData.role === 0) {
      logger.warn(`⚠️  Blocking attempt to set Channel 0 role to DISABLED (0), forcing to PRIMARY (1)`);
      channelData = { ...channelData, role: 1 };  // Clone and override
    }

    if (channelData.id !== undefined && channelData.id > 0 && channelData.role === 1) {
      logger.warn(`⚠️  Blocking attempt to set Channel ${channelData.id} role to PRIMARY (1), forcing to SECONDARY (2)`);
      logger.warn(`⚠️  Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
      channelData = { ...channelData, role: 2 };  // Clone and override to SECONDARY
    }

    logger.info(`📝 upsertChannel called with ID: ${channelData.id}, name: "${channelData.name}" (length: ${channelData.name.length})`);

    // Channel ID is required - we no longer support name-based lookups
    // All channels must have a numeric ID for proper indexing
    if (channelData.id === undefined) {
      logger.error(`❌ Cannot upsert channel without ID. Name: "${channelData.name}"`);
      throw new Error('Channel ID is required for upsert operation');
    }

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const existingChannel = this.channelsCache.get(channelData.id);
      logger.info(`📝 getChannelById(${channelData.id}) returned: ${existingChannel ? `"${existingChannel.name}"` : 'null'}`);

      // Build the updated/new channel object
      const updatedChannel: DbChannel = {
        id: channelData.id,
        name: channelData.name,
        psk: channelData.psk ?? existingChannel?.psk,
        role: channelData.role ?? existingChannel?.role,
        uplinkEnabled: channelData.uplinkEnabled ?? existingChannel?.uplinkEnabled ?? true,
        downlinkEnabled: channelData.downlinkEnabled ?? existingChannel?.downlinkEnabled ?? true,
        positionPrecision: channelData.positionPrecision ?? existingChannel?.positionPrecision,
        createdAt: existingChannel?.createdAt ?? now,
        updatedAt: now,
      };

      // Update cache immediately
      this.channelsCache.set(channelData.id, updatedChannel);

      if (existingChannel) {
        logger.info(`📝 Updating channel ${existingChannel.id} from "${existingChannel.name}" to "${channelData.name}"`);
      } else {
        logger.debug(`📝 Creating new channel with ID: ${channelData.id}`);
      }

      // Fire and forget async update
      if (this.channelsRepo) {
        this.channelsRepo.upsertChannel({
          id: channelData.id,
          name: channelData.name,
          psk: channelData.psk,
          role: channelData.role,
          uplinkEnabled: channelData.uplinkEnabled,
          downlinkEnabled: channelData.downlinkEnabled,
          positionPrecision: channelData.positionPrecision,
        }).catch((error) => {
          logger.error(`[DatabaseService] Failed to upsert channel ${channelData.id}: ${error}`);
        });
      }
      return;
    }

    // SQLite path — route through ChannelsRepository
    if (channelData.id === undefined) {
      logger.error(`❌ Cannot upsert channel without ID. Name: "${channelData.name}"`);
      throw new Error('Channel ID is required for upsert operation');
    }
    this.channelsRepo!.upsertChannelSync({
      id: channelData.id,
      name: channelData.name,
      psk: channelData.psk,
      role: channelData.role,
      uplinkEnabled: channelData.uplinkEnabled,
      downlinkEnabled: channelData.downlinkEnabled,
      positionPrecision: channelData.positionPrecision,
    });
  }

  getChannelById(id: number): DbChannel | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getChannelById(${id}) called before cache initialized`);
        return null;
      }
      const channel = this.channelsCache.get(id) ?? null;
      if (id === 0) {
        logger.info(`🔍 getChannelById(0) - FROM CACHE: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
      }
      return channel;
    }
    const channel = this.channelsRepo!.getChannelByIdSync(id);
    return channel;
  }

  getAllChannels(): DbChannel[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getAllChannels() called before cache initialized`);
        return [];
      }
      return Array.from(this.channelsCache.values()).sort((a, b) => a.id - b.id);
    }
    return this.channelsRepo!.getAllChannelsSync();
  }

  getChannelCount(): number {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getChannelCount() called before cache initialized`);
        return 0;
      }
      return this.channelsCache.size;
    }
    return this.channelsRepo!.getChannelCountSync();
  }

  // Clean up invalid channels that shouldn't have been created
  // Meshtastic supports channels 0-7 (8 total channels)
  cleanupInvalidChannels(): number {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      let count = 0;
      for (const [id] of this.channelsCache) {
        if (id < 0 || id > 7) {
          this.channelsCache.delete(id);
          count++;
        }
      }
      // Fire and forget async cleanup
      if (this.channelsRepo) {
        this.channelsRepo.cleanupInvalidChannels().catch((error) => {
          logger.error(`[DatabaseService] Failed to cleanup invalid channels: ${error}`);
        });
      }
      logger.debug(`🧹 Cleaned up ${count} invalid channels (outside 0-7 range)`);
      return count;
    }
    const deleted = this.channelsRepo!.cleanupInvalidChannelsSync();
    logger.debug(`🧹 Cleaned up ${deleted} invalid channels (outside 0-7 range)`);
    return deleted;
  }

  // Clean up channels that appear to be empty/unused
  // Keep channels 0-1 (Primary and typically one active secondary)
  // Remove higher ID channels that have no PSK (not configured)
  cleanupEmptyChannels(): number {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      let count = 0;
      for (const [id, channel] of this.channelsCache) {
        if (id > 1 && channel.psk === null && channel.role === null) {
          this.channelsCache.delete(id);
          count++;
        }
      }
      // Fire and forget async cleanup
      if (this.channelsRepo) {
        this.channelsRepo.cleanupEmptyChannels().catch((error) => {
          logger.error(`[DatabaseService] Failed to cleanup empty channels: ${error}`);
        });
      }
      logger.debug(`🧹 Cleaned up ${count} empty channels (ID > 1, no PSK/role)`);
      return count;
    }
    const deleted = this.channelsRepo!.cleanupEmptyChannelsSync();
    logger.debug(`🧹 Cleaned up ${deleted} empty channels (ID > 1, no PSK/role)`);
    return deleted;
  }

  // Telemetry operations
  insertTelemetry(telemetryData: DbTelemetry, sourceId?: string): void {
    // For PostgreSQL/MySQL, fire-and-forget async insert
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        // Note: We removed the nodesCache check here because it was too aggressive -
        // it would skip telemetry for nodes that exist in the DB but not in the in-memory cache
        // (e.g., after server restart). The foreign key error handling below handles race conditions.
        this.telemetryRepo.insertTelemetry(telemetryData, sourceId).catch((error) => {
          // Ignore foreign key violations - node might not be persisted yet
          const errorStr = String(error);
          if (errorStr.includes('foreign key') || errorStr.includes('violates')) {
            logger.debug(`[DatabaseService] Telemetry insert skipped - node ${telemetryData.nodeNum} not yet persisted`);
          } else {
            logger.error(`[DatabaseService] Failed to insert telemetry: ${error}`);
          }
        });
      }
      // Invalidate the telemetry types cache since we may have added a new type
      this.invalidateTelemetryTypesCache();
      return;
    }

    this.telemetry.insertTelemetrySync(telemetryData, sourceId);

    // Invalidate the telemetry types cache since we may have added a new type
    this.invalidateTelemetryTypesCache();
  }

  /**
   * Async version of insertTelemetry - works with all database backends
   */
  async insertTelemetryAsync(telemetryData: DbTelemetry, sourceId?: string): Promise<void> {
    await this.telemetry.insertTelemetry(telemetryData, sourceId);
    this.invalidateTelemetryTypesCache();
  }

  getTelemetryByNode(nodeId: string, limit: number = 100, sinceTimestamp?: number, beforeTimestamp?: number, offset: number = 0, telemetryType?: string): DbTelemetry[] {
    return this.telemetry.getTelemetryByNodeSync(nodeId, limit, sinceTimestamp, beforeTimestamp, offset, telemetryType) as unknown as DbTelemetry[];
  }

  /** @deprecated Use databaseService.telemetry.getTelemetryByNode() instead */
  async getTelemetryByNodeAsync(
    nodeId: string,
    limit: number = 100,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    offset: number = 0,
    telemetryType?: string
  ): Promise<DbTelemetry[]> {
    // Cast to local DbTelemetry type (they have compatible structure)
    return this.telemetry.getTelemetryByNode(nodeId, limit, sinceTimestamp, beforeTimestamp, offset, telemetryType) as unknown as DbTelemetry[];
  }

  /**
   * Get only position-related telemetry (latitude, longitude, altitude, ground_speed, ground_track) for a node.
   * This is much more efficient than fetching all telemetry types - reduces data fetched by ~70%.
   *
   * NOTE: This sync method only works for SQLite. For PostgreSQL/MySQL, use getPositionTelemetryByNodeAsync().
   * Returns empty array for non-SQLite backends by design (sync DB access not supported).
   */
  getPositionTelemetryByNode(nodeId: string, limit: number = 1500, sinceTimestamp?: number): DbTelemetry[] {
    // INTENTIONAL: PostgreSQL/MySQL require async queries - use getPositionTelemetryByNodeAsync() instead
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    let query = `
      SELECT * FROM telemetry
      WHERE nodeId = ?
        AND telemetryType IN ('latitude', 'longitude', 'altitude', 'ground_speed', 'ground_track')
    `;
    const params: any[] = [nodeId];

    if (sinceTimestamp !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(sinceTimestamp);
    }

    query += `
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    params.push(limit);

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const telemetry = stmt.all(...params) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  /** @deprecated Use databaseService.telemetry.getPositionTelemetryByNode() instead */
  async getPositionTelemetryByNodeAsync(nodeId: string, limit: number = 1500, sinceTimestamp?: number): Promise<DbTelemetry[]> {
    // Cast to local DbTelemetry type (they have compatible structure)
    return this.telemetry.getPositionTelemetryByNode(nodeId, limit, sinceTimestamp) as unknown as Promise<DbTelemetry[]>;
  }

  /**
   * Get the latest estimated positions for all nodes in a single query.
   * This is much more efficient than querying each node individually (N+1 problem).
   * Returns a Map of nodeId -> { latitude, longitude } for nodes with estimated positions.
   */
  getAllNodesEstimatedPositions(): Map<string, { latitude: number; longitude: number }> {
    // For PostgreSQL/MySQL, estimated positions require async telemetry queries
    // Return empty map - estimated positions will be computed via API endpoints
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return new Map();
    }

    // Use a subquery to get the latest timestamp for each node/type combination,
    // then join to get the actual values. This avoids the N+1 query problem.
    const query = `
      WITH LatestEstimates AS (
        SELECT nodeId, telemetryType, MAX(timestamp) as maxTimestamp
        FROM telemetry
        WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
        GROUP BY nodeId, telemetryType
      )
      SELECT t.nodeId, t.telemetryType, t.value
      FROM telemetry t
      INNER JOIN LatestEstimates le
        ON t.nodeId = le.nodeId
        AND t.telemetryType = le.telemetryType
        AND t.timestamp = le.maxTimestamp
    `;

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const results = stmt.all() as Array<{ nodeId: string; telemetryType: string; value: number }>;

    // Build a map of nodeId -> { latitude, longitude }
    const positionMap = new Map<string, { latitude: number; longitude: number }>();

    for (const row of results) {
      const existing = positionMap.get(row.nodeId) || { latitude: 0, longitude: 0 };

      if (row.telemetryType === 'estimated_latitude') {
        existing.latitude = row.value;
      } else if (row.telemetryType === 'estimated_longitude') {
        existing.longitude = row.value;
      }

      positionMap.set(row.nodeId, existing);
    }

    // Filter out entries that don't have both lat and lon
    for (const [nodeId, pos] of positionMap) {
      if (pos.latitude === 0 || pos.longitude === 0) {
        positionMap.delete(nodeId);
      }
    }

    return positionMap;
  }

  async getAllNodesEstimatedPositionsAsync(): Promise<Map<string, { latitude: number; longitude: number }>> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const result = await client.query(`
          WITH "LatestEstimates" AS (
            SELECT "nodeId", "telemetryType", MAX(timestamp) as "maxTimestamp"
            FROM telemetry
            WHERE "telemetryType" IN ('estimated_latitude', 'estimated_longitude')
            GROUP BY "nodeId", "telemetryType"
          )
          SELECT t."nodeId", t."telemetryType", t.value
          FROM telemetry t
          INNER JOIN "LatestEstimates" le
            ON t."nodeId" = le."nodeId"
            AND t."telemetryType" = le."telemetryType"
            AND t.timestamp = le."maxTimestamp"
        `);
        return this.buildEstimatedPositionMap(result.rows);
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const [rows] = await pool.query(`
        WITH LatestEstimates AS (
          SELECT nodeId, telemetryType, MAX(timestamp) as maxTimestamp
          FROM telemetry
          WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
          GROUP BY nodeId, telemetryType
        )
        SELECT t.nodeId, t.telemetryType, t.value
        FROM telemetry t
        INNER JOIN LatestEstimates le
          ON t.nodeId = le.nodeId
          AND t.telemetryType = le.telemetryType
          AND t.timestamp = le.maxTimestamp
      `);
      return this.buildEstimatedPositionMap(rows as any[]);
    }
    return this.getAllNodesEstimatedPositions();
  }

  private buildEstimatedPositionMap(rows: Array<{ nodeId: string; telemetryType: string; value: number }>): Map<string, { latitude: number; longitude: number }> {
    const positionMap = new Map<string, { latitude: number; longitude: number }>();
    for (const row of rows) {
      const existing = positionMap.get(row.nodeId) || { latitude: 0, longitude: 0 };
      if (row.telemetryType === 'estimated_latitude') {
        existing.latitude = Number(row.value);
      } else if (row.telemetryType === 'estimated_longitude') {
        existing.longitude = Number(row.value);
      }
      positionMap.set(row.nodeId, existing);
    }
    for (const [nodeId, pos] of positionMap) {
      if (pos.latitude === 0 || pos.longitude === 0) {
        positionMap.delete(nodeId);
      }
    }
    return positionMap;
  }

  /**
   * Get recent estimated positions for a specific node.
   * Returns position estimates with timestamps for time-weighted averaging.
   * @param nodeNum - The node number to get estimates for
   * @param limit - Maximum number of estimates to return (default 10)
   * @returns Array of { latitude, longitude, timestamp } sorted by timestamp descending
   */
  async getRecentEstimatedPositionsAsync(nodeNum: number, limit: number = 10): Promise<Array<{ latitude: number; longitude: number; timestamp: number }>> {
    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    return this.telemetry.getRecentEstimatedPositions(nodeId, limit);
  }

  /**
   * Get smart hops statistics for a node.
   * Returns min/max/avg hop counts aggregated into time buckets.
   *
   * @param nodeId - Node ID to get statistics for (e.g., '!abcd1234')
   * @param sinceTimestamp - Only include telemetry after this timestamp
   * @param intervalMinutes - Time bucket interval in minutes (default: 15)
   * @returns Array of time-bucketed hop statistics
   */
  async getSmartHopsStatsAsync(
    nodeId: string,
    sinceTimestamp: number,
    intervalMinutes: number = 15
  ): Promise<Array<{ timestamp: number; minHops: number; maxHops: number; avgHops: number }>> {
    return this.telemetry.getSmartHopsStats(nodeId, sinceTimestamp, intervalMinutes);
  }

  /**
   * Get link quality history for a node.
   * Returns link quality values over time for graphing.
   *
   * @param nodeId - Node ID to get history for (e.g., '!abcd1234')
   * @param sinceTimestamp - Only include telemetry after this timestamp
   * @returns Array of { timestamp, quality } records
   */
  async getLinkQualityHistoryAsync(
    nodeId: string,
    sinceTimestamp: number
  ): Promise<Array<{ timestamp: number; quality: number }>> {
    return this.telemetry.getLinkQualityHistory(nodeId, sinceTimestamp);
  }

  /**
   * Get all traceroutes for position recalculation.
   * Returns traceroutes with route data, ordered by timestamp for chronological processing.
   */
  getAllTraceroutesForRecalculation(): Array<{
    id: number;
    fromNodeNum: number;
    toNodeNum: number;
    route: string | null;
    snrTowards: string | null;
    timestamp: number;
  }> {
    // For PostgreSQL/MySQL, this is typically only needed for migration purposes
    // Since PostgreSQL starts fresh without historical traceroutes, return empty array
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    return this.traceroutesRepo!.getCompletedTraceroutesForMigrationSync();
  }

  /**
   * Delete all estimated position telemetry records.
   * Used during migration to force recalculation with new algorithm.
   */
  deleteAllEstimatedPositions(): number {
    return this.telemetry.deleteAllEstimatedPositionsSync();
  }

  // Cache for PostgreSQL telemetry data
  private _telemetryCache: Map<string, DbTelemetry[]> = new Map();

  getTelemetryByNodeAveraged(nodeId: string, sinceTimestamp?: number, intervalMinutes?: number, maxHours?: number, sourceId?: string): DbTelemetry[] {
    // For PostgreSQL/MySQL, use async repo and cache (no averaging yet)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cacheKey = `${nodeId}-${sinceTimestamp || 0}-${maxHours || 24}-${sourceId || 'all'}`;
      if (this.telemetryRepo) {
        // Calculate limit based on maxHours
        const limit = Math.min((maxHours || 24) * 60, 5000); // ~1 per minute, max 5000
        this.telemetryRepo.getTelemetryByNode(nodeId, limit, sinceTimestamp, undefined, 0, undefined, sourceId).then(telemetry => {
          // Convert to local DbTelemetry type
          this._telemetryCache.set(cacheKey, telemetry.map(t => ({
            id: t.id,
            nodeId: t.nodeId,
            nodeNum: t.nodeNum,
            telemetryType: t.telemetryType,
            timestamp: t.timestamp,
            value: t.value,
            unit: t.unit ?? undefined,
            createdAt: t.createdAt,
            packetTimestamp: t.packetTimestamp ?? undefined,
            channel: t.channel ?? undefined,
            precisionBits: t.precisionBits ?? undefined,
            gpsAccuracy: t.gpsAccuracy ?? undefined,
          })));
        }).catch(err => logger.debug('Failed to fetch telemetry:', err));
      }
      return this._telemetryCache.get(cacheKey) || [];
    }
    // Dynamic bucketing: automatically choose interval based on time range
    // This prevents data cutoff for long time periods or chatty nodes
    let actualIntervalMinutes = intervalMinutes;
    if (actualIntervalMinutes === undefined && maxHours !== undefined) {
      if (maxHours <= 24) {
        // Short period (0-24 hours): 3-minute intervals for high detail
        actualIntervalMinutes = 3;
      } else if (maxHours <= 168) {
        // Medium period (1-7 days): 30-minute intervals to reduce data points
        actualIntervalMinutes = 30;
      } else {
        // Long period (7+ days): 2-hour intervals for manageable data size
        actualIntervalMinutes = 120;
      }
    } else if (actualIntervalMinutes === undefined) {
      // Default to 3 minutes if no maxHours specified
      actualIntervalMinutes = 3;
    }

    // SQLite: delegate to Drizzle-backed repo sync helper. Keeps column names
    // aligned with the schema (fixes issue #2631 where raw SQL used
    // `source_id` while the schema column is `sourceId`).
    if (!this.telemetryRepo) {
      return [];
    }
    const rows = this.telemetryRepo.getTelemetryByNodeAveragedSqlite(
      nodeId,
      sinceTimestamp,
      actualIntervalMinutes,
      maxHours,
      sourceId
    );
    return rows.map(t => this.normalizeBigInts(t));
  }

  /**
   * Get packet rate statistics (packets per minute) for a node.
   * Calculates the rate of change between consecutive telemetry samples.
   *
   * @param nodeId - The node ID to fetch rates for
   * @param types - Array of telemetry types to calculate rates for
   * @param sinceTimestamp - Only fetch data after this timestamp (optional)
   * @returns Object mapping telemetry type to array of rate data points
   */
  getPacketRates(
    nodeId: string,
    types: string[],
    sinceTimestamp?: number,
    sourceId?: string
  ): Record<string, Array<{ timestamp: number; ratePerMinute: number }>> {
    const result: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};

    // For PostgreSQL/MySQL, packet rates not yet implemented - return empty
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      for (const type of types) {
        result[type] = [];
      }
      return result;
    }

    // Initialize result object for each type
    for (const type of types) {
      result[type] = [];
    }

    // Build query to fetch raw telemetry data ordered by timestamp ASC (oldest first)
    // We need consecutive samples to calculate deltas
    let query = `
      SELECT telemetryType, timestamp, value
      FROM telemetry
      WHERE nodeId = ?
        AND telemetryType IN (${types.map(() => '?').join(', ')})
    `;
    const params: (string | number)[] = [nodeId, ...types];

    if (sinceTimestamp !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(sinceTimestamp);
    }

    if (sourceId !== undefined) {
      query += ` AND sourceId = ?`;
      params.push(sourceId);
    }

    query += ` ORDER BY telemetryType, timestamp ASC`;

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      telemetryType: string;
      timestamp: number;
      value: number;
    }>;

    // Group by telemetry type
    const groupedByType: Record<string, Array<{ timestamp: number; value: number }>> = {};
    for (const row of rows) {
      if (!groupedByType[row.telemetryType]) {
        groupedByType[row.telemetryType] = [];
      }
      groupedByType[row.telemetryType].push({
        timestamp: row.timestamp,
        value: row.value,
      });
    }

    // Calculate rates for each type
    for (const [type, samples] of Object.entries(groupedByType)) {
      const rates: Array<{ timestamp: number; ratePerMinute: number }> = [];

      for (let i = 1; i < samples.length; i++) {
        const deltaValue = samples[i].value - samples[i - 1].value;
        const deltaTimeMs = samples[i].timestamp - samples[i - 1].timestamp;
        const deltaTimeMinutes = deltaTimeMs / 60000;

        // Skip counter resets (negative delta = device reboot)
        if (deltaValue < 0) {
          continue;
        }

        // Skip if time gap > 1 hour (stale data, likely a device restart)
        if (deltaTimeMinutes > 60) {
          continue;
        }

        // Skip if delta time is too small (avoid division issues)
        if (deltaTimeMinutes < 0.1) {
          continue;
        }

        const ratePerMinute = deltaValue / deltaTimeMinutes;

        // Skip unreasonably high rates (likely artifact from reset)
        // More than 1000 packets/minute is suspicious
        if (ratePerMinute > 1000) {
          continue;
        }

        rates.push({
          timestamp: samples[i].timestamp,
          ratePerMinute: Math.round(ratePerMinute * 100) / 100, // Round to 2 decimal places
        });
      }

      result[type] = rates;
    }

    return result;
  }

  async getPacketRatesAsync(
    nodeId: string,
    types: string[],
    sinceTimestamp?: number,
    sourceId?: string
  ): Promise<Record<string, Array<{ timestamp: number; ratePerMinute: number }>>> {
    const result: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};
    for (const type of types) {
      result[type] = [];
    }

    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const typePlaceholders = types.map((_, i) => `$${i + 2}`).join(', ');
        const params: (string | number)[] = [nodeId, ...types];
        let query = `SELECT "telemetryType", timestamp, value FROM telemetry
                      WHERE "nodeId" = $1 AND "telemetryType" IN (${typePlaceholders})`;
        if (sinceTimestamp !== undefined) {
          params.push(sinceTimestamp);
          query += ` AND timestamp >= $${params.length}`;
        }
        if (sourceId !== undefined) {
          params.push(sourceId);
          query += ` AND "sourceId" = $${params.length}`;
        }
        query += ` ORDER BY "telemetryType", timestamp ASC`;
        const queryResult = await client.query(query, params);
        return this.calculatePacketRates(queryResult.rows, types);
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const typePlaceholders = types.map(() => '?').join(', ');
      const params: (string | number)[] = [nodeId, ...types];
      let query = `SELECT telemetryType, timestamp, value FROM telemetry
                    WHERE nodeId = ? AND telemetryType IN (${typePlaceholders})`;
      if (sinceTimestamp !== undefined) {
        params.push(sinceTimestamp);
        query += ` AND timestamp >= ?`;
      }
      if (sourceId !== undefined) {
        params.push(sourceId);
        query += ` AND sourceId = ?`;
      }
      query += ` ORDER BY telemetryType, timestamp ASC`;
      const [rows] = await pool.query(query, params);
      return this.calculatePacketRates(rows as any[], types);
    }
    return this.getPacketRates(nodeId, types, sinceTimestamp, sourceId);
  }

  private calculatePacketRates(
    rows: Array<{ telemetryType: string; timestamp: number; value: number }>,
    types: string[]
  ): Record<string, Array<{ timestamp: number; ratePerMinute: number }>> {
    const result: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};
    for (const type of types) {
      result[type] = [];
    }

    const groupedByType: Record<string, Array<{ timestamp: number; value: number }>> = {};
    for (const row of rows) {
      if (!groupedByType[row.telemetryType]) {
        groupedByType[row.telemetryType] = [];
      }
      groupedByType[row.telemetryType].push({
        timestamp: Number(row.timestamp),
        value: Number(row.value),
      });
    }

    for (const [type, samples] of Object.entries(groupedByType)) {
      const rates: Array<{ timestamp: number; ratePerMinute: number }> = [];
      for (let i = 1; i < samples.length; i++) {
        const deltaValue = samples[i].value - samples[i - 1].value;
        const deltaTimeMs = samples[i].timestamp - samples[i - 1].timestamp;
        const deltaTimeMinutes = deltaTimeMs / 60000;
        if (deltaValue < 0) continue;
        if (deltaTimeMinutes > 60) continue;
        if (deltaTimeMinutes < 0.1) continue;
        rates.push({
          timestamp: samples[i].timestamp,
          ratePerMinute: deltaValue / deltaTimeMinutes,
        });
      }
      result[type] = rates;
    }
    return result;
  }

  insertTraceroute(tracerouteData: DbTraceroute, sourceId?: string): void {
    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        const now = Date.now();
        const pendingTimeoutAgo = now - PENDING_TRACEROUTE_TIMEOUT_MS;

        // Fire async operation
        (async () => {
          try {
            // Check for pending traceroute (reversed direction - see note below)
            // NOTE: When a traceroute response comes in, fromNum is the destination (responder) and toNum is the local node (requester)
            // But when we created the pending record, fromNodeNum was the local node and toNodeNum was the destination
            const pendingRecord = await this.traceroutesRepo!.findPendingTraceroute(
              tracerouteData.toNodeNum,    // Reversed: response's toNum is the requester
              tracerouteData.fromNodeNum,  // Reversed: response's fromNum is the destination
              pendingTimeoutAgo,
              sourceId
            );

            if (pendingRecord) {
              // Update existing pending record
              await this.traceroutesRepo!.updateTracerouteResponse(
                pendingRecord.id,
                tracerouteData.route || null,
                tracerouteData.routeBack || null,
                tracerouteData.snrTowards || null,
                tracerouteData.snrBack || null,
                tracerouteData.timestamp
              );
            } else {
              // Insert new traceroute
              await this.traceroutesRepo!.insertTraceroute(tracerouteData, sourceId);
            }

            // Cleanup old traceroutes
            await this.traceroutesRepo!.cleanupOldTraceroutesForPair(
              tracerouteData.fromNodeNum,
              tracerouteData.toNodeNum,
              TRACEROUTE_HISTORY_LIMIT,
              sourceId
            );
          } catch (error) {
            logger.error('[DatabaseService] Failed to insert traceroute:', error);
          }
        })();
      }
      return;
    }

    // SQLite: delegate to repository sync upsert (runs in a transaction)
    this.traceroutes.upsertTracerouteSync(
      tracerouteData,
      PENDING_TRACEROUTE_TIMEOUT_MS,
      TRACEROUTE_HISTORY_LIMIT,
      sourceId
    );
  }

  getTraceroutesByNodes(fromNodeNum: number, toNodeNum: number, limit: number = 10): DbTraceroute[] {
    // For PostgreSQL/MySQL, use async repo with cache pattern
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        // Fire async query and update cache in background
        const cacheKey = `${fromNodeNum}_${toNodeNum}`;
        this.traceroutesRepo.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit).then(traceroutes => {
          this._traceroutesByNodesCache.set(cacheKey, traceroutes.map(t => ({
            ...t,
            route: t.route || '',
            routeBack: t.routeBack || '',
            snrTowards: t.snrTowards || '',
            snrBack: t.snrBack || '',
          })) as DbTraceroute[]);
        }).catch(err => logger.debug('Failed to fetch traceroutes by nodes:', err));
      }
      // Return cached result or empty array
      const cacheKey = `${fromNodeNum}_${toNodeNum}`;
      return this._traceroutesByNodesCache.get(cacheKey) || [];
    }

    // Search bidirectionally to capture traceroutes initiated from either direction
    return this.traceroutes.getTraceroutesByNodesSync(fromNodeNum, toNodeNum, limit) as unknown as DbTraceroute[];
  }

  getAllTraceroutes(limit: number = 100, sourceId?: string): DbTraceroute[] {
    // For PostgreSQL/MySQL, use cached traceroutes or return empty
    // Traceroute data is primarily real-time from mesh traffic
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Use traceroutesRepo if available - fire async and return cache
      if (this.traceroutesRepo) {
        // Fire async query and update cache in background
        this.traceroutesRepo.getAllTraceroutes(limit, sourceId).then(traceroutes => {
          // Store in internal cache for next sync call (cast to local DbTraceroute type)
          this._traceroutesCache = traceroutes.map(t => ({
            ...t,
            route: t.route || '',
            routeBack: t.routeBack || '',
            snrTowards: t.snrTowards || '',
            snrBack: t.snrBack || '',
          })) as DbTraceroute[];
        }).catch(err => logger.debug('Failed to fetch traceroutes:', err));
      }
      // Return cached traceroutes or empty array
      return this._traceroutesCache || [];
    }

    return this.traceroutes.getAllTraceroutesRecentSync(limit, sourceId) as unknown as DbTraceroute[];
  }

  getNodeNeedingTraceroute(localNodeNum: number): DbNode | null {
    // Auto-traceroute selection not yet implemented for PostgreSQL/MySQL
    // This function uses complex SQLite-specific queries that need conversion
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug('⏭️ Auto-traceroute node selection not yet supported for PostgreSQL/MySQL');
      return null;
    }

    const now = Date.now();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const expirationHours = this.getTracerouteExpirationHours();
    const EXPIRATION_MS = expirationHours * 60 * 60 * 1000;

    // Get maxNodeAgeHours setting to filter only active nodes
    // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
    const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');
    const activeNodeCutoff = Math.floor(Date.now() / 1000) - (maxNodeAgeHours * 60 * 60);

    // Check if node filter is enabled
    const filterEnabled = this.isAutoTracerouteNodeFilterEnabled();

    // Get all filter settings
    const specificNodes = this.getAutoTracerouteNodes();
    const filterChannels = this.getTracerouteFilterChannels();
    const filterRoles = this.getTracerouteFilterRoles();
    const filterHwModels = this.getTracerouteFilterHwModels();
    const filterNameRegex = this.getTracerouteFilterNameRegex();

    // Get individual filter enabled flags
    const filterNodesEnabled = this.isTracerouteFilterNodesEnabled();
    const filterChannelsEnabled = this.isTracerouteFilterChannelsEnabled();
    const filterRolesEnabled = this.isTracerouteFilterRolesEnabled();
    const filterHwModelsEnabled = this.isTracerouteFilterHwModelsEnabled();
    const filterRegexEnabled = this.isTracerouteFilterRegexEnabled();

    // Last heard and hop range filters (AND logic, applied before OR union filters)
    const filterLastHeardEnabled = this.isTracerouteFilterLastHeardEnabled();
    const filterLastHeardHours = this.getTracerouteFilterLastHeardHours();
    const filterHopsEnabled = this.isTracerouteFilterHopsEnabled();
    const filterHopsMin = this.getTracerouteFilterHopsMin();
    const filterHopsMax = this.getTracerouteFilterHopsMax();

    // Get all nodes that are eligible for traceroute based on their status
    // Only consider nodes that have been heard within maxNodeAgeHours (active nodes)
    // Two categories:
    // 1. Nodes with no successful traceroute: retry every 3 hours
    // 2. Nodes with successful traceroute: retry every 24 hours
    let eligibleNodes = this.traceroutesRepo!.getEligibleTracerouteCandidatesSync(
      localNodeNum,
      activeNodeCutoff,
      now - THREE_HOURS_MS,
      now - EXPIRATION_MS
    ) as unknown as DbNode[];

    // Apply last-heard filter (AND logic — applied before OR union filters)
    if (filterLastHeardEnabled) {
      const lastHeardCutoff = Math.floor(Date.now() / 1000) - (filterLastHeardHours * 3600);
      eligibleNodes = eligibleNodes.filter(node => {
        // Exclude nodes with no lastHeard or lastHeard older than cutoff
        return node.lastHeard != null && node.lastHeard >= lastHeardCutoff;
      });
    }

    // Apply hop range filter (AND logic)
    if (filterHopsEnabled) {
      eligibleNodes = eligibleNodes.filter(node => {
        // Treat NULL hopsAway as 1 (direct neighbor)
        const hops = node.hopsAway ?? 1;
        return hops >= filterHopsMin && hops <= filterHopsMax;
      });
    }

    // Apply filters using UNION logic (node is eligible if it matches ANY enabled filter)
    // If filterEnabled is true but no individual filters are enabled, all nodes pass
    if (filterEnabled) {
      // Build regex matcher if enabled
      let regexMatcher: RegExp | null = null;
      if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
        try {
          regexMatcher = new RegExp(filterNameRegex, 'i');
        } catch (e) {
          logger.warn(`Invalid traceroute filter regex: ${filterNameRegex}`, e);
        }
      }

      // Check if ANY filter is actually configured
      const hasAnyFilter =
        (filterNodesEnabled && specificNodes.length > 0) ||
        (filterChannelsEnabled && filterChannels.length > 0) ||
        (filterRolesEnabled && filterRoles.length > 0) ||
        (filterHwModelsEnabled && filterHwModels.length > 0) ||
        (filterRegexEnabled && regexMatcher !== null);

      // Only filter if at least one filter is configured
      if (hasAnyFilter) {
        eligibleNodes = eligibleNodes.filter(node => {
          // UNION logic: node passes if it matches ANY enabled filter
          // Check specific nodes filter
          if (filterNodesEnabled && specificNodes.length > 0) {
            if (specificNodes.includes(node.nodeNum)) {
              return true;
            }
          }

          // Check channel filter
          if (filterChannelsEnabled && filterChannels.length > 0) {
            if (node.channel !== undefined && filterChannels.includes(node.channel)) {
              return true;
            }
          }

          // Check role filter
          if (filterRolesEnabled && filterRoles.length > 0) {
            if (node.role !== undefined && filterRoles.includes(node.role)) {
              return true;
            }
          }

          // Check hardware model filter
          if (filterHwModelsEnabled && filterHwModels.length > 0) {
            if (node.hwModel !== undefined && filterHwModels.includes(node.hwModel)) {
              return true;
            }
          }

          // Check regex name filter
          if (filterRegexEnabled && regexMatcher !== null) {
            const name = node.longName || node.shortName || node.nodeId || '';
            if (regexMatcher.test(name)) {
              return true;
            }
          }

          // Node didn't match any enabled filter
          return false;
        });
      }
      // If hasAnyFilter is false, all nodes pass (no filtering applied)
    }

    if (eligibleNodes.length === 0) {
      return null;
    }

    // Check if sort by hops is enabled
    const sortByHops = this.isTracerouteSortByHopsEnabled();

    if (sortByHops) {
      // Sort by hopsAway ascending (closer nodes first), with undefined hops at the end
      eligibleNodes.sort((a, b) => {
        const hopsA = a.hopsAway ?? Infinity;
        const hopsB = b.hopsAway ?? Infinity;
        return hopsA - hopsB;
      });
      // Take the first (closest) node
      return this.normalizeBigInts(eligibleNodes[0]);
    }

    // Randomly select one node from the eligible nodes
    const randomIndex = Math.floor(Math.random() * eligibleNodes.length);
    return this.normalizeBigInts(eligibleNodes[randomIndex]);
  }

  /**
   * Async version of getNodeNeedingTraceroute - works with all database backends
   * Returns a node that needs a traceroute based on configured filters and timing
   */
  async getNodeNeedingTracerouteAsync(localNodeNum: number, sourceId?: string): Promise<DbNode | null> {
    const now = Date.now();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

    // Read ALL filter configuration per-source (falls back to global when
    // no per-source override exists). This is what makes Auto-Traceroute
    // filters honor the Source that the scheduler tick is running on.
    const filterCfg = await this.getTracerouteFilterSettingsAsync(sourceId);
    const EXPIRATION_MS = filterCfg.expirationHours * 60 * 60 * 1000;

    // Get maxNodeAgeHours setting to filter only active nodes
    // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
    const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');
    const activeNodeCutoff = Math.floor(Date.now() / 1000) - (maxNodeAgeHours * 60 * 60);

    // For SQLite, use repository (which now supports sourceId)
    if (this.drizzleDbType === 'sqlite' || !this.nodesRepo) {
      if (!sourceId) return this.getNodeNeedingTraceroute(localNodeNum);
      // Use repo path for SQLite when sourceId is needed
    }

    try {
      // Get eligible nodes from repository
      let eligibleNodes = await this.nodesRepo!.getEligibleNodesForTraceroute(
        localNodeNum,
        activeNodeCutoff,
        now - THREE_HOURS_MS,
        now - EXPIRATION_MS,
        sourceId
      );

      // Last heard and hop range filters (AND logic, applied before OR union filters)
      const filterLastHeardEnabled = filterCfg.filterLastHeardEnabled;
      const filterLastHeardHours = filterCfg.filterLastHeardHours;
      const filterHopsEnabled = filterCfg.filterHopsEnabled;
      const filterHopsMin = filterCfg.filterHopsMin;
      const filterHopsMax = filterCfg.filterHopsMax;

      // Apply last-heard filter (AND logic — applied before OR union filters)
      if (filterLastHeardEnabled) {
        const lastHeardCutoff = Math.floor(Date.now() / 1000) - (filterLastHeardHours * 3600);
        eligibleNodes = eligibleNodes.filter(node => {
          // Exclude nodes with no lastHeard or lastHeard older than cutoff
          return node.lastHeard != null && node.lastHeard >= lastHeardCutoff;
        });
      }

      // Apply hop range filter (AND logic)
      if (filterHopsEnabled) {
        eligibleNodes = eligibleNodes.filter(node => {
          // Treat NULL hopsAway as 1 (direct neighbor)
          const hops = node.hopsAway ?? 1;
          return hops >= filterHopsMin && hops <= filterHopsMax;
        });
      }

      // Check if node filter is enabled (per-source when scoped)
      const filterEnabled = filterCfg.enabled;

      if (filterEnabled) {
        const specificNodes = filterCfg.nodeNums;
        const filterChannels = filterCfg.filterChannels;
        const filterRoles = filterCfg.filterRoles;
        const filterHwModels = filterCfg.filterHwModels;
        const filterNameRegex = filterCfg.filterNameRegex;

        const filterNodesEnabled = filterCfg.filterNodesEnabled;
        const filterChannelsEnabled = filterCfg.filterChannelsEnabled;
        const filterRolesEnabled = filterCfg.filterRolesEnabled;
        const filterHwModelsEnabled = filterCfg.filterHwModelsEnabled;
        const filterRegexEnabled = filterCfg.filterRegexEnabled;

        // Build regex matcher if enabled
        let regexMatcher: RegExp | null = null;
        if (filterRegexEnabled && filterNameRegex && filterNameRegex !== '.*') {
          try {
            regexMatcher = new RegExp(filterNameRegex, 'i');
          } catch (e) {
            logger.warn(`Invalid traceroute filter regex: ${filterNameRegex}`, e);
          }
        }

        // Check if ANY filter is actually configured
        const hasAnyFilter =
          (filterNodesEnabled && specificNodes.length > 0) ||
          (filterChannelsEnabled && filterChannels.length > 0) ||
          (filterRolesEnabled && filterRoles.length > 0) ||
          (filterHwModelsEnabled && filterHwModels.length > 0) ||
          (filterRegexEnabled && regexMatcher !== null);

        // Only filter if at least one filter is configured
        if (hasAnyFilter) {
          eligibleNodes = eligibleNodes.filter(node => {
            // UNION logic: node passes if it matches ANY enabled filter
            // Check specific nodes filter
            if (filterNodesEnabled && specificNodes.length > 0) {
              if (specificNodes.includes(node.nodeNum)) {
                return true;
              }
            }

            // Check channel filter
            if (filterChannelsEnabled && filterChannels.length > 0) {
              if (node.channel != null && filterChannels.includes(node.channel)) {
                return true;
              }
            }

            // Check role filter
            if (filterRolesEnabled && filterRoles.length > 0) {
              if (node.role != null && filterRoles.includes(node.role)) {
                return true;
              }
            }

            // Check hardware model filter
            if (filterHwModelsEnabled && filterHwModels.length > 0) {
              if (node.hwModel != null && filterHwModels.includes(node.hwModel)) {
                return true;
              }
            }

            // Check regex name filter
            if (filterRegexEnabled && regexMatcher !== null) {
              const name = node.longName || node.shortName || node.nodeId || '';
              if (regexMatcher.test(name)) {
                return true;
              }
            }

            // Node didn't match any enabled filter
            return false;
          });
        }
        // If hasAnyFilter is false, all nodes pass (no filtering applied)
      }

      if (eligibleNodes.length === 0) {
        return null;
      }

      // Check if sort by hops is enabled (per-source when scoped)
      const sortByHops = filterCfg.sortByHops;

      if (sortByHops) {
        // Sort by hopsAway ascending (closer nodes first), with undefined hops at the end
        eligibleNodes.sort((a, b) => {
          const hopsA = a.hopsAway ?? Infinity;
          const hopsB = b.hopsAway ?? Infinity;
          return hopsA - hopsB;
        });
        // Take the first (closest) node
        return this.normalizeBigInts(eligibleNodes[0]);
      }

      // Randomly select one node from the eligible nodes
      const randomIndex = Math.floor(Math.random() * eligibleNodes.length);
      return this.normalizeBigInts(eligibleNodes[randomIndex]);
    } catch (error) {
      logger.error('Error in getNodeNeedingTracerouteAsync:', error);
      return null;
    }
  }

  /**
   * Get a node that needs remote admin checking.
   * Returns null if no nodes need checking.
   */
  async getNodeNeedingRemoteAdminCheckAsync(localNodeNum: number, sourceId?: string): Promise<DbNode | null> {
    try {
      // Get maxNodeAgeHours setting to filter only active nodes
      // lastHeard is stored in SECONDS (Unix timestamp)
      const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');
      const activeNodeCutoffSeconds = Math.floor(Date.now() / 1000) - (maxNodeAgeHours * 60 * 60);

      // Get expiration hours (default 168 = 1 week)
      // lastRemoteAdminCheck is stored in MILLISECONDS
      const expirationHours = parseInt(this.getSetting('remoteAdminScannerExpirationHours') || '168');
      const expirationMsAgo = Date.now() - (expirationHours * 60 * 60 * 1000);

      if (this.nodesRepo) {
        const node = await this.nodesRepo.getNodeNeedingRemoteAdminCheckAsync(
          localNodeNum,
          activeNodeCutoffSeconds,
          expirationMsAgo,
          sourceId
        );
        return node as DbNode | null;
      }

      return null;
    } catch (error) {
      logger.error('Error in getNodeNeedingRemoteAdminCheckAsync:', error);
      return null;
    }
  }

  /**
   * Update a node's remote admin status
   */
  async updateNodeRemoteAdminStatusAsync(
    nodeNum: number,
    hasRemoteAdmin: boolean,
    metadata: string | null,
    sourceId: string
  ): Promise<void> {
    try {
      if (this.nodesRepo) {
        await this.nodesRepo.updateNodeRemoteAdminStatusAsync(nodeNum, hasRemoteAdmin, metadata, sourceId);
      }

      // Update cache for PostgreSQL/MySQL
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        const existingNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
        if (existingNode) {
          existingNode.hasRemoteAdmin = hasRemoteAdmin;
          existingNode.lastRemoteAdminCheck = Date.now();
          existingNode.remoteAdminMetadata = metadata ?? undefined;
          existingNode.updatedAt = Date.now();
        }
      }
    } catch (error) {
      logger.error('Error in updateNodeRemoteAdminStatusAsync:', error);
    }
  }

  async recordTracerouteRequest(fromNodeNum: number, toNodeNum: number, sourceId?: string): Promise<void> {
    const now = Date.now();

    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      try {
        // Update the nodes table with last request time (Phase 3C: scoped per-source).
        if (this.nodesRepo && sourceId) {
          await this.nodesRepo.updateNodeLastTracerouteRequest(toNodeNum, now, sourceId);
        }

        // Insert a pending traceroute record
        if (this.traceroutesRepo) {
          const fromNodeId = `!${fromNodeNum.toString(16).padStart(8, '0')}`;
          const toNodeId = `!${toNodeNum.toString(16).padStart(8, '0')}`;

          await this.traceroutesRepo.insertTraceroute({
            fromNodeNum,
            toNodeNum,
            fromNodeId,
            toNodeId,
            route: null,  // null for pending (findPendingTraceroute checks for isNull)
            routeBack: null,
            snrTowards: null,
            snrBack: null,
            timestamp: now,
            createdAt: now,
          }, sourceId);

          // Cleanup old traceroutes
          await this.traceroutesRepo.cleanupOldTraceroutesForPair(
            fromNodeNum,
            toNodeNum,
            TRACEROUTE_HISTORY_LIMIT,
            sourceId
          );
        }
      } catch (error) {
        logger.error('[DatabaseService] Failed to record traceroute request:', error);
      }
      return;
    }

    // SQLite path
    // Update the nodes table with last request time (Phase 3C: scoped per-source when available).
    this.nodesRepo!.updateNodeLastTracerouteRequestSqlite(toNodeNum, now, sourceId);

    // Insert a traceroute record for the attempt (with null routes indicating pending)
    const fromNodeId = `!${fromNodeNum.toString(16).padStart(8, '0')}`;
    const toNodeId = `!${toNodeNum.toString(16).padStart(8, '0')}`;

    // upsertTracerouteSync handles insert + history prune in a transaction.
    // Using a pending timeout of 0 guarantees no "pending match" occurs so
    // we always insert a new pending record (matching legacy behavior).
    this.traceroutes.upsertTracerouteSync(
      {
        fromNodeNum,
        toNodeNum,
        fromNodeId,
        toNodeId,
        route: null as unknown as string,
        routeBack: null as unknown as string,
        snrTowards: null as unknown as string,
        snrBack: null as unknown as string,
        timestamp: now,
        createdAt: now,
      } as DbTraceroute,
      0,
      TRACEROUTE_HISTORY_LIMIT,
      sourceId
    );
  }

  // Auto-traceroute node filter methods
  getAutoTracerouteNodes(): number[] {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'getAutoTracerouteNodes' called but using ${this.drizzleDbType} database. Use getAutoTracerouteNodesAsync() instead.`);
    }
    return this.misc!.getAutoTracerouteNodesSync();
  }

  setAutoTracerouteNodes(nodeNums: number[]): void {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'setAutoTracerouteNodes' called but using ${this.drizzleDbType} database. Use setAutoTracerouteNodesAsync() instead.`);
    }
    this.misc!.setAutoTracerouteNodesSync(nodeNums);
    logger.debug(`✅ Set auto-traceroute filter to ${nodeNums.length} nodes`);
  }

  // Solar Estimates methods
  async upsertSolarEstimateAsync(timestamp: number, wattHours: number, fetchedAt: number): Promise<void> {
    await this.misc.upsertSolarEstimate({
      timestamp,
      watt_hours: wattHours,
      fetched_at: fetchedAt,
    });
  }

  async getRecentSolarEstimatesAsync(limit: number = 100): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    return this.misc.getRecentSolarEstimates(limit);
  }

  async getSolarEstimatesInRangeAsync(startTimestamp: number, endTimestamp: number): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    return this.misc.getSolarEstimatesInRange(startTimestamp, endTimestamp);
  }

  isAutoTracerouteNodeFilterEnabled(): boolean {
    const value = this.getSetting('tracerouteNodeFilterEnabled');
    return value === 'true';
  }

  setAutoTracerouteNodeFilterEnabled(enabled: boolean): void {
    this.setSetting('tracerouteNodeFilterEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Auto-traceroute node filter ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Advanced traceroute filter settings (stored as JSON in settings table)
  getTracerouteFilterChannels(): number[] {
    const value = this.getSetting('tracerouteFilterChannels');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  setTracerouteFilterChannels(channels: number[]): void {
    this.setSetting('tracerouteFilterChannels', JSON.stringify(channels));
    logger.debug(`✅ Set traceroute filter channels: ${channels.join(', ') || 'none'}`);
  }

  getTracerouteFilterRoles(): number[] {
    const value = this.getSetting('tracerouteFilterRoles');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  setTracerouteFilterRoles(roles: number[]): void {
    this.setSetting('tracerouteFilterRoles', JSON.stringify(roles));
    logger.debug(`✅ Set traceroute filter roles: ${roles.join(', ') || 'none'}`);
  }

  getTracerouteFilterHwModels(): number[] {
    const value = this.getSetting('tracerouteFilterHwModels');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  setTracerouteFilterHwModels(hwModels: number[]): void {
    this.setSetting('tracerouteFilterHwModels', JSON.stringify(hwModels));
    logger.debug(`✅ Set traceroute filter hardware models: ${hwModels.join(', ') || 'none'}`);
  }

  getTracerouteFilterNameRegex(): string {
    const value = this.getSetting('tracerouteFilterNameRegex');
    // Default to '.*' (match all) if not set
    return value || '.*';
  }

  setTracerouteFilterNameRegex(regex: string): void {
    this.setSetting('tracerouteFilterNameRegex', regex);
    logger.debug(`✅ Set traceroute filter name regex: ${regex}`);
  }

  // Individual filter enabled flags
  isTracerouteFilterNodesEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterNodesEnabled');
    // Default to true for backward compatibility
    return value !== 'false';
  }

  setTracerouteFilterNodesEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterNodesEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter nodes enabled: ${enabled}`);
  }

  isTracerouteFilterChannelsEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterChannelsEnabled');
    // Default to true for backward compatibility
    return value !== 'false';
  }

  setTracerouteFilterChannelsEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterChannelsEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter channels enabled: ${enabled}`);
  }

  isTracerouteFilterRolesEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterRolesEnabled');
    // Default to true for backward compatibility
    return value !== 'false';
  }

  setTracerouteFilterRolesEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterRolesEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter roles enabled: ${enabled}`);
  }

  isTracerouteFilterHwModelsEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterHwModelsEnabled');
    // Default to true for backward compatibility
    return value !== 'false';
  }

  setTracerouteFilterHwModelsEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterHwModelsEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter hardware models enabled: ${enabled}`);
  }

  isTracerouteFilterRegexEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterRegexEnabled');
    // Default to true for backward compatibility
    return value !== 'false';
  }

  setTracerouteFilterRegexEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterRegexEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter regex enabled: ${enabled}`);
  }

  // Last Heard filter
  isTracerouteFilterLastHeardEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterLastHeardEnabled');
    // Default to true — skip stale nodes by default
    return value !== 'false';
  }

  setTracerouteFilterLastHeardEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterLastHeardEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter last heard enabled: ${enabled}`);
  }

  getTracerouteFilterLastHeardHours(): number {
    const value = this.getSetting('tracerouteFilterLastHeardHours');
    if (!value) return 168; // Default: 7 days
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 168 : parsed;
  }

  setTracerouteFilterLastHeardHours(hours: number): void {
    this.setSetting('tracerouteFilterLastHeardHours', hours.toString());
    logger.debug(`✅ Set traceroute filter last heard hours: ${hours}`);
  }

  // Hop range filter
  isTracerouteFilterHopsEnabled(): boolean {
    const value = this.getSetting('tracerouteFilterHopsEnabled');
    // Default to false — disabled by default
    return value === 'true';
  }

  setTracerouteFilterHopsEnabled(enabled: boolean): void {
    this.setSetting('tracerouteFilterHopsEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute filter hops enabled: ${enabled}`);
  }

  getTracerouteFilterHopsMin(): number {
    const value = this.getSetting('tracerouteFilterHopsMin');
    if (!value) return 0;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  setTracerouteFilterHopsMin(min: number): void {
    this.setSetting('tracerouteFilterHopsMin', min.toString());
    logger.debug(`✅ Set traceroute filter hops min: ${min}`);
  }

  getTracerouteFilterHopsMax(): number {
    const value = this.getSetting('tracerouteFilterHopsMax');
    if (!value) return 10;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? 10 : parsed;
  }

  setTracerouteFilterHopsMax(max: number): void {
    this.setSetting('tracerouteFilterHopsMax', max.toString());
    logger.debug(`✅ Set traceroute filter hops max: ${max}`);
  }

  // Get the traceroute expiration hours (how long to wait before re-tracerouting a node)
  getTracerouteExpirationHours(): number {
    const value = this.getSetting('tracerouteExpirationHours');
    if (value === null) {
      return 24; // Default to 24 hours
    }
    const hours = parseInt(value, 10);
    // Validate range (0-168 hours; 0 = always re-traceroute, up to 1 week)
    if (isNaN(hours) || hours < 0 || hours > 168) {
      return 24;
    }
    return hours;
  }

  setTracerouteExpirationHours(hours: number): void {
    // Validate range (0-168 hours; 0 = always re-traceroute, up to 1 week)
    if (hours < 0 || hours > 168) {
      throw new Error('Traceroute expiration hours must be between 0 and 168 (1 week)');
    }
    this.setSetting('tracerouteExpirationHours', hours.toString());
    logger.debug(`✅ Set traceroute expiration hours to: ${hours}`);
  }

  // Sort by hops setting - prioritize nodes with fewer hops for traceroute
  isTracerouteSortByHopsEnabled(): boolean {
    const value = this.getSetting('tracerouteSortByHops');
    // Default to false (random selection)
    return value === 'true';
  }

  setTracerouteSortByHopsEnabled(enabled: boolean): void {
    this.setSetting('tracerouteSortByHops', enabled ? 'true' : 'false');
    logger.debug(`✅ Set traceroute sort by hops: ${enabled}`);
  }

  // Get all traceroute filter settings at once
  getTracerouteFilterSettings(): {
    enabled: boolean;
    nodeNums: number[];
    filterChannels: number[];
    filterRoles: number[];
    filterHwModels: number[];
    filterNameRegex: string;
    filterNodesEnabled: boolean;
    filterChannelsEnabled: boolean;
    filterRolesEnabled: boolean;
    filterHwModelsEnabled: boolean;
    filterRegexEnabled: boolean;
    expirationHours: number;
    sortByHops: boolean;
    filterLastHeardEnabled: boolean;
    filterLastHeardHours: number;
    filterHopsEnabled: boolean;
    filterHopsMin: number;
    filterHopsMax: number;
  } {
    return {
      enabled: this.isAutoTracerouteNodeFilterEnabled(),
      nodeNums: this.getAutoTracerouteNodes(),
      filterChannels: this.getTracerouteFilterChannels(),
      filterRoles: this.getTracerouteFilterRoles(),
      filterHwModels: this.getTracerouteFilterHwModels(),
      filterNameRegex: this.getTracerouteFilterNameRegex(),
      filterNodesEnabled: this.isTracerouteFilterNodesEnabled(),
      filterChannelsEnabled: this.isTracerouteFilterChannelsEnabled(),
      filterRolesEnabled: this.isTracerouteFilterRolesEnabled(),
      filterHwModelsEnabled: this.isTracerouteFilterHwModelsEnabled(),
      filterRegexEnabled: this.isTracerouteFilterRegexEnabled(),
      expirationHours: this.getTracerouteExpirationHours(),
      sortByHops: this.isTracerouteSortByHopsEnabled(),
      filterLastHeardEnabled: this.isTracerouteFilterLastHeardEnabled(),
      filterLastHeardHours: this.getTracerouteFilterLastHeardHours(),
      filterHopsEnabled: this.isTracerouteFilterHopsEnabled(),
      filterHopsMin: this.getTracerouteFilterHopsMin(),
      filterHopsMax: this.getTracerouteFilterHopsMax(),
    };
  }

  // Set all traceroute filter settings at once
  setTracerouteFilterSettings(settings: {
    enabled: boolean;
    nodeNums: number[];
    filterChannels: number[];
    filterRoles: number[];
    filterHwModels: number[];
    filterNameRegex: string;
    filterNodesEnabled?: boolean;
    filterChannelsEnabled?: boolean;
    filterRolesEnabled?: boolean;
    filterHwModelsEnabled?: boolean;
    filterRegexEnabled?: boolean;
    expirationHours?: number;
    sortByHops?: boolean;
    filterLastHeardEnabled?: boolean;
    filterLastHeardHours?: number;
    filterHopsEnabled?: boolean;
    filterHopsMin?: number;
    filterHopsMax?: number;
  }): void {
    this.setAutoTracerouteNodeFilterEnabled(settings.enabled);
    this.setAutoTracerouteNodes(settings.nodeNums);
    this.setTracerouteFilterChannels(settings.filterChannels);
    this.setTracerouteFilterRoles(settings.filterRoles);
    this.setTracerouteFilterHwModels(settings.filterHwModels);
    this.setTracerouteFilterNameRegex(settings.filterNameRegex);
    // Individual filter enabled flags (default to true for backward compatibility)
    if (settings.filterNodesEnabled !== undefined) {
      this.setTracerouteFilterNodesEnabled(settings.filterNodesEnabled);
    }
    if (settings.filterChannelsEnabled !== undefined) {
      this.setTracerouteFilterChannelsEnabled(settings.filterChannelsEnabled);
    }
    if (settings.filterRolesEnabled !== undefined) {
      this.setTracerouteFilterRolesEnabled(settings.filterRolesEnabled);
    }
    if (settings.filterHwModelsEnabled !== undefined) {
      this.setTracerouteFilterHwModelsEnabled(settings.filterHwModelsEnabled);
    }
    if (settings.filterRegexEnabled !== undefined) {
      this.setTracerouteFilterRegexEnabled(settings.filterRegexEnabled);
    }
    if (settings.expirationHours !== undefined) {
      this.setTracerouteExpirationHours(settings.expirationHours);
    }
    if (settings.sortByHops !== undefined) {
      this.setTracerouteSortByHopsEnabled(settings.sortByHops);
    }
    if (settings.filterLastHeardEnabled !== undefined) {
      this.setTracerouteFilterLastHeardEnabled(settings.filterLastHeardEnabled);
    }
    if (settings.filterLastHeardHours !== undefined) {
      this.setTracerouteFilterLastHeardHours(settings.filterLastHeardHours);
    }
    if (settings.filterHopsEnabled !== undefined) {
      this.setTracerouteFilterHopsEnabled(settings.filterHopsEnabled);
    }
    if (settings.filterHopsMin !== undefined) {
      this.setTracerouteFilterHopsMin(settings.filterHopsMin);
    }
    if (settings.filterHopsMax !== undefined) {
      this.setTracerouteFilterHopsMax(settings.filterHopsMax);
    }
    logger.debug('✅ Updated all traceroute filter settings');
  }

  // Async versions of traceroute filter settings methods.
  //
  // When sourceId is provided, each filter field is read via
  // settings.getSettingForSource(sourceId, key) so it falls back to the
  // global value when no per-source override has been written. When
  // sourceId is undefined, behavior matches the global sync getters.
  async getTracerouteFilterSettingsAsync(sourceId?: string): Promise<{
    enabled: boolean;
    nodeNums: number[];
    filterChannels: number[];
    filterRoles: number[];
    filterHwModels: number[];
    filterNameRegex: string;
    filterNodesEnabled: boolean;
    filterChannelsEnabled: boolean;
    filterRolesEnabled: boolean;
    filterHwModelsEnabled: boolean;
    filterRegexEnabled: boolean;
    expirationHours: number;
    sortByHops: boolean;
    filterLastHeardEnabled: boolean;
    filterLastHeardHours: number;
    filterHopsEnabled: boolean;
    filterHopsMin: number;
    filterHopsMax: number;
  }> {
    const nodeNums = await this.misc.getAutoTracerouteNodes(sourceId);
    const read = (key: string) =>
      this.settings.getSettingForSource(sourceId ?? null, key);
    const [
      enabledStr, channelsStr, rolesStr, hwModelsStr, regexStr,
      nodesEnStr, channelsEnStr, rolesEnStr, hwModelsEnStr, regexEnStr,
      expirationStr, sortByHopsStr,
      lastHeardEnStr, lastHeardHoursStr,
      hopsEnStr, hopsMinStr, hopsMaxStr,
    ] = await Promise.all([
      read('tracerouteNodeFilterEnabled'),
      read('tracerouteFilterChannels'),
      read('tracerouteFilterRoles'),
      read('tracerouteFilterHwModels'),
      read('tracerouteFilterNameRegex'),
      read('tracerouteFilterNodesEnabled'),
      read('tracerouteFilterChannelsEnabled'),
      read('tracerouteFilterRolesEnabled'),
      read('tracerouteFilterHwModelsEnabled'),
      read('tracerouteFilterRegexEnabled'),
      read('tracerouteExpirationHours'),
      read('tracerouteSortByHops'),
      read('tracerouteFilterLastHeardEnabled'),
      read('tracerouteFilterLastHeardHours'),
      read('tracerouteFilterHopsEnabled'),
      read('tracerouteFilterHopsMin'),
      read('tracerouteFilterHopsMax'),
    ]);

    const parseJsonArray = (s: string | null): number[] => {
      if (!s) return [];
      try { const p = JSON.parse(s); return Array.isArray(p) ? p.map((v) => Number(v)).filter((v) => !isNaN(v)) : []; } catch { return []; }
    };
    const parseIntBounded = (s: string | null, def: number, min = -Infinity, max = Infinity): number => {
      if (s === null || s === undefined || s === '') return def;
      const n = parseInt(s, 10);
      if (isNaN(n) || n < min || n > max) return def;
      return n;
    };

    return {
      enabled: enabledStr === 'true',
      nodeNums,
      filterChannels: parseJsonArray(channelsStr),
      filterRoles: parseJsonArray(rolesStr),
      filterHwModels: parseJsonArray(hwModelsStr),
      filterNameRegex: regexStr ?? '.*',
      filterNodesEnabled: nodesEnStr !== 'false',
      filterChannelsEnabled: channelsEnStr !== 'false',
      filterRolesEnabled: rolesEnStr !== 'false',
      filterHwModelsEnabled: hwModelsEnStr !== 'false',
      filterRegexEnabled: regexEnStr !== 'false',
      expirationHours: parseIntBounded(expirationStr, 24, 0, 168),
      sortByHops: sortByHopsStr === 'true',
      filterLastHeardEnabled: lastHeardEnStr === 'true',
      filterLastHeardHours: parseIntBounded(lastHeardHoursStr, 168),
      filterHopsEnabled: hopsEnStr === 'true',
      filterHopsMin: parseIntBounded(hopsMinStr, 0),
      filterHopsMax: parseIntBounded(hopsMaxStr, 10),
    };
  }

  async setTracerouteFilterSettingsAsync(settings: {
    enabled: boolean;
    nodeNums: number[];
    filterChannels: number[];
    filterRoles: number[];
    filterHwModels: number[];
    filterNameRegex: string;
    filterNodesEnabled?: boolean;
    filterChannelsEnabled?: boolean;
    filterRolesEnabled?: boolean;
    filterHwModelsEnabled?: boolean;
    filterRegexEnabled?: boolean;
    expirationHours?: number;
    sortByHops?: boolean;
    filterLastHeardEnabled?: boolean;
    filterLastHeardHours?: number;
    filterHopsEnabled?: boolean;
    filterHopsMin?: number;
    filterHopsMax?: number;
  }, sourceId?: string): Promise<void> {
    // When sourceId is provided, persist every filter field as a per-source
    // override so each Source can hold its own Auto-Traceroute filter config.
    // Legacy behavior (no sourceId) still writes to the shared global keys.
    if (sourceId) {
      const kv: Record<string, string> = {
        tracerouteNodeFilterEnabled: settings.enabled ? 'true' : 'false',
        tracerouteFilterChannels: JSON.stringify(settings.filterChannels),
        tracerouteFilterRoles: JSON.stringify(settings.filterRoles),
        tracerouteFilterHwModels: JSON.stringify(settings.filterHwModels),
        tracerouteFilterNameRegex: settings.filterNameRegex,
      };
      if (settings.filterNodesEnabled !== undefined) kv.tracerouteFilterNodesEnabled = settings.filterNodesEnabled ? 'true' : 'false';
      if (settings.filterChannelsEnabled !== undefined) kv.tracerouteFilterChannelsEnabled = settings.filterChannelsEnabled ? 'true' : 'false';
      if (settings.filterRolesEnabled !== undefined) kv.tracerouteFilterRolesEnabled = settings.filterRolesEnabled ? 'true' : 'false';
      if (settings.filterHwModelsEnabled !== undefined) kv.tracerouteFilterHwModelsEnabled = settings.filterHwModelsEnabled ? 'true' : 'false';
      if (settings.filterRegexEnabled !== undefined) kv.tracerouteFilterRegexEnabled = settings.filterRegexEnabled ? 'true' : 'false';
      if (settings.expirationHours !== undefined) kv.tracerouteExpirationHours = String(settings.expirationHours);
      if (settings.sortByHops !== undefined) kv.tracerouteSortByHops = settings.sortByHops ? 'true' : 'false';
      if (settings.filterLastHeardEnabled !== undefined) kv.tracerouteFilterLastHeardEnabled = settings.filterLastHeardEnabled ? 'true' : 'false';
      if (settings.filterLastHeardHours !== undefined) kv.tracerouteFilterLastHeardHours = String(settings.filterLastHeardHours);
      if (settings.filterHopsEnabled !== undefined) kv.tracerouteFilterHopsEnabled = settings.filterHopsEnabled ? 'true' : 'false';
      if (settings.filterHopsMin !== undefined) kv.tracerouteFilterHopsMin = String(settings.filterHopsMin);
      if (settings.filterHopsMax !== undefined) kv.tracerouteFilterHopsMax = String(settings.filterHopsMax);
      await this.settings.setSourceSettings(sourceId, kv);
      await this.misc.setAutoTracerouteNodes(settings.nodeNums, sourceId);
      logger.debug(`✅ Updated per-source traceroute filter settings (source=${sourceId})`);
      return;
    }

    this.setAutoTracerouteNodeFilterEnabled(settings.enabled);
    await this.misc.setAutoTracerouteNodes(settings.nodeNums, sourceId);
    this.setTracerouteFilterChannels(settings.filterChannels);
    this.setTracerouteFilterRoles(settings.filterRoles);
    this.setTracerouteFilterHwModels(settings.filterHwModels);
    this.setTracerouteFilterNameRegex(settings.filterNameRegex);
    if (settings.filterNodesEnabled !== undefined) {
      this.setTracerouteFilterNodesEnabled(settings.filterNodesEnabled);
    }
    if (settings.filterChannelsEnabled !== undefined) {
      this.setTracerouteFilterChannelsEnabled(settings.filterChannelsEnabled);
    }
    if (settings.filterRolesEnabled !== undefined) {
      this.setTracerouteFilterRolesEnabled(settings.filterRolesEnabled);
    }
    if (settings.filterHwModelsEnabled !== undefined) {
      this.setTracerouteFilterHwModelsEnabled(settings.filterHwModelsEnabled);
    }
    if (settings.filterRegexEnabled !== undefined) {
      this.setTracerouteFilterRegexEnabled(settings.filterRegexEnabled);
    }
    if (settings.expirationHours !== undefined) {
      this.setTracerouteExpirationHours(settings.expirationHours);
    }
    if (settings.sortByHops !== undefined) {
      this.setTracerouteSortByHopsEnabled(settings.sortByHops);
    }
    if (settings.filterLastHeardEnabled !== undefined) {
      this.setTracerouteFilterLastHeardEnabled(settings.filterLastHeardEnabled);
    }
    if (settings.filterLastHeardHours !== undefined) {
      this.setTracerouteFilterLastHeardHours(settings.filterLastHeardHours);
    }
    if (settings.filterHopsEnabled !== undefined) {
      this.setTracerouteFilterHopsEnabled(settings.filterHopsEnabled);
    }
    if (settings.filterHopsMin !== undefined) {
      this.setTracerouteFilterHopsMin(settings.filterHopsMin);
    }
    if (settings.filterHopsMax !== undefined) {
      this.setTracerouteFilterHopsMax(settings.filterHopsMax);
    }
    logger.debug('✅ Updated all traceroute filter settings');
  }

  // Auto-traceroute log methods
  logAutoTracerouteAttempt(toNodeNum: number, toNodeName: string | null, sourceId?: string): number {
    return this.misc!.logAutoTracerouteAttemptSync(toNodeNum, toNodeName, sourceId);
  }

  updateAutoTracerouteResult(logId: number, success: boolean): void {
    this.misc!.updateAutoTracerouteResultSync(logId, success);
  }

  // Update the most recent pending auto-traceroute for a given destination
  updateAutoTracerouteResultByNode(toNodeNum: number, success: boolean): void {
    this.misc!.updateAutoTracerouteResultByNodeSync(toNodeNum, success);
  }

  getAutoTracerouteLog(limit: number = 10, sourceId?: string): {
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }[] {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    return this.misc!.getAutoTracerouteLogSync(limit, sourceId);
  }

  /**
   * Async version of getAutoTracerouteLog - works with all database backends
   */
  async getAutoTracerouteLogAsync(limit: number = 10, sourceId?: string): Promise<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }[]> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.getAutoTracerouteLog(limit, sourceId);
    }
    return this.misc!.getAutoTracerouteLog(limit, sourceId);
  }

  /**
   * Async version of logAutoTracerouteAttempt - works with all database backends
   */
  async logAutoTracerouteAttemptAsync(toNodeNum: number, toNodeName: string | null, sourceId?: string): Promise<number> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.logAutoTracerouteAttempt(toNodeNum, toNodeName, sourceId);
    }
    return this.misc!.logAutoTracerouteAttempt(toNodeNum, toNodeName, sourceId);
  }

  /**
   * Async version of updateAutoTracerouteResultByNode - works with all database backends
   */
  async updateAutoTracerouteResultByNodeAsync(toNodeNum: number, success: boolean): Promise<void> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      this.updateAutoTracerouteResultByNode(toNodeNum, success);
      return;
    }
    await this.misc!.updateAutoTracerouteResultByNode(toNodeNum, success);
  }

  // Auto key repair state methods
  getKeyRepairState(nodeNum: number): {
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }

    return this.miscRepo!.getKeyRepairStateSqlite(nodeNum);
  }

  async getKeyRepairStateAsync(nodeNum: number): Promise<{
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const result = await client.query(
          `SELECT "nodeNum", "attemptCount", "lastAttemptTime", exhausted, "startedAt"
           FROM auto_key_repair_state WHERE "nodeNum" = $1`,
          [nodeNum]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        return {
          nodeNum: Number(row.nodeNum),
          attemptCount: row.attemptCount,
          lastAttemptTime: row.lastAttemptTime ? Number(row.lastAttemptTime) : null,
          exhausted: row.exhausted === 1,
          startedAt: Number(row.startedAt),
        };
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const [rows] = await pool.query(
        `SELECT nodeNum, attemptCount, lastAttemptTime, exhausted, startedAt
         FROM auto_key_repair_state WHERE nodeNum = ?`,
        [nodeNum]
      );
      const resultRows = rows as any[];
      if (resultRows.length === 0) return null;
      const row = resultRows[0];
      return {
        nodeNum: Number(row.nodeNum),
        attemptCount: row.attemptCount,
        lastAttemptTime: row.lastAttemptTime ? Number(row.lastAttemptTime) : null,
        exhausted: row.exhausted === 1,
        startedAt: Number(row.startedAt),
      };
    }
    // SQLite fallback
    return this.getKeyRepairState(nodeNum);
  }

  setKeyRepairState(nodeNum: number, state: {
    attemptCount?: number;
    lastAttemptTime?: number;
    exhausted?: boolean;
    startedAt?: number;
  }): void {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      this.setKeyRepairStateAsync(nodeNum, state).catch(err =>
        logger.error('Error setting key repair state:', err)
      );
      return;
    }

    const existing = this.getKeyRepairState(nodeNum);
    this.miscRepo!.setKeyRepairStateSqlite(nodeNum, state, existing);
  }

  async setKeyRepairStateAsync(nodeNum: number, state: {
    attemptCount?: number;
    lastAttemptTime?: number;
    exhausted?: boolean;
    startedAt?: number;
  }): Promise<void> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const existing = await this.getKeyRepairStateAsync(nodeNum);
        const now = Date.now();
        if (existing) {
          await client.query(
            `UPDATE auto_key_repair_state
             SET "attemptCount" = $1, "lastAttemptTime" = $2, exhausted = $3
             WHERE "nodeNum" = $4`,
            [
              state.attemptCount ?? existing.attemptCount,
              state.lastAttemptTime ?? existing.lastAttemptTime,
              (state.exhausted ?? existing.exhausted) ? 1 : 0,
              nodeNum
            ]
          );
        } else {
          await client.query(
            `INSERT INTO auto_key_repair_state ("nodeNum", "attemptCount", "lastAttemptTime", exhausted, "startedAt")
             VALUES ($1, $2, $3, $4, $5)`,
            [
              nodeNum,
              state.attemptCount ?? 0,
              state.lastAttemptTime ?? null,
              (state.exhausted ?? false) ? 1 : 0,
              state.startedAt ?? now
            ]
          );
        }
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const existing = await this.getKeyRepairStateAsync(nodeNum);
      const now = Date.now();
      if (existing) {
        await pool.query(
          `UPDATE auto_key_repair_state
           SET attemptCount = ?, lastAttemptTime = ?, exhausted = ?
           WHERE nodeNum = ?`,
          [
            state.attemptCount ?? existing.attemptCount,
            state.lastAttemptTime ?? existing.lastAttemptTime,
            (state.exhausted ?? existing.exhausted) ? 1 : 0,
            nodeNum
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO auto_key_repair_state (nodeNum, attemptCount, lastAttemptTime, exhausted, startedAt)
           VALUES (?, ?, ?, ?, ?)`,
          [
            nodeNum,
            state.attemptCount ?? 0,
            state.lastAttemptTime ?? null,
            (state.exhausted ?? false) ? 1 : 0,
            state.startedAt ?? now
          ]
        );
      }
    } else {
      // SQLite fallback
      this.setKeyRepairState(nodeNum, state);
    }
  }

  clearKeyRepairState(nodeNum: number): void {
    // For PostgreSQL/MySQL, delegate to async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      this.clearKeyRepairStateAsync(nodeNum).catch(err =>
        logger.error('Error clearing key repair state:', err)
      );
      return;
    }

    this.miscRepo!.clearKeyRepairStateSqlite(nodeNum);
  }

  getNodesNeedingKeyRepair(): {
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    attemptCount: number;
    lastAttemptTime: number | null;
    startedAt: number | null;
  }[] {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    // Get nodes with keyMismatchDetected=true that are not exhausted
    return this.miscRepo!.getNodesNeedingKeyRepairSqlite();
  }

  async getNodesNeedingKeyRepairAsync(): Promise<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    attemptCount: number;
    lastAttemptTime: number | null;
    startedAt: number | null;
  }[]> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const result = await client.query(
          `SELECT
            n."nodeNum",
            n."nodeId",
            n."longName",
            n."shortName",
            COALESCE(s."attemptCount", 0) as "attemptCount",
            s."lastAttemptTime",
            s."startedAt"
          FROM nodes n
          LEFT JOIN auto_key_repair_state s ON n."nodeNum" = s."nodeNum"
          WHERE n."keyMismatchDetected" = true
            AND (s.exhausted IS NULL OR s.exhausted = 0)`
        );
        return result.rows.map((row: any) => ({
          nodeNum: Number(row.nodeNum),
          nodeId: row.nodeId,
          longName: row.longName ?? null,
          shortName: row.shortName ?? null,
          attemptCount: Number(row.attemptCount),
          lastAttemptTime: row.lastAttemptTime ? Number(row.lastAttemptTime) : null,
          startedAt: row.startedAt ? Number(row.startedAt) : null,
        }));
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const [rows] = await pool.query(
        `SELECT
          n.nodeNum,
          n.nodeId,
          n.longName,
          n.shortName,
          COALESCE(s.attemptCount, 0) as attemptCount,
          s.lastAttemptTime,
          s.startedAt
        FROM nodes n
        LEFT JOIN auto_key_repair_state s ON n.nodeNum = s.nodeNum
        WHERE n.keyMismatchDetected = 1
          AND (s.exhausted IS NULL OR s.exhausted = 0)`
      );
      return (rows as any[]).map((row: any) => ({
        nodeNum: Number(row.nodeNum),
        nodeId: row.nodeId,
        longName: row.longName ?? null,
        shortName: row.shortName ?? null,
        attemptCount: Number(row.attemptCount),
        lastAttemptTime: row.lastAttemptTime ? Number(row.lastAttemptTime) : null,
        startedAt: row.startedAt ? Number(row.startedAt) : null,
      }));
    }
    // SQLite fallback
    return this.getNodesNeedingKeyRepair();
  }

  // Auto key repair log methods
  logKeyRepairAttempt(nodeNum: number, nodeName: string | null, action: string, success: boolean | null = null): number {
    // For PostgreSQL/MySQL, delegate to async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      this.logKeyRepairAttemptAsync(nodeNum, nodeName, action, success).catch(err =>
        logger.error('Error logging key repair attempt:', err)
      );
      return 0;
    }

    return this.miscRepo!.logKeyRepairAttemptSqlite(nodeNum, nodeName, action, success, null, null, null);
  }

  getKeyRepairLog(limit: number = 50): {
    id: number;
    timestamp: number;
    nodeNum: number;
    nodeName: string | null;
    action: string;
    success: boolean | null;
  }[] {
    // For PostgreSQL/MySQL, key repair logging is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    const rows = this.miscRepo!.getKeyRepairLogSqlite(limit, undefined, false, false);
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      nodeNum: r.nodeNum,
      nodeName: r.nodeName,
      action: r.action,
      success: r.success,
    }));
  }

  async logKeyRepairAttemptAsync(
    nodeNum: number,
    nodeName: string | null,
    action: string,
    success: boolean | null = null,
    oldKeyFragment: string | null = null,
    newKeyFragment: string | null = null,
    sourceId: string | null = null
  ): Promise<number> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        const result = await client.query(
          `INSERT INTO auto_key_repair_log (timestamp, "nodeNum", "nodeName", action, success, created_at, "oldKeyFragment", "newKeyFragment", "sourceId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [Date.now(), nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), Date.now(), oldKeyFragment, newKeyFragment, sourceId]
        );
        await client.query(
          `DELETE FROM auto_key_repair_log WHERE id NOT IN (
            SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100
          )`
        );
        return result.rows[0]?.id || 0;
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      const [result] = await pool.query(
        `INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at, oldKeyFragment, newKeyFragment, sourceId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Date.now(), nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), Date.now(), oldKeyFragment, newKeyFragment, sourceId]
      );
      await pool.query(
        `DELETE FROM auto_key_repair_log WHERE id NOT IN (
          SELECT id FROM (SELECT id FROM auto_key_repair_log ORDER BY timestamp DESC LIMIT 100) as t
        )`
      );
      return (result as any).insertId || 0;
    }
    // SQLite fallback - delegate to repo (uses raw better-sqlite3 for extended columns)
    return this.miscRepo!.logKeyRepairAttemptSqlite(nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment, sourceId);
  }

  async getKeyRepairLogAsync(limit: number = 50, sourceId?: string): Promise<{
    id: number;
    timestamp: number;
    nodeNum: number;
    nodeName: string | null;
    action: string;
    success: boolean | null;
    oldKeyFragment: string | null;
    newKeyFragment: string | null;
  }[]> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        // Check if table exists (may not exist if auto-key management was never enabled)
        const tableCheck = await client.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'auto_key_repair_log'"
        );
        if (tableCheck.rows.length === 0) {
          return [];
        }

        // Check if migration 084 columns exist
        const colCheck = await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
        );
        const selectCols = colCheck.rows.length > 0
          ? 'id, timestamp, "nodeNum", "nodeName", action, success, "oldKeyFragment", "newKeyFragment"'
          : 'id, timestamp, "nodeNum", "nodeName", action, success';

        // Check if sourceId column exists (migration 027)
        const sourceColCheck = await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'auto_key_repair_log' AND column_name = 'sourceId'"
        );
        const hasSourceId = sourceColCheck.rows.length > 0;
        const whereClause = sourceId && hasSourceId ? `WHERE "sourceId" = $2` : '';
        const params: any[] = sourceId && hasSourceId ? [limit, sourceId] : [limit];

        const result = await client.query(
          `SELECT ${selectCols} FROM auto_key_repair_log ${whereClause} ORDER BY timestamp DESC LIMIT $1`,
          params
        );
        return result.rows.map((row: any) => ({
          id: row.id,
          timestamp: Number(row.timestamp),
          nodeNum: Number(row.nodeNum),
          nodeName: row.nodeName,
          action: row.action,
          success: row.success === null ? null : Boolean(row.success),
          oldKeyFragment: row.oldKeyFragment || null,
          newKeyFragment: row.newKeyFragment || null,
        }));
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;

      // Check if table exists (may not exist if auto-key management was never enabled)
      const [tableRows] = await pool.query(
        "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log'"
      );
      if ((tableRows as any[]).length === 0) {
        return [];
      }

      // Check if migration 084 columns exist
      const [colRows] = await pool.query(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'oldKeyFragment'"
      );
      const selectCols = (colRows as any[]).length > 0
        ? 'id, timestamp, nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment'
        : 'id, timestamp, nodeNum, nodeName, action, success';

      // Check if sourceId column exists (migration 027)
      const [sourceColRows] = await pool.query(
        "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'auto_key_repair_log' AND column_name = 'sourceId'"
      );
      const hasSourceIdMy = (sourceColRows as any[]).length > 0;
      const whereClauseMy = sourceId && hasSourceIdMy ? 'WHERE sourceId = ?' : '';
      const paramsMy: any[] = sourceId && hasSourceIdMy ? [sourceId, limit] : [limit];

      const [rows] = await pool.query(
        `SELECT ${selectCols} FROM auto_key_repair_log ${whereClauseMy} ORDER BY timestamp DESC LIMIT ?`,
        paramsMy
      );
      return (rows as any[]).map((row: any) => ({
        id: row.id,
        timestamp: Number(row.timestamp),
        nodeNum: Number(row.nodeNum),
        nodeName: row.nodeName,
        action: row.action,
        success: row.success === null ? null : Boolean(row.success),
        oldKeyFragment: row.oldKeyFragment || null,
        newKeyFragment: row.newKeyFragment || null,
      }));
    }
    // SQLite — delegate to repository (introspection + fetch)
    const { tableExists, hasOldKeyCol, hasSourceId } = this.miscRepo!.getKeyRepairLogIntrospectionSqlite();
    if (!tableExists) return [];
    return this.miscRepo!.getKeyRepairLogSqlite(limit, sourceId, hasOldKeyCol, hasSourceId);
  }

  // Distance delete log methods moved to MiscRepository (databaseService.misc.getDistanceDeleteLog / addDistanceDeleteLogEntry)

  async clearKeyRepairStateAsync(nodeNum: number): Promise<void> {
    if (this.drizzleDbType === 'postgres') {
      const client = await this.postgresPool!.connect();
      try {
        await client.query('DELETE FROM auto_key_repair_state WHERE "nodeNum" = $1', [nodeNum]);
      } finally {
        client.release();
      }
    } else if (this.drizzleDbType === 'mysql') {
      const pool = this.mysqlPool!;
      await pool.query('DELETE FROM auto_key_repair_state WHERE nodeNum = ?', [nodeNum]);
    } else {
      this.clearKeyRepairState(nodeNum);
    }
  }

  getTelemetryByType(telemetryType: string, limit: number = 100): DbTelemetry[] {
    // For PostgreSQL/MySQL, telemetry is async - return empty for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    return this.telemetry.getTelemetryByTypeSync(telemetryType, limit) as unknown as DbTelemetry[];
  }

  /** @deprecated Use databaseService.telemetry.getTelemetryByType() instead */
  async getTelemetryByTypeAsync(telemetryType: string, limit: number = 100): Promise<DbTelemetry[]> {
    // Cast to local DbTelemetry type (they have compatible structure)
    return this.telemetry.getTelemetryByType(telemetryType, limit) as unknown as DbTelemetry[];
  }

  getLatestTelemetryByNode(nodeId: string): DbTelemetry[] {
    // For PostgreSQL/MySQL, telemetry is async - return empty for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    return this.telemetry.getLatestTelemetryByNodeSync(nodeId) as unknown as DbTelemetry[];
  }

  getLatestTelemetryForType(nodeId: string, telemetryType: string): DbTelemetry | null {
    // For PostgreSQL/MySQL, telemetry is not cached - return null for sync calls
    // This is used for checking node capabilities, not critical for operation
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Telemetry queries require async, so return null for sync interface
      // The actual data will be fetched via API endpoints which can be async
      return null;
    }
    return this.telemetry.getLatestTelemetryForTypeSync(nodeId, telemetryType) as unknown as DbTelemetry | null;
  }

  /**
   * Async version of getLatestTelemetryForType - works with all database backends
   */
  async getLatestTelemetryForTypeAsync(nodeId: string, telemetryType: string): Promise<DbTelemetry | null> {
    const result = await this.telemetry.getLatestTelemetryForType(nodeId, telemetryType);
    if (!result) return null;
    // Normalize the result to match DbTelemetry interface (convert null to undefined)
    return {
      id: result.id,
      nodeId: result.nodeId,
      nodeNum: result.nodeNum,
      telemetryType: result.telemetryType,
      timestamp: result.timestamp,
      value: result.value,
      unit: result.unit ?? undefined,
      createdAt: result.createdAt,
      packetTimestamp: result.packetTimestamp ?? undefined,
      channel: result.channel ?? undefined,
      precisionBits: result.precisionBits ?? undefined,
      gpsAccuracy: result.gpsAccuracy ?? undefined,
    };
  }

  /** @deprecated Use databaseService.telemetry.getLatestTelemetryValueForAllNodes() instead */
  async getLatestTelemetryValueForAllNodesAsync(telemetryType: string): Promise<Map<string, number>> {
    return this.telemetry.getLatestTelemetryValueForAllNodes(telemetryType);
  }

  // Get distinct telemetry types per node (efficient for checking capabilities)
  getNodeTelemetryTypes(nodeId: string): string[] {
    // For PostgreSQL/MySQL, return empty array for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    return this.telemetry.getNodeTelemetryTypesSync(nodeId);
  }

  // Get all nodes with their telemetry types (cached for performance)
  // This query can be slow with large telemetry tables, so results are cached
  getAllNodesTelemetryTypes(): Map<string, string[]> {
    const now = Date.now();

    // Return cached result if still valid
    if (
      this.telemetryTypesCache !== null &&
      now - this.telemetryTypesCacheTime < DatabaseService.TELEMETRY_TYPES_CACHE_TTL_MS
    ) {
      return this.telemetryTypesCache;
    }

    // For PostgreSQL/MySQL, use async query and cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        // Fire async query and update cache in background
        this.telemetryRepo.getAllNodesTelemetryTypes().then(map => {
          this.telemetryTypesCache = map;
          this.telemetryTypesCacheTime = Date.now();
        }).catch(err => logger.debug('Failed to fetch telemetry types:', err));
      }
      // Return existing cache or empty map
      return this.telemetryTypesCache || new Map();
    }

    // SQLite: query the database and update cache
    const map = this.telemetry.getAllNodesTelemetryTypesSync();

    this.telemetryTypesCache = map;
    this.telemetryTypesCacheTime = now;

    return map;
  }

  // Get all nodes with their telemetry types (async version)
  async getAllNodesTelemetryTypesAsync(): Promise<Map<string, string[]>> {
    const now = Date.now();

    // Return cached result if still valid
    if (
      this.telemetryTypesCache !== null &&
      now - this.telemetryTypesCacheTime < DatabaseService.TELEMETRY_TYPES_CACHE_TTL_MS
    ) {
      return this.telemetryTypesCache;
    }

    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const map = await this.telemetry.getAllNodesTelemetryTypes();
      this.telemetryTypesCache = map;
      this.telemetryTypesCacheTime = Date.now();
      return map;
    }

    // SQLite: query the database and update cache
    const map = this.telemetry.getAllNodesTelemetryTypesSync();

    this.telemetryTypesCache = map;
    this.telemetryTypesCacheTime = now;

    return map;
  }

  // Invalidate the telemetry types cache (call when new telemetry is inserted)
  invalidateTelemetryTypesCache(): void {
    this.telemetryTypesCacheTime = 0;
  }

  // Danger zone operations
  purgeAllNodes(): void {
    logger.debug('⚠️ PURGING all nodes and related data from database');

    // For PostgreSQL/MySQL, clear cache and fire-and-forget async purge
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Clear the nodes cache immediately
      this.nodesCache.clear();

      // Fire-and-forget async purge
      this.purgeAllNodesAsync().catch(err => {
        logger.error('Failed to purge all nodes from database:', err);
      });

      logger.debug('✅ Cache cleared, async purge started');
      return;
    }

    // SQLite: synchronous deletion
    // Delete in order to respect foreign key constraints
    // First delete all child records that reference nodes
    if (this.messagesRepo) {
      this.messagesRepo.deleteAllMessagesSqlite();
    }
    this.telemetry.deleteAllTelemetrySync();
    this.traceroutes.deleteAllTraceroutesSync();
    this.traceroutes.deleteAllRouteSegmentsSync();
    if (this.neighborsRepo) {
      // Use Drizzle repo for all backends (including SQLite)
      this.neighborsRepo.deleteAllNeighborInfo().catch(err =>
        logger.debug('Failed to delete all neighbor info:', err)
      );
    }
    // Finally delete the nodes themselves
    this.nodesRepo!.truncateNodesSqlite();
    // Telemetry cache invalidation after bulk purge
    this.invalidateTelemetryTypesCache();
    logger.debug('✅ Successfully purged all nodes and related data');
  }

  purgeAllTelemetry(): void {
    logger.debug('⚠️ PURGING all telemetry from database');

    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        this.telemetryRepo.deleteAllTelemetry().then(() => {
          logger.debug('✅ Successfully purged all telemetry');
          this.invalidateTelemetryTypesCache();
        }).catch(err => {
          logger.error('Failed to purge all telemetry:', err);
        });
      } else {
        logger.warn('Cannot purge telemetry: telemetry repository not initialized');
      }
      return;
    }

    this.telemetry.deleteAllTelemetrySync();
    this.invalidateTelemetryTypesCache();
  }

  purgeOldTelemetry(hoursToKeep: number, favoriteDaysToKeep?: number): number {
    // PostgreSQL/MySQL: Use async telemetry repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const regularCutoffTime = Date.now() - (hoursToKeep * 60 * 60 * 1000);

      if (this.telemetryRepo) {
        // If no favorite days specified, use simple deletion
        if (!favoriteDaysToKeep) {
          this.telemetryRepo.deleteOldTelemetry(regularCutoffTime).then(count => {
            logger.debug(`🧹 Purged ${count} old telemetry records (keeping last ${hoursToKeep} hours)`);
          }).catch(error => {
            logger.error('Error purging old telemetry:', error);
          });
        } else {
          // Get favorites and use favorites-aware deletion
          const favoritesStr = this.getSetting('telemetryFavorites');
          let favorites: Array<{ nodeId: string; telemetryType: string }> = [];
          if (favoritesStr) {
            try {
              favorites = JSON.parse(favoritesStr);
            } catch (error) {
              logger.error('Failed to parse telemetryFavorites from settings:', error);
            }
          }

          const favoriteCutoffTime = Date.now() - (favoriteDaysToKeep * 24 * 60 * 60 * 1000);

          this.telemetryRepo.deleteOldTelemetryWithFavorites(
            regularCutoffTime,
            favoriteCutoffTime,
            favorites
          ).then(({ nonFavoritesDeleted, favoritesDeleted }) => {
            logger.debug(
              `🧹 Purged ${nonFavoritesDeleted + favoritesDeleted} old telemetry records ` +
              `(${nonFavoritesDeleted} non-favorites older than ${hoursToKeep}h, ` +
              `${favoritesDeleted} favorites older than ${favoriteDaysToKeep}d)`
            );
          }).catch(error => {
            logger.error('Error purging old telemetry:', error);
          });
        }
      }
      return 0; // Cannot return sync count for async operation
    }

    const regularCutoffTime = Date.now() - (hoursToKeep * 60 * 60 * 1000);

    // If no favorite storage duration specified, purge all telemetry older than hoursToKeep
    if (!favoriteDaysToKeep) {
      const deleted = this.telemetry.deleteOldTelemetrySync(regularCutoffTime);
      logger.debug(`🧹 Purged ${deleted} old telemetry records (keeping last ${hoursToKeep} hours)`);
      if (deleted > 0) this.invalidateTelemetryTypesCache();
      return deleted;
    }

    // Get the list of favorited telemetry from settings
    const favoritesStr = this.getSetting('telemetryFavorites');
    let favorites: Array<{ nodeId: string; telemetryType: string }> = [];
    if (favoritesStr) {
      try {
        favorites = JSON.parse(favoritesStr);
      } catch (error) {
        logger.error('Failed to parse telemetryFavorites from settings:', error);
      }
    }

    // If no favorites, just purge everything older than hoursToKeep
    if (favorites.length === 0) {
      const deleted = this.telemetry.deleteOldTelemetrySync(regularCutoffTime);
      logger.debug(`🧹 Purged ${deleted} old telemetry records (keeping last ${hoursToKeep} hours, no favorites)`);
      if (deleted > 0) this.invalidateTelemetryTypesCache();
      return deleted;
    }

    // Calculate the cutoff time for favorited telemetry
    const favoriteCutoffTime = Date.now() - (favoriteDaysToKeep * 24 * 60 * 60 * 1000);

    const { nonFavoritesDeleted, favoritesDeleted } = this.telemetry.deleteOldTelemetryWithFavoritesSync(
      regularCutoffTime,
      favoriteCutoffTime,
      favorites
    );
    const totalDeleted = nonFavoritesDeleted + favoritesDeleted;

    logger.debug(
      `🧹 Purged ${totalDeleted} old telemetry records ` +
      `(${nonFavoritesDeleted} non-favorites older than ${hoursToKeep}h, ` +
      `${favoritesDeleted} favorites older than ${favoriteDaysToKeep}d)`
    );
    if (totalDeleted > 0) this.invalidateTelemetryTypesCache();
    return totalDeleted;
  }

  /**
   * Purge all telemetry data (async version)
   */
  async purgeAllTelemetryAsync(): Promise<void> {
    logger.debug('⚠️ PURGING all telemetry from database');

    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      await this.telemetry.deleteAllTelemetry();
      this.invalidateTelemetryTypesCache();
      logger.debug('✅ Successfully purged all telemetry');
      return;
    }

    this.telemetry.deleteAllTelemetrySync();
    this.invalidateTelemetryTypesCache();
    logger.debug('✅ Successfully purged all telemetry');
  }

  /**
   * Purge old telemetry data (async version)
   */
  async purgeOldTelemetryAsync(hoursToKeep: number, favoriteDaysToKeep?: number): Promise<number> {
    const regularCutoffTime = Date.now() - (hoursToKeep * 60 * 60 * 1000);

    // PostgreSQL/MySQL: Use async telemetry repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!favoriteDaysToKeep) {
        const count = await this.telemetry.deleteOldTelemetry(regularCutoffTime);
        logger.debug(`🧹 Purged ${count} old telemetry records (keeping last ${hoursToKeep} hours)`);
        return count;
      }

      // Get favorites and use favorites-aware deletion
      const favoritesStr = await this.getSettingAsync('telemetryFavorites');
      let favorites: Array<{ nodeId: string; telemetryType: string }> = [];
      if (favoritesStr) {
        try {
          favorites = JSON.parse(favoritesStr);
        } catch (error) {
          logger.error('Failed to parse telemetryFavorites from settings:', error);
        }
      }

      const favoriteCutoffTime = Date.now() - (favoriteDaysToKeep * 24 * 60 * 60 * 1000);
      const { nonFavoritesDeleted, favoritesDeleted } = await this.telemetry.deleteOldTelemetryWithFavorites(
        regularCutoffTime,
        favoriteCutoffTime,
        favorites
      );
      const totalDeleted = nonFavoritesDeleted + favoritesDeleted;
      logger.debug(
        `🧹 Purged ${totalDeleted} old telemetry records ` +
        `(${nonFavoritesDeleted} non-favorites older than ${hoursToKeep}h, ` +
        `${favoritesDeleted} favorites older than ${favoriteDaysToKeep}d)`
      );
      return totalDeleted;
    }

    // SQLite: synchronous path via repository
    if (!favoriteDaysToKeep) {
      const deleted = this.telemetry.deleteOldTelemetrySync(regularCutoffTime);
      logger.debug(`🧹 Purged ${deleted} old telemetry records (keeping last ${hoursToKeep} hours)`);
      if (deleted > 0) this.invalidateTelemetryTypesCache();
      return deleted;
    }

    const favoritesStr = this.getSetting('telemetryFavorites');
    let favorites: Array<{ nodeId: string; telemetryType: string }> = [];
    if (favoritesStr) {
      try {
        favorites = JSON.parse(favoritesStr);
      } catch (error) {
        logger.error('Failed to parse telemetryFavorites from settings:', error);
      }
    }

    if (favorites.length === 0) {
      const deleted = this.telemetry.deleteOldTelemetrySync(regularCutoffTime);
      logger.debug(`🧹 Purged ${deleted} old telemetry records (keeping last ${hoursToKeep} hours, no favorites)`);
      if (deleted > 0) this.invalidateTelemetryTypesCache();
      return deleted;
    }

    const favoriteCutoffTime = Date.now() - (favoriteDaysToKeep * 24 * 60 * 60 * 1000);

    const { nonFavoritesDeleted, favoritesDeleted } = this.telemetry.deleteOldTelemetryWithFavoritesSync(
      regularCutoffTime,
      favoriteCutoffTime,
      favorites
    );
    const totalDeleted = nonFavoritesDeleted + favoritesDeleted;

    logger.debug(
      `🧹 Purged ${totalDeleted} old telemetry records ` +
      `(${nonFavoritesDeleted} non-favorites older than ${hoursToKeep}h, ` +
      `${favoritesDeleted} favorites older than ${favoriteDaysToKeep}d)`
    );
    if (totalDeleted > 0) this.invalidateTelemetryTypesCache();
    return totalDeleted;
  }


  // Settings methods
  async getSettingAsync(key: string): Promise<string | null> {
    // For PostgreSQL/MySQL, use the async repository
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.settingsRepo) {
      return this.settingsRepo.getSetting(key);
    }
    // For SQLite (and test environments), use the sync method which uses raw better-sqlite3
    return this.getSetting(key);
  }

  getSetting(key: string): string | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getSetting('${key}') called before cache initialized`);
        return null;
      }
      return this.settingsCache.get(key) ?? null;
    }
    // SQLite: route through repo's sync drizzle path (no raw SQL)
    if (this.settingsRepo) {
      return this.settingsRepo.getSettingSync(key);
    }
    return null;
  }

  getAllSettings(): Record<string, string> {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getAllSettings() called before cache initialized');
        return {};
      }
      const settings: Record<string, string> = {};
      this.settingsCache.forEach((value, key) => {
        settings[key] = value;
      });
      return settings;
    }
    // SQLite: route through repo's sync drizzle path (no raw SQL)
    if (this.settingsRepo) {
      return this.settingsRepo.getAllSettingsSync();
    }
    return {};
  }

  setSetting(key: string, value: string): void {
    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Update cache immediately for sync access
      this.settingsCache.set(key, value);
      // Fire and forget repo write
      if (this.settingsRepo) {
        this.settingsRepo.setSetting(key, value).catch(err => {
          logger.error(`Failed to set setting ${key}:`, err);
        });
      }
      return;
    }
    // SQLite: route through repo's sync drizzle path (no raw SQL)
    if (this.settingsRepo) {
      this.settingsRepo.setSettingSync(key, value);
    }
  }

  setSettings(settings: Record<string, string>): void {
    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Update cache immediately for sync access
      for (const [key, value] of Object.entries(settings)) {
        this.settingsCache.set(key, value);
      }
      if (this.settingsRepo) {
        this.settingsRepo.setSettings(settings).catch(err => {
          logger.error('Failed to set settings:', err);
        });
      }
      return;
    }
    // SQLite: route through repo's sync drizzle path (no raw SQL)
    if (this.settingsRepo) {
      this.settingsRepo.setSettingsSync(settings);
    }
  }

  deleteAllSettings(): void {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Clear cache immediately
      this.settingsCache.clear();
      if (this.settingsRepo) {
        this.settingsRepo.deleteAllSettings().catch(err => {
          logger.error('Failed to delete all settings:', err);
        });
      }
      return;
    }
    logger.debug('🔄 Resetting all settings to defaults');
    // SQLite: route through repo's sync drizzle path (no raw SQL)
    if (this.settingsRepo) {
      this.settingsRepo.deleteAllSettingsSync();
    }
  }

  // ============ ASYNC NOTIFICATION PREFERENCES METHODS ============

  /**
   * Delete a node and all associated data (scoped to sourceId — Phase 3C2)
   */
  async deleteNodeAsync(nodeNum: number, sourceId: string): Promise<{
    messagesDeleted: number;
    traceroutesDeleted: number;
    telemetryDeleted: number;
    nodeDeleted: boolean;
  }> {
    let messagesDeleted = 0;
    let traceroutesDeleted = 0;
    let telemetryDeleted = 0;
    let nodeDeleted = false;

    try {
      // Delete DMs to/from this node (scoped to this source)
      if (this.messagesRepo) {
        messagesDeleted = await this.messagesRepo.purgeDirectMessages(nodeNum, sourceId);
      }

      // Delete traceroutes for this node (scoped to this source)
      if (this.traceroutesRepo) {
        traceroutesDeleted = await this.traceroutesRepo.deleteTraceroutesForNode(nodeNum, sourceId);
        // Also delete route segments (no-op when scoped — route_segments lacks sourceId column)
        await this.traceroutesRepo.deleteRouteSegmentsForNode(nodeNum, sourceId);
      }

      // Delete telemetry for this node (scoped to this source)
      if (this.telemetryRepo) {
        telemetryDeleted = await this.telemetryRepo.purgeNodeTelemetry(nodeNum, sourceId);
      }

      // Delete neighbor info for this node (scoped to this source)
      if (this.neighborsRepo) {
        await this.neighborsRepo.deleteNeighborInfoForNode(nodeNum, sourceId);
      }

      // Delete the node itself (scoped to sourceId)
      if (this.nodesRepo) {
        nodeDeleted = await this.nodesRepo.deleteNodeRecord(nodeNum, sourceId);
      }

      // Also remove from cache (scoped lookup)
      this.nodesCache.delete(this.cacheKey(nodeNum, sourceId));

      logger.debug(`Deleted node ${nodeNum}@${sourceId}: messages=${messagesDeleted}, traceroutes=${traceroutesDeleted}, telemetry=${telemetryDeleted}, node=${nodeDeleted}`);
    } catch (error) {
      logger.error(`Error deleting node ${nodeNum}@${sourceId}:`, error);
      throw error;
    }

    return { messagesDeleted, traceroutesDeleted, telemetryDeleted, nodeDeleted };
  }

  /**
   * Purge all nodes and related data (async version for PostgreSQL)
   */
  async purgeAllNodesAsync(): Promise<void> {
    logger.debug('⚠️ PURGING all nodes and related data from database (async)');

    try {
      // Delete in order to respect foreign key constraints
      // First delete all child records that reference nodes
      if (this.messagesRepo) {
        await this.messagesRepo.deleteAllMessages();
      }
      if (this.telemetryRepo) {
        await this.telemetryRepo.deleteAllTelemetry();
      }
      if (this.traceroutesRepo) {
        await this.traceroutesRepo.deleteAllTraceroutes();
        await this.traceroutesRepo.deleteAllRouteSegments();
      }
      if (this.neighborsRepo) {
        await this.neighborsRepo.deleteAllNeighborInfo();
      }
      // Finally delete the nodes themselves
      if (this.nodesRepo) {
        await this.nodesRepo.deleteAllNodes();
      }

      // Clear the cache
      this.nodesCache.clear();

      logger.debug('✅ Successfully purged all nodes and related data (async)');
    } catch (error) {
      logger.error('Error purging all nodes:', error);
      throw error;
    }
  }

  // Route segment operations
  insertRouteSegment(segmentData: DbRouteSegment, sourceId?: string): void {
    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.insertRouteSegment(segmentData, sourceId).catch((error) => {
          logger.error('[DatabaseService] Failed to insert route segment:', error);
        });
      }
      return;
    }

    // SQLite path
    this.traceroutesRepo!.insertRouteSegmentSync(segmentData, sourceId);
  }

  getLongestActiveRouteSegment(sourceId?: string): DbRouteSegment | null {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }
    return this.traceroutesRepo!.getLongestActiveRouteSegmentSync(sourceId) as unknown as DbRouteSegment | null;
  }

  getRecordHolderRouteSegment(sourceId?: string): DbRouteSegment | null {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }
    return this.traceroutesRepo!.getRecordHolderRouteSegmentSync(sourceId) as unknown as DbRouteSegment | null;
  }

  updateRecordHolderSegment(newSegment: DbRouteSegment, sourceId?: string): void {
    // For PostgreSQL/MySQL, use async approach
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.getRecordHolderRouteSegment(sourceId).then(currentRecord => {
          if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
            // Clear existing record holder flag (per-source so one source's
            // new record doesn't unseat another source's record holder).
            this.traceroutesRepo!.clearRecordHolderBySource(sourceId).then(() => {
              this.traceroutesRepo!.insertRouteSegment({
                ...newSegment,
                isRecordHolder: true
              }, sourceId).catch((err: unknown) => logger.debug('Failed to insert record holder segment:', err));
            }).catch((err: unknown) => logger.debug('Failed to clear record holder segments:', err));
            logger.debug(`🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${newSegment.toNodeId}`);
          }
        }).catch(err => logger.debug('Failed to get record holder segment:', err));
      }
      return;
    }

    const currentRecord = this.getRecordHolderRouteSegment(sourceId);

    // If no current record or new segment is longer, update
    if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
      // Clear existing record holders for this source (IS NULL when scope is
      // global, exact match when scoped — keeps per-source records independent).
      this.traceroutesRepo!.clearRecordHolderSegmentSync(sourceId);

      // Insert new record holder
      this.insertRouteSegment({
        ...newSegment,
        isRecordHolder: true
      }, sourceId);

      logger.debug(`🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${newSegment.toNodeId}`);
    }
  }

  clearRecordHolderSegment(sourceId?: string): void {
    // For PostgreSQL/MySQL, use async approach
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.clearRecordHolderBySource(sourceId).catch((err: unknown) =>
          logger.debug('Failed to clear record holder segments:', err)
        );
      }
      logger.debug('🗑️ Cleared record holder route segment');
      return;
    }

    this.traceroutesRepo!.clearRecordHolderSegmentSync(sourceId);
    logger.debug('🗑️ Cleared record holder route segment');
  }

  cleanupOldRouteSegments(days: number = 30, sourceId?: string): number {
    // For PostgreSQL/MySQL, fire-and-forget async cleanup
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.cleanupOldRouteSegments(days, sourceId).catch((err: unknown) => {
          logger.debug('Failed to cleanup old route segments:', err);
        });
      }
      return 0;
    }

    return this.traceroutesRepo!.cleanupOldRouteSegmentsSync(days, sourceId);
  }

  /**
   * Delete traceroutes older than the specified number of days
   */
  cleanupOldTraceroutes(days: number = 30): number {
    // For PostgreSQL/MySQL, fire-and-forget async cleanup
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.cleanupOldTraceroutes(days * 24).catch(err => {
          logger.debug('Failed to cleanup old traceroutes:', err);
        });
      }
      return 0;
    }

    return this.traceroutesRepo!.cleanupOldTraceroutesSync(days);
  }

  /**
   * Delete neighbor info records older than the specified number of days
   */
  cleanupOldNeighborInfo(days: number = 30): number {
    if (this.neighborsRepo) {
      this.neighborsRepo.cleanupOldNeighborInfo(days).catch(err => {
        logger.debug('Failed to cleanup old neighbor info:', err);
      });
    }
    return 0;
  }

  /**
   * Run VACUUM to reclaim unused space in the database file
   * This can take a while on large databases and temporarily doubles disk usage
   */
  vacuum(): void {
    // For PostgreSQL/MySQL, use native vacuum/optimize
    if (this.drizzleDbType === 'postgres') {
      logger.info('🧹 Running VACUUM on PostgreSQL database...');
      this.postgresPool!.query('VACUUM').then(() => {
        logger.info('✅ PostgreSQL VACUUM complete');
      }).catch(err => {
        logger.error('Failed to VACUUM PostgreSQL:', err);
      });
      return;
    }
    if (this.drizzleDbType === 'mysql') {
      logger.info('🧹 Running OPTIMIZE TABLE on MySQL database...');
      // MySQL OPTIMIZE TABLE requires table names; skip for now as it's not critical
      logger.info('✅ MySQL OPTIMIZE TABLE skipped (not critical)');
      return;
    }

    logger.info('🧹 Running VACUUM on database...');
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    this.db.exec('VACUUM');
    logger.info('✅ VACUUM complete');
  }

  /**
   * Get the current database file size in bytes
   */
  getDatabaseSize(): number {
    // For PostgreSQL, use pg_database_size()
    if (this.drizzleDbType === 'postgres') {
      // Return 0 from sync context; use getDatabaseSizeAsync for accurate results
      return 0;
    }
    // For MySQL, use information_schema
    if (this.drizzleDbType === 'mysql') {
      // Return 0 from sync context; use getDatabaseSizeAsync for accurate results
      return 0;
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
    const result = stmt.get() as { size: number } | undefined;
    return result?.size ?? 0;
  }

  private _neighborsCache: DbNeighborInfo[] = [];
  private _neighborsByNodeCache: Map<number, DbNeighborInfo[]> = new Map();

  saveNeighborInfo(neighborInfo: Omit<DbNeighborInfo, 'id' | 'createdAt'>): void {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Update local cache immediately
      const newNeighbor: DbNeighborInfo = {
        id: 0, // Will be set by DB
        nodeNum: neighborInfo.nodeNum,
        neighborNodeNum: neighborInfo.neighborNodeNum,
        snr: neighborInfo.snr,
        lastRxTime: neighborInfo.lastRxTime,
        timestamp: neighborInfo.timestamp,
        createdAt: Date.now(),
      };
      this._neighborsCache.push(newNeighbor);

      if (this.neighborsRepo) {
        this.neighborsRepo.upsertNeighborInfo({
          ...neighborInfo,
          createdAt: Date.now()
        } as DbNeighborInfo).catch(err =>
          logger.debug('Failed to save neighbor info:', err)
        );
      }
      return;
    }

    if (this.neighborsRepo) {
      this.neighborsRepo.upsertNeighborInfo({
        ...neighborInfo,
        createdAt: Date.now()
      } as DbNeighborInfo).catch(err =>
        logger.debug('Failed to save neighbor info:', err)
      );
    }
  }

  /**
   * Clear all neighbor info for a specific node (called before saving new neighbor info)
   */
  clearNeighborInfoForNode(nodeNum: number): void {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Clear local cache for this node
      this._neighborsCache = this._neighborsCache.filter(n => n.nodeNum !== nodeNum);
      this._neighborsByNodeCache.delete(nodeNum);

      if (this.neighborsRepo) {
        this.neighborsRepo.deleteNeighborInfoForNode(nodeNum).catch(err =>
          logger.debug('Failed to clear neighbor info:', err)
        );
      }
      return;
    }

    // SQLite: use repo
    if (this.neighborsRepo) {
      this.neighborsRepo.deleteNeighborInfoForNode(nodeNum).catch(err =>
        logger.debug('Failed to clear neighbor info for node:', err)
      );
    }
  }

  private convertRepoNeighborInfo(n: import('../db/types.js').DbNeighborInfo): DbNeighborInfo {
    return {
      id: n.id,
      nodeNum: n.nodeNum,
      neighborNodeNum: n.neighborNodeNum,
      snr: n.snr ?? undefined,
      lastRxTime: n.lastRxTime ?? undefined,
      timestamp: n.timestamp,
      createdAt: n.createdAt,
    };
  }

  getNeighborsForNode(nodeNum: number): DbNeighborInfo[] {
    // All backends: fire async repo refresh, return cached data immediately
    if (this.neighborsRepo) {
      this.neighborsRepo.getNeighborsForNode(nodeNum).then(neighbors => {
        this._neighborsByNodeCache.set(nodeNum, neighbors.map(n => this.convertRepoNeighborInfo(n)));
      }).catch(err => logger.debug('Failed to get neighbors for node:', err));
    }
    return this._neighborsByNodeCache.get(nodeNum) || [];
  }

  getAllNeighborInfo(): DbNeighborInfo[] {
    // All backends: fire async repo refresh, return cached data immediately
    if (this.neighborsRepo) {
      this.neighborsRepo.getAllNeighborInfo().then(neighbors => {
        this._neighborsCache = neighbors.map(n => this.convertRepoNeighborInfo(n));
      }).catch(err => logger.debug('Failed to get all neighbor info:', err));
    }
    return this._neighborsCache;
  }

  getLatestNeighborInfoPerNode(): DbNeighborInfo[] {
    // All backends: return the in-memory cache (populated via async repo calls)
    // The cache is populated by getAllNeighborInfo() which fires on each read
    return this._neighborsCache;
  }

  getLatestNeighborInfoPerNodeScoped(sourceId?: string): DbNeighborInfo[] {
    if (!sourceId) return this.getLatestNeighborInfoPerNode();
    return this._neighborsCache.filter((ni: any) => ni.sourceId === sourceId);
  }

  /**
   * Get direct neighbor RSSI statistics from zero-hop packets
   *
   * Queries packet_log for packets received directly (hop_start == hop_limit),
   * aggregating RSSI values to help identify likely relay nodes.
   *
   * @param hoursBack Number of hours to look back (default 24)
   * @returns Record mapping nodeNum to stats {avgRssi, packetCount, lastHeard}
   */
  async getDirectNeighborStatsAsync(hoursBack: number = 24): Promise<Record<number, { avgRssi: number; packetCount: number; lastHeard: number }>> {
    const stats = await this.neighbors.getDirectNeighborRssiAsync(hoursBack);
    const result: Record<number, { avgRssi: number; packetCount: number; lastHeard: number }> = {};

    for (const [nodeNum, stat] of stats) {
      result[nodeNum] = {
        avgRssi: stat.avgRssi,
        packetCount: stat.packetCount,
        lastHeard: stat.lastHeard,
      };
    }

    return result;
  }

  /**
   * Delete all neighbor info for a specific node
   *
   * @param nodeNum The node number to delete neighbor info for
   * @returns Number of neighbor records deleted
   */
  async deleteNeighborInfoForNodeAsync(nodeNum: number): Promise<number> {
    // Clear from cache
    this._neighborsByNodeCache.delete(nodeNum);
    this._neighborsCache = this._neighborsCache.filter(n => n.nodeNum !== nodeNum);

    // Count then delete from database
    const count = await this.neighbors.getNeighborCountForNode(nodeNum);
    await this.neighbors.deleteNeighborInfoForNode(nodeNum);
    logger.info(`Deleted ${count} neighbor records for node ${nodeNum}`);
    return count;
  }

  // Favorite operations (scoped to sourceId — Phase 3C2)
  setNodeFavorite(nodeNum: number, isFavorite: boolean, sourceId: string, favoriteLocked?: boolean): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.isFavorite = isFavorite;
        if (favoriteLocked !== undefined) {
          cachedNode.favoriteLocked = favoriteLocked;
        }
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.setNodeFavorite(nodeNum, isFavorite, sourceId, favoriteLocked).catch(err => {
          logger.error(`Failed to set node favorite in database:`, err);
        });
      }

      logger.debug(`${isFavorite ? '⭐' : '☆'} Node ${nodeNum}@${sourceId} favorite status set to: ${isFavorite}, locked: ${favoriteLocked}`);
      return;
    }

    // SQLite: synchronous update
    const now = Date.now();
    if (favoriteLocked !== undefined) {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare(`
        UPDATE nodes SET
          isFavorite = ?,
          favoriteLocked = ?,
          updatedAt = ?
        WHERE nodeNum = ? AND sourceId = ?
      `);
      const result = stmt.run(isFavorite ? 1 : 0, favoriteLocked ? 1 : 0, now, nodeNum, sourceId);
      if (result.changes === 0) {
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.warn(`⚠️ Failed to update favorite for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
        throw new Error(`Node ${nodeId} not found`);
      }
      logger.debug(`${isFavorite ? '⭐' : '☆'} Node ${nodeNum}@${sourceId} favorite status set to: ${isFavorite}, locked: ${favoriteLocked} (${result.changes} row updated)`);
    } else {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare(`
        UPDATE nodes SET
          isFavorite = ?,
          updatedAt = ?
        WHERE nodeNum = ? AND sourceId = ?
      `);
      const result = stmt.run(isFavorite ? 1 : 0, now, nodeNum, sourceId);
      if (result.changes === 0) {
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.warn(`⚠️ Failed to update favorite for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
        throw new Error(`Node ${nodeId} not found`);
      }
      logger.debug(`${isFavorite ? '⭐' : '☆'} Node ${nodeNum}@${sourceId} favorite status set to: ${isFavorite} (${result.changes} row updated)`);
    }
  }

  setNodeFavoriteLocked(nodeNum: number, favoriteLocked: boolean, sourceId: string): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.favoriteLocked = favoriteLocked;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.setNodeFavoriteLocked(nodeNum, favoriteLocked, sourceId).catch(err => {
          logger.error(`Failed to set node favoriteLocked in database:`, err);
        });
      }

      logger.debug(`Node ${nodeNum}@${sourceId} favoriteLocked set to: ${favoriteLocked}`);
      return;
    }

    // SQLite: synchronous update
    const now = Date.now();
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        favoriteLocked = ?,
        updatedAt = ?
      WHERE nodeNum = ? AND sourceId = ?
    `);
    const result = stmt.run(favoriteLocked ? 1 : 0, now, nodeNum, sourceId);

    if (result.changes === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update favoriteLocked for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`Node ${nodeNum}@${sourceId} favoriteLocked set to: ${favoriteLocked} (${result.changes} row updated)`);
  }

  // Ignored operations (scoped to sourceId — Phase 3C2)
  setNodeIgnored(nodeNum: number, isIgnored: boolean, sourceId: string): void {
    // Get the node info for the persistent ignore list
    const node = this.getNode(nodeNum, sourceId);
    const nodeId = node?.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;

    // Persist to/remove from the per-source ignored_nodes table (migration 048).
    if (isIgnored) {
      this.ignoredNodes.addIgnoredNodeAsync(
        nodeNum, sourceId, nodeId, node?.longName, node?.shortName
      ).catch(err => {
        logger.error('Failed to add node to per-source ignore list:', err);
      });
    } else {
      this.ignoredNodes.removeIgnoredNodeAsync(nodeNum, sourceId).catch(err => {
        logger.error('Failed to remove node from per-source ignore list:', err);
      });
    }

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (cachedNode) {
        cachedNode.isIgnored = isIgnored;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.setNodeIgnored(nodeNum, isIgnored, sourceId).catch(err => {
          logger.error(`Failed to set node ignored status in database:`, err);
        });
      }

      logger.debug(`${isIgnored ? '🚫' : '✅'} Node ${nodeNum}@${sourceId} ignored status set to: ${isIgnored}`);
      return;
    }

    // SQLite: synchronous update
    const now = Date.now();
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        isIgnored = ?,
        updatedAt = ?
      WHERE nodeNum = ? AND sourceId = ?
    `);
    const result = stmt.run(isIgnored ? 1 : 0, now, nodeNum, sourceId);

    if (result.changes === 0) {
      logger.warn(`Failed to update ignored status for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`${isIgnored ? '🚫' : '✅'} Node ${nodeNum}@${sourceId} ignored status set to: ${isIgnored} (${result.changes} row updated)`);
  }

  // Persistent ignored nodes operations — use databaseService.ignoredNodes.xxxAsync() directly

  // Embed profile operations — use databaseService.embedProfiles.xxxAsync() directly

  // Geofence cooldown operations
  getGeofenceCooldownAsync(triggerId: string, nodeNum: number): Promise<number | null> {
    if (this.drizzleDbType === 'sqlite') {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare('SELECT firedAt FROM geofence_cooldowns WHERE triggerId = ? AND nodeNum = ?');
      const row = stmt.get(triggerId, nodeNum) as { firedAt: number } | undefined;
      return Promise.resolve(row ? Number(row.firedAt) : null);
    } else if (this.drizzleDbType === 'postgres') {
      return this.postgresPool!.query(
        'SELECT "firedAt" FROM geofence_cooldowns WHERE "triggerId" = $1 AND "nodeNum" = $2',
        [triggerId, nodeNum]
      ).then((result: any) => result.rows.length > 0 ? Number(result.rows[0].firedAt) : null);
    } else {
      return this.mysqlPool!.query(
        'SELECT firedAt FROM geofence_cooldowns WHERE triggerId = ? AND nodeNum = ?',
        [triggerId, nodeNum]
      ).then(([rows]: any) => Array.isArray(rows) && rows.length > 0 ? Number(rows[0].firedAt) : null);
    }
  }

  setGeofenceCooldownAsync(triggerId: string, nodeNum: number, firedAt: number): Promise<void> {
    if (this.drizzleDbType === 'sqlite') {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare(
        'INSERT INTO geofence_cooldowns (triggerId, nodeNum, firedAt) VALUES (?, ?, ?) ON CONFLICT(triggerId, nodeNum) DO UPDATE SET firedAt = excluded.firedAt'
      );
      stmt.run(triggerId, nodeNum, firedAt);
      return Promise.resolve();
    } else if (this.drizzleDbType === 'postgres') {
      return this.postgresPool!.query(
        'INSERT INTO geofence_cooldowns ("triggerId", "nodeNum", "firedAt") VALUES ($1, $2, $3) ON CONFLICT ("triggerId", "nodeNum") DO UPDATE SET "firedAt" = EXCLUDED."firedAt"',
        [triggerId, nodeNum, firedAt]
      ).then(() => {});
    } else {
      return this.mysqlPool!.query(
        'INSERT INTO geofence_cooldowns (triggerId, nodeNum, firedAt) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE firedAt = VALUES(firedAt)',
        [triggerId, nodeNum, firedAt]
      ).then(() => {});
    }
  }

  clearGeofenceCooldownsAsync(triggerId: string): Promise<void> {
    if (this.drizzleDbType === 'sqlite') {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare('DELETE FROM geofence_cooldowns WHERE triggerId = ?');
      stmt.run(triggerId);
      return Promise.resolve();
    } else if (this.drizzleDbType === 'postgres') {
      return this.postgresPool!.query(
        'DELETE FROM geofence_cooldowns WHERE "triggerId" = $1',
        [triggerId]
      ).then(() => {});
    } else {
      return this.mysqlPool!.query(
        'DELETE FROM geofence_cooldowns WHERE triggerId = ?',
        [triggerId]
      ).then(() => {});
    }
  }

  getAllGeofenceCooldownsAsync(): Promise<Array<{ triggerId: string; nodeNum: number; firedAt: number }>> {
    if (this.drizzleDbType === 'sqlite') {
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare('SELECT triggerId, nodeNum, firedAt FROM geofence_cooldowns');
      const rows = stmt.all() as Array<{ triggerId: string; nodeNum: number; firedAt: number }>;
      return Promise.resolve(rows.map(r => ({ triggerId: r.triggerId, nodeNum: Number(r.nodeNum), firedAt: Number(r.firedAt) })));
    } else if (this.drizzleDbType === 'postgres') {
      return this.postgresPool!.query('SELECT "triggerId", "nodeNum", "firedAt" FROM geofence_cooldowns')
        .then((result: any) => result.rows.map((r: any) => ({ triggerId: r.triggerId, nodeNum: Number(r.nodeNum), firedAt: Number(r.firedAt) })));
    } else {
      return this.mysqlPool!.query('SELECT triggerId, nodeNum, firedAt FROM geofence_cooldowns')
        .then(([rows]: any) => (rows as any[]).map(r => ({ triggerId: r.triggerId, nodeNum: Number(r.nodeNum), firedAt: Number(r.firedAt) })));
    }
  }

  // Position override operations (scoped to sourceId — Phase 3C2)
  setNodePositionOverride(
    nodeNum: number,
    enabled: boolean,
    sourceId: string,
    latitude?: number,
    longitude?: number,
    altitude?: number,
    isPrivate: boolean = false
  ): void {
    const now = Date.now();

    // For PostgreSQL/MySQL, use cache and async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const existingNode = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (!existingNode) {
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.warn(`⚠️ Failed to update position override for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in cache`);
        throw new Error(`Node ${nodeId} not found`);
      }

      // Update cache (in-place)
      existingNode.positionOverrideEnabled = enabled;
      existingNode.latitudeOverride = enabled && latitude !== undefined ? latitude : undefined;
      existingNode.longitudeOverride = enabled && longitude !== undefined ? longitude : undefined;
      existingNode.altitudeOverride = enabled && altitude !== undefined ? altitude : undefined;
      existingNode.positionOverrideIsPrivate = enabled && isPrivate;
      existingNode.updatedAt = now;

      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.upsertNode(existingNode).catch(err => {
          logger.error('Failed to update position override:', err);
        });
      }

      logger.debug(`📍 Node ${nodeNum}@${sourceId} position override ${enabled ? 'enabled' : 'disabled'}${enabled ? ` (${latitude}, ${longitude}, ${altitude}m)${isPrivate ? ' [PRIVATE]' : ''}` : ''}`);
      return;
    }

    // SQLite path
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        positionOverrideEnabled = ?,
        latitudeOverride = ?,
        longitudeOverride = ?,
        altitudeOverride = ?,
        positionOverrideIsPrivate = ?,
        updatedAt = ?
      WHERE nodeNum = ? AND sourceId = ?
    `);
    const result = stmt.run(
      enabled ? 1 : 0,
      enabled && latitude !== undefined ? latitude : null,
      enabled && longitude !== undefined ? longitude : null,
      enabled && altitude !== undefined ? altitude : null,
      enabled && isPrivate ? 1 : 0,
      now,
      nodeNum,
      sourceId
    );

    if (result.changes === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update position override for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`📍 Node ${nodeNum}@${sourceId} position override ${enabled ? 'enabled' : 'disabled'}${enabled ? ` (${latitude}, ${longitude}, ${altitude}m)${isPrivate ? ' [PRIVATE]' : ''}` : ''}`);
  }

  getNodePositionOverride(nodeNum: number, sourceId: string): {
    enabled: boolean;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    isPrivate: boolean;
  } | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const node = this.nodesCache.get(this.cacheKey(nodeNum, sourceId));
      if (!node) {
        return null;
      }

      return {
        enabled: node.positionOverrideEnabled === true,
        latitude: node.latitudeOverride ?? undefined,
        longitude: node.longitudeOverride ?? undefined,
        altitude: node.altitudeOverride ?? undefined,
        isPrivate: node.positionOverrideIsPrivate === true,
      };
    }

    // SQLite path
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      SELECT positionOverrideEnabled, latitudeOverride, longitudeOverride, altitudeOverride, positionOverrideIsPrivate
      FROM nodes
      WHERE nodeNum = ? AND sourceId = ?
    `);
    const row = stmt.get(nodeNum, sourceId) as {
      positionOverrideEnabled: number | boolean | null;
      latitudeOverride: number | null;
      longitudeOverride: number | null;
      altitudeOverride: number | null;
      positionOverrideIsPrivate: number | boolean | null;
    } | undefined;

    if (!row) {
      return null;
    }

    return {
      enabled: row.positionOverrideEnabled === true || row.positionOverrideEnabled === 1,
      latitude: row.latitudeOverride ?? undefined,
      longitude: row.longitudeOverride ?? undefined,
      altitude: row.altitudeOverride ?? undefined,
      isPrivate: row.positionOverrideIsPrivate === true || row.positionOverrideIsPrivate === 1,
    };
  }

  clearNodePositionOverride(nodeNum: number, sourceId: string): void {
    this.setNodePositionOverride(nodeNum, false, sourceId);
  }

  // Authentication and Authorization
  private ensureAdminUser(): void {
    // Run asynchronously without blocking initialization
    this.createAdminIfNeeded().catch(error => {
      logger.error('❌ Failed to ensure admin user:', error);
    });

    // Ensure anonymous user exists (runs independently of admin creation)
    this.ensureAnonymousUser().catch(error => {
      logger.error('❌ Failed to ensure anonymous user:', error);
    });
  }

  private async createAdminIfNeeded(): Promise<void> {
    logger.debug('🔐 Checking for admin user...');
    try {
      // CRITICAL: Wait for any pending restore to complete before checking for admin
      // This prevents a race condition where we create a default admin while
      // a restore is in progress, which would then overwrite the imported admin data
      // or cause conflicts. See ARCHITECTURE_LESSONS.md for details.
      try {
        // Use dynamic import to avoid circular dependency (systemRestoreService imports database.ts)
        const { systemRestoreService } = await import('../server/services/systemRestoreService.js');
        logger.debug('🔐 Waiting for any pending restore to complete before admin check...');
        await systemRestoreService.waitForRestoreComplete();
        logger.debug('🔐 Restore check complete, proceeding with admin user check');
      } catch (importError) {
        // If import fails (e.g., during tests), proceed without waiting
        logger.debug('🔐 Could not import systemRestoreService, proceeding without restore check');
      }

      const password = 'changeme';
      const adminUsername = getEnvironmentConfig().adminUsername;

      // Use AuthRepository for all database backends
      const allUsers = await this.auth.getAllUsers();
      const hasAdmin = allUsers.some(u => u.isAdmin);
      if (hasAdmin) {
        logger.debug('✅ Admin user already exists');
        return;
      }

      logger.debug('📝 No admin user found, creating default admin...');
      const bcrypt = await import('bcrypt');
      const passwordHash = await bcrypt.hash(password, 10);
      const now = Date.now();

      const adminId = await this.auth.createUser({
        username: adminUsername,
        passwordHash,
        email: null,
        displayName: 'Administrator',
        authMethod: 'local',
        oidcSubject: null,
        isAdmin: true,
        isActive: true,
        passwordLocked: false,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      });

      // Grant all permissions for admin
      // Resource names must match the CHECK constraint in the permissions table (set by migration 006)
      const allResources = [
        'dashboard', 'nodes', 'messages', 'settings', 'configuration', 'info',
        'automation', 'connection', 'traceroute', 'audit', 'security', 'themes',
        'channel_0', 'channel_1', 'channel_2', 'channel_3',
        'channel_4', 'channel_5', 'channel_6', 'channel_7',
        'nodes_private', 'meshcore', 'packetmonitor'
      ];
      for (const resource of allResources) {
        await this.auth.createPermission({
          userId: adminId,
          resource,
          canRead: true,
          canWrite: true,
          canDelete: true
        });
      }

      // Log the password
      logger.warn('');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn('🔐 FIRST RUN: Admin user created');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn(`   Username: ${adminUsername}`);
      logger.warn(`   Password: changeme`);
      logger.warn('');
      logger.warn('   ⚠️  IMPORTANT: Change this password after first login!');
      logger.warn('═══════════════════════════════════════════════════════════');
      logger.warn('');

      // Log to audit log (fire-and-forget)
      this.auditLogAsync(
        adminId,
        'first_run_admin_created',
        'users',
        JSON.stringify({ username: adminUsername }),
        'system'
      ).catch(err => logger.error('Failed to write audit log:', err));

      // Save to settings
      await this.settings.setSetting('setup_complete', 'true');
    } catch (error) {
      logger.error('❌ Failed to create admin user:', error);
      throw error;
    }
  }

  private async ensureAnonymousUser(): Promise<void> {
    try {
      // Generate a random password that nobody will know (anonymous user should not be able to log in)
      const crypto = await import('crypto');
      const bcrypt = await import('bcrypt');
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      // Default permissions for anonymous user
      const defaultAnonPermissions = [
        { resource: 'dashboard' as const, canViewOnMap: false, canRead: true, canWrite: false, canDelete: false },
        { resource: 'nodes' as const, canViewOnMap: false, canRead: true, canWrite: false, canDelete: false },
        { resource: 'info' as const, canViewOnMap: false, canRead: true, canWrite: false, canDelete: false }
      ];

      // Use AuthRepository for all database backends
      const existingUser = await this.auth.getUserByUsername('anonymous');
      if (existingUser) {
        logger.debug('✅ Anonymous user already exists');
        return;
      }

      logger.debug('📝 Creating anonymous user for unauthenticated access...');
      const now = Date.now();
      const anonymousId = await this.auth.createUser({
        username: 'anonymous',
        passwordHash,
        email: null,
        displayName: 'Anonymous User',
        authMethod: 'local',
        oidcSubject: null,
        isAdmin: false,
        isActive: true,
        passwordLocked: false,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null
      });

      // Grant default permissions
      for (const perm of defaultAnonPermissions) {
        await this.auth.createPermission({
          userId: anonymousId,
          resource: perm.resource,
          canViewOnMap: perm.canViewOnMap,
          canRead: perm.canRead,
          canWrite: perm.canWrite,
          canDelete: perm.canDelete
        });
      }

      logger.debug('✅ Anonymous user created with read-only permissions (dashboard, nodes, info)');
      logger.debug('   💡 Admin can modify anonymous permissions in the Users tab');

      // Log to audit log (fire-and-forget)
      this.auditLogAsync(
        anonymousId,
        'anonymous_user_created',
        'users',
        JSON.stringify({ username: 'anonymous', defaultPermissions: defaultAnonPermissions }),
        'system'
      ).catch(err => logger.error('Failed to write audit log:', err));
    } catch (error) {
      logger.error('❌ Failed to create anonymous user:', error);
      throw error;
    }
  }


  auditLog(
    userId: number | null,
    action: string,
    resource: string | null,
    details: string | null,
    ipAddress: string | null,
    valueBefore?: string | null,
    valueAfter?: string | null
  ): void {
    // Delegate to AuthRepository for all backends (fire-and-forget)
    // Note: valueBefore/valueAfter not yet in Drizzle schema — tracked as future enhancement
    void valueBefore;
    void valueAfter;
    this.auth.createAuditLogEntry({
      userId,
      action,
      resource,
      details,
      ipAddress,
      userAgent: null,
      timestamp: Date.now(),
    }).catch(error => {
      logger.error('Failed to write audit log:', error);
      // Don't throw - audit log failures shouldn't break the application
    });
  }

  /**
   * Async version of getAuditLogs - works with all database backends
   */
  async getAuditLogsAsync(options: {
    limit?: number;
    offset?: number;
    userId?: number;
    action?: string;
    excludeAction?: string;
    resource?: string;
    startDate?: number;
    endDate?: number;
    search?: string;
  } = {}): Promise<{ logs: any[]; total: number }> {
    return this.authRepo!.getAuditLogsFiltered(options) as Promise<{ logs: any[]; total: number }>;
  }

  async getAuditStatsAsync(days: number = 30): Promise<any> {
    return this.authRepo!.getAuditStats(days);
  }

  // Read Messages tracking
  markMessageAsRead(messageId: string, userId: number | null): void {
    // For PostgreSQL/MySQL, read tracking is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // TODO: Implement read message tracking for PostgreSQL via repository
      return;
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(messageId, userId, Date.now());
  }

  markMessagesAsRead(messageIds: string[], userId: number | null): void {
    if (messageIds.length === 0) return;

    // For PostgreSQL/MySQL, read tracking is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // TODO: Implement read message tracking for PostgreSQL via repository
      return;
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      VALUES (?, ?, ?)
    `);

    const transaction = this.db.transaction(() => {
      const now = Date.now();
      messageIds.forEach(messageId => {
        stmt.run(messageId, userId, now);
      });
    });

    transaction();
  }

  async markMessageAsReadAsync(messageId: string, userId: number | null): Promise<void> {
    if (!userId) return;
    return this.notifications.markMessagesAsReadByIds([messageId], userId);
  }

  async markMessagesAsReadAsync(messageIds: string[], userId: number | null): Promise<void> {
    if (!userId || messageIds.length === 0) return;
    return this.notifications.markMessagesAsReadByIds(messageIds, userId);
  }

  markChannelMessagesAsRead(channelId: number, userId: number | null, beforeTimestamp?: number): number {
    logger.info(`[DatabaseService] markChannelMessagesAsRead called: channel=${channelId}, userId=${userId}, dbType=${this.drizzleDbType}`);
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.notificationsRepo) {
        this.notificationsRepo.markChannelMessagesAsRead(channelId, userId, beforeTimestamp)
          .then((count) => {
            logger.info(`[DatabaseService] Marked ${count} channel ${channelId} messages as read for user ${userId}`);
          })
          .catch((error) => {
            logger.error(`[DatabaseService] Mark channel messages as read failed: ${error}`);
          });
      } else {
        logger.warn(`[DatabaseService] notificationsRepo is null, cannot mark messages as read`);
      }
      return 0; // Return 0 since we don't wait for the async result
    }
    let query = `
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      SELECT id, ?, ? FROM messages
      WHERE channel = ?
        AND portnum = 1
    `;
    const params: any[] = [userId, Date.now(), channelId];

    if (beforeTimestamp !== undefined) {
      query += ` AND timestamp <= ?`;
      params.push(beforeTimestamp);
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const result = stmt.run(...params);
    return Number(result.changes);
  }

  markDMMessagesAsRead(localNodeId: string, remoteNodeId: string, userId: number | null, beforeTimestamp?: number): number {
    logger.info(`[DatabaseService] markDMMessagesAsRead called: local=${localNodeId}, remote=${remoteNodeId}, userId=${userId}`);
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.notificationsRepo) {
        this.notificationsRepo.markDMMessagesAsRead(localNodeId, remoteNodeId, userId, beforeTimestamp)
          .then((count) => {
            logger.info(`[DatabaseService] Marked ${count} DM messages as read for user ${userId}`);
          })
          .catch((error) => {
            logger.error(`[DatabaseService] Mark DM messages as read failed: ${error}`);
          });
      } else {
        logger.warn(`[DatabaseService] notificationsRepo is null, cannot mark DM messages as read`);
      }
      return 0; // Return 0 since we don't wait for the async result
    }
    let query = `
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      SELECT id, ?, ? FROM messages
      WHERE ((fromNodeId = ? AND toNodeId = ?) OR (fromNodeId = ? AND toNodeId = ?))
        AND portnum = 1
        AND channel = -1
    `;
    const params: any[] = [userId, Date.now(), localNodeId, remoteNodeId, remoteNodeId, localNodeId];

    if (beforeTimestamp !== undefined) {
      query += ` AND timestamp <= ?`;
      params.push(beforeTimestamp);
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const result = stmt.run(...params);
    return Number(result.changes);
  }

  /**
   * Mark all DM messages as read for the local node
   * This marks all direct messages (channel = -1) involving the local node as read
   */
  markAllDMMessagesAsRead(localNodeId: string, userId: number | null): number {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.notificationsRepo) {
        this.notificationsRepo.markAllDMMessagesAsRead(localNodeId, userId).catch((error) => {
          logger.debug(`[DatabaseService] Mark all DM messages as read failed: ${error}`);
        });
      }
      return 0; // Return 0 since we don't wait for the async result
    }
    const query = `
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      SELECT id, ?, ? FROM messages
      WHERE (fromNodeId = ? OR toNodeId = ?)
        AND portnum = 1
        AND channel = -1
    `;
    const params: any[] = [userId, Date.now(), localNodeId, localNodeId];

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const result = stmt.run(...params);
    return Number(result.changes);
  }

  // Update message acknowledgment status by requestId (for tracking routing ACKs)
  updateMessageAckByRequestId(requestId: number, _acknowledged: boolean = true, ackFailed: boolean = false): boolean {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.updateMessageAckByRequestId(requestId, ackFailed).catch((error) => {
          logger.debug(`[DatabaseService] Message ack update skipped for requestId ${requestId}: ${error}`);
        });
      }
      return true; // Optimistically return true
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.updateMessageAckByRequestIdSqlite(requestId, ackFailed);
    }
    return false;
  }

  // Update message delivery state directly (undefined/delivered/confirmed)
  updateMessageDeliveryState(requestId: number, deliveryState: 'delivered' | 'confirmed' | 'failed'): boolean {
    // For PostgreSQL/MySQL, fire-and-forget async update
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.updateMessageDeliveryState(requestId, deliveryState).catch((error) => {
          // Silently ignore errors - message may not exist (normal for routing acks from external nodes)
          logger.debug(`[DatabaseService] Message delivery state update skipped for requestId ${requestId}: ${error}`);
        });
      }
      // Also update the cache immediately so poll returns updated state
      const ackFailed = deliveryState === 'failed';
      for (const msg of this._messagesCache) {
        if ((msg as any).requestId === requestId) {
          (msg as any).deliveryState = deliveryState;
          (msg as any).ackFailed = ackFailed;
          break;
        }
      }
      // Update channel-specific caches too
      for (const [_channel, messages] of this._messagesCacheChannel) {
        for (const msg of messages) {
          if ((msg as any).requestId === requestId) {
            (msg as any).deliveryState = deliveryState;
            (msg as any).ackFailed = ackFailed;
            break;
          }
        }
      }
      return true; // Optimistic return
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.updateMessageDeliveryStateSqlite(requestId, deliveryState);
    }
    return false;
  }

  // Update message rxTime and timestamp when ACK is received (fixes outgoing message ordering)
  updateMessageTimestamps(requestId: number, rxTime: number): boolean {
    // For PostgreSQL/MySQL, fire-and-forget async update
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.updateMessageTimestamps(requestId, rxTime).catch((error) => {
          logger.debug(`[DatabaseService] Message timestamp update skipped for requestId ${requestId}: ${error}`);
        });
      }
      // Also update the cache immediately so poll returns updated state
      for (const msg of this._messagesCache) {
        if ((msg as any).requestId === requestId) {
          (msg as any).rxTime = rxTime;
          (msg as any).timestamp = rxTime;
          break;
        }
      }
      // Update channel-specific caches too
      for (const [_channel, messages] of this._messagesCacheChannel) {
        for (const msg of messages) {
          if ((msg as any).requestId === requestId) {
            (msg as any).rxTime = rxTime;
            (msg as any).timestamp = rxTime;
            break;
          }
        }
      }
      return true; // Optimistic return
    }
    // SQLite: delegate to Drizzle sync variant
    if (this.messagesRepo) {
      return this.messagesRepo.updateMessageTimestampsSqlite(requestId, rxTime);
    }
    return false;
  }

  getUnreadMessageIds(userId: number | null): string[] {
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      SELECT m.id FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
    `);

    const rows = userId === null ? stmt.all() as Array<{ id: string }> : stmt.all(userId) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  getUnreadCountsByChannel(userId: number | null, localNodeId?: string): {[channelId: number]: number} {
    // For PostgreSQL/MySQL, use async method via cache or return empty for sync call
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Sync method can't do async DB query - return empty and let caller use async version
      return {};
    }

    // Only count incoming messages (exclude messages sent by our node)
    const excludeOutgoing = localNodeId ? 'AND m.fromNodeId != ?' : '';
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      SELECT m.channel, COUNT(*) as count
      FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
        AND m.channel != -1
        AND m.portnum = 1
        ${excludeOutgoing}
      GROUP BY m.channel
    `);

    let rows: Array<{ channel: number; count: number }>;
    if (userId === null) {
      rows = localNodeId
        ? stmt.all(localNodeId) as Array<{ channel: number; count: number }>
        : stmt.all() as Array<{ channel: number; count: number }>;
    } else {
      rows = localNodeId
        ? stmt.all(userId, localNodeId) as Array<{ channel: number; count: number }>
        : stmt.all(userId) as Array<{ channel: number; count: number }>;
    }

    const counts: {[channelId: number]: number} = {};
    rows.forEach(row => {
      counts[row.channel] = Number(row.count);
    });
    return counts;
  }

  getUnreadDMCount(localNodeId: string, remoteNodeId: string, userId: number | null): number {
    // For PostgreSQL/MySQL, return 0 (unread tracking is complex and low priority)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }

    // Only count incoming DMs (messages FROM remote node TO local node)
    // Exclude outgoing messages (messages FROM local node TO remote node)
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
        AND m.portnum = 1
        AND m.channel = -1
        AND m.fromNodeId = ?
        AND m.toNodeId = ?
    `);

    const params = userId === null
      ? [remoteNodeId, localNodeId]
      : [userId, remoteNodeId, localNodeId];

    const result = stmt.get(...params) as { count: number };
    return Number(result.count);
  }

  /**
   * Async version of getUnreadCountsByChannel for PostgreSQL/MySQL.
   * Delegates to NotificationsRepository for Drizzle-based execution on all backends.
   */
  async getUnreadCountsByChannelAsync(userId: number | null, localNodeId?: string): Promise<{[channelId: number]: number}> {
    // For SQLite, use sync version (legacy compatibility)
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getUnreadCountsByChannel(userId, localNodeId);
    }
    if (!this.notificationsRepo) return {};
    return this.notificationsRepo.getUnreadCountsByChannelAsync(userId, localNodeId);
  }

  /**
   * Async version of getUnreadDMCount for PostgreSQL/MySQL.
   * Delegates to NotificationsRepository for Drizzle-based execution on all backends.
   */
  async getUnreadDMCountAsync(localNodeId: string, remoteNodeId: string, userId: number | null): Promise<number> {
    // For SQLite, use sync version
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getUnreadDMCount(localNodeId, remoteNodeId, userId);
    }
    if (!this.notificationsRepo) return 0;
    return this.notificationsRepo.getUnreadDMCountAsync(localNodeId, remoteNodeId, userId);
  }

  /**
   * Get all DM unread counts in a single batch query, grouped by remote node.
   * Returns { [fromNodeId: string]: number } for all nodes with unread DMs.
   */
  getBatchUnreadDMCounts(localNodeId: string, userId: number | null): { [fromNodeId: string]: number } {
    // For PostgreSQL/MySQL, return empty (handled by async version)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return {};
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      SELECT m.fromNodeId, COUNT(*) as count
      FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
        AND m.portnum = 1
        AND m.channel = -1
        AND m.toNodeId = ?
      GROUP BY m.fromNodeId
    `);

    const params = userId === null
      ? [localNodeId]
      : [userId, localNodeId];

    const rows = stmt.all(...params) as { fromNodeId: string; count: number }[];
    const result: { [fromNodeId: string]: number } = {};
    for (const row of rows) {
      result[row.fromNodeId] = Number(row.count);
    }
    return result;
  }

  /**
   * Async version of getBatchUnreadDMCounts for PostgreSQL/MySQL support.
   * Delegates to NotificationsRepository for Drizzle-based execution on all backends.
   */
  async getBatchUnreadDMCountsAsync(localNodeId: string, userId: number | null): Promise<{ [fromNodeId: string]: number }> {
    // For SQLite, use sync version
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getBatchUnreadDMCounts(localNodeId, userId);
    }
    if (!this.notificationsRepo) return {};
    return this.notificationsRepo.getBatchUnreadDMCountsAsync(localNodeId, userId);
  }

  cleanupOldReadMessages(days: number): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare('DELETE FROM read_messages WHERE read_at < ?');
    const result = stmt.run(cutoff);
    logger.debug(`🧹 Cleaned up ${result.changes} read_messages entries older than ${days} days`);
    return Number(result.changes);
  }


  // Packet Log operations — delegated to MiscRepository (this.misc)
  // Sync methods retain SQLite fallbacks for test compatibility and pre-init callers.

  async insertPacketLogAsync(packet: Omit<DbPacketLog, 'id' | 'created_at'>): Promise<number> {
    const enabled = await this.getSettingAsync('packet_log_enabled');
    if (enabled !== '1') return 0;

    // All backends route through MiscRepository
    const id = await this.misc.insertPacketLog(packet, packet.sourceId ?? undefined);
    const maxCountStr = this.drizzleDbType === 'sqlite'
      ? this.getSetting('packet_log_max_count')
      : await this.getSettingAsync('packet_log_max_count');
    const maxCount = maxCountStr ? parseInt(maxCountStr, 10) : 1000;
    await this.misc.enforcePacketLogMaxCount(maxCount);
    return id;
  }

  async getPacketLogsAsync(options: {
    offset?: number; limit?: number; portnum?: number; from_node?: number;
    to_node?: number; channel?: number; encrypted?: boolean; since?: number;
    relay_node?: number | 'unknown'; sourceId?: string;
  }): Promise<DbPacketLog[]> {
    return this.misc.getPacketLogs(options);
  }

  async getPacketLogByIdAsync(id: number): Promise<DbPacketLog | null> {
    return this.misc.getPacketLogById(id);
  }

  async getPacketLogCountAsync(options: {
    portnum?: number; from_node?: number; to_node?: number; channel?: number;
    encrypted?: boolean; since?: number; relay_node?: number | 'unknown'; sourceId?: string;
  } = {}): Promise<number> {
    return this.misc.getPacketLogCount(options);
  }

  clearPacketLogs(): number {
    return this.miscRepo!.clearPacketLogsSync();
  }

  async clearPacketLogsAsync(): Promise<number> {
    if (this.miscRepo) return this.miscRepo.clearPacketLogs();
    return this.clearPacketLogs();
  }

  async getDistinctRelayNodesAsync(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    return this.misc.getDistinctRelayNodes(sourceId);
  }

  async updatePacketLogDecryptionAsync(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    return this.miscRepo!.updatePacketLogDecryption(id, decryptedBy, decryptedChannelId, portnum, metadata);
  }

  cleanupOldPacketLogs(): number {
    const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
    const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
    const cutoffTimestamp = Date.now() - (maxAgeHours * 60 * 60 * 1000);
    return this.miscRepo!.cleanupOldPacketLogsSync(cutoffTimestamp);
  }

  async cleanupOldPacketLogsAsync(): Promise<number> {
    const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
    const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
    if (this.miscRepo) return this.miscRepo.cleanupOldPacketLogs(maxAgeHours);
    return this.cleanupOldPacketLogs();
  }

  async getPacketCountsByNodeAsync(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    return this.misc.getPacketCountsByNode(options);
  }

  async getPacketCountsByPortnumAsync(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    return this.misc.getPacketCountsByPortnum(options);
  }


  /**
   * Validate that a theme definition has all required color variables
   */
  validateThemeDefinition(definition: any): definition is ThemeDefinition {
    const validation = validateTheme(definition);

    if (!validation.isValid) {
      logger.warn(`⚠️  Theme validation failed:`, validation.errors);
    }

    return validation.isValid;
  }

  /**
   * Create or update PostgreSQL schema
   * Runs all migrations from the registry (001 baseline creates all tables).
   */
  private async createPostgresSchema(pool: PgPool): Promise<void> {
    logger.info('[PostgreSQL] Ensuring database schema is up to date...');

    const client = await pool.connect();
    try {
      // Pre-3.7 detection: if tables exist but ignored_nodes doesn't, database is too old
      const tableCount = await client.query(`
        SELECT COUNT(*) as count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const ignoredNodesExists = await client.query(`
        SELECT EXISTS (SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'ignored_nodes') as exists
      `);
      if (parseInt(tableCount.rows[0]?.count) > 0 && !ignoredNodesExists.rows[0]?.exists) {
        throw new Error('Database is pre-v3.7. Please upgrade to v3.7 first.');
      }

      // Run ALL migrations from the registry — 001 baseline creates all tables
      for (const migration of registry.getAll()) {
        if (migration.postgres) {
          await migration.postgres(client);
        }
      }

      logger.info('[PostgreSQL] Schema initialization complete');
    } finally {
      client.release();
    }
  }

  /**
   * Create or update MySQL schema
   * Runs all migrations from the registry (001 baseline creates all tables).
   */
  private async createMySQLSchema(pool: MySQLPool): Promise<void> {
    logger.info('[MySQL] Ensuring database schema is up to date...');

    const connection = await pool.getConnection();
    try {
      // Pre-3.7 detection: if tables exist but ignored_nodes doesn't, database is too old
      const [tableCountRows] = await connection.query(`
        SELECT COUNT(*) as count FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
      `);
      const [ignoredNodesRows] = await connection.query(`
        SELECT COUNT(*) as count FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'ignored_nodes'
      `);
      const tableCount = parseInt((tableCountRows as any[])[0]?.count);
      const ignoredNodesExists = parseInt((ignoredNodesRows as any[])[0]?.count) > 0;
      if (tableCount > 0 && !ignoredNodesExists) {
        throw new Error('Database is pre-v3.7. Please upgrade to v3.7 first.');
      }
    } finally {
      connection.release();
    }

    // Run ALL migrations from the registry — 001 baseline creates all tables
    for (const migration of registry.getAll()) {
      if (migration.mysql) {
        await migration.mysql(pool);
      }
    }

    logger.info('[MySQL] Schema initialization complete');
  }

  // ============ ASYNC AUTH METHODS ============
  // These methods delegate to the AuthRepository for all database backends

  /**
   * Map a DbUser from the AuthRepository to the User type expected by auth middleware.
   */
  private mapDbUserToUser(dbUser: any): any {
    return {
      id: dbUser.id,
      username: dbUser.username,
      passwordHash: dbUser.passwordHash,
      email: dbUser.email,
      displayName: dbUser.displayName,
      authProvider: dbUser.authMethod,
      oidcSubject: dbUser.oidcSubject,
      isAdmin: dbUser.isAdmin,
      isActive: dbUser.isActive,
      passwordLocked: dbUser.passwordLocked,
      mfaEnabled: dbUser.mfaEnabled ?? false,
      mfaSecret: dbUser.mfaSecret ?? null,
      mfaBackupCodes: dbUser.mfaBackupCodes ?? null,
      createdAt: dbUser.createdAt,
      lastLoginAt: dbUser.lastLoginAt,
    };
  }

  /**
   * Async method to find a user by username.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async findUserByUsernameAsync(username: string): Promise<any | null> {
    const dbUser = await this.auth.getUserByUsername(username);
    if (!dbUser) return null;
    return this.mapDbUserToUser(dbUser);
  }

  /**
   * Find user by email (async).
   * Note: Email is NOT unique in the schema. Returns first match if multiple users share email.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async findUserByEmailAsync(email: string): Promise<any | null> {
    const dbUser = await this.auth.getUserByEmail(email);
    if (!dbUser) return null;
    return this.mapDbUserToUser(dbUser);
  }

  /**
   * Async method to authenticate a user with username and password.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   * Returns the user if authentication succeeds, null otherwise.
   */
  async authenticateAsync(username: string, password: string): Promise<any | null> {
    const dbUser = await this.auth.getUserByUsername(username);
    if (!dbUser || !dbUser.passwordHash) return null;

    // Verify password using bcrypt
    const bcrypt = await import('bcrypt');
    const isValid = await bcrypt.compare(password, dbUser.passwordHash);
    if (!isValid) return null;

    // Update last login
    await this.auth.updateUser(dbUser.id, { lastLoginAt: Date.now() });

    return { ...this.mapDbUserToUser(dbUser), lastLoginAt: Date.now() };
  }

  /**
   * Async method to validate an API token.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   * Returns the user associated with the token if valid, null otherwise.
   */
  async validateApiTokenAsync(token: string): Promise<any | null> {
    const result = await this.auth.validateApiToken(token);
    if (!result) return null;
    return this.mapDbUserToUser(result);
  }

  /**
   * Async method to find a user by ID.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async findUserByIdAsync(id: number): Promise<any | null> {
    const dbUser = await this.auth.getUserById(id);
    if (!dbUser) return null;
    return this.mapDbUserToUser(dbUser);
  }

  /**
   * Async method to check user permission.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async checkPermissionAsync(userId: number, resource: string, action: string, sourceId?: string): Promise<boolean> {
    // Admin bypass: matches the same shortcut used by requirePermission/hasPermission
    // middleware. Without this, admin users (whose perm rows historically have
    // sourceId=NULL) are silently denied by direct callers like the notification
    // filter, since the per-source lookup below requires an exact sourceId match.
    const user = await this.auth.getUserById(userId);
    if (user?.isAdmin) return true;

    const permissions = await this.auth.getPermissionsForUser(userId);

    const check = (perm: (typeof permissions)[0]): boolean => {
      if (action === 'viewOnMap') return !!(perm as any).canViewOnMap;
      if (action === 'read') return !!(perm as any).canRead;
      if (action === 'write') return !!(perm as any).canWrite;
      return false;
    };

    const sourcey = isSourceyResource(resource as any);

    if (sourcey) {
      // Per-source resource. With sourceId → exact-match. Without sourceId →
      // union across sources (legacy callers that don't scope their lookup).
      if (sourceId) {
        for (const perm of permissions) {
          if (perm.resource === resource && (perm as any).sourceId === sourceId) {
            return check(perm);
          }
        }
        return false;
      }
      for (const perm of permissions) {
        if (perm.resource === resource && (perm as any).sourceId) {
          if (check(perm)) return true;
        }
      }
      return false;
    }

    // Non-sourcey (global) resource. Prefer the canonical sourceId=NULL row,
    // then fall back to any per-source row — covers databases where the admin
    // PUT endpoint historically saved global grants under a sourceId.
    for (const perm of permissions) {
      if (perm.resource === resource && !(perm as any).sourceId) {
        if (check(perm)) return true;
      }
    }
    for (const perm of permissions) {
      if (perm.resource === resource && (perm as any).sourceId) {
        if (check(perm)) return true;
      }
    }
    return false;
  }

  /**
   * Async method to get user permission set.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async getUserPermissionSetAsync(userId: number, sourceId?: string): Promise<Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>> {
    const permissions = await this.auth.getPermissionsForUser(userId);
    const permissionSet: Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }> = {};

    // All resources are per-source. When sourceId is provided, return permissions
    // for that source. When omitted, merge permissions across all sources (grant
    // access if the user has it on any source).
    if (sourceId) {
      for (const perm of permissions) {
        if ((perm as any).sourceId === sourceId) {
          permissionSet[perm.resource] = {
            viewOnMap: (perm as any).canViewOnMap ?? false,
            read: perm.canRead,
            write: perm.canWrite,
          };
        }
      }
    } else {
      // No sourceId — merge across all sources (most permissive wins)
      for (const perm of permissions) {
        if (!(perm as any).sourceId) continue;
        const existing = permissionSet[perm.resource];
        permissionSet[perm.resource] = {
          viewOnMap: existing?.viewOnMap || ((perm as any).canViewOnMap ?? false),
          read: existing?.read || perm.canRead,
          write: existing?.write || perm.canWrite,
        };
      }
    }

    return permissionSet;
  }

  /**
   * Return the user's permissions split into `global` (non-sourcey rows where
   * sourceId IS NULL) and `bySource` (per-source rows keyed by sourceId).
   * Does NOT OR-merge across sources. Callers that need to answer a permission
   * question must pick a specific source or use the global map.
   */
  async getUserPermissionSetsBySourceAsync(userId: number): Promise<{
    global: Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>;
    bySource: Record<string, Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>>;
  }> {
    const permissions = await this.auth.getPermissionsForUser(userId);
    const global: Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }> = {};
    const bySource: Record<string, Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>> = {};

    for (const perm of permissions) {
      const entry = {
        viewOnMap: (perm as any).canViewOnMap ?? false,
        read: perm.canRead,
        write: perm.canWrite,
      };
      const sid = (perm as any).sourceId as string | null | undefined;
      if (sid) {
        (bySource[sid] ??= {})[perm.resource] = entry;
      } else {
        global[perm.resource] = entry;
      }
    }

    return { global, bySource };
  }

  /**
   * Async method to write an audit log entry.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async auditLogAsync(
    userId: number | null,
    action: string,
    resource: string | null,
    details: string | null,
    ipAddress: string | null,
    valueBefore?: string | null,
    valueAfter?: string | null
  ): Promise<void> {
    // Note: valueBefore/valueAfter not yet in Drizzle schema — tracked as future enhancement
    void valueBefore;
    void valueAfter;
    try {
      await this.auth.createAuditLogEntry({
        userId,
        action,
        resource,
        details,
        ipAddress,
        userAgent: null,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('[auditLogAsync] Failed to write audit log:', error);
    }
  }

  // ============ ASYNC MESSAGE METHODS ============
  // These methods provide async access to message operations for multi-database support

  /**
   * Async method to get a message by ID.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async getMessageAsync(id: string): Promise<DbMessage | null> {
    const result = await this.messages.getMessage(id);
    // Transform null values to undefined to match DbMessage type
    if (result) {
      return {
        ...result,
        portnum: result.portnum ?? undefined,
        requestId: result.requestId ?? undefined,
        rxTime: result.rxTime ?? undefined,
        hopStart: result.hopStart ?? undefined,
        hopLimit: result.hopLimit ?? undefined,
        relayNode: result.relayNode ?? undefined,
        replyId: result.replyId ?? undefined,
        emoji: result.emoji ?? undefined,
        viaMqtt: result.viaMqtt ?? undefined,
        rxSnr: result.rxSnr ?? undefined,
        rxRssi: result.rxRssi ?? undefined,
        ackFailed: result.ackFailed ?? undefined,
        routingErrorReceived: result.routingErrorReceived ?? undefined,
        deliveryState: result.deliveryState ?? undefined,
        wantAck: result.wantAck ?? undefined,
        ackFromNode: result.ackFromNode ?? undefined,
        decryptedBy: result.decryptedBy ?? undefined,
      };
    }
    return null;
  }

  // deleteMessageAsync, purgeChannelMessagesAsync, purgeDirectMessagesAsync
  // migrated to direct repository access: databaseService.messages.deleteMessage(), etc.


  /** @deprecated Use databaseService.telemetry.purgeNodeTelemetry() instead */
  async purgeNodeTelemetryAsync(nodeNum: number): Promise<number> {
    return this.telemetry.purgeNodeTelemetry(nodeNum);
  }

  /** @deprecated Use databaseService.telemetry.purgePositionHistory() instead */
  async purgePositionHistoryAsync(nodeNum: number): Promise<number> {
    return this.telemetry.purgePositionHistory(nodeNum);
  }

  /**
   * Async method to update user password.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async updatePasswordAsync(userId: number, newPassword: string): Promise<void> {
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.auth.updateUser(userId, { passwordHash });
  }

  // ============ ASYNC MFA METHODS ============

  /**
   * Update MFA secret and backup codes for a user.
   */
  async updateUserMfaSecretAsync(userId: number, secret: string, backupCodes: string): Promise<void> {
    await this.auth.updateUser(userId, { mfaSecret: secret, mfaBackupCodes: backupCodes });
  }

  /**
   * Clear MFA data for a user (disable MFA).
   */
  async clearUserMfaAsync(userId: number): Promise<void> {
    await this.auth.updateUser(userId, { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
  }

  /**
   * Enable MFA for a user (set mfaEnabled to true).
   */
  async enableUserMfaAsync(userId: number): Promise<void> {
    await this.auth.updateUser(userId, { mfaEnabled: true });
  }

  /**
   * Update backup codes for a user (after one is consumed).
   */
  async consumeBackupCodeAsync(userId: number, remainingCodes: string): Promise<void> {
    await this.auth.updateUser(userId, { mfaBackupCodes: remainingCodes });
  }

  // ============ SESSION METHODS ============

  async getSessionAsync(sid: string): Promise<{ sid: string; sess: string; expire: number } | null> {
    return this.auth.getSession(sid);
  }

  async setSessionAsync(sid: string, sess: string, expire: number): Promise<void> {
    return this.auth.setSession(sid, sess, expire);
  }

  async deleteSessionAsync(sid: string): Promise<void> {
    return this.auth.deleteSession(sid);
  }

  async cleanupExpiredSessionsAsync(): Promise<number> {
    return this.auth.cleanupExpiredSessions();
  }

  // ============ ASYNC CHANNEL DATABASE METHODS ============
  // ============ CHANNEL DATABASE (business logic only) ============

  /**
   * Get channel database permissions for a user as a map keyed by channel database ID
   * Returns { [channelDbId]: { viewOnMap: boolean, read: boolean } }
   * KEPT: Has business logic (transforms permissions list into a lookup map)
   */
  async getChannelDatabasePermissionsForUserAsSetAsync(userId: number): Promise<{
    [channelDbId: number]: { viewOnMap: boolean; read: boolean }
  }> {
    const permissions = await this.channelDatabase.getPermissionsForUserAsync(userId);
    const result: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } } = {};
    for (const perm of permissions) {
      result[perm.channelDatabaseId] = {
        viewOnMap: perm.canViewOnMap,
        read: perm.canRead,
      };
    }
    return result;
  }

  // ============ NEWS CACHE ============

  /**
   * Save news feed to cache
   */
  async saveNewsCacheAsync(feedData: string, sourceUrl: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    return this.misc.saveNewsCache({
      feedData,
      fetchedAt: now,
      sourceUrl,
    });
  }

  // ============ USER NEWS STATUS ============

  /**
   * Get user's news status
   */
  async getUserNewsStatusAsync(userId: number): Promise<{ lastSeenNewsId: string | null; dismissedNewsIds: string[] } | null> {
    const status = await this.misc.getUserNewsStatus(userId);
    if (!status) {
      return null;
    }
    return {
      lastSeenNewsId: status.lastSeenNewsId ?? null,
      dismissedNewsIds: status.dismissedNewsIds ? JSON.parse(status.dismissedNewsIds) : [],
    };
  }

  /**
   * Save user's news status
   */
  async saveUserNewsStatusAsync(userId: number, lastSeenNewsId: string | null, dismissedNewsIds: string[]): Promise<void> {
    return this.misc.saveUserNewsStatus({
      userId,
      lastSeenNewsId,
      dismissedNewsIds: JSON.stringify(dismissedNewsIds),
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  // ============ BACKUP HISTORY ============

  /**
   * Insert a new backup history record
   */
  async insertBackupHistoryAsync(backup: {
    filename: string;
    filePath: string;
    timestamp: number;
    backupType: string;
    fileSize?: number | null;
    nodeId?: string | null;
    nodeNum?: number | null;
  }): Promise<void> {
    return this.misc.insertBackupHistory({
      ...backup,
      createdAt: Date.now(),
    });
  }

  /**
   * Get backup statistics
   */
  async getBackupStatsAsync(): Promise<{
    count: number;
    totalSize: number;
    oldestBackup: string | null;
    newestBackup: string | null;
  }> {
    const stats = await this.misc.getBackupStats();
    return {
      count: stats.count,
      totalSize: stats.totalSize,
      oldestBackup: stats.oldestTimestamp ? new Date(stats.oldestTimestamp).toISOString() : null,
      newestBackup: stats.newestTimestamp ? new Date(stats.newestTimestamp).toISOString() : null,
    };
  }

  // ============ AUTO TIME SYNC SETTINGS ============

  /**
   * Check if auto time sync is enabled
   */
  isAutoTimeSyncEnabled(): boolean {
    const value = this.getSetting('autoTimeSyncEnabled');
    return value === 'true';
  }

  /**
   * Enable or disable auto time sync
   */
  setAutoTimeSyncEnabled(enabled: boolean): void {
    this.setSetting('autoTimeSyncEnabled', enabled ? 'true' : 'false');
  }

  /**
   * Get auto time sync interval in minutes
   */
  getAutoTimeSyncIntervalMinutes(): number {
    const value = this.getSetting('autoTimeSyncIntervalMinutes');
    return value ? parseInt(value, 10) : 15;
  }

  /**
   * Set auto time sync interval in minutes
   */
  setAutoTimeSyncIntervalMinutes(minutes: number): void {
    this.setSetting('autoTimeSyncIntervalMinutes', String(minutes));
  }

  /**
   * Get auto time sync expiration hours
   */
  getAutoTimeSyncExpirationHours(): number {
    const value = this.getSetting('autoTimeSyncExpirationHours');
    return value ? parseInt(value, 10) : 24;
  }

  /**
   * Set auto time sync expiration hours
   */
  setAutoTimeSyncExpirationHours(hours: number): void {
    this.setSetting('autoTimeSyncExpirationHours', String(hours));
  }

  /**
   * Check if auto time sync node filter is enabled
   */
  isAutoTimeSyncNodeFilterEnabled(): boolean {
    const value = this.getSetting('autoTimeSyncNodeFilterEnabled');
    return value === 'true';
  }

  /**
   * Enable or disable auto time sync node filter
   */
  setAutoTimeSyncNodeFilterEnabled(enabled: boolean): void {
    this.setSetting('autoTimeSyncNodeFilterEnabled', enabled ? 'true' : 'false');
  }

  /**
   * Get auto time sync nodes
   */
  /**
   * Get time sync filter settings
   */
  async getTimeSyncFilterSettingsAsync(sourceId?: string): Promise<{
    enabled: boolean;
    nodeNums: number[];
    filterEnabled: boolean;
    expirationHours: number;
    intervalMinutes: number;
  }> {
    const nodeNums = await this.misc.getAutoTimeSyncNodes(sourceId);
    const read = (key: string) => this.settings.getSettingForSource(sourceId ?? null, key);
    const [enabledStr, filterEnabledStr, expirationStr, intervalStr] = await Promise.all([
      read('autoTimeSyncEnabled'),
      read('autoTimeSyncNodeFilterEnabled'),
      read('autoTimeSyncExpirationHours'),
      read('autoTimeSyncIntervalMinutes'),
    ]);
    const parseIntDefault = (s: string | null, def: number): number => {
      if (s === null || s === undefined || s === '') return def;
      const n = parseInt(s, 10);
      return isNaN(n) ? def : n;
    };
    return {
      enabled: enabledStr === 'true',
      nodeNums,
      filterEnabled: filterEnabledStr === 'true',
      expirationHours: parseIntDefault(expirationStr, 24),
      intervalMinutes: parseIntDefault(intervalStr, 15),
    };
  }

  /**
   * Set time sync filter settings
   */
  async setTimeSyncFilterSettingsAsync(settings: {
    enabled?: boolean;
    nodeNums?: number[];
    filterEnabled?: boolean;
    expirationHours?: number;
    intervalMinutes?: number;
  }, sourceId?: string): Promise<void> {
    if (sourceId) {
      const kv: Record<string, string> = {};
      if (settings.enabled !== undefined) kv.autoTimeSyncEnabled = settings.enabled ? 'true' : 'false';
      if (settings.filterEnabled !== undefined) kv.autoTimeSyncNodeFilterEnabled = settings.filterEnabled ? 'true' : 'false';
      if (settings.expirationHours !== undefined) kv.autoTimeSyncExpirationHours = String(settings.expirationHours);
      if (settings.intervalMinutes !== undefined) kv.autoTimeSyncIntervalMinutes = String(settings.intervalMinutes);
      if (Object.keys(kv).length > 0) {
        await this.settings.setSourceSettings(sourceId, kv);
      }
      if (settings.nodeNums !== undefined) {
        await this.misc.setAutoTimeSyncNodes(settings.nodeNums, sourceId);
      }
      logger.debug(`✅ Updated per-source time sync filter settings (source=${sourceId})`);
      return;
    }

    if (settings.enabled !== undefined) {
      this.setAutoTimeSyncEnabled(settings.enabled);
    }
    if (settings.nodeNums !== undefined) {
      await this.misc.setAutoTimeSyncNodes(settings.nodeNums, sourceId);
    }
    if (settings.filterEnabled !== undefined) {
      this.setAutoTimeSyncNodeFilterEnabled(settings.filterEnabled);
    }
    if (settings.expirationHours !== undefined) {
      this.setAutoTimeSyncExpirationHours(settings.expirationHours);
    }
    if (settings.intervalMinutes !== undefined) {
      this.setAutoTimeSyncIntervalMinutes(settings.intervalMinutes);
    }
    logger.debug('✅ Updated time sync filter settings');
  }

  /**
   * Get a node that needs time sync
   */
  async getNodeNeedingTimeSyncAsync(sourceId?: string): Promise<DbNode | null> {
    const activeHours = 48; // Only consider nodes heard in last 48 hours
    // lastHeard is stored in seconds, so convert cutoff to seconds
    const activeNodeCutoff = Math.floor((Date.now() - (activeHours * 60 * 60 * 1000)) / 1000);

    const read = (key: string) => this.settings.getSettingForSource(sourceId ?? null, key);
    const [expirationStr, filterEnabledStr] = await Promise.all([
      read('autoTimeSyncExpirationHours'),
      read('autoTimeSyncNodeFilterEnabled'),
    ]);
    const expirationHours = (() => {
      if (!expirationStr) return 24;
      const n = parseInt(expirationStr, 10);
      return isNaN(n) ? 24 : n;
    })();
    // lastTimeSync is stored in milliseconds
    const expirationMsAgo = Date.now() - (expirationHours * 60 * 60 * 1000);

    // Get filter settings
    let filterNodeNums: number[] | undefined;
    if (filterEnabledStr === 'true') {
      filterNodeNums = await this.misc.getAutoTimeSyncNodes(sourceId);
      if (filterNodeNums.length === 0) {
        // Filter is enabled but no nodes selected - skip
        return null;
      }
    }

    const node = await this.nodes.getNodeNeedingTimeSyncAsync(
      activeNodeCutoff,
      expirationMsAgo,
      filterNodeNums,
      sourceId
    );
    return node as DbNode | null;
  }

  /**
   * Get user's map preferences - delegates to MiscRepository (Drizzle ORM)
   */
  async getMapPreferencesAsync(userId: number): Promise<Record<string, any> | null> {
    return this.miscRepo!.getMapPreferences(userId);
  }

  /**
   * Save user's map preferences - delegates to MiscRepository (Drizzle ORM)
   */
  async saveMapPreferencesAsync(userId: number, preferences: {
    mapTileset?: string;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showMeshCoreNodes?: boolean;
    showAnimations?: boolean;
    showAccuracyRegions?: boolean;
    showEstimatedPositions?: boolean;
    positionHistoryHours?: number | null;
  }): Promise<void> {
    return this.miscRepo!.saveMapPreferences(userId, preferences);
  }
  // ============================================================
  // Async wrappers for sync methods (Phase 4 migration)
  // These allow callers to use await consistently.
  // For SQLite, they delegate to the sync method.
  // For PG/MySQL, the sync methods already fire-and-forget async internally.
  // ============================================================

  // Group 1: Cleanup/Maintenance
  async cleanupOldMessagesAsync(days: number = 30, sourceId?: string): Promise<number> {
    if (sourceId && this.messagesRepo) {
      return this.messagesRepo.cleanupOldMessagesForSource(days, sourceId);
    }
    // No sourceId: use the plain repo cleanup (PG/MySQL) or sync SQLite path.
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.messagesRepo) {
      return this.messagesRepo.cleanupOldMessages(days);
    }
    return this.cleanupOldMessages(days);
  }

  async cleanupOldTraceroutesAsync(days: number = 30): Promise<number> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      return this.traceroutesRepo.cleanupOldTraceroutes(days * 24);
    }
    return this.cleanupOldTraceroutes(days);
  }

  async cleanupOldRouteSegmentsAsync(days: number = 30): Promise<number> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      return this.traceroutesRepo.cleanupOldRouteSegments(days);
    }
    return this.cleanupOldRouteSegments(days);
  }

  async cleanupOldNeighborInfoAsync(days: number = 30): Promise<number> {
    if (this.neighborsRepo) {
      return this.neighborsRepo.cleanupOldNeighborInfo(days);
    }
    return 0;
  }

  async cleanupInactiveNodesAsync(days: number = 30, sourceId?: string): Promise<number> {
    if (sourceId) {
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        return this.nodesRepo!.cleanupInactiveNodesForSourceAsync(days, sourceId);
      }
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      return this.nodesRepo!.deleteInactiveNodesForSourceSqlite(cutoff, sourceId);
    }
    return this.cleanupInactiveNodes(days);
  }

  async cleanupInvalidChannelsAsync(sourceId?: string): Promise<number> {
    if (sourceId) {
      // Channels with no name and no PSK scoped to a source
      return this.channelsRepo!.cleanupEmptyChannelsForSource(sourceId);
    }
    return this.cleanupInvalidChannels();
  }

  async cleanupAuditLogsAsync(days: number): Promise<number> {
    return this.authRepo!.cleanupOldAuditLogs(days);
  }

  async vacuumAsync(): Promise<void> {
    if (this.drizzleDbType === 'postgres') {
      await this.postgresPool!.query('VACUUM');
      return;
    }
    if (this.drizzleDbType === 'mysql') {
      // InnoDB doesn't reclaim space automatically after bulk deletes; run
      // OPTIMIZE TABLE on each maintenance-cleaned table so the daily job
      // actually shrinks the tablespace. OPTIMIZE TABLE on InnoDB is remapped
      // to ALTER TABLE … FORCE which is an online DDL rebuild.
      const optimizeTables = ['messages', 'traceroutes', 'route_segments', 'neighbor_info'];
      for (const table of optimizeTables) {
        try {
          await this.mysqlPool!.query(`OPTIMIZE TABLE \`${table}\``);
        } catch (err) {
          logger.debug(`OPTIMIZE TABLE ${table} failed:`, err);
        }
      }
      return;
    }
    return this.vacuum();
  }

  async getDatabaseSizeAsync(): Promise<number> {
    if (this.drizzleDbType === 'postgres') {
      const result = await this.postgresPool!.query('SELECT pg_database_size(current_database()) as size');
      return Number(result.rows[0]?.size ?? 0);
    }
    if (this.drizzleDbType === 'mysql') {
      const [rows] = await this.mysqlPool!.query(
        `SELECT SUM(data_length + index_length) as size FROM information_schema.tables WHERE table_schema = DATABASE()`
      );
      return Number((rows as any[])[0]?.size ?? 0);
    }
    return this.getDatabaseSize();
  }

  // Group 2: Messages
  async getMessagesByChannelAsync(channel: number, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    return this.getMessagesByChannel(channel, limit, offset);
  }

  async markAllDMMessagesAsReadAsync(localNodeId: string, userId: number | null): Promise<number> {
    return this.markAllDMMessagesAsRead(localNodeId, userId);
  }

  async markChannelMessagesAsReadAsync(channelId: number, userId: number | null, beforeTimestamp?: number): Promise<number> {
    return this.markChannelMessagesAsRead(channelId, userId, beforeTimestamp);
  }

  async markDMMessagesAsReadAsync(localNodeId: string, remoteNodeId: string, userId: number | null, beforeTimestamp?: number): Promise<number> {
    return this.markDMMessagesAsRead(localNodeId, remoteNodeId, userId, beforeTimestamp);
  }

  // Group 3: Nodes
  async getNodesWithPublicKeysAsync(): Promise<Array<{ nodeNum: number; publicKey: string | null }>> {
    return this.getNodesWithPublicKeys();
  }

  async setNodeIgnoredAsync(nodeNum: number, isIgnored: boolean, sourceId: string): Promise<void> {
    this.setNodeIgnored(nodeNum, isIgnored, sourceId);
  }

  async getNodePositionOverrideAsync(nodeNum: number, sourceId: string): Promise<{
    enabled: boolean;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    isPrivate?: boolean;
  } | null> {
    return this.getNodePositionOverride(nodeNum, sourceId);
  }

  async setNodePositionOverrideAsync(
    nodeNum: number,
    enabled: boolean,
    sourceId: string,
    latitude?: number,
    longitude?: number,
    altitude?: number,
    isPrivate: boolean = false
  ): Promise<void> {
    this.setNodePositionOverride(nodeNum, enabled, sourceId, latitude, longitude, altitude, isPrivate);
  }

  async clearNodePositionOverrideAsync(nodeNum: number, sourceId: string): Promise<void> {
    this.clearNodePositionOverride(nodeNum, sourceId);
  }

  async handleAutoWelcomeEnabledAsync(): Promise<number> {
    return this.handleAutoWelcomeEnabled();
  }

  async markAllNodesAsWelcomedAsync(sourceId?: string | null): Promise<number> {
    return this.markAllNodesAsWelcomed(sourceId ?? null);
  }

  // Group 4: Traceroutes
  async recordTracerouteRequestAsync(fromNodeNum: number, toNodeNum: number, sourceId?: string): Promise<void> {
    await this.recordTracerouteRequest(fromNodeNum, toNodeNum, sourceId);
  }

  async getAllTraceroutesForRecalculationAsync(): Promise<any[]> {
    return this.getAllTraceroutesForRecalculation();
  }

  async clearRecordHolderSegmentAsync(sourceId?: string): Promise<void> {
    this.clearRecordHolderSegment(sourceId);
  }

  async updateRecordHolderSegmentAsync(segment: DbRouteSegment, sourceId?: string): Promise<void> {
    this.updateRecordHolderSegment(segment, sourceId);
  }

  // Group 5: Neighbors/Telemetry
  async getNeighborsForNodeAsync(nodeNum: number, sourceId?: string): Promise<DbNeighborInfo[]> {
    if (this.neighborsRepo) {
      const results = await this.neighborsRepo.getNeighborsForNode(nodeNum, sourceId);
      return results.map(n => this.convertRepoNeighborInfo(n));
    }
    return [];
  }

  async getTelemetryByNodeAveragedAsync(nodeId: string, sinceTimestamp?: number, intervalMinutes?: number, maxHours?: number, sourceId?: string): Promise<DbTelemetry[]> {
    return this.getTelemetryByNodeAveraged(nodeId, sinceTimestamp, intervalMinutes, maxHours, sourceId);
  }

  // Group 6: Ghost Nodes (in-memory, but async-compatible wrappers)
  async getSuppressedGhostNodesAsync(): Promise<Array<{ nodeNum: number; nodeId: string; expiresAt: number; remainingMs: number }>> {
    return this.getSuppressedGhostNodes();
  }

  async suppressGhostNodeAsync(nodeNum: number, durationMs: number = 30 * 60 * 1000): Promise<void> {
    this.suppressGhostNode(nodeNum, durationMs);
  }

  async unsuppressGhostNodeAsync(nodeNum: number): Promise<void> {
    this.unsuppressGhostNode(nodeNum);
  }

  async isNodeSuppressedAsync(nodeNum: number | undefined | null): Promise<boolean> {
    return this.isNodeSuppressed(nodeNum);
  }

  // Group 7: Settings/Config
  async isAutoTimeSyncEnabledAsync(): Promise<boolean> {
    return this.isAutoTimeSyncEnabled();
  }

  async getAutoTimeSyncIntervalMinutesAsync(): Promise<number> {
    return this.getAutoTimeSyncIntervalMinutes();
  }

  // Group 8: Export/Import
  async exportDataAsync(): Promise<{ nodes: DbNode[]; messages: DbMessage[] }> {
    return this.exportData();
  }

  async importDataAsync(data: { nodes: DbNode[]; messages: DbMessage[] }): Promise<void> {
    this.importData(data);
  }
}

// Export the class for testing purposes (allows creating isolated test instances)
export { DatabaseService };

export default new DatabaseService();