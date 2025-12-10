import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { calculateDistance } from '../utils/distance.js';
import { logger } from '../utils/logger.js';
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
import { validateThemeDefinition as validateTheme } from '../utils/themeValidation.js';

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
  mobile?: number; // 0 = not mobile, 1 = mobile (moved >100m)
  rebootCount?: number;
  publicKey?: string;
  hasPKC?: boolean;
  lastPKIPacket?: number;
  keyIsLowEntropy?: boolean;
  duplicateKeyDetected?: boolean;
  keySecurityIssueDetails?: string;
  welcomedAt?: number;
  // Position precision tracking (Migration 020)
  positionChannel?: number; // Which channel the position came from
  positionPrecisionBits?: number; // Position precision (0-32 bits, higher = more precise)
  positionGpsAccuracy?: number; // GPS accuracy in meters
  positionHdop?: number; // Horizontal Dilution of Precision
  positionTimestamp?: number; // When this position was received (for upgrade/downgrade logic)
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
  replyId?: number;
  emoji?: number;
  createdAt: number;
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
  payload_size?: number;
  want_ack?: boolean;
  priority?: number;
  payload_preview?: string;
  metadata?: string;
  created_at?: number;
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
  public db: Database.Database;
  private isInitialized = false;
  public userModel: UserModel;
  public permissionModel: PermissionModel;
  public apiTokenModel: APITokenModel;

  constructor() {
    logger.debug('🔧🔧🔧 DatabaseService constructor called');
    // Use DATABASE_PATH env var if set, otherwise default to /data/meshmonitor.db
    const dbPath = getEnvironmentConfig().databasePath;

    logger.debug('Initializing database at:', dbPath);

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
      const err = error as NodeJS.ErrnoException;
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
      this.db = new Database(dbPath);
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

    this.initialize();
    // Channel 0 will be created automatically when the device syncs its configuration
    // Always ensure broadcast node exists for channel messages
    this.ensureBroadcastNode();
    // Ensure admin user exists for authentication
    this.ensureAdminUser();
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
    this.runAutoWelcomeMigration();
    this.runUserMapPreferencesMigration();
    this.runInactiveNodeNotificationMigration();
    this.ensureAutomationDefaults();
    this.isInitialized = true;
  }

  private ensureAutomationDefaults(): void {
    logger.debug('Ensuring automation default settings...');
    try {
      // Only set defaults if they don't exist
      const automationSettings = {
        autoAckEnabled: 'false',
        autoAckRegex: '^(test|ping)',
        autoAckUseDM: 'false',
        autoAnnounceEnabled: 'false',
        autoAnnounceIntervalHours: '6',
        autoAnnounceMessage: 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}',
        autoAnnounceChannelIndex: '0',
        autoAnnounceOnStart: 'false',
        autoAnnounceUseSchedule: 'false',
        autoAnnounceSchedule: '0 */6 * * *',
        tracerouteIntervalMinutes: '0',
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
      const tableCheck = this.db
        .prepare(
          `
        SELECT name FROM sqlite_master WHERE type='table' AND name='users'
      `
        )
        .get();

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

  private runAutoWelcomeMigration(): void {
    try {
      const migrationKey = 'migration_017_auto_welcome_existing_nodes';
      const migrationCompleted = this.getSetting(migrationKey);

      if (migrationCompleted === 'completed') {
        logger.debug('✅ Auto-welcome existing nodes migration already completed');
        return;
      }

      logger.debug('Running migration 017: Mark existing nodes as already welcomed...');

      // Get all existing nodes
      const stmt = this.db.prepare('SELECT nodeNum, nodeId, createdAt FROM nodes WHERE welcomedAt IS NULL');
      const nodes = stmt.all() as Array<{ nodeNum: number; nodeId: string; createdAt?: number }>;

      if (nodes.length === 0) {
        logger.debug('No existing nodes to mark as welcomed');
      } else {
        logger.debug(`📊 Marking ${nodes.length} existing nodes as welcomed to prevent thundering herd...`);

        // Mark all existing nodes as already welcomed
        // Use their createdAt timestamp if available, otherwise use current timestamp
        const updateStmt = this.db.prepare('UPDATE nodes SET welcomedAt = ? WHERE nodeNum = ?');
        const currentTime = Date.now();

        let markedCount = 0;
        for (const node of nodes) {
          // Use the node's createdAt time if available, otherwise use current time
          const welcomedAt = node.createdAt || currentTime;
          updateStmt.run(welcomedAt, node.nodeNum);
          markedCount++;
        }

        logger.debug(`✅ Marked ${markedCount} existing nodes as welcomed`);
      }

      this.setSetting(migrationKey, 'completed');
      logger.debug('✅ Auto-welcome existing nodes migration completed successfully');
    } catch (error) {
      logger.error('❌ Failed to run auto-welcome existing nodes migration:', error);
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
          shortName: 'BCAST',
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
            if (fromNode?.latitude && fromNode?.longitude && toNode?.latitude && toNode?.longitude) {
              const distanceKm = calculateDistance(
                fromNode.latitude,
                fromNode.longitude,
                toNode.latitude,
                toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now(),
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
            if (fromNode?.latitude && fromNode?.longitude && toNode?.latitude && toNode?.longitude) {
              const distanceKm = calculateDistance(
                fromNode.latitude,
                fromNode.longitude,
                toNode.latitude,
                toNode.longitude
              );

              const segment: DbRouteSegment = {
                fromNodeNum,
                toNodeNum,
                fromNodeId: fromNode.nodeId,
                toNodeId: toNode.nodeId,
                distanceKm,
                isRecordHolder: false,
                timestamp: traceroute.timestamp,
                createdAt: Date.now(),
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
      logger.debug(
        `✅ Migration completed! Processed ${processedCount} traceroutes, created ${segmentsCreated} route segments`
      );
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
          keySecurityIssueDetails = COALESCE(?, keySecurityIssueDetails),
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
        nodeData.keySecurityIssueDetails || null,
        now,
        nodeData.nodeNum
      );
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO nodes (
          nodeNum, nodeId, longName, shortName, hwModel, role, hopsAway, viaMqtt, macaddr,
          latitude, longitude, altitude, batteryLevel, voltage,
          channelUtilization, airUtilTx, lastHeard, snr, rssi, firmwareVersion, channel,
          isFavorite, rebootCount, publicKey, hasPKC, lastPKIPacket, welcomedAt,
          keyIsLowEntropy, duplicateKeyDetected, keySecurityIssueDetails,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        nodeData.keySecurityIssueDetails || null,
        now,
        now
      );

      // Send notification for newly discovered node (only if not broadcast node)
      if (nodeData.nodeNum !== 4294967295 && nodeData.nodeId) {
        // Import notification service dynamically to avoid circular dependencies
        import('../server/services/notificationService.js')
          .then(({ notificationService }) => {
            notificationService
              .notifyNewNode(nodeData.nodeId!, nodeData.longName || nodeData.nodeId!, nodeData.hopsAway)
              .catch(err => logger.error('Failed to send new node notification:', err));
          })
          .catch(err => logger.error('Failed to import notification service:', err));
      }
    }
  }

  getNode(nodeNum: number): DbNode | null {
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE nodeNum = ?');
    const node = stmt.get(nodeNum) as DbNode | null;
    return node ? this.normalizeBigInts(node) : null;
  }

  getAllNodes(): DbNode[] {
    const stmt = this.db.prepare('SELECT * FROM nodes ORDER BY updatedAt DESC');
    const nodes = stmt.all() as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  getActiveNodes(sinceDays: number = 7): DbNode[] {
    // lastHeard is stored in seconds (Unix timestamp), so convert cutoff to seconds
    const cutoff = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE lastHeard > ? ORDER BY lastHeard DESC');
    const nodes = stmt.all(cutoff) as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  /**
   * Mark all existing nodes as welcomed to prevent thundering herd on startup
   * Should be called when Auto-Welcome is enabled during server initialization
   */
  markAllNodesAsWelcomed(): number {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE nodes SET welcomedAt = ? WHERE welcomedAt IS NULL');
    const result = stmt.run(now);
    return result.changes;
  }

  /**
   * Atomically mark a node as welcomed if not already welcomed
   * Returns true if the node was marked, false if it was already welcomed
   * This provides an atomic check-and-set operation to prevent race conditions
   */
  markNodeAsWelcomedIfNotAlready(nodeNum: number, nodeId: string): boolean {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE nodes 
      SET welcomedAt = ?, updatedAt = ? 
      WHERE nodeNum = ? AND nodeId = ? AND welcomedAt IS NULL
    `);
    const result = stmt.run(now, now, nodeNum, nodeId);
    return result.changes > 0;
  }

  /**
   * Get nodes with key security issues (low-entropy or duplicate keys)
   */
  getNodesWithKeySecurityIssues(): DbNode[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE keyIsLowEntropy = 1 OR duplicateKeyDetected = 1
      ORDER BY lastHeard DESC
    `);
    const nodes = stmt.all() as DbNode[];
    return nodes.map(node => this.normalizeBigInts(node));
  }

  /**
   * Get all nodes that have public keys (for duplicate detection)
   */
  getNodesWithPublicKeys(): Array<{ nodeNum: number; publicKey: string | null }> {
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

  // Message operations
  insertMessage(messageData: DbMessage): void {
    // Use INSERT OR IGNORE to silently skip duplicate messages
    // (mesh networks can retransmit packets or send duplicates during reconnections)
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (
        id, fromNodeNum, toNodeNum, fromNodeId, toNodeId,
        text, channel, portnum, timestamp, rxTime, hopStart, hopLimit, replyId, emoji,
        requestId, ackFailed, routingErrorReceived, deliveryState, wantAck, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      messageData.replyId ?? null,
      messageData.emoji ?? null,
      (messageData as any).requestId ?? null,
      (messageData as any).ackFailed ?? 0,
      (messageData as any).routingErrorReceived ?? 0,
      (messageData as any).deliveryState ?? null,
      (messageData as any).wantAck ?? 0,
      messageData.createdAt
    );
  }

  getMessage(id: string): DbMessage | null {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    const message = stmt.get(id) as DbMessage | null;
    return message ? this.normalizeBigInts(message) : null;
  }

  getMessageByRequestId(requestId: number): DbMessage | null {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE requestId = ?');
    const message = stmt.get(requestId) as DbMessage | null;
    return message ? this.normalizeBigInts(message) : null;
  }

  getMessages(limit: number = 100, offset: number = 0): DbMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ORDER BY COALESCE(rxTime, timestamp) DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getMessagesByChannel(channel: number, limit: number = 100, offset: number = 0): DbMessage[] {
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
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE (fromNodeId = ? AND toNodeId = ?)
         OR (fromNodeId = ? AND toNodeId = ?)
      ORDER BY COALESCE(rxTime, timestamp) DESC
      LIMIT ? OFFSET ?
    `);
    const messages = stmt.all(nodeId1, nodeId2, nodeId2, nodeId1, limit, offset) as DbMessage[];
    return messages.map(message => this.normalizeBigInts(message));
  }

  getMessagesAfterTimestamp(timestamp: number): DbMessage[] {
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
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getNodeCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM nodes');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getTelemetryCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM telemetry');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  getTelemetryCountByNode(nodeId: string, sinceTimestamp?: number, beforeTimestamp?: number, telemetryType?: string): number {
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
   * Update node mobility status based on position telemetry
   * Checks if a node has moved more than 100 meters based on its last 50 position records
   * @param nodeId The node ID to check
   * @returns The updated mobility status (0 = stationary, 1 = mobile)
   */
  updateNodeMobility(nodeId: string): number {
    try {
      // Get last 50 position telemetry records for this node
      const positionTelemetry = this.getPositionTelemetryByNode(nodeId, 50);

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
        const dLat = ((maxLat - minLat) * Math.PI) / 180;
        const dLon = ((maxLon - minLon) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((minLat * Math.PI) / 180) *
            Math.cos((maxLat * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = R * c;

        // If movement is greater than 100 meters (0.1 km), mark as mobile
        isMobile = distance > 0.1 ? 1 : 0;

        logger.debug(
          `📍 Node ${nodeId} mobility check: ${latitudes.length} positions, distance=${distance.toFixed(
            3
          )}km, mobile=${isMobile}`
        );
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

  getMessagesByDay(days: number = 7): Array<{ date: string; count: number }> {
    const stmt = this.db.prepare(`
      SELECT
        date(timestamp/1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM messages
      WHERE timestamp > ?
      GROUP BY date(timestamp/1000, 'unixepoch')
      ORDER BY date
    `);

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const results = stmt.all(cutoff) as Array<{ date: string; count: number }>;
    return results.map(row => ({
      date: row.date,
      count: Number(row.count),
    }));
  }

  // Cleanup operations
  cleanupOldMessages(days: number = 30): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM messages WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  cleanupInactiveNodes(days: number = 30): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM nodes WHERE lastHeard < ? OR lastHeard IS NULL');
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  // Message deletion operations
  deleteMessage(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const result = stmt.run(id);
    return Number(result.changes) > 0;
  }

  purgeChannelMessages(channel: number): number {
    const stmt = this.db.prepare('DELETE FROM messages WHERE channel = ?');
    const result = stmt.run(channel);
    return Number(result.changes);
  }

  purgeDirectMessages(nodeNum: number): number {
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
    // Delete all traceroutes involving this node (either as source or destination)
    const stmt = this.db.prepare(`
      DELETE FROM traceroutes
      WHERE fromNodeNum = ? OR toNodeNum = ?
    `);
    const result = stmt.run(nodeNum, nodeNum);
    return Number(result.changes);
  }

  purgeNodeTelemetry(nodeNum: number): number {
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
    // Delete all data associated with the node and then the node itself
    const messagesDeleted = this.purgeDirectMessages(nodeNum);
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
      nodeDeleted,
    };
  }

  deleteTelemetryByNodeAndType(nodeId: string, telemetryType: string): boolean {
    // Delete telemetry data for a specific node and type
    const stmt = this.db.prepare('DELETE FROM telemetry WHERE nodeId = ? AND telemetryType = ?');
    const result = stmt.run(nodeId, telemetryType);
    return Number(result.changes) > 0;
  }

  // Database maintenance
  vacuum(): void {
    this.db.exec('VACUUM');
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
        if (obj.hasOwnProperty(key)) {
          normalized[key] = this.normalizeBigInts(obj[key]);
        }
      }
      return normalized;
    }

    return obj;
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }

  // Export/Import functionality
  exportData(): { nodes: DbNode[]; messages: DbMessage[] } {
    return {
      nodes: this.getAllNodes(),
      messages: this.getMessages(10000), // Export last 10k messages
    };
  }

  importData(data: { nodes: DbNode[]; messages: DbMessage[] }): void {
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
          node.nodeNum,
          node.nodeId,
          node.longName,
          node.shortName,
          node.hwModel,
          node.macaddr,
          node.latitude,
          node.longitude,
          node.altitude,
          node.batteryLevel,
          node.voltage,
          node.channelUtilization,
          node.airUtilTx,
          node.lastHeard,
          node.snr,
          node.rssi,
          node.createdAt,
          node.updatedAt
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
          message.id,
          message.fromNodeNum,
          message.toNodeNum,
          message.fromNodeId,
          message.toNodeId,
          message.text,
          message.channel,
          message.portnum,
          message.timestamp,
          message.rxTime,
          message.createdAt
        );
      }
    });

    transaction();
  }

  // Channel operations
  upsertChannel(channelData: {
    id?: number;
    name: string;
    psk?: string;
    role?: number;
    uplinkEnabled?: boolean;
    downlinkEnabled?: boolean;
    positionPrecision?: number;
  }): void {
    const now = Date.now();

    // Defensive checks for channel roles:
    // 1. Channel 0 must NEVER be DISABLED (role=0) - it must be PRIMARY (role=1)
    // 2. Channels 1-7 must NEVER be PRIMARY (role=1) - they can only be SECONDARY (role=2) or DISABLED (role=0)
    // A mesh network requires exactly ONE PRIMARY channel, and Channel 0 is conventionally PRIMARY
    if (channelData.id === 0 && channelData.role === 0) {
      logger.warn(`⚠️  Blocking attempt to set Channel 0 role to DISABLED (0), forcing to PRIMARY (1)`);
      channelData = { ...channelData, role: 1 }; // Clone and override
    }

    if (channelData.id !== undefined && channelData.id > 0 && channelData.role === 1) {
      logger.warn(
        `⚠️  Blocking attempt to set Channel ${channelData.id} role to PRIMARY (1), forcing to SECONDARY (2)`
      );
      logger.warn(`⚠️  Only Channel 0 can be PRIMARY - all other channels must be SECONDARY or DISABLED`);
      channelData = { ...channelData, role: 2 }; // Clone and override to SECONDARY
    }

    logger.info(
      `📝 upsertChannel called with ID: ${channelData.id}, name: "${channelData.name}" (length: ${channelData.name.length})`
    );

    let existingChannel: DbChannel | null = null;

    // If we have an ID, check by ID FIRST
    if (channelData.id !== undefined) {
      existingChannel = this.getChannelById(channelData.id);
      logger.info(
        `📝 getChannelById(${channelData.id}) returned: ${existingChannel ? `"${existingChannel.name}"` : 'null'}`
      );
    }

    // Channel ID is required - we no longer support name-based lookups
    // All channels must have a numeric ID for proper indexing
    if (channelData.id === undefined) {
      logger.error(`❌ Cannot upsert channel without ID. Name: "${channelData.name}"`);
      throw new Error('Channel ID is required for upsert operation');
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
      logger.debug(
        `Created channel: ${channelData.name} (ID: ${
          channelData.id !== undefined ? channelData.id : 'auto'
        }), lastInsertRowid: ${result.lastInsertRowid}`
      );
    }
  }

  getChannelById(id: number): DbChannel | null {
    const stmt = this.db.prepare('SELECT * FROM channels WHERE id = ?');
    const channel = stmt.get(id) as DbChannel | null;
    if (id === 0) {
      logger.info(
        `🔍 getChannelById(0) - RAW from DB: ${
          channel ? `name="${channel.name}" (length: ${channel.name?.length || 0})` : 'null'
        }`
      );
    }
    return channel ? this.normalizeBigInts(channel) : null;
  }

  getAllChannels(): DbChannel[] {
    const stmt = this.db.prepare('SELECT * FROM channels ORDER BY id ASC');
    const channels = stmt.all() as DbChannel[];
    return channels.map(channel => this.normalizeBigInts(channel));
  }

  getChannelCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM channels');
    const result = stmt.get() as { count: number };
    return Number(result.count);
  }

  // Clean up invalid channels that shouldn't have been created
  // Meshtastic supports channels 0-7 (8 total channels)
  cleanupInvalidChannels(): number {
    const stmt = this.db.prepare(`DELETE FROM channels WHERE id < 0 OR id > 7`);
    const result = stmt.run();
    logger.debug(`🧹 Cleaned up ${result.changes} invalid channels (outside 0-7 range)`);
    return Number(result.changes);
  }

  // Clean up channels that appear to be empty/unused
  // Keep channels 0-1 (Primary and typically one active secondary)
  // Remove higher ID channels that have no PSK (not configured)
  cleanupEmptyChannels(): number {
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

  // Get only position-related telemetry (latitude, longitude, altitude) for a node
  // This is much more efficient than fetching all telemetry types - reduces data fetched by ~70%
  getPositionTelemetryByNode(nodeId: string, limit: number = 1500, sinceTimestamp?: number): DbTelemetry[] {
    let query = `
      SELECT * FROM telemetry
      WHERE nodeId = ?
        AND telemetryType IN ('latitude', 'longitude', 'altitude')
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

  /**
   * Get the latest estimated positions for all nodes in a single query.
   * This is much more efficient than querying each node individually (N+1 problem).
   * Returns a Map of nodeId -> { latitude, longitude } for nodes with estimated positions.
   */
  getAllNodesEstimatedPositions(): Map<string, { latitude: number; longitude: number }> {
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

  getTelemetryByNodeAveraged(
    nodeId: string,
    sinceTimestamp?: number,
    intervalMinutes?: number,
    maxHours?: number
  ): DbTelemetry[] {
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

    // Build the query to group and average telemetry data by time intervals
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
    `;
    const params: any[] = [intervalMs, intervalMs, nodeId];

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
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  insertTraceroute(tracerouteData: DbTraceroute): void {
    // Wrap in transaction to prevent race conditions
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
        tracerouteData.toNodeNum, // Reversed: response's toNum is the requester
        tracerouteData.fromNodeNum, // Reversed: response's fromNum is the destination
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

  getAllTraceroutes(limit: number = 100): DbTraceroute[] {
    const stmt = this.db.prepare(`
      SELECT * FROM traceroutes
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const traceroutes = stmt.all(limit) as DbTraceroute[];
    return traceroutes.map(t => this.normalizeBigInts(t));
  }

  getNodeNeedingTraceroute(localNodeNum: number): DbNode | null {
    const now = Date.now();
    const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

    // Check if node filter is enabled
    const filterEnabled = this.isAutoTracerouteNodeFilterEnabled();
    const allowedNodes = filterEnabled ? this.getAutoTracerouteNodes() : [];

    // Build the node filter clause
    let nodeFilterClause = '';
    if (filterEnabled && allowedNodes.length > 0) {
      nodeFilterClause = `AND n.nodeNum IN (${allowedNodes.join(',')})`;
    }

    // Get all nodes that are eligible for traceroute based on their status
    // Two categories:
    // 1. Nodes with no successful traceroute: retry every 3 hours
    // 2. Nodes with successful traceroute: retry every 24 hours
    const stmt = this.db.prepare(`
      SELECT n.*,
        (SELECT COUNT(*) FROM traceroutes t
         WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) as hasTraceroute
      FROM nodes n
      WHERE n.nodeNum != ?
        ${nodeFilterClause}
        AND (
          -- Category 1: No traceroute exists, and (never requested OR requested > 3 hours ago)
          (
            (SELECT COUNT(*) FROM traceroutes t
             WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) = 0
            AND (n.lastTracerouteRequest IS NULL OR n.lastTracerouteRequest < ?)
          )
          OR
          -- Category 2: Traceroute exists, and requested > 24 hours ago
          (
            (SELECT COUNT(*) FROM traceroutes t
             WHERE t.fromNodeNum = ? AND t.toNodeNum = n.nodeNum) > 0
            AND n.lastTracerouteRequest IS NOT NULL
            AND n.lastTracerouteRequest < ?
          )
        )
      ORDER BY n.lastHeard DESC
    `);

    const eligibleNodes = stmt.all(
      localNodeNum,
      localNodeNum,
      localNodeNum,
      now - THREE_HOURS_MS,
      localNodeNum,
      now - TWENTY_FOUR_HOURS_MS
    ) as DbNode[];

    if (eligibleNodes.length === 0) {
      return null;
    }

    // Randomly select one node from the eligible nodes
    const randomIndex = Math.floor(Math.random() * eligibleNodes.length);
    return this.normalizeBigInts(eligibleNodes[randomIndex]);
  }

  recordTracerouteRequest(fromNodeNum: number, toNodeNum: number): void {
    const now = Date.now();

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
    const stmt = this.db.prepare(`
      SELECT nodeNum FROM auto_traceroute_nodes
      ORDER BY addedAt ASC
    `);
    const nodes = stmt.all() as { nodeNum: number }[];
    return nodes.map(n => Number(n.nodeNum));
  }

  setAutoTracerouteNodes(nodeNums: number[]): void {
    const now = Date.now();

    // Use a transaction for atomic operation
    const deleteStmt = this.db.prepare('DELETE FROM auto_traceroute_nodes');
    const insertStmt = this.db.prepare(`
      INSERT INTO auto_traceroute_nodes (nodeNum, addedAt)
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

  isAutoTracerouteNodeFilterEnabled(): boolean {
    const value = this.getSetting('tracerouteNodeFilterEnabled');
    return value === 'true';
  }

  setAutoTracerouteNodeFilterEnabled(enabled: boolean): void {
    this.setSetting('tracerouteNodeFilterEnabled', enabled ? 'true' : 'false');
    logger.debug(`✅ Auto-traceroute node filter ${enabled ? 'enabled' : 'disabled'}`);
  }

  getTelemetryByType(telemetryType: string, limit: number = 100): DbTelemetry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM telemetry
      WHERE telemetryType = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const telemetry = stmt.all(telemetryType, limit) as DbTelemetry[];
    return telemetry.map(t => this.normalizeBigInts(t));
  }

  getLatestTelemetryByNode(nodeId: string): DbTelemetry[] {
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
    const stmt = this.db.prepare(`
      SELECT * FROM telemetry
      WHERE nodeId = ? AND telemetryType = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const telemetry = stmt.get(nodeId, telemetryType) as DbTelemetry | null;
    return telemetry ? this.normalizeBigInts(telemetry) : null;
  }

  // Get distinct telemetry types per node (efficient for checking capabilities)
  getNodeTelemetryTypes(nodeId: string): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT telemetryType FROM telemetry
      WHERE nodeId = ?
    `);
    const results = stmt.all(nodeId) as Array<{ telemetryType: string }>;
    return results.map(r => r.telemetryType);
  }

  // Get all nodes with their telemetry types (efficient bulk query)
  getAllNodesTelemetryTypes(): Map<string, string[]> {
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
    return map;
  }

  // Danger zone operations
  purgeAllNodes(): void {
    logger.debug('⚠️ PURGING all nodes and related data from database');
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
    const regularCutoffTime = Date.now() - hoursToKeep * 60 * 60 * 1000;

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
      logger.debug(
        `🧹 Purged ${result.changes} old telemetry records (keeping last ${hoursToKeep} hours, no favorites)`
      );
      return Number(result.changes);
    }

    // Calculate the cutoff time for favorited telemetry
    const favoriteCutoffTime = Date.now() - favoriteDaysToKeep * 24 * 60 * 60 * 1000;

    // Build a query to purge old telemetry, exempting favorited telemetry
    // Purge non-favorited telemetry older than hoursToKeep
    // Purge favorited telemetry older than favoriteDaysToKeep
    let totalDeleted = 0;

    // First, delete non-favorited telemetry older than regularCutoffTime
    const conditions = favorites.map(() => '(nodeId = ? AND telemetryType = ?)').join(' OR ');
    const params = favorites.flatMap(f => [f.nodeId, f.telemetryType]);

    const deleteNonFavoritesStmt = this.db.prepare(`DELETE FROM telemetry WHERE timestamp < ? AND NOT (${conditions})`);
    const nonFavoritesResult = deleteNonFavoritesStmt.run(regularCutoffTime, ...params);
    totalDeleted += Number(nonFavoritesResult.changes);

    // Then, delete favorited telemetry older than favoriteCutoffTime
    const deleteFavoritesStmt = this.db.prepare(`DELETE FROM telemetry WHERE timestamp < ? AND (${conditions})`);
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
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  getAllSettings(): Record<string, string> {
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as Array<{ key: string; value: string }>;
    const settings: Record<string, string> = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  setSetting(key: string, value: string): void {
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

  setSettings(settings: Record<string, string>): void {
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

  deleteAllSettings(): void {
    logger.debug('🔄 Resetting all settings to defaults');
    this.db.exec('DELETE FROM settings');
  }

  // Route segment operations
  insertRouteSegment(segmentData: DbRouteSegment): void {
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
    // Get the longest segment from recent traceroutes (within last 7 days)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE timestamp > ?
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get(cutoff) as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  getRecordHolderRouteSegment(): DbRouteSegment | null {
    const stmt = this.db.prepare(`
      SELECT * FROM route_segments
      WHERE isRecordHolder = 1
      ORDER BY distanceKm DESC
      LIMIT 1
    `);
    const segment = stmt.get() as DbRouteSegment | null;
    return segment ? this.normalizeBigInts(segment) : null;
  }

  updateRecordHolderSegment(newSegment: DbRouteSegment): void {
    const currentRecord = this.getRecordHolderRouteSegment();

    // If no current record or new segment is longer, update
    if (!currentRecord || newSegment.distanceKm > currentRecord.distanceKm) {
      // Clear all existing record holders
      this.db.exec('UPDATE route_segments SET isRecordHolder = 0');

      // Insert new record holder
      this.insertRouteSegment({
        ...newSegment,
        isRecordHolder: true,
      });

      logger.debug(
        `🏆 New record holder route segment: ${newSegment.distanceKm.toFixed(2)} km from ${newSegment.fromNodeId} to ${
          newSegment.toNodeId
        }`
      );
    }
  }

  clearRecordHolderSegment(): void {
    this.db.exec('UPDATE route_segments SET isRecordHolder = 0');
    logger.debug('🗑️ Cleared record holder route segment');
  }

  cleanupOldRouteSegments(days: number = 30): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(`
      DELETE FROM route_segments
      WHERE timestamp < ? AND isRecordHolder = 0
    `);
    const result = stmt.run(cutoff);
    return Number(result.changes);
  }

  saveNeighborInfo(neighborInfo: Omit<DbNeighborInfo, 'id' | 'createdAt'>): void {
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

  getNeighborsForNode(nodeNum: number): DbNeighborInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM neighbor_info
      WHERE nodeNum = ?
      ORDER BY timestamp DESC
    `);
    return stmt.all(nodeNum) as DbNeighborInfo[];
  }

  getAllNeighborInfo(): DbNeighborInfo[] {
    const stmt = this.db.prepare(`
      SELECT * FROM neighbor_info
      ORDER BY timestamp DESC
    `);
    return stmt.all() as DbNeighborInfo[];
  }

  getLatestNeighborInfoPerNode(): DbNeighborInfo[] {
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

  // Favorite operations
  setNodeFavorite(nodeNum: number, isFavorite: boolean): void {
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

    logger.debug(
      `${isFavorite ? '⭐' : '☆'} Node ${nodeNum} favorite status set to: ${isFavorite} (${result.changes} row updated)`
    );
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
      // Check if any admin users exist
      if (this.userModel.hasAdminUser()) {
        logger.debug('✅ Admin user already exists');
        return;
      }

      // No admin exists, create one
      logger.debug('📝 No admin user found, creating default admin...');

      // Use default password for fresh installs
      const password = 'changeme';
      const adminUsername = getEnvironmentConfig().adminUsername;

      // Create admin user
      const admin = await this.userModel.create({
        username: adminUsername,
        password: password,
        authProvider: 'local',
        isAdmin: true,
        displayName: 'Administrator',
      });

      // Grant all permissions
      this.permissionModel.grantDefaultPermissions(admin.id, true);

      // Log the password (this is the only time it will be shown)
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
      this.auditLog(admin.id, 'first_run_admin_created', 'users', JSON.stringify({ username: adminUsername }), null);

      // Save to settings so we know setup is complete
      this.setSetting('setup_complete', 'true');
    } catch (error) {
      logger.error('❌ Failed to create admin user:', error);
      throw error;
    }
  }

  private async ensureAnonymousUser(): Promise<void> {
    try {
      // Check if anonymous user exists
      const anonymousUser = this.userModel.findByUsername('anonymous');

      if (anonymousUser) {
        logger.debug('✅ Anonymous user already exists');
        return;
      }

      // Create anonymous user
      logger.debug('📝 Creating anonymous user for unauthenticated access...');

      // Generate a random password that nobody will know (anonymous user should not be able to log in)
      const crypto = await import('crypto');
      const randomPassword = crypto.randomBytes(32).toString('hex');

      const anonymous = await this.userModel.create({
        username: 'anonymous',
        password: randomPassword, // Random password - effectively cannot login
        authProvider: 'local',
        isAdmin: false,
        displayName: 'Anonymous User',
      });

      // Grant default read-only permissions for anonymous users
      // Admin can modify these via the Users tab
      const defaultAnonPermissions = [
        { resource: 'dashboard' as const, canRead: true, canWrite: false },
        { resource: 'nodes' as const, canRead: true, canWrite: false },
        { resource: 'info' as const, canRead: true, canWrite: false },
      ];

      for (const perm of defaultAnonPermissions) {
        this.permissionModel.grant({
          userId: anonymous.id,
          resource: perm.resource,
          canRead: perm.canRead,
          canWrite: perm.canWrite,
          grantedBy: anonymous.id,
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

  getAuditLogs(
    options: {
      limit?: number;
      offset?: number;
      userId?: number;
      action?: string;
      resource?: string;
      startDate?: number;
      endDate?: number;
      search?: string;
    } = {}
  ): { logs: any[]; total: number } {
    const { limit = 100, offset = 0, userId, action, resource, startDate, endDate, search } = options;

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

  // Get audit log statistics
  getAuditStats(days: number = 30): any {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // Count by action type
    const actionStats = this.db
      .prepare(
        `
      SELECT action, COUNT(*) as count
      FROM audit_log
      WHERE timestamp >= ?
      GROUP BY action
      ORDER BY count DESC
    `
      )
      .all(cutoff);

    // Count by user
    const userStats = this.db
      .prepare(
        `
      SELECT u.username, COUNT(*) as count
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.timestamp >= ?
      GROUP BY al.user_id
      ORDER BY count DESC
      LIMIT 10
    `
      )
      .all(cutoff);

    // Count by day
    const dailyStats = this.db
      .prepare(
        `
      SELECT
        date(timestamp/1000, 'unixepoch') as date,
        COUNT(*) as count
      FROM audit_log
      WHERE timestamp >= ?
      GROUP BY date(timestamp/1000, 'unixepoch')
      ORDER BY date DESC
    `
      )
      .all(cutoff);

    return {
      actionStats,
      userStats,
      dailyStats,
      totalEvents: actionStats.reduce((sum: number, stat: any) => sum + Number(stat.count), 0),
    };
  }

  // Cleanup old audit logs
  cleanupAuditLogs(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?');
    const result = stmt.run(cutoff);
    logger.debug(`🧹 Cleaned up ${result.changes} audit log entries older than ${days} days`);
    return Number(result.changes);
  }

  // Read Messages tracking
  markMessageAsRead(messageId: string, userId: number | null): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO read_messages (message_id, user_id, read_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(messageId, userId, Date.now());
  }

  markMessagesAsRead(messageIds: string[], userId: number | null): void {
    if (messageIds.length === 0) return;

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

  markDMMessagesAsRead(
    localNodeId: string,
    remoteNodeId: string,
    userId: number | null,
    beforeTimestamp?: number
  ): number {
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
    const stmt = this.db.prepare(`
      UPDATE messages
      SET deliveryState = ?, ackFailed = ?
      WHERE requestId = ?
    `);
    const ackFailed = deliveryState === 'failed' ? 1 : 0;
    const result = stmt.run(deliveryState, ackFailed, requestId);
    return Number(result.changes) > 0;
  }

  getUnreadMessageIds(userId: number | null): string[] {
    const stmt = this.db.prepare(`
      SELECT m.id FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
    `);

    const rows = userId === null ? (stmt.all() as Array<{ id: string }>) : (stmt.all(userId) as Array<{ id: string }>);
    return rows.map(row => row.id);
  }

  getUnreadCountsByChannel(userId: number | null): { [channelId: number]: number } {
    const stmt = this.db.prepare(`
      SELECT m.channel, COUNT(*) as count
      FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
        AND m.channel != -1
        AND m.portnum = 1
      GROUP BY m.channel
    `);

    const rows =
      userId === null
        ? (stmt.all() as Array<{ channel: number; count: number }>)
        : (stmt.all(userId) as Array<{ channel: number; count: number }>);

    const counts: { [channelId: number]: number } = {};
    rows.forEach(row => {
      counts[row.channel] = Number(row.count);
    });
    return counts;
  }

  getUnreadDMCount(localNodeId: string, remoteNodeId: string, userId: number | null): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN read_messages rm ON m.id = rm.message_id AND rm.user_id ${userId === null ? 'IS NULL' : '= ?'}
      WHERE rm.message_id IS NULL
        AND m.portnum = 1
        AND m.channel = -1
        AND ((m.fromNodeId = ? AND m.toNodeId = ?) OR (m.fromNodeId = ? AND m.toNodeId = ?))
    `);

    const params =
      userId === null
        ? [localNodeId, remoteNodeId, remoteNodeId, localNodeId]
        : [userId, localNodeId, remoteNodeId, remoteNodeId, localNodeId];

    const result = stmt.get(...params) as { count: number };
    return Number(result.count);
  }

  cleanupOldReadMessages(days: number): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
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

    const stmt = this.db.prepare(`
      INSERT INTO packet_log (
        packet_id, timestamp, from_node, from_node_id, to_node, to_node_id,
        channel, portnum, portnum_name, encrypted, snr, rssi, hop_limit, hop_start,
        payload_size, want_ack, priority, payload_preview, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      packet.payload_size ?? null,
      packet.want_ack ? 1 : 0,
      packet.priority ?? null,
      packet.payload_preview ?? null,
      packet.metadata ?? null
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

  getPacketLogCount(
    options: {
      portnum?: number;
      from_node?: number;
      to_node?: number;
      channel?: number;
      encrypted?: boolean;
      since?: number;
    } = {}
  ): number {
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

  cleanupOldPacketLogs(): number {
    const maxAgeHoursStr = this.getSetting('packet_log_max_age_hours');
    const maxAgeHours = maxAgeHoursStr ? parseInt(maxAgeHoursStr, 10) : 24;
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - maxAgeHours * 60 * 60;

    const stmt = this.db.prepare('DELETE FROM packet_log WHERE timestamp < ?');
    const result = stmt.run(cutoffTimestamp);
    logger.debug(`🧹 Cleaned up ${result.changes} packet log entries older than ${maxAgeHours} hours`);
    return Number(result.changes);
  }

  // Custom Themes Methods

  /**
   * Get all themes (custom only - built-in themes are in CSS)
   */
  getAllCustomThemes(): DbCustomTheme[] {
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
        updated_at: now,
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
}

// Export the class for testing purposes (allows creating isolated test instances)
export { DatabaseService };

export default new DatabaseService();
