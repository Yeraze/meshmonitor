/**
 * Reticulum source-config helpers (#3960 Phase 1a WP3).
 *
 * Converts a `sources.config` record (stored as JSON in the DB) into the
 * runtime `ReticulumConfig` shape that `ReticulumBridgeClient.connect()` /
 * the future `ReticulumManager` (WP4) expect.
 *
 * Mirrors `meshcoreConfig.ts`'s shape: a `*SourceConfig` interface for the
 * raw DB record, a `*ConfigFromSource()` mapper that returns `null` when
 * required fields are missing, and an `ensure*ManagerStarted()`
 * create-or-reconnect recipe shared by `sourceRoutes.ts` and
 * `bootstrapSources.ts`.
 *
 * WP4 seam: `ReticulumManager` (the `ISourceManager` implementation that
 * owns a `ReticulumBridgeClient` and persists announces/interface stats)
 * does not exist yet. `ensureReticulumManagerStarted` below is intentionally
 * a stub — WP4 replaces its body with the real create-or-reconnect recipe
 * (see the inline comment in that function for the exact shape to mirror
 * from `ensureMeshCoreManagerStarted`). Nothing else in this file changes
 * when WP4 lands.
 */

import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';
import { PROTOCOL_VERSION, type ReticulumMode, type TcpPeerConfig } from './reticulumProtocol.js';
import type { ReticulumConnectParams } from './reticulumBridgeClient.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { isReticulumManager } from './sourceManagerTypes.js';
import { ReticulumManager } from './reticulumManager.js';

/** Default bridge sidecar bind address (mirrors `bridge/meshmonitor_rns_bridge/config.py` DEFAULT_HOST/DEFAULT_PORT). */
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 8765;

export interface ReticulumSourceConfig {
  mode: 'attach' | 'tcp_peer';
  /** WebSocket URL of the bridge sidecar. Defaults to ws://127.0.0.1:8765 when omitted. */
  bridgeUrl?: string;
  /** Shared secret for the `hello` handshake (must match the bridge's BRIDGE_TOKEN). */
  token?: string;
  autoConnect?: boolean;
  /** attach mode: directory of the shared rnsd instance's RNS config. */
  configDir?: string;
  /** tcp_peer mode: one or more TCPClientInterface peers the bridge's own RNS instance joins. */
  peers?: TcpPeerConfig[];
}

/** Runtime config consumed by `ReticulumBridgeClient.connect()` (a superset used as `ReticulumConnectParams` plus transport fields). */
export interface ReticulumConfig extends ReticulumConnectParams {
  mode: ReticulumMode;
  bridgeUrl: string;
  token: string;
  protocolVersion: number;
}

/**
 * Convert a `sources.config` record into the runtime `ReticulumConfig` shape.
 * Returns `null` when a field required by the chosen mode is missing:
 *  - `attach` requires a non-blank `configDir`.
 *  - `tcp_peer` requires at least one well-formed `{host, port}` peer.
 *
 * `token` is NOT mode-specific and is not itself a null-trigger here (an
 * absent token is a valid, if non-functional, config — the resulting
 * `hello` handshake fails with `AUTH_FAILED`, which surfaces through
 * `ReticulumBridgeClient`/`ReticulumManager` status rather than silently
 * skipping auto-connect the way a missing `configDir`/`peers` does).
 */
export function reticulumConfigFromSource(source: Source): ReticulumConfig | null {
  const cfg = (source.config ?? {}) as unknown as ReticulumSourceConfig;
  const mode: ReticulumMode = cfg.mode === 'tcp_peer' ? 'tcp_peer' : 'attach';
  const bridgeUrl = cfg.bridgeUrl?.trim() || `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
  const token = cfg.token?.trim() ?? '';

  if (mode === 'attach') {
    const configDir = cfg.configDir?.trim();
    if (!configDir) return null;
    return {
      mode,
      bridgeUrl,
      token,
      protocolVersion: PROTOCOL_VERSION,
      configDir,
    };
  }

  // tcp_peer
  const peers = normalizeTcpPeers(cfg.peers);
  if (peers.length === 0) return null;
  return {
    mode,
    bridgeUrl,
    token,
    protocolVersion: PROTOCOL_VERSION,
    peers,
  };
}

function normalizeTcpPeers(raw: ReticulumSourceConfig['peers']): TcpPeerConfig[] {
  if (!Array.isArray(raw)) return [];
  const peers: TcpPeerConfig[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const host = typeof entry.host === 'string' ? entry.host.trim() : '';
    const port = typeof entry.port === 'number' ? entry.port : NaN;
    if (!host || !Number.isFinite(port) || port <= 0) continue;
    peers.push({ host, port });
  }
  return peers;
}

/**
 * Ensure a Reticulum manager is started for the given source (create-or-
 * reconnect recipe, mirrors `ensureMeshCoreManagerStarted` in
 * `meshcoreConfig.ts`). Called by both `bootstrapSources.ts` and
 * `sourceRoutes.ts` (WP5) — this same function name/signature is the shared
 * seam, so neither call site changes across WP boundaries.
 *
 * - No manager registered yet: create one, stage `cfg` via `configure()`,
 *   then register it — `addManager()` calls `start()` automatically, which
 *   drives the actual `connect()`.
 * - A Reticulum manager is already registered but not connected: reconnect
 *   it in place with the (possibly updated) `cfg`.
 * - Already registered and connected: no-op (logged at debug).
 */
export async function ensureReticulumManagerStarted(source: Source, cfg: ReticulumConfig): Promise<void> {
  const existing = sourceManagerRegistry.getManager(source.id);
  if (!existing) {
    const rm = new ReticulumManager(source.id, source.name);
    rm.configure(cfg);
    await sourceManagerRegistry.addManager(rm);
  } else if (isReticulumManager(existing) && !existing.isConnected()) {
    await existing.connect(cfg);
  } else {
    logger.debug(`[Reticulum:${source.id}] Manager already registered and connected — skipping auto-connect`);
  }
}
