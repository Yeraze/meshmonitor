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
export * from './mqttPacketLog.js';

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
export * from './meshcorePositionHistory.js';
export * from './meshcoreHeardRepeaters.js';

// Embed Profiles table
export * from './embedProfiles.js';

// Automation Engine tables (global — no sourceId)
export * from './automations.js';
export * from './automationVariables.js';

// MeshCore saved-regions catalog (global — no sourceId) (#3770)
export * from './savedRegions.js';

// Waypoints table
export * from './waypoints.js';

// Estimated positions table (global — no sourceId)
export * from './estimatedPositions.js';

// Automated Remote Favorites Management (issue #2608)
export * from './autoFavoriteTargets.js';

// Per-source PKI private keys for server-side DM decryption (issue #3441)
export * from './sourcePkiKeys.js';

// Dead Drop / Mailbox — async per-source message store
export * from './deadDrop.js';

// ATAK contacts table (ATAK/CoT Phase 2, issue #3691) — per-source, one row
// per distinct ATAK EUD, built from the PLI variant of TAKPacket.
export * from './atakContacts.js';
