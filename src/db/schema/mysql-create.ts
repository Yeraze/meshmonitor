/**
 * MySQL Schema Creation SQL
 *
 * This is the canonical MySQL schema for MeshMonitor.
 * Used by both the database service and migration script.
 */

export const MYSQL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    nodeNum BIGINT PRIMARY KEY,
    nodeId VARCHAR(255) UNIQUE NOT NULL,
    longName TEXT,
    shortName TEXT,
    hwModel INTEGER,
    role INTEGER,
    hopsAway INTEGER,
    lastMessageHops INTEGER,
    viaMqtt TINYINT(1),
    macaddr TEXT,
    latitude FLOAT,
    longitude FLOAT,
    altitude FLOAT,
    batteryLevel INTEGER,
    voltage FLOAT,
    channelUtilization FLOAT,
    airUtilTx FLOAT,
    lastHeard BIGINT,
    snr FLOAT,
    rssi INTEGER,
    lastTracerouteRequest BIGINT,
    firmwareVersion TEXT,
    channel INTEGER,
    isFavorite TINYINT(1) DEFAULT 0,
    isIgnored TINYINT(1) DEFAULT 0,
    mobile INTEGER DEFAULT 0,
    rebootCount INTEGER,
    publicKey TEXT,
    hasPKC TINYINT(1),
    lastPKIPacket BIGINT,
    keyIsLowEntropy TINYINT(1),
    duplicateKeyDetected TINYINT(1),
    keyMismatchDetected TINYINT(1),
    keySecurityIssueDetails TEXT,
    welcomedAt BIGINT,
    positionChannel INTEGER,
    positionPrecisionBits INTEGER,
    positionGpsAccuracy FLOAT,
    positionHdop FLOAT,
    positionTimestamp BIGINT,
    positionOverrideEnabled INTEGER DEFAULT 0,
    latitudeOverride FLOAT,
    longitudeOverride FLOAT,
    altitudeOverride FLOAT,
    positionOverrideIsPrivate INTEGER DEFAULT 0,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(255) PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(255) NOT NULL,
    toNodeId VARCHAR(255) NOT NULL,
    text TEXT NOT NULL,
    channel INTEGER NOT NULL DEFAULT 0,
    portnum INTEGER,
    requestId BIGINT,
    timestamp BIGINT NOT NULL,
    rxTime BIGINT,
    hopStart INTEGER,
    hopLimit INTEGER,
    relayNode INTEGER,
    replyId BIGINT,
    emoji INTEGER,
    viaMqtt TINYINT(1) DEFAULT 0,
    rxSnr FLOAT,
    rxRssi FLOAT,
    ackFailed TINYINT(1),
    routingErrorReceived TINYINT(1),
    deliveryState TEXT,
    wantAck TINYINT(1),
    ackFromNode INTEGER,
    createdAt BIGINT NOT NULL,
    INDEX idx_messages_timestamp (timestamp),
    INDEX idx_messages_channel (channel)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    psk TEXT,
    role INTEGER,
    uplinkEnabled TINYINT(1) NOT NULL DEFAULT 1,
    downlinkEnabled TINYINT(1) NOT NULL DEFAULT 1,
    positionPrecision INTEGER,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS telemetry (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    nodeId VARCHAR(255) NOT NULL,
    nodeNum BIGINT NOT NULL,
    telemetryType VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL,
    value FLOAT NOT NULL,
    unit TEXT,
    createdAt BIGINT NOT NULL,
    packetTimestamp BIGINT,
    channel INTEGER,
    precisionBits INTEGER,
    gpsAccuracy FLOAT,
    INDEX idx_telemetry_nodenum (nodeNum),
    INDEX idx_telemetry_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS traceroutes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(255) NOT NULL,
    toNodeId VARCHAR(255) NOT NULL,
    route TEXT,
    routeBack TEXT,
    snrTowards TEXT,
    snrBack TEXT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_traceroutes_from_to (fromNodeNum, toNodeNum),
    INDEX idx_traceroutes_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS route_segments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(255) NOT NULL,
    toNodeId VARCHAR(255) NOT NULL,
    distanceKm FLOAT NOT NULL,
    isRecordHolder TINYINT(1) DEFAULT 0,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_route_segments_from_to (fromNodeNum, toNodeNum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS neighbor_info (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    neighborNodeNum BIGINT NOT NULL,
    snr DOUBLE,
    lastRxTime BIGINT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_neighbor_info_nodenum (nodeNum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email TEXT,
    displayName TEXT,
    passwordHash TEXT,
    authMethod VARCHAR(255) NOT NULL,
    oidcSubject VARCHAR(255) UNIQUE,
    isAdmin TINYINT(1) NOT NULL DEFAULT 0,
    isActive TINYINT(1) NOT NULL DEFAULT 1,
    passwordLocked TINYINT(1) NOT NULL DEFAULT 0,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastLoginAt BIGINT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS permissions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    userId BIGINT NOT NULL,
    resource VARCHAR(255) NOT NULL,
    canRead TINYINT(1) NOT NULL DEFAULT 0,
    canWrite TINYINT(1) NOT NULL DEFAULT 0,
    canDelete TINYINT(1) NOT NULL DEFAULT 0,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL,
    INDEX idx_sessions_expire (expire)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    userId BIGINT,
    username TEXT,
    action VARCHAR(255) NOT NULL,
    resource TEXT,
    details TEXT,
    ipAddress TEXT,
    userAgent TEXT,
    timestamp BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_log_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS api_tokens (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    userId BIGINT NOT NULL,
    name VARCHAR(255) NOT NULL,
    tokenHash VARCHAR(255) NOT NULL UNIQUE,
    prefix VARCHAR(255) NOT NULL,
    isActive TINYINT(1) NOT NULL DEFAULT 1,
    createdAt BIGINT NOT NULL,
    lastUsedAt BIGINT,
    expiresAt BIGINT,
    createdBy BIGINT,
    revokedAt BIGINT,
    revokedBy BIGINT,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS read_messages (
    messageId VARCHAR(255) NOT NULL,
    userId BIGINT NOT NULL,
    readAt BIGINT NOT NULL,
    PRIMARY KEY (messageId, userId),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    userId BIGINT,
    endpoint TEXT NOT NULL,
    p256dhKey TEXT NOT NULL,
    authKey TEXT NOT NULL,
    userAgent TEXT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastUsedAt BIGINT,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS user_notification_preferences (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    userId BIGINT NOT NULL UNIQUE,
    notifyOnMessage TINYINT(1) DEFAULT 1,
    notifyOnDirectMessage TINYINT(1) DEFAULT 1,
    notifyOnChannelMessage TINYINT(1) DEFAULT 0,
    notifyOnEmoji TINYINT(1) DEFAULT 0,
    notifyOnInactiveNode TINYINT(1) DEFAULT 0,
    notifyOnServerEvents TINYINT(1) DEFAULT 0,
    prefixWithNodeName TINYINT(1) DEFAULT 0,
    appriseEnabled TINYINT(1) DEFAULT 1,
    appriseUrls TEXT,
    notifyOnMqtt TINYINT(1) DEFAULT 1,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS packet_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    packetId BIGINT NOT NULL,
    fromNodeNum BIGINT,
    toNodeNum BIGINT,
    channel INTEGER,
    portnum INTEGER,
    hopLimit INTEGER,
    hopStart INTEGER,
    wantAck TINYINT(1),
    viaMqtt TINYINT(1) DEFAULT 0,
    rxTime BIGINT,
    rxSnr DOUBLE,
    rxRssi INTEGER,
    decoded TEXT,
    raw TEXT,
    createdAt BIGINT NOT NULL,
    INDEX idx_packet_log_createdat (createdAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS backup_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    filePath TEXT NOT NULL,
    sizeBytes BIGINT NOT NULL,
    schemaVersion INTEGER NOT NULL,
    nodeCount INTEGER,
    messageCount INTEGER,
    createdAt BIGINT NOT NULL,
    createdBy TEXT,
    notes TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS upgrade_history (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    fromVersion VARCHAR(255) NOT NULL,
    toVersion VARCHAR(255) NOT NULL,
    upgradeType VARCHAR(255) NOT NULL,
    status VARCHAR(255) NOT NULL,
    startedAt BIGINT NOT NULL,
    completedAt BIGINT,
    error TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS custom_themes (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    definition TEXT NOT NULL,
    createdBy BIGINT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS user_map_preferences (
    userId BIGINT PRIMARY KEY,
    centerLat DOUBLE,
    centerLng DOUBLE,
    zoom INTEGER,
    selectedNodeNum BIGINT,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE INDEX IF NOT EXISTS idx_nodes_nodeid ON nodes(nodeId);
  CREATE INDEX IF NOT EXISTS idx_nodes_lastheard ON nodes(lastHeard);
`;

export const MYSQL_TABLE_NAMES = [
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
  'upgrade_history',
  'custom_themes',
  'user_map_preferences',
];
