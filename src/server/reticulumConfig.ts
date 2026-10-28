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
import { validateBridgeUrl, type ReticulumConnectParams } from './reticulumBridgeClient.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { isReticulumManager } from './sourceManagerTypes.js';
import { ReticulumManager } from './reticulumManager.js';
import { clampIntervalSetting, RETICULUM_ANNOUNCE_HOURS } from './utils/schedulerInterval.js';

/** Default bridge sidecar bind address (mirrors `bridge/meshmonitor_rns_bridge/config.py` DEFAULT_HOST/DEFAULT_PORT). */
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 8765;

export interface ReticulumSourceConfig {
  mode: 'attach' | 'tcp_peer' | 'own';
  /** WebSocket URL of the bridge sidecar. Defaults to ws://127.0.0.1:8765 when omitted. */
  bridgeUrl?: string;
  /** Shared secret for the `hello` handshake (must match the bridge's BRIDGE_TOKEN). */
  token?: string;
  autoConnect?: boolean;
  /** attach mode: directory of the shared rnsd instance's RNS config. */
  configDir?: string;
  /** tcp_peer mode: one or more TCPClientInterface peers the bridge's own RNS instance joins. */
  peers?: TcpPeerConfig[];
  /**
   * own mode (Phase 3 WP1/WP4, build spec §2.B/§2.C): the RNode's serial
   * device path (e.g. `/dev/ttyUSB0`). Required for own mode.
   */
  device?: string;
  /** own mode: initial radio params applied at interface construction (build spec §2.C). All optional. */
  frequency?: number;
  bandwidth?: number;
  spreadingFactor?: number;
  codingRate?: number;
  txPower?: number;
  stAlock?: number;
  ltAlock?: number;
  /**
   * Phase 4 WP3 (build spec §0 R5): the operator's remote-fleet allowlist —
   * which remote destination hashes THIS source is permitted to query via
   * `get_remote_status`. NOT mode-specific (own/attach/tcp_peer all forward
   * it) — mirrors the bridge's own `RNS_REMOTE_ALLOWED` env var
   * (`config.py`'s `remote_allowed`). Admin-set hex destination hashes,
   * lowercased/deduplicated by `reticulumConfigFromSource`.
   */
  remoteAllowed?: string[];
  /**
   * LXMF display name this source announces (#6011). Absent = anonymous.
   * Written by `PUT /api/sources/:id/reticulum/display-name`, not by the
   * source edit form; re-applied to the bridge on every connect, before the
   * on-connect announce. See {@link normalizeReticulumDisplayName}.
   */
  displayName?: string;
  /**
   * Periodic LXMF announce interval in hours (#6011). Absent or 0 = off (the
   * default); otherwise 1–24 ({@link RETICULUM_ANNOUNCE_HOURS}). Written by
   * `PUT /api/sources/:id/reticulum/announce-interval`.
   */
  announceIntervalHours?: number;
}

/**
 * `sources.config` keys owned by the Reticulum Configuration page rather than
 * the source edit form (#6011). The form rebuilds `config` from its own fields,
 * so a source save that leaves these out keeps the stored values
 * ({@link preserveReticulumManagedConfig}).
 */
export const RETICULUM_MANAGED_CONFIG_KEYS = ['displayName', 'announceIntervalHours'] as const;

/**
 * Longest LXMF display name we accept, in characters (#6011). LXMF sets no
 * limit of its own, but the name rides in the announce's app_data, and an RNS
 * announce must fit one 500-byte packet. 64 characters is at most 256 UTF-8
 * bytes, which still fits beside the announce's ~200 bytes of keys, hashes and
 * signature, and is longer than any name Sideband or NomadNet shows in full.
 */
export const RETICULUM_DISPLAY_NAME_MAX_CHARS = 64;

/**
 * Validate a display name from a request body (#6011). Trims whitespace; an
 * empty result (or `null`) means anonymous and comes back as `null`. Rejects a
 * non-string, a name over {@link RETICULUM_DISPLAY_NAME_MAX_CHARS} characters,
 * and control characters (they would end up in every peer's contact list).
 */
export function normalizeReticulumDisplayName(
  raw: unknown,
): { ok: true; name: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, name: null };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string or null' };
  const name = raw.trim();
  if (name.length === 0) return { ok: true, name: null };
  if (Array.from(name).length > RETICULUM_DISPLAY_NAME_MAX_CHARS) {
    return { ok: false, error: `name must be at most ${RETICULUM_DISPLAY_NAME_MAX_CHARS} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, error: 'name must not contain control characters' };
  }
  return { ok: true, name };
}

/**
 * Read the stored periodic-announce interval (#6011): 0 (off) when absent,
 * zero or not a number; otherwise clamped into {@link RETICULUM_ANNOUNCE_HOURS},
 * since nothing upstream of a hand-edited row bounds it.
 */
export function announceIntervalHoursFromConfig(raw: unknown, label = 'Reticulum announceIntervalHours'): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return clampIntervalSetting(Math.round(raw), RETICULUM_ANNOUNCE_HOURS, label);
}

/**
 * Put back the Configuration-page keys ({@link RETICULUM_MANAGED_CONFIG_KEYS})
 * that a source-form save left out (#6011). A key the save does send, including
 * an explicit `null`, wins.
 */
export function preserveReticulumManagedConfig(
  stored: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!stored) return next;
  const out = { ...next };
  for (const key of RETICULUM_MANAGED_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(next, key) && stored[key] !== undefined) {
      out[key] = stored[key];
    }
  }
  return out;
}

/** Runtime config consumed by `ReticulumBridgeClient.connect()` (a superset used as `ReticulumConnectParams` plus transport fields). */
export interface ReticulumConfig extends ReticulumConnectParams {
  mode: ReticulumMode;
  bridgeUrl: string;
  token: string;
  protocolVersion: number;
  /** Saved LXMF display name (#6011); `null`/absent = anonymous. Not sent in `configure`. */
  displayName?: string | null;
  /** Periodic announce interval in hours (#6011); 0/absent = off. */
  announceIntervalHours?: number;
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
 *
 * `bridgeUrl` IS validated here (fail-fast at source-create/update time, not
 * just at connect time): a malformed URL, non-`ws(s):` scheme, or non-
 * loopback host outside `RETICULUM_BRIDGE_ALLOWED_HOSTS` returns `null` (with
 * a warning logged), mirroring how `observerConfigFromSource` in
 * `meshcoreConfig.ts` handles a `brokerUrl` that fails to normalize. See
 * `validateBridgeUrl()` in `reticulumBridgeClient.ts` for the full rule set —
 * `ReticulumBridgeClient.connect()` re-validates independently, so this is a
 * belt-and-suspenders early check, not the only enforcement point.
 */
export function reticulumConfigFromSource(source: Source): ReticulumConfig | null {
  const cfg = (source.config ?? {}) as unknown as ReticulumSourceConfig;
  if (cfg.mode !== undefined && cfg.mode !== 'attach' && cfg.mode !== 'tcp_peer' && cfg.mode !== 'own') {
    logger.warn(
      `[ReticulumConfig] Unrecognized mode '${String(cfg.mode)}' in source ${source.id} config — defaulting to 'attach'`,
    );
  }
  const mode: ReticulumMode = cfg.mode === 'tcp_peer' ? 'tcp_peer' : cfg.mode === 'own' ? 'own' : 'attach';
  const bridgeUrl = cfg.bridgeUrl?.trim() || `ws://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
  const token = cfg.token?.trim() ?? '';

  try {
    validateBridgeUrl(bridgeUrl);
  } catch (e) {
    logger.warn(
      `[ReticulumConfig] Rejecting source config: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }

  // Phase 4 WP3 (build spec §0 R5): NOT mode-specific — every mode forwards
  // the same remote-fleet allowlist.
  const remoteAllowed = normalizeRemoteAllowed(cfg.remoteAllowed);

  // #6011: LXMF identity settings, the same for every mode. A stored name that
  // no longer validates (hand-edited row) is dropped rather than sent.
  const storedName = normalizeReticulumDisplayName(cfg.displayName);
  const identity = {
    displayName: storedName.ok ? storedName.name : null,
    announceIntervalHours: announceIntervalHoursFromConfig(
      cfg.announceIntervalHours,
      `Source ${source.id} announceIntervalHours`,
    ),
  };

  if (mode === 'attach') {
    const configDir = cfg.configDir?.trim();
    if (!configDir) return null;
    return {
      mode,
      bridgeUrl,
      token,
      protocolVersion: PROTOCOL_VERSION,
      configDir,
      remoteAllowed,
      ...identity,
    };
  }

  if (mode === 'own') {
    const device = cfg.device?.trim();
    if (!device) return null;
    return {
      mode,
      bridgeUrl,
      token,
      protocolVersion: PROTOCOL_VERSION,
      device,
      frequency: finiteNumberOrUndefined(cfg.frequency),
      bandwidth: finiteNumberOrUndefined(cfg.bandwidth),
      spreadingFactor: finiteNumberOrUndefined(cfg.spreadingFactor),
      codingRate: finiteNumberOrUndefined(cfg.codingRate),
      txPower: finiteNumberOrUndefined(cfg.txPower),
      stAlock: finiteNumberOrUndefined(cfg.stAlock),
      ltAlock: finiteNumberOrUndefined(cfg.ltAlock),
      remoteAllowed,
      ...identity,
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
    remoteAllowed,
    ...identity,
  };
}

/** Coerce a raw `sources.config` field into a finite number, or `undefined` (own-mode initial radio params are all optional — see build spec §2.C). */
function finiteNumberOrUndefined(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Normalize `sources.config`'s `remoteAllowed` field into a lowercased,
 * deduplicated, blank-filtered hex-hash list — same leniency as the
 * bridge's own `config.py`'s `_parse_remote_allowed` (no hex/length
 * validation here, that happens at request time on the query side; see
 * build spec §0 R5). Returns `undefined` (not an empty array) when nothing
 * was configured, matching the `finiteNumberOrUndefined` "omit rather than
 * send an empty/default value" convention used by the own-mode radio
 * params below.
 */
function normalizeRemoteAllowed(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const hash = entry.trim().toLowerCase();
    if (hash.length === 0) continue;
    seen.add(hash);
  }
  return seen.size > 0 ? Array.from(seen) : undefined;
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
