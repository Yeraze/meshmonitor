import BetterSqlite3Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { calculateDistance } from '../utils/distance.js';
import { compileUserRegex } from '../utils/safeRegex.js';
import { isNodeComplete } from '../utils/nodeHelpers.js';
import { logger } from '../utils/logger.js';
import { getEnvironmentConfig } from '../server/config/environment.js';

import { registry } from '../db/migrations.js';
import {
  readAppliedMigrationsPostgres,
  markMigrationAppliedPostgres,
  readAppliedMigrationsMysql,
  markMigrationAppliedMysql,
  runLedgeredMigrations,
} from '../db/migrationLedger.js';
import { validateThemeDefinition as validateTheme } from '../utils/themeValidation.js';
import { isSourceyResource } from '../types/permission.js';
import { computeAveragingIntervalMinutes } from '../utils/telemetryAveraging.js';
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
  PacketLogRepository,
  KeyRepairRepository,
  ChannelDatabaseRepository,
  IgnoredNodesRepository,
  EmbedProfileRepository,
  SourcesRepository,
  AnalysisRepository,
  WaypointsRepository,
  MeshCoreRepository,
  MqttPacketLogRepository,
  AtakContactsRepository,
  EstimatedPositionsRepository,
  AutoFavoriteTargetsRepository,
  SourcePkiKeysRepository,
  DeadDropRepository,
  AutomationsRepository,
  AutomationVariablesRepository,
  SavedRegionsRepository,
  SolarEstimatesRepository,
  NewsCacheRepository,
  BackupHistoryRepository,
  AutoTracerouteRepository,
  MeshcorePathfindingTargetsRepository,
  TimeSyncRepository,
  DistanceDeleteLogRepository,
  MapPreferencesRepository,
  ThemesRepository,
  ALL_SOURCES,
} from '../db/repositories/index.js';
import type { EstimatedPosition, EstimatedPositionInput, SourceScope } from '../db/repositories/index.js';
import type { DatabaseType, DbPacketLog as DbTypesPacketLog, DbPacketCountByNode, DbPacketCountByPortnum, DbDistinctRelayNode } from '../db/types.js';
import { updateNodeMobility } from '../server/services/nodeMobilityService.js';
import { selectNodeNeedingTraceroute } from '../server/services/autoTracerouteSelectionService.js';
import { NodeCacheService } from '../server/services/nodeCacheService.js';

// Configuration constants for traceroute history
const TRACEROUTE_HISTORY_LIMIT = getEnvironmentConfig().tracerouteHistoryLimit;
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
  /** meshtastic.MeshPacket.TransportMechanism — see migration 066. */
  transportMechanism?: number | null;
  /** #4240: unix seconds last heard over each transport (NULL = never).
   *  Migration 126. Map visibility keys off these, not the last-wins
   *  transportMechanism. */
  transportLastRf?: number | null;
  transportLastMqtt?: number | null;
  transportLastUdp?: number | null;
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
  positionLocationSource?: number; // Meshtastic Position.location_source: 0=UNSET, 1=MANUAL, 2=INTERNAL GPS, 3=EXTERNAL GPS (#4176)
  // Position override (Migration 040, updated in Migration 047 to boolean)
  positionOverrideEnabled?: boolean; // false = disabled, true = enabled
  latitudeOverride?: number; // Override latitude
  longitudeOverride?: number; // Override longitude
  altitudeOverride?: number; // Override altitude
  positionOverrideIsPrivate?: boolean; // Override privacy (false = public, true = private)
  hideFromMap?: boolean; // #3549: suppress this node's marker on maps only
  notes?: string; // #3921: free-text per-node MeshMonitor-local annotation
  isUnmessagable?: boolean; // #3684: User.is_unmessagable — node won't receive DMs
  isLicensed?: boolean; // #3684: User.is_licensed — amateur-radio licensed operator
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
  /** Impersonation flag (#2584): claims from == our local node but arrived over RF. */
  spoofSuspected?: boolean | null;
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
  // Per-position-fix receive metadata (issue #3492): SNR + hop info of the
  // packet a position fix arrived in. Only populated for position rows.
  rxSnr?: number;
  hopStart?: number;
  hopLimit?: number;
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
  /** JSON: `{ [nodeNum]: { lat, lng, alt? } }` — position snapshot at traceroute time. */
  routePositions?: string;
  /** Originating Meshtastic packet id (null/undefined = not captured). Enables cross-source correlation (#3623). */
  packetId?: number | null;
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

/**
 * MeshCore Auto-Pathfinding target filter config (#4024).
 *
 * Mirrors the AND/OR classification used by Auto-Traceroute's node filter:
 * lastHeard/hops/signal are AND pre-filters (narrow the pool first);
 * contacts/regex are OR-union identity filters (select within the pool).
 * `targetKeys` is table-backed (MeshcorePathfindingTargetsRepository); every
 * other field is a per-source settings KV pair. See
 * docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §2.7 / §0.
 */
export interface MeshcorePathfindingFilterSettings {
  enabled: boolean;              // master
  targetKeys: string[];          // allowlist (table-backed)
  contactsEnabled: boolean;      // OR: allowlist sub-filter enable
  regexEnabled: boolean;         // OR: name-regex enable
  nameRegex: string;             // regex value (default '.*')
  lastHeardEnabled: boolean;     // AND
  lastHeardHours: number;        // AND value (default 168)
  hopsEnabled: boolean;          // AND
  hopsMin: number;               // default 0
  hopsMax: number;               // default 10
  signalEnabled: boolean;        // AND
  rssiMin: number;               // dBm, default -200 (no-op)
  snrMin: number;                // dB,  default -100 (no-op)
}

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
  // Keyed by sourceId (or '__global__' when called without a source filter)
  private telemetryTypesCacheBySource: Map<
    string,
    { map: Map<string, string[]>; time: number }
  > = new Map();
  private static readonly TELEMETRY_TYPES_CACHE_TTL_MS = 60000; // 60 seconds
  private static readonly TELEMETRY_TYPES_CACHE_GLOBAL_KEY = '__global__';

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
  /**
   * In-memory node cache (PostgreSQL/MySQL sync-method compatibility). Extracted
   * into NodeCacheService, which owns the `${nodeNum}:${sourceId}` key scheme,
   * repo→cache conversion, and the NodesRepository cache-hook wiring.
   */
  public readonly nodeCache: NodeCacheService = new NodeCacheService();
  private channelsCache: Map<number, DbChannel> = new Map();
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
  public packetLogRepo: PacketLogRepository | null = null;
  public keyRepairRepo: KeyRepairRepository | null = null;
  public channelDatabaseRepo: ChannelDatabaseRepository | null = null;
  public ignoredNodesRepo: IgnoredNodesRepository | null = null;
  public embedProfileRepo: EmbedProfileRepository | null = null;
  public sourcesRepo: SourcesRepository | null = null;
  public analysisRepo: AnalysisRepository | null = null;
  public waypointsRepo: WaypointsRepository | null = null;
  public meshcoreRepo: MeshCoreRepository | null = null;
  public mqttPacketLogRepo: MqttPacketLogRepository | null = null;
  public atakContactsRepo: AtakContactsRepository | null = null;
  public estimatedPositionsRepo: EstimatedPositionsRepository | null = null;
  public autoFavoriteTargetsRepo: AutoFavoriteTargetsRepository | null = null;
  public sourcePkiKeysRepo: SourcePkiKeysRepository | null = null;
  public deadDropRepo: DeadDropRepository | null = null;
  public automationsRepo: AutomationsRepository | null = null;
  public automationVariablesRepo: AutomationVariablesRepository | null = null;
  public savedRegionsRepo: SavedRegionsRepository | null = null;
  public solarEstimatesRepo: SolarEstimatesRepository | null = null;
  public newsCacheRepo: NewsCacheRepository | null = null;
  public backupHistoryRepo: BackupHistoryRepository | null = null;
  public autoTracerouteRepo: AutoTracerouteRepository | null = null;
  public meshcorePathfindingTargetsRepo: MeshcorePathfindingTargetsRepository | null = null;
  public timeSyncRepo: TimeSyncRepository | null = null;
  public distanceDeleteLogRepo: DistanceDeleteLogRepository | null = null;
  public mapPreferencesRepo: MapPreferencesRepository | null = null;
  public themesRepo: ThemesRepository | null = null;

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

  get autoFavoriteTargets(): AutoFavoriteTargetsRepository {
    if (!this.autoFavoriteTargetsRepo) throw new Error('Database not initialized');
    return this.autoFavoriteTargetsRepo;
  }

  get sourcePkiKeys(): SourcePkiKeysRepository {
    if (!this.sourcePkiKeysRepo) throw new Error('Database not initialized');
    return this.sourcePkiKeysRepo;
  }

  get deadDrop(): DeadDropRepository {
    if (!this.deadDropRepo) throw new Error('Database not initialized');
    return this.deadDropRepo;
  }

  get automations(): AutomationsRepository {
    if (!this.automationsRepo) throw new Error('Database not initialized');
    return this.automationsRepo;
  }

  get automationVariables(): AutomationVariablesRepository {
    if (!this.automationVariablesRepo) throw new Error('Database not initialized');
    return this.automationVariablesRepo;
  }

  get savedRegions(): SavedRegionsRepository {
    if (!this.savedRegionsRepo) throw new Error('Database not initialized');
    return this.savedRegionsRepo;
  }

  get solarEstimates(): SolarEstimatesRepository {
    if (!this.solarEstimatesRepo) throw new Error('Database not initialized');
    return this.solarEstimatesRepo;
  }

  get newsCache(): NewsCacheRepository {
    if (!this.newsCacheRepo) throw new Error('Database not initialized');
    return this.newsCacheRepo;
  }

  get backupHistory(): BackupHistoryRepository {
    if (!this.backupHistoryRepo) throw new Error('Database not initialized');
    return this.backupHistoryRepo;
  }

  get autoTraceroute(): AutoTracerouteRepository {
    if (!this.autoTracerouteRepo) throw new Error('Database not initialized');
    return this.autoTracerouteRepo;
  }

  get meshcorePathfindingTargets(): MeshcorePathfindingTargetsRepository {
    if (!this.meshcorePathfindingTargetsRepo) throw new Error('Database not initialized');
    return this.meshcorePathfindingTargetsRepo;
  }

  get timeSync(): TimeSyncRepository {
    if (!this.timeSyncRepo) throw new Error('Database not initialized');
    return this.timeSyncRepo;
  }

  get distanceDeleteLog(): DistanceDeleteLogRepository {
    if (!this.distanceDeleteLogRepo) throw new Error('Database not initialized');
    return this.distanceDeleteLogRepo;
  }

  get mapPreferences(): MapPreferencesRepository {
    if (!this.mapPreferencesRepo) throw new Error('Database not initialized');
    return this.mapPreferencesRepo;
  }

  get themes(): ThemesRepository {
    if (!this.themesRepo) throw new Error('Database not initialized');
    return this.themesRepo;
  }

  get auth(): AuthRepository {
    if (!this.authRepo) throw new Error('Database not initialized');
    return this.authRepo;
  }

  get notifications(): NotificationsRepository {
    if (!this.notificationsRepo) throw new Error('Database not initialized');
    return this.notificationsRepo;
  }

  get packetLog(): PacketLogRepository {
    if (!this.packetLogRepo) throw new Error('Database not initialized');
    return this.packetLogRepo;
  }

  get keyRepair(): KeyRepairRepository {
    if (!this.keyRepairRepo) throw new Error('Database not initialized');
    return this.keyRepairRepo;
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

  get analysis(): AnalysisRepository {
    if (!this.analysisRepo) throw new Error('Database not initialized');
    return this.analysisRepo;
  }

  get waypoints(): WaypointsRepository {
    if (!this.waypointsRepo) throw new Error('Database not initialized');
    return this.waypointsRepo;
  }

  get meshcore(): MeshCoreRepository {
    if (!this.meshcoreRepo) throw new Error('Database not initialized');
    return this.meshcoreRepo;
  }

  get mqttPacketLog(): MqttPacketLogRepository {
    if (!this.mqttPacketLogRepo) throw new Error('Database not initialized');
    return this.mqttPacketLogRepo;
  }

  get atakContacts(): AtakContactsRepository {
    if (!this.atakContactsRepo) throw new Error('Database not initialized');
    return this.atakContactsRepo;
  }

  get estimatedPositions(): EstimatedPositionsRepository {
    if (!this.estimatedPositionsRepo) throw new Error('Database not initialized');
    return this.estimatedPositionsRepo;
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
    // Prime the in-memory ignore-list mirror now that migrations have created
    // the ignored_nodes table. Lets upsertNode re-apply the ignore flag
    // synchronously when a previously-ignored node reappears (issue #2601).
    this.ignoredNodesRepo?.primeCacheSqlite();

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
      // Wire the in-memory node cache to repository writes so PG/MySQL caches
      // stay coherent with DB state — fixes #2858 where bypassing the facade
      // (e.g. via `databaseService.nodes.upsertNode(...)`) left newly-discovered
      // nodes invisible to sync cache readers like setNodePositionOverride.
      this.nodesRepo.setCacheHook(this.nodeCache.buildHook());
      this.messagesRepo = new MessagesRepository(drizzleDb, this.drizzleDbType);
      this.telemetryRepo = new TelemetryRepository(drizzleDb, this.drizzleDbType);
      // Auth repo for all backends - Migration 012 aligned SQLite schema with Drizzle definitions
      this.authRepo = new AuthRepository(drizzleDb, this.drizzleDbType);
      this.traceroutesRepo = new TraceroutesRepository(drizzleDb, this.drizzleDbType);
      this.neighborsRepo = new NeighborsRepository(drizzleDb, this.drizzleDbType);
      this.notificationsRepo = new NotificationsRepository(drizzleDb, this.drizzleDbType);
      this.packetLogRepo = new PacketLogRepository(drizzleDb, this.drizzleDbType);
      this.keyRepairRepo = new KeyRepairRepository(drizzleDb, this.drizzleDbType);
      this.channelDatabaseRepo = new ChannelDatabaseRepository(drizzleDb, this.drizzleDbType);
      this.ignoredNodesRepo = new IgnoredNodesRepository(drizzleDb, this.drizzleDbType);
      this.embedProfileRepo = new EmbedProfileRepository(drizzleDb, this.drizzleDbType);
      this.sourcesRepo = new SourcesRepository(drizzleDb, this.drizzleDbType);
      this.analysisRepo = new AnalysisRepository(drizzleDb as any, this.drizzleDbType);
      this.waypointsRepo = new WaypointsRepository(drizzleDb, this.drizzleDbType);
      this.meshcoreRepo = new MeshCoreRepository(drizzleDb, this.drizzleDbType);
      this.mqttPacketLogRepo = new MqttPacketLogRepository(drizzleDb, this.drizzleDbType);
      this.atakContactsRepo = new AtakContactsRepository(drizzleDb, this.drizzleDbType);
      this.estimatedPositionsRepo = new EstimatedPositionsRepository(drizzleDb, this.drizzleDbType);
      this.autoFavoriteTargetsRepo = new AutoFavoriteTargetsRepository(drizzleDb, this.drizzleDbType);
      this.sourcePkiKeysRepo = new SourcePkiKeysRepository(drizzleDb, this.drizzleDbType);
      this.deadDropRepo = new DeadDropRepository(drizzleDb, this.drizzleDbType);
      this.automationsRepo = new AutomationsRepository(drizzleDb, this.drizzleDbType);
      this.automationVariablesRepo = new AutomationVariablesRepository(drizzleDb, this.drizzleDbType);
      this.savedRegionsRepo = new SavedRegionsRepository(drizzleDb, this.drizzleDbType);
      this.solarEstimatesRepo = new SolarEstimatesRepository(drizzleDb, this.drizzleDbType);
      this.newsCacheRepo = new NewsCacheRepository(drizzleDb, this.drizzleDbType);
      this.backupHistoryRepo = new BackupHistoryRepository(drizzleDb, this.drizzleDbType);
      this.autoTracerouteRepo = new AutoTracerouteRepository(drizzleDb, this.drizzleDbType);
      this.meshcorePathfindingTargetsRepo = new MeshcorePathfindingTargetsRepository(drizzleDb, this.drizzleDbType);
      this.timeSyncRepo = new TimeSyncRepository(drizzleDb, this.drizzleDbType);
      this.distanceDeleteLogRepo = new DistanceDeleteLogRepository(drizzleDb, this.drizzleDbType);
      this.mapPreferencesRepo = new MapPreferencesRepository(drizzleDb, this.drizzleDbType);
      this.themesRepo = new ThemesRepository(drizzleDb, this.drizzleDbType);

      logger.info('[DatabaseService] Drizzle repositories initialized successfully');

      // Load caches for PostgreSQL/MySQL to enable sync method compatibility
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        await this.loadCachesFromDatabase();
        // Prime the in-memory ignore-list mirror so upsertNode can re-apply the
        // ignore flag synchronously when an ignored node reappears (issue #2601).
        await this.ignoredNodesRepo?.primeCacheAsync();
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

      // Load all nodes into cache (NodeCacheService handles the repo→cache
      // conversion and cross-source warm-up).
      if (this.nodesRepo) {
        await this.nodeCache.warmFromRepo(this.nodesRepo);
        // Count nodes with welcomedAt set for auto-welcome diagnostics
        const nodesWithWelcome = Array.from(this.nodeCache.values()).filter(n => n.welcomedAt !== null && n.welcomedAt !== undefined);
        logger.info(`[DatabaseService] Loaded ${this.nodeCache.size} nodes into cache (${nodesWithWelcome.length} previously welcomed)`);
      }

      // Load all channels into cache
      if (this.channelsRepo) {
        // intentional cross-source: init cache warm-up loads all sources at once
        const channels = await this.channelsRepo.getAllChannels(ALL_SOURCES);
        this.channelsCache.clear();
        for (const channel of channels) {
          this.channelsCache.set(channel.id, channel);
        }
        logger.info(`[DatabaseService] Loaded ${this.channelsCache.size} channels into cache`);
      }

      // Load recent messages into cache for delivery state updates
      if (this.messagesRepo) {
        // intentional cross-source: init cache warm-up loads all sources at once
        const messages = await this.messagesRepo.getMessages(500, 0, ALL_SOURCES);
        this._messagesCache = messages.map(m => this.convertRepoMessage(m));
        logger.info(`[DatabaseService] Loaded ${this._messagesCache.length} messages into cache`);
      }

      // Load neighbor info into cache
      if (this.neighborsRepo) {
        // intentional cross-source: init cache warm-up loads all sources at once
        const neighbors = await this.neighborsRepo.getAllNeighborInfo(ALL_SOURCES);
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

    // Pre-3.7 detection: check BEFORE the migration loop so we can distinguish
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
        if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'SQLITE_CORRUPT') {
          const dbPath = getEnvironmentConfig().databasePath;
          logger.error(
            '\n════════════════════════════════════════════════════════\n' +
            'DATABASE CORRUPTION DETECTED\n' +
            '════════════════════════════════════════════════════════\n' +
            'Your SQLite database file is corrupted (SQLITE_CORRUPT).\n' +
            'On Raspberry Pi this is usually caused by SD card failure\n' +
            'or an unexpected power loss during a write operation.\n\n' +
            `Database location: ${dbPath}\n\n` +
            'To recover:\n' +
            `  1. Back up:  cp "${dbPath}" "${dbPath}.bak"\n` +
            `  2. Delete:   rm "${dbPath}"\n` +
            '  3. Restart MeshMonitor — a fresh database will be created.\n\n' +
            'Historical data will be lost. Keep the .bak file if you\n' +
            'want to attempt manual recovery with the sqlite3 tool.\n' +
            '════════════════════════════════════════════════════════',
          );
          process.exit(1);
        }
        throw error;
      }
    }
    this.runDataMigrations();
    this.ensureAutomationDefaults();
    this.warmupCaches();
    this.isInitialized = true;
  }

  // Warm up caches on startup to avoid cold cache latency on first request
  private warmupCaches(): void {
    try {
      logger.debug('🔥 Warming up database caches...');
      // Pre-populate the telemetry types cache (SQLite bootstrap path).
      const map = this.telemetry.getAllNodesTelemetryTypesSync();
      this.telemetryTypesCacheBySource.set(DatabaseService.TELEMETRY_TYPES_CACHE_GLOBAL_KEY, { map, time: Date.now() });
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

      const existingNode = this.nodesRepo!.getNodeSqlite(broadcastNodeNum) as unknown as DbNode | null;
      logger.debug('🔍 getNode(4294967295) returned:', existingNode);

      if (!existingNode) {
        logger.debug('🔍 No broadcast node found, creating it');
        this.nodesRepo!.upsertNodeSqlite({
          nodeNum: broadcastNodeNum,
          nodeId: broadcastNodeId,
          longName: 'Broadcast',
          shortName: 'BCAST'
        }, false);

        // Verify it was created
        const verify = this.nodesRepo!.getNodeSqlite(broadcastNodeNum) as unknown as DbNode | null;
        logger.debug('🔍 After upsert, getNode(4294967295) returns:', verify);
      } else {
        logger.debug(`✅ Broadcast node already exists`);
      }
    } catch (error) {
      logger.error('❌ Error in ensureBroadcastNode:', error);
    }
  }

  // SQLite-only record-holder update used by the runDataMigrations bootstrap.
  private updateRecordHolderSegmentSqlite(newSegment: DbRouteSegment, sourceId?: string): void {
    const currentRecord = this.traceroutesRepo!.getRecordHolderRouteSegmentSync(sourceId) as unknown as DbRouteSegment | null;
    if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
      this.traceroutesRepo!.clearRecordHolderSegmentSync(sourceId);
      this.traceroutesRepo!.insertRouteSegmentSync({ ...newSegment, isRecordHolder: true }, sourceId);
    }
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

            const fromNode = this.nodesRepo!.getNodeSqlite(fromNodeNum) as unknown as DbNode | null;
            const toNode = this.nodesRepo!.getNodeSqlite(toNodeNum) as unknown as DbNode | null;

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

              const rdmSid = (traceroute as any).sourceId ?? undefined;
              this.traceroutesRepo!.insertRouteSegmentSync(segment, rdmSid);
              this.updateRecordHolderSegmentSqlite(segment, rdmSid);
              segmentsCreated++;
            }
          }

          // Process return route segments
          for (let i = 0; i < routeBack.length - 1; i++) {
            const fromNodeNum = routeBack[i];
            const toNodeNum = routeBack[i + 1];

            const fromNode = this.nodesRepo!.getNodeSqlite(fromNodeNum) as unknown as DbNode | null;
            const toNode = this.nodesRepo!.getNodeSqlite(toNodeNum) as unknown as DbNode | null;

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

              const rdmSid = (traceroute as any).sourceId ?? undefined;
              this.traceroutesRepo!.insertRouteSegmentSync(segment, rdmSid);
              this.updateRecordHolderSegmentSqlite(segment, rdmSid);
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


  /**
   * Fire the "new node discovered" notification when an upsert moves a node
   * from incomplete -> complete (has longName + shortName + hwModel) for the
   * first time. Deduped per-process via newNodeNotifiedSet, and gated against
   * the node's prior persisted state so a device re-dumping its known NodeDB on
   * reconnect does NOT re-notify already-complete nodes. Fire-and-forget — it
   * never blocks the caller.
   *
   * Shared by upsertNode() (the sync MQTT path) and upsertNodeAsync() (the
   * direct Meshtastic path) so both behave identically (issue #3796).
   */
  private maybeNotifyNewNode(
    // Minimal structural shape so both the local-DbNode wrapper path and the
    // repo-DbNode upsertNodeAsync path can pass their node objects without a
    // cast (the two DbNode definitions differ on unrelated fields).
    nodeData: {
      nodeNum?: number | null;
      nodeId?: string | null;
      longName?: string | null;
      shortName?: string | null;
      hwModel?: number | null;
      hopsAway?: number | null;
      sourceId?: string | null;
    },
    existingNode: DbNode | null | undefined,
    sourceId?: string
  ): void {
    const nodeNum = nodeData.nodeNum;
    if (nodeNum === undefined || nodeNum === null || nodeNum === 4294967295) return;
    if (this.newNodeNotifiedSet.has(nodeNum)) return;

    // Only notify on the incomplete -> complete transition, never for a node
    // that was already complete before this upsert.
    const wasComplete = existingNode ? isNodeComplete(existingNode) : false;
    if (wasComplete) return;

    const mergedNode = {
      nodeId: nodeData.nodeId ?? existingNode?.nodeId,
      longName: nodeData.longName ?? existingNode?.longName,
      shortName: nodeData.shortName ?? existingNode?.shortName,
      hwModel: nodeData.hwModel ?? existingNode?.hwModel,
    };
    if (!isNodeComplete(mergedNode)) return;

    this.newNodeNotifiedSet.add(nodeNum);
    const newNodeSourceId = sourceId ?? (nodeData as any).sourceId ?? (existingNode as any)?.sourceId ?? 'default';
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
        (nodeData.hopsAway ?? existingNode?.hopsAway) ?? undefined,
        newNodeSourceId,
        sourceName
      );
    }).catch(err => logger.error('Failed to send new node notification:', err));
  }

  /**
   * Async node upsert that ALSO fires the new-node notification. The direct
   * Meshtastic path (meshtasticManager) previously called
   * databaseService.nodes.upsertNode() directly, bypassing the notification
   * logic that lived only in the sync upsertNode() wrapper — so "Newly Found
   * Node" notifications never fired for directly-connected Meshtastic nodes
   * (issue #3796). This wraps the same repository write and adds the shared
   * completeness/dedup-gated notification check.
   */
  async upsertNodeAsync(nodeData: Parameters<NodesRepository['upsertNode']>[0], sourceId?: string): Promise<void> {
    const nodeNum = nodeData.nodeNum;
    const sid = sourceId ?? (nodeData as any).sourceId;

    // Only pay for the pre-upsert read when this node could still need a
    // notification (not yet notified, not the broadcast address). Once a node
    // has been notified this short-circuits to a single Set lookup.
    const needsCheck = nodeNum !== undefined && nodeNum !== null &&
      nodeNum !== 4294967295 && !this.newNodeNotifiedSet.has(nodeNum);
    const existingNode = needsCheck ? await this.nodes.getNode(nodeNum!, sid) as unknown as DbNode | null : null;

    await this.nodes.upsertNode(nodeData, sid);

    // Per-source ignore list is authoritative (issue #2601): a node's on-device
    // ignore flag is wiped when the device's nodeDB churns, and it then reports
    // the node as un-ignored. If the node is still on our blocklist, force the
    // flag back on — for newly discovered AND existing nodes. The repository
    // upsert never writes isIgnored, so re-apply it explicitly after the write.
    if (nodeNum !== undefined && nodeNum !== null && nodeNum !== 4294967295 &&
        (nodeData as any).isIgnored !== true && sid &&
        this.ignoredNodesRepo?.isIgnoredCached(nodeNum, sid)) {
      await this.nodes.setNodeIgnored(nodeNum, true, sid);
    }

    if (needsCheck) {
      this.maybeNotifyNewNode(nodeData, existingNode, sid);
    }
  }



  /**
   * @deprecated Use databaseService.nodes.getAllNodes() directly. Kept for internal/test compatibility.
   */
  async getAllNodesAsync(): Promise<DbNode[]> {
    return this.nodes.getAllNodes(ALL_SOURCES) as unknown as DbNode[]; // intentional cross-source: deprecated compat shim returns all sources
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

    return this.packetLogRepo!.getPacketCountsPerNodeSince({
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

    return this.packetLogRepo!.getTopBroadcastersSince({
      since: oneHourAgo,
      limit,
      localNodeNum,
      sourceId,
    });
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
   * Get all nodes with excessive packet rates (async)
   */
  async getNodesWithExcessivePacketsAsync(sourceId?: string): Promise<DbNode[]> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.nodeCache.iterate(sourceId)) {
        if ((node as any).isExcessivePackets) {
          result.push(node);
        }
      }
      return result;
    }

    return this.nodesRepo!.getNodesWithExcessivePacketsSqlite(sourceId) as unknown as DbNode[];
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
   * Get all nodes with time offset issues (async)
   */
  async getNodesWithTimeOffsetIssuesAsync(sourceId?: string): Promise<DbNode[]> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.nodeCache.iterate(sourceId)) {
        if ((node as any).isTimeOffsetIssue) {
          result.push(node);
        }
      }
      return result;
    }

    return this.nodesRepo!.getNodesWithTimeOffsetIssuesSqlite(sourceId) as unknown as DbNode[];
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




  async getMessageByRequestIdAsync(requestId: number): Promise<DbMessage | null> {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        const msg = await this.messagesRepo.getMessageByRequestId(requestId);
        return msg ? this.convertRepoMessage(msg) : null;
      }
      return null;
    }
    // SQLite: use the Drizzle sync variant
    if (this.messagesRepo) {
      const msg = this.messagesRepo.getMessageByRequestIdSqlite(requestId);
      return msg ? this.convertRepoMessage(msg as any) : null;
    }
    return null;
  }


  // Internal cache for messages (used for PostgreSQL sync compatibility)
  private _messagesCache: DbMessage[] = [];

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
      spoofSuspected: msg.spoofSuspected ?? undefined,
    };
  }



  // Direct messages methods moved to MessagesRepository (databaseService.messages.getDirectMessages)


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








  /**
   * Async version of updateNodeMobility - works for all database backends
   * Detects if a node has moved more than 100 meters based on position history
   * @param nodeId The node ID to check
   * @returns The updated mobility status (0 = stationary, 1 = mobile)
   */
  async updateNodeMobilityAsync(nodeId: string): Promise<number> {
    // Delegates the movement heuristic to NodeMobilityService; the cache patch
    // stays here so the service has no direct dependency on the facade's cache.
    return updateNodeMobility(nodeId, {
      telemetryRepo: this.telemetryRepo!,
      nodesRepo: this.nodesRepo!,
      patchCache: (nid, mobile) => {
        this.nodeCache.patchMobility(nid, mobile);
      },
    });
  }


  async getMessagesByDayAsync(days: number = 7, sourceId?: string): Promise<Array<{ date: string; count: number }>> {
    if (this.messagesRepo) {
      return this.messagesRepo.getMessagesByDay(days, sourceId);
    }
    return [];
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



  // Channel operations
  // (legacy synchronous DatabaseService.upsertChannel + ChannelsRepository.upsertChannelSync
  //  removed — dead code with no callers; all channel upserts go through the
  //  async, #1567-guarded databaseService.channels.upsertChannel)







  /**
   * Async version of insertTelemetry - works with all database backends
   */
  async insertTelemetryAsync(telemetryData: DbTelemetry, sourceId?: string): Promise<void> {
    await this.telemetry.insertTelemetry(telemetryData, sourceId);
    this.invalidateTelemetryTypesCache();
  }




  /** @deprecated Use databaseService.telemetry.getPositionTelemetryByNode() instead */
  async getPositionTelemetryByNodeAsync(nodeId: string, limit: number = 1500, sinceTimestamp?: number, beforeTimestamp?: number): Promise<DbTelemetry[]> {
    // Cast to local DbTelemetry type (they have compatible structure)
    return this.telemetry.getPositionTelemetryByNode(nodeId, limit, sinceTimestamp, ALL_SOURCES, beforeTimestamp) as unknown as Promise<DbTelemetry[]>; // intentional cross-source: deprecated shim has no sourceId
  }


  /**
   * Get the latest estimated position for every node as a Map keyed by nodeId.
   * Reads the GLOBAL `estimated_positions` table (one estimate per physical node,
   * pooled across all Meshtastic sources by positionEstimationService) — not the
   * old per-source telemetry rows. Used by the node-enhancement / display path.
   */
  async getAllNodesEstimatedPositionsAsync(): Promise<Map<string, { latitude: number; longitude: number }>> {
    const rows = await this.estimatedPositions.getAll();
    const map = new Map<string, { latitude: number; longitude: number }>();
    for (const row of rows) {
      map.set(row.nodeId, { latitude: row.latitude, longitude: row.longitude });
    }
    return map;
  }

  /** Get all global estimated positions (full rows incl. uncertaintyKm). */
  async getAllEstimatedPositionsAsync(): Promise<EstimatedPosition[]> {
    return this.estimatedPositions.getAll();
  }


  /** Bulk-upsert global estimated positions. */
  async upsertEstimatedPositionsAsync(inputs: EstimatedPositionInput[]): Promise<void> {
    return this.estimatedPositions.upsertManyEstimates(inputs);
  }

  /** Delete global estimates for the given node numbers. */
  async deleteEstimatedPositionsByNodeNumsAsync(nodeNums: number[]): Promise<number> {
    return this.estimatedPositions.deleteByNodeNums(nodeNums);
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
    intervalMinutes: number = 15,
    sourceId?: SourceScope
  ): Promise<Array<{ timestamp: number; minHops: number; maxHops: number; avgHops: number }>> {
    return this.telemetry.getSmartHopsStats(nodeId, sinceTimestamp, intervalMinutes, sourceId);
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
    sinceTimestamp: number,
    sourceId?: SourceScope
  ): Promise<Array<{ timestamp: number; quality: number }>> {
    return this.telemetry.getLinkQualityHistory(nodeId, sinceTimestamp, sourceId);
  }





  async getPacketRatesAsync(
    nodeId: string,
    types: string[],
    sinceTimestamp?: number,
    sourceId?: string
  ): Promise<Record<string, Array<{ timestamp: number; ratePerMinute: number }>>> {
    // Backend-agnostic path: the telemetry repository computes rates via Drizzle
    // for SQLite/PostgreSQL/MySQL alike (see TelemetryRepository.getPacketRates).
    if (this.telemetryRepo) {
      // intentional cross-source when sourceId omitted: the legacy facade
      // (raw SQL) skipped the source filter entirely for undefined sourceId,
      // and withSourceScope throws on undefined — preserve that behavior.
      return this.telemetryRepo.getPacketRates(nodeId, types, sinceTimestamp, sourceId ?? ALL_SOURCES);
    }
    // No repo wired (should not happen post-init) — return empty rates per type.
    const empty: Record<string, Array<{ timestamp: number; ratePerMinute: number }>> = {};
    for (const type of types) empty[type] = [];
    return empty;
  }


  /**
   * Async version of insertTraceroute — carries the FULL pending-response
   * deduplication logic for all backends (not a delegation to the sync form).
   * For PG/MySQL it awaits the async repo dedup path; for SQLite it runs the
   * transactional sync upsert (which is itself synchronous under the hood).
   */
  async insertTracerouteAsync(tracerouteData: DbTraceroute, sourceId?: string): Promise<void> {
    // For PostgreSQL/MySQL, use async repository with full dedup logic
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        const now = Date.now();
        const pendingTimeoutAgo = now - PENDING_TRACEROUTE_TIMEOUT_MS;
        try {
          // Check for pending traceroute (reversed direction - see note below)
          // NOTE: When a traceroute response comes in, fromNum is the destination (responder) and toNum is the local node (requester)
          // But when we created the pending record, fromNodeNum was the local node and toNodeNum was the destination
          const pendingRecord = await this.traceroutesRepo.findPendingTraceroute(
            tracerouteData.toNodeNum,    // Reversed: response's toNum is the requester
            tracerouteData.fromNodeNum,  // Reversed: response's fromNum is the destination
            pendingTimeoutAgo,
            sourceId
          );

          if (pendingRecord) {
            // Update existing pending record
            await this.traceroutesRepo.updateTracerouteResponse(
              pendingRecord.id,
              tracerouteData.route || null,
              tracerouteData.routeBack || null,
              tracerouteData.snrTowards || null,
              tracerouteData.snrBack || null,
              tracerouteData.timestamp,
              tracerouteData.packetId ?? null
            );
          } else {
            // Insert new traceroute
            await this.traceroutesRepo.insertTraceroute(tracerouteData, sourceId);
          }

          // Cleanup old traceroutes
          await this.traceroutesRepo.cleanupOldTraceroutesForPair(
            tracerouteData.fromNodeNum,
            tracerouteData.toNodeNum,
            TRACEROUTE_HISTORY_LIMIT,
            sourceId
          );
        } catch (error) {
          logger.error('[DatabaseService] Failed to insert traceroute:', error);
        }
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



  /**
   * Async version of getAllTraceroutes — works across all backends by awaiting
   * the repository directly instead of relying on the sync fire-and-cache path.
   */
  async getAllTraceroutesAsync(limit: number = 100, sourceId?: SourceScope): Promise<DbTraceroute[]> {
    return (await this.traceroutes.getAllTraceroutes(limit, sourceId)) as unknown as DbTraceroute[];
  }


  /**
   * Async version of getNodeNeedingTraceroute - works with all database backends
   * Returns a node that needs a traceroute based on configured filters and timing
   */
  async getNodeNeedingTracerouteAsync(localNodeNum: number, sourceId?: string): Promise<DbNode | null> {
    // Selection is fully backend-agnostic via the extracted service + repo.
    if (!this.nodesRepo) return null;

    // Read ALL filter configuration per-source (falls back to global when
    // no per-source override exists). This is what makes Auto-Traceroute
    // filters honor the Source that the scheduler tick is running on.
    const filterCfg = await this.getTracerouteFilterSettingsAsync(sourceId);

    // Get maxNodeAgeHours setting to filter only active nodes.
    const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');

    return selectNodeNeedingTraceroute(localNodeNum, sourceId, {
      filterCfg,
      maxNodeAgeHours,
      nodesRepo: this.nodesRepo!,
      normalizeBigInts: (node) => this.normalizeBigInts(node),
    }) as unknown as Promise<DbNode | null>;
  }

  /**
   * Read the per-source Remote LocalStats automation filter config (issue #3398).
   * Mirrors getTracerouteFilterSettingsAsync but with the smaller filter set the
   * feature exposes: discrete node list / role / favorite / name-regex. All keys
   * default-on-read, so no migration/seed is required for unset sources.
   */
  async getRemoteLocalStatsFilterSettingsAsync(sourceId?: string): Promise<{
    enabled: boolean;
    nodeNums: number[];
    filterRoles: number[];
    filterNameRegex: string;
    filterNodesEnabled: boolean;
    filterRolesEnabled: boolean;
    filterFavoriteEnabled: boolean;
    filterRegexEnabled: boolean;
    filterLastHeardEnabled: boolean;
    filterLastHeardHours: number;
  }> {
    const read = (key: string) => this.settings.getSettingForSource(sourceId ?? null, key);
    const [
      enabledStr, nodesStr, rolesStr, regexStr,
      nodesEnStr, rolesEnStr, favoriteEnStr, regexEnStr,
      lastHeardEnStr, lastHeardHoursStr,
    ] = await Promise.all([
      read('remoteLocalStatsFilterEnabled'),
      read('remoteLocalStatsFilterNodes'),
      read('remoteLocalStatsFilterRoles'),
      read('remoteLocalStatsFilterNameRegex'),
      read('remoteLocalStatsFilterNodesEnabled'),
      read('remoteLocalStatsFilterRolesEnabled'),
      read('remoteLocalStatsFilterFavoriteEnabled'),
      read('remoteLocalStatsFilterRegexEnabled'),
      read('remoteLocalStatsFilterLastHeardEnabled'),
      read('remoteLocalStatsFilterLastHeardHours'),
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
      nodeNums: parseJsonArray(nodesStr),
      filterRoles: parseJsonArray(rolesStr),
      filterNameRegex: regexStr ?? '.*',
      // Default-on: when the filter group is enabled but a sub-filter flag is
      // unset, treat it as active (matches the traceroute `!== 'false'` idiom).
      filterNodesEnabled: nodesEnStr !== 'false',
      filterRolesEnabled: rolesEnStr !== 'false',
      filterFavoriteEnabled: favoriteEnStr === 'true',
      filterRegexEnabled: regexEnStr !== 'false',
      filterLastHeardEnabled: lastHeardEnStr === 'true',
      filterLastHeardHours: parseIntBounded(lastHeardHoursStr, 168),
    };
  }

  /**
   * Persist the per-source Remote LocalStats filter config (issue #3398).
   * Always per-source (the feature is 4.x-only; there is no legacy global path).
   */
  async setRemoteLocalStatsFilterSettingsAsync(settings: {
    enabled: boolean;
    nodeNums: number[];
    filterRoles: number[];
    filterNameRegex: string;
    filterNodesEnabled?: boolean;
    filterRolesEnabled?: boolean;
    filterFavoriteEnabled?: boolean;
    filterRegexEnabled?: boolean;
    filterLastHeardEnabled?: boolean;
    filterLastHeardHours?: number;
  }, sourceId: string): Promise<void> {
    const kv: Record<string, string> = {
      remoteLocalStatsFilterEnabled: settings.enabled ? 'true' : 'false',
      remoteLocalStatsFilterNodes: JSON.stringify(settings.nodeNums),
      remoteLocalStatsFilterRoles: JSON.stringify(settings.filterRoles),
      remoteLocalStatsFilterNameRegex: settings.filterNameRegex,
    };
    if (settings.filterNodesEnabled !== undefined) kv.remoteLocalStatsFilterNodesEnabled = settings.filterNodesEnabled ? 'true' : 'false';
    if (settings.filterRolesEnabled !== undefined) kv.remoteLocalStatsFilterRolesEnabled = settings.filterRolesEnabled ? 'true' : 'false';
    if (settings.filterFavoriteEnabled !== undefined) kv.remoteLocalStatsFilterFavoriteEnabled = settings.filterFavoriteEnabled ? 'true' : 'false';
    if (settings.filterRegexEnabled !== undefined) kv.remoteLocalStatsFilterRegexEnabled = settings.filterRegexEnabled ? 'true' : 'false';
    if (settings.filterLastHeardEnabled !== undefined) kv.remoteLocalStatsFilterLastHeardEnabled = settings.filterLastHeardEnabled ? 'true' : 'false';
    if (settings.filterLastHeardHours !== undefined) kv.remoteLocalStatsFilterLastHeardHours = String(settings.filterLastHeardHours);
    await this.settings.setSourceSettings(sourceId, kv);
    logger.debug(`✅ Updated per-source remote LocalStats filter settings (source=${sourceId})`);
  }

  /**
   * Return the set of remote nodes that should be polled for local_stats on this
   * source (issue #3398). Unlike the traceroute picker this returns the FULL
   * matched set — the scheduler round-robins one target per tick. Union-of-enabled
   * filter semantics (list / role / favorite / name-regex), always excluding the
   * local node and (optionally) stale nodes.
   */
  async getNodesNeedingRemoteLocalStatsAsync(localNodeNum: number, sourceId?: string): Promise<DbNode[]> {
    try {
      const cfg = await this.getRemoteLocalStatsFilterSettingsAsync(sourceId);

      // Candidate base: active nodes for this source. maxNodeAgeHours bounds how
      // far back "active" reaches so we never poll long-dead nodes.
      const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');
      const sinceDays = Math.max(1, Math.ceil(maxNodeAgeHours / 24));
      let nodes = (await this.nodesRepo!.getActiveNodes(sinceDays, sourceId)) as unknown as DbNode[];

      // Never poll ourselves.
      nodes = nodes.filter(n => Number(n.nodeNum) !== Number(localNodeNum));

      // Optional last-heard tightening (AND, applied before the OR union).
      if (cfg.filterLastHeardEnabled) {
        const lastHeardCutoff = Math.floor(Date.now() / 1000) - (cfg.filterLastHeardHours * 3600);
        nodes = nodes.filter(n => n.lastHeard != null && n.lastHeard >= lastHeardCutoff);
      }

      if (cfg.enabled) {
        let regexMatcher: RegExp | null = null;
        if (cfg.filterRegexEnabled && cfg.filterNameRegex && cfg.filterNameRegex !== '.*') {
          try { regexMatcher = compileUserRegex(cfg.filterNameRegex, 'i'); }
          catch (e) { logger.warn(`Invalid remote LocalStats filter regex: ${cfg.filterNameRegex}`, e); }
        }

        const hasAnyFilter =
          (cfg.filterNodesEnabled && cfg.nodeNums.length > 0) ||
          (cfg.filterRolesEnabled && cfg.filterRoles.length > 0) ||
          cfg.filterFavoriteEnabled ||
          (cfg.filterRegexEnabled && regexMatcher !== null);

        if (hasAnyFilter) {
          nodes = nodes.filter(node => {
            // UNION: node passes if it matches ANY enabled filter.
            if (cfg.filterNodesEnabled && cfg.nodeNums.length > 0 && cfg.nodeNums.includes(Number(node.nodeNum))) return true;
            if (cfg.filterRolesEnabled && cfg.filterRoles.length > 0 && node.role != null && cfg.filterRoles.includes(node.role)) return true;
            if (cfg.filterFavoriteEnabled && node.isFavorite === true) return true;
            if (cfg.filterRegexEnabled && regexMatcher !== null) {
              const name = node.longName || node.shortName || node.nodeId || '';
              if (regexMatcher.test(name)) return true;
            }
            return false;
          });
        }
        // hasAnyFilter false → no narrowing (all active remote nodes are targets).
      } else {
        // Filter group disabled → automation has no explicit targets. Returning
        // an empty set keeps the feature strictly opt-in (won't blanket-poll the
        // whole mesh just because an interval was set).
        return [];
      }

      return nodes.map(n => this.normalizeBigInts(n));
    } catch (error) {
      logger.error('Error in getNodesNeedingRemoteLocalStatsAsync:', error);
      return [];
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
        const existingNode = this.nodeCache.get(nodeNum, sourceId);
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



  // Solar Estimates methods
  async upsertSolarEstimateAsync(timestamp: number, wattHours: number, fetchedAt: number): Promise<void> {
    await this.solarEstimates.upsertSolarEstimate({
      timestamp,
      watt_hours: wattHours,
      fetched_at: fetchedAt,
    });
  }

  async getRecentSolarEstimatesAsync(limit: number = 100): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    return this.solarEstimates.getRecentSolarEstimates(limit);
  }

  async getSolarEstimatesInRangeAsync(startTimestamp: number, endTimestamp: number): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    return this.solarEstimates.getSolarEstimatesInRange(startTimestamp, endTimestamp);
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
    const nodeNums = await this.autoTraceroute.getAutoTracerouteNodes(sourceId);
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
      await this.autoTraceroute.setAutoTracerouteNodes(settings.nodeNums, sourceId);
      logger.debug(`✅ Updated per-source traceroute filter settings (source=${sourceId})`);
      return;
    }

    this.setAutoTracerouteNodeFilterEnabled(settings.enabled);
    await this.autoTraceroute.setAutoTracerouteNodes(settings.nodeNums, sourceId);
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

  // MeshCore Auto-Pathfinding target filter settings (#4024).
  //
  // Mirrors getTracerouteFilterSettingsAsync/setTracerouteFilterSettingsAsync
  // (above), but sourceId is required — MeshCore managers always have one,
  // unlike Auto-Traceroute which also supports a legacy unscoped global mode.
  async getMeshcorePathfindingFilterSettingsAsync(sourceId: string): Promise<MeshcorePathfindingFilterSettings> {
    const targetKeys = await this.meshcorePathfindingTargets.getTargets(sourceId);
    const read = (key: string) => this.settings.getSettingForSource(sourceId, key);
    const [
      enabledStr, contactsEnStr, regexEnStr, nameRegexStr,
      lastHeardEnStr, lastHeardHoursStr,
      hopsEnStr, hopsMinStr, hopsMaxStr,
      signalEnStr, rssiMinStr, snrMinStr,
    ] = await Promise.all([
      read('meshcorePathfindingFilterEnabled'),
      read('meshcorePathfindingFilterContactsEnabled'),
      read('meshcorePathfindingFilterRegexEnabled'),
      read('meshcorePathfindingFilterNameRegex'),
      read('meshcorePathfindingFilterLastHeardEnabled'),
      read('meshcorePathfindingFilterLastHeardHours'),
      read('meshcorePathfindingFilterHopsEnabled'),
      read('meshcorePathfindingFilterHopsMin'),
      read('meshcorePathfindingFilterHopsMax'),
      read('meshcorePathfindingFilterSignalEnabled'),
      read('meshcorePathfindingFilterRssiMin'),
      read('meshcorePathfindingFilterSnrMin'),
    ]);

    const parseIntBounded = (s: string | null, def: number, min = -Infinity, max = Infinity): number => {
      if (s === null || s === undefined || s === '') return def;
      const n = parseInt(s, 10);
      if (isNaN(n) || n < min || n > max) return def;
      return n;
    };

    return {
      enabled: enabledStr === 'true',
      targetKeys,
      contactsEnabled: contactsEnStr === 'true',
      regexEnabled: regexEnStr === 'true',
      nameRegex: nameRegexStr ?? '.*',
      lastHeardEnabled: lastHeardEnStr === 'true',
      lastHeardHours: parseIntBounded(lastHeardHoursStr, 168, 1, 8760),
      hopsEnabled: hopsEnStr === 'true',
      hopsMin: parseIntBounded(hopsMinStr, 0, 0, 10),
      hopsMax: parseIntBounded(hopsMaxStr, 10, 0, 10),
      signalEnabled: signalEnStr === 'true',
      rssiMin: parseIntBounded(rssiMinStr, -200, -200, 0),
      snrMin: parseIntBounded(snrMinStr, -100, -100, 100),
    };
  }

  async setMeshcorePathfindingFilterSettingsAsync(
    sourceId: string,
    settings: Partial<MeshcorePathfindingFilterSettings> & { targetKeys: string[] },
  ): Promise<void> {
    const kv: Record<string, string> = {};
    if (settings.enabled !== undefined) kv.meshcorePathfindingFilterEnabled = settings.enabled ? 'true' : 'false';
    if (settings.contactsEnabled !== undefined) kv.meshcorePathfindingFilterContactsEnabled = settings.contactsEnabled ? 'true' : 'false';
    if (settings.regexEnabled !== undefined) kv.meshcorePathfindingFilterRegexEnabled = settings.regexEnabled ? 'true' : 'false';
    if (settings.nameRegex !== undefined) kv.meshcorePathfindingFilterNameRegex = settings.nameRegex;
    if (settings.lastHeardEnabled !== undefined) kv.meshcorePathfindingFilterLastHeardEnabled = settings.lastHeardEnabled ? 'true' : 'false';
    if (settings.lastHeardHours !== undefined) kv.meshcorePathfindingFilterLastHeardHours = String(settings.lastHeardHours);
    if (settings.hopsEnabled !== undefined) kv.meshcorePathfindingFilterHopsEnabled = settings.hopsEnabled ? 'true' : 'false';
    if (settings.hopsMin !== undefined) kv.meshcorePathfindingFilterHopsMin = String(settings.hopsMin);
    if (settings.hopsMax !== undefined) kv.meshcorePathfindingFilterHopsMax = String(settings.hopsMax);
    if (settings.signalEnabled !== undefined) kv.meshcorePathfindingFilterSignalEnabled = settings.signalEnabled ? 'true' : 'false';
    if (settings.rssiMin !== undefined) kv.meshcorePathfindingFilterRssiMin = String(settings.rssiMin);
    if (settings.snrMin !== undefined) kv.meshcorePathfindingFilterSnrMin = String(settings.snrMin);

    if (Object.keys(kv).length > 0) {
      await this.settings.setSourceSettings(sourceId, kv);
    }
    await this.meshcorePathfindingTargets.setTargets(settings.targetKeys, sourceId);
    logger.debug(`Updated MeshCore pathfinding filter settings (source=${sourceId})`);
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
      return this.autoTraceroute!.getAutoTracerouteLogSync(limit, sourceId);
    }
    return this.autoTraceroute!.getAutoTracerouteLog(limit, sourceId);
  }

  /**
   * Async version of logAutoTracerouteAttempt - works with all database backends
   */
  async logAutoTracerouteAttemptAsync(toNodeNum: number, toNodeName: string | null, sourceId?: string): Promise<number> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.autoTraceroute!.logAutoTracerouteAttemptSync(toNodeNum, toNodeName, sourceId);
    }
    return this.autoTraceroute!.logAutoTracerouteAttempt(toNodeNum, toNodeName, sourceId);
  }

  /**
   * Async version of updateAutoTracerouteResultByNode - works with all database backends
   */
  async updateAutoTracerouteResultByNodeAsync(toNodeNum: number, success: boolean): Promise<void> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      this.autoTraceroute!.updateAutoTracerouteResultByNodeSync(toNodeNum, success);
      return;
    }
    await this.autoTraceroute!.updateAutoTracerouteResultByNode(toNodeNum, success);
  }

  // Auto key repair state methods — thin delegations to KeyRepairRepository (Task 3.2)

  async getKeyRepairStateAsync(nodeNum: number): Promise<{
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null> {
    return this.keyRepairRepo!.getKeyRepairStateAsync(nodeNum);
  }

  async setKeyRepairStateAsync(nodeNum: number, state: {
    attemptCount?: number;
    lastAttemptTime?: number;
    exhausted?: boolean;
    startedAt?: number;
  }): Promise<void> {
    return this.keyRepairRepo!.setKeyRepairStateAsync(nodeNum, state);
  }

  async clearKeyRepairStateAsync(nodeNum: number): Promise<void> {
    return this.keyRepairRepo!.clearKeyRepairStateAsync(nodeNum);
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
    return this.keyRepairRepo!.getNodesNeedingKeyRepairAsync();
  }

  // Auto key repair log methods — thin delegations to KeyRepairRepository (Task 3.2)

  async logKeyRepairAttemptAsync(
    nodeNum: number,
    nodeName: string | null,
    action: string,
    success: boolean | null = null,
    oldKeyFragment: string | null = null,
    newKeyFragment: string | null = null,
    sourceId: string | null = null
  ): Promise<number> {
    return this.keyRepairRepo!.logKeyRepairAttemptAsync(nodeNum, nodeName, action, success, oldKeyFragment, newKeyFragment, sourceId);
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
    return this.keyRepairRepo!.getKeyRepairLogAsync(limit, sourceId);
  }

  // Distance delete log methods moved to DistanceDeleteLogRepository (databaseService.distanceDeleteLog.getDistanceDeleteLog / addDistanceDeleteLogEntry)





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




  // Get all nodes with their telemetry types (async version)
  async getAllNodesTelemetryTypesAsync(sourceId?: string): Promise<Map<string, string[]>> {
    const now = Date.now();
    const cacheKey = sourceId ?? DatabaseService.TELEMETRY_TYPES_CACHE_GLOBAL_KEY;
    const cached = this.telemetryTypesCacheBySource.get(cacheKey);

    // Return cached result if still valid
    if (cached && now - cached.time < DatabaseService.TELEMETRY_TYPES_CACHE_TTL_MS) {
      return cached.map;
    }

    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const map = await this.telemetry.getAllNodesTelemetryTypes(sourceId ?? ALL_SOURCES); // undefined = global cache key — intentional cross-source
      this.telemetryTypesCacheBySource.set(cacheKey, { map, time: Date.now() });
      return map;
    }

    // SQLite: query the database and update cache
    const map = this.telemetry.getAllNodesTelemetryTypesSync();
    this.telemetryTypesCacheBySource.set(cacheKey, { map, time: now });
    return map;
  }

  // Invalidate the telemetry types cache (call when new telemetry is inserted
  // or rows are bulk-purged). When sourceId is provided, only that source's
  // cache slot is cleared (plus the global '__global__' slot, since its
  // contents are derived from the union of all sources). When omitted, the
  // whole map is cleared.
  invalidateTelemetryTypesCache(sourceId?: string): void {
    if (!sourceId) {
      this.telemetryTypesCacheBySource.clear();
      return;
    }
    this.telemetryTypesCacheBySource.delete(sourceId);
    this.telemetryTypesCacheBySource.delete(DatabaseService.TELEMETRY_TYPES_CACHE_GLOBAL_KEY);
  }




  /**
   * Purge all telemetry data (async version), optionally scoped to one source.
   */
  async purgeAllTelemetryAsync(sourceId?: string): Promise<void> {
    logger.debug(`⚠️ PURGING ${sourceId ? `source ${sourceId}'s ` : 'all '}telemetry from database`);

    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      await this.telemetry.deleteAllTelemetry(sourceId);
      this.invalidateTelemetryTypesCache(sourceId);
      logger.debug('✅ Successfully purged telemetry');
      return;
    }

    this.telemetry.deleteAllTelemetrySync(sourceId);
    this.invalidateTelemetryTypesCache(sourceId);
    logger.debug('✅ Successfully purged telemetry');
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

  /**
   * Synchronous per-source setting read — mirrors
   * `settingsRepo.getSettingForSource()`'s prefix scheme but via the sync
   * `getSetting()` path above, for server singletons (e.g. MessageQueueService)
   * that read settings at call time and cannot await. Returns ONLY the
   * per-source value (null if no override exists) — no fallback to the
   * un-namespaced global key, matching `getSettingForSource`'s semantics
   * (issue #2839: silent cross-source fallback caused automation spam).
   */
  getSettingForSourceSync(sourceId: string | null | undefined, key: string): string | null {
    if (sourceId) {
      return this.getSetting(`source:${sourceId}:${key}`);
    }
    return this.getSetting(key);
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



  // ============ ASYNC NOTIFICATION PREFERENCES METHODS ============

  /**
   * Delete a node and all associated data (scoped to sourceId — Phase 3C2)
   */
  async deleteNodeAsync(nodeNum: number, sourceId: string): Promise<{
    messagesDeleted: number;
    broadcastMessagesDeleted: number;
    traceroutesDeleted: number;
    telemetryDeleted: number;
    nodeDeleted: boolean;
  }> {
    let messagesDeleted = 0;
    let broadcastMessagesDeleted = 0;
    let traceroutesDeleted = 0;
    let telemetryDeleted = 0;
    let nodeDeleted = false;

    try {
      // Delete DMs to/from this node (scoped to this source)
      if (this.messagesRepo) {
        messagesDeleted = await this.messagesRepo.purgeDirectMessages(nodeNum, sourceId);
        // Delete channel broadcasts originated by this node (scoped to this source).
        // Ordering matters: purgeDirectMessages already removed DMs from/to this
        // node, so purgeMessagesFromNode only counts surviving from-node rows —
        // i.e. broadcasts — keeping the two counts disjoint.
        broadcastMessagesDeleted = await this.messagesRepo.purgeMessagesFromNode(nodeNum, sourceId);
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

      // Delete packet log entries for this node (#2637) so Packet Monitor
      // doesn't keep showing history for a deleted node
      if (this.packetLogRepo) {
        try {
          await this.packetLogRepo.deletePacketLogsForNode(nodeNum, sourceId);
        } catch (err) {
          logger.error(`Failed to delete packet logs for node ${nodeNum}@${sourceId}:`, err);
        }
      }

      // Delete the node itself (scoped to sourceId)
      if (this.nodesRepo) {
        nodeDeleted = await this.nodesRepo.deleteNodeRecord(nodeNum, sourceId);
      }

      // Also remove from cache (scoped lookup)
      this.nodeCache.delete(nodeNum, sourceId);

      logger.debug(`Deleted node ${nodeNum}@${sourceId}: messages=${messagesDeleted}, broadcastMessages=${broadcastMessagesDeleted}, traceroutes=${traceroutesDeleted}, telemetry=${telemetryDeleted}, node=${nodeDeleted}`);
    } catch (error) {
      logger.error(`Error deleting node ${nodeNum}@${sourceId}:`, error);
      throw error;
    }

    return { messagesDeleted, broadcastMessagesDeleted, traceroutesDeleted, telemetryDeleted, nodeDeleted };
  }

  /**
   * Delete nodes for a source whose last-known position is outside the bbox.
   * Surgical alternative to purgeAllNodesAsync — keeps inside-bbox nodes and
   * nodes without recorded position. Returns the number of rows deleted.
   *
   * Powers the "Prune Outside ROI" kebab action on mqtt_bridge sources.
   */
  async pruneNodesOutsideBboxAsync(
    sourceId: string,
    bbox: { minLat?: number; maxLat?: number; minLng?: number; maxLng?: number },
  ): Promise<number> {
    if (!this.nodesRepo) throw new Error('Nodes repository not initialized');
    return this.nodesRepo.pruneNodesOutsideBbox(sourceId, bbox);
  }

  /**
   * Purge all nodes and related data (async version).
   * When sourceId is provided, scope to that source only.
   */
  async purgeAllNodesAsync(sourceId?: string): Promise<void> {
    logger.debug(`⚠️ PURGING ${sourceId ? `source ${sourceId}'s ` : 'all '}nodes and related data from database (async)`);

    try {
      // Delete in order to respect foreign key constraints
      // First delete all child records that reference nodes
      if (this.messagesRepo) {
        await this.messagesRepo.deleteAllMessages(sourceId);
      }
      if (this.telemetryRepo) {
        await this.telemetryRepo.deleteAllTelemetry(sourceId);
      }
      if (this.traceroutesRepo) {
        await this.traceroutesRepo.deleteAllTraceroutes(sourceId);
        // undefined sourceId = admin global purge across every source — intentional cross-source
        await this.traceroutesRepo.deleteAllRouteSegments(sourceId ?? ALL_SOURCES);
      }
      if (this.neighborsRepo) {
        await this.neighborsRepo.deleteAllNeighborInfo(sourceId);
      }
      // Clear packet log so Packet Monitor doesn't show ghost entries from purged nodes (issue #2637)
      if (this.packetLogRepo) {
        try {
          await this.packetLogRepo.clearPacketLogs(sourceId);
        } catch (err) {
          logger.error('Failed to clear packet logs during purge:', err);
        }
      }
      // Clear ATAK contacts so a deleted/purged source's contacts don't linger (#3691 Phase 2)
      if (this.atakContactsRepo) {
        try {
          if (sourceId) {
            await this.atakContactsRepo.deleteContactsForSource(sourceId);
          } else {
            // undefined sourceId = admin global purge across every source — intentional cross-source
            const atakSourceIds = await this.atakContactsRepo.getContactSourceIds();
            for (const atakSourceId of atakSourceIds) {
              await this.atakContactsRepo.deleteContactsForSource(atakSourceId);
            }
          }
        } catch (err) {
          logger.error('Failed to purge ATAK contacts during purge:', err);
        }
      }
      // Finally delete the nodes themselves
      if (this.nodesRepo) {
        await this.nodesRepo.deleteAllNodes(sourceId);
      }

      // Clear the cache (scoped if a sourceId was provided)
      if (sourceId) {
        for (const key of Array.from(this.nodeCache.keys())) {
          const cached = this.nodeCache.rawGet(key);
          if (cached && (cached as any).sourceId === sourceId) {
            this.nodeCache.deleteByKey(key);
          }
        }
      } else {
        this.nodeCache.clear();
      }

      logger.debug('✅ Successfully purged nodes and related data (async)');
    } catch (error) {
      logger.error('Error purging nodes:', error);
      throw error;
    }
  }


  /**
   * Async version of insertRouteSegment — awaits the repository insert directly
   * so callers can surface/await failures instead of fire-and-forget.
   */
  async insertRouteSegmentAsync(segmentData: DbRouteSegment, sourceId?: string): Promise<void> {
    await this.traceroutesRepo!.insertRouteSegment(segmentData, sourceId);
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
        this.neighborsRepo.deleteNeighborInfoForNode(nodeNum, ALL_SOURCES).catch(err => // intentional cross-source: legacy facade has no sourceId
          logger.debug('Failed to clear neighbor info:', err)
        );
      }
      return;
    }

    // SQLite: use repo
    if (this.neighborsRepo) {
      this.neighborsRepo.deleteNeighborInfoForNode(nodeNum, ALL_SOURCES).catch(err => // intentional cross-source: legacy facade has no sourceId
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


  getAllNeighborInfo(): DbNeighborInfo[] {
    // All backends: fire async repo refresh, return cached data immediately
    if (this.neighborsRepo) {
      // intentional cross-source: neighbor cache is global across all sources
      this.neighborsRepo.getAllNeighborInfo(ALL_SOURCES).then(neighbors => {
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


  /**
   * Async version of getLatestNeighborInfoPerNodeScoped — queries the repository
   * for the latest neighbor info per node, then filters by sourceId when scoped.
   */
  async getLatestNeighborInfoPerNodeScopedAsync(sourceId?: string): Promise<DbNeighborInfo[]> {
    const all = await this.neighbors.getLatestNeighborInfoPerNode();
    if (!sourceId) return all as unknown as DbNeighborInfo[];
    return (all as any[]).filter((ni: any) => ni.sourceId === sourceId) as unknown as DbNeighborInfo[];
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
  async deleteNeighborInfoForNodeAsync(nodeNum: number, sourceId?: SourceScope): Promise<number> {
    // Clear from cache
    this._neighborsByNodeCache.delete(nodeNum);
    this._neighborsCache = this._neighborsCache.filter(n => n.nodeNum !== nodeNum);

    // Count then delete from database (scoped to the requested source)
    const count = await this.neighbors.getNeighborCountForNode(nodeNum, sourceId);
    await this.neighbors.deleteNeighborInfoForNode(nodeNum, sourceId);
    logger.info(`Deleted ${count} neighbor records for node ${nodeNum}`);
    return count;
  }

  // Favorite operations (scoped to sourceId — Phase 3C2)
  setNodeFavorite(nodeNum: number, isFavorite: boolean, sourceId: string, favoriteLocked?: boolean): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodeCache.get(nodeNum, sourceId);
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
      const cachedNode = this.nodeCache.get(nodeNum, sourceId);
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





  /**
   * Set the free-text per-node notes field (issue #3921). MeshMonitor-local
   * annotation — never synced to the mesh. An empty string clears the note.
   * Uses the Drizzle-based repository setter for every backend (no raw SQL).
   */
  async setNodeNotesAsync(nodeNum: number, notes: string, sourceId: string): Promise<void> {
    const now = Date.now();

    if (!this.nodesRepo) {
      throw new Error('Nodes repository is not initialized');
    }

    // Persist via the repository (Drizzle — works for SQLite/PostgreSQL/MySQL).
    await this.nodesRepo.setNodeNotes(nodeNum, notes, sourceId);

    // Keep the in-memory cache consistent for sync readers.
    const cached = this.nodeCache.get(nodeNum, sourceId);
    if (cached) {
      cached.notes = notes;
      cached.updatedAt = now;
    }

    logger.debug(`📝 Node ${nodeNum}@${sourceId} notes updated (${notes.length} chars)`);
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



  async markMessageAsReadAsync(messageId: string, userId: number | null): Promise<void> {
    if (!userId) return;
    return this.notifications.markMessagesAsReadByIds([messageId], userId);
  }

  async markMessagesAsReadAsync(messageIds: string[], userId: number | null): Promise<void> {
    if (!userId || messageIds.length === 0) return;
    return this.notifications.markMessagesAsReadByIds(messageIds, userId);
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



  /**
   * Async version of getUnreadCountsByChannel for PostgreSQL/MySQL.
   * Delegates to NotificationsRepository for Drizzle-based execution on all backends.
   */
  async getUnreadCountsByChannelAsync(userId: number | null, localNodeId?: string, sourceId?: SourceScope, excludeMqtt?: boolean): Promise<{[channelId: number]: number}> {
    // For SQLite, use sync version (legacy compatibility).
    // The raw-SQL sync twin binds sourceId as a parameter, so the ALL_SOURCES
    // symbol must be normalized to undefined (its legacy "all sources" spelling).
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      const sid = typeof sourceId === 'string' ? sourceId : undefined;
      // Only count incoming messages (exclude messages sent by our node) and
      // optionally scope to a single source so multi-source views don't bleed
      // counts from other sources into this tab.
      const fromClause = localNodeId ? 'AND m.fromNodeId != ?' : '';
      const sourceClause = sid ? 'AND m.sourceId = ?' : '';
      const mqttClause = excludeMqtt ? 'AND (m.viaMqtt IS NULL OR m.viaMqtt = 0)' : '';
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare(`
        SELECT m.channel, COUNT(*) as count
        FROM messages m
        LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
        WHERE rm.message_id IS NULL
          AND m.channel != -1
          AND m.portnum = 1
          ${fromClause}
          ${sourceClause}
          ${mqttClause}
        GROUP BY m.channel
      `);

      const params: any[] = [];
      if (userId !== null) params.push(userId);
      if (localNodeId) params.push(localNodeId);
      if (sid) params.push(sid);

      const rows = stmt.all(...params) as Array<{ channel: number; count: number }>;
      const counts: {[channelId: number]: number} = {};
      rows.forEach(row => { counts[row.channel] = Number(row.count); });
      return counts;
    }
    if (!this.notificationsRepo) return {};
    return this.notificationsRepo.getUnreadCountsByChannelAsync(userId, localNodeId, sourceId, excludeMqtt);
  }



  /**
   * Async version of getBatchUnreadDMCounts for PostgreSQL/MySQL support.
   * Delegates to NotificationsRepository for Drizzle-based execution on all backends.
   */
  async getBatchUnreadDMCountsAsync(localNodeId: string, userId: number | null, sourceId?: SourceScope): Promise<{ [fromNodeId: string]: number }> {
    // For SQLite, use sync version.
    // The raw-SQL sync twin binds sourceId as a parameter, so the ALL_SOURCES
    // symbol must be normalized to undefined (its legacy "all sources" spelling).
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      const sid = typeof sourceId === 'string' ? sourceId : undefined;
      const sourceClause = sid ? 'AND m.sourceId = ?' : '';
      // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
      const stmt = this.db.prepare(`
        SELECT m.fromNodeId, COUNT(*) as count
        FROM messages m
        LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
        WHERE rm.message_id IS NULL
          AND m.portnum = 1
          AND m.channel = -1
          AND m.toNodeId = ?
          ${sourceClause}
        GROUP BY m.fromNodeId
      `);

      const params: any[] = [];
      if (userId !== null) params.push(userId);
      params.push(localNodeId);
      if (sid) params.push(sid);

      const rows = stmt.all(...params) as { fromNodeId: string; count: number }[];
      const result: { [fromNodeId: string]: number } = {};
      for (const row of rows) { result[row.fromNodeId] = Number(row.count); }
      return result;
    }
    if (!this.notificationsRepo) return {};
    return this.notificationsRepo.getBatchUnreadDMCountsAsync(localNodeId, userId, sourceId);
  }

  cleanupOldReadMessages(days: number): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare('DELETE FROM read_messages WHERE read_at < ?');
    const result = stmt.run(cutoff);
    logger.debug(`🧹 Cleaned up ${result.changes} read_messages entries older than ${days} days`);
    return Number(result.changes);
  }


  // Packet Log operations — delegated to PacketLogRepository (this.packetLog)
  // Sync methods retain SQLite fallbacks for test compatibility and pre-init callers.

  async insertPacketLogAsync(packet: Omit<DbPacketLog, 'id' | 'created_at'>): Promise<number> {
    const enabled = await this.getSettingAsync('packet_log_enabled');
    if (enabled !== '1') return 0;

    // All backends route through PacketLogRepository
    const id = await this.packetLog.insertPacketLog(packet, packet.sourceId ?? undefined);
    const maxCountStr = this.drizzleDbType === 'sqlite'
      ? this.getSetting('packet_log_max_count')
      : await this.getSettingAsync('packet_log_max_count');
    const maxCount = maxCountStr ? parseInt(maxCountStr, 10) : 1000;
    await this.packetLog.enforcePacketLogMaxCount(maxCount);
    return id;
  }

  async getPacketLogsAsync(options: {
    offset?: number; limit?: number; portnum?: number; from_node?: number;
    to_node?: number; channel?: number; encrypted?: boolean; since?: number;
    relay_node?: number | 'unknown'; transport_mechanism?: number; sourceId?: string;
    untilTs?: number; untilId?: number;
  }): Promise<DbPacketLog[]> {
    return this.packetLog.getPacketLogs(options);
  }

  /**
   * Return distinct sourceIds for encrypted, not-yet-server-decrypted rows of
   * `packet_log`. Consumed by the channel-database retroactive-decrypt
   * permission pre-flight to enforce per-source `messages:read` ACL before
   * any decrypted payload is written back to packet_log.
   *
   * A `null` element represents the legacy pre-multi-source default-source
   * bucket (rows with `sourceId IS NULL`).
   */
  async getDistinctEncryptedPacketSourceIdsAsync(): Promise<Array<string | null>> {
    return this.packetLog.getDistinctEncryptedPacketSourceIds();
  }

  async getPacketLogByIdAsync(id: number): Promise<DbPacketLog | null> {
    return this.packetLog.getPacketLogById(id);
  }

  async getPacketLogCountAsync(options: {
    portnum?: number; from_node?: number; to_node?: number; channel?: number;
    encrypted?: boolean; since?: number; relay_node?: number | 'unknown';
    transport_mechanism?: number; sourceId?: string;
  } = {}): Promise<number> {
    return this.packetLog.getPacketLogCount(options);
  }


  async clearPacketLogsAsync(): Promise<number> {
    if (this.packetLogRepo) return this.packetLogRepo.clearPacketLogs();
    return 0;
  }

  async getDistinctRelayNodesAsync(sourceId?: string): Promise<DbDistinctRelayNode[]> {
    return this.packetLog.getDistinctRelayNodes(sourceId);
  }

  async updatePacketLogDecryptionAsync(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    return this.packetLogRepo!.updatePacketLogDecryption(id, decryptedBy, decryptedChannelId, portnum, metadata);
  }


  async cleanupOldPacketLogsAsync(): Promise<number> {
    if (!this.packetLogRepo) return 0;
    const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
    const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
    return this.packetLogRepo.cleanupOldPacketLogs(maxAgeHours);
  }

  async getPacketCountsByNodeAsync(options?: { since?: number; limit?: number; portnum?: number; sourceId?: string }): Promise<DbPacketCountByNode[]> {
    return this.packetLog.getPacketCountsByNode(options);
  }

  async getPacketCountsByPortnumAsync(options?: { since?: number; from_node?: number; sourceId?: string }): Promise<DbPacketCountByPortnum[]> {
    return this.packetLog.getPacketCountsByPortnum(options);
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

      // Run migrations from the registry — 001 baseline creates all tables.
      // Migrations 002+ are guarded by the ledger so they run exactly once
      // (#4233); 001 has no settingsKey and always runs (it is the
      // CREATE TABLE IF NOT EXISTS baseline that creates `settings` itself).
      await runLedgeredMigrations({
        backend: 'PostgreSQL',
        handle: client,
        migrations: registry.getAll(),
        pick: m => m.postgres,
        readApplied: readAppliedMigrationsPostgres,
        markApplied: markMigrationAppliedPostgres,
      });

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

    // Run migrations from the registry — 001 baseline creates all tables.
    // Migrations 002+ are guarded by the ledger so they run exactly once
    // (#4233); 001 has no settingsKey and always runs.
    await runLedgeredMigrations({
      backend: 'MySQL',
      handle: pool,
      migrations: registry.getAll(),
      pick: m => m.mysql,
      readApplied: readAppliedMigrationsMysql,
      markApplied: markMigrationAppliedMysql,
    });

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
    return this.newsCache.saveNewsCache({
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
    const status = await this.newsCache.getUserNewsStatus(userId);
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
    return this.newsCache.saveUserNewsStatus({
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
    return this.backupHistory.insertBackupHistory({
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
    const stats = await this.backupHistory.getBackupStats();
    return {
      count: stats.count,
      totalSize: stats.totalSize,
      oldestBackup: stats.oldestTimestamp ? new Date(stats.oldestTimestamp).toISOString() : null,
      newestBackup: stats.newestTimestamp ? new Date(stats.newestTimestamp).toISOString() : null,
    };
  }

  // ============ AUTO TIME SYNC SETTINGS ============


  /**
   * Enable or disable auto time sync
   */
  setAutoTimeSyncEnabled(enabled: boolean): void {
    this.setSetting('autoTimeSyncEnabled', enabled ? 'true' : 'false');
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
    const nodeNums = await this.timeSync.getAutoTimeSyncNodes(sourceId);
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
        await this.timeSync.setAutoTimeSyncNodes(settings.nodeNums, sourceId);
      }
      logger.debug(`✅ Updated per-source time sync filter settings (source=${sourceId})`);
      return;
    }

    if (settings.enabled !== undefined) {
      this.setAutoTimeSyncEnabled(settings.enabled);
    }
    if (settings.nodeNums !== undefined) {
      await this.timeSync.setAutoTimeSyncNodes(settings.nodeNums, sourceId);
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
      filterNodeNums = await this.timeSync.getAutoTimeSyncNodes(sourceId);
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
   * Get user's map preferences - delegates to MapPreferencesRepository (Drizzle ORM)
   */
  async getMapPreferencesAsync(userId: number): Promise<Record<string, any> | null> {
    return this.mapPreferences!.getMapPreferences(userId);
  }

  /**
   * Save user's map preferences - delegates to MapPreferencesRepository (Drizzle ORM)
   */
  async saveMapPreferencesAsync(userId: number, preferences: {
    mapTileset?: string | null;
    mapTilesetLight?: string | null;
    mapTilesetDark?: string | null;
    showPaths?: boolean;
    showNeighborInfo?: boolean;
    showRoute?: boolean;
    showMotion?: boolean;
    showMqttNodes?: boolean;
    showUdpNodes?: boolean;
    showRfNodes?: boolean;
    showMeshCoreNodes?: boolean;
    showWaypoints?: boolean;
    showAnimations?: boolean;
    showAccuracyRegions?: boolean;
    showEstimatedPositions?: boolean;
    positionHistoryHours?: number | null;
    mapMaxAgeHours?: number | null;
    positionHistoryPointsOnly?: boolean;
  }): Promise<void> {
    return this.mapPreferences!.saveMapPreferences(userId, preferences);
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
    return this.messagesRepo!.cleanupOldMessagesSqlite(days);
  }

  async cleanupOldTraceroutesAsync(days: number = 30): Promise<number> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      return this.traceroutesRepo.cleanupOldTraceroutes(days * 24);
    }
    return this.traceroutesRepo!.cleanupOldTraceroutesSync(days);
  }

  async cleanupOldRouteSegmentsAsync(days: number = 30): Promise<number> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      return this.traceroutesRepo.cleanupOldRouteSegments(days, ALL_SOURCES); // intentional cross-source: scheduled cleanup spans every source
    }
    return this.traceroutesRepo!.cleanupOldRouteSegmentsSync(days);
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
    return this.nodesRepo!.cleanupInactiveNodes(days);
  }

  async cleanupInvalidChannelsAsync(sourceId?: string): Promise<number> {
    if (sourceId) {
      // Channels with no name and no PSK scoped to a source
      return this.channelsRepo!.cleanupEmptyChannelsForSource(sourceId);
    }
    return this.channelsRepo!.cleanupInvalidChannels();
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
    logger.info('🧹 Running VACUUM on database...');
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    this.db.exec('VACUUM');
    logger.info('✅ VACUUM complete');
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
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()');
    const result = stmt.get() as { size: number } | undefined;
    return result?.size ?? 0;
  }

  // Group 2: Messages
  async getMessagesByChannelAsync(channel: number, limit: number = 100, offset: number = 0): Promise<DbMessage[]> {
    if (this.messagesRepo) {
      // intentional cross-source: legacy facade has no sourceId
      const rows = await this.messagesRepo.getMessagesByChannel(channel, limit, offset, ALL_SOURCES);
      return rows.map(msg => this.convertRepoMessage(msg));
    }
    return [];
  }

  async markAllDMMessagesAsReadAsync(localNodeId: string, userId: number | null): Promise<number> {
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.notificationsRepo) {
        this.notificationsRepo.markAllDMMessagesAsRead(localNodeId, userId).catch((error) => {
          logger.debug(`[DatabaseService] Mark all DM messages as read failed: ${error}`);
        });
      }
      return 0; // Return 0 since we don't wait for the async result
    }
    // INSERT OR REPLACE — see markChannelMessagesAsRead for rationale.
    const query = `
      INSERT OR REPLACE INTO read_messages (message_id, user_id, read_at)
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

  async markChannelMessagesAsReadAsync(channelId: number, userId: number | null, beforeTimestamp?: number, sourceId?: string): Promise<number> {
    logger.info(`[DatabaseService] markChannelMessagesAsRead called: channel=${channelId}, userId=${userId}, sourceId=${sourceId ?? 'all'}, dbType=${this.drizzleDbType}`);
    // For PostgreSQL/MySQL, use async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.notificationsRepo) {
        this.notificationsRepo.markChannelMessagesAsRead(channelId, userId, beforeTimestamp, sourceId)
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
    // SQLite read_messages PK is message_id only — using INSERT OR IGNORE
    // strands rows owned by an earlier user/anonymous session because the
    // join in unread queries filters by user_id. INSERT OR REPLACE rewrites
    // the row to the current reader so subsequent unread checks for that
    // user actually find their read marker.
    let query = `
      INSERT OR REPLACE INTO read_messages (message_id, user_id, read_at)
      SELECT id, ?, ? FROM messages
      WHERE channel = ?
        AND portnum = 1
    `;
    const params: any[] = [userId, Date.now(), channelId];

    // Source scope (#3712): without this, marking a slot read on one source
    // also marks the same slot read on every other source (e.g. an MQTT bridge
    // and a radio source both using slot 2).
    if (sourceId) {
      query += ` AND sourceId = ?`;
      params.push(sourceId);
    }

    if (beforeTimestamp !== undefined) {
      query += ` AND timestamp <= ?`;
      params.push(beforeTimestamp);
    }

    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(query);
    const result = stmt.run(...params);
    return Number(result.changes);
  }

  async markDMMessagesAsReadAsync(localNodeId: string, remoteNodeId: string, userId: number | null, beforeTimestamp?: number): Promise<number> {
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
    // INSERT OR REPLACE — see markChannelMessagesAsRead for rationale.
    let query = `
      INSERT OR REPLACE INTO read_messages (message_id, user_id, read_at)
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


  async setNodeIgnoredAsync(nodeNum: number, isIgnored: boolean, sourceId: string): Promise<void> {
    // Get the node info for the persistent ignore list
    const node = await this.nodes.getNode(nodeNum, sourceId) as unknown as DbNode | null;
    const nodeId = node?.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;

    // Persist to/remove from the per-source ignored_nodes table (migration 048).
    if (isIgnored) {
      await this.ignoredNodes.addIgnoredNodeAsync(
        nodeNum, sourceId, nodeId, node?.longName, node?.shortName
      );
    } else {
      await this.ignoredNodes.removeIgnoredNodeAsync(nodeNum, sourceId);
    }

    // Update the node row (isIgnored flag) + in-memory cache for all dialects.
    await this.nodes.setNodeIgnored(nodeNum, isIgnored, sourceId);

    logger.debug(`${isIgnored ? '🚫' : '✅'} Node ${nodeNum}@${sourceId} ignored status set to: ${isIgnored}`);
  }

  async getNodePositionOverrideAsync(nodeNum: number, sourceId: string): Promise<{
    enabled: boolean;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    isPrivate?: boolean;
  } | null> {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const node = this.nodeCache.get(nodeNum, sourceId);
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

  async setNodePositionOverrideAsync(
    nodeNum: number,
    enabled: boolean,
    sourceId: string,
    latitude?: number,
    longitude?: number,
    altitude?: number,
    isPrivate: boolean = false
  ): Promise<void> {
    const now = Date.now();

    // For PostgreSQL/MySQL, use cache and async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const existingNode = this.nodeCache.get(nodeNum, sourceId);
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

      // Fire and forget async update — pass sourceId explicitly so the upsert targets
      // the live-source row (see issue #2902). Without this the repository fell back to
      // 'default', creating a stray row that the map never reads from.
      if (this.nodesRepo) {
        this.nodesRepo.upsertNode(existingNode, sourceId).catch(err => {
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

  async clearNodePositionOverrideAsync(nodeNum: number, sourceId: string): Promise<void> {
    await this.setNodePositionOverrideAsync(nodeNum, false, sourceId);
  }

  async setNodeHideFromMapAsync(nodeNum: number, hidden: boolean, sourceId: string): Promise<void> {
    const now = Date.now();

    // For PostgreSQL/MySQL, use cache and async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const existingNode = this.nodeCache.get(nodeNum, sourceId);
      if (!existingNode) {
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.warn(`⚠️ Failed to update hideFromMap for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in cache`);
        throw new Error(`Node ${nodeId} not found`);
      }

      existingNode.hideFromMap = hidden;
      existingNode.updatedAt = now;

      if (this.nodesRepo) {
        this.nodesRepo.upsertNode(existingNode, sourceId).catch(err => {
          logger.error('Failed to update hideFromMap:', err);
        });
      }

      logger.debug(`🗺️ Node ${nodeNum}@${sourceId} hideFromMap ${hidden ? 'enabled' : 'disabled'}`);
      return;
    }

    // SQLite path
    // eslint-disable-next-line no-restricted-syntax -- legacy raw SQL, pending future Drizzle migration batch
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        hideFromMap = ?,
        updatedAt = ?
      WHERE nodeNum = ? AND sourceId = ?
    `);
    const result = stmt.run(hidden ? 1 : 0, now, nodeNum, sourceId);

    if (result.changes === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update hideFromMap for node ${nodeId} (${nodeNum}) source ${sourceId}: node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    // Keep the in-memory cache consistent for sync readers.
    const cached = this.nodeCache.get(nodeNum, sourceId);
    if (cached) {
      cached.hideFromMap = hidden;
      cached.updatedAt = now;
    }

    logger.debug(`🗺️ Node ${nodeNum}@${sourceId} hideFromMap ${hidden ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set `hideFromMap` across EVERY source's row for this nodeNum (issue #4137).
   * Used when toggling map visibility from a unified/cross-source view, where
   * "un-hide" needs to converge every source's row — not just the single
   * winning row that mergeNodesAcrossSources happened to pick — or a stale
   * `true` on another source keeps the node hidden in the unified view forever.
   * Delegates to the Drizzle-based NodesRepository so it works identically
   * across SQLite/PostgreSQL/MySQL (unlike the per-source method above, which
   * still branches on backend for legacy reasons).
   */
  async setNodeHideFromMapAllSourcesAsync(nodeNum: number, hidden: boolean): Promise<number> {
    if (!this.nodesRepo) {
      throw new Error('Nodes repository not initialized');
    }

    const affected = await this.nodesRepo.setNodeHideFromMapAllSourcesAsync(nodeNum, hidden);

    if (affected === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update hideFromMap (all sources) for node ${nodeId} (${nodeNum}): node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`🗺️ Node ${nodeNum} hideFromMap ${hidden ? 'enabled' : 'disabled'} across ${affected} source row(s) (#4137)`);
    return affected;
  }

  async handleAutoWelcomeEnabledAsync(): Promise<number> {
    const migrationKey = 'auto_welcome_first_enabled';
    const migrationCompleted = this.getSetting(migrationKey);

    // If migration already ran, don't run it again
    if (migrationCompleted === 'completed') {
      logger.debug('✅ Auto-welcome first-enable migration already completed');
      return 0;
    }

    logger.info('👋 Auto-welcome enabled for the first time - marking existing nodes as welcomed...');
    const markedCount = await this.nodes.markAllNodesAsWelcomed();

    if (markedCount > 0) {
      logger.info(`✅ Marked ${markedCount} existing node(s) as welcomed to prevent spam`);
    } else {
      logger.debug('No existing nodes to mark as welcomed');
    }

    // Mark migration as completed so it doesn't run again
    this.setSetting(migrationKey, 'completed');
    return markedCount;
  }

  async markAllNodesAsWelcomedAsync(sourceId?: string | null): Promise<number> {
    return this.nodes.markAllNodesAsWelcomed(sourceId ?? null);
  }

  // Group 4: Traceroutes
  async recordTracerouteRequestAsync(fromNodeNum: number, toNodeNum: number, sourceId?: string): Promise<void> {
    await this.recordTracerouteRequest(fromNodeNum, toNodeNum, sourceId);
  }

  async clearRecordHolderSegmentAsync(sourceId?: string): Promise<void> {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        await this.traceroutesRepo.clearRecordHolderBySource(sourceId);
      }
      logger.debug('🗑️ Cleared record holder route segment');
      return;
    }
    this.traceroutesRepo!.clearRecordHolderSegmentSync(sourceId);
    logger.debug('🗑️ Cleared record holder route segment');
  }

  async updateRecordHolderSegmentAsync(segment: DbRouteSegment, sourceId?: string): Promise<void> {
    if (!this.traceroutesRepo) return;
    const currentRecord = await this.traceroutesRepo.getRecordHolderRouteSegment(sourceId);
    if (!currentRecord || segment.distanceKm > currentRecord.distanceKm) {
      await this.traceroutesRepo.clearRecordHolderBySource(sourceId);
      await this.traceroutesRepo.insertRouteSegment({ ...segment, isRecordHolder: true }, sourceId);
      logger.debug(`🏆 New record holder route segment: ${segment.distanceKm.toFixed(2)} km from ${segment.fromNodeId} to ${segment.toNodeId}`);
    }
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
    if (!this.telemetryRepo) {
      return [];
    }
    const actualIntervalMinutes = intervalMinutes ?? computeAveragingIntervalMinutes(maxHours);

    // PostgreSQL/MySQL: run the averaged query asynchronously against the
    // backend (previously these dialects fell through to a raw newest-N fetch
    // with no averaging, which truncated long windows to ~the last few hours
    // on chatty nodes). SQLite continues to use the synchronous repo helper.
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const rows = await this.telemetryRepo.getTelemetryByNodeAveragedSql(
        nodeId,
        sinceTimestamp,
        actualIntervalMinutes,
        maxHours,
        sourceId
      );
      return rows.map(t => this.normalizeBigInts(t));
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

  // Group 6: Ghost Nodes (in-memory, but async-compatible wrappers)
  async getSuppressedGhostNodesAsync(): Promise<Array<{ nodeNum: number; nodeId: string; expiresAt: number; remainingMs: number }>> {
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

  async suppressGhostNodeAsync(nodeNum: number, durationMs: number = 30 * 60 * 1000): Promise<void> {
    const expiresAt = Date.now() + durationMs;
    this.suppressedGhostNodes.set(nodeNum, expiresAt);
    logger.info(`👻 Suppressed ghost node !${nodeNum.toString(16).padStart(8, '0')} for ${Math.round(durationMs / 60000)} minutes`);
  }

  async unsuppressGhostNodeAsync(nodeNum: number): Promise<void> {
    if (this.suppressedGhostNodes.delete(nodeNum)) {
      logger.info(`👻 Unsuppressed ghost node !${nodeNum.toString(16).padStart(8, '0')}`);
    }
  }

  async isNodeSuppressedAsync(nodeNum: number | undefined | null): Promise<boolean> {
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

  // Group 8: Export/Import
  async exportDataAsync(): Promise<{ nodes: DbNode[]; messages: DbMessage[] }> {
    return {
      nodes: await this.nodes.getAllNodes(ALL_SOURCES) as unknown as DbNode[], // intentional cross-source: full backup export spans all sources
      messages: await this.messages.getMessages(10000, 0, ALL_SOURCES) as unknown as DbMessage[] // Export last 10k messages across all sources
    };
  }

  async importDataAsync(data: { nodes: DbNode[]; messages: DbMessage[] }): Promise<void> {
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
}

// Export the class for testing purposes (allows creating isolated test instances)
export { DatabaseService };

export default new DatabaseService();
