/**
 * MeshCore source-config helpers.
 *
 * Converts a `sources.config` record (stored as JSON in the DB) into the
 * runtime `MeshCoreConfig` shape that `MeshCoreManager.connect()` expects.
 *
 * Extracted from meshcoreRegistry.ts so this logic can be imported without
 * pulling in the (now-deprecated) MeshCoreManagerRegistry class.
 */

import { ConnectionType, MeshCoreManager, type MeshCoreConfig } from './meshcoreManager.js';
import type { Source } from '../db/repositories/sources.js';
import { sourceManagerRegistry } from './sourceManagerRegistry.js';
import { isMeshCoreManager } from './sourceManagerTypes.js';
import { logger } from '../utils/logger.js';
import { normalizeBrokerUrl } from './transports/mqttBrokerClient.js';

export interface MeshCoreSourceConfig {
  transport?: 'usb' | 'serial' | 'tcp';
  port?: string;
  serialPort?: string;
  baudRate?: number;
  tcpHost?: string;
  tcpPort?: number;
  deviceType?: 'companion' | 'repeater';
  autoConnect?: boolean;
  /**
   * Companion heartbeat / auto-reconnect interval in seconds (0 = disabled).
   * Mirrors the Meshtastic source setting. When > 0 the manager periodically
   * probes the node (cheap RTC read) and, on repeated failure, tears down and
   * reconnects with exponential backoff. Only honoured for companion devices
   * (the native backend); repeater/direct-serial ignores it.
   */
  heartbeatIntervalSeconds?: number;
  // Virtual Node server — expose this node to the MeshCore app over WiFi (#3535).
  virtualNode?: {
    enabled?: boolean;
    port?: number;
    allowAdminCommands?: boolean;
    /**
     * Allow connected apps to read the node's Ed25519 private key over the
     * Virtual Node port via ExportPrivateKey(23). SECURITY-SENSITIVE, and
     * deliberately separate from `allowAdminCommands`: the VN port has no
     * per-client auth, so anything that can reach it gets the key. Off by
     * default.
     */
    allowPkiExport?: boolean;
  };
  observer?: MeshCoreObserverConfig;
}

/**
 * MeshCore Analyzer Observer output (#4457). When enabled, Phase 2's publisher
 * relays every OTA packet this companion hears to a MeshCore-Analyzer-compatible
 * MQTT broker. Observation-only: MeshMonitor publishes, never subscribes.
 *
 * NOTE: the Ed25519 signing key is deliberately NOT part of this block. It lives
 * encrypted in `meshcore_observer_keys` (see meshcoreObserverKeyStore) so it never
 * rides along in a config response or the source-edit form round-trip.
 */
export interface MeshCoreObserverConfig {
  enabled?: boolean;
  /**
   * How MeshMonitor authenticates to the broker (issue #4595).
   * - `token` (default, and the value assumed when absent): mint an
   *   Ed25519-signed token with the companion's own signing key; username is
   *   `v1_{PUBLIC_KEY}`. FL Mesh / LetsMesh-backbone brokers.
   * - `password`: send a STATIC MQTT username/password. Used by regional
   *   brokers (e.g. meshcoretel.ru) that don't verify the signature. The
   *   password is NEVER in this block — it lives encrypted in
   *   `meshcore_observer_credentials` (see meshcoreObserverCredentialStore).
   *
   * When `brokers[]` is present and non-empty, this is only the DEFAULT
   * auth mode for an entry that omits its own `authMode` — see
   * `MeshCoreObserverBrokerConfig.authMode`.
   */
  authMode?: 'token' | 'password';
  /**
   * LEGACY single broker (pre-#5014). Kept and still honoured: when
   * `brokers` is absent or empty, this (plus `authMode` / `tokenAudience`)
   * is synthesized into a single-entry broker list — see the precedence
   * rule in `normalizeObserverBrokers`.
   */
  brokerUrl?: string;
  /**
   * 3-letter IATA region code, or the literal 'test' for local validation.
   * Shared across every broker on purpose (#5014): it is the REGION segment
   * of the topic (`meshcore/{IATA}/{PUBKEY}/packets`), not a broker property.
   */
  iataCode?: string;
  /**
   * Must equal the broker's AUTH_EXPECTED_AUDIENCE, or auth is rejected.
   * Only meaningful in `token` mode — a static-credential broker signs
   * nothing, so there is no audience to match.
   *
   * LEGACY: applies only to the synthesized legacy broker entry. A
   * `brokers[]` entry needs its own `tokenAudience` — this value is
   * deliberately NOT inherited by other entries, since two brokers with
   * different audiences is the normal multi-broker case (#5014).
   */
  tokenAudience?: string;
  /**
   * Multi-broker list (#5014 Phase 1). When present and non-empty this is
   * authoritative: the legacy `brokerUrl` above is NOT unioned in as an
   * extra entry (see `normalizeObserverBrokers` rule 1 — unioning risks
   * double-publishing the same broker under two spellings).
   */
  brokers?: MeshCoreObserverBrokerConfig[];
}

/** One Analyzer broker this source publishes to (#5014 Phase 1). */
export interface MeshCoreObserverBrokerConfig {
  /** ws/wss/mqtt/mqtts URL, or a bare host:port that normalizeBrokerUrl accepts. */
  url: string;
  /** Defaults to the block-level `authMode`, which itself defaults to 'token'. */
  authMode?: 'token' | 'password';
  /**
   * Required in token mode. NOT inherited from the block-level
   * `tokenAudience`: two brokers with different audiences are the normal
   * case, and silently inheriting one would mint tokens the other broker
   * rejects. The only exception is the legacy synthesized entry — see the
   * precedence rule in `normalizeObserverBrokers`.
   */
  tokenAudience?: string;
  /** Free-text display label, e.g. "MeshMapper". UI only, never on the wire. */
  label?: string;
}

/**
 * One normalized, validated broker entry, as produced by
 * `normalizeObserverBrokers` and consumed by the publisher (#5014 Phase 1).
 */
export interface NormalizedObserverBroker {
  /** Stable identity: normalizeBrokerUrl(url).toLowerCase(). Non-secret. */
  key: string;
  /** normalizeBrokerUrl(url). */
  url: string;
  authMode: 'token' | 'password';
  /** Present iff authMode === 'token' (normalization drops token brokers without one). */
  tokenAudience?: string;
  label?: string;
  /**
   * True iff this entry corresponds to the block-level legacy `brokerUrl`.
   * The publisher uses it, and only it, to fall back to the pre-#5014
   * single-credential row. At most one entry can carry it (dedupe
   * guarantees key uniqueness).
   */
  legacy: boolean;
}

/**
 * Superset of the pre-#5014 runtime shape: the flat brokerUrl / authMode /
 * tokenAudience fields are RETAINED as mirrors of brokers[0] so every
 * existing reader (and every existing test) keeps compiling and keeps
 * observing the same values for a single-broker source (#5014 Phase 1).
 */
export interface NormalizedObserverConfig {
  enabled: true;
  iataCode: string;
  brokers: NormalizedObserverBroker[];
  authMode: 'token' | 'password';
  brokerUrl: string;
  tokenAudience?: string;
}

/** Normalize the (optional, back-compatible) observer auth mode. */
export function observerAuthMode(o: MeshCoreObserverConfig | undefined | null): 'token' | 'password' {
  return o?.authMode === 'password' ? 'password' : 'token';
}

/**
 * Stable, case-insensitive broker identity. The one place this is derived —
 * credentials, status and dedupe all key off this value (#5014 Phase 1).
 * Throws only if `normalizeBrokerUrl` throws (unnormalizable input).
 */
export function observerBrokerKey(url: string): string {
  return normalizeBrokerUrl(url).toLowerCase();
}

/**
 * Pure: turns the persisted (legacy or multi) observer block into the
 * ordered, deduped, validated broker list the publisher consumes. Never
 * throws. Returns `[]` when nothing usable is configured (#5014 Phase 1).
 *
 * Semantics, in order (see MESHMAPPER_OBSERVER_PHASE1_SPEC.md §2.3 for the
 * full rationale on each rule):
 *  1. Source list selection: `o.brokers` wins outright when it is a
 *     non-empty array — `o.brokerUrl` is NOT unioned in as an extra entry,
 *     which would risk double-publishing the same broker under two
 *     spellings once the Phase 2 UI migrates it into `brokers[0]`.
 *     Otherwise, synthesize a single entry from `o.brokerUrl` (when present).
 *  2. Per-entry auth mode: `entry.authMode ?? o.authMode ?? 'token'`.
 *  3. Per-entry audience: `entry.tokenAudience?.trim()`. Only the
 *     synthesized legacy entry falls back to `o.tokenAudience?.trim()`.
 *  4. Per-entry URL: `normalizeBrokerUrl(entry.url)`. On throw, warn naming
 *     the index and skip that entry only — one malformed broker must not
 *     disable the others.
 *  5. Dedupe by `key`, first wins.
 *  6. Completeness: drop a token-mode entry with no `tokenAudience`. A
 *     password-mode entry needs no audience.
 *  7. Legacy flag: true when the entry was synthesized from `o.brokerUrl`,
 *     OR when `o.brokerUrl` is present and its key matches this entry's key
 *     (keeps the pre-#5014 stored credential reachable after the Phase 2 UI
 *     moves that broker into `brokers[]`).
 */
export function normalizeObserverBrokers(
  o: MeshCoreObserverConfig | undefined | null,
): NormalizedObserverBroker[] {
  if (!o) return [];
  const blockAuthMode = observerAuthMode(o);
  const brokersProvided = Array.isArray(o.brokers) && o.brokers.length > 0;
  const rawList: MeshCoreObserverBrokerConfig[] = brokersProvided
    ? (o.brokers as MeshCoreObserverBrokerConfig[])
    : o.brokerUrl
      ? [{ url: o.brokerUrl, authMode: o.authMode, tokenAudience: o.tokenAudience }]
      : [];
  // True only for the single entry synthesized from the legacy field above —
  // NOT for a real brokers[] entry that merely happens to match it (rule 7's
  // second clause handles that case, without the audience fallback).
  const synthesizedFromLegacy = !brokersProvided && !!o.brokerUrl;

  const seen = new Map<string, NormalizedObserverBroker>();
  const order: string[] = [];

  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    if (!raw || typeof raw.url !== 'string' || raw.url.length === 0) {
      logger.warn(`[MeshCoreConfig] observer.brokers[${i}] has no url; skipping`);
      continue;
    }
    let url: string;
    try {
      url = normalizeBrokerUrl(raw.url);
    } catch {
      logger.warn(`[MeshCoreConfig] observer.brokers[${i}].url failed to normalize; skipping`);
      continue;
    }
    const key = url.toLowerCase();
    const isSynthesizedLegacyEntry = synthesizedFromLegacy && i === 0;
    const authMode: 'token' | 'password' =
      raw.authMode === 'password' ? 'password' : raw.authMode === 'token' ? 'token' : blockAuthMode;
    const tokenAudience = isSynthesizedLegacyEntry
      ? raw.tokenAudience?.trim() || o.tokenAudience?.trim() || undefined
      : raw.tokenAudience?.trim() || undefined;

    if (authMode === 'token' && !tokenAudience) {
      logger.warn(`[MeshCoreConfig] observer.brokers[${i}] (${key}) is token-mode with no tokenAudience; skipping`);
      continue;
    }

    if (seen.has(key)) {
      logger.debug(`[MeshCoreConfig] observer.brokers[${i}] (${key}) duplicates an earlier broker; discarding`);
      continue;
    }

    // At most one entry can carry legacy: true (dedupe guarantees key
    // uniqueness, and o.brokerUrl can match at most one normalized key).
    let legacy = isSynthesizedLegacyEntry;
    if (!legacy && o.brokerUrl) {
      try {
        legacy = observerBrokerKey(o.brokerUrl) === key;
      } catch {
        // o.brokerUrl itself fails to normalize — can't match; leave legacy false.
      }
    }

    seen.set(key, {
      key,
      url,
      authMode,
      ...(tokenAudience ? { tokenAudience } : {}),
      ...(raw.label ? { label: raw.label } : {}),
      legacy,
    });
    order.push(key);
  }

  return order.map((k) => seen.get(k)!);
}

/** Default TCP port the Virtual Node server listens on when none is given. */
export const DEFAULT_VIRTUAL_NODE_PORT = 5000;

/**
 * Build the runtime virtual-node config from a source's saved config, or
 * undefined when disabled/absent. A non-positive or missing port falls back to
 * the default so an enabled server always binds to a usable port.
 */
export function virtualNodeConfigFromSource(cfg: MeshCoreSourceConfig): MeshCoreConfig['virtualNode'] {
  const vn = cfg.virtualNode;
  if (!vn?.enabled) return undefined;
  return {
    enabled: true,
    port: typeof vn.port === 'number' && vn.port > 0 ? vn.port : DEFAULT_VIRTUAL_NODE_PORT,
    allowAdminCommands: vn.allowAdminCommands === true,
    allowPkiExport: vn.allowPkiExport === true,
  };
}

/**
 * Build the runtime Analyzer Observer config from a source's saved config, or
 * undefined when disabled/absent or missing a required field (#5014 Phase 1:
 * now multi-broker aware via `normalizeObserverBrokers`).
 *
 * "Incomplete block disables the observer" contract, preserved: returns
 * `undefined` when `!o.enabled`, when `iataCode` is missing, or when
 * `normalizeObserverBrokers` yields no usable broker at all (a bad
 * `brokerUrl`, or a token-mode broker with no `tokenAudience`, are each
 * warned-and-skipped there rather than throwing).
 *
 * The flat `authMode` / `brokerUrl` / `tokenAudience` fields on the returned
 * value are mirrors of `brokers[0]` — kept so every pre-#5014 reader (and
 * every pre-#5014 test) keeps observing the same values for a single-broker
 * source. `NormalizedObserverConfig` (the richer, multi-broker-aware type)
 * documents the full shape; `MeshCoreConfig['observer']` itself is not
 * retyped to it here — that is #5014 Phase 1 WP3.
 */
export function observerConfigFromSource(cfg: MeshCoreSourceConfig): MeshCoreConfig['observer'] {
  const o = cfg.observer;
  if (!o?.enabled || !o.iataCode) return undefined;
  const brokers = normalizeObserverBrokers(o);
  if (brokers.length === 0) return undefined;
  const primary = brokers[0];
  return {
    enabled: true,
    iataCode: o.iataCode.trim().toUpperCase(),
    brokers,
    authMode: primary.authMode,
    brokerUrl: primary.url,
    // Carried through in password mode only when the operator happened to
    // leave a value behind; the publisher ignores it in that mode.
    ...(primary.tokenAudience ? { tokenAudience: primary.tokenAudience } : {}),
  };
}

/**
 * Ensure a MeshCore manager is started for the given source.
 *
 * - If no manager is registered: creates one, configures it, and registers it
 *   (which auto-calls start() → connect()).
 * - If a MeshCore manager is registered but disconnected: reconnects it with
 *   the supplied config.
 * - If already registered and connected: logs a debug message and skips.
 *
 * This is the canonical create-or-connect recipe for MeshCore sources, shared
 * by sourceRoutes.ts (auto-connect on create/enable/config-change) and
 * server.ts (startup auto-connect loop).
 */
export async function ensureMeshCoreManagerStarted(source: Source, cfg: MeshCoreConfig): Promise<void> {
  const existing = sourceManagerRegistry.getManager(source.id);
  if (!existing) {
    const mc = new MeshCoreManager(source.id, source.name);
    mc.configure(cfg);
    await sourceManagerRegistry.addManager(mc);
  } else if (isMeshCoreManager(existing) && !existing.isConnected()) {
    await existing.connect(cfg);
  } else {
    logger.debug(`[MeshCore:${source.id}] Manager already registered as meshcore and connected — skipping auto-connect`);
  }
}

/**
 * Convert a `sources.config` record into the runtime `MeshCoreConfig`
 * shape that `MeshCoreManager.connect` expects. Supports companion-USB/serial
 * and TCP transports. Returns null when the config is missing required fields.
 */
export function meshcoreConfigFromSource(source: Source): MeshCoreConfig | null {
  const cfg = (source.config ?? {}) as MeshCoreSourceConfig;
  const firmwareType = cfg.deviceType === 'repeater' ? 'repeater' : 'companion';
  const virtualNode = virtualNodeConfigFromSource(cfg);
  const observer = observerConfigFromSource(cfg);

  // Companion-USB / direct serial — the v1 path.
  const port = cfg.serialPort || cfg.port;
  if ((cfg.transport === 'usb' || cfg.transport === 'serial' || !cfg.transport) && port) {
    return {
      connectionType: ConnectionType.SERIAL,
      serialPort: port,
      baudRate: cfg.baudRate ?? 115200,
      firmwareType,
      virtualNode,
      observer,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    };
  }

  if (cfg.transport === 'tcp' && cfg.tcpHost) {
    return {
      connectionType: ConnectionType.TCP,
      tcpHost: cfg.tcpHost,
      tcpPort: cfg.tcpPort ?? 4403,
      firmwareType,
      virtualNode,
      observer,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
    };
  }

  return null;
}
