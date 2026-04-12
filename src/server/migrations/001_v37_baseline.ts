/**
 * Migration 001: v3.7 Baseline Schema
 *
 * Creates the complete MeshMonitor v3.7 schema (35+ tables) for all 3 backends.
 * Replaces the old 77-migration chain (001-077) with a single baseline.
 *
 * For existing v3.7+ databases: idempotent (CREATE TABLE IF NOT EXISTS).
 * For fresh installs: creates everything from scratch.
 *
 * Table inventory (SQLite column naming convention noted):
 *   Core:     nodes, messages, channels, telemetry, settings
 *   Routing:  traceroutes, route_segments, neighbor_info
 *   Auth:     users (snake_case), permissions (snake_case), sessions, audit_log (snake_case), api_tokens (snake_case)
 *   Notif:    push_subscriptions (snake_case), user_notification_preferences (snake_case), read_messages (snake_case)
 *   Packets:  packet_log (snake_case)
 *   Backup:   backup_history, system_backup_history, upgrade_history
 *   UI:       custom_themes (snake_case), user_map_preferences, embed_profiles
 *   Solar:    solar_estimates (snake_case)
 *   Auto:     auto_traceroute_nodes, auto_time_sync_nodes, auto_traceroute_log (snake_case), auto_key_repair_state, auto_key_repair_log, auto_distance_delete_log (snake_case)
 *   Channel:  channel_database (snake_case), channel_database_permissions (snake_case)
 *   Ignored:  ignored_nodes
 *   Geo:      geofence_cooldowns
 *   MeshCore: meshcore_nodes, meshcore_messages
 *   News:     news_cache, user_news_status
 */
import type { Database } from 'better-sqlite3';
import type { PoolClient } from 'pg';
import type { Pool as MySQLPool } from 'mysql2/promise';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    // Check if this is an existing v3.7+ database
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all() as any[];
    if (tables.length > 0) {
      // Settings table exists — check for v3.7 marker
      try {
        const result = db.prepare("SELECT value FROM settings WHERE key = 'migration_077_ignored_nodes_nodenum_bigint'").get();
        if (result) {
          logger.debug('v3.7 baseline: existing v3.7+ database detected, skipping SQLite table creation');
          return;
        }
      } catch {
        // Settings table exists but query failed — continue with creation
      }
    }

    logger.info('v3.7 baseline: creating complete schema for fresh SQLite install');

    // ============================================================
    // CORE TABLES
    // ============================================================

    db.exec(`
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
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    // ============================================================
    // ROUTING TABLES
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        neighborNodeNum INTEGER NOT NULL,
        snr REAL,
        lastRxTime INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    // ============================================================
    // AUTH TABLES (snake_case column names for SQLite)
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    // ============================================================
    // NOTIFICATION TABLES (snake_case column names for SQLite)
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS read_messages (
        message_id TEXT NOT NULL PRIMARY KEY,
        user_id INTEGER,
        read_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    // ============================================================
    // PACKET LOG (snake_case column names)
    // ============================================================

    db.exec(`
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
      )
    `);

    // ============================================================
    // BACKUP & UPGRADE TABLES
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    // ============================================================
    // UI TABLES
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_map_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        centerLat REAL,
        centerLng REAL,
        zoom REAL,
        selectedLayer TEXT,
        map_tileset TEXT,
        show_paths INTEGER DEFAULT 0,
        show_neighbor_info INTEGER DEFAULT 0,
        show_route INTEGER DEFAULT 1,
        show_motion INTEGER DEFAULT 1,
        show_mqtt_nodes INTEGER DEFAULT 1,
        show_meshcore_nodes INTEGER DEFAULT 1,
        show_animations INTEGER DEFAULT 0,
        show_accuracy_regions INTEGER DEFAULT 0,
        show_estimated_positions INTEGER DEFAULT 0,
        position_history_hours INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

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

    // ============================================================
    // SOLAR ESTIMATES (snake_case)
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS solar_estimates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL UNIQUE,
        watt_hours REAL NOT NULL,
        fetched_at INTEGER NOT NULL,
        created_at INTEGER
      )
    `);

    // ============================================================
    // AUTOMATION TABLES
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_traceroute_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        to_node_num INTEGER NOT NULL,
        to_node_name TEXT,
        success INTEGER,
        created_at INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_state (
        nodeNum INTEGER PRIMARY KEY,
        attemptCount INTEGER DEFAULT 0,
        lastAttemptTime INTEGER,
        exhausted INTEGER DEFAULT 0,
        startedAt INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_key_repair_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodeNum INTEGER NOT NULL,
        nodeName TEXT,
        action TEXT NOT NULL,
        success INTEGER,
        created_at INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        nodes_deleted INTEGER NOT NULL,
        threshold_km REAL NOT NULL,
        details TEXT,
        created_at INTEGER
      )
    `);

    // ============================================================
    // CHANNEL DATABASE (snake_case for SQLite)
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    // ============================================================
    // IGNORED NODES
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS ignored_nodes (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL,
        longName TEXT,
        shortName TEXT,
        ignoredAt INTEGER NOT NULL,
        ignoredBy TEXT
      )
    `);

    // ============================================================
    // GEOFENCE COOLDOWNS
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS geofence_cooldowns (
        triggerId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        firedAt INTEGER NOT NULL,
        PRIMARY KEY (triggerId, nodeNum)
      )
    `);

    // ============================================================
    // MESHCORE TABLES
    // ============================================================

    db.exec(`
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
      )
    `);

    db.exec(`
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
      )
    `);

    // ============================================================
    // NEWS TABLES
    // ============================================================

    db.exec(`
      CREATE TABLE IF NOT EXISTS news_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedData TEXT NOT NULL,
        fetchedAt INTEGER NOT NULL,
        sourceUrl TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_news_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        lastSeenNewsId TEXT,
        dismissedNewsIds TEXT,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // ============================================================
    // INDEXES
    // ============================================================

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_nodeid ON nodes(nodeId);
      CREATE INDEX IF NOT EXISTS idx_nodes_lastheard ON nodes(lastHeard);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_telemetry_nodenum ON telemetry(nodeNum);
      CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
      CREATE INDEX IF NOT EXISTS idx_traceroutes_nodes ON traceroutes(fromNodeNum, toNodeNum, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traceroutes_timestamp ON traceroutes(timestamp);
      CREATE INDEX IF NOT EXISTS idx_route_segments_from_to ON route_segments(fromNodeNum, toNodeNum);
      CREATE INDEX IF NOT EXISTS idx_neighbor_info_nodenum ON neighbor_info(nodeNum);
      CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
      CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_packet_log_createdat ON packet_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_system_backup_history_timestamp ON system_backup_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_upgrade_history_timestamp ON upgrade_history(startedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_traceroute_timestamp ON auto_traceroute_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_auto_key_repair_log_timestamp ON auto_key_repair_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_channel_database_enabled ON channel_database(is_enabled);
      CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp ON auto_distance_delete_log(timestamp DESC);
    `);

    logger.info('v3.7 baseline: SQLite schema creation complete');
  },
  down: (_db: Database): void => { /* Not supported */ },
};

// ============================================================
// POSTGRESQL BASELINE
// ============================================================

export async function runMigration001Postgres(client: PoolClient): Promise<void> {
  logger.info('v3.7 baseline: ensuring complete PostgreSQL schema');
  // Copy of POSTGRES_SCHEMA_SQL — all statements are CREATE TABLE IF NOT EXISTS, safe to re-run
  await client.query(`
  CREATE TABLE IF NOT EXISTS nodes (
    "nodeNum" BIGINT PRIMARY KEY,
    "nodeId" TEXT UNIQUE NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "hwModel" INTEGER,
    role INTEGER,
    "hopsAway" INTEGER,
    "lastMessageHops" INTEGER,
    "viaMqtt" BOOLEAN,
    macaddr TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    altitude DOUBLE PRECISION,
    "batteryLevel" INTEGER,
    voltage REAL,
    "channelUtilization" REAL,
    "airUtilTx" REAL,
    "lastHeard" BIGINT,
    snr REAL,
    rssi INTEGER,
    "lastTracerouteRequest" BIGINT,
    "firmwareVersion" TEXT,
    channel INTEGER,
    "isFavorite" BOOLEAN DEFAULT false,
    "favoriteLocked" BOOLEAN DEFAULT false,
    "isIgnored" BOOLEAN DEFAULT false,
    mobile INTEGER DEFAULT 0,
    "rebootCount" INTEGER,
    "publicKey" TEXT,
    "lastMeshReceivedKey" TEXT,
    "hasPKC" BOOLEAN,
    "lastPKIPacket" BIGINT,
    "keyIsLowEntropy" BOOLEAN,
    "duplicateKeyDetected" BOOLEAN,
    "keyMismatchDetected" BOOLEAN,
    "keySecurityIssueDetails" TEXT,
    "isExcessivePackets" BOOLEAN DEFAULT false,
    "packetRatePerHour" INTEGER,
    "packetRateLastChecked" BIGINT,
    "welcomedAt" BIGINT,
    "positionChannel" INTEGER,
    "positionPrecisionBits" INTEGER,
    "positionGpsAccuracy" REAL,
    "positionHdop" REAL,
    "positionTimestamp" BIGINT,
    "positionOverrideEnabled" BOOLEAN DEFAULT false,
    "latitudeOverride" DOUBLE PRECISION,
    "longitudeOverride" DOUBLE PRECISION,
    "altitudeOverride" DOUBLE PRECISION,
    "positionOverrideIsPrivate" BOOLEAN DEFAULT false,
    "hasRemoteAdmin" BOOLEAN DEFAULT false,
    "lastRemoteAdminCheck" BIGINT,
    "remoteAdminMetadata" TEXT,
    "lastTimeSync" BIGINT,
    "isTimeOffsetIssue" BOOLEAN DEFAULT false,
    "timeOffsetSeconds" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    text TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    "requestId" BIGINT,
    timestamp BIGINT NOT NULL,
    "rxTime" BIGINT,
    "hopStart" INTEGER,
    "hopLimit" INTEGER,
    "relayNode" BIGINT,
    "replyId" BIGINT,
    emoji INTEGER,
    "viaMqtt" BOOLEAN DEFAULT false,
    "rxSnr" REAL,
    "rxRssi" REAL,
    "ackFailed" BOOLEAN,
    "routingErrorReceived" BOOLEAN,
    "deliveryState" TEXT,
    "wantAck" BOOLEAN,
    "ackFromNode" BIGINT,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    psk TEXT,
    role INTEGER,
    "uplinkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "downlinkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "positionPrecision" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telemetry (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "telemetryType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    unit TEXT,
    "createdAt" BIGINT NOT NULL,
    "packetTimestamp" BIGINT,
    "packetId" BIGINT,
    channel INTEGER,
    "precisionBits" INTEGER,
    "gpsAccuracy" DOUBLE PRECISION
  );

  CREATE TABLE IF NOT EXISTS traceroutes (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    route TEXT,
    "routeBack" TEXT,
    "snrTowards" TEXT,
    "snrBack" TEXT,
    "routePositions" TEXT,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS route_segments (
    id SERIAL PRIMARY KEY,
    "fromNodeNum" BIGINT NOT NULL,
    "toNodeNum" BIGINT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "distanceKm" REAL NOT NULL,
    "isRecordHolder" BOOLEAN DEFAULT false,
    "fromLatitude" DOUBLE PRECISION,
    "fromLongitude" DOUBLE PRECISION,
    "toLatitude" DOUBLE PRECISION,
    "toLongitude" DOUBLE PRECISION,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS neighbor_info (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL,
    "neighborNodeNum" BIGINT NOT NULL,
    snr DOUBLE PRECISION,
    "lastRxTime" BIGINT,
    "timestamp" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    "displayName" TEXT,
    "passwordHash" TEXT,
    "authMethod" TEXT NOT NULL DEFAULT 'local',
    "oidcSubject" TEXT UNIQUE,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passwordLocked" BOOLEAN NOT NULL DEFAULT false,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaBackupCodes" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastLoginAt" BIGINT
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    "canViewOnMap" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" BIGINT,
    "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT,
    action TEXT NOT NULL,
    resource TEXT,
    details TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "valueBefore" TEXT,
    "valueAfter" TEXT,
    timestamp BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    "tokenHash" TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "lastUsedAt" BIGINT,
    "expiresAt" BIGINT,
    "createdBy" INTEGER,
    "revokedAt" BIGINT,
    "revokedBy" INTEGER
  );

  CREATE TABLE IF NOT EXISTS read_messages (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "messageId" TEXT NOT NULL,
    "readAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    "p256dhKey" TEXT NOT NULL,
    "authKey" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastUsedAt" BIGINT
  );

  CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    "notifyOnMessage" BOOLEAN DEFAULT true,
    "notifyOnDirectMessage" BOOLEAN DEFAULT true,
    "notifyOnChannelMessage" BOOLEAN DEFAULT false,
    "notifyOnEmoji" BOOLEAN DEFAULT false,
    "notifyOnNewNode" BOOLEAN DEFAULT true,
    "notifyOnTraceroute" BOOLEAN DEFAULT true,
    "notifyOnInactiveNode" BOOLEAN DEFAULT false,
    "notifyOnServerEvents" BOOLEAN DEFAULT false,
    "prefixWithNodeName" BOOLEAN DEFAULT false,
    "appriseEnabled" BOOLEAN DEFAULT true,
    "appriseUrls" TEXT,
    "enabledChannels" TEXT,
    "monitoredNodes" TEXT,
    whitelist TEXT,
    blacklist TEXT,
    "notifyOnMqtt" BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packet_log (
    id SERIAL PRIMARY KEY,
    packet_id BIGINT,
    timestamp BIGINT NOT NULL,
    from_node BIGINT NOT NULL,
    from_node_id TEXT,
    to_node BIGINT,
    to_node_id TEXT,
    channel INTEGER,
    portnum INTEGER NOT NULL,
    portnum_name TEXT,
    encrypted BOOLEAN NOT NULL,
    snr REAL,
    rssi REAL,
    hop_limit INTEGER,
    hop_start INTEGER,
    relay_node BIGINT,
    payload_size INTEGER,
    want_ack BOOLEAN,
    priority INTEGER,
    payload_preview TEXT,
    metadata TEXT,
    direction TEXT,
    created_at BIGINT,
    decrypted_by TEXT,
    decrypted_channel_id INTEGER,
    transport_mechanism INTEGER
  );

  CREATE TABLE IF NOT EXISTS backup_history (
    id SERIAL PRIMARY KEY,
    "nodeId" TEXT,
    "nodeNum" BIGINT,
    filename TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" BIGINT,
    "backupType" TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_backup_history (
    id SERIAL PRIMARY KEY,
    "backupPath" TEXT NOT NULL,
    "backupType" TEXT NOT NULL,
    "schemaVersion" INTEGER,
    "appVersion" TEXT,
    "totalSize" INTEGER,
    "tableCount" INTEGER,
    "rowCount" INTEGER,
    timestamp BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upgrade_history (
    id TEXT PRIMARY KEY,
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "deploymentMethod" TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    "currentStep" TEXT,
    logs TEXT,
    "backupPath" TEXT,
    "startedAt" BIGINT,
    "completedAt" BIGINT,
    "initiatedBy" TEXT,
    "errorMessage" TEXT,
    "rollbackAvailable" BOOLEAN
  );

  CREATE TABLE IF NOT EXISTS custom_themes (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    definition TEXT NOT NULL,
    is_builtin BOOLEAN DEFAULT false,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_map_preferences (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "centerLat" REAL,
    "centerLng" REAL,
    zoom REAL,
    "selectedLayer" TEXT,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS solar_estimates (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL UNIQUE,
    watt_hours DOUBLE PRECISION NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
    id SERIAL PRIMARY KEY,
    "nodeNum" BIGINT NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_traceroute_log (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    to_node_num BIGINT NOT NULL,
    to_node_name TEXT,
    success INTEGER DEFAULT NULL,
    created_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS auto_key_repair_state (
    "nodeNum" BIGINT PRIMARY KEY,
    "attemptCount" INTEGER DEFAULT 0,
    "lastAttemptTime" BIGINT,
    exhausted INTEGER DEFAULT 0,
    "startedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auto_key_repair_log (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "nodeName" TEXT,
    action TEXT NOT NULL,
    success INTEGER DEFAULT NULL,
    created_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS channel_database (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    psk TEXT NOT NULL,
    "pskLength" INTEGER NOT NULL,
    description TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "decryptedPacketCount" INTEGER NOT NULL DEFAULT 0,
    "lastDecryptedAt" BIGINT,
    "createdBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_database_permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "channelDatabaseId" INTEGER NOT NULL REFERENCES channel_database(id) ON DELETE CASCADE,
    "canViewOnMap" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "grantedAt" BIGINT NOT NULL,
    UNIQUE("userId", "channelDatabaseId")
  );

  CREATE TABLE IF NOT EXISTS geofence_cooldowns (
    "triggerId" TEXT NOT NULL,
    "nodeNum" BIGINT NOT NULL,
    "firedAt" BIGINT NOT NULL,
    PRIMARY KEY ("triggerId", "nodeNum")
  );

  CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
    id SERIAL PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    nodes_deleted INTEGER NOT NULL,
    threshold_km REAL NOT NULL,
    details TEXT,
    created_at BIGINT
  );

  CREATE TABLE IF NOT EXISTS embed_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    channels TEXT NOT NULL DEFAULT '[]',
    tileset TEXT NOT NULL DEFAULT 'osm',
    "defaultLat" REAL NOT NULL DEFAULT 0,
    "defaultLng" REAL NOT NULL DEFAULT 0,
    "defaultZoom" INTEGER NOT NULL DEFAULT 10,
    "showTooltips" BOOLEAN NOT NULL DEFAULT true,
    "showPopups" BOOLEAN NOT NULL DEFAULT true,
    "showLegend" BOOLEAN NOT NULL DEFAULT true,
    "showPaths" BOOLEAN NOT NULL DEFAULT false,
    "showNeighborInfo" BOOLEAN NOT NULL DEFAULT false,
    "showMqttNodes" BOOLEAN NOT NULL DEFAULT true,
    "pollIntervalSeconds" INTEGER NOT NULL DEFAULT 30,
    "allowedOrigins" TEXT NOT NULL DEFAULT '[]',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ignored_nodes (
    "nodeNum" BIGINT PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "longName" TEXT,
    "shortName" TEXT,
    "ignoredAt" BIGINT NOT NULL,
    "ignoredBy" TEXT
  );

  CREATE TABLE IF NOT EXISTS meshcore_nodes (
    "publicKey" TEXT PRIMARY KEY,
    name TEXT,
    "advType" INTEGER,
    "txPower" INTEGER,
    "maxTxPower" INTEGER,
    "radioFreq" REAL,
    "radioBw" REAL,
    "radioSf" INTEGER,
    "radioCr" INTEGER,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    altitude DOUBLE PRECISION,
    "batteryMv" INTEGER,
    "uptimeSecs" BIGINT,
    rssi INTEGER,
    snr REAL,
    "lastHeard" BIGINT,
    "hasAdminAccess" BOOLEAN DEFAULT false,
    "lastAdminCheck" BIGINT,
    "isLocalNode" BOOLEAN DEFAULT false,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meshcore_messages (
    id TEXT PRIMARY KEY,
    "fromPublicKey" TEXT NOT NULL,
    "toPublicKey" TEXT,
    text TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    rssi INTEGER,
    snr INTEGER,
    "messageType" TEXT DEFAULT 'text',
    delivered BOOLEAN DEFAULT false,
    "deliveredAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS news_cache (
    id SERIAL PRIMARY KEY,
    "feedData" TEXT NOT NULL,
    "fetchedAt" BIGINT NOT NULL,
    "sourceUrl" TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_news_status (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "lastSeenNewsId" TEXT,
    "dismissedNewsIds" TEXT,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_auto_traceroute_timestamp ON auto_traceroute_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_auto_key_repair_log_timestamp ON auto_key_repair_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_channel_database_enabled ON channel_database("isEnabled");
  CREATE INDEX IF NOT EXISTS idx_channel_database_permissions_user ON channel_database_permissions("userId");

  CREATE INDEX IF NOT EXISTS idx_nodes_nodeid ON nodes("nodeId");
  CREATE INDEX IF NOT EXISTS idx_nodes_lastheard ON nodes("lastHeard");
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
  CREATE INDEX IF NOT EXISTS idx_telemetry_nodenum ON telemetry("nodeNum");
  CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
  CREATE INDEX IF NOT EXISTS idx_traceroutes_from_to ON traceroutes("fromNodeNum", "toNodeNum");
  CREATE INDEX IF NOT EXISTS idx_traceroutes_timestamp ON traceroutes(timestamp);
  CREATE INDEX IF NOT EXISTS idx_route_segments_from_to ON route_segments("fromNodeNum", "toNodeNum");
  CREATE INDEX IF NOT EXISTS idx_neighbor_info_nodenum ON neighbor_info("nodeNum");
  CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
  CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_packet_log_createdat ON packet_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_backup_history_timestamp ON backup_history(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_system_backup_history_timestamp ON system_backup_history(timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_auto_distance_delete_log_timestamp
    ON auto_distance_delete_log(timestamp DESC);
  `);
}

// ============================================================
// MYSQL BASELINE
// ============================================================

export async function runMigration001Mysql(pool: MySQLPool): Promise<void> {
  logger.info('v3.7 baseline: ensuring complete MySQL schema');
  // Each statement executed individually (MySQL doesn't support multi-statement by default)
  const statements = [
    `CREATE TABLE IF NOT EXISTS nodes (
      nodeNum BIGINT PRIMARY KEY,
      nodeId VARCHAR(255) UNIQUE NOT NULL,
      longName TEXT,
      shortName VARCHAR(255),
      hwModel INT,
      role INT,
      hopsAway INT,
      lastMessageHops INT,
      viaMqtt BOOLEAN,
      macaddr VARCHAR(255),
      latitude DOUBLE,
      longitude DOUBLE,
      altitude DOUBLE,
      batteryLevel INT,
      voltage DOUBLE,
      channelUtilization DOUBLE,
      airUtilTx DOUBLE,
      lastHeard BIGINT,
      snr DOUBLE,
      rssi INT,
      lastTracerouteRequest BIGINT,
      firmwareVersion VARCHAR(255),
      channel INT,
      isFavorite BOOLEAN DEFAULT false,
      favoriteLocked BOOLEAN DEFAULT false,
      isIgnored BOOLEAN DEFAULT false,
      mobile INT DEFAULT 0,
      rebootCount INT,
      publicKey TEXT,
      lastMeshReceivedKey TEXT,
      hasPKC BOOLEAN,
      lastPKIPacket BIGINT,
      keyIsLowEntropy BOOLEAN,
      duplicateKeyDetected BOOLEAN,
      keyMismatchDetected BOOLEAN,
      keySecurityIssueDetails TEXT,
      isExcessivePackets BOOLEAN DEFAULT false,
      packetRatePerHour INT,
      packetRateLastChecked BIGINT,
      welcomedAt BIGINT,
      positionChannel INT,
      positionPrecisionBits INT,
      positionGpsAccuracy DOUBLE,
      positionHdop DOUBLE,
      positionTimestamp BIGINT,
      positionOverrideEnabled BOOLEAN DEFAULT false,
      latitudeOverride DOUBLE,
      longitudeOverride DOUBLE,
      altitudeOverride DOUBLE,
      positionOverrideIsPrivate BOOLEAN DEFAULT false,
      hasRemoteAdmin BOOLEAN DEFAULT false,
      lastRemoteAdminCheck BIGINT,
      remoteAdminMetadata TEXT,
      lastTimeSync BIGINT,
      isTimeOffsetIssue BOOLEAN DEFAULT false,
      timeOffsetSeconds INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(255) PRIMARY KEY,
      fromNodeNum BIGINT NOT NULL,
      toNodeNum BIGINT NOT NULL,
      fromNodeId VARCHAR(255) NOT NULL,
      toNodeId VARCHAR(255) NOT NULL,
      text TEXT NOT NULL,
      channel INT NOT NULL DEFAULT 0,
      portnum INT,
      requestId BIGINT,
      timestamp BIGINT NOT NULL,
      rxTime BIGINT,
      hopStart INT,
      hopLimit INT,
      relayNode BIGINT,
      replyId BIGINT,
      emoji INT,
      viaMqtt BOOLEAN DEFAULT false,
      rxSnr REAL,
      rxRssi REAL,
      ackFailed BOOLEAN,
      routingErrorReceived BOOLEAN,
      deliveryState VARCHAR(50),
      wantAck BOOLEAN,
      ackFromNode BIGINT,
      decrypted_by VARCHAR(16),
      createdAt BIGINT NOT NULL,
      INDEX idx_messages_timestamp (timestamp),
      INDEX idx_messages_channel (channel)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS channels (
      id INT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      psk TEXT,
      role INT,
      uplinkEnabled BOOLEAN NOT NULL DEFAULT true,
      downlinkEnabled BOOLEAN NOT NULL DEFAULT true,
      positionPrecision INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS telemetry (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeId VARCHAR(255) NOT NULL,
      nodeNum BIGINT NOT NULL,
      telemetryType VARCHAR(255) NOT NULL,
      timestamp BIGINT NOT NULL,
      value DOUBLE NOT NULL,
      unit VARCHAR(255),
      createdAt BIGINT NOT NULL,
      packetTimestamp BIGINT,
      packetId BIGINT,
      channel INT,
      precisionBits INT,
      gpsAccuracy DOUBLE,
      INDEX idx_telemetry_nodenum (nodeNum),
      INDEX idx_telemetry_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255),
      displayName VARCHAR(255),
      passwordHash TEXT,
      authMethod VARCHAR(50) NOT NULL DEFAULT 'local',
      oidcSubject VARCHAR(255) UNIQUE,
      isAdmin BOOLEAN NOT NULL DEFAULT false,
      isActive BOOLEAN NOT NULL DEFAULT true,
      passwordLocked BOOLEAN NOT NULL DEFAULT false,
      mfaEnabled BOOLEAN NOT NULL DEFAULT false,
      mfaSecret TEXT,
      mfaBackupCodes TEXT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      lastLoginAt BIGINT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      resource VARCHAR(255) NOT NULL,
      canViewOnMap BOOLEAN NOT NULL DEFAULT false,
      canRead BOOLEAN NOT NULL DEFAULT false,
      canWrite BOOLEAN NOT NULL DEFAULT false,
      canDelete BOOLEAN NOT NULL DEFAULT false,
      grantedAt BIGINT,
      grantedBy INT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(255) PRIMARY KEY,
      sess TEXT NOT NULL,
      expire BIGINT NOT NULL,
      INDEX idx_sessions_expire (expire)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS traceroutes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fromNodeNum BIGINT NOT NULL,
      toNodeNum BIGINT NOT NULL,
      fromNodeId VARCHAR(32) NOT NULL,
      toNodeId VARCHAR(32) NOT NULL,
      route TEXT,
      routeBack TEXT,
      snrTowards TEXT,
      snrBack TEXT,
      routePositions TEXT,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX idx_traceroutes_from_to (fromNodeNum, toNodeNum),
      INDEX idx_traceroutes_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS route_segments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fromNodeNum BIGINT NOT NULL,
      toNodeNum BIGINT NOT NULL,
      fromNodeId VARCHAR(32) NOT NULL,
      toNodeId VARCHAR(32) NOT NULL,
      distanceKm DOUBLE NOT NULL,
      isRecordHolder BOOLEAN DEFAULT false,
      fromLatitude DOUBLE,
      fromLongitude DOUBLE,
      toLatitude DOUBLE,
      toLongitude DOUBLE,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX idx_route_segments_from_to (fromNodeNum, toNodeNum)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS neighbor_info (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeNum BIGINT NOT NULL,
      neighborNodeNum BIGINT NOT NULL,
      snr DOUBLE,
      lastRxTime BIGINT,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX idx_neighbor_info_nodenum (nodeNum)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT,
      username VARCHAR(255),
      action VARCHAR(255) NOT NULL,
      resource VARCHAR(255),
      details TEXT,
      ipAddress VARCHAR(255),
      userAgent TEXT,
      valueBefore TEXT,
      valueAfter TEXT,
      timestamp BIGINT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_audit_log_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS api_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      tokenHash TEXT NOT NULL,
      prefix VARCHAR(255) NOT NULL,
      isActive BOOLEAN NOT NULL DEFAULT true,
      createdAt BIGINT NOT NULL,
      lastUsedAt BIGINT,
      expiresAt BIGINT,
      createdBy INT,
      revokedAt BIGINT,
      revokedBy INT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS read_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      messageId VARCHAR(64) NOT NULL,
      readAt BIGINT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT,
      endpoint TEXT NOT NULL,
      p256dhKey TEXT NOT NULL,
      authKey TEXT NOT NULL,
      userAgent TEXT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      lastUsedAt BIGINT,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_notification_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL UNIQUE,
      notifyOnMessage BOOLEAN DEFAULT true,
      notifyOnDirectMessage BOOLEAN DEFAULT true,
      notifyOnChannelMessage BOOLEAN DEFAULT false,
      notifyOnEmoji BOOLEAN DEFAULT false,
      notifyOnNewNode BOOLEAN DEFAULT true,
      notifyOnTraceroute BOOLEAN DEFAULT true,
      notifyOnInactiveNode BOOLEAN DEFAULT false,
      notifyOnServerEvents BOOLEAN DEFAULT false,
      prefixWithNodeName BOOLEAN DEFAULT false,
      appriseEnabled BOOLEAN DEFAULT true,
      appriseUrls TEXT,
      enabledChannels TEXT,
      monitoredNodes TEXT,
      whitelist TEXT,
      blacklist TEXT,
      notifyOnMqtt BOOLEAN DEFAULT true,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS packet_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      packet_id BIGINT,
      timestamp BIGINT NOT NULL,
      from_node BIGINT NOT NULL,
      from_node_id VARCHAR(32),
      to_node BIGINT,
      to_node_id VARCHAR(32),
      channel INT,
      portnum INT NOT NULL,
      portnum_name VARCHAR(64),
      encrypted BOOLEAN NOT NULL,
      snr DOUBLE,
      rssi DOUBLE,
      hop_limit INT,
      hop_start INT,
      relay_node BIGINT,
      payload_size INT,
      want_ack BOOLEAN,
      priority INT,
      payload_preview TEXT,
      metadata TEXT,
      direction VARCHAR(8),
      created_at BIGINT,
      decrypted_by VARCHAR(16),
      decrypted_channel_id INT,
      transport_mechanism INT,
      INDEX idx_packet_log_createdat (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS backup_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeId VARCHAR(255),
      nodeNum BIGINT,
      filename VARCHAR(255) NOT NULL,
      filePath TEXT NOT NULL,
      fileSize BIGINT,
      backupType VARCHAR(50) NOT NULL,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX idx_backup_history_timestamp (timestamp DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS system_backup_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      backupPath VARCHAR(512) NOT NULL,
      backupType VARCHAR(32) NOT NULL,
      schemaVersion INT,
      appVersion VARCHAR(32),
      totalSize INT,
      tableCount INT,
      rowCount INT,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX idx_system_backup_history_timestamp (timestamp DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS upgrade_history (
      id VARCHAR(64) PRIMARY KEY,
      fromVersion VARCHAR(32) NOT NULL,
      toVersion VARCHAR(32) NOT NULL,
      deploymentMethod VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      progress INT DEFAULT 0,
      currentStep VARCHAR(255),
      logs TEXT,
      backupPath VARCHAR(512),
      startedAt BIGINT,
      completedAt BIGINT,
      initiatedBy VARCHAR(255),
      errorMessage TEXT,
      rollbackAvailable BOOLEAN
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS custom_themes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      slug VARCHAR(128) NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      is_builtin BOOLEAN DEFAULT false,
      created_by INT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_map_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      centerLat DOUBLE,
      centerLng DOUBLE,
      zoom DOUBLE,
      selectedLayer VARCHAR(64),
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS solar_estimates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp BIGINT NOT NULL UNIQUE,
      watt_hours DOUBLE NOT NULL,
      fetched_at BIGINT NOT NULL,
      created_at BIGINT,
      INDEX idx_solar_timestamp (timestamp),
      INDEX idx_solar_fetched_at (fetched_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeNum BIGINT NOT NULL UNIQUE,
      enabled BOOLEAN DEFAULT true,
      createdAt BIGINT NOT NULL,
      INDEX idx_auto_traceroute_nodenum (nodeNum)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_time_sync_nodes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeNum BIGINT NOT NULL UNIQUE,
      enabled BOOLEAN DEFAULT true,
      createdAt BIGINT NOT NULL,
      INDEX idx_auto_time_sync_nodenum (nodeNum)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_traceroute_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      to_node_num BIGINT NOT NULL,
      to_node_name TEXT,
      success INT DEFAULT NULL,
      created_at BIGINT,
      INDEX idx_auto_traceroute_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_key_repair_state (
      nodeNum BIGINT PRIMARY KEY,
      attemptCount INT DEFAULT 0,
      lastAttemptTime BIGINT,
      exhausted INT DEFAULT 0,
      startedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_key_repair_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      nodeNum BIGINT NOT NULL,
      nodeName TEXT,
      action TEXT NOT NULL,
      success INT DEFAULT NULL,
      created_at BIGINT,
      INDEX idx_auto_key_repair_log_timestamp (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS channel_database (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      psk VARCHAR(255) NOT NULL,
      pskLength INT NOT NULL,
      description TEXT,
      isEnabled BOOLEAN NOT NULL DEFAULT true,
      decryptedPacketCount INT NOT NULL DEFAULT 0,
      lastDecryptedAt BIGINT,
      createdBy INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      INDEX idx_channel_database_enabled (isEnabled),
      FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS channel_database_permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      channelDatabaseId INT NOT NULL,
      canViewOnMap BOOLEAN NOT NULL DEFAULT false,
      canRead BOOLEAN NOT NULL DEFAULT false,
      grantedBy INT,
      grantedAt BIGINT NOT NULL,
      UNIQUE KEY unique_user_channel (userId, channelDatabaseId),
      INDEX idx_channel_database_permissions_user (userId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (channelDatabaseId) REFERENCES channel_database(id) ON DELETE CASCADE,
      FOREIGN KEY (grantedBy) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS geofence_cooldowns (
      triggerId VARCHAR(255) NOT NULL,
      nodeNum BIGINT NOT NULL,
      firedAt BIGINT NOT NULL,
      PRIMARY KEY (triggerId, nodeNum)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS auto_distance_delete_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      timestamp BIGINT NOT NULL,
      nodes_deleted INT NOT NULL,
      threshold_km REAL NOT NULL,
      details TEXT,
      created_at BIGINT,
      INDEX idx_auto_distance_delete_log_timestamp (timestamp DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS embed_profiles (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      channels TEXT NOT NULL,
      tileset VARCHAR(255) NOT NULL DEFAULT 'osm',
      defaultLat DOUBLE NOT NULL DEFAULT 0,
      defaultLng DOUBLE NOT NULL DEFAULT 0,
      defaultZoom INT NOT NULL DEFAULT 10,
      showTooltips BOOLEAN NOT NULL DEFAULT true,
      showPopups BOOLEAN NOT NULL DEFAULT true,
      showLegend BOOLEAN NOT NULL DEFAULT true,
      showPaths BOOLEAN NOT NULL DEFAULT false,
      showNeighborInfo BOOLEAN NOT NULL DEFAULT false,
      showMqttNodes BOOLEAN NOT NULL DEFAULT true,
      pollIntervalSeconds INT NOT NULL DEFAULT 30,
      allowedOrigins TEXT NOT NULL,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS ignored_nodes (
      nodeNum BIGINT PRIMARY KEY,
      nodeId VARCHAR(255) NOT NULL,
      longName VARCHAR(255),
      shortName VARCHAR(255),
      ignoredAt BIGINT NOT NULL,
      ignoredBy VARCHAR(255)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS meshcore_nodes (
      publicKey VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255),
      advType INT,
      txPower INT,
      maxTxPower INT,
      radioFreq DOUBLE,
      radioBw DOUBLE,
      radioSf INT,
      radioCr INT,
      latitude DOUBLE,
      longitude DOUBLE,
      altitude DOUBLE,
      batteryMv INT,
      uptimeSecs BIGINT,
      rssi INT,
      snr DOUBLE,
      lastHeard BIGINT,
      hasAdminAccess BOOLEAN DEFAULT false,
      lastAdminCheck BIGINT,
      isLocalNode BOOLEAN DEFAULT false,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS meshcore_messages (
      id VARCHAR(64) PRIMARY KEY,
      fromPublicKey VARCHAR(64) NOT NULL,
      toPublicKey VARCHAR(64),
      text TEXT NOT NULL,
      timestamp BIGINT NOT NULL,
      rssi INT,
      snr INT,
      messageType VARCHAR(32) DEFAULT 'text',
      delivered BOOLEAN DEFAULT false,
      deliveredAt BIGINT,
      createdAt BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS news_cache (
      id INT AUTO_INCREMENT PRIMARY KEY,
      feedData TEXT NOT NULL,
      fetchedAt BIGINT NOT NULL,
      sourceUrl VARCHAR(512) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS user_news_status (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      lastSeenNewsId VARCHAR(128),
      dismissedNewsIds TEXT,
      updatedAt BIGINT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];

  // Create indexes that are separate from table definitions
  const postIndexes = [
    `CREATE INDEX idx_nodes_nodeid ON nodes(nodeId)`,
    `CREATE INDEX idx_nodes_lastheard ON nodes(lastHeard)`,
  ];

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (error: any) {
      if (error.code === 'ER_DUP_KEYNAME') continue; // Skip duplicate index errors
      throw error;
    }
  }

  for (const stmt of postIndexes) {
    try {
      await pool.query(stmt);
    } catch (error: any) {
      if (error.code === 'ER_DUP_KEYNAME') continue; // Skip duplicate index errors
      throw error;
    }
  }
}
