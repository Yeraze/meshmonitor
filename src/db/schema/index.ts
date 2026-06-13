/**
 * Drizzle Schema Index
 * Re-exports all schema definitions for SQLite, PostgreSQL, and MySQL
 */

// Core tables
export * from './nodes.js';
export * from './messages.js';
export * from './channels.js';
export * from './telemetry.js';
export * from './traceroutes.js';
export * from './settings.js';
export * from './neighbors.js';

// Auth tables
export * from './auth.js';

// Notification tables
export * from './notifications.js';

// Packet logging
export * from './packets.js';

// Miscellaneous tables
export * from './misc.js';

// Channel Database tables
export * from './channelDatabase.js';

// Ignored Nodes table
export * from './ignoredNodes.js';

// MeshCore tables
export * from './meshcoreNodes.js';
export * from './meshcoreMessages.js';
export * from './meshcoreNeighbors.js';
export * from './meshcorePacketLog.js';

// Embed Profiles table
export * from './embedProfiles.js';

// Waypoints table
export * from './waypoints.js';

// Estimated positions table (global — no sourceId)
export * from './estimatedPositions.js';

// Automated Remote Favorites Management (issue #2608)
export * from './autoFavoriteTargets.js';

// Per-source PKI private keys for server-side DM decryption (issue #3441)
export * from './sourcePkiKeys.js';
