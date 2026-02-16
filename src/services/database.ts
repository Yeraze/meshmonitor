import BetterSqlite3Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import path from 'path';
import fs from 'fs';
import { calculateDistance } from '../utils/distance.js';
import { logger } from '../utils/logger.js';
import { getPortNumName } from '../server/constants/meshtastic.js';
import { getEnvironmentConfig } from '../server/config/environment.js';
import { UserModel } from '../server/models/User.js';
import { PermissionModel } from '../server/models/Permission.js';
import { APITokenModel } from '../server/models/APIToken.js';
import { migration as authMigration } from '../server/migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../server/migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../server/migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../server/migrations/004_add_traceroute_permission.js';
import { migration as auditLogMigration } from '../server/migrations/005_enhance_audit_log.js';
import { migration as auditPermissionMigration } from '../server/migrations/006_add_audit_permission.js';
import { migration as readMessagesMigration } from '../server/migrations/007_add_read_messages.js';
import { migration as pushSubscriptionsMigration } from '../server/migrations/008_add_push_subscriptions.js';
import { migration as notificationPreferencesMigration } from '../server/migrations/009_add_notification_preferences.js';
import { migration as notifyOnEmojiMigration } from '../server/migrations/010_add_notify_on_emoji.js';
import { migration as packetLogMigration } from '../server/migrations/011_add_packet_log.js';
import { migration as inactiveNodeNotificationMigration } from '../server/migrations/032_add_notify_on_inactive_node.js';
import { migration as channelRoleMigration } from '../server/migrations/012_add_channel_role_and_position.js';
import { migration as backupTablesMigration } from '../server/migrations/013_add_backup_tables.js';
import { migration as messageDeliveryTrackingMigration } from '../server/migrations/014_add_message_delivery_tracking.js';
import { migration as autoTracerouteFilterMigration } from '../server/migrations/015_add_auto_traceroute_filter.js';
import { migration as securityPermissionMigration } from '../server/migrations/016_add_security_permission.js';
import { migration as channelColumnMigration } from '../server/migrations/017_add_channel_to_nodes.js';
import { migration as mobileMigration } from '../server/migrations/018_add_mobile_to_nodes.js';
import { migration as solarEstimatesMigration } from '../server/migrations/019_add_solar_estimates.js';
import { migration as positionPrecisionMigration } from '../server/migrations/020_add_position_precision_tracking.js';
import { migration as systemBackupTableMigration } from '../server/migrations/021_add_system_backup_table.js';
import { migration as customThemesMigration } from '../server/migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../server/migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../server/migrations/024_add_per_channel_permissions.js';
import { migration as apiTokensMigration } from '../server/migrations/025_add_api_tokens.js';
import { migration as cascadeForeignKeysMigration } from '../server/migrations/028_add_cascade_to_foreign_keys.js';
import { migration as userMapPreferencesMigration } from '../server/migrations/030_add_user_map_preferences.js';
import { migration as isIgnoredMigration } from '../server/migrations/033_add_is_ignored_to_nodes.js';
import { migration as notifyOnServerEventsMigration } from '../server/migrations/034_add_notify_on_server_events.js';
import { migration as prefixWithNodeNameMigration } from '../server/migrations/035_add_prefix_with_node_name.js';
import { migration as perUserAppriseUrlsMigration } from '../server/migrations/036_add_per_user_apprise_urls.js';
import { migration as notifyOnMqttMigration } from '../server/migrations/037_add_notify_on_mqtt.js';
import { migration as recalculateEstimatedPositionsMigration } from '../server/migrations/038_recalculate_estimated_positions.js';
import { migration as recalculateEstimatedPositionsFixMigration } from '../server/migrations/039_recalculate_estimated_positions_fix.js';
import { migration as positionOverrideMigration } from '../server/migrations/040_add_position_override_to_nodes.js';
import { migration as autoTracerouteLogMigration } from '../server/migrations/041_add_auto_traceroute_log.js';
import { migration as relayNodePacketLogMigration } from '../server/migrations/042_add_relay_node_to_packet_log.js';
import { migration as positionOverridePrivacyMigration } from '../server/migrations/043_add_position_override_privacy.js';
import { migration as nodesPrivatePermissionMigration } from '../server/migrations/044_add_nodes_private_permission.js';
import { migration as packetDirectionMigration } from '../server/migrations/045_add_packet_direction.js';
import { migration as autoKeyRepairMigration } from '../server/migrations/046_add_auto_key_repair.js';
import { migration as positionOverrideBooleanMigration, runMigration047Postgres, runMigration047Mysql } from '../server/migrations/047_fix_position_override_boolean_types.js';
import { migration as autoTracerouteColumnMigration } from '../server/migrations/048_fix_auto_traceroute_column_name.js';
import { migration as notificationChannelSettingsMigration, runMigration049Postgres, runMigration049Mysql } from '../server/migrations/049_add_notification_channel_settings.js';
import { migration as channelDatabaseMigration, runMigration050Postgres, runMigration050Mysql } from '../server/migrations/050_add_channel_database.js';
import { migration as decryptedByMessagesMigration, runMigration051Postgres, runMigration051Mysql } from '../server/migrations/051_add_decrypted_by_to_messages.js';
import { migration as upgradeHistorySchemaMigration, runMigration052Postgres, runMigration052Mysql } from '../server/migrations/052_fix_upgrade_history_schema.js';
import { migration as viewOnMapPermissionMigration, runMigration053Postgres, runMigration053Mysql } from '../server/migrations/053_add_view_on_map_permission.js';
import { migration as newsTablesMigration, runMigration054Postgres, runMigration054Mysql } from '../server/migrations/054_add_news_tables.js';
import { migration as remoteAdminColumnsMigration, runMigration055Postgres, runMigration055Mysql } from '../server/migrations/055_add_remote_admin_columns.js';
import { migration as backupHistoryColumnsMigration, runMigration056Postgres, runMigration056Mysql } from '../server/migrations/056_fix_backup_history_columns.js';
import { migration as packetViaMqttMigration, runMigration057Postgres, runMigration057Mysql } from '../server/migrations/057_add_packet_via_mqtt.js';
import { migration as transportMechanismMigration, runMigration058Postgres, runMigration058Mysql } from '../server/migrations/058_convert_via_mqtt_to_transport_mechanism.js';
import { migration as channelDbViewOnMapMigration, runMigration059Postgres, runMigration059Mysql } from '../server/migrations/059_add_channel_database_view_on_map.js';
import { migration as autoTracerouteEnabledMigration, runMigration060Postgres, runMigration060Mysql } from '../server/migrations/060_add_auto_traceroute_enabled_column.js';
import { migration as spamDetectionMigration, runMigration061Postgres, runMigration061Mysql } from '../server/migrations/061_add_spam_detection_columns.js';
import { migration as positionDoublePrecisionMigration, runMigration062Postgres, runMigration062Mysql } from '../server/migrations/062_upgrade_position_precision.js';
import { migration as positionHistoryHoursMigration, runMigration063Postgres, runMigration063Mysql } from '../server/migrations/063_add_position_history_hours.js';
import { migration as enforceNameValidationMigration, runMigration064Postgres, runMigration064Mysql } from '../server/migrations/064_add_enforce_name_validation.js';
import { migration as sortOrderMigration, runMigration065Postgres, runMigration065Mysql } from '../server/migrations/065_add_sortorder_to_channel_database.js';
import { migration as ignoredNodesMigration, runMigration066Postgres, runMigration066Mysql } from '../server/migrations/066_add_ignored_nodes_table.js';
import { migration as autoTimeSyncMigration, runMigration067Postgres, runMigration067Mysql } from '../server/migrations/067_add_auto_time_sync.js';
import { migration as mfaColumnsMigration, runMigration068Postgres, runMigration068Mysql } from '../server/migrations/068_add_mfa_columns.js';
import { migration as traceroutePositionsMigration, runMigration069Postgres, runMigration069Mysql } from '../server/migrations/069_add_traceroute_positions.js';
import { migration as meshcoreTablesMigration, runMigration070Postgres as runMigration070MeshcorePostgres, runMigration070Mysql as runMigration070MeshcoreMysql } from '../server/migrations/070_add_meshcore_tables.js';
import { migration as meshcorePermissionMigration, runMigration071Postgres, runMigration071Mysql } from '../server/migrations/071_add_meshcore_permission.js';
import { migration as dmUnreadIndexMigration, runMigration072Postgres, runMigration072Mysql } from '../server/migrations/072_add_messages_dm_unread_index.js';
import { validateThemeDefinition as validateTheme } from '../utils/themeValidation.js';

// Drizzle ORM imports for dual-database support
import { createSQLiteDriver } from '../db/drivers/sqlite.js';
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
} from '../db/repositories/index.js';
import type { DatabaseType } from '../db/types.js';
import { packetLogPostgres, packetLogMysql, packetLogSqlite } from '../db/schema/packets.js';
import { POSTGRES_SCHEMA_SQL, POSTGRES_TABLE_NAMES } from '../db/schema/postgres-create.js';
import { MYSQL_SCHEMA_SQL, MYSQL_TABLE_NAMES } from '../db/schema/mysql-create.js';

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
  isIgnored?: boolean;
  mobile?: number; // 0 = not mobile, 1 = mobile (moved >100m)
  rebootCount?: number;
  publicKey?: string;
  hasPKC?: boolean;
  lastPKIPacket?: number;
  keyIsLowEntropy?: boolean;
  duplicateKeyDetected?: boolean;
  keyMismatchDetected?: boolean;
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
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface DbPacketLog {
  id?: number;
  packet_id?: number;
  timestamp: number;
  from_node: number;
  from_node_id?: string;
  from_node_longName?: string;
  to_node?: number;
  to_node_id?: string;
  to_node_longName?: string;
  channel?: number;
  portnum: number;
  portnum_name?: string;
  encrypted: boolean;
  snr?: number;
  rssi?: number;
  hop_limit?: number;
  hop_start?: number;
  relay_node?: number;
  payload_size?: number;
  want_ack?: boolean;
  priority?: number;
  payload_preview?: string;
  metadata?: string;
  direction?: 'rx' | 'tx';
  created_at?: number;
  decrypted_by?: 'node' | 'server' | null;
  decrypted_channel_id?: number | null;
  transport_mechanism?: number;
}

export interface DbPacketCountByNode {
  from_node: number;
  from_node_id: string | null;
  from_node_longName: string | null;
  count: number;
}

export interface DbPacketCountByPortnum {
  portnum: number;
  portnum_name: string;
  count: number;
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
}

class DatabaseService {
  public db: BetterSqlite3Database.Database;
  private isInitialized = false;
  public userModel: UserModel;
  public permissionModel: PermissionModel;
  public apiTokenModel: APITokenModel;

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
  private nodesCache: Map<number, DbNode> = new Map();
  private channelsCache: Map<number, DbChannel> = new Map();
  private _traceroutesCache: DbTraceroute[] = [];
  private _traceroutesByNodesCache: Map<string, DbTraceroute[]> = new Map();
  private cacheInitialized = false;

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
        const result = await this.postgresPool.query('SELECT version()');
        const fullVersion = result.rows?.[0]?.version || 'Unknown';
        // Extract just the version number from "PostgreSQL 16.2 (Debian 16.2-1.pgdg120+2) on x86_64-pc-linux-gnu..."
        const match = fullVersion.match(/PostgreSQL\s+([\d.]+)/);
        return match ? match[1] : fullVersion.split(' ').slice(0, 2).join(' ');
      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        const [rows] = await this.mysqlPool.query('SELECT version() as version');
        return (rows as any[])?.[0]?.version || 'Unknown';
      } else if (this.db) {
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

      // Models will not work with PostgreSQL/MySQL - they need to be migrated to use repositories
      // For now, create them with the proxy db - they'll throw errors if used
      this.userModel = new UserModel(this.db);
      this.permissionModel = new PermissionModel(this.db);
      this.apiTokenModel = new APITokenModel(this.db);

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
    try {
      this.db = new BetterSqlite3Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000'); // 5 second timeout for locked database
    } catch (error: unknown) {
      const err = error as Error & { code?: string };
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

      logger.error('═══════════════════════════════════════════════════════════');
      throw new Error(`Database initialization failed: ${err.message}`);
    }

    // Initialize models
    this.userModel = new UserModel(this.db);
    this.permissionModel = new PermissionModel(this.db);
    this.apiTokenModel = new APITokenModel(this.db);

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
  private async initializeDrizzleRepositoriesAsync(dbPath: string): Promise<void> {
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
        // Use SQLite driver (default)
        const { db } = createSQLiteDriver({
          databasePath: dbPath,
          enableWAL: false, // Already enabled on main connection
          enableForeignKeys: false, // Already enabled on main connection
        });
        drizzleDb = db;
        this.drizzleDbType = 'sqlite';
      }

      this.drizzleDatabase = drizzleDb;

      // Initialize all repositories
      this.settingsRepo = new SettingsRepository(drizzleDb, this.drizzleDbType);
      this.channelsRepo = new ChannelsRepository(drizzleDb, this.drizzleDbType);
      this.nodesRepo = new NodesRepository(drizzleDb, this.drizzleDbType);
      this.messagesRepo = new MessagesRepository(drizzleDb, this.drizzleDbType);
      this.telemetryRepo = new TelemetryRepository(drizzleDb, this.drizzleDbType);
      // Auth repo only for PostgreSQL/MySQL - SQLite uses existing sync models (UserModel, etc.)
      // because SQLite migrations created tables with different schema than Drizzle expects
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        this.authRepo = new AuthRepository(drizzleDb, this.drizzleDbType);
      }
      this.traceroutesRepo = new TraceroutesRepository(drizzleDb, this.drizzleDbType);
      this.neighborsRepo = new NeighborsRepository(drizzleDb, this.drizzleDbType);
      this.notificationsRepo = new NotificationsRepository(drizzleDb, this.drizzleDbType);
      this.miscRepo = new MiscRepository(drizzleDb, this.drizzleDbType);
      this.channelDatabaseRepo = new ChannelDatabaseRepository(drizzleDb, this.drizzleDbType);
      this.ignoredNodesRepo = new IgnoredNodesRepository(drizzleDb, this.drizzleDbType);

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
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
          };
          this.nodesCache.set(node.nodeNum, localNode);
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

    this.createTables();
    this.migrateSchema();
    this.createIndexes();
    this.runDataMigrations();
    this.runAuthMigration();
    this.runChannelsMigration();
    this.runConnectionMigration();
    this.runTracerouteMigration();
    this.runAuditLogMigration();
    this.runAuditPermissionMigration();
    this.runReadMessagesMigration();
    this.runPushSubscriptionsMigration();
    this.runNotificationPreferencesMigration();
    this.runNotifyOnEmojiMigration();
    this.runPacketLogMigration();
    this.runChannelRoleMigration();
    this.runBackupTablesMigration();
    this.runMessageDeliveryTrackingMigration();
    this.runAutoTracerouteFilterMigration();
    this.runSecurityPermissionMigration();
    this.runChannelColumnMigration();
    this.runMobileMigration();
    this.runSolarEstimatesMigration();
    this.runPositionPrecisionMigration();
    this.runSystemBackupTableMigration();
    this.runCustomThemesMigration();
    this.runPasswordLockedMigration();
    this.runPerChannelPermissionsMigration();
    this.runAPITokensMigration();
    this.runCascadeForeignKeysMigration();
    // NOTE: Auto-welcome migration is now handled when the feature is first enabled
    // See handleAutoWelcomeEnabled() which is called from the settings POST endpoint in server.ts
    this.runUserMapPreferencesMigration();
    this.runInactiveNodeNotificationMigration();
    this.runIsIgnoredMigration();
    this.runNotifyOnServerEventsMigration();
    this.runPrefixWithNodeNameMigration();
    this.runPerUserAppriseUrlsMigration();
    this.runNotifyOnMqttMigration();
    this.runRecalculateEstimatedPositionsMigration();
    this.runRecalculateEstimatedPositionsFixMigration();
    this.runPositionOverrideMigration();
    this.runPositionOverridePrivacyMigration();
    this.runNodesPrivatePermissionMigration();
    this.runPacketDirectionMigration();
    this.runAutoTracerouteLogMigration();
    this.runRelayNodePacketLogMigration();
    this.runAutoKeyRepairMigration();
    this.runPositionOverrideBooleanMigration();
    this.runAutoTracerouteColumnMigration();
    this.runNotificationChannelSettingsMigration();
    this.runChannelDatabaseMigration();
    this.runDecryptedByMessagesMigration();
    this.runUpgradeHistorySchemaMigration();
    this.runViewOnMapPermissionMigration();
    this.runNewsTablesMigration();
    this.runRemoteAdminColumnsMigration();
    this.runBackupHistoryColumnsMigration();
    this.runPacketViaMqttMigration();
    this.runTransportMechanismMigration();
    this.runChannelDbViewOnMapMigration();
    this.runAutoTracerouteEnabledMigration();
    this.runSpamDetectionMigration();
    this.runPositionDoublePrecisionMigration();
    this.runPositionHistoryHoursMigration();
    this.runEnforceNameValidationMigration();
    this.runSortOrderMigration();
    this.runIgnoredNodesTableMigration();
    this.runAutoTimeSyncMigration();
    this.runMfaColumnsMigration();
    this.runTraceroutePositionsMigration();
    this.runMeshcoreTablesMigration();
    this.runMeshcorePermissionMigration();
    this.runDmUnreadIndexMigration();
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
        autoAnnounceChannelIndex: '0',
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

  private runAuthMigration(): void {
    logger.debug('Running authentication migration...');
    try {
      // Check if migration has already been run
      const tableCheck = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='users'
      `).get();

      if (!tableCheck) {
        logger.debug('Authentication tables not found, running migration...');
        authMigration.up(this.db);
        logger.debug('✅ Authentication migration completed successfully');
      } else {
        logger.debug('✅ Authentication tables already exist, skipping migration');
      }
    } catch (error) {
      logger.error('❌ Failed to run authentication migration:', error);
      throw error;
    }
  }

  private runChannelsMigration(): void {
    logger.debug('Running channels permission migration...');
    try {
      // Check if migration has already been run by checking if 'channels' is in the CHECK constraint
      // We'll use a setting to track this migration
      const migrationKey = 'migration_002_channels_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Channels permission migration already completed');
        return;
      }

      logger.debug('Running migration 002: Add channels permission resource...');
      channelsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Channels permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run channels permission migration:', error);
      throw error;
    }
  }

  private runConnectionMigration(): void {
    logger.debug('Running connection permission migration...');
    try {
      const migrationKey = 'migration_003_connection_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Connection permission migration already completed');
        return;
      }

      logger.debug('Running migration 003: Add connection permission resource...');
      connectionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Connection permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run connection permission migration:', error);
      throw error;
    }
  }

  private runTracerouteMigration(): void {
    logger.debug('Running traceroute permission migration...');
    try {
      const migrationKey = 'migration_004_traceroute_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Traceroute permission migration already completed');
        return;
      }

      logger.debug('Running migration 004: Add traceroute permission resource...');
      tracerouteMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Traceroute permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run traceroute permission migration:', error);
      throw error;
    }
  }

  private runAuditLogMigration(): void {
    logger.debug('Running audit log enhancement migration...');
    try {
      const migrationKey = 'migration_005_enhance_audit_log';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Audit log enhancement migration already completed');
        return;
      }

      logger.debug('Running migration 005: Enhance audit log table...');
      auditLogMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Audit log enhancement migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run audit log enhancement migration:', error);
      throw error;
    }
  }

  private runAuditPermissionMigration(): void {
    logger.debug('Running audit permission migration...');
    try {
      const migrationKey = 'migration_006_audit_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Audit permission migration already completed');
        return;
      }

      logger.debug('Running migration 006: Add audit permission resource...');
      auditPermissionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Audit permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run audit permission migration:', error);
      throw error;
    }
  }

  private runReadMessagesMigration(): void {
    logger.debug('Running read messages migration...');
    try {
      const migrationKey = 'migration_007_read_messages';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Read messages migration already completed');
        return;
      }

      logger.debug('Running migration 007: Add read_messages table...');
      readMessagesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Read messages migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run read messages migration:', error);
      throw error;
    }
  }

  private runPushSubscriptionsMigration(): void {
    logger.debug('Running push subscriptions migration...');
    try {
      const migrationKey = 'migration_008_push_subscriptions';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Push subscriptions migration already completed');
        return;
      }

      logger.debug('Running migration 008: Add push_subscriptions table...');
      pushSubscriptionsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Push subscriptions migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run push subscriptions migration:', error);
      throw error;
    }
  }

  private runNotificationPreferencesMigration(): void {
    logger.debug('Running notification preferences migration...');
    try {
      const migrationKey = 'migration_009_notification_preferences';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Notification preferences migration already completed');
        return;
      }

      logger.debug('Running migration 009: Add user_notification_preferences table...');
      notificationPreferencesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Notification preferences migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run notification preferences migration:', error);
      throw error;
    }
  }

  private runNotifyOnEmojiMigration(): void {
    logger.debug('Running notify on emoji migration...');
    try {
      const migrationKey = 'migration_010_notify_on_emoji';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Notify on emoji migration already completed');
        return;
      }

      logger.debug('Running migration 010: Add notify_on_emoji column...');
      notifyOnEmojiMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Notify on emoji migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run notify on emoji migration:', error);
      throw error;
    }
  }

  private runPacketLogMigration(): void {
    logger.debug('Running packet log migration...');
    try {
      const migrationKey = 'migration_011_packet_log';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Packet log migration already completed');
        return;
      }

      logger.debug('Running migration 011: Add packet log table...');
      packetLogMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Packet log migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run packet log migration:', error);
      throw error;
    }
  }

  private runChannelRoleMigration(): void {
    try {
      const migrationKey = 'migration_012_channel_role';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Channel role migration already completed');
        return;
      }

      logger.debug('Running migration 012: Add channel role and position precision...');
      channelRoleMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Channel role migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run channel role migration:', error);
      throw error;
    }
  }

  private runBackupTablesMigration(): void {
    try {
      const migrationKey = 'migration_013_add_backup_tables';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Backup tables migration already completed');
        return;
      }

      logger.debug('Running migration 013: Add backup tables...');
      backupTablesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Backup tables migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run backup tables migration:', error);
      throw error;
    }
  }

  private runMessageDeliveryTrackingMigration(): void {
    try {
      const migrationKey = 'migration_014_message_delivery_tracking';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Message delivery tracking migration already completed');
        return;
      }

      logger.debug('Running migration 014: Add message delivery tracking fields...');
      messageDeliveryTrackingMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Message delivery tracking migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run message delivery tracking migration:', error);
      throw error;
    }
  }

  private runAutoTracerouteFilterMigration(): void {
    try {
      const migrationKey = 'migration_015_auto_traceroute_filter';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Auto-traceroute filter migration already completed');
        return;
      }

      logger.debug('Running migration 015: Add auto-traceroute node filter...');
      autoTracerouteFilterMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto-traceroute filter migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto-traceroute filter migration:', error);
      throw error;
    }
  }

  private runSecurityPermissionMigration(): void {
    logger.debug('Running security permission migration...');
    try {
      const migrationKey = 'migration_016_security_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Security permission migration already completed');
        return;
      }

      logger.debug('Running migration 016: Add security permission resource...');
      securityPermissionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Security permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run security permission migration:', error);
      throw error;
    }
  }

  private runChannelColumnMigration(): void {
    logger.debug('Running channel column migration...');
    try {
      const migrationKey = 'migration_017_add_channel_to_nodes';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Channel column migration already completed');
        return;
      }

      logger.debug('Running migration 017: Add channel column to nodes table...');
      channelColumnMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Channel column migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run channel column migration:', error);
      throw error;
    }
  }

  private runMobileMigration(): void {
    logger.debug('Running mobile column migration...');
    try {
      const migrationKey = 'migration_018_add_mobile_to_nodes';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Mobile column migration already completed');
        return;
      }

      logger.debug('Running migration 018: Add mobile column to nodes table...');
      mobileMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Mobile column migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run mobile column migration:', error);
      throw error;
    }
  }

  private runSolarEstimatesMigration(): void {
    try {
      const migrationKey = 'migration_019_solar_estimates';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Solar estimates migration already completed');
        return;
      }

      logger.debug('Running migration 019: Add solar estimates table...');
      solarEstimatesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Solar estimates migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run solar estimates migration:', error);
      throw error;
    }
  }

  private runPositionPrecisionMigration(): void {
    try {
      const migrationKey = 'migration_020_position_precision';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position precision migration already completed');
        return;
      }

      logger.debug('Running migration 020: Add position precision tracking...');
      positionPrecisionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position precision migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position precision migration:', error);
      throw error;
    }
  }

  private runSystemBackupTableMigration(): void {
    try {
      const migrationKey = 'migration_021_system_backup_table';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ System backup table migration already completed');
        return;
      }

      logger.debug('Running migration 021: Add system_backup_history table...');
      systemBackupTableMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ System backup table migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run system backup table migration:', error);
      throw error;
    }
  }

  private runCustomThemesMigration(): void {
    try {
      const migrationKey = 'migration_022_custom_themes';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Custom themes migration already completed');
        return;
      }

      logger.debug('Running migration 022: Add custom_themes table...');
      customThemesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Custom themes migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run custom themes migration:', error);
      throw error;
    }
  }

  private runPasswordLockedMigration(): void {
    try {
      const migrationKey = 'migration_023_password_locked';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Password locked migration already completed');
        return;
      }

      logger.debug('Running migration 023: Add password_locked flag to users table...');
      passwordLockedMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Password locked migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run password locked migration:', error);
      throw error;
    }
  }

  private runPerChannelPermissionsMigration(): void {
    try {
      const migrationKey = 'migration_024_per_channel_permissions';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Per-channel permissions migration already completed');
        return;
      }

      logger.debug('Running migration 024: Add per-channel permissions...');
      perChannelPermissionsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Per-channel permissions migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run per-channel permissions migration:', error);
      throw error;
    }
  }

  private runAPITokensMigration(): void {
    const migrationKey = 'migration_025_api_tokens';

    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ API tokens migration already completed');
        return;
      }

      logger.debug('Running migration 025: Add API tokens table...');
      apiTokensMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ API tokens migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run API tokens migration:', error);
      throw error;
    }
  }

  private runCascadeForeignKeysMigration(): void {
    const migrationKey = 'migration_028_cascade_foreign_keys';

    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ CASCADE foreign keys migration already completed');
        return;
      }

      logger.debug('Running migration 028: Add CASCADE to foreign keys...');
      cascadeForeignKeysMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ CASCADE foreign keys migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run CASCADE foreign keys migration:', error);
      throw error;
    }
  }

  private runUserMapPreferencesMigration(): void {
    const migrationKey = 'migration_030_user_map_preferences';

    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ User map preferences migration already completed');
        return;
      }

      logger.debug('Running migration 030: Add user_map_preferences table...');
      userMapPreferencesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ User map preferences migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run user map preferences migration:', error);
      throw error;
    }
  }

  private runIsIgnoredMigration(): void {
    const migrationKey = 'migration_033_is_ignored';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ isIgnored migration already completed');
        return;
      }

      logger.debug('Running migration 033: Add isIgnored column to nodes table...');
      isIgnoredMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ isIgnored migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run isIgnored migration:', error);
      throw error;
    }
  }

  private runNotifyOnServerEventsMigration(): void {
    const migrationKey = 'migration_034_notify_on_server_events';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Notify on server events migration already completed');
        return;
      }

      logger.debug('Running migration 034: Add notify_on_server_events column...');
      notifyOnServerEventsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Notify on server events migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run notify on server events migration:', error);
      throw error;
    }
  }

  private runPrefixWithNodeNameMigration(): void {
    const migrationKey = 'migration_035_prefix_with_node_name';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Prefix with node name migration already completed');
        return;
      }

      logger.debug('Running migration 035: Add prefix_with_node_name column...');
      prefixWithNodeNameMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Prefix with node name migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run prefix with node name migration:', error);
      throw error;
    }
  }

  private runPerUserAppriseUrlsMigration(): void {
    const migrationKey = 'migration_036_per_user_apprise_urls';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Per-user Apprise URLs migration already completed');
        return;
      }

      logger.debug('Running migration 036: Add per-user apprise_urls column...');
      perUserAppriseUrlsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Per-user Apprise URLs migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run per-user Apprise URLs migration:', error);
      throw error;
    }
  }

  private runNotifyOnMqttMigration(): void {
    const migrationKey = 'migration_037_notify_on_mqtt';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Notify on MQTT migration already completed');
        return;
      }

      logger.debug('Running migration 037: Add notify_on_mqtt column...');
      notifyOnMqttMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Notify on MQTT migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run notify on MQTT migration:', error);
      throw error;
    }
  }

  private runRecalculateEstimatedPositionsMigration(): void {
    const migrationKey = 'migration_038_recalculate_estimated_positions';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Recalculate estimated positions migration already completed');
        return;
      }

      logger.info('Running migration 038: Recalculate estimated positions...');
      recalculateEstimatedPositionsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.info('✅ Recalculate estimated positions migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run recalculate estimated positions migration:', error);
      throw error;
    }
  }

  private runRecalculateEstimatedPositionsFixMigration(): void {
    const migrationKey = 'migration_039_recalculate_estimated_positions_fix';
    try {
      const currentStatus = this.getSetting(migrationKey);
      if (currentStatus === 'completed') {
        logger.debug('✅ Recalculate estimated positions fix migration already completed');
        return;
      }

      logger.info('Running migration 039: Recalculate estimated positions (fix route order)...');
      recalculateEstimatedPositionsFixMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.info('✅ Recalculate estimated positions fix migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run recalculate estimated positions fix migration:', error);
      throw error;
    }
  }

  private runPositionOverrideMigration(): void {
    try {
      const migrationKey = 'migration_040_position_override';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position override migration already completed');
        return;
      }

      logger.debug('Running migration 040: Add position override columns to nodes table...');
      positionOverrideMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position override migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position override migration:', error);
      throw error;
    }
  }
   
  private runPositionOverridePrivacyMigration(): void {
    try {
      const migrationKey = 'migration_043_position_override_privacy';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position override privacy migration already completed');
        return;
      }

      logger.debug('Running migration 043: Add position privacy column to nodes table...');
      positionOverridePrivacyMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position override privacy migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position override privacy migration:', error);
      throw error;
    }
  }
  
  private runNodesPrivatePermissionMigration(): void {
    try {
      const migrationKey = 'migration_044_nodes_private_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Nodes private permission migration already completed');
        return;
      }

      logger.debug('Running migration 044: Add nodes_private resource to permissions table...');
      nodesPrivatePermissionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Nodes private permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run nodes private permission migration:', error);
      throw error;
    }
  }

  private runPacketDirectionMigration(): void {
    try {
      const migrationKey = 'migration_045_packet_direction';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Packet direction migration already completed');
        return;
      }

      logger.debug('Running migration 045: Add direction field to packet_log table...');
      packetDirectionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Packet direction migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run packet direction migration:', error);
      throw error;
    }
  }

  private runInactiveNodeNotificationMigration(): void {
    logger.debug('Running inactive node notification migration...');
    try {
      const migrationKey = 'migration_032_inactive_node_notification';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Inactive node notification migration already completed');
        return;
      }

      logger.debug('Running migration 032: Add notify_on_inactive_node and monitored_nodes columns...');
      inactiveNodeNotificationMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Inactive node notification migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run inactive node notification migration:', error);
      throw error;
    }
  }

  private runAutoTracerouteLogMigration(): void {
    logger.debug('Running auto-traceroute log migration...');
    try {
      const migrationKey = 'migration_041_auto_traceroute_log';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Auto-traceroute log migration already completed');
        return;
      }

      logger.debug('Running migration 041: Add auto_traceroute_log table...');
      autoTracerouteLogMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto-traceroute log migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto-traceroute log migration:', error);
      throw error;
    }
  }

  private runRelayNodePacketLogMigration(): void {
    logger.debug('Running relay_node packet_log migration...');
    try {
      const migrationKey = 'migration_042_relay_node_packet_log';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Relay node packet log migration already completed');
        return;
      }

      logger.debug('Running migration 042: Add relay_node to packet_log table...');
      relayNodePacketLogMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Relay node packet log migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run relay node packet log migration:', error);
      throw error;
    }
  }

  private runAutoKeyRepairMigration(): void {
    logger.debug('Running auto key repair migration...');
    try {
      const migrationKey = 'migration_046_auto_key_repair';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Auto key repair migration already completed');
        return;
      }

      logger.debug('Running migration 046: Add auto key repair tables...');
      autoKeyRepairMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto key repair migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto key repair migration:', error);
      throw error;
    }
  }

  private runPositionOverrideBooleanMigration(): void {
    logger.debug('Running position override boolean migration...');
    try {
      const migrationKey = 'migration_047_position_override_boolean';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position override boolean migration already completed');
        return;
      }

      logger.debug('Running migration 047: Fix position override boolean types...');
      positionOverrideBooleanMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position override boolean migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position override boolean migration:', error);
      throw error;
    }
  }

  private runAutoTracerouteColumnMigration(): void {
    logger.debug('Running auto traceroute column name migration...');
    try {
      const migrationKey = 'migration_048_auto_traceroute_column';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Auto traceroute column migration already completed');
        return;
      }

      logger.debug('Running migration 048: Fix auto_traceroute_nodes column name...');
      autoTracerouteColumnMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto traceroute column migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto traceroute column migration:', error);
      throw error;
    }
  }

  private runNotificationChannelSettingsMigration(): void {
    logger.debug('Running notification channel settings migration...');
    try {
      const migrationKey = 'migration_049_notification_channel_settings';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Notification channel settings migration already completed');
        return;
      }

      logger.debug('Running migration 049: Add notification channel settings columns...');
      notificationChannelSettingsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Notification channel settings migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run notification channel settings migration:', error);
      throw error;
    }
  }

  private runChannelDatabaseMigration(): void {
    logger.debug('Running channel database migration...');
    try {
      const migrationKey = 'migration_050_channel_database';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Channel database migration already completed');
        return;
      }

      logger.debug('Running migration 050: Add channel database tables...');
      channelDatabaseMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Channel database migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run channel database migration:', error);
      throw error;
    }
  }

  private runDecryptedByMessagesMigration(): void {
    logger.debug('Running decrypted_by messages migration...');
    try {
      const migrationKey = 'migration_051_decrypted_by_messages';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Decrypted_by messages migration already completed');
        return;
      }

      logger.debug('Running migration 051: Add decrypted_by column to messages...');
      decryptedByMessagesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Decrypted_by messages migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run decrypted_by messages migration:', error);
      throw error;
    }
  }

  private runUpgradeHistorySchemaMigration(): void {
    try {
      const migrationKey = 'migration_052_upgrade_history_schema';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Upgrade history schema migration already completed');
        return;
      }

      logger.debug('Running migration 052: Fix upgrade_history schema...');
      upgradeHistorySchemaMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Upgrade history schema migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run upgrade history schema migration:', error);
      throw error;
    }
  }

  private runViewOnMapPermissionMigration(): void {
    try {
      const migrationKey = 'migration_053_view_on_map_permission';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ View on map permission migration already completed');
        return;
      }

      logger.debug('Running migration 053: Add view on map permission column...');
      viewOnMapPermissionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ View on map permission migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run view on map permission migration:', error);
      throw error;
    }
  }

  private runNewsTablesMigration(): void {
    try {
      const migrationKey = 'migration_054_news_tables';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ News tables migration already completed');
        return;
      }

      logger.debug('Running migration 054: Add news tables...');
      newsTablesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ News tables migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run news tables migration:', error);
      throw error;
    }
  }

  private runRemoteAdminColumnsMigration(): void {
    try {
      const migrationKey = 'migration_055_remote_admin_columns';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Remote admin columns migration already completed');
        return;
      }

      logger.debug('Running migration 055: Add remote admin columns...');
      remoteAdminColumnsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Remote admin columns migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run remote admin columns migration:', error);
      throw error;
    }
  }

  private runBackupHistoryColumnsMigration(): void {
    try {
      const migrationKey = 'migration_056_backup_history_columns';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Backup history columns migration already completed');
        return;
      }

      logger.debug('Running migration 056: Fix backup_history column names...');
      backupHistoryColumnsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Backup history columns migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run backup history columns migration:', error);
      throw error;
    }
  }

  private runPacketViaMqttMigration(): void {
    try {
      const migrationKey = 'migration_057_packet_via_mqtt';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Packet via_mqtt migration already completed');
        return;
      }

      logger.debug('Running migration 057: Add via_mqtt column to packet_log...');
      packetViaMqttMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Packet via_mqtt migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run packet via_mqtt migration:', error);
      throw error;
    }
  }

  private runTransportMechanismMigration(): void {
    try {
      const migrationKey = 'migration_058_transport_mechanism';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Transport mechanism migration already completed');
        return;
      }

      logger.debug('Running migration 058: Convert via_mqtt to transport_mechanism...');
      transportMechanismMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Transport mechanism migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run transport mechanism migration:', error);
      throw error;
    }
  }

  private runChannelDbViewOnMapMigration(): void {
    try {
      const migrationKey = 'migration_059_channel_db_view_on_map';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Channel database view on map migration already completed');
        return;
      }

      logger.debug('Running migration 059: Add can_view_on_map to channel_database_permissions...');
      channelDbViewOnMapMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Channel database view on map migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run channel database view on map migration:', error);
      throw error;
    }
  }

  private runAutoTracerouteEnabledMigration(): void {
    try {
      const migrationKey = 'migration_060_auto_traceroute_enabled';
      // Always run the migration check - it's idempotent and verifies
      // the column exists regardless of whether it was previously marked complete.
      // This guards against edge cases where the setting was marked complete
      // but the column is actually missing (e.g., restored backups).
      autoTracerouteEnabledMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto traceroute enabled column migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto traceroute enabled column migration:', error);
      throw error;
    }
  }

  private runSpamDetectionMigration(): void {
    try {
      const migrationKey = 'migration_061_spam_detection';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Spam detection columns migration already completed');
        return;
      }

      logger.debug('Running migration 061: Add spam detection columns to nodes...');
      spamDetectionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Spam detection columns migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run spam detection columns migration:', error);
      throw error;
    }
  }

  private runPositionDoublePrecisionMigration(): void {
    try {
      const migrationKey = 'migration_062_position_double_precision';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position double precision migration already completed');
        return;
      }

      logger.debug('Running migration 062: Position double precision (no-op for SQLite)...');
      positionDoublePrecisionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position double precision migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position double precision migration:', error);
      throw error;
    }
  }

  private runPositionHistoryHoursMigration(): void {
    try {
      const migrationKey = 'migration_063_position_history_hours';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Position history hours migration already completed');
        return;
      }

      logger.debug('Running migration 063: Add position_history_hours column...');
      positionHistoryHoursMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Position history hours migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run position history hours migration:', error);
      throw error;
    }
  }

  private runEnforceNameValidationMigration(): void {
    const migrationKey = 'migration_064_enforce_name_validation';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 064 (enforce_name_validation) already completed');
        return;
      }

      logger.debug('Running migration 064: Add enforce_name_validation column...');
      enforceNameValidationMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Enforce name validation migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run enforce name validation migration:', error);
      throw error;
    }
  }

  private runSortOrderMigration(): void {
    const migrationKey = 'migration_065_sortorder';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 065 (sortOrder) already completed');
        return;
      }

      logger.debug('Running migration 065: Add sort_order column...');
      sortOrderMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Sort order migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run sort order migration:', error);
      throw error;
    }
  }

  private runIgnoredNodesTableMigration(): void {
    const migrationKey = 'migration_066_ignored_nodes_table';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 066 (ignored_nodes table) already completed');
        return;
      }

      logger.debug('Running migration 066: Add ignored_nodes table...');
      ignoredNodesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('Migration 066 (ignored_nodes table) completed successfully');
    } catch (error) {
      logger.error('Failed to run ignored_nodes table migration:', error);
      throw error;
    }
  }

  private runAutoTimeSyncMigration(): void {
    const migrationKey = 'migration_067_auto_time_sync';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 067 (auto time sync) already completed');
        return;
      }

      logger.debug('Running migration 067: Add auto time sync schema...');
      autoTimeSyncMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('Migration 067 (auto time sync) completed successfully');
    } catch (error) {
      logger.error('Failed to run auto time sync migration:', error);
      throw error;
    }
  }

  private runMfaColumnsMigration(): void {
    const migrationKey = 'migration_068_mfa_columns';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 068 (MFA columns) already completed');
        return;
      }

      logger.debug('Running migration 068: Add MFA columns to users table...');
      mfaColumnsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('Migration 068 (MFA columns) completed successfully');
    } catch (error) {
      logger.error('Failed to run MFA columns migration:', error);
      throw error;
    }
  }

  private runTraceroutePositionsMigration(): void {
    const migrationKey = 'migration_069_traceroute_positions';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 069 (traceroute positions) already completed');
        return;
      }

      logger.debug('Running migration 069: Add position snapshot columns to traceroutes and route_segments...');
      traceroutePositionsMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('Migration 069 (traceroute positions) completed successfully');
    } catch (error) {
      logger.error('Failed to run traceroute positions migration:', error);
      throw error;
    }
  }

  private runMeshcoreTablesMigration(): void {
    const migrationKey = 'migration_070_meshcore_tables';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 070 (meshcore tables) already completed');
        return;
      }

      logger.debug('Running migration 070: Add MeshCore tables...');
      meshcoreTablesMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('MeshCore tables migration completed successfully');
    } catch (error) {
      logger.error('Failed to run MeshCore tables migration:', error);
      throw error;
    }
  }

  private runMeshcorePermissionMigration(): void {
    const migrationKey = 'migration_071_meshcore_permission';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 071 (meshcore permission) already completed');
        return;
      }

      logger.debug('Running migration 071: Add meshcore permission resource...');
      meshcorePermissionMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('MeshCore permission migration completed successfully');
    } catch (error) {
      logger.error('Failed to run MeshCore permission migration:', error);
      throw error;
    }
  }

  private runDmUnreadIndexMigration(): void {
    const migrationKey = 'migration_072_dm_unread_index';
    try {
      const migrationStatus = this.getSetting(migrationKey);
      if (migrationStatus === 'completed') {
        logger.debug('Migration 072 (DM unread index) already completed');
        return;
      }

      logger.debug('Running migration 072: Add DM unread index...');
      dmUnreadIndexMigration.up(this.db);
      this.setSetting(migrationKey, 'completed');
      logger.debug('DM unread index migration completed successfully');
    } catch (error) {
      logger.error('Failed to run DM unread index migration:', error);
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
    logger.debug('Creating database tables...');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT UNIQUE NOT NULL,
        longName TEXT,
        shortName TEXT,
        hwModel INTEGER,
        role INTEGER,
        hopsAway INTEGER,
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
        firmwareVersion TEXT,
        channel INTEGER,
        isFavorite BOOLEAN DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

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
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        replyId INTEGER,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        name TEXT,
        psk TEXT,
        uplinkEnabled BOOLEAN DEFAULT 1,
        downlinkEnabled BOOLEAN DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

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
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
      );
    `);

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
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
      );
    `);

    // Create index for efficient traceroute queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_traceroutes_nodes
      ON traceroutes(fromNodeNum, toNodeNum, timestamp DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fromNodeNum INTEGER NOT NULL,
        toNodeNum INTEGER NOT NULL,
        fromNodeId TEXT NOT NULL,
        toNodeId TEXT NOT NULL,
        distanceKm REAL NOT NULL,
        isRecordHolder BOOLEAN DEFAULT 0,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        neighborNodeNum INTEGER NOT NULL,
        snr REAL,
        lastRxTime INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum),
        FOREIGN KEY (neighborNodeNum) REFERENCES nodes(nodeNum)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);

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
        startedAt INTEGER NOT NULL,
        completedAt INTEGER,
        initiatedBy TEXT,
        errorMessage TEXT,
        rollbackAvailable INTEGER DEFAULT 1
      );
    `);

    // Create index for efficient upgrade history queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_upgrade_history_timestamp
      ON upgrade_history(startedAt DESC);
    `);

    // Channel 0 (Primary) will be created automatically when device config syncs
    // It should have an empty name as per Meshtastic protocol

    logger.debug('Database tables created successfully');
  }

  private migrateSchema(): void {
    logger.debug('Running database migrations...');

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN hopStart INTEGER;
      `);
      logger.debug('✅ Added hopStart column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ hopStart column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN hopLimit INTEGER;
      `);
      logger.debug('✅ Added hopLimit column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ hopLimit column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN replyId INTEGER;
      `);
      logger.debug('✅ Added replyId column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ replyId column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN role INTEGER;
      `);
      logger.debug('✅ Added role column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ role column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN hopsAway INTEGER;
      `);
      logger.debug('✅ Added hopsAway column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ hopsAway column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN lastTracerouteRequest INTEGER;
      `);
      logger.debug('✅ Added lastTracerouteRequest column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ lastTracerouteRequest column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN firmwareVersion TEXT;
      `);
      logger.debug('✅ Added firmwareVersion column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ firmwareVersion column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN emoji INTEGER;
      `);
      logger.debug('✅ Added emoji column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ emoji column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN isFavorite BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added isFavorite column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ isFavorite column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN rebootCount INTEGER;
      `);
      logger.debug('✅ Added rebootCount column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ rebootCount column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN publicKey TEXT;
      `);
      logger.debug('✅ Added publicKey column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ publicKey column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN hasPKC BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added hasPKC column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ hasPKC column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN lastPKIPacket INTEGER;
      `);
      logger.debug('✅ Added lastPKIPacket column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ lastPKIPacket column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN viaMqtt BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added viaMqtt column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ viaMqtt column already exists or other error:', error.message);
      }
    }

    // Add viaMqtt column to messages table for MQTT message filtering
    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN viaMqtt BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added viaMqtt column to messages table');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ viaMqtt column on messages already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE telemetry ADD COLUMN packetTimestamp INTEGER;
      `);
      logger.debug('✅ Added packetTimestamp column to telemetry table');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ packetTimestamp column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN keyIsLowEntropy BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added keyIsLowEntropy column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ keyIsLowEntropy column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN duplicateKeyDetected BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added duplicateKeyDetected column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ duplicateKeyDetected column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN keyMismatchDetected BOOLEAN DEFAULT 0;
      `);
      logger.debug('✅ Added keyMismatchDetected column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ keyMismatchDetected column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN keySecurityIssueDetails TEXT;
      `);
      logger.debug('✅ Added keySecurityIssueDetails column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ keySecurityIssueDetails column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN welcomedAt INTEGER;
      `);
      logger.debug('✅ Added welcomedAt column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ welcomedAt column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN rxSnr REAL;
      `);
      logger.debug('✅ Added rxSnr column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ rxSnr column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE messages ADD COLUMN rxRssi INTEGER;
      `);
      logger.debug('✅ Added rxRssi column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ rxRssi column already exists or other error:', error.message);
      }
    }

    try {
      this.db.exec(`
        ALTER TABLE nodes ADD COLUMN lastMessageHops INTEGER;
      `);
      logger.debug('✅ Added lastMessageHops column');
    } catch (error: any) {
      if (!error.message?.includes('duplicate column')) {
        logger.debug('⚠️ lastMessageHops column already exists or other error:', error.message);
      }
    }

    logger.debug('Database migrations completed');
  }

  private createIndexes(): void {
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
      // Get ALL traceroutes from the database
      const stmt = this.db.prepare('SELECT * FROM traceroutes ORDER BY timestamp ASC');
      const allTraceroutes = stmt.all() as DbTraceroute[];

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

              this.insertRouteSegment(segment);
              this.updateRecordHolderSegment(segment);
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

              this.insertRouteSegment(segment);
              this.updateRecordHolderSegment(segment);
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

    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.nodesRepo) {
        // Update cache optimistically
        const existingNode = this.nodesCache.get(nodeData.nodeNum);
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
          createdAt: existingNode?.createdAt ?? now,
          updatedAt: now,
        };
        this.nodesCache.set(nodeData.nodeNum, updatedNode);

        // Fire and forget async version - pass the full merged node to avoid race conditions
        // where a subsequent update (like welcomedAt) could be overwritten
        this.nodesRepo.upsertNode(updatedNode).catch(err => {
          logger.error('Failed to upsert node:', err);
        });

        // For newly discovered nodes, check persistent ignore list and restore status
        if (!existingNode && nodeData.nodeNum !== 4294967295) {
          // Check if this node was previously ignored
          if (this.ignoredNodesRepo) {
            this.ignoredNodesRepo.isNodeIgnoredAsync(nodeData.nodeNum).then(wasIgnored => {
              if (wasIgnored) {
                logger.debug(`Restoring ignored status for returning node ${nodeData.nodeNum}`);
                updatedNode.isIgnored = true;
                this.nodesCache.set(nodeData.nodeNum!, updatedNode);
                if (this.nodesRepo) {
                  this.nodesRepo.setNodeIgnored(nodeData.nodeNum!, true).catch(err => {
                    logger.error('Failed to restore ignored status:', err);
                  });
                }
              }
            }).catch(err => logger.error('Failed to check persistent ignore list:', err));
          }

          // Send notification for newly discovered node
          import('../server/services/notificationService.js').then(({ notificationService }) => {
            notificationService.notifyNewNode(
              nodeData.nodeId!,
              nodeData.longName || nodeData.nodeId!,
              nodeData.hopsAway
            ).catch(err => logger.error('Failed to send new node notification:', err));
          }).catch(err => logger.error('Failed to import notification service:', err));
        }
      }
      return;
    }

    const now = Date.now();
    const existingNode = this.getNode(nodeData.nodeNum);

    if (existingNode) {
      const stmt = this.db.prepare(`
        UPDATE nodes SET
          nodeId = COALESCE(?, nodeId),
          longName = COALESCE(?, longName),
          shortName = COALESCE(?, shortName),
          hwModel = COALESCE(?, hwModel),
          role = COALESCE(?, role),
          hopsAway = COALESCE(?, hopsAway),
          viaMqtt = COALESCE(?, viaMqtt),
          macaddr = COALESCE(?, macaddr),
          latitude = COALESCE(?, latitude),
          longitude = COALESCE(?, longitude),
          altitude = COALESCE(?, altitude),
          batteryLevel = COALESCE(?, batteryLevel),
          voltage = COALESCE(?, voltage),
          channelUtilization = COALESCE(?, channelUtilization),
          airUtilTx = COALESCE(?, airUtilTx),
          lastHeard = COALESCE(?, lastHeard),
          snr = COALESCE(?, snr),
          rssi = COALESCE(?, rssi),
          firmwareVersion = COALESCE(?, firmwareVersion),
          channel = COALESCE(?, channel),
          isFavorite = COALESCE(?, isFavorite),
          rebootCount = COALESCE(?, rebootCount),
          publicKey = COALESCE(?, publicKey),
          hasPKC = COALESCE(?, hasPKC),
          lastPKIPacket = COALESCE(?, lastPKIPacket),
          welcomedAt = COALESCE(?, welcomedAt),
          keyIsLowEntropy = COALESCE(?, keyIsLowEntropy),
          duplicateKeyDetected = COALESCE(?, duplicateKeyDetected),
          keyMismatchDetected = COALESCE(?, keyMismatchDetected),
          keySecurityIssueDetails = COALESCE(?, keySecurityIssueDetails),
          positionChannel = COALESCE(?, positionChannel),
          positionPrecisionBits = COALESCE(?, positionPrecisionBits),
          positionTimestamp = COALESCE(?, positionTimestamp),
          updatedAt = ?
        WHERE nodeNum = ?
      `);

      stmt.run(
        nodeData.nodeId,
        nodeData.longName,
        nodeData.shortName,
        nodeData.hwModel,
        nodeData.role,
        nodeData.hopsAway,
        nodeData.viaMqtt !== undefined ? (nodeData.viaMqtt ? 1 : 0) : null,
        nodeData.macaddr,
        nodeData.latitude,
        nodeData.longitude,
        nodeData.altitude,
        nodeData.batteryLevel,
        nodeData.voltage,
        nodeData.channelUtilization,
        nodeData.airUtilTx,
        nodeData.lastHeard,
        nodeData.snr,
        nodeData.rssi,
        nodeData.firmwareVersion || null,
        nodeData.channel !== undefined ? nodeData.channel : null,
        nodeData.isFavorite !== undefined ? (nodeData.isFavorite ? 1 : 0) : null,
        nodeData.rebootCount !== undefined ? nodeData.rebootCount : null,
        nodeData.publicKey || null,
        nodeData.hasPKC !== undefined ? (nodeData.hasPKC ? 1 : 0) : null,
        nodeData.lastPKIPacket !== undefined ? nodeData.lastPKIPacket : null,
        nodeData.welcomedAt !== undefined ? nodeData.welcomedAt : null,
        nodeData.keyIsLowEntropy !== undefined ? (nodeData.keyIsLowEntropy ? 1 : 0) : null,
        nodeData.duplicateKeyDetected !== undefined ? (nodeData.duplicateKeyDetected ? 1 : 0) : null,
        nodeData.keyMismatchDetected !== undefined ? (nodeData.keyMismatchDetected ? 1 : 0) : null,
        // For keySecurityIssueDetails, use empty string to explicitly clear (COALESCE will keep old value for null)
        // If explicitly set to undefined, pass empty string to clear; if set to a value, use it; if not provided, pass null
        'keySecurityIssueDetails' in nodeData ? (nodeData.keySecurityIssueDetails || '') : null,
        nodeData.positionChannel !== undefined ? nodeData.positionChannel : null,
        nodeData.positionPrecisionBits !== undefined ? nodeData.positionPrecisionBits : null,
        nodeData.positionTimestamp !== undefined ? nodeData.positionTimestamp : null,
        now,
        nodeData.nodeNum
      );
    } else {
      // Check if this node was previously ignored (persistent ignore list)
      let wasIgnored = false;
      try {
        const ignoreCheck = this.db.prepare('SELECT nodeNum FROM ignored_nodes WHERE nodeNum = ?');
        wasIgnored = !!ignoreCheck.get(nodeData.nodeNum);
      } catch {
        // Table may not exist yet during initial setup
      }

      const stmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, role, hopsAway, viaMqtt, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi, firmwareVersion, channel,
          isFavorite, rebootCount, publicKey, hasPKC, lastPKIPacket, welcomedAt,
          keyIsLowEntropy, duplicateKeyDetected, keyMismatchDetected, keySecurityIssueDetails,
          positionChannel, positionPrecisionBits, positionTimestamp,
          isIgnored,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        nodeData.nodeNum,
        nodeData.nodeId,
        nodeData.longName || null,
        nodeData.shortName || null,
        nodeData.hwModel || null,
        nodeData.role || null,
        nodeData.hopsAway !== undefined ? nodeData.hopsAway : null,
        nodeData.viaMqtt !== undefined ? (nodeData.viaMqtt ? 1 : 0) : null,
        nodeData.macaddr || null,
        nodeData.latitude || null,
        nodeData.longitude || null,
        nodeData.altitude || null,
        nodeData.batteryLevel || null,
        nodeData.voltage || null,
        nodeData.channelUtilization || null,
        nodeData.airUtilTx || null,
        nodeData.lastHeard || null,
        nodeData.snr || null,
        nodeData.rssi || null,
        nodeData.firmwareVersion || null,
        nodeData.channel !== undefined ? nodeData.channel : null,
        nodeData.isFavorite ? 1 : 0,
        nodeData.rebootCount || null,
        nodeData.publicKey || null,
        nodeData.hasPKC ? 1 : 0,
        nodeData.lastPKIPacket || null,
        nodeData.welcomedAt || null,
        nodeData.keyIsLowEntropy ? 1 : 0,
        nodeData.duplicateKeyDetected ? 1 : 0,
        nodeData.keyMismatchDetected ? 1 : 0,
        nodeData.keySecurityIssueDetails || null,
        nodeData.positionChannel !== undefined ? nodeData.positionChannel : null,
        nodeData.positionPrecisionBits !== undefined ? nodeData.positionPrecisionBits : null,
        nodeData.positionTimestamp !== undefined ? nodeData.positionTimestamp : null,
        wasIgnored ? 1 : 0,
        now,
        now
      );

      if (wasIgnored) {
        logger.debug(`Restored ignored status for returning node ${nodeData.nodeNum}`);
      }

      // Send notification for newly discovered node (only if not broadcast node)
      if (nodeData.nodeNum !== 4294967295 && nodeData.nodeId) {
        // Import notification service dynamically to avoid circular dependencies
        import('../server/services/notificationService.js').then(({ notificationService }) => {
          notificationService.notifyNewNode(
            nodeData.nodeId!,
            nodeData.longName || nodeData.nodeId!,
            nodeData.hopsAway
          ).catch(err => logger.error('Failed to send new node notification:', err));
        }).catch(err => logger.error('Failed to import notification service:', err));
      }
    }
  }

  getNode(nodeNum: number): DbNode | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getNode(${nodeNum}) called before cache initialized`);
        return null;
      }
      return this.nodesCache.get(nodeNum) ?? null;
    }
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE nodeNum = ?');
    const node = stmt.get(nodeNum) as DbNode | null;
    return node ? this.normalizeBigInts(node) : null;
  }

  getAllNodes(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getAllNodes() called before cache initialized');
        return [];
      }
      return Array.from(this.nodesCache.values());
    }
    const stmt = this.db.prepare('SELECT * FROM nodes ORDER BY updatedAt DESC');
    const nodes = stmt.all() as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  /**
   * Async version of getAllNodes - works with all database backends
   */
  async getAllNodesAsync(): Promise<DbNode[]> {
    if (this.nodesRepo) {
      // Cast to local DbNode type (they have compatible structure)
      return this.nodesRepo.getAllNodes() as unknown as DbNode[];
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getAllNodes();
  }

  getActiveNodes(sinceDays: number = 7): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getActiveNodes() called before cache initialized');
        return [];
      }
      const cutoff = Math.floor(Date.now() / 1000) - (sinceDays * 24 * 60 * 60);
      return Array.from(this.nodesCache.values())
        .filter(node => node.lastHeard !== undefined && node.lastHeard !== null && node.lastHeard > cutoff)
        .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
    }

    // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
    const cutoff = Math.floor(Date.now() / 1000) - (sinceDays * 24 * 60 * 60);
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE lastHeard > ? ORDER BY lastHeard DESC');
    const nodes = stmt.all(cutoff) as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  /**
   * Update the lastMessageHops for a node (calculated from hopStart - hopLimit of received packets)
   */
  updateNodeMessageHops(nodeNum: number, hops: number): void {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        cachedNode.lastMessageHops = hops;
        cachedNode.updatedAt = now;
      }
      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.updateNode(nodeNum, { lastMessageHops: hops, updatedAt: now }).catch((err: Error) => {
          logger.error('Failed to update node message hops:', err);
        });
      }
      return;
    }
    const stmt = this.db.prepare('UPDATE nodes SET lastMessageHops = ?, updatedAt = ? WHERE nodeNum = ?');
    stmt.run(hops, now, nodeNum);
  }

  /**
   * Mark all existing nodes as welcomed to prevent thundering herd on startup
   * Should be called when Auto-Welcome is enabled during server initialization
   */
  markAllNodesAsWelcomed(): number {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      let count = 0;
      for (const node of this.nodesCache.values()) {
        if (node.welcomedAt === undefined || node.welcomedAt === null) {
          node.welcomedAt = now;
          node.updatedAt = now;
          count++;
        }
      }
      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.markAllNodesAsWelcomed().catch((err: Error) => {
          logger.error('Failed to mark all nodes as welcomed:', err);
        });
      }
      return count;
    }
    const stmt = this.db.prepare('UPDATE nodes SET welcomedAt = ? WHERE welcomedAt IS NULL');
    const result = stmt.run(now);
    return result.changes;
  }

  /**
   * Atomically mark a specific node as welcomed if not already welcomed.
   * This prevents race conditions where multiple processes try to welcome the same node.
   * Returns true if the node was marked, false if already welcomed.
   */
  markNodeAsWelcomedIfNotAlready(nodeNum: number, nodeId: string): boolean {
    const now = Date.now();
    // Update cache for PostgreSQL/MySQL
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode && cachedNode.nodeId === nodeId && (cachedNode.welcomedAt === undefined || cachedNode.welcomedAt === null)) {
        cachedNode.welcomedAt = now;
        cachedNode.updatedAt = now;
        // Persist to database and log result
        if (this.nodesRepo) {
          this.nodesRepo.updateNode(nodeNum, { welcomedAt: now, updatedAt: now })
            .then(() => {
              logger.info(`✅ Persisted welcomedAt=${now} to database for node ${nodeId}`);
            })
            .catch((err: Error) => {
              logger.error(`❌ Failed to persist welcomedAt for node ${nodeId}:`, err);
            });
        }
        return true;
      }
      return false;
    }
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET welcomedAt = ?, updatedAt = ?
      WHERE nodeNum = ? AND nodeId = ? AND welcomedAt IS NULL
    `);
    const result = stmt.run(now, now, nodeNum, nodeId);
    return result.changes > 0;
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
  getNodesWithKeySecurityIssues(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug('getNodesWithKeySecurityIssues() called before cache initialized');
        return [];
      }
      return Array.from(this.nodesCache.values())
        .filter(node => node.keyIsLowEntropy || node.duplicateKeyDetected)
        .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
    }

    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE keyIsLowEntropy = 1 OR duplicateKeyDetected = 1
      ORDER BY lastHeard DESC
    `);
    const nodes = stmt.all() as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  /**
   * Get nodes with key security issues (low-entropy or duplicate keys) - async version
   * Works with PostgreSQL, MySQL, and SQLite through the repository pattern
   */
  async getNodesWithKeySecurityIssuesAsync(): Promise<DbNode[]> {
    if (this.nodesRepo) {
      const nodes = await this.nodesRepo.getNodesWithKeySecurityIssues();
      return nodes as unknown as DbNode[];
    }
    // Fallback to sync method for SQLite without repo
    return this.getNodesWithKeySecurityIssues();
  }

  /**
   * Get all nodes that have public keys (for duplicate detection)
   */
  getNodesWithPublicKeys(): Array<{ nodeNum: number; publicKey: string | null }> {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: Array<{ nodeNum: number; publicKey: string | null }> = [];
      for (const node of this.nodesCache.values()) {
        if (node.publicKey && node.publicKey !== '') {
          result.push({ nodeNum: node.nodeNum, publicKey: node.publicKey });
        }
      }
      return result;
    }

    const stmt = this.db.prepare(`
      SELECT nodeNum, publicKey FROM nodes
      WHERE publicKey IS NOT NULL AND publicKey != ''
    `);
    return stmt.all() as Array<{ nodeNum: number; publicKey: string | null }>;
  }

  /**
   * Update security flags for a node by nodeNum (doesn't require nodeId)
   * Used by duplicate key scanner which needs to update nodes that may not have nodeIds yet
   */
  updateNodeSecurityFlags(nodeNum: number, duplicateKeyDetected: boolean, keySecurityIssueDetails?: string): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        cachedNode.duplicateKeyDetected = duplicateKeyDetected;
        cachedNode.keySecurityIssueDetails = keySecurityIssueDetails;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.updateNodeSecurityFlags(nodeNum, duplicateKeyDetected, keySecurityIssueDetails).catch(err => {
          logger.error(`Failed to update node security flags in database:`, err);
        });
      }
      return;
    }

    // SQLite: synchronous update
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET duplicateKeyDetected = ?,
          keySecurityIssueDetails = ?,
          updatedAt = ?
      WHERE nodeNum = ?
    `);
    const now = Date.now();
    stmt.run(duplicateKeyDetected ? 1 : 0, keySecurityIssueDetails ?? null, now, nodeNum);
  }

  updateNodeLowEntropyFlag(nodeNum: number, keyIsLowEntropy: boolean, details?: string): void {
    const node = this.getNode(nodeNum);
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
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        cachedNode.keyIsLowEntropy = keyIsLowEntropy;
        cachedNode.keySecurityIssueDetails = combinedDetails || undefined;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.updateNodeLowEntropyFlag(nodeNum, keyIsLowEntropy, combinedDetails || undefined).catch(err => {
          logger.error(`Failed to update node low entropy flag in database:`, err);
        });
      }
      return;
    }

    // SQLite: synchronous update
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET keyIsLowEntropy = ?,
          keySecurityIssueDetails = ?,
          updatedAt = ?
      WHERE nodeNum = ?
    `);
    const now = Date.now();
    stmt.run(keyIsLowEntropy ? 1 : 0, combinedDetails || null, now, nodeNum);
  }

  /**
   * Get packet counts per node for the last hour (for spam detection)
   * Returns an array of { nodeNum, packetCount }
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  getPacketCountsPerNodeLastHour(): Array<{ nodeNum: number; packetCount: number }> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    // For PostgreSQL/MySQL, use async method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Return empty array and caller should use async version
      logger.warn('getPacketCountsPerNodeLastHour() called for non-SQLite database - use async version');
      return [];
    }

    // Get local node number to exclude internal traffic
    const localNodeNumStr = this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    const stmt = this.db.prepare(`
      SELECT from_node as nodeNum, COUNT(*) as packetCount
      FROM packet_log
      WHERE timestamp >= ?
        AND NOT (from_node = ? AND to_node = ?)
      GROUP BY from_node
    `);

    return stmt.all(oneHourAgo, localNodeNum || -1, localNodeNum || -1) as Array<{ nodeNum: number; packetCount: number }>;
  }

  /**
   * Get packet counts per node for the last hour (async version)
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  async getPacketCountsPerNodeLastHourAsync(): Promise<Array<{ nodeNum: number; packetCount: number }>> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    // Get local node number to exclude internal traffic
    const localNodeNumStr = this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const result = await this.postgresPool.query(`
          SELECT from_node as "nodeNum", COUNT(*)::int as "packetCount"
          FROM packet_log
          WHERE timestamp >= $1
            AND NOT (from_node = $2 AND to_node = $2)
          GROUP BY from_node
        `, [oneHourAgo, localNodeNum || -1]);

        return result.rows;
      } catch (error) {
        logger.error('Error getting packet counts per node (PostgreSQL):', error);
        return [];
      }
    }

    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const [rows] = await this.mysqlPool.query(`
          SELECT from_node as nodeNum, COUNT(*) as packetCount
          FROM packet_log
          WHERE timestamp >= ?
            AND NOT (from_node = ? AND to_node = ?)
          GROUP BY from_node
        `, [oneHourAgo, localNodeNum || -1, localNodeNum || -1]) as any;

        return rows.map((row: any) => ({
          nodeNum: Number(row.nodeNum),
          packetCount: Number(row.packetCount)
        }));
      } catch (error) {
        logger.error('Error getting packet counts per node (MySQL):', error);
        return [];
      }
    }

    // SQLite fallback
    return this.getPacketCountsPerNodeLastHour();
  }

  /**
   * Get top N broadcasters by packet count in the last hour
   * Returns node info with packet counts, sorted by count descending
   * Excludes internal traffic (packets where both from and to are the local node)
   */
  async getTopBroadcastersAsync(limit: number = 5): Promise<Array<{ nodeNum: number; shortName: string | null; longName: string | null; packetCount: number }>> {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    // Get local node number to exclude internal traffic
    const localNodeNumStr = this.getSetting('localNodeNum');
    const localNodeNum = localNodeNumStr ? parseInt(localNodeNumStr, 10) : null;

    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        // Exclude packets where both from_node and to_node are the local node (internal traffic)
        const result = await this.postgresPool.query(`
          SELECT p.from_node as "nodeNum", n."shortName", n."longName", COUNT(*)::int as "packetCount"
          FROM packet_log p
          LEFT JOIN nodes n ON p.from_node = n."nodeNum"
          WHERE p.timestamp >= $1
            AND NOT (p.from_node = $3 AND p.to_node = $3)
          GROUP BY p.from_node, n."shortName", n."longName"
          ORDER BY "packetCount" DESC
          LIMIT $2
        `, [oneHourAgo, limit, localNodeNum || -1]);

        return result.rows;
      } catch (error) {
        logger.error('Error getting top broadcasters (PostgreSQL):', error);
        return [];
      }
    }

    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const [rows] = await this.mysqlPool.query(`
          SELECT p.from_node as nodeNum, n.shortName, n.longName, COUNT(*) as packetCount
          FROM packet_log p
          LEFT JOIN nodes n ON p.from_node = n.nodeNum
          WHERE p.timestamp >= ?
            AND NOT (p.from_node = ? AND p.to_node = ?)
          GROUP BY p.from_node, n.shortName, n.longName
          ORDER BY packetCount DESC
          LIMIT ?
        `, [oneHourAgo, localNodeNum || -1, localNodeNum || -1, limit]) as any;

        return rows.map((row: any) => ({
          nodeNum: Number(row.nodeNum),
          shortName: row.shortName,
          longName: row.longName,
          packetCount: Number(row.packetCount)
        }));
      } catch (error) {
        logger.error('Error getting top broadcasters (MySQL):', error);
        return [];
      }
    }

    // SQLite - exclude packets where both from_node and to_node are the local node
    const stmt = this.db.prepare(`
      SELECT p.from_node as nodeNum, n.shortName, n.longName, COUNT(*) as packetCount
      FROM packet_log p
      LEFT JOIN nodes n ON p.from_node = n.nodeNum
      WHERE p.timestamp >= ?
        AND NOT (p.from_node = ? AND p.to_node = ?)
      GROUP BY p.from_node
      ORDER BY packetCount DESC
      LIMIT ?
    `);

    return stmt.all(oneHourAgo, localNodeNum || -1, localNodeNum || -1, limit) as Array<{ nodeNum: number; shortName: string | null; longName: string | null; packetCount: number }>;
  }

  /**
   * Update the spam detection flags for a node
   */
  updateNodeSpamFlags(nodeNum: number, isExcessivePackets: boolean, packetRatePerHour: number): void {
    const now = Math.floor(Date.now() / 1000);

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        (cachedNode as any).isExcessivePackets = isExcessivePackets;
        (cachedNode as any).packetRatePerHour = packetRatePerHour;
        (cachedNode as any).packetRateLastChecked = now;
        cachedNode.updatedAt = Date.now();
      }

      // Fire-and-forget database update
      this.updateNodeSpamFlagsAsync(nodeNum, isExcessivePackets, packetRatePerHour, now).catch(err => {
        logger.error(`Failed to update node spam flags in database:`, err);
      });
      return;
    }

    // SQLite: synchronous update
    const stmt = this.db.prepare(`
      UPDATE nodes
      SET isExcessivePackets = ?,
          packetRatePerHour = ?,
          packetRateLastChecked = ?,
          updatedAt = ?
      WHERE nodeNum = ?
    `);
    stmt.run(isExcessivePackets ? 1 : 0, packetRatePerHour, now, Date.now(), nodeNum);
  }

  /**
   * Update the spam detection flags for a node (async)
   */
  async updateNodeSpamFlagsAsync(nodeNum: number, isExcessivePackets: boolean, packetRatePerHour: number, lastChecked: number): Promise<void> {
    const now = Date.now();

    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      await this.postgresPool.query(`
        UPDATE nodes
        SET "isExcessivePackets" = $1,
            "packetRatePerHour" = $2,
            "packetRateLastChecked" = $3,
            "updatedAt" = $4
        WHERE "nodeNum" = $5
      `, [isExcessivePackets, packetRatePerHour, lastChecked, now, nodeNum]);
      return;
    }

    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      await this.mysqlPool.query(`
        UPDATE nodes
        SET isExcessivePackets = ?,
            packetRatePerHour = ?,
            packetRateLastChecked = ?,
            updatedAt = ?
        WHERE nodeNum = ?
      `, [isExcessivePackets, packetRatePerHour, lastChecked, now, nodeNum]);
      return;
    }
  }

  /**
   * Get all nodes with excessive packet rates (for security page)
   */
  getNodesWithExcessivePackets(): DbNode[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const result: DbNode[] = [];
      for (const node of this.nodesCache.values()) {
        if ((node as any).isExcessivePackets) {
          result.push(node);
        }
      }
      return result;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM nodes WHERE isExcessivePackets = 1
    `);
    return stmt.all() as DbNode[];
  }

  /**
   * Get all nodes with excessive packet rates (async)
   */
  async getNodesWithExcessivePacketsAsync(): Promise<DbNode[]> {
    if (this.nodesRepo) {
      // Use cache for now since we don't have a repo method yet
      return this.getNodesWithExcessivePackets();
    }
    return this.getNodesWithExcessivePackets();
  }

  // Message operations
  insertMessage(messageData: DbMessage): void {
    // For PostgreSQL/MySQL, fire-and-forget async insert
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
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
      return;
    }

    // SQLite synchronous path - Use INSERT OR IGNORE to silently skip duplicate messages
    // (mesh networks can retransmit packets or send duplicates during reconnections)
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, fromNodeNum, toNodeNum, fromNodeId, toNodeId,
        text, channel, portnum, timestamp, rxTime, hopStart, hopLimit, relayNode, replyId, emoji,
        requestId, ackFailed, routingErrorReceived, deliveryState, wantAck, viaMqtt, rxSnr, rxRssi, createdAt, decrypted_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      messageData.id,
      messageData.fromNodeNum,
      messageData.toNodeNum,
      messageData.fromNodeId,
      messageData.toNodeId,
      messageData.text,
      messageData.channel,
      messageData.portnum ?? null,
      messageData.timestamp,
      messageData.rxTime ?? null,
      messageData.hopStart ?? null,
      messageData.hopLimit ?? null,
      messageData.relayNode ?? null,
      messageData.replyId ?? null,
      messageData.emoji ?? null,
      (messageData as any).requestId ?? null,
      (messageData as any).ackFailed ? 1 : 0,
      (messageData as any).routingErrorReceived ? 1 : 0,
      (messageData as any).deliveryState ?? null,
      (messageData as any).wantAck ? 1 : 0,
      messageData.viaMqtt ? 1 : 0,
      messageData.rxSnr ?? null,
      messageData.rxRssi ?? null,
      messageData.createdAt,
      messageData.decryptedBy ?? null
    );
  }

  getMessage(id: string): DbMessage | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.find(m => m.id === id) ?? null;
    }
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const message = stmt.get(id) as DbMessage | null;
    return message ? this.normalizeBigInts(message) : null;
  }

  getMessageByRequestId(requestId: number): DbMessage | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.find(m => m.requestId === requestId) ?? null;
    }
    const stmt = this.db.prepare('SELECT * FROM messages WHERE requestId = ?');
    const message = stmt.get(requestId) as DbMessage | null;
    return message ? this.normalizeBigInts(message) : null;
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
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ORDER BY COALESCE(rxTime, timestamp) DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
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
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel = ?
      ORDER BY COALESCE(rxTime, timestamp) DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(channel, limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getDirectMessages(nodeId1: string, nodeId2: string, limit: number = 100, offset: number = 0): DbMessage[] {
    // For PostgreSQL/MySQL, messages are not cached - return empty for sync calls
    // Messages are fetched via API endpoints which can be async
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE portnum = 1
        AND channel = -1
        AND (
          (fromNodeId = ? AND toNodeId = ?)
          OR (fromNodeId = ? AND toNodeId = ?)
        )
      ORDER BY COALESCE(rxTime, timestamp) DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(nodeId1, nodeId2, nodeId2, nodeId1, limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getMessagesAfterTimestamp(timestamp: number): DbMessage[] {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache
        .filter(m => m.timestamp > timestamp)
        .sort((a, b) => a.timestamp - b.timestamp);
    }
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE timestamp > ?
      ORDER BY timestamp ASC
    `);
    const messages = stmt.all(timestamp) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  // Statistics
  getMessageCount(): number {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return this._messagesCache.length;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const result = stmt.get() as { count: number };
    return Number(result.count);
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
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM nodes');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getTelemetryCount(): number {
    // For PostgreSQL/MySQL, telemetry is not cached and count is only used for stats
    // Return 0 as telemetry count is not critical for operation
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM telemetry');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getTelemetryCountByNode(nodeId: string, sinceTimestamp?: number, beforeTimestamp?: number, telemetryType?: string): number {
    // For PostgreSQL/MySQL, telemetry count is async - return 0 for now
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }

    let query = 'SELECT COUNT(*) as count FROM telemetry WHERE nodeId = ?';
    const params: any[] = [nodeId];

    if (sinceTimestamp !== undefined) {
      query += ' AND timestamp >= ?';
      params.push(sinceTimestamp);
    }

    if (beforeTimestamp !== undefined) {
      query += ' AND timestamp < ?';
      params.push(beforeTimestamp);
    }

    if (telemetryType !== undefined) {
      query += ' AND telemetryType = ?';
      params.push(telemetryType);
    }

    const stmt = this.db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return Number(result.count);
  }

  /**
   * Async version of getTelemetryCountByNode - works with all database backends
   */
  async getTelemetryCountByNodeAsync(
    nodeId: string,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    telemetryType?: string
  ): Promise<number> {
    if (this.telemetryRepo) {
      return this.telemetryRepo.getTelemetryCountByNode(nodeId, sinceTimestamp, beforeTimestamp, telemetryType);
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getTelemetryCountByNode(nodeId, sinceTimestamp, beforeTimestamp, telemetryType);
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
      const stmt = this.db.prepare('UPDATE nodes SET mobile = ? WHERE nodeId = ?');
      stmt.run(isMobile, nodeId);

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
      const positionTelemetry = await this.getPositionTelemetryByNodeAsync(nodeId, 500);

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
      await this.nodesRepo!.updateNodeMobility(nodeId, isMobile);

      // Also update the cache so getAllNodes() returns the updated value
      for (const [nodeNum, cachedNode] of this.nodesCache.entries()) {
        if (cachedNode.nodeId === nodeId) {
          cachedNode.mobile = isMobile;
          this.nodesCache.set(nodeNum, cachedNode);
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

    const stmt = this.db.prepare(`
      SELECT
        date(timestamp/1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM messages
      WHERE timestamp > ?
      GROUP BY date(timestamp/1000, 'unixepoch')
      ORDER BY date
    `);

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const results = stmt.all(cutoff) as Array<{ date: string; count: number }>;
    return results.map(row => ({
      date: row.date,
      count: Number(row.count)
    }));
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

    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM messages WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
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
    const stmt = this.db.prepare('DELETE FROM nodes WHERE (lastHeard < ? OR lastHeard IS NULL) AND (isIgnored = 0 OR isIgnored IS NULL)');
    const result = stmt.run(cutoff);
    return Number(result.changes);
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

    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const result = stmt.run(id);
    return Number(result.changes) > 0;
  }

  purgeChannelMessages(channel: number): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.purgeChannelMessages(channel).catch(err => {
          logger.debug('Failed to purge channel messages:', err);
        });
      }
      return 0;
    }

    const stmt = this.db.prepare('DELETE FROM messages WHERE channel = ?');
    const result = stmt.run(channel);
    return Number(result.changes);
  }

  purgeDirectMessages(nodeNum: number): number {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.messagesRepo) {
        this.messagesRepo.purgeDirectMessages(nodeNum).catch(err => {
          logger.debug('Failed to purge direct messages:', err);
        });
      }
      return 0;
    }

    // Delete all DMs to/from this node
    // DMs are identified by fromNodeNum/toNodeNum pairs, regardless of channel
    const stmt = this.db.prepare(`
      DELETE FROM messages
      WHERE (fromNodeNum = ? OR toNodeNum = ?)
      AND toNodeId != '!ffffffff'
    `);
    const result = stmt.run(nodeNum, nodeNum);
    return Number(result.changes);
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
    const stmt = this.db.prepare(`
      DELETE FROM traceroutes
      WHERE fromNodeNum = ? OR toNodeNum = ?
    `);
    const result = stmt.run(nodeNum, nodeNum);
    return Number(result.changes);
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
    const stmt = this.db.prepare('DELETE FROM telemetry WHERE nodeNum = ?');
    const result = stmt.run(nodeNum);
    return Number(result.changes);
  }

  deleteNode(nodeNum: number): {
    messagesDeleted: number;
    traceroutesDeleted: number;
    telemetryDeleted: number;
    nodeDeleted: boolean;
  } {
    // For PostgreSQL/MySQL, update cache and fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Remove from cache immediately
      const existed = this.nodesCache.has(nodeNum);
      this.nodesCache.delete(nodeNum);

      // Fire-and-forget async deletion of all associated data
      this.deleteNodeAsync(nodeNum).catch(err => {
        logger.error(`Failed to delete node ${nodeNum} from database:`, err);
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
    // (messages the deleted node sent to public channels)
    const broadcastStmt = this.db.prepare(`
      DELETE FROM messages
      WHERE fromNodeNum = ?
      AND toNodeId = '!ffffffff'
    `);
    const broadcastResult = broadcastStmt.run(nodeNum);
    const broadcastDeleted = Number(broadcastResult.changes);

    const messagesDeleted = dmsDeleted + broadcastDeleted;
    const traceroutesDeleted = this.purgeNodeTraceroutes(nodeNum);
    const telemetryDeleted = this.purgeNodeTelemetry(nodeNum);

    // Delete route segments where this node is involved
    const routeSegmentsStmt = this.db.prepare(`
      DELETE FROM route_segments
      WHERE fromNodeNum = ? OR toNodeNum = ?
    `);
    routeSegmentsStmt.run(nodeNum, nodeNum);

    // Delete neighbor_info records where this node is involved (either as source or neighbor)
    const neighborInfoStmt = this.db.prepare(`
      DELETE FROM neighbor_info
      WHERE nodeNum = ? OR neighborNodeNum = ?
    `);
    neighborInfoStmt.run(nodeNum, nodeNum);

    // Delete the node from the nodes table
    const nodeStmt = this.db.prepare('DELETE FROM nodes WHERE nodeNum = ?');
    const nodeResult = nodeStmt.run(nodeNum);
    const nodeDeleted = Number(nodeResult.changes) > 0;

    return {
      messagesDeleted,
      traceroutesDeleted,
      telemetryDeleted,
      nodeDeleted
    };
  }

  deleteTelemetryByNodeAndType(nodeId: string, telemetryType: string): boolean {
    // For PostgreSQL/MySQL, fire-and-forget async delete
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        this.telemetryRepo.deleteTelemetryByNodeAndType(nodeId, telemetryType).catch(err => {
          logger.debug('Failed to delete telemetry by node and type:', err);
        });
      }
      return true;
    }

    // Delete telemetry data for a specific node and type
    const stmt = this.db.prepare('DELETE FROM telemetry WHERE nodeId = ? AND telemetryType = ?');
    const result = stmt.run(nodeId, telemetryType);
    return Number(result.changes) > 0;
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

  close(): void {
    // For PostgreSQL/MySQL, we don't have a direct close method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug('Closing PostgreSQL/MySQL connection');
      return;
    }

    if (this.db) {
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
      this.db.exec('DELETE FROM messages');
      this.db.exec('DELETE FROM nodes');

      // Import nodes
      const nodeStmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of data.nodes) {
        nodeStmt.run(
          node.nodeNum, node.nodeId, node.longName, node.shortName,
          node.hwModel, node.macaddr, node.latitude, node.longitude,
          node.altitude, node.batteryLevel, node.voltage,
          node.channelUtilization, node.airUtilTx, node.lastHeard,
          node.snr, node.rssi, node.createdAt, node.updatedAt
        );
      }

      // Import messages
      const msgStmt = this.db.prepare(`
        INSERT INTO messages (
          id, fromNodeNum, toNodeNum, fromNodeId, toNodeId,
          text, channel, portnum, timestamp, rxTime, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const message of data.messages) {
        msgStmt.run(
          message.id, message.fromNodeNum, message.toNodeNum,
          message.fromNodeId, message.toNodeId, message.text,
          message.channel, message.portnum, message.timestamp,
          message.rxTime, message.createdAt
        );
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

    // SQLite path
    let existingChannel: DbChannel | null = null;

    // If we have an ID, check by ID FIRST
    if (channelData.id !== undefined) {
      existingChannel = this.getChannelById(channelData.id);
      logger.info(`📝 getChannelById(${channelData.id}) returned: ${existingChannel ? `"${existingChannel.name}"` : 'null'}`);
    }

    if (existingChannel) {
      // Update existing channel (by name match or ID match)
      logger.info(`📝 Updating channel ${existingChannel.id} from "${existingChannel.name}" to "${channelData.name}"`);
      const stmt = this.db.prepare(`
        UPDATE channels SET
          name = ?,
          psk = COALESCE(?, psk),
          role = COALESCE(?, role),
          uplinkEnabled = COALESCE(?, uplinkEnabled),
          downlinkEnabled = COALESCE(?, downlinkEnabled),
          positionPrecision = COALESCE(?, positionPrecision),
          updatedAt = ?
        WHERE id = ?
      `);
      const result = stmt.run(
        channelData.name,
        channelData.psk,
        channelData.role !== undefined ? channelData.role : null,
        channelData.uplinkEnabled !== undefined ? (channelData.uplinkEnabled ? 1 : 0) : null,
        channelData.downlinkEnabled !== undefined ? (channelData.downlinkEnabled ? 1 : 0) : null,
        channelData.positionPrecision !== undefined ? channelData.positionPrecision : null,
        now,
        existingChannel.id
      );
      logger.info(`✅ Updated channel ${existingChannel.id}, changes: ${result.changes}`);
    } else {
      // Create new channel
      logger.debug(`📝 Creating new channel with ID: ${channelData.id !== undefined ? channelData.id : null}`);
      const stmt = this.db.prepare(`
        INSERT INTO channels (id, name, psk, role, uplinkEnabled, downlinkEnabled, positionPrecision, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        channelData.id !== undefined ? channelData.id : null,
        channelData.name,
        channelData.psk || null,
        channelData.role !== undefined ? channelData.role : null,
        channelData.uplinkEnabled !== undefined ? (channelData.uplinkEnabled ? 1 : 0) : 1,
        channelData.downlinkEnabled !== undefined ? (channelData.downlinkEnabled ? 1 : 0) : 1,
        channelData.positionPrecision !== undefined ? channelData.positionPrecision : null,
        now,
        now
      );
      logger.debug(`Created channel: ${channelData.name} (ID: ${channelData.id !== undefined ? channelData.id : 'auto'}), lastInsertRowid: ${result.lastInsertRowid}`);
    }
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
    const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
    const channel = stmt.get(id) as DbChannel | null;
    if (id === 0) {
      logger.info(`🔍 getChannelById(0) - RAW from DB: ${channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'}`);
    }
    return channel ? this.normalizeBigInts(channel) : null;
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
    const stmt = this.db.prepare('SELECT * FROM channels ORDER BY id ASC');
    const channels = stmt.all() as DbChannel[];
    return channels.map(channel => this.normalizeBigInts(channel));
  }

  /**
   * Async version of getAllChannels - works with all database backends
   */
  async getAllChannelsAsync(): Promise<DbChannel[]> {
    if (this.channelsRepo) {
      return this.channelsRepo.getAllChannels() as unknown as DbChannel[];
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getAllChannels();
  }

  /**
   * Async version of getChannelById - works with all database backends
   */
  async getChannelByIdAsync(id: number): Promise<DbChannel | null> {
    if (this.channelsRepo) {
      return this.channelsRepo.getChannelById(id) as unknown as DbChannel | null;
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getChannelById(id);
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
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM channels');
    const result = stmt.get() as { count: number };
    return Number(result.count);
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
    const stmt = this.db.prepare(`DELETE FROM channels WHERE id < 0 OR id > 7`);
    const result = stmt.run();
    logger.debug(`🧹 Cleaned up ${result.changes} invalid channels (outside 0-7 range)`);
    return Number(result.changes);
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
    const stmt = this.db.prepare(`
      DELETE FROM channels
      WHERE id > 1
      AND psk IS NULL
      AND role IS NULL
    `);
    const result = stmt.run();
    logger.debug(`🧹 Cleaned up ${result.changes} empty channels (ID > 1, no PSK/role)`);
    return Number(result.changes);
  }

  // Telemetry operations
  insertTelemetry(telemetryData: DbTelemetry): void {
    // For PostgreSQL/MySQL, fire-and-forget async insert
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.telemetryRepo) {
        // Note: We removed the nodesCache check here because it was too aggressive -
        // it would skip telemetry for nodes that exist in the DB but not in the in-memory cache
        // (e.g., after server restart). The foreign key error handling below handles race conditions.
        this.telemetryRepo.insertTelemetry(telemetryData).catch((error) => {
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

    const stmt = this.db.prepare(`
      INSERT INTO telemetry (
        nodeId, nodeNum, telemetryType, timestamp, value, unit, createdAt, packetTimestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      telemetryData.nodeId,
      telemetryData.nodeNum,
      telemetryData.telemetryType,
      telemetryData.timestamp,
      telemetryData.value,
      telemetryData.unit || null,
      telemetryData.createdAt,
      telemetryData.packetTimestamp || null
    );

    // Invalidate the telemetry types cache since we may have added a new type
    this.invalidateTelemetryTypesCache();
  }

  /**
   * Async version of insertTelemetry - works with all database backends
   */
  async insertTelemetryAsync(telemetryData: DbTelemetry): Promise<void> {
    if (this.telemetryRepo) {
      await this.telemetryRepo.insertTelemetry(telemetryData);
      this.invalidateTelemetryTypesCache();
      return;
    }
    // Fallback to sync for SQLite if repo not ready
    this.insertTelemetry(telemetryData);
  }

  getTelemetryByNode(nodeId: string, limit: number = 100, sinceTimestamp?: number, beforeTimestamp?: number, offset: number = 0, telemetryType?: string): DbTelemetry[] {
    let query = `
      SELECT * FROM telemetry
      WHERE nodeId = ?
    `;
    const params: any[] = [nodeId];

    if (sinceTimestamp !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(sinceTimestamp);
    }

    if (beforeTimestamp !== undefined) {
      query += ` AND timestamp < ?`;
      params.push(beforeTimestamp);
    }

    if (telemetryType !== undefined) {
      query += ` AND telemetryType = ?`;
      params.push(telemetryType);
    }

    query += `
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const telemetry = stmt.all(...params) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  /**
   * Async version of getTelemetryByNode - works with all database backends
   */
  async getTelemetryByNodeAsync(
    nodeId: string,
    limit: number = 100,
    sinceTimestamp?: number,
    beforeTimestamp?: number,
    offset: number = 0,
    telemetryType?: string
  ): Promise<DbTelemetry[]> {
    if (this.telemetryRepo) {
      // Cast to local DbTelemetry type (they have compatible structure)
      return this.telemetryRepo.getTelemetryByNode(nodeId, limit, sinceTimestamp, beforeTimestamp, offset, telemetryType) as unknown as DbTelemetry[];
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getTelemetryByNode(nodeId, limit, sinceTimestamp, beforeTimestamp, offset, telemetryType);
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

    const stmt = this.db.prepare(query);
    const telemetry = stmt.all(...params) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  // Async version of getPositionTelemetryByNode - works for all database backends
  async getPositionTelemetryByNodeAsync(nodeId: string, limit: number = 1500, sinceTimestamp?: number): Promise<DbTelemetry[]> {
    if (this.telemetryRepo) {
      // Cast to local DbTelemetry type (they have compatible structure)
      return this.telemetryRepo.getPositionTelemetryByNode(nodeId, limit, sinceTimestamp) as unknown as Promise<DbTelemetry[]>;
    }
    // Fallback to sync method for SQLite when repo not available
    return this.getPositionTelemetryByNode(nodeId, limit, sinceTimestamp);
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

  /**
   * Get recent estimated positions for a specific node.
   * Returns position estimates with timestamps for time-weighted averaging.
   * @param nodeNum - The node number to get estimates for
   * @param limit - Maximum number of estimates to return (default 10)
   * @returns Array of { latitude, longitude, timestamp } sorted by timestamp descending
   */
  async getRecentEstimatedPositionsAsync(nodeNum: number, limit: number = 10): Promise<Array<{ latitude: number; longitude: number; timestamp: number }>> {
    const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
    if (!this.telemetryRepo) {
      return [];
    }
    return this.telemetryRepo.getRecentEstimatedPositions(nodeId, limit);
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
    if (!this.telemetryRepo) {
      return [];
    }
    return this.telemetryRepo.getSmartHopsStats(nodeId, sinceTimestamp, intervalMinutes);
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
    if (!this.telemetryRepo) {
      return [];
    }
    return this.telemetryRepo.getLinkQualityHistory(nodeId, sinceTimestamp);
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

    const query = `
      SELECT id, fromNodeNum, toNodeNum, route, snrTowards, timestamp
      FROM traceroutes
      WHERE route IS NOT NULL AND route != '[]'
      ORDER BY timestamp ASC
    `;

    const stmt = this.db.prepare(query);
    return stmt.all() as Array<{
      id: number;
      fromNodeNum: number;
      toNodeNum: number;
      route: string | null;
      snrTowards: string | null;
      timestamp: number;
    }>;
  }

  /**
   * Delete all estimated position telemetry records.
   * Used during migration to force recalculation with new algorithm.
   */
  deleteAllEstimatedPositions(): number {
    const stmt = this.db.prepare(`
      DELETE FROM telemetry
      WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')
    `);
    const result = stmt.run();
    return result.changes;
  }

  // Cache for PostgreSQL telemetry data
  private _telemetryCache: Map<string, DbTelemetry[]> = new Map();

  getTelemetryByNodeAveraged(nodeId: string, sinceTimestamp?: number, intervalMinutes?: number, maxHours?: number): DbTelemetry[] {
    // For PostgreSQL/MySQL, use async repo and cache (no averaging yet)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cacheKey = `${nodeId}-${sinceTimestamp || 0}-${maxHours || 24}`;
      if (this.telemetryRepo) {
        // Calculate limit based on maxHours
        const limit = Math.min((maxHours || 24) * 60, 5000); // ~1 per minute, max 5000
        this.telemetryRepo.getTelemetryByNode(nodeId, limit, sinceTimestamp).then(telemetry => {
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

    // Calculate the interval in milliseconds
    const intervalMs = actualIntervalMinutes * 60 * 1000;

    // Telemetry types that should use raw values instead of averaging
    // These are discrete integer values where averaging produces meaningless floats
    const rawValueTypes = ['sats_in_view'];

    // Build the query to group and average telemetry data by time intervals
    // Exclude raw value types from this query - they'll be fetched separately
    let query = `
      SELECT
        nodeId,
        nodeNum,
        telemetryType,
        CAST((timestamp / ?) * ? AS INTEGER) as timestamp,
        AVG(value) as value,
        unit,
        MIN(createdAt) as createdAt
      FROM telemetry
      WHERE nodeId = ?
        AND telemetryType NOT IN (${rawValueTypes.map(() => '?').join(', ')})
    `;
    const params: any[] = [intervalMs, intervalMs, nodeId, ...rawValueTypes];

    if (sinceTimestamp !== undefined) {
      query += ` AND timestamp >= ?`;
      params.push(sinceTimestamp);
    }

    query += `
      GROUP BY
        nodeId,
        nodeNum,
        telemetryType,
        CAST(timestamp / ? AS INTEGER),
        unit
      ORDER BY timestamp DESC
    `;
    params.push(intervalMs);

    // Add limit based on max hours if specified
    // Calculate points per hour based on the actual interval used
    if (maxHours !== undefined) {
      const pointsPerHour = 60 / actualIntervalMinutes;

      // Query the actual number of distinct telemetry types for this node
      // This is more efficient than using a blanket multiplier
      let countQuery = `
        SELECT COUNT(DISTINCT telemetryType) as typeCount
        FROM telemetry
        WHERE nodeId = ?
      `;
      const countParams: any[] = [nodeId];
      if (sinceTimestamp !== undefined) {
        countQuery += ` AND timestamp >= ?`;
        countParams.push(sinceTimestamp);
      }

      const countStmt = this.db.prepare(countQuery);
      const result = countStmt.get(...countParams) as { typeCount: number } | undefined;
      const telemetryTypeCount = result?.typeCount || 1;

      // Calculate limit: expected data points per type × number of types
      // Add 50% padding to account for data density variations and ensure we don't cut off
      const expectedPointsPerType = (maxHours + 1) * pointsPerHour;
      const limit = Math.ceil(expectedPointsPerType * telemetryTypeCount * 1.5);

      query += ` LIMIT ?`;
      params.push(limit);
    }

    const stmt = this.db.prepare(query);
    const telemetry = stmt.all(...params) as DbTelemetry[];

    // Fetch raw values for types that shouldn't be averaged (sparse integer data)
    let rawQuery = `
      SELECT
        nodeId,
        nodeNum,
        telemetryType,
        timestamp,
        value,
        unit,
        createdAt
      FROM telemetry
      WHERE nodeId = ?
        AND telemetryType IN (${rawValueTypes.map(() => '?').join(', ')})
    `;
    const rawParams: any[] = [nodeId, ...rawValueTypes];

    if (sinceTimestamp !== undefined) {
      rawQuery += ` AND timestamp >= ?`;
      rawParams.push(sinceTimestamp);
    }

    rawQuery += ` ORDER BY timestamp DESC`;

    // Apply same limit logic for raw data
    if (maxHours !== undefined) {
      // For raw data, limit based on expected frequency (~10 per hour max for position data)
      const rawLimit = Math.ceil((maxHours + 1) * 10 * rawValueTypes.length * 1.5);
      rawQuery += ` LIMIT ?`;
      rawParams.push(rawLimit);
    }

    const rawStmt = this.db.prepare(rawQuery);
    const rawTelemetry = rawStmt.all(...rawParams) as DbTelemetry[];

    // Combine averaged and raw telemetry
    const combined = [...telemetry, ...rawTelemetry];
    return combined.map(t => this.normalizeBigInts(t));
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
    sinceTimestamp?: number
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

    query += ` ORDER BY telemetryType, timestamp ASC`;

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

  insertTraceroute(tracerouteData: DbTraceroute): void {
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
              pendingTimeoutAgo
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
              await this.traceroutesRepo!.insertTraceroute(tracerouteData);
            }

            // Cleanup old traceroutes
            await this.traceroutesRepo!.cleanupOldTraceroutesForPair(
              tracerouteData.fromNodeNum,
              tracerouteData.toNodeNum,
              TRACEROUTE_HISTORY_LIMIT
            );
          } catch (error) {
            logger.error('[DatabaseService] Failed to insert traceroute:', error);
          }
        })();
      }
      return;
    }

    // SQLite: Wrap in transaction to prevent race conditions
    const transaction = this.db.transaction(() => {
      const now = Date.now();
      const pendingTimeoutAgo = now - PENDING_TRACEROUTE_TIMEOUT_MS;

      // Check if there's a pending traceroute request (with null route) within the timeout window
      // NOTE: When a traceroute response comes in, fromNum is the destination (responder) and toNum is the local node (requester)
      // But when we created the pending record, fromNodeNum was the local node and toNodeNum was the destination
      // So we need to check the REVERSE direction (toNum -> fromNum instead of fromNum -> toNum)
      const findPendingStmt = this.db.prepare(`
        SELECT id FROM traceroutes
        WHERE fromNodeNum = ? AND toNodeNum = ?
        AND route IS NULL
        AND timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT 1
      `);

      const pendingRecord = findPendingStmt.get(
        tracerouteData.toNodeNum,    // Reversed: response's toNum is the requester
        tracerouteData.fromNodeNum,  // Reversed: response's fromNum is the destination
        pendingTimeoutAgo
      ) as { id: number } | undefined;

      if (pendingRecord) {
        // Update the existing pending record with the response data
        const updateStmt = this.db.prepare(`
          UPDATE traceroutes
          SET route = ?, routeBack = ?, snrTowards = ?, snrBack = ?, timestamp = ?
          WHERE id = ?
        `);

        updateStmt.run(
          tracerouteData.route || null,
          tracerouteData.routeBack || null,
          tracerouteData.snrTowards || null,
          tracerouteData.snrBack || null,
          tracerouteData.timestamp,
          pendingRecord.id
        );
      } else {
        // No pending request found, insert a new traceroute record
        const insertStmt = this.db.prepare(`
          INSERT INTO traceroutes (
            fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, routeBack, snrTowards, snrBack, timestamp, createdAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        insertStmt.run(
          tracerouteData.fromNodeNum,
          tracerouteData.toNodeNum,
          tracerouteData.fromNodeId,
          tracerouteData.toNodeId,
          tracerouteData.route || null,
          tracerouteData.routeBack || null,
          tracerouteData.snrTowards || null,
          tracerouteData.snrBack || null,
          tracerouteData.timestamp,
          tracerouteData.createdAt
        );
      }

      // Keep only the last N traceroutes for this source-destination pair
      // Delete older traceroutes beyond the limit
      const deleteOldStmt = this.db.prepare(`
        DELETE FROM traceroutes
        WHERE fromNodeNum = ? AND toNodeNum = ?
        AND id NOT IN (
          SELECT id FROM traceroutes
          WHERE fromNodeNum = ? AND toNodeNum = ?
          ORDER BY timestamp DESC
          LIMIT ?
        )
      `);
      deleteOldStmt.run(
        tracerouteData.fromNodeNum,
        tracerouteData.toNodeNum,
        tracerouteData.fromNodeNum,
        tracerouteData.toNodeNum,
        TRACEROUTE_HISTORY_LIMIT
      );
    });

    transaction();
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
    // This is especially important for 3rd party traceroutes (e.g., via Virtual Node)
    // where the stored direction might be reversed from what's being queried
    const stmt = this.db.prepare(`
      SELECT * FROM traceroutes
      WHERE (fromNodeNum = ? AND toNodeNum = ?) OR (fromNodeNum = ? AND toNodeNum = ?)
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const traceroutes = stmt.all(fromNodeNum, toNodeNum, toNodeNum, fromNodeNum, limit) as DbTraceroute[];
    return traceroutes.map(t => this.normalizeBigInts(t));
  }

  /**
   * Async version of getTraceroutesByNodes for PostgreSQL/MySQL
   */
  async getTraceroutesByNodesAsync(fromNodeNum: number, toNodeNum: number, limit: number = 10): Promise<DbTraceroute[]> {
    if (this.traceroutesRepo) {
      const traceroutes = await this.traceroutesRepo.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit);
      return traceroutes.map(t => ({
        ...t,
        route: t.route || '',
        routeBack: t.routeBack || '',
        snrTowards: t.snrTowards || '',
        snrBack: t.snrBack || '',
      })) as DbTraceroute[];
    }

    // Fallback to sync for SQLite
    return this.getTraceroutesByNodes(fromNodeNum, toNodeNum, limit);
  }

  getAllTraceroutes(limit: number = 100): DbTraceroute[] {
    // For PostgreSQL/MySQL, use cached traceroutes or return empty
    // Traceroute data is primarily real-time from mesh traffic
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Use traceroutesRepo if available - fire async and return cache
      if (this.traceroutesRepo) {
        // Fire async query and update cache in background
        this.traceroutesRepo.getAllTraceroutes(limit).then(traceroutes => {
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

    const stmt = this.db.prepare(`
      SELECT * FROM traceroutes
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const traceroutes = stmt.all(limit) as DbTraceroute[];
    return traceroutes.map(t => this.normalizeBigInts(t));
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

    // Get all nodes that are eligible for traceroute based on their status
    // Only consider nodes that have been heard within maxNodeAgeHours (active nodes)
    // Two categories:
    // 1. Nodes with no successful traceroute: retry every 3 hours
    // 2. Nodes with successful traceroute: retry every 24 hours
    const stmt = this.db.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM traceroutes t
         WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) as hasTraceroute
      FROM nodes n
      WHERE n.nodeNum != ?
        AND n.lastHeard > ?
        AND (
          -- Category 1: No traceroute exists, and (never requested OR requested > 3 hours ago)
          (
            (SELECT COUNT(*) FROM traceroutes t
             WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) = 0
            AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ?)
          )
          OR
          -- Category 2: Traceroute exists, and (never requested OR requested > expiration hours ago)
          (
            (SELECT COUNT(*) FROM traceroutes t
             WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) > 0
            AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ?)
          )
        )
      ORDER BY n.lastHeard DESC
    `);

    let eligibleNodes = stmt.all(
      localNodeNum,
      localNodeNum,
      activeNodeCutoff,
      localNodeNum,
      now - THREE_HOURS_MS,
      localNodeNum,
      now - EXPIRATION_MS
    ) as DbNode[];

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
  async getNodeNeedingTracerouteAsync(localNodeNum: number): Promise<DbNode | null> {
    const now = Date.now();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const expirationHours = this.getTracerouteExpirationHours();
    const EXPIRATION_MS = expirationHours * 60 * 60 * 1000;

    // Get maxNodeAgeHours setting to filter only active nodes
    // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
    const maxNodeAgeHours = parseInt(this.getSetting('maxNodeAgeHours') || '24');
    const activeNodeCutoff = Math.floor(Date.now() / 1000) - (maxNodeAgeHours * 60 * 60);

    // For SQLite, fallback to sync method
    if (this.drizzleDbType === 'sqlite' || !this.nodesRepo) {
      return this.getNodeNeedingTraceroute(localNodeNum);
    }

    try {
      // Get eligible nodes from repository
      let eligibleNodes = await this.nodesRepo.getEligibleNodesForTraceroute(
        localNodeNum,
        activeNodeCutoff,
        now - THREE_HOURS_MS,
        now - EXPIRATION_MS
      );

      // Check if node filter is enabled
      const filterEnabled = this.isAutoTracerouteNodeFilterEnabled();

      if (filterEnabled) {
        // Get all filter settings (use async for specificNodes)
        const specificNodes = await this.getAutoTracerouteNodesAsync();
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
    } catch (error) {
      logger.error('Error in getNodeNeedingTracerouteAsync:', error);
      return null;
    }
  }

  /**
   * Get a node that needs remote admin checking.
   * Returns null if no nodes need checking.
   */
  async getNodeNeedingRemoteAdminCheckAsync(localNodeNum: number): Promise<DbNode | null> {
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
          expirationMsAgo
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
    metadata: string | null
  ): Promise<void> {
    try {
      if (this.nodesRepo) {
        await this.nodesRepo.updateNodeRemoteAdminStatusAsync(nodeNum, hasRemoteAdmin, metadata);
      }

      // Update cache for PostgreSQL/MySQL
      if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
        const existingNode = this.nodesCache.get(nodeNum);
        if (existingNode) {
          existingNode.hasRemoteAdmin = hasRemoteAdmin;
          existingNode.lastRemoteAdminCheck = Date.now();
          existingNode.remoteAdminMetadata = metadata ?? undefined;
          existingNode.updatedAt = Date.now();
          this.nodesCache.set(nodeNum, existingNode);
        }
      }
    } catch (error) {
      logger.error('Error in updateNodeRemoteAdminStatusAsync:', error);
    }
  }

  recordTracerouteRequest(fromNodeNum: number, toNodeNum: number): void {
    const now = Date.now();

    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Fire async operations
      (async () => {
        try {
          // Update the nodes table with last request time
          if (this.nodesRepo) {
            await this.nodesRepo.updateNodeLastTracerouteRequest(toNodeNum, now);
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
            });

            // Cleanup old traceroutes
            await this.traceroutesRepo.cleanupOldTraceroutesForPair(
              fromNodeNum,
              toNodeNum,
              TRACEROUTE_HISTORY_LIMIT
            );
          }
        } catch (error) {
          logger.error('[DatabaseService] Failed to record traceroute request:', error);
        }
      })();
      return;
    }

    // SQLite path
    // Update the nodes table with last request time
    const updateStmt = this.db.prepare(`
      UPDATE nodes SET lastTracerouteRequest = ? WHERE nodeNum = ?
    `);
    updateStmt.run(now, toNodeNum);

    // Insert a traceroute record for the attempt (with null routes indicating pending)
    const fromNodeId = `!${fromNodeNum.toString(16).padStart(8, '0')}`;
    const toNodeId = `!${toNodeNum.toString(16).padStart(8, '0')}`;

    const insertStmt = this.db.prepare(`
      INSERT INTO traceroutes (
        fromNodeNum, toNodeNum, fromNodeId, toNodeId, route, routeBack, snrTowards, snrBack, timestamp, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      fromNodeNum,
      toNodeNum,
      fromNodeId,
      toNodeId,
      null, // route will be null until response received
      null, // routeBack will be null until response received
      null, // snrTowards will be null until response received
      null, // snrBack will be null until response received
      now,
      now
    );

    // Keep only the last N traceroutes for this source-destination pair
    const deleteOldStmt = this.db.prepare(`
      DELETE FROM traceroutes
      WHERE fromNodeNum = ? AND toNodeNum = ?
      AND id NOT IN (
        SELECT id FROM traceroutes
        WHERE fromNodeNum = ? AND toNodeNum = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    deleteOldStmt.run(fromNodeNum, toNodeNum, fromNodeNum, toNodeNum, TRACEROUTE_HISTORY_LIMIT);
  }

  // Auto-traceroute node filter methods
  getAutoTracerouteNodes(): number[] {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'getAutoTracerouteNodes' called but using ${this.drizzleDbType} database. Use getAutoTracerouteNodesAsync() instead.`);
    }
    const stmt = this.db.prepare(`
      SELECT nodeNum FROM auto_traceroute_nodes
      ORDER BY createdAt ASC
    `);
    const nodes = stmt.all() as { nodeNum: number }[];
    return nodes.map(n => Number(n.nodeNum));
  }

  async getAutoTracerouteNodesAsync(): Promise<number[]> {
    if (this.miscRepo) {
      return await this.miscRepo.getAutoTracerouteNodes();
    }
    // Fallback to sync method for SQLite
    return this.getAutoTracerouteNodes();
  }

  setAutoTracerouteNodes(nodeNums: number[]): void {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'setAutoTracerouteNodes' called but using ${this.drizzleDbType} database. Use setAutoTracerouteNodesAsync() instead.`);
    }
    const now = Date.now();

    // Use a transaction for atomic operation
    const deleteStmt = this.db.prepare('DELETE FROM auto_traceroute_nodes');
    const insertStmt = this.db.prepare(`
      INSERT INTO auto_traceroute_nodes (nodeNum, createdAt)
      VALUES (?, ?)
    `);

    this.db.transaction(() => {
      // Clear existing entries
      deleteStmt.run();

      // Insert new entries
      for (const nodeNum of nodeNums) {
        try {
          insertStmt.run(nodeNum, now);
        } catch (error) {
          // Ignore duplicate entries or foreign key violations
          logger.debug(`Skipping invalid nodeNum: ${nodeNum}`, error);
        }
      }
    })();

    logger.debug(`✅ Set auto-traceroute filter to ${nodeNums.length} nodes`);
  }

  async setAutoTracerouteNodesAsync(nodeNums: number[]): Promise<void> {
    if (this.miscRepo) {
      await this.miscRepo.setAutoTracerouteNodes(nodeNums);
      logger.debug(`✅ Set auto-traceroute filter to ${nodeNums.length} nodes`);
      return;
    }
    // Fallback to sync method for SQLite
    this.setAutoTracerouteNodes(nodeNums);
  }

  // Solar Estimates methods
  async upsertSolarEstimateAsync(timestamp: number, wattHours: number, fetchedAt: number): Promise<void> {
    if (this.miscRepo) {
      await this.miscRepo.upsertSolarEstimate({
        timestamp,
        watt_hours: wattHours,
        fetched_at: fetchedAt,
      });
      return;
    }
    // Fallback to sync SQLite method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'upsertSolarEstimate' called but using ${this.drizzleDbType} database. MiscRepository not initialized.`);
    }
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO solar_estimates (timestamp, watt_hours, fetched_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(timestamp, wattHours, fetchedAt);
  }

  async getRecentSolarEstimatesAsync(limit: number = 100): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    if (this.miscRepo) {
      return await this.miscRepo.getRecentSolarEstimates(limit);
    }
    // Fallback to sync SQLite method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'getRecentSolarEstimates' called but using ${this.drizzleDbType} database. MiscRepository not initialized.`);
    }
    const stmt = this.db.prepare(`
      SELECT timestamp, watt_hours, fetched_at
      FROM solar_estimates
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(limit) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
  }

  async getSolarEstimatesInRangeAsync(startTimestamp: number, endTimestamp: number): Promise<Array<{ timestamp: number; watt_hours: number; fetched_at: number }>> {
    if (this.miscRepo) {
      return await this.miscRepo.getSolarEstimatesInRange(startTimestamp, endTimestamp);
    }
    // Fallback to sync SQLite method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      throw new Error(`SQLite method 'getSolarEstimatesInRange' called but using ${this.drizzleDbType} database. MiscRepository not initialized.`);
    }
    const stmt = this.db.prepare(`
      SELECT timestamp, watt_hours, fetched_at
      FROM solar_estimates
      WHERE timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `);
    return stmt.all(startTimestamp, endTimestamp) as Array<{ timestamp: number; watt_hours: number; fetched_at: number }>;
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

  // Get the traceroute expiration hours (how long to wait before re-tracerouting a node)
  getTracerouteExpirationHours(): number {
    const value = this.getSetting('tracerouteExpirationHours');
    if (value === null) {
      return 24; // Default to 24 hours
    }
    const hours = parseInt(value, 10);
    // Validate range (1-168 hours, i.e., 1 hour to 1 week)
    if (isNaN(hours) || hours < 1 || hours > 168) {
      return 24;
    }
    return hours;
  }

  setTracerouteExpirationHours(hours: number): void {
    // Validate range (1-168 hours, i.e., 1 hour to 1 week)
    if (hours < 1 || hours > 168) {
      throw new Error('Traceroute expiration hours must be between 1 and 168 (1 week)');
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
    logger.debug('✅ Updated all traceroute filter settings');
  }

  // Async versions of traceroute filter settings methods
  async getTracerouteFilterSettingsAsync(): Promise<{
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
  }> {
    const nodeNums = await this.getAutoTracerouteNodesAsync();
    return {
      enabled: this.isAutoTracerouteNodeFilterEnabled(),
      nodeNums,
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
  }): Promise<void> {
    this.setAutoTracerouteNodeFilterEnabled(settings.enabled);
    await this.setAutoTracerouteNodesAsync(settings.nodeNums);
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
    logger.debug('✅ Updated all traceroute filter settings');
  }

  // Auto-traceroute log methods
  logAutoTracerouteAttempt(toNodeNum: number, toNodeName: string | null): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO auto_traceroute_log (timestamp, to_node_num, to_node_name, success, created_at)
      VALUES (?, ?, ?, NULL, ?)
    `);
    const result = stmt.run(now, toNodeNum, toNodeName, now);

    // Clean up old entries (keep last 100)
    const cleanupStmt = this.db.prepare(`
      DELETE FROM auto_traceroute_log
      WHERE id NOT IN (
        SELECT id FROM auto_traceroute_log
        ORDER BY timestamp DESC
        LIMIT 100
      )
    `);
    cleanupStmt.run();

    return result.lastInsertRowid as number;
  }

  updateAutoTracerouteResult(logId: number, success: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE auto_traceroute_log SET success = ? WHERE id = ?
    `);
    stmt.run(success ? 1 : 0, logId);
  }

  // Update the most recent pending auto-traceroute for a given destination
  updateAutoTracerouteResultByNode(toNodeNum: number, success: boolean): void {
    const stmt = this.db.prepare(`
      UPDATE auto_traceroute_log
      SET success = ?
      WHERE id = (
        SELECT id FROM auto_traceroute_log
        WHERE to_node_num = ? AND success IS NULL
        ORDER BY timestamp DESC
        LIMIT 1
      )
    `);
    stmt.run(success ? 1 : 0, toNodeNum);
  }

  getAutoTracerouteLog(limit: number = 10): {
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

    const stmt = this.db.prepare(`
      SELECT id, timestamp, to_node_num as toNodeNum, to_node_name as toNodeName, success
      FROM auto_traceroute_log
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const results = stmt.all(limit) as {
      id: number;
      timestamp: number;
      toNodeNum: number;
      toNodeName: string | null;
      success: number | null;
    }[];

    return results.map(r => ({
      ...r,
      success: r.success === null ? null : r.success === 1
    }));
  }

  /**
   * Async version of getAutoTracerouteLog - works with all database backends
   */
  async getAutoTracerouteLogAsync(limit: number = 10): Promise<{
    id: number;
    timestamp: number;
    toNodeNum: number;
    toNodeName: string | null;
    success: boolean | null;
  }[]> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.getAutoTracerouteLog(limit);
    }

    try {
      let results: any[] = [];

      if (this.drizzleDbType === 'postgres' && this.postgresPool) {
        const result = await this.postgresPool.query(
          `SELECT id, timestamp, to_node_num, to_node_name, success FROM auto_traceroute_log ORDER BY timestamp DESC LIMIT $1`,
          [limit]
        );
        results = result.rows || [];
      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        const [rows] = await this.mysqlPool.query(
          `SELECT id, timestamp, to_node_num, to_node_name, success FROM auto_traceroute_log ORDER BY timestamp DESC LIMIT ?`,
          [limit]
        );
        results = rows as any[] || [];
      }

      return results.map((r: any) => ({
        id: Number(r.id),
        timestamp: Number(r.timestamp),
        toNodeNum: Number(r.to_node_num),
        toNodeName: r.to_node_name,
        success: r.success === null ? null : Boolean(r.success)
      }));
    } catch (error) {
      logger.error(`[DatabaseService] Failed to get auto traceroute log async: ${error}`);
      return [];
    }
  }

  /**
   * Async version of logAutoTracerouteAttempt - works with all database backends
   */
  async logAutoTracerouteAttemptAsync(toNodeNum: number, toNodeName: string | null): Promise<number> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.logAutoTracerouteAttempt(toNodeNum, toNodeName);
    }

    const now = Date.now();

    try {
      let insertedId = 0;

      if (this.drizzleDbType === 'postgres' && this.postgresPool) {
        const result = await this.postgresPool.query(
          `INSERT INTO auto_traceroute_log (timestamp, to_node_num, to_node_name, success, created_at)
           VALUES ($1, $2, $3, NULL, $4) RETURNING id`,
          [now, toNodeNum, toNodeName, now]
        );
        insertedId = result.rows[0]?.id || 0;

        // Clean up old entries (keep last 100)
        await this.postgresPool.query(`
          DELETE FROM auto_traceroute_log
          WHERE id NOT IN (
            SELECT id FROM auto_traceroute_log
            ORDER BY timestamp DESC
            LIMIT 100
          )
        `);
      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        const [result] = await this.mysqlPool.query(
          `INSERT INTO auto_traceroute_log (timestamp, to_node_num, to_node_name, success, created_at)
           VALUES (?, ?, ?, NULL, ?)`,
          [now, toNodeNum, toNodeName, now]
        ) as any;
        insertedId = result.insertId || 0;

        // Clean up old entries (keep last 100)
        await this.mysqlPool.query(`
          DELETE FROM auto_traceroute_log
          WHERE id NOT IN (
            SELECT id FROM (
              SELECT id FROM auto_traceroute_log
              ORDER BY timestamp DESC
              LIMIT 100
            ) AS keep_ids
          )
        `);
      }

      return insertedId;
    } catch (error) {
      logger.error(`[DatabaseService] Failed to log auto traceroute attempt async: ${error}`);
      return 0;
    }
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

    try {
      if (this.drizzleDbType === 'postgres' && this.postgresPool) {
        await this.postgresPool.query(`
          UPDATE auto_traceroute_log
          SET success = $1
          WHERE id = (
            SELECT id FROM auto_traceroute_log
            WHERE to_node_num = $2 AND success IS NULL
            ORDER BY timestamp DESC
            LIMIT 1
          )
        `, [success ? 1 : 0, toNodeNum]);
      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        await this.mysqlPool.query(`
          UPDATE auto_traceroute_log
          SET success = ?
          WHERE id = (
            SELECT id FROM (
              SELECT id FROM auto_traceroute_log
              WHERE to_node_num = ? AND success IS NULL
              ORDER BY timestamp DESC
              LIMIT 1
            ) AS subq
          )
        `, [success ? 1 : 0, toNodeNum]);
      }
    } catch (error) {
      logger.error(`[DatabaseService] Failed to update auto traceroute result async: ${error}`);
    }
  }

  // Auto key repair state methods
  getKeyRepairState(nodeNum: number): {
    nodeNum: number;
    attemptCount: number;
    lastAttemptTime: number | null;
    exhausted: boolean;
    startedAt: number;
  } | null {
    // For PostgreSQL/MySQL, key repair state is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }

    const stmt = this.db.prepare(`
      SELECT nodeNum, attemptCount, lastAttemptTime, exhausted, startedAt
      FROM auto_key_repair_state
      WHERE nodeNum = ?
    `);
    const result = stmt.get(nodeNum) as {
      nodeNum: number;
      attemptCount: number;
      lastAttemptTime: number | null;
      exhausted: number;
      startedAt: number;
    } | undefined;

    if (!result) return null;

    return {
      ...result,
      exhausted: result.exhausted === 1
    };
  }

  setKeyRepairState(nodeNum: number, state: {
    attemptCount?: number;
    lastAttemptTime?: number;
    exhausted?: boolean;
    startedAt?: number;
  }): void {
    // For PostgreSQL/MySQL, key repair state is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug(`setKeyRepairState not yet implemented for PostgreSQL/MySQL`);
      return;
    }

    const existing = this.getKeyRepairState(nodeNum);
    const now = Date.now();

    if (existing) {
      // Update existing state
      const stmt = this.db.prepare(`
        UPDATE auto_key_repair_state
        SET attemptCount = ?, lastAttemptTime = ?, exhausted = ?
        WHERE nodeNum = ?
      `);
      stmt.run(
        state.attemptCount ?? existing.attemptCount,
        state.lastAttemptTime ?? existing.lastAttemptTime,
        (state.exhausted ?? existing.exhausted) ? 1 : 0,
        nodeNum
      );
    } else {
      // Insert new state
      const stmt = this.db.prepare(`
        INSERT INTO auto_key_repair_state (nodeNum, attemptCount, lastAttemptTime, exhausted, startedAt)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(
        nodeNum,
        state.attemptCount ?? 0,
        state.lastAttemptTime ?? null,
        (state.exhausted ?? false) ? 1 : 0,
        state.startedAt ?? now
      );
    }
  }

  clearKeyRepairState(nodeNum: number): void {
    // For PostgreSQL/MySQL, key repair state is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug(`clearKeyRepairState not yet implemented for PostgreSQL/MySQL`);
      return;
    }

    const stmt = this.db.prepare(`
      DELETE FROM auto_key_repair_state
      WHERE nodeNum = ?
    `);
    stmt.run(nodeNum);
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
    // For PostgreSQL/MySQL, key repair state is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Return nodes with keyMismatchDetected from cache, without attempt tracking
      const result: {
        nodeNum: number;
        nodeId: string;
        longName: string | null;
        shortName: string | null;
        attemptCount: number;
        lastAttemptTime: number | null;
        startedAt: number | null;
      }[] = [];
      for (const node of this.nodesCache.values()) {
        if (node.keyMismatchDetected) {
          result.push({
            nodeNum: node.nodeNum,
            nodeId: node.nodeId,
            longName: node.longName ?? null,
            shortName: node.shortName ?? null,
            attemptCount: 0,
            lastAttemptTime: null,
            startedAt: null,
          });
        }
      }
      return result;
    }

    // Get nodes with keyMismatchDetected=true that are not exhausted
    const stmt = this.db.prepare(`
      SELECT
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
        AND (s.exhausted IS NULL OR s.exhausted = 0)
    `);
    return stmt.all() as {
      nodeNum: number;
      nodeId: string;
      longName: string | null;
      shortName: string | null;
      attemptCount: number;
      lastAttemptTime: number | null;
      startedAt: number | null;
    }[];
  }

  // Auto key repair log methods
  logKeyRepairAttempt(nodeNum: number, nodeName: string | null, action: string, success: boolean | null = null): number {
    // For PostgreSQL/MySQL, key repair logging is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      logger.debug(`logKeyRepairAttempt not yet implemented for PostgreSQL/MySQL: ${action} for node ${nodeNum}`);
      return 0;
    }

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO auto_key_repair_log (timestamp, nodeNum, nodeName, action, success, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(now, nodeNum, nodeName, action, success === null ? null : (success ? 1 : 0), now);

    // Clean up old entries (keep last 100)
    const cleanupStmt = this.db.prepare(`
      DELETE FROM auto_key_repair_log
      WHERE id NOT IN (
        SELECT id FROM auto_key_repair_log
        ORDER BY timestamp DESC
        LIMIT 100
      )
    `);
    cleanupStmt.run();

    return result.lastInsertRowid as number;
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

    const stmt = this.db.prepare(`
      SELECT id, timestamp, nodeNum, nodeName, action, success
      FROM auto_key_repair_log
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const results = stmt.all(limit) as {
      id: number;
      timestamp: number;
      nodeNum: number;
      nodeName: string | null;
      action: string;
      success: number | null;
    }[];

    return results.map(r => ({
      ...r,
      success: r.success === null ? null : r.success === 1
    }));
  }

  getTelemetryByType(telemetryType: string, limit: number = 100): DbTelemetry[] {
    // For PostgreSQL/MySQL, telemetry is async - return empty for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM telemetry
      WHERE telemetryType = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const telemetry = stmt.all(telemetryType, limit) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  /**
   * Async version of getTelemetryByType - works with all database backends
   */
  async getTelemetryByTypeAsync(telemetryType: string, limit: number = 100): Promise<DbTelemetry[]> {
    if (this.telemetryRepo) {
      // Cast to local DbTelemetry type (they have compatible structure)
      return this.telemetryRepo.getTelemetryByType(telemetryType, limit) as unknown as DbTelemetry[];
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getTelemetryByType(telemetryType, limit);
  }

  getLatestTelemetryByNode(nodeId: string): DbTelemetry[] {
    // For PostgreSQL/MySQL, telemetry is async - return empty for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM telemetry t1
      WHERE nodeId = ? AND timestamp = (
        SELECT MAX(timestamp) FROM telemetry t2
        WHERE t2.nodeId = t1.nodeId AND t2.telemetryType = t1.telemetryType
      )
      ORDER BY telemetryType ASC
    `);
    const telemetry = stmt.all(nodeId) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  getLatestTelemetryForType(nodeId: string, telemetryType: string): DbTelemetry | null {
    // For PostgreSQL/MySQL, telemetry is not cached - return null for sync calls
    // This is used for checking node capabilities, not critical for operation
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Telemetry queries require async, so return null for sync interface
      // The actual data will be fetched via API endpoints which can be async
      return null;
    }
    const stmt = this.db.prepare(`
      SELECT * FROM telemetry
      WHERE nodeId = ? AND telemetryType = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const telemetry = stmt.get(nodeId, telemetryType) as DbTelemetry | null;
    return telemetry ? this.normalizeBigInts(telemetry) : null;
  }

  /**
   * Async version of getLatestTelemetryForType - works with all database backends
   */
  async getLatestTelemetryForTypeAsync(nodeId: string, telemetryType: string): Promise<DbTelemetry | null> {
    if (this.telemetryRepo) {
      const result = await this.telemetryRepo.getLatestTelemetryForType(nodeId, telemetryType);
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
    // Fallback to sync for SQLite if repo not ready
    return this.getLatestTelemetryForType(nodeId, telemetryType);
  }

  // Get distinct telemetry types per node (efficient for checking capabilities)
  getNodeTelemetryTypes(nodeId: string): string[] {
    // For PostgreSQL/MySQL, return empty array for sync calls
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    const stmt = this.db.prepare(`
      SELECT DISTINCT telemetryType FROM telemetry
      WHERE nodeId = ?
    `);
    const results = stmt.all(nodeId) as Array<{ telemetryType: string }>;
    return results.map(r => r.telemetryType);
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
    const stmt = this.db.prepare(`
      SELECT nodeId, GROUP_CONCAT(DISTINCT telemetryType) as types
      FROM telemetry
      GROUP BY nodeId
    `);
    const results = stmt.all() as Array<{ nodeId: string; types: string }>;
    const map = new Map<string, string[]>();
    results.forEach(r => {
      map.set(r.nodeId, r.types ? r.types.split(',') : []);
    });

    this.telemetryTypesCache = map;
    this.telemetryTypesCacheTime = now;

    return map;
  }

  // Invalidate the telemetry types cache (call when new telemetry is inserted)
  invalidateTelemetryTypesCache(): void {
    this.telemetryTypesCache = null;
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
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM telemetry');
    this.db.exec('DELETE FROM traceroutes');
    this.db.exec('DELETE FROM route_segments');
    this.db.exec('DELETE FROM neighbor_info');
    // Finally delete the nodes themselves
    this.db.exec('DELETE FROM nodes');
    logger.debug('✅ Successfully purged all nodes and related data');
  }

  purgeAllTelemetry(): void {
    logger.debug('⚠️ PURGING all telemetry from database');
    this.db.exec('DELETE FROM telemetry');
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
      const stmt = this.db.prepare('DELETE FROM telemetry WHERE timestamp < ?');
      const result = stmt.run(regularCutoffTime);
      logger.debug(`🧹 Purged ${result.changes} old telemetry records (keeping last ${hoursToKeep} hours)`);
      return Number(result.changes);
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
      const stmt = this.db.prepare('DELETE FROM telemetry WHERE timestamp < ?');
      const result = stmt.run(regularCutoffTime);
      logger.debug(`🧹 Purged ${result.changes} old telemetry records (keeping last ${hoursToKeep} hours, no favorites)`);
      return Number(result.changes);
    }

    // Calculate the cutoff time for favorited telemetry
    const favoriteCutoffTime = Date.now() - (favoriteDaysToKeep * 24 * 60 * 60 * 1000);

    // Build a query to purge old telemetry, exempting favorited telemetry
    // Purge non-favorited telemetry older than hoursToKeep
    // Purge favorited telemetry older than favoriteDaysToKeep
    let totalDeleted = 0;

    // First, delete non-favorited telemetry older than regularCutoffTime
    const conditions = favorites.map(() => '(nodeId = ? AND telemetryType = ?)').join(' OR ');
    const params = favorites.flatMap(f => [f.nodeId, f.telemetryType]);

    const deleteNonFavoritesStmt = this.db.prepare(
      `DELETE FROM telemetry WHERE timestamp < ? AND NOT (${conditions})`
    );
    const nonFavoritesResult = deleteNonFavoritesStmt.run(regularCutoffTime, ...params);
    totalDeleted += Number(nonFavoritesResult.changes);

    // Then, delete favorited telemetry older than favoriteCutoffTime
    const deleteFavoritesStmt = this.db.prepare(
      `DELETE FROM telemetry WHERE timestamp < ? AND (${conditions})`
    );
    const favoritesResult = deleteFavoritesStmt.run(favoriteCutoffTime, ...params);
    totalDeleted += Number(favoritesResult.changes);

    logger.debug(
      `🧹 Purged ${totalDeleted} old telemetry records ` +
      `(${nonFavoritesResult.changes} non-favorites older than ${hoursToKeep}h, ` +
      `${favoritesResult.changes} favorites older than ${favoriteDaysToKeep}d)`
    );
    return totalDeleted;
  }

  purgeAllMessages(): void {
    logger.debug('⚠️ PURGING all messages from database');
    this.db.exec('DELETE FROM messages');
  }

  purgeAllTraceroutes(): void {
    logger.debug('⚠️ PURGING all traceroutes and route segments from database');
    this.db.exec('DELETE FROM traceroutes');
    this.db.exec('DELETE FROM route_segments');
    logger.debug('✅ Successfully purged all traceroutes and route segments');
  }

  // Settings methods
  getSetting(key: string): string | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (!this.cacheInitialized) {
        logger.debug(`getSetting('${key}') called before cache initialized`);
        return null;
      }
      return this.settingsCache.get(key) ?? null;
    }
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Async version of getSetting - works with all database backends
   */
  async getSettingAsync(key: string): Promise<string | null> {
    if (this.settingsRepo) {
      return this.settingsRepo.getSetting(key);
    }
    // Fallback to sync for SQLite if repo not ready
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
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  /**
   * Async version of getAllSettings - works with all database backends
   */
  async getAllSettingsAsync(): Promise<Record<string, string>> {
    if (this.settingsRepo) {
      return this.settingsRepo.getAllSettings();
    }
    // Fallback to sync for SQLite if repo not ready
    return this.getAllSettings();
  }

  setSetting(key: string, value: string): void {
    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Update cache immediately for sync access
      this.settingsCache.set(key, value);
      // Fire and forget async version
      this.setSettingAsync(key, value).catch(err => {
        logger.error(`Failed to set setting ${key}:`, err);
      });
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updatedAt = excluded.updatedAt
    `);
    stmt.run(key, value, now, now);
  }

  /**
   * Async version of setSetting - works with all database backends
   */
  async setSettingAsync(key: string, value: string): Promise<void> {
    if (this.settingsRepo) {
      await this.settingsRepo.setSetting(key, value);
      return;
    }
    // Fallback to sync for SQLite if repo not ready
    this.setSetting(key, value);
  }

  setSettings(settings: Record<string, string>): void {
    // For PostgreSQL/MySQL, use async repo and update cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Update cache immediately for sync access
      for (const [key, value] of Object.entries(settings)) {
        this.settingsCache.set(key, value);
      }
      this.setSettingsAsync(settings).catch(err => {
        logger.error('Failed to set settings:', err);
      });
      return;
    }
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updatedAt = excluded.updatedAt
    `);

    this.db.transaction(() => {
      Object.entries(settings).forEach(([key, value]) => {
        stmt.run(key, value, now, now);
      });
    })();
  }

  /**
   * Async version of setSettings - works with all database backends
   */
  async setSettingsAsync(settings: Record<string, string>): Promise<void> {
    if (this.settingsRepo) {
      await this.settingsRepo.setSettings(settings);
      return;
    }
    // Fallback to sync for SQLite if repo not ready
    this.setSettings(settings);
  }

  deleteAllSettings(): void {
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Clear cache immediately
      this.settingsCache.clear();
      this.deleteAllSettingsAsync().catch(err => {
        logger.error('Failed to delete all settings:', err);
      });
      return;
    }
    logger.debug('🔄 Resetting all settings to defaults');
    this.db.exec('DELETE FROM settings');
  }

  /**
   * Async version of deleteAllSettings - works with all database backends
   */
  async deleteAllSettingsAsync(): Promise<void> {
    if (this.settingsRepo) {
      await this.settingsRepo.deleteAllSettings();
      return;
    }
    // Fallback to sync for SQLite if repo not ready
    this.deleteAllSettings();
  }

  // ============ ASYNC NOTIFICATION PREFERENCES METHODS ============

  /**
   * Async method to get user notification preferences.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async getUserNotificationPreferencesAsync(userId: number): Promise<{
    enableWebPush: boolean;
    enableApprise: boolean;
    enabledChannels: number[];
    enableDirectMessages: boolean;
    notifyOnEmoji: boolean;
    notifyOnMqtt: boolean;
    notifyOnNewNode: boolean;
    notifyOnTraceroute: boolean;
    notifyOnInactiveNode: boolean;
    notifyOnServerEvents: boolean;
    prefixWithNodeName: boolean;
    monitoredNodes: string[];
    whitelist: string[];
    blacklist: string[];
    appriseUrls: string[];
  } | null> {
    if (this.notificationsRepo) {
      return this.notificationsRepo.getUserPreferences(userId);
    }
    // Fallback to sync SQLite method if repo not ready
    return null;
  }

  /**
   * Async method to save user notification preferences.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async saveUserNotificationPreferencesAsync(userId: number, prefs: {
    enableWebPush: boolean;
    enableApprise: boolean;
    enabledChannels: number[];
    enableDirectMessages: boolean;
    notifyOnEmoji: boolean;
    notifyOnMqtt: boolean;
    notifyOnNewNode: boolean;
    notifyOnTraceroute: boolean;
    notifyOnInactiveNode: boolean;
    notifyOnServerEvents: boolean;
    prefixWithNodeName: boolean;
    monitoredNodes: string[];
    whitelist: string[];
    blacklist: string[];
    appriseUrls: string[];
  }): Promise<boolean> {
    if (this.notificationsRepo) {
      return this.notificationsRepo.saveUserPreferences(userId, prefs);
    }
    // Fallback - return false if repo not ready
    return false;
  }

  /**
   * Delete a node and all associated data (async version for PostgreSQL)
   */
  async deleteNodeAsync(nodeNum: number): Promise<{
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
      // Delete DMs to/from this node
      if (this.messagesRepo) {
        messagesDeleted = await this.messagesRepo.purgeDirectMessages(nodeNum);
      }

      // Delete traceroutes for this node
      if (this.traceroutesRepo) {
        traceroutesDeleted = await this.traceroutesRepo.deleteTraceroutesForNode(nodeNum);
        // Also delete route segments
        await this.traceroutesRepo.deleteRouteSegmentsForNode(nodeNum);
      }

      // Delete telemetry for this node
      if (this.telemetryRepo) {
        telemetryDeleted = await this.telemetryRepo.purgeNodeTelemetry(nodeNum);
      }

      // Delete neighbor info for this node
      if (this.neighborsRepo) {
        await this.neighborsRepo.deleteNeighborInfoForNode(nodeNum);
      }

      // Delete the node itself
      if (this.nodesRepo) {
        nodeDeleted = await this.nodesRepo.deleteNodeRecord(nodeNum);
      }

      // Also remove from cache
      this.nodesCache.delete(nodeNum);

      logger.debug(`Deleted node ${nodeNum}: messages=${messagesDeleted}, traceroutes=${traceroutesDeleted}, telemetry=${telemetryDeleted}, node=${nodeDeleted}`);
    } catch (error) {
      logger.error(`Error deleting node ${nodeNum}:`, error);
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
  insertRouteSegment(segmentData: DbRouteSegment): void {
    // For PostgreSQL/MySQL, use async repository
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.insertRouteSegment(segmentData).catch((error) => {
          logger.error('[DatabaseService] Failed to insert route segment:', error);
        });
      }
      return;
    }

    // SQLite path
    const stmt = this.db.prepare(`
      INSERT INTO route_segments (
        fromNodeNum, toNodeNum, fromNodeId, toNodeId, distanceKm, isRecordHolder, timestamp, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      segmentData.fromNodeNum,
      segmentData.toNodeNum,
      segmentData.fromNodeId,
      segmentData.toNodeId,
      segmentData.distanceKm,
      segmentData.isRecordHolder ? 1 : 0,
      segmentData.timestamp,
      segmentData.createdAt
    );
  }

  getLongestActiveRouteSegment(): DbRouteSegment | null {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }
    // Get the longest segment from recent traceroutes (within last 7 days)
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE timestamp > ?
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get(cutoff) as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  async getLongestActiveRouteSegmentAsync(): Promise<DbRouteSegment | null> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      const segment = await this.traceroutesRepo.getLongestActiveRouteSegment();
      if (!segment) return null;
      return { ...segment, isRecordHolder: segment.isRecordHolder ?? false };
    }
    return this.getLongestActiveRouteSegment();
  }

  getRecordHolderRouteSegment(): DbRouteSegment | null {
    // For PostgreSQL/MySQL, use async version
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return null;
    }
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE isRecordHolder = 1
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get() as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  async getRecordHolderRouteSegmentAsync(): Promise<DbRouteSegment | null> {
    if ((this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') && this.traceroutesRepo) {
      const segment = await this.traceroutesRepo.getRecordHolderRouteSegment();
      if (!segment) return null;
      return { ...segment, isRecordHolder: segment.isRecordHolder ?? false };
    }
    return this.getRecordHolderRouteSegment();
  }

  updateRecordHolderSegment(newSegment: DbRouteSegment): void {
    // For PostgreSQL/MySQL, use async approach
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.getRecordHolderRouteSegment().then(currentRecord => {
          if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
            this.traceroutesRepo!.clearAllRecordHolders().then(() => {
              this.traceroutesRepo!.insertRouteSegment({
                ...newSegment,
                isRecordHolder: true
              }).catch(err => logger.debug('Failed to insert record holder segment:', err));
            }).catch(err => logger.debug('Failed to clear record holder segments:', err));
            logger.debug(`🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${newSegment.toNodeId}`);
          }
        }).catch(err => logger.debug('Failed to get record holder segment:', err));
      }
      return;
    }

    const currentRecord = this.getRecordHolderRouteSegment();

    // If no current record or new segment is longer, update
    if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
      // Clear all existing record holders
      this.db.exec('UPDATE route_segments SET isRecordHolder = 0');

      // Insert new record holder
      this.insertRouteSegment({
        ...newSegment,
        isRecordHolder: true
      });

      logger.debug(`🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${newSegment.toNodeId}`);
    }
  }

  clearRecordHolderSegment(): void {
    // For PostgreSQL/MySQL, use async approach
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.traceroutesRepo) {
        this.traceroutesRepo.clearAllRecordHolders().catch(err =>
          logger.debug('Failed to clear record holder segments:', err)
        );
      }
      logger.debug('🗑️ Cleared record holder route segment');
      return;
    }

    this.db.exec('UPDATE route_segments SET isRecordHolder = 0');
    logger.debug('🗑️ Cleared record holder route segment');
  }

  cleanupOldRouteSegments(days: number = 30): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare(`
      DELETE FROM route_segments
      WHERE timestamp < ? AND isRecordHolder = 0
    `);
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  /**
   * Delete traceroutes older than the specified number of days
   */
  cleanupOldTraceroutes(days: number = 30): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM traceroutes WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  /**
   * Delete neighbor info records older than the specified number of days
   */
  cleanupOldNeighborInfo(days: number = 30): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM neighbor_info WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  /**
   * Run VACUUM to reclaim unused space in the database file
   * This can take a while on large databases and temporarily doubles disk usage
   */
  vacuum(): void {
    logger.info('🧹 Running VACUUM on database...');
    this.db.exec('VACUUM');
    logger.info('✅ VACUUM complete');
  }

  /**
   * Get the current database file size in bytes
   */
  getDatabaseSize(): number {
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

    const stmt = this.db.prepare(`
      INSERT INTO neighbor_info (nodeNum, neighborNodeNum, snr, lastRxTime, timestamp, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      neighborInfo.nodeNum,
      neighborInfo.neighborNodeNum,
      neighborInfo.snr || null,
      neighborInfo.lastRxTime || null,
      neighborInfo.timestamp,
      Date.now()
    );
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

    // SQLite: direct delete
    const stmt = this.db.prepare('DELETE FROM neighbor_info WHERE nodeNum = ?');
    stmt.run(nodeNum);
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
    // For PostgreSQL/MySQL, use async repo with cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.neighborsRepo) {
        this.neighborsRepo.getNeighborsForNode(nodeNum).then(neighbors => {
          this._neighborsByNodeCache.set(nodeNum, neighbors.map(n => this.convertRepoNeighborInfo(n)));
        }).catch(err => logger.debug('Failed to get neighbors for node:', err));
      }
      return this._neighborsByNodeCache.get(nodeNum) || [];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM neighbor_info
      WHERE nodeNum = ?
      ORDER BY timestamp DESC
    `);
    return stmt.all(nodeNum) as DbNeighborInfo[];
  }

  getAllNeighborInfo(): DbNeighborInfo[] {
    // For PostgreSQL/MySQL, use async repo with cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      if (this.neighborsRepo) {
        this.neighborsRepo.getAllNeighborInfo().then(neighbors => {
          this._neighborsCache = neighbors.map(n => this.convertRepoNeighborInfo(n));
        }).catch(err => logger.debug('Failed to get all neighbor info:', err));
      }
      return this._neighborsCache;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM neighbor_info
      ORDER BY timestamp DESC
    `);
    return stmt.all() as DbNeighborInfo[];
  }

  getLatestNeighborInfoPerNode(): DbNeighborInfo[] {
    // For PostgreSQL/MySQL, use the all neighbor info cache (simplified)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // Return cached data - getAllNeighborInfo is already ordered by timestamp DESC
      // For now, just return all (filtering can be done on demand)
      return this._neighborsCache;
    }

    const stmt = this.db.prepare(`
      SELECT ni.*
      FROM neighbor_info ni
      INNER JOIN (
        SELECT nodeNum, neighborNodeNum, MAX(timestamp) as maxTimestamp
        FROM neighbor_info
        GROUP BY nodeNum, neighborNodeNum
      ) latest
      ON ni.nodeNum = latest.nodeNum
        AND ni.neighborNodeNum = latest.neighborNodeNum
        AND ni.timestamp = latest.maxTimestamp
    `);
    return stmt.all() as DbNeighborInfo[];
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
    if (!this.neighborsRepo) {
      return {};
    }

    const stats = await this.neighborsRepo.getDirectNeighborRssiAsync(hoursBack);
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
    if (!this.neighborsRepo) {
      return 0;
    }

    // Clear from cache
    this._neighborsByNodeCache.delete(nodeNum);
    this._neighborsCache = this._neighborsCache.filter(n => n.nodeNum !== nodeNum);

    // Delete from database
    const deleted = await this.neighborsRepo.deleteNeighborInfoForNode(nodeNum);
    logger.info(`Deleted ${deleted} neighbor records for node ${nodeNum}`);
    return deleted;
  }

  // Favorite operations
  setNodeFavorite(nodeNum: number, isFavorite: boolean): void {
    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        cachedNode.isFavorite = isFavorite;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.setNodeFavorite(nodeNum, isFavorite).catch(err => {
          logger.error(`Failed to set node favorite in database:`, err);
        });
      }

      logger.debug(`${isFavorite ? '⭐' : '☆'} Node ${nodeNum} favorite status set to: ${isFavorite}`);
      return;
    }

    // SQLite: synchronous update
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        isFavorite = ?,
        updatedAt = ?
      WHERE nodeNum = ?
    `);
    const result = stmt.run(isFavorite ? 1 : 0, now, nodeNum);

    if (result.changes === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update favorite for node ${nodeId} (${nodeNum}): node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`${isFavorite ? '⭐' : '☆'} Node ${nodeNum} favorite status set to: ${isFavorite} (${result.changes} row updated)`);
  }

  // Ignored operations
  setNodeIgnored(nodeNum: number, isIgnored: boolean): void {
    // Get the node info for the persistent ignore list
    const node = this.getNode(nodeNum);
    const nodeId = node?.nodeId || `!${nodeNum.toString(16).padStart(8, '0')}`;

    // Persist to/remove from the ignored_nodes table
    if (this.ignoredNodesRepo) {
      if (isIgnored) {
        this.ignoredNodesRepo.addIgnoredNodeAsync(
          nodeNum, nodeId, node?.longName, node?.shortName
        ).catch(err => {
          logger.error('Failed to add node to persistent ignore list:', err);
        });
      } else {
        this.ignoredNodesRepo.removeIgnoredNodeAsync(nodeNum).catch(err => {
          logger.error('Failed to remove node from persistent ignore list:', err);
        });
      }
    } else {
      // SQLite fallback: use raw SQL for the ignored_nodes table
      try {
        if (isIgnored) {
          const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO ignored_nodes (nodeNum, nodeId, longName, shortName, ignoredAt)
            VALUES (?, ?, ?, ?, ?)
          `);
          stmt.run(nodeNum, nodeId, node?.longName || null, node?.shortName || null, Date.now());
        } else {
          const stmt = this.db.prepare('DELETE FROM ignored_nodes WHERE nodeNum = ?');
          stmt.run(nodeNum);
        }
      } catch (err) {
        logger.error('Failed to update persistent ignore list:', err);
      }
    }

    // For PostgreSQL/MySQL, update cache and fire-and-forget
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const cachedNode = this.nodesCache.get(nodeNum);
      if (cachedNode) {
        cachedNode.isIgnored = isIgnored;
        cachedNode.updatedAt = Date.now();
      }

      if (this.nodesRepo) {
        this.nodesRepo.setNodeIgnored(nodeNum, isIgnored).catch(err => {
          logger.error(`Failed to set node ignored status in database:`, err);
        });
      }

      logger.debug(`${isIgnored ? '🚫' : '✅'} Node ${nodeNum} ignored status set to: ${isIgnored}`);
      return;
    }

    // SQLite: synchronous update
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        isIgnored = ?,
        updatedAt = ?
      WHERE nodeNum = ?
    `);
    const result = stmt.run(isIgnored ? 1 : 0, now, nodeNum);

    if (result.changes === 0) {
      logger.warn(`Failed to update ignored status for node ${nodeId} (${nodeNum}): node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`${isIgnored ? '🚫' : '✅'} Node ${nodeNum} ignored status set to: ${isIgnored} (${result.changes} row updated)`);
  }

  // Persistent ignored nodes operations
  async addIgnoredNodeAsync(
    nodeNum: number,
    nodeId: string,
    longName?: string | null,
    shortName?: string | null,
    ignoredBy?: string | null,
  ): Promise<void> {
    if (this.ignoredNodesRepo) {
      await this.ignoredNodesRepo.addIgnoredNodeAsync(nodeNum, nodeId, longName, shortName, ignoredBy);
    } else {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO ignored_nodes (nodeNum, nodeId, longName, shortName, ignoredAt, ignoredBy)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(nodeNum, nodeId, longName || null, shortName || null, Date.now(), ignoredBy || null);
    }
  }

  async removeIgnoredNodeAsync(nodeNum: number): Promise<void> {
    if (this.ignoredNodesRepo) {
      await this.ignoredNodesRepo.removeIgnoredNodeAsync(nodeNum);
    } else {
      const stmt = this.db.prepare('DELETE FROM ignored_nodes WHERE nodeNum = ?');
      stmt.run(nodeNum);
    }
  }

  async getIgnoredNodesAsync(): Promise<Array<{
    nodeNum: number;
    nodeId: string;
    longName: string | null;
    shortName: string | null;
    ignoredAt: number;
    ignoredBy: string | null;
  }>> {
    if (this.ignoredNodesRepo) {
      return this.ignoredNodesRepo.getIgnoredNodesAsync();
    }
    // SQLite fallback
    const stmt = this.db.prepare('SELECT * FROM ignored_nodes');
    return stmt.all() as any[];
  }

  async isNodeIgnoredAsync(nodeNum: number): Promise<boolean> {
    if (this.ignoredNodesRepo) {
      return this.ignoredNodesRepo.isNodeIgnoredAsync(nodeNum);
    }
    // SQLite fallback
    const stmt = this.db.prepare('SELECT nodeNum FROM ignored_nodes WHERE nodeNum = ?');
    const row = stmt.get(nodeNum);
    return !!row;
  }

  // Position override operations
  setNodePositionOverride(
    nodeNum: number,
    enabled: boolean,
    latitude?: number,
    longitude?: number,
    altitude?: number,
    isPrivate: boolean = false
  ): void {
    const now = Date.now();

    // For PostgreSQL/MySQL, use cache and async repo
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const existingNode = this.nodesCache.get(nodeNum);
      if (!existingNode) {
        const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
        logger.warn(`⚠️ Failed to update position override for node ${nodeId} (${nodeNum}): node not found in cache`);
        throw new Error(`Node ${nodeId} not found`);
      }

      // Update cache
      existingNode.positionOverrideEnabled = enabled;
      existingNode.latitudeOverride = enabled && latitude !== undefined ? latitude : undefined;
      existingNode.longitudeOverride = enabled && longitude !== undefined ? longitude : undefined;
      existingNode.altitudeOverride = enabled && altitude !== undefined ? altitude : undefined;
      existingNode.positionOverrideIsPrivate = enabled && isPrivate;
      existingNode.updatedAt = now;
      this.nodesCache.set(nodeNum, existingNode);

      // Fire and forget async update
      if (this.nodesRepo) {
        this.nodesRepo.upsertNode(existingNode).catch(err => {
          logger.error('Failed to update position override:', err);
        });
      }

      logger.debug(`📍 Node ${nodeNum} position override ${enabled ? 'enabled' : 'disabled'}${enabled ? ` (${latitude}, ${longitude}, ${altitude}m)${isPrivate ? ' [PRIVATE]' : ''}` : ''}`);
      return;
    }

    // SQLite path
    const stmt = this.db.prepare(`
      UPDATE nodes SET
        positionOverrideEnabled = ?,
        latitudeOverride = ?,
        longitudeOverride = ?,
        altitudeOverride = ?,
        positionOverrideIsPrivate = ?,
        updatedAt = ?
      WHERE nodeNum = ?
    `);
    const result = stmt.run(
      enabled ? 1 : 0,
      enabled && latitude !== undefined ? latitude : null,
      enabled && longitude !== undefined ? longitude : null,
      enabled && altitude !== undefined ? altitude : null,
      enabled && isPrivate ? 1 : 0,
      now,
      nodeNum
    );

    if (result.changes === 0) {
      const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
      logger.warn(`⚠️ Failed to update position override for node ${nodeId} (${nodeNum}): node not found in database`);
      throw new Error(`Node ${nodeId} not found`);
    }

    logger.debug(`📍 Node ${nodeNum} position override ${enabled ? 'enabled' : 'disabled'}${enabled ? ` (${latitude}, ${longitude}, ${altitude}m)${isPrivate ? ' [PRIVATE]' : ''}` : ''}`);
  }

  getNodePositionOverride(nodeNum: number): {
    enabled: boolean;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    isPrivate: boolean;
  } | null {
    // For PostgreSQL/MySQL, use cache
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      const node = this.nodesCache.get(nodeNum);
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
    const stmt = this.db.prepare(`
      SELECT positionOverrideEnabled, latitudeOverride, longitudeOverride, altitudeOverride, positionOverrideIsPrivate
      FROM nodes
      WHERE nodeNum = ?
    `);
    const row = stmt.get(nodeNum) as {
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

  clearNodePositionOverride(nodeNum: number): void {
    this.setNodePositionOverride(nodeNum, false);
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

      if (this.authRepo) {
        // PostgreSQL/MySQL: use Drizzle repository
        const allUsers = await this.authRepo.getAllUsers();
        const hasAdmin = allUsers.some(u => u.isAdmin);
        if (hasAdmin) {
          logger.debug('✅ Admin user already exists');
          return;
        }

        logger.debug('📝 No admin user found, creating default admin...');
        const bcrypt = await import('bcrypt');
        const passwordHash = await bcrypt.hash(password, 10);
        const now = Date.now();

        const adminId = await this.authRepo.createUser({
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
        const allResources = ['dashboard', 'nodes', 'messages', 'traceroutes', 'channels', 'configuration', 'info', 'notifications', 'audit', 'users', 'packets'];
        for (const resource of allResources) {
          await this.authRepo.createPermission({
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
        await this.setSettingAsync('setup_complete', 'true');
      } else {
        // SQLite: use sync models
        if (this.userModel.hasAdminUser()) {
          logger.debug('✅ Admin user already exists');
          return;
        }

        logger.debug('📝 No admin user found, creating default admin...');

        const admin = await this.userModel.create({
          username: adminUsername,
          password: password,
          authProvider: 'local',
          isAdmin: true,
          displayName: 'Administrator'
        });

        // Grant all permissions
        this.permissionModel.grantDefaultPermissions(admin.id, true);

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

        // Log to audit log
        this.auditLog(
          admin.id,
          'first_run_admin_created',
          'users',
          JSON.stringify({ username: adminUsername }),
          null
        );

        // Save to settings
        this.setSetting('setup_complete', 'true');
      }
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

      // Use appropriate method based on database type
      if (this.authRepo) {
        // PostgreSQL/MySQL: use Drizzle repository
        const existingUser = await this.authRepo.getUserByUsername('anonymous');
        if (existingUser) {
          logger.debug('✅ Anonymous user already exists');
          return;
        }

        logger.debug('📝 Creating anonymous user for unauthenticated access...');
        const now = Date.now();
        const anonymousId = await this.authRepo.createUser({
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
          await this.authRepo.createPermission({
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

        // Log to audit log (fire-and-forget for async)
        this.auditLogAsync(
          anonymousId,
          'anonymous_user_created',
          'users',
          JSON.stringify({ username: 'anonymous', defaultPermissions: defaultAnonPermissions }),
          'system'
        ).catch(err => logger.error('Failed to write audit log:', err));
      } else {
        // SQLite: use sync models
        const anonymousUser = this.userModel.findByUsername('anonymous');
        if (anonymousUser) {
          logger.debug('✅ Anonymous user already exists');
          return;
        }

        logger.debug('📝 Creating anonymous user for unauthenticated access...');
        const anonymous = await this.userModel.create({
          username: 'anonymous',
          password: randomPassword,  // Random password - effectively cannot login
          authProvider: 'local',
          isAdmin: false,
          displayName: 'Anonymous User'
        });

        // Grant default permissions
        for (const perm of defaultAnonPermissions) {
          this.permissionModel.grant({
            userId: anonymous.id,
            resource: perm.resource,
            canViewOnMap: perm.canViewOnMap,
            canRead: perm.canRead,
            canWrite: perm.canWrite,
            grantedBy: anonymous.id
          });
        }

        logger.debug('✅ Anonymous user created with read-only permissions (dashboard, nodes, info)');
        logger.debug('   💡 Admin can modify anonymous permissions in the Users tab');

        // Log to audit log
        this.auditLog(
          anonymous.id,
          'anonymous_user_created',
          'users',
          JSON.stringify({ username: 'anonymous', defaultPermissions: defaultAnonPermissions }),
          null
        );
      }
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
    // Route to async method for PostgreSQL/MySQL
    if (this.authRepo) {
      this.authRepo.createAuditLogEntry({
        userId,
        action,
        resource,
        details,
        ipAddress,
        userAgent: null,
        timestamp: Date.now(),
      }).catch(error => {
        logger.error('Failed to write audit log (async):', error);
      });
      return;
    }

    // SQLite sync path
    try {
      const stmt = this.db.prepare(`
        INSERT INTO audit_log (user_id, action, resource, details, ip_address, value_before, value_after, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(userId, action, resource, details, ipAddress, valueBefore || null, valueAfter || null, Date.now());
    } catch (error) {
      logger.error('Failed to write audit log:', error);
      // Don't throw - audit log failures shouldn't break the application
    }
  }

  getAuditLogs(options: {
    limit?: number;
    offset?: number;
    userId?: number;
    action?: string;
    resource?: string;
    startDate?: number;
    endDate?: number;
    search?: string;
  } = {}): { logs: any[]; total: number } {
    const {
      limit = 100,
      offset = 0,
      userId,
      action,
      resource,
      startDate,
      endDate,
      search
    } = options;

    // Build WHERE clause dynamically
    const conditions: string[] = [];
    const params: any[] = [];

    if (userId !== undefined) {
      conditions.push('al.user_id = ?');
      params.push(userId);
    }

    if (action) {
      conditions.push('al.action = ?');
      params.push(action);
    }

    if (resource) {
      conditions.push('al.resource = ?');
      params.push(resource);
    }

    if (startDate !== undefined) {
      conditions.push('al.timestamp >= ?');
      params.push(startDate);
    }

    if (endDate !== undefined) {
      conditions.push('al.timestamp <= ?');
      params.push(endDate);
    }

    if (search) {
      conditions.push('(al.details LIKE ? OR u.username LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as count
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
    `;
    const countStmt = this.db.prepare(countQuery);
    const countResult = countStmt.get(...params) as { count: number };
    const total = Number(countResult.count);

    // Get paginated results
    const query = `
      SELECT
        al.id, al.user_id as userId, al.action, al.resource,
        al.details, al.ip_address as ipAddress, al.value_before as valueBefore,
        al.value_after as valueAfter, al.timestamp,
        u.username
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY al.timestamp DESC
      LIMIT ? OFFSET ?
    `;

    const stmt = this.db.prepare(query);
    const logs = stmt.all(...params, limit, offset) as any[];

    return { logs, total };
  }

  /**
   * Async version of getAuditLogs - works with all database backends
   */
  async getAuditLogsAsync(options: {
    limit?: number;
    offset?: number;
    userId?: number;
    action?: string;
    resource?: string;
    startDate?: number;
    endDate?: number;
    search?: string;
  } = {}): Promise<{ logs: any[]; total: number }> {
    if (!this.drizzleDatabase || this.drizzleDbType === 'sqlite') {
      // Fallback to sync for SQLite
      return this.getAuditLogs(options);
    }

    const {
      limit = 100,
      offset = 0,
      userId,
      action,
      resource,
      startDate,
      endDate,
      search
    } = options;

    try {
      if (this.drizzleDbType === 'postgres' && this.postgresPool) {
        // Build WHERE clause dynamically for PostgreSQL
        // Note: PostgreSQL schema uses camelCase column names (userId, ipAddress, etc.)
        // and username is stored directly in audit_log, not joined from users
        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (userId !== undefined) {
          conditions.push(`"userId" = $${paramIndex++}`);
          params.push(userId);
        }

        if (action) {
          conditions.push(`action = $${paramIndex++}`);
          params.push(action);
        }

        if (resource) {
          conditions.push(`resource = $${paramIndex++}`);
          params.push(resource);
        }

        if (startDate !== undefined) {
          conditions.push(`timestamp >= $${paramIndex++}`);
          params.push(startDate);
        }

        if (endDate !== undefined) {
          conditions.push(`timestamp <= $${paramIndex++}`);
          params.push(endDate);
        }

        if (search) {
          conditions.push(`(details ILIKE $${paramIndex} OR username ILIKE $${paramIndex + 1})`);
          params.push(`%${search}%`, `%${search}%`);
          paramIndex += 2;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Get total count
        const countResult = await this.postgresPool.query(
          `SELECT COUNT(*) as count FROM audit_log ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0]?.count || '0', 10);

        // Get paginated results
        const result = await this.postgresPool.query(
          `SELECT id, "userId", username, action, resource, details, "ipAddress", timestamp
           FROM audit_log
           ${whereClause}
           ORDER BY timestamp DESC
           LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
          [...params, limit, offset]
        );

        return { logs: result.rows || [], total };

      } else if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
        // Build WHERE clause dynamically for MySQL
        // Note: MySQL schema uses camelCase column names (userId, ipAddress, etc.)
        // and username is stored directly in audit_log, not joined from users
        const conditions: string[] = [];
        const params: any[] = [];

        if (userId !== undefined) {
          conditions.push('userId = ?');
          params.push(userId);
        }

        if (action) {
          conditions.push('action = ?');
          params.push(action);
        }

        if (resource) {
          conditions.push('resource = ?');
          params.push(resource);
        }

        if (startDate !== undefined) {
          conditions.push('timestamp >= ?');
          params.push(startDate);
        }

        if (endDate !== undefined) {
          conditions.push('timestamp <= ?');
          params.push(endDate);
        }

        if (search) {
          conditions.push('(details LIKE ? OR username LIKE ?)');
          params.push(`%${search}%`, `%${search}%`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Get total count
        const [countRows] = await this.mysqlPool.query(
          `SELECT COUNT(*) as count FROM audit_log ${whereClause}`,
          params
        ) as any;
        const total = parseInt(countRows[0]?.count || '0', 10);

        // Get paginated results
        const [rows] = await this.mysqlPool.query(
          `SELECT id, userId, username, action, resource, details, ipAddress, timestamp
           FROM audit_log
           ${whereClause}
           ORDER BY timestamp DESC
           LIMIT ? OFFSET ?`,
          [...params, limit, offset]
        ) as any;

        return { logs: rows || [], total };
      }

      return { logs: [], total: 0 };
    } catch (error) {
      logger.error(`[DatabaseService] Failed to get audit logs async: ${error}`);
      return { logs: [], total: 0 };
    }
  }

  // Get audit log statistics
  getAuditStats(days: number = 30): any {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);

    // Count by action type
    const actionStats = this.db.prepare(`
      SELECT action, COUNT(*) as count
      FROM audit_log
      WHERE timestamp >= ?
      GROUP BY action
      ORDER BY count DESC
    `).all(cutoff);

    // Count by user
    const userStats = this.db.prepare(`
      SELECT u.username, COUNT(*) as count
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.timestamp >= ?
      GROUP BY al.user_id
      ORDER BY count DESC
      LIMIT 10
    `).all(cutoff);

    // Count by day
    const dailyStats = this.db.prepare(`
      SELECT
        date(timestamp/1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM audit_log
      WHERE timestamp >= ?
      GROUP BY date(timestamp/1000, 'unixepoch')
      ORDER BY date DESC
    `).all(cutoff);

    return {
      actionStats,
      userStats,
      dailyStats,
      totalEvents: actionStats.reduce((sum: number, stat: any) => sum + Number(stat.count), 0)
    };
  }

  // Cleanup old audit logs
  cleanupAuditLogs(days: number): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    logger.debug(`🧹 Cleaned up ${result.changes} audit log entries older than ${days} days`);
    return Number(result.changes);
  }

  // Read Messages tracking
  markMessageAsRead(messageId: string, userId: number | null): void {
    // For PostgreSQL/MySQL, read tracking is not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // TODO: Implement read message tracking for PostgreSQL via repository
      return;
    }

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
    const stmt = this.db.prepare(`
      UPDATE messages
      SET ackFailed = ?, routingErrorReceived = ?, deliveryState = ?
      WHERE requestId = ?
    `);
    // Set deliveryState based on whether ACK was successful or failed
    const deliveryState = ackFailed ? 'failed' : 'delivered';
    const result = stmt.run(ackFailed ? 1 : 0, ackFailed ? 1 : 0, deliveryState, requestId);
    return Number(result.changes) > 0;
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
    const stmt = this.db.prepare(`
      UPDATE messages
      SET deliveryState = ?, ackFailed = ?
      WHERE requestId = ?
    `);
    const ackFailed = deliveryState === 'failed' ? 1 : 0;
    const result = stmt.run(deliveryState, ackFailed, requestId);
    return Number(result.changes) > 0;
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
    const stmt = this.db.prepare(`
      UPDATE messages
      SET rxTime = ?, timestamp = ?
      WHERE requestId = ?
    `);
    const result = stmt.run(rxTime, rxTime, requestId);
    return Number(result.changes) > 0;
  }

  getUnreadMessageIds(userId: number | null): string[] {
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
   * Async version of getUnreadCountsByChannel for PostgreSQL/MySQL
   */
  async getUnreadCountsByChannelAsync(userId: number | null, localNodeId?: string): Promise<{[channelId: number]: number}> {
    // For SQLite, use sync version
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getUnreadCountsByChannel(userId, localNodeId);
    }

    // PostgreSQL implementation using postgresPool
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          // Anonymous user - check for messages not in read_messages at all
          query = `
            SELECT m.channel, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId"
            WHERE rm."messageId" IS NULL
              AND m.channel != -1
              AND m.portnum = 1
              ${localNodeId ? 'AND m."fromNodeId" != $1' : ''}
            GROUP BY m.channel
          `;
          params = localNodeId ? [localNodeId] : [];
        } else {
          // Authenticated user - check for messages not read by this user
          query = `
            SELECT m.channel, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId" AND rm."userId" = $1
            WHERE rm."messageId" IS NULL
              AND m.channel != -1
              AND m.portnum = 1
              ${localNodeId ? 'AND m."fromNodeId" != $2' : ''}
            GROUP BY m.channel
          `;
          params = localNodeId ? [userId, localNodeId] : [userId];
        }

        const result = await this.postgresPool.query(query, params);
        const counts: {[channelId: number]: number} = {};

        result.rows.forEach((row: any) => {
          counts[Number(row.channel)] = Number(row.count);
        });

        return counts;
      } catch (error) {
        logger.error('Error getting unread counts by channel:', error);
        return {};
      }
    }

    // MySQL implementation using mysqlPool
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          query = `
            SELECT m.channel, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId
            WHERE rm.messageId IS NULL
              AND m.channel != -1
              AND m.portnum = 1
              ${localNodeId ? 'AND m.fromNodeId != ?' : ''}
            GROUP BY m.channel
          `;
          params = localNodeId ? [localNodeId] : [];
        } else {
          query = `
            SELECT m.channel, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId AND rm.userId = ?
            WHERE rm.messageId IS NULL
              AND m.channel != -1
              AND m.portnum = 1
              ${localNodeId ? 'AND m.fromNodeId != ?' : ''}
            GROUP BY m.channel
          `;
          params = localNodeId ? [userId, localNodeId] : [userId];
        }

        const [rows] = await this.mysqlPool.query(query, params) as any;
        const counts: {[channelId: number]: number} = {};

        for (const row of rows) {
          counts[Number(row.channel)] = Number(row.count);
        }

        return counts;
      } catch (error) {
        logger.error('Error getting unread counts by channel:', error);
        return {};
      }
    }

    return {};
  }

  /**
   * Async version of getUnreadDMCount for PostgreSQL/MySQL
   */
  async getUnreadDMCountAsync(localNodeId: string, remoteNodeId: string, userId: number | null): Promise<number> {
    // For SQLite, use sync version
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getUnreadDMCount(localNodeId, remoteNodeId, userId);
    }

    // PostgreSQL implementation using postgresPool
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          query = `
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId"
            WHERE rm."messageId" IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m."fromNodeId" = $1
              AND m."toNodeId" = $2
          `;
          params = [remoteNodeId, localNodeId];
        } else {
          query = `
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId" AND rm."userId" = $1
            WHERE rm."messageId" IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m."fromNodeId" = $2
              AND m."toNodeId" = $3
          `;
          params = [userId, remoteNodeId, localNodeId];
        }

        const result = await this.postgresPool.query(query, params);

        if (result.rows.length > 0) {
          return Number(result.rows[0].count);
        }

        return 0;
      } catch (error) {
        logger.error('Error getting unread DM count:', error);
        return 0;
      }
    }

    // MySQL implementation using mysqlPool
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          query = `
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId
            WHERE rm.messageId IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m.fromNodeId = ?
              AND m.toNodeId = ?
          `;
          params = [remoteNodeId, localNodeId];
        } else {
          query = `
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId AND rm.userId = ?
            WHERE rm.messageId IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m.fromNodeId = ?
              AND m.toNodeId = ?
          `;
          params = [userId, remoteNodeId, localNodeId];
        }

        const [rows] = await this.mysqlPool.query(query, params) as any;

        if (rows.length > 0) {
          return Number(rows[0].count);
        }

        return 0;
      } catch (error) {
        logger.error('Error getting unread DM count:', error);
        return 0;
      }
    }

    return 0;
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
   */
  async getBatchUnreadDMCountsAsync(localNodeId: string, userId: number | null): Promise<{ [fromNodeId: string]: number }> {
    // For SQLite, use sync version
    if (this.drizzleDbType !== 'postgres' && this.drizzleDbType !== 'mysql') {
      return this.getBatchUnreadDMCounts(localNodeId, userId);
    }

    // PostgreSQL implementation
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          query = `
            SELECT m."fromNodeId", COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId"
            WHERE rm."messageId" IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m."toNodeId" = $1
            GROUP BY m."fromNodeId"
          `;
          params = [localNodeId];
        } else {
          query = `
            SELECT m."fromNodeId", COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm."messageId" AND rm."userId" = $1
            WHERE rm."messageId" IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m."toNodeId" = $2
            GROUP BY m."fromNodeId"
          `;
          params = [userId, localNodeId];
        }

        const result = await this.postgresPool.query(query, params);
        const counts: { [fromNodeId: string]: number } = {};
        for (const row of result.rows) {
          counts[row.fromNodeId] = Number(row.count);
        }
        return counts;
      } catch (error) {
        logger.error('Error getting batch unread DM counts:', error);
        return {};
      }
    }

    // MySQL implementation using mysqlPool
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        let query: string;
        let params: any[];

        if (userId === null) {
          query = `
            SELECT m.fromNodeId, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId
            WHERE rm.messageId IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m.toNodeId = ?
            GROUP BY m.fromNodeId
          `;
          params = [localNodeId];
        } else {
          query = `
            SELECT m.fromNodeId, COUNT(*) as count
            FROM messages m
            LEFT JOIN read_messages rm ON m.id = rm.messageId AND rm.userId = ?
            WHERE rm.messageId IS NULL
              AND m.portnum = 1
              AND m.channel = -1
              AND m.toNodeId = ?
            GROUP BY m.fromNodeId
          `;
          params = [userId, localNodeId];
        }

        const [rows] = await this.mysqlPool.query(query, params) as any;
        const counts: { [fromNodeId: string]: number } = {};
        for (const row of rows) {
          counts[row.fromNodeId] = Number(row.count);
        }
        return counts;
      } catch (error) {
        logger.error('Error getting batch unread DM counts:', error);
        return {};
      }
    }

    return {};
  }

  cleanupOldReadMessages(days: number): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const stmt = this.db.prepare('DELETE FROM read_messages WHERE read_at < ?');
    const result = stmt.run(cutoff);
    logger.debug(`🧹 Cleaned up ${result.changes} read_messages entries older than ${days} days`);
    return Number(result.changes);
  }

  // Packet Log operations
  insertPacketLog(packet: Omit<DbPacketLog, 'id' | 'created_at'>): number {
    // Check if packet logging is enabled
    const enabled = this.getSetting('packet_log_enabled');
    if (enabled !== '1') {
      return 0;
    }

    // For PostgreSQL/MySQL, use async method
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      this.insertPacketLogAsync(packet).catch((error) => {
        logger.error(`[DatabaseService] Failed to insert packet log: ${error}`);
      });
      return 0;
    }

    const stmt = this.db.prepare(`
      INSERT INTO packet_log (
        packet_id, timestamp, from_node, from_node_id, to_node, to_node_id,
        channel, portnum, portnum_name, encrypted, snr, rssi, hop_limit, hop_start,
        relay_node, payload_size, want_ack, priority, payload_preview, metadata, direction,
        transport_mechanism, decrypted_by, decrypted_channel_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      packet.packet_id ?? null,
      packet.timestamp,
      packet.from_node,
      packet.from_node_id ?? null,
      packet.to_node ?? null,
      packet.to_node_id ?? null,
      packet.channel ?? null,
      packet.portnum,
      packet.portnum_name ?? null,
      packet.encrypted ? 1 : 0,
      packet.snr ?? null,
      packet.rssi ?? null,
      packet.hop_limit ?? null,
      packet.hop_start ?? null,
      packet.relay_node ?? null,
      packet.payload_size ?? null,
      packet.want_ack ? 1 : 0,
      packet.priority ?? null,
      packet.payload_preview ?? null,
      packet.metadata ?? null,
      packet.direction ?? 'rx',
      packet.transport_mechanism ?? null,
      packet.decrypted_by ?? null,
      packet.decrypted_channel_id ?? null
    );

    // Enforce max count limit
    this.enforcePacketLogMaxCount();

    return Number(result.lastInsertRowid);
  }

  private enforcePacketLogMaxCount(): void {
    const maxCountStr = this.getSetting('packet_log_max_count');
    const maxCount = maxCountStr ? parseInt(maxCountStr, 10) : 1000;

    // Get current count
    const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM packet_log');
    const countResult = countStmt.get() as { count: number };
    const currentCount = Number(countResult.count);

    if (currentCount > maxCount) {
      // Delete oldest packets to get back to max count
      const deleteCount = currentCount - maxCount;
      const deleteStmt = this.db.prepare(`
        DELETE FROM packet_log
        WHERE id IN (
          SELECT id FROM packet_log
          ORDER BY timestamp ASC
          LIMIT ?
        )
      `);
      deleteStmt.run(deleteCount);
      logger.debug(`🧹 Deleted ${deleteCount} old packets to enforce max count of ${maxCount}`);
    }
  }

  /**
   * Async version of insertPacketLog - works with all database backends
   */
  async insertPacketLogAsync(packet: Omit<DbPacketLog, 'id' | 'created_at'>): Promise<number> {
    // Check if packet logging is enabled
    const enabled = await this.getSettingAsync('packet_log_enabled');
    if (enabled !== '1') {
      return 0;
    }

    if (!this.drizzleDatabase) {
      // Fallback to sync for SQLite if drizzle not ready
      return this.insertPacketLog(packet);
    }

    try {
      const values = {
        packet_id: packet.packet_id ?? null,
        timestamp: packet.timestamp,
        from_node: packet.from_node,
        from_node_id: packet.from_node_id ?? null,
        to_node: packet.to_node ?? null,
        to_node_id: packet.to_node_id ?? null,
        channel: packet.channel ?? null,
        portnum: packet.portnum,
        portnum_name: packet.portnum_name ?? null,
        encrypted: packet.encrypted,
        snr: packet.snr ?? null,
        rssi: packet.rssi ?? null,
        hop_limit: packet.hop_limit ?? null,
        hop_start: packet.hop_start ?? null,
        relay_node: packet.relay_node ?? null,
        payload_size: packet.payload_size ?? null,
        want_ack: packet.want_ack ?? false,
        priority: packet.priority ?? null,
        payload_preview: packet.payload_preview ?? null,
        metadata: packet.metadata ?? null,
        direction: packet.direction ?? 'rx',
        created_at: Date.now(),
        transport_mechanism: packet.transport_mechanism ?? null,
        decrypted_by: packet.decrypted_by ?? null,
        decrypted_channel_id: packet.decrypted_channel_id ?? null,
      };

      // Use type assertion to avoid complex type narrowing
      // The drizzleDatabase is the raw Drizzle ORM database instance
      const db = this.drizzleDatabase as any;
      if (this.drizzleDbType === 'postgres') {
        await db.insert(packetLogPostgres).values(values);
      } else if (this.drizzleDbType === 'mysql') {
        await db.insert(packetLogMysql).values(values);
      } else {
        await db.insert(packetLogSqlite).values(values);
      }

      // TODO: Enforce max count for async version
      return 0;
    } catch (error) {
      logger.error(`[DatabaseService] Failed to insert packet log async: ${error}`);
      return 0;
    }
  }

  getPacketLogs(options: {
    offset?: number;
    limit?: number;
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  }): DbPacketLog[] {
    const { offset = 0, limit = 100, portnum, from_node, to_node, channel, encrypted, since } = options;

    let query = `
      SELECT
        pl.*,
        from_nodes.longName as from_node_longName,
        to_nodes.longName as to_node_longName
      FROM packet_log pl
      LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.nodeNum
      LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.nodeNum
      WHERE 1=1
    `;
    const params: any[] = [];

    if (portnum !== undefined) {
      query += ' AND pl.portnum = ?';
      params.push(portnum);
    }
    if (from_node !== undefined) {
      query += ' AND pl.from_node = ?';
      params.push(from_node);
    }
    if (to_node !== undefined) {
      query += ' AND pl.to_node = ?';
      params.push(to_node);
    }
    if (channel !== undefined) {
      query += ' AND pl.channel = ?';
      params.push(channel);
    }
    if (encrypted !== undefined) {
      query += ' AND pl.encrypted = ?';
      params.push(encrypted ? 1 : 0);
    }
    if (since !== undefined) {
      query += ' AND pl.timestamp >= ?';
      params.push(since);
    }

    query += ' ORDER BY pl.timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as DbPacketLog[];
  }

  getPacketLogById(id: number): DbPacketLog | null {
    const stmt = this.db.prepare(`
      SELECT
        pl.*,
        from_nodes.longName as from_node_longName,
        to_nodes.longName as to_node_longName
      FROM packet_log pl
      LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.nodeNum
      LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.nodeNum
      WHERE pl.id = ?
    `);
    const result = stmt.get(id) as DbPacketLog | undefined;
    return result || null;
  }

  getPacketLogCount(options: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  } = {}): number {
    const { portnum, from_node, to_node, channel, encrypted, since } = options;

    let query = 'SELECT COUNT(*) as count FROM packet_log WHERE 1=1';
    const params: any[] = [];

    if (portnum !== undefined) {
      query += ' AND portnum = ?';
      params.push(portnum);
    }
    if (from_node !== undefined) {
      query += ' AND from_node = ?';
      params.push(from_node);
    }
    if (to_node !== undefined) {
      query += ' AND to_node = ?';
      params.push(to_node);
    }
    if (channel !== undefined) {
      query += ' AND channel = ?';
      params.push(channel);
    }
    if (encrypted !== undefined) {
      query += ' AND encrypted = ?';
      params.push(encrypted ? 1 : 0);
    }
    if (since !== undefined) {
      query += ' AND timestamp >= ?';
      params.push(since);
    }

    const stmt = this.db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return Number(result.count);
  }

  clearPacketLogs(): number {
    const stmt = this.db.prepare('DELETE FROM packet_log');
    const result = stmt.run();
    logger.debug(`🧹 Cleared ${result.changes} packet log entries`);
    return Number(result.changes);
  }

  /**
   * Clear all packet logs - async version for PostgreSQL/MySQL
   */
  async clearPacketLogsAsync(): Promise<number> {
    // For PostgreSQL
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const result = await this.postgresPool.query('DELETE FROM packet_log');
        const deletedCount = result.rowCount ?? 0;
        logger.debug(`🧹 Cleared ${deletedCount} packet log entries (PostgreSQL)`);
        return deletedCount;
      } catch (error) {
        logger.error('[DatabaseService] Failed to clear packet logs (PostgreSQL):', error);
        throw error;
      }
    }

    // For MySQL/MariaDB
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const [result] = await this.mysqlPool.execute('DELETE FROM packet_log');
        const deletedCount = (result as any).affectedRows ?? 0;
        logger.debug(`🧹 Cleared ${deletedCount} packet log entries (MySQL)`);
        return deletedCount;
      } catch (error) {
        logger.error('[DatabaseService] Failed to clear packet logs (MySQL):', error);
        throw error;
      }
    }

    // Fallback to SQLite
    return this.clearPacketLogs();
  }

  /**
   * Get packet log count - async version for PostgreSQL/MySQL
   */
  async getPacketLogCountAsync(options: {
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  } = {}): Promise<number> {
    const { portnum, from_node, to_node, channel, encrypted, since } = options;

    // For PostgreSQL, use pool.query with parameterized query
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const params: any[] = [];
        let paramIndex = 1;
        let query = 'SELECT COUNT(*) as count FROM packet_log WHERE 1=1';

        if (portnum !== undefined) {
          query += ` AND portnum = $${paramIndex++}`;
          params.push(portnum);
        }
        if (from_node !== undefined) {
          query += ` AND from_node = $${paramIndex++}`;
          params.push(from_node);
        }
        if (to_node !== undefined) {
          query += ` AND to_node = $${paramIndex++}`;
          params.push(to_node);
        }
        if (channel !== undefined) {
          query += ` AND channel = $${paramIndex++}`;
          params.push(channel);
        }
        if (encrypted !== undefined) {
          query += ` AND encrypted = $${paramIndex++}`;
          params.push(encrypted);
        }
        if (since !== undefined) {
          query += ` AND timestamp >= $${paramIndex++}`;
          params.push(since);
        }

        const result = await this.postgresPool.query(query, params);
        return Number(result.rows?.[0]?.count ?? 0);
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet log count:', error);
        return 0;
      }
    }

    // For MySQL, use pool.query with parameterized query
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const params: any[] = [];
        let query = 'SELECT COUNT(*) as count FROM packet_log WHERE 1=1';

        if (portnum !== undefined) {
          query += ' AND portnum = ?';
          params.push(portnum);
        }
        if (from_node !== undefined) {
          query += ' AND from_node = ?';
          params.push(from_node);
        }
        if (to_node !== undefined) {
          query += ' AND to_node = ?';
          params.push(to_node);
        }
        if (channel !== undefined) {
          query += ' AND channel = ?';
          params.push(channel);
        }
        if (encrypted !== undefined) {
          query += ' AND encrypted = ?';
          params.push(encrypted);
        }
        if (since !== undefined) {
          query += ' AND timestamp >= ?';
          params.push(since);
        }

        const [rows] = await this.mysqlPool.query(query, params);
        return Number((rows as any[])?.[0]?.count ?? 0);
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet log count:', error);
        return 0;
      }
    }

    // For SQLite, use sync method
    return this.getPacketLogCount(options);
  }

  /**
   * Get packet logs - async version for PostgreSQL/MySQL
   */
  async getPacketLogsAsync(options: {
    offset?: number;
    limit?: number;
    portnum?: number;
    from_node?: number;
    to_node?: number;
    channel?: number;
    encrypted?: boolean;
    since?: number;
  }): Promise<DbPacketLog[]> {
    const { offset = 0, limit = 100, portnum, from_node, to_node, channel, encrypted, since } = options;

    // For PostgreSQL, use pool.query with parameterized query
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const params: any[] = [];
        let paramIndex = 1;

        let query = `
          SELECT
            pl.*,
            from_nodes."longName" as "from_node_longName",
            to_nodes."longName" as "to_node_longName"
          FROM packet_log pl
          LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes."nodeNum"
          LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes."nodeNum"
          WHERE 1=1
        `;

        if (portnum !== undefined) {
          query += ` AND pl.portnum = $${paramIndex++}`;
          params.push(portnum);
        }
        if (from_node !== undefined) {
          query += ` AND pl.from_node = $${paramIndex++}`;
          params.push(from_node);
        }
        if (to_node !== undefined) {
          query += ` AND pl.to_node = $${paramIndex++}`;
          params.push(to_node);
        }
        if (channel !== undefined) {
          query += ` AND pl.channel = $${paramIndex++}`;
          params.push(channel);
        }
        if (encrypted !== undefined) {
          query += ` AND pl.encrypted = $${paramIndex++}`;
          params.push(encrypted);
        }
        if (since !== undefined) {
          query += ` AND pl.timestamp >= $${paramIndex++}`;
          params.push(since);
        }

        query += ` ORDER BY pl.timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        params.push(limit, offset);

        const result = await this.postgresPool.query(query, params);
        // Convert BIGINT fields from strings to numbers (PostgreSQL returns BIGINT as strings)
        return (result.rows ?? []).map((row: any) => ({
          ...row,
          id: row.id != null ? Number(row.id) : row.id,
          packet_id: row.packet_id != null ? Number(row.packet_id) : row.packet_id,
          timestamp: row.timestamp != null ? Number(row.timestamp) : row.timestamp,
          from_node: row.from_node != null ? Number(row.from_node) : row.from_node,
          to_node: row.to_node != null ? Number(row.to_node) : row.to_node,
          relay_node: row.relay_node != null ? Number(row.relay_node) : row.relay_node,
          created_at: row.created_at != null ? Number(row.created_at) : row.created_at,
        })) as DbPacketLog[];
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet logs:', error);
        return [];
      }
    }
    // For MySQL, use pool.query with parameterized query
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const params: any[] = [];

        let query = `
          SELECT
            pl.*,
            from_nodes.longName as from_node_longName,
            to_nodes.longName as to_node_longName
          FROM packet_log pl
          LEFT JOIN nodes from_nodes ON pl.from_node = from_nodes.nodeNum
          LEFT JOIN nodes to_nodes ON pl.to_node = to_nodes.nodeNum
          WHERE 1=1
        `;

        if (portnum !== undefined) {
          query += ` AND pl.portnum = ?`;
          params.push(portnum);
        }
        if (from_node !== undefined) {
          query += ` AND pl.from_node = ?`;
          params.push(from_node);
        }
        if (to_node !== undefined) {
          query += ` AND pl.to_node = ?`;
          params.push(to_node);
        }
        if (channel !== undefined) {
          query += ` AND pl.channel = ?`;
          params.push(channel);
        }
        if (encrypted !== undefined) {
          query += ` AND pl.encrypted = ?`;
          params.push(encrypted);
        }
        if (since !== undefined) {
          query += ` AND pl.timestamp >= ?`;
          params.push(since);
        }

        query += ` ORDER BY pl.timestamp DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [rows] = await this.mysqlPool.query(query, params);
        return (rows ?? []) as DbPacketLog[];
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet logs:', error);
        return [];
      }
    }
    // For SQLite, use sync method
    return this.getPacketLogs(options);
  }

  /**
   * Update packet log entry with decryption results (for retroactive decryption)
   * Updates the decrypted_by, decrypted_channel_id, portnum, and metadata fields
   */
  async updatePacketLogDecryptionAsync(
    id: number,
    decryptedBy: 'server' | 'node',
    decryptedChannelId: number | null,
    portnum: number,
    metadata: string
  ): Promise<void> {
    if (this.drizzleDbType === 'postgres' && this.drizzleDatabase) {
      const db = this.drizzleDatabase as any;
      await db.execute(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = false,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    } else if (this.drizzleDbType === 'mysql' && this.drizzleDatabase) {
      const db = this.drizzleDatabase as any;
      await db.execute(sql`
        UPDATE packet_log
        SET decrypted_by = ${decryptedBy},
            decrypted_channel_id = ${decryptedChannelId},
            portnum = ${portnum},
            encrypted = false,
            metadata = ${metadata}
        WHERE id = ${id}
      `);
    } else {
      // SQLite
      const stmt = this.db.prepare(`
        UPDATE packet_log
        SET decrypted_by = ?,
            decrypted_channel_id = ?,
            portnum = ?,
            encrypted = 0,
            metadata = ?
        WHERE id = ?
      `);
      stmt.run(decryptedBy, decryptedChannelId, portnum, metadata, id);
    }
  }

  /**
   * Get database size - async version for PostgreSQL/MySQL
   * Note: PostgreSQL uses pg_database_size() which requires different permissions
   * Returns 0 for PostgreSQL/MySQL as exact size calculation differs
   */
  async getDatabaseSizeAsync(): Promise<number> {
    // For PostgreSQL/MySQL, return 0 (size calculation is different)
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return 0;
    }
    // For SQLite, use sync method
    return this.getDatabaseSize();
  }

  cleanupOldPacketLogs(): number {
    // For PostgreSQL/MySQL, packet log cleanup not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      // TODO: Implement packet log cleanup for PostgreSQL via repository
      logger.debug('🧹 Packet log cleanup skipped (PostgreSQL/MySQL not yet implemented)');
      return 0;
    }

    const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
    const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (maxAgeHours * 60 * 60);

    const stmt = this.db.prepare('DELETE FROM packet_log WHERE timestamp < ?');
    const result = stmt.run(cutoffTimestamp);
    logger.debug(`🧹 Cleaned up ${result.changes} packet log entries older than ${maxAgeHours} hours`);
    return Number(result.changes);
  }

  /**
   * Get packet counts grouped by from_node (for distribution charts)
   * Returns top N nodes by packet count, plus counts for remainder grouped as "Other"
   */
  async getPacketCountsByNodeAsync(options?: { since?: number; limit?: number; portnum?: number }): Promise<DbPacketCountByNode[]> {
    const { since, limit = 10, portnum } = options || {};

    // For PostgreSQL
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const params: any[] = [];
        let paramIndex = 1;
        const conditions: string[] = [];

        if (since !== undefined) {
          conditions.push(`pl.timestamp >= $${paramIndex++}`);
          params.push(since);
        }
        if (portnum !== undefined) {
          conditions.push(`pl.portnum = $${paramIndex++}`);
          params.push(portnum);
        }

        let query = `
          SELECT
            pl.from_node,
            n."nodeId" as "from_node_id",
            n."longName" as "from_node_longName",
            COUNT(*) as count
          FROM packet_log pl
          LEFT JOIN nodes n ON pl.from_node = n."nodeNum"
        `;

        if (conditions.length > 0) {
          query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` GROUP BY pl.from_node, n."nodeId", n."longName" ORDER BY count DESC LIMIT $${paramIndex++}`;
        params.push(limit);

        const result = await this.postgresPool.query(query, params);
        return (result.rows ?? []).map((row: any) => ({
          from_node: Number(row.from_node),
          from_node_id: row.from_node_id,
          from_node_longName: row.from_node_longName,
          count: Number(row.count),
        }));
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet counts by node:', error);
        return [];
      }
    }

    // For MySQL
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const params: any[] = [];
        const conditions: string[] = [];

        if (since !== undefined) {
          conditions.push(`pl.timestamp >= ?`);
          params.push(since);
        }
        if (portnum !== undefined) {
          conditions.push(`pl.portnum = ?`);
          params.push(portnum);
        }

        let query = `
          SELECT
            pl.from_node,
            n.nodeId as from_node_id,
            n.longName as from_node_longName,
            COUNT(*) as count
          FROM packet_log pl
          LEFT JOIN nodes n ON pl.from_node = n.nodeNum
        `;

        if (conditions.length > 0) {
          query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` GROUP BY pl.from_node, n.nodeId, n.longName ORDER BY count DESC LIMIT ?`;
        params.push(limit);

        const [rows] = await this.mysqlPool.query(query, params);
        return ((rows as any[]) ?? []).map((row: any) => ({
          from_node: Number(row.from_node),
          from_node_id: row.from_node_id,
          from_node_longName: row.from_node_longName,
          count: Number(row.count),
        }));
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet counts by node:', error);
        return [];
      }
    }

    // For SQLite
    try {
      const params: any[] = [];
      const conditions: string[] = [];

      if (since !== undefined) {
        conditions.push(`pl.timestamp >= ?`);
        params.push(since);
      }
      if (portnum !== undefined) {
        conditions.push(`pl.portnum = ?`);
        params.push(portnum);
      }

      let query = `
        SELECT
          pl.from_node,
          n.nodeId as from_node_id,
          n.longName as from_node_longName,
          COUNT(*) as count
        FROM packet_log pl
        LEFT JOIN nodes n ON pl.from_node = n.nodeNum
      `;

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` GROUP BY pl.from_node ORDER BY count DESC LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as any[];
      return rows.map((row: any) => ({
        from_node: Number(row.from_node),
        from_node_id: row.from_node_id,
        from_node_longName: row.from_node_longName,
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[DatabaseService] Failed to get packet counts by node:', error);
      return [];
    }
  }

  /**
   * Get packet counts grouped by portnum (for distribution charts)
   * Includes port name from meshtastic constants
   */
  async getPacketCountsByPortnumAsync(options?: { since?: number; from_node?: number }): Promise<DbPacketCountByPortnum[]> {
    const { since, from_node } = options || {};

    // For PostgreSQL
    if (this.drizzleDbType === 'postgres' && this.postgresPool) {
      try {
        const params: any[] = [];
        let paramIndex = 1;
        const conditions: string[] = [];

        if (since !== undefined) {
          conditions.push(`timestamp >= $${paramIndex++}`);
          params.push(since);
        }
        if (from_node !== undefined) {
          conditions.push(`from_node = $${paramIndex++}`);
          params.push(from_node);
        }

        let query = `
          SELECT
            portnum,
            COUNT(*) as count
          FROM packet_log
        `;

        if (conditions.length > 0) {
          query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` GROUP BY portnum ORDER BY count DESC`;

        const result = await this.postgresPool.query(query, params);
        return (result.rows ?? []).map((row: any) => ({
          portnum: Number(row.portnum),
          portnum_name: getPortNumName(Number(row.portnum)),
          count: Number(row.count),
        }));
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet counts by portnum:', error);
        return [];
      }
    }

    // For MySQL
    if (this.drizzleDbType === 'mysql' && this.mysqlPool) {
      try {
        const params: any[] = [];
        const conditions: string[] = [];

        if (since !== undefined) {
          conditions.push(`timestamp >= ?`);
          params.push(since);
        }
        if (from_node !== undefined) {
          conditions.push(`from_node = ?`);
          params.push(from_node);
        }

        let query = `
          SELECT
            portnum,
            COUNT(*) as count
          FROM packet_log
        `;

        if (conditions.length > 0) {
          query += ` WHERE ${conditions.join(' AND ')}`;
        }

        query += ` GROUP BY portnum ORDER BY count DESC`;

        const [rows] = await this.mysqlPool.query(query, params);
        return ((rows as any[]) ?? []).map((row: any) => ({
          portnum: Number(row.portnum),
          portnum_name: getPortNumName(Number(row.portnum)),
          count: Number(row.count),
        }));
      } catch (error) {
        logger.error('[DatabaseService] Failed to get packet counts by portnum:', error);
        return [];
      }
    }

    // For SQLite
    try {
      const conditions: string[] = [];
      const params: any[] = [];

      if (since !== undefined) {
        conditions.push(`timestamp >= ?`);
        params.push(since);
      }
      if (from_node !== undefined) {
        conditions.push(`from_node = ?`);
        params.push(from_node);
      }

      let query = `
        SELECT
          portnum,
          COUNT(*) as count
        FROM packet_log
      `;

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` GROUP BY portnum ORDER BY count DESC`;

      const stmt = this.db.prepare(query);
      const rows = stmt.all(...params) as any[];
      return rows.map((row: any) => ({
        portnum: Number(row.portnum),
        portnum_name: getPortNumName(Number(row.portnum)),
        count: Number(row.count),
      }));
    } catch (error) {
      logger.error('[DatabaseService] Failed to get packet counts by portnum:', error);
      return [];
    }
  }

  // Custom Themes Methods

  /**
   * Get all themes (custom only - built-in themes are in CSS)
   */
  getAllCustomThemes(): DbCustomTheme[] {
    // For PostgreSQL/MySQL, custom themes not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return [];
    }
    try {
      const stmt = this.db.prepare(`
        SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
        FROM custom_themes
        ORDER BY name ASC
      `);
      const themes = stmt.all() as DbCustomTheme[];
      logger.debug(`📚 Retrieved ${themes.length} custom themes`);
      return themes;
    } catch (error) {
      logger.error('❌ Failed to get custom themes:', error);
      throw error;
    }
  }

  /**
   * Get a specific theme by slug
   */
  getCustomThemeBySlug(slug: string): DbCustomTheme | undefined {
    // For PostgreSQL/MySQL, custom themes not yet implemented
    if (this.drizzleDbType === 'postgres' || this.drizzleDbType === 'mysql') {
      return undefined;
    }
    try {
      const stmt = this.db.prepare(`
        SELECT id, name, slug, definition, is_builtin, created_by, created_at, updated_at
        FROM custom_themes
        WHERE slug = ?
      `);
      const theme = stmt.get(slug) as DbCustomTheme | undefined;
      if (theme) {
        logger.debug(`🎨 Retrieved custom theme: ${theme.name}`);
      }
      return theme;
    } catch (error) {
      logger.error(`❌ Failed to get custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Create a new custom theme
   */
  createCustomTheme(name: string, slug: string, definition: ThemeDefinition, userId?: number): DbCustomTheme {
    try {
      const now = Math.floor(Date.now() / 1000);
      const definitionJson = JSON.stringify(definition);

      const stmt = this.db.prepare(`
        INSERT INTO custom_themes (name, slug, definition, is_builtin, created_by, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?, ?)
      `);

      const result = stmt.run(name, slug, definitionJson, userId || null, now, now);
      const id = Number(result.lastInsertRowid);

      logger.debug(`✅ Created custom theme: ${name} (slug: ${slug})`);

      return {
        id,
        name,
        slug,
        definition: definitionJson,
        is_builtin: 0,
        created_by: userId,
        created_at: now,
        updated_at: now
      };
    } catch (error) {
      logger.error(`❌ Failed to create custom theme ${name}:`, error);
      throw error;
    }
  }

  /**
   * Update an existing custom theme
   */
  updateCustomTheme(slug: string, updates: Partial<{ name: string; definition: ThemeDefinition }>): boolean {
    try {
      const theme = this.getCustomThemeBySlug(slug);
      if (!theme) {
        logger.warn(`⚠️  Cannot update non-existent theme: ${slug}`);
        return false;
      }

      const now = Math.floor(Date.now() / 1000);
      const fieldsToUpdate: string[] = [];
      const values: any[] = [];

      if (updates.name !== undefined) {
        fieldsToUpdate.push('name = ?');
        values.push(updates.name);
      }

      if (updates.definition !== undefined) {
        fieldsToUpdate.push('definition = ?');
        values.push(JSON.stringify(updates.definition));
      }

      if (fieldsToUpdate.length === 0) {
        logger.debug('⏭️  No fields to update');
        return true;
      }

      fieldsToUpdate.push('updated_at = ?');
      values.push(now);
      values.push(slug);

      const stmt = this.db.prepare(`
        UPDATE custom_themes
        SET ${fieldsToUpdate.join(', ')}
        WHERE slug = ?
      `);

      stmt.run(...values);
      logger.debug(`✅ Updated custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`❌ Failed to update custom theme ${slug}:`, error);
      throw error;
    }
  }

  /**
   * Delete a custom theme
   */
  deleteCustomTheme(slug: string): boolean {
    try {
      const theme = this.getCustomThemeBySlug(slug);
      if (!theme) {
        logger.warn(`⚠️  Cannot delete non-existent theme: ${slug}`);
        return false;
      }

      if (theme.is_builtin) {
        logger.error(`❌ Cannot delete built-in theme: ${slug}`);
        throw new Error('Cannot delete built-in themes');
      }

      const stmt = this.db.prepare('DELETE FROM custom_themes WHERE slug = ?');
      stmt.run(slug);
      logger.debug(`🗑️  Deleted custom theme: ${slug}`);
      return true;
    } catch (error) {
      logger.error(`❌ Failed to delete custom theme ${slug}:`, error);
      throw error;
    }
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
   * Uses idempotent CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS
   * This ensures new tables are created when upgrading existing databases
   */
  private async createPostgresSchema(pool: PgPool): Promise<void> {
    logger.info('[PostgreSQL] Ensuring database schema is up to date...');

    const client = await pool.connect();
    try {
      // Run migration 056 FIRST to fix backup_history table schema
      // This must run before POSTGRES_SCHEMA_SQL which creates indexes on columns that may not exist
      await runMigration056Postgres(client);

      // Execute the canonical schema SQL - all statements are idempotent
      // (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS)
      await client.query(POSTGRES_SCHEMA_SQL);

      // Run migration 047: Convert position override columns to BOOLEAN
      await runMigration047Postgres(client);

      // Run migration 049: Add missing notification channel settings columns
      await runMigration049Postgres(client);

      // Run migration 050: Add channel database tables
      await runMigration050Postgres(client);

      // Run migration 051: Add decrypted_by column to messages
      await runMigration051Postgres(client);

      // Run migration 052: Fix upgrade_history schema
      await runMigration052Postgres(client);

      // Run migration 053: Add viewOnMap permission column
      await runMigration053Postgres(client);

      // Run migration 054: Add news tables
      await runMigration054Postgres(client);

      // Run migration 055: Add remote admin discovery columns
      await runMigration055Postgres(client);

      // Run migration 057: Add via_mqtt column to packet_log
      await runMigration057Postgres(client);

      // Run migration 058: Convert via_mqtt to transport_mechanism
      await runMigration058Postgres(client);

      // Run migration 059: Add canViewOnMap to channel_database_permissions
      await runMigration059Postgres(client);

      // Run migration 060: Add enabled column to auto_traceroute_nodes
      await runMigration060Postgres(client);

      // Run migration 061: Add spam detection columns to nodes
      await runMigration061Postgres(client);

      // Run migration 062: Upgrade position columns from REAL to DOUBLE PRECISION
      await runMigration062Postgres(client);

      // Run migration 063: Add position_history_hours column
      await runMigration063Postgres(client);

      // Run migration 064: Add enforce_name_validation column to channel_database
      await runMigration064Postgres(client);

      // Run migration 065: Add sortOrder column to channel_database
      await runMigration065Postgres(client);

      // Run migration 066: Add ignored_nodes table
      await runMigration066Postgres(client);

      // Run migration 067: Add auto time sync schema
      await runMigration067Postgres(client);

      // Run migration 068: Add MFA columns to users table
      await runMigration068Postgres(client);

      // Run migration 069: Add position snapshot columns to traceroutes and route_segments
      await runMigration069Postgres(client);

      // Run migration 070: Add MeshCore tables
      await runMigration070MeshcorePostgres(client);

      // Run migration 071: Add meshcore permission resource
      await runMigration071Postgres(client);

      // Run migration 072: Add DM unread index
      await runMigration072Postgres(client);


      // Verify all expected tables exist
      const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
      `);
      const existingTables = new Set(result.rows.map(r => r.table_name));
      const missingTables = POSTGRES_TABLE_NAMES.filter(t => !existingTables.has(t));

      if (missingTables.length > 0) {
        logger.warn(`[PostgreSQL] Missing tables after schema creation: ${missingTables.join(', ')}`);
      } else {
        logger.info(`[PostgreSQL] Schema verified: all ${POSTGRES_TABLE_NAMES.length} tables present`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Create or update MySQL schema
   * Uses idempotent CREATE TABLE IF NOT EXISTS
   * This ensures new tables are created when upgrading existing databases
   */
  private async createMySQLSchema(pool: MySQLPool): Promise<void> {
    logger.info('[MySQL] Ensuring database schema is up to date...');

    // Run migration 056 FIRST to fix backup_history table schema
    // This must run before MYSQL_SCHEMA_SQL which creates indexes on columns that may not exist
    await runMigration056Mysql(pool);

    const connection = await pool.getConnection();
    try {
      // Split the schema SQL by semicolons and execute each statement
      // MySQL doesn't support multi-statement queries by default
      const statements = MYSQL_SCHEMA_SQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

      let executed = 0;
      for (const stmt of statements) {
        try {
          await connection.query(stmt);
          executed++;
        } catch (error: any) {
          // Ignore "index already exists" errors for idempotent index creation
          if (error.code === 'ER_DUP_KEYNAME') {
            logger.debug(`[MySQL] Index already exists, skipping: ${stmt.substring(0, 50)}...`);
          } else {
            throw error;
          }
        }
      }

      logger.debug(`[MySQL] Executed ${executed} schema statements`);

      // Run migration 047: Convert position override columns to BOOLEAN
      await runMigration047Mysql(pool);

      // Run migration 049: Add missing notification channel settings columns
      await runMigration049Mysql(pool);

      // Run migration 050: Add channel database tables
      await runMigration050Mysql(pool);

      // Run migration 051: Add decrypted_by column to messages
      await runMigration051Mysql(pool);

      // Run migration 052: Fix upgrade_history schema
      await runMigration052Mysql(pool);

      // Run migration 053: Add viewOnMap permission column
      await runMigration053Mysql(pool);

      // Run migration 054: Add news tables
      await runMigration054Mysql(pool);

      // Run migration 055: Add remote admin discovery columns
      await runMigration055Mysql(pool);

      // Run migration 057: Add via_mqtt column to packet_log
      await runMigration057Mysql(pool);

      // Run migration 058: Convert via_mqtt to transport_mechanism
      await runMigration058Mysql(pool);

      // Run migration 059: Add canViewOnMap to channel_database_permissions
      await runMigration059Mysql(pool);

      // Run migration 060: Add enabled column to auto_traceroute_nodes
      await runMigration060Mysql(pool);

      // Run migration 061: Add spam detection columns to nodes
      await runMigration061Mysql(pool);

      // Run migration 062: Position precision (no-op for MySQL, already uses DOUBLE)
      await runMigration062Mysql(pool);

      // Run migration 063: Add position_history_hours column
      await runMigration063Mysql(pool);

      // Run migration 064: Add enforce_name_validation column to channel_database
      await runMigration064Mysql(pool);

      // Run migration 065: Add sortOrder column to channel_database
      await runMigration065Mysql(pool);

      // Run migration 066: Add ignored_nodes table
      await runMigration066Mysql(pool);

      // Run migration 067: Add auto time sync schema
      await runMigration067Mysql(pool);

      // Run migration 068: Add MFA columns to users table
      await runMigration068Mysql(pool);

      // Run migration 069: Add position snapshot columns to traceroutes and route_segments
      await runMigration069Mysql(pool);

      // Run migration 070: Add MeshCore tables
      await runMigration070MeshcoreMysql(pool);

      // Run migration 071: Add meshcore permission resource
      await runMigration071Mysql(pool);

      // Run migration 072: Add DM unread index
      await runMigration072Mysql(pool);


      // Verify all expected tables exist
      const [rows] = await connection.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = DATABASE()
      `);
      const existingTables = new Set((rows as any[]).map(r => r.table_name || r.TABLE_NAME));
      const missingTables = MYSQL_TABLE_NAMES.filter(t => !existingTables.has(t));

      if (missingTables.length > 0) {
        logger.warn(`[MySQL] Missing tables after schema creation: ${missingTables.join(', ')}`);
      } else {
        logger.info(`[MySQL] Schema verified: all ${MYSQL_TABLE_NAMES.length} tables present`);
      }
    } finally {
      connection.release();
    }
  }

  // ============ ASYNC AUTH METHODS FOR POSTGRESQL ============
  // These methods delegate to the authRepo for PostgreSQL/MySQL support

  /**
   * Async method to find a user by username.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async findUserByUsernameAsync(username: string): Promise<any | null> {
    if (this.authRepo) {
      const dbUser = await this.authRepo.getUserByUsername(username);
      if (!dbUser) return null;
      // Map DbUser to User type expected by auth middleware
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
    // Fallback to sync for SQLite if repo not ready
    return this.userModel.findByUsername(username);
  }

  /**
   * Async method to authenticate a user with username and password.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   * Returns the user if authentication succeeds, null otherwise.
   */
  async authenticateAsync(username: string, password: string): Promise<any | null> {
    if (this.authRepo) {
      const dbUser = await this.authRepo.getUserByUsername(username);
      if (!dbUser || !dbUser.passwordHash) return null;

      // Verify password using bcrypt
      const bcrypt = await import('bcrypt');
      const isValid = await bcrypt.compare(password, dbUser.passwordHash);
      if (!isValid) return null;

      // Update last login
      await this.authRepo.updateUser(dbUser.id, { lastLoginAt: Date.now() });

      // Map DbUser to User type
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
        lastLoginAt: Date.now(),
      };
    }
    // Fallback to sync for SQLite
    return this.userModel.authenticate(username, password);
  }

  /**
   * Async method to validate an API token.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   * Returns the user associated with the token if valid, null otherwise.
   */
  async validateApiTokenAsync(token: string): Promise<any | null> {
    if (this.authRepo) {
      const result = await this.authRepo.validateApiToken(token);
      if (!result) return null;
      // Map DbUser to User type
      return {
        id: result.id,
        username: result.username,
        passwordHash: result.passwordHash,
        email: result.email,
        displayName: result.displayName,
        authProvider: result.authMethod,
        oidcSubject: result.oidcSubject,
        isAdmin: result.isAdmin,
        isActive: result.isActive,
        passwordLocked: result.passwordLocked,
        createdAt: result.createdAt,
        lastLoginAt: result.lastLoginAt,
      };
    }
    // Fallback to sync for SQLite - apiTokenModel.validate returns userId
    const userId = await this.apiTokenModel.validate(token);
    if (!userId) return null;
    return this.userModel.findById(userId);
  }

  /**
   * Async method to find a user by ID.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async findUserByIdAsync(id: number): Promise<any | null> {
    if (this.authRepo) {
      const dbUser = await this.authRepo.getUserById(id);
      if (!dbUser) return null;
      // Map DbUser to User type expected by auth middleware
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
    // Fallback to sync for SQLite if repo not ready
    return this.userModel.findById(id);
  }

  /**
   * Async method to check user permission.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async checkPermissionAsync(userId: number, resource: string, action: string): Promise<boolean> {
    if (this.authRepo) {
      const permissions = await this.authRepo.getPermissionsForUser(userId);
      for (const perm of permissions) {
        if (perm.resource === resource) {
          if (action === 'viewOnMap') return perm.canViewOnMap;
          if (action === 'read') return perm.canRead;
          if (action === 'write') return perm.canWrite;
        }
      }
      return false;
    }
    // Fallback to sync for SQLite if repo not ready
    return this.permissionModel.check(userId, resource as any, action as any);
  }

  /**
   * Async method to get user permission set.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   * Returns permissions in the same format as PermissionModel.getUserPermissionSet()
   */
  async getUserPermissionSetAsync(userId: number): Promise<Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }>> {
    if (this.authRepo) {
      const permissions = await this.authRepo.getPermissionsForUser(userId);
      const permissionSet: Record<string, { viewOnMap?: boolean; read: boolean; write: boolean }> = {};
      for (const perm of permissions) {
        permissionSet[perm.resource] = {
          viewOnMap: perm.canViewOnMap ?? false,
          read: perm.canRead,
          write: perm.canWrite,
        };
      }
      return permissionSet;
    }
    // Fallback to sync for SQLite if repo not ready
    return this.permissionModel.getUserPermissionSet(userId);
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
    ipAddress: string
  ): Promise<void> {
    if (this.authRepo) {
      try {
        await this.authRepo.createAuditLogEntry({
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
      return;
    }
    // Fallback to sync for SQLite
    this.auditLog(userId, action, resource, details, ipAddress);
  }

  // ============ ASYNC MESSAGE METHODS ============
  // These methods provide async access to message operations for multi-database support

  /**
   * Async method to get a message by ID.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async getMessageAsync(id: string): Promise<DbMessage | null> {
    if (this.messagesRepo) {
      const result = await this.messagesRepo.getMessage(id);
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
    // Fallback to sync for SQLite
    return this.getMessage(id);
  }

  /**
   * Async method to delete a message by ID.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async deleteMessageAsync(id: string): Promise<boolean> {
    if (this.messagesRepo) {
      return this.messagesRepo.deleteMessage(id);
    }
    // Fallback to sync for SQLite
    return this.deleteMessage(id);
  }

  /**
   * Async method to purge all messages from a channel.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async purgeChannelMessagesAsync(channel: number): Promise<number> {
    if (this.messagesRepo) {
      return this.messagesRepo.purgeChannelMessages(channel);
    }
    // Fallback to sync for SQLite
    return this.purgeChannelMessages(channel);
  }

  /**
   * Async method to purge all direct messages with a node.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async purgeDirectMessagesAsync(nodeNum: number): Promise<number> {
    if (this.messagesRepo) {
      return this.messagesRepo.purgeDirectMessages(nodeNum);
    }
    // Fallback to sync for SQLite
    return this.purgeDirectMessages(nodeNum);
  }

  /**
   * Async method to purge all traceroutes for a node.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async purgeNodeTraceroutesAsync(nodeNum: number): Promise<number> {
    if (this.traceroutesRepo) {
      return this.traceroutesRepo.deleteTraceroutesForNode(nodeNum);
    }
    // Fallback to sync for SQLite
    return this.purgeNodeTraceroutes(nodeNum);
  }

  /**
   * Async method to purge all telemetry for a node.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async purgeNodeTelemetryAsync(nodeNum: number): Promise<number> {
    if (this.telemetryRepo) {
      return this.telemetryRepo.purgeNodeTelemetry(nodeNum);
    }
    // Fallback to sync for SQLite
    return this.purgeNodeTelemetry(nodeNum);
  }

  /**
   * Async method to update user password.
   * Works with all database backends (SQLite, PostgreSQL, MySQL).
   */
  async updatePasswordAsync(userId: number, newPassword: string): Promise<void> {
    // Import bcrypt dynamically to avoid circular dependencies
    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(newPassword, 10);

    if (this.authRepo) {
      await this.authRepo.updateUser(userId, { passwordHash });
      return;
    }
    // Fallback to sync for SQLite
    await this.userModel.updatePassword(userId, newPassword);
  }

  // ============ ASYNC MFA METHODS ============

  /**
   * Update MFA secret and backup codes for a user.
   */
  async updateUserMfaSecretAsync(userId: number, secret: string, backupCodes: string): Promise<void> {
    if (this.authRepo) {
      await this.authRepo.updateUser(userId, { mfaSecret: secret, mfaBackupCodes: backupCodes });
      return;
    }
    // Fallback to sync for SQLite
    this.userModel.update(userId, { mfaSecret: secret, mfaBackupCodes: backupCodes });
  }

  /**
   * Clear MFA data for a user (disable MFA).
   */
  async clearUserMfaAsync(userId: number): Promise<void> {
    if (this.authRepo) {
      await this.authRepo.updateUser(userId, { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
      return;
    }
    // Fallback to sync for SQLite
    this.userModel.update(userId, { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: null });
  }

  /**
   * Enable MFA for a user (set mfaEnabled to true).
   */
  async enableUserMfaAsync(userId: number): Promise<void> {
    if (this.authRepo) {
      await this.authRepo.updateUser(userId, { mfaEnabled: true });
      return;
    }
    // Fallback to sync for SQLite
    this.userModel.update(userId, { mfaEnabled: true });
  }

  /**
   * Update backup codes for a user (after one is consumed).
   */
  async consumeBackupCodeAsync(userId: number, remainingCodes: string): Promise<void> {
    if (this.authRepo) {
      await this.authRepo.updateUser(userId, { mfaBackupCodes: remainingCodes });
      return;
    }
    // Fallback to sync for SQLite
    this.userModel.update(userId, { mfaBackupCodes: remainingCodes });
  }

  // ============ ASYNC CHANNEL DATABASE METHODS ============
  // These methods provide server-side decryption channel management

  /**
   * Get a channel database entry by ID
   */
  async getChannelDatabaseByIdAsync(id: number): Promise<import('../db/types.js').DbChannelDatabase | null> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getByIdAsync(id);
  }

  /**
   * Get all channel database entries
   */
  async getAllChannelDatabaseEntriesAsync(): Promise<import('../db/types.js').DbChannelDatabase[]> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getAllAsync();
  }

  /**
   * Get all enabled channel database entries (for decryption)
   */
  async getEnabledChannelDatabaseEntriesAsync(): Promise<import('../db/types.js').DbChannelDatabase[]> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getEnabledAsync();
  }

  /**
   * Create a new channel database entry
   */
  async createChannelDatabaseEntryAsync(data: {
    name: string;
    psk: string;
    pskLength: number;
    description?: string | null;
    isEnabled?: boolean;
    enforceNameValidation?: boolean;
    createdBy?: number | null;
  }): Promise<number> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.createAsync(data);
  }

  /**
   * Update a channel database entry
   */
  async updateChannelDatabaseEntryAsync(id: number, data: {
    name?: string;
    psk?: string;
    pskLength?: number;
    description?: string | null;
    isEnabled?: boolean;
    enforceNameValidation?: boolean;
    sortOrder?: number;
  }): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.updateAsync(id, data);
  }

  /**
   * Delete a channel database entry
   */
  async deleteChannelDatabaseEntryAsync(id: number): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.deleteAsync(id);
  }

  /**
   * Reorder channel database entries
   * Updates the sortOrder for each entry in the provided array
   */
  async reorderChannelDatabaseEntriesAsync(updates: { id: number; sortOrder: number }[]): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.reorderAsync(updates);
  }

  /**
   * Increment decrypted packet count for a channel
   */
  async incrementChannelDatabaseDecryptedCountAsync(id: number): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.incrementDecryptedCountAsync(id);
  }

  /**
   * Get permission for a specific user and channel database
   */
  async getChannelDatabasePermissionAsync(userId: number, channelDatabaseId: number): Promise<import('../db/types.js').DbChannelDatabasePermission | null> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getPermissionAsync(userId, channelDatabaseId);
  }

  /**
   * Get all channel database permissions for a user
   */
  async getChannelDatabasePermissionsForUserAsync(userId: number): Promise<import('../db/types.js').DbChannelDatabasePermission[]> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getPermissionsForUserAsync(userId);
  }

  /**
   * Get all permissions for a channel database entry
   */
  async getChannelDatabasePermissionsForChannelAsync(channelDatabaseId: number): Promise<import('../db/types.js').DbChannelDatabasePermission[]> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.getPermissionsForChannelAsync(channelDatabaseId);
  }

  /**
   * Set permission for a user on a channel database entry
   */
  async setChannelDatabasePermissionAsync(data: {
    userId: number;
    channelDatabaseId: number;
    canViewOnMap: boolean;
    canRead: boolean;
    grantedBy?: number | null;
  }): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.setPermissionAsync(data);
  }

  /**
   * Get channel database permissions for a user as a map keyed by channel database ID
   * Returns { [channelDbId]: { viewOnMap: boolean, read: boolean } }
   */
  async getChannelDatabasePermissionsForUserAsSetAsync(userId: number): Promise<{
    [channelDbId: number]: { viewOnMap: boolean; read: boolean }
  }> {
    const permissions = await this.getChannelDatabasePermissionsForUserAsync(userId);
    const result: { [channelDbId: number]: { viewOnMap: boolean; read: boolean } } = {};
    for (const perm of permissions) {
      result[perm.channelDatabaseId] = {
        viewOnMap: perm.canViewOnMap,
        read: perm.canRead,
      };
    }
    return result;
  }

  /**
   * Delete permission for a user on a channel database entry
   */
  async deleteChannelDatabasePermissionAsync(userId: number, channelDatabaseId: number): Promise<void> {
    if (!this.channelDatabaseRepo) {
      throw new Error('Channel database repository not initialized');
    }
    return this.channelDatabaseRepo.deletePermissionAsync(userId, channelDatabaseId);
  }

  // ============ NEWS CACHE ============

  /**
   * Get cached news feed
   */
  async getNewsCacheAsync(): Promise<{ feedData: string; fetchedAt: number; sourceUrl: string } | null> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.getNewsCache();
  }

  /**
   * Save news feed to cache
   */
  async saveNewsCacheAsync(feedData: string, sourceUrl: string): Promise<void> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    const now = Math.floor(Date.now() / 1000);
    return this.miscRepo.saveNewsCache({
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
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    const status = await this.miscRepo.getUserNewsStatus(userId);
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
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.saveUserNewsStatus({
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
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.insertBackupHistory({
      ...backup,
      createdAt: Date.now(),
    });
  }

  /**
   * Get all backup history records ordered by timestamp (newest first)
   */
  async getBackupHistoryListAsync(): Promise<Array<{
    id?: number;
    filename: string;
    filePath: string;
    timestamp: number;
    backupType: string;
    fileSize?: number | null;
    nodeId?: string | null;
    nodeNum?: number | null;
    createdAt: number;
  }>> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.getBackupHistoryList();
  }

  /**
   * Get a backup history record by filename
   */
  async getBackupByFilenameAsync(filename: string): Promise<{
    id?: number;
    filename: string;
    filePath: string;
    timestamp: number;
    backupType: string;
    fileSize?: number | null;
    nodeId?: string | null;
    nodeNum?: number | null;
    createdAt: number;
  } | null> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.getBackupByFilename(filename);
  }

  /**
   * Delete a backup history record by filename
   */
  async deleteBackupHistoryAsync(filename: string): Promise<void> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.deleteBackupHistory(filename);
  }

  /**
   * Count total backup history records
   */
  async countBackupsAsync(): Promise<number> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.countBackups();
  }

  /**
   * Get oldest backup history records (for purging)
   */
  async getOldestBackupsAsync(limit: number): Promise<Array<{
    id?: number;
    filename: string;
    filePath: string;
    timestamp: number;
    backupType: string;
    fileSize?: number | null;
    nodeId?: string | null;
    nodeNum?: number | null;
    createdAt: number;
  }>> {
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    return this.miscRepo.getOldestBackups(limit);
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
    if (!this.miscRepo) {
      throw new Error('Misc repository not initialized');
    }
    const stats = await this.miscRepo.getBackupStats();
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
  async getAutoTimeSyncNodesAsync(): Promise<number[]> {
    if (this.miscRepo) {
      return await this.miscRepo.getAutoTimeSyncNodes();
    }
    return [];
  }

  /**
   * Set auto time sync nodes
   */
  async setAutoTimeSyncNodesAsync(nodeNums: number[]): Promise<void> {
    if (this.miscRepo) {
      await this.miscRepo.setAutoTimeSyncNodes(nodeNums);
      logger.debug(`✅ Set auto-time-sync filter to ${nodeNums.length} nodes`);
    }
  }

  /**
   * Get time sync filter settings
   */
  async getTimeSyncFilterSettingsAsync(): Promise<{
    enabled: boolean;
    nodeNums: number[];
    filterEnabled: boolean;
    expirationHours: number;
    intervalMinutes: number;
  }> {
    const nodeNums = await this.getAutoTimeSyncNodesAsync();
    return {
      enabled: this.isAutoTimeSyncEnabled(),
      nodeNums,
      filterEnabled: this.isAutoTimeSyncNodeFilterEnabled(),
      expirationHours: this.getAutoTimeSyncExpirationHours(),
      intervalMinutes: this.getAutoTimeSyncIntervalMinutes(),
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
  }): Promise<void> {
    if (settings.enabled !== undefined) {
      this.setAutoTimeSyncEnabled(settings.enabled);
    }
    if (settings.nodeNums !== undefined) {
      await this.setAutoTimeSyncNodesAsync(settings.nodeNums);
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
  async getNodeNeedingTimeSyncAsync(): Promise<DbNode | null> {
    if (!this.nodesRepo) {
      return null;
    }

    const activeHours = 48; // Only consider nodes heard in last 48 hours
    // lastHeard is stored in seconds, so convert cutoff to seconds
    const activeNodeCutoff = Math.floor((Date.now() - (activeHours * 60 * 60 * 1000)) / 1000);
    const expirationHours = this.getAutoTimeSyncExpirationHours();
    // lastTimeSync is stored in milliseconds
    const expirationMsAgo = Date.now() - (expirationHours * 60 * 60 * 1000);

    // Get filter settings
    let filterNodeNums: number[] | undefined;
    if (this.isAutoTimeSyncNodeFilterEnabled()) {
      filterNodeNums = await this.getAutoTimeSyncNodesAsync();
      if (filterNodeNums.length === 0) {
        // Filter is enabled but no nodes selected - skip
        return null;
      }
    }

    const node = await this.nodesRepo.getNodeNeedingTimeSyncAsync(
      activeNodeCutoff,
      expirationMsAgo,
      filterNodeNums
    );
    return node as DbNode | null;
  }

  /**
   * Update a node's lastTimeSync timestamp
   */
  async updateNodeTimeSyncAsync(nodeNum: number, timestamp: number): Promise<void> {
    if (this.nodesRepo) {
      await this.nodesRepo.updateNodeTimeSyncAsync(nodeNum, timestamp);
    }
  }
}

// Export the class for testing purposes (allows creating isolated test instances)
export { DatabaseService };

export default new DatabaseService();