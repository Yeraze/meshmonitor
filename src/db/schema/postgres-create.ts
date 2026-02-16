/**
 * PostgreSQL Schema Creation SQL
 *
 * This is the canonical PostgreSQL schema for MeshMonitor.
 * Used by both the database service and migration script.
 */

export const POSTGRES_SCHEMA_SQL = `
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
    "isIgnored" BOOLEAN DEFAULT false,
    mobile INTEGER DEFAULT 0,
    "rebootCount" INTEGER,
    "publicKey" TEXT,
    "hasPKC" BOOLEAN,
    "lastPKIPacket" BIGINT,
    "keyIsLowEntropy" BOOLEAN,
    "duplicateKeyDetected" BOOLEAN,
    "keyMismatchDetected" BOOLEAN,
    "keySecurityIssueDetails" TEXT,
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
    "relayNode" INTEGER,
    "replyId" BIGINT,
    emoji INTEGER,
    "viaMqtt" BOOLEAN DEFAULT false,
    "rxSnr" REAL,
    "rxRssi" REAL,
    "ackFailed" BOOLEAN,
    "routingErrorReceived" BOOLEAN,
    "deliveryState" TEXT,
    "wantAck" BOOLEAN,
    "ackFromNode" INTEGER,
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
    "packetId" INTEGER,
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
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "lastLoginAt" BIGINT
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false
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
    "messageId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "readAt" BIGINT NOT NULL,
    PRIMARY KEY ("messageId", "userId")
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
    dirname TEXT NOT NULL UNIQUE,
    timestamp BIGINT NOT NULL,
    type TEXT NOT NULL,
    size BIGINT NOT NULL,
    table_count INTEGER NOT NULL,
    meshmonitor_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
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
    name TEXT NOT NULL UNIQUE,
    definition TEXT NOT NULL,
    "createdBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_map_preferences (
    "userId" INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    "centerLat" DOUBLE PRECISION,
    "centerLng" DOUBLE PRECISION,
    zoom INTEGER,
    "selectedNodeNum" BIGINT,
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
    "canRead" BOOLEAN NOT NULL DEFAULT false,
    "grantedBy" INTEGER REFERENCES users(id) ON DELETE SET NULL,
    "grantedAt" BIGINT NOT NULL,
    UNIQUE("userId", "channelDatabaseId")
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
  CREATE INDEX IF NOT EXISTS idx_system_backup_history_type ON system_backup_history(type);
`;

export const POSTGRES_TABLE_NAMES = [
  'nodes',
  'messages',
  'channels',
  'telemetry',
  'traceroutes',
  'route_segments',
  'neighbor_info',
  'settings',
  'users',
  'permissions',
  'sessions',
  'audit_log',
  'api_tokens',
  'read_messages',
  'push_subscriptions',
  'user_notification_preferences',
  'packet_log',
  'backup_history',
  'system_backup_history',
  'upgrade_history',
  'custom_themes',
  'user_map_preferences',
  'solar_estimates',
  'auto_traceroute_nodes',
  'auto_time_sync_nodes',
  'auto_traceroute_log',
  'auto_key_repair_state',
  'auto_key_repair_log',
  'channel_database',
  'channel_database_permissions',
  'ignored_nodes',
];
