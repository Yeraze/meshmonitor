/**
 * MySQL Schema Creation SQL
 *
 * This is the canonical MySQL schema for MeshMonitor.
 * Used by both the database service and migration script.
 *
 * IMPORTANT: This schema MUST match what createMySQLSchema() creates in database.ts
 * to ensure consistency between migration and fresh installations.
 */

export const MYSQL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
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
    isIgnored BOOLEAN DEFAULT false,
    mobile INT DEFAULT 0,
    rebootCount INT,
    publicKey TEXT,
    hasPKC BOOLEAN,
    lastPKIPacket BIGINT,
    keyIsLowEntropy BOOLEAN,
    duplicateKeyDetected BOOLEAN,
    keyMismatchDetected BOOLEAN,
    keySecurityIssueDetails TEXT,
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
    channel INT NOT NULL DEFAULT 0,
    portnum INT,
    requestId BIGINT,
    timestamp BIGINT NOT NULL,
    rxTime BIGINT,
    hopStart INT,
    hopLimit INT,
    relayNode INT,
    replyId BIGINT,
    emoji INT,
    viaMqtt BOOLEAN DEFAULT false,
    rxSnr REAL,
    rxRssi REAL,
    ackFailed BOOLEAN,
    routingErrorReceived BOOLEAN,
    deliveryState VARCHAR(50),
    wantAck BOOLEAN,
    ackFromNode INT,
    createdAt BIGINT NOT NULL,
    INDEX idx_messages_timestamp (timestamp),
    INDEX idx_messages_channel (channel)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS channels (
    id INT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    psk TEXT,
    role INT,
    uplinkEnabled BOOLEAN NOT NULL DEFAULT true,
    downlinkEnabled BOOLEAN NOT NULL DEFAULT true,
    positionPrecision INT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS telemetry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeId VARCHAR(255) NOT NULL,
    nodeNum BIGINT NOT NULL,
    telemetryType VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL,
    value DOUBLE NOT NULL,
    unit VARCHAR(255),
    createdAt BIGINT NOT NULL,
    packetTimestamp BIGINT,
    channel INT,
    precisionBits INT,
    gpsAccuracy DOUBLE,
    INDEX idx_telemetry_nodenum (nodeNum),
    INDEX idx_telemetry_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(255) PRIMARY KEY,
    value TEXT NOT NULL,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS users (
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
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    lastLoginAt BIGINT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT NOT NULL,
    resource VARCHAR(255) NOT NULL,
    canRead BOOLEAN NOT NULL DEFAULT false,
    canWrite BOOLEAN NOT NULL DEFAULT false,
    canDelete BOOLEAN NOT NULL DEFAULT false,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL,
    INDEX idx_sessions_expire (expire)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS traceroutes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
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
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromNodeNum BIGINT NOT NULL,
    toNodeNum BIGINT NOT NULL,
    fromNodeId VARCHAR(32) NOT NULL,
    toNodeId VARCHAR(32) NOT NULL,
    distanceKm DOUBLE NOT NULL,
    isRecordHolder BOOLEAN DEFAULT false,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_route_segments_from_to (fromNodeNum, toNodeNum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS neighbor_info (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeNum BIGINT NOT NULL,
    neighborNodeNum BIGINT NOT NULL,
    snr DOUBLE,
    lastRxTime BIGINT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_neighbor_info_nodenum (nodeNum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT,
    username VARCHAR(255),
    action VARCHAR(255) NOT NULL,
    resource VARCHAR(255),
    details TEXT,
    ipAddress VARCHAR(255),
    userAgent TEXT,
    timestamp BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_log_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS api_tokens (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS read_messages (
    messageId VARCHAR(255) NOT NULL,
    visitorKey VARCHAR(255) NOT NULL,
    userId INT,
    readAt BIGINT NOT NULL,
    PRIMARY KEY (messageId, visitorKey),
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS push_subscriptions (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS user_notification_preferences (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS packet_log (
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
    INDEX idx_packet_log_createdat (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS backup_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    filePath TEXT NOT NULL,
    sizeBytes BIGINT NOT NULL,
    schemaVersion INT NOT NULL,
    nodeCount INT,
    messageCount INT,
    createdAt BIGINT NOT NULL,
    createdBy TEXT,
    notes TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS upgrade_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    fromVersion VARCHAR(255) NOT NULL,
    toVersion VARCHAR(255) NOT NULL,
    upgradeType VARCHAR(255) NOT NULL,
    status VARCHAR(255) NOT NULL,
    startedAt BIGINT NOT NULL,
    completedAt BIGINT,
    error TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS custom_themes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    definition TEXT NOT NULL,
    createdBy INT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (createdBy) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS user_map_preferences (
    userId INT PRIMARY KEY,
    centerLat DOUBLE,
    centerLng DOUBLE,
    zoom INT,
    selectedNodeNum BIGINT,
    updatedAt BIGINT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS solar_estimates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp BIGINT NOT NULL UNIQUE,
    watt_hours DOUBLE NOT NULL,
    fetched_at BIGINT NOT NULL,
    created_at BIGINT,
    INDEX idx_solar_timestamp (timestamp),
    INDEX idx_solar_fetched_at (fetched_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS auto_traceroute_nodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nodeNum BIGINT NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT true,
    createdAt BIGINT NOT NULL,
    INDEX idx_auto_traceroute_nodenum (nodeNum)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS auto_traceroute_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    to_node_num BIGINT NOT NULL,
    to_node_name TEXT,
    success INT DEFAULT NULL,
    created_at BIGINT,
    INDEX idx_auto_traceroute_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS auto_key_repair_state (
    nodeNum BIGINT PRIMARY KEY,
    attemptCount INT DEFAULT 0,
    lastAttemptTime BIGINT,
    exhausted INT DEFAULT 0,
    startedAt BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS auto_key_repair_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp BIGINT NOT NULL,
    nodeNum BIGINT NOT NULL,
    nodeName TEXT,
    action TEXT NOT NULL,
    success INT DEFAULT NULL,
    created_at BIGINT,
    INDEX idx_auto_key_repair_log_timestamp (timestamp)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE INDEX idx_nodes_nodeid ON nodes(nodeId);
  CREATE INDEX idx_nodes_lastheard ON nodes(lastHeard);
`;

export const MYSQL_TABLE_NAMES = [
  'nodes',
  'messages',
  'channels',
  'telemetry',
  'settings',
  'users',
  'permissions',
  'sessions',
  'traceroutes',
  'route_segments',
  'neighbor_info',
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
  'solar_estimates',
  'auto_traceroute_nodes',
  'auto_traceroute_log',
  'auto_key_repair_state',
  'auto_key_repair_log',
];
