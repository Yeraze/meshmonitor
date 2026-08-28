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

// Per-user conversation read watermarks (issue #4607)
export * from './conversationReadState.js';

// Packet logging
export * from './packets.js';
export * from './mqttPacketLog.js';
export * from './mqttOkToMqttViolations.js';

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

// Per-message delivery event timeline (#4816 Phase 3, protocol-agnostic)
export * from './messageEvents.js';

// Meshtastic Heard-By table (#4816 Phase 4 WP1)
export * from './meshtasticHeardRepeaters.js';

// Mesh Issues findings (global — no sourceId) (epic #4964 Phase 1 WP1)
export * from './meshIssues.js';

// Embed Profiles table
export * from './embedProfiles.js';

// Automation Engine tables (global — no sourceId)
export * from './automations.js';
export * from './automationVariables.js';
export * from './automationHomeAnchors.js';

// MeshCore saved-regions catalog (global — no sourceId) (#3770)
export * from './savedRegions.js';

// Waypoints table
export * from './waypoints.js';

// Estimated positions table (global — no sourceId)
export * from './estimatedPositions.js';

// Per-estimate anchor rationale (global — no sourceId, issue #4609)
export * from './estimatedPositionAnchors.js';

// Automated Remote Favorites Management (issue #2608)
export * from './autoFavoriteTargets.js';

// Per-source PKI private keys for server-side DM decryption (issue #3441)
export * from './sourcePkiKeys.js';

// Per-source MeshCore Analyzer Observer signing keys (epic #4457)
export * from './meshcoreObserverKeys.js';
export * from './meshcoreObserverCredentials.js';

// Dead Drop / Mailbox — async per-source message store
export * from './deadDrop.js';

// ATAK contacts table (ATAK/CoT Phase 2, issue #3691) — per-source, one row
// per distinct ATAK EUD, built from the PLI variant of TAKPacket.
export * from './atakContacts.js';
export * from './meshBeaconOffers.js';

// Reticulum tables (epic #3960, Phase 1a) — per-source destinations +
// interfaces snapshot.
export * from './reticulum.js';
