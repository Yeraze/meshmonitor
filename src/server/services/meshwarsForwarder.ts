/**
 * MeshWars forwarder — sends MeshCore "heard repeaters" results to MeshWars
 * (https://github.com/zvx-echo6/meshwars), a territory game where a player
 * claims a map square by reaching the mesh from it.
 *
 * MeshWars takes MeshCore pings at POST /api/mc/ingest in the MeshMapper
 * wardrive format: a position, the repeaters that re-flooded the ping, and
 * the radio's contact key, authenticated by the player's MeshWars API key.
 * MeshMonitor already learns the same thing on its own: when a repeater
 * re-floods one of our channel messages we correlate the self-echo (#3700)
 * and emit `meshcore:channel-heard`. This service turns each such message
 * into one MeshWars "TX" ping.
 *
 * ## Mesh impact (CLAUDE.md checklist)
 *
 * 1. Airtime: none. Nothing is transmitted; the forwarder only reports on
 *    channel messages the user already sent. The cost is one HTTPS POST.
 * 2. Spam: no packets, events or notifications. HTTP is capped at one ping
 *    per MIN_FORWARD_INTERVAL_MS, the same as MeshWars' own repaint cooldown
 *    for a square, so a ping inside that window would score nothing anyway.
 *    A failed POST is logged and dropped, never retried.
 * 3. Timers: the last forward time is persisted, so a restart or a settings
 *    save does not reopen the window early.
 *
 * Off by default. Admin-only to configure, because it sends the radio's
 * position to a third-party server.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { dataEventEmitter, type DataEvent } from './dataEventEmitter.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager } from '../sourceManagerTypes.js';

/** User-editable, saved through POST /api/settings (VALID_SETTINGS_KEYS). */
export const MESHWARS_SETTINGS = {
  enabled: 'meshwarsEnabled',
  sourceId: 'meshwarsSourceId',
  baseUrl: 'meshwarsBaseUrl',
  // `_token` suffix keeps it server-only (SECRET_SETTINGS_KEY_PATTERN).
  apiKey: 'meshwars_api_token',
} as const;

/** Server-owned state, written with setSetting directly; not user-postable. */
const STATE_KEYS = {
  lastForwardAt: 'meshwarsLastForwardAt',
} as const;

export const DEFAULT_MESHWARS_BASE_URL = 'https://meshwars.com';
/** Matches MeshWars' MC_COOLDOWN_SECONDS default (5 minutes). */
export const MIN_FORWARD_INTERVAL_MS = 5 * 60_000;
/** How long to keep collecting repeaters for one message before sending. */
export const COLLECT_WINDOW_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface HeardRepeater {
  hash: string;
  name?: string | null;
  snr?: number | null;
}

export interface MeshWarsPing {
  type: 'TX';
  lat: number;
  lon: number;
  timestamp: number;
  heard_repeats: string;
  contact: string;
}

export interface MeshWarsStatus {
  enabled: boolean;
  sourceId: string;
  baseUrl: string;
  apiKeySet: boolean;
  lastForwardAt: number | null;
  lastResult: { at: number; ok: boolean; repeaters: number; error?: string } | null;
  forwardedCount: number;
  skippedCount: number;
  minForwardIntervalMs: number;
}

/**
 * Build a MeshWars ping, or null when the radio has no position or key or
 * nothing heard the message. `heard_repeats` is MeshMapper's
 * "id(snr),id(snr)" string; a repeater with no SNR gets 0, since MeshWars
 * ignores an entry without the parenthesis and SNR plays no part in scoring.
 */
export function buildPing(
  node: { latitude?: number; longitude?: number; publicKey?: string } | null,
  heardBy: HeardRepeater[],
  heardAtMs: number,
): MeshWarsPing | null {
  if (!node) return null;
  const { latitude: lat, longitude: lon, publicKey } = node;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (!publicKey || !/^[0-9a-f]{8}/i.test(publicKey)) return null;

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const r of heardBy) {
    const id = (r.hash || '').trim().toLowerCase();
    if (!/^[0-9a-f]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const snr = typeof r.snr === 'number' && Number.isFinite(r.snr) ? r.snr : 0;
    entries.push(`${id}(${snr})`);
  }
  if (entries.length === 0) return null;

  return {
    type: 'TX',
    lat,
    lon,
    timestamp: Math.floor(heardAtMs / 1000),
    heard_repeats: entries.join(','),
    contact: publicKey.slice(0, 8).toUpperCase(),
  };
}

/** Normalise a base URL: http(s) only, no trailing slash. Null if invalid. */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim() || DEFAULT_MESHWARS_BASE_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

interface Pending {
  sourceId: string;
  firstHeardAt: number;
  heardBy: HeardRepeater[];
}

class MeshWarsForwarder {
  private started = false;
  private pending = new Map<string, Pending>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastResult: MeshWarsStatus['lastResult'] = null;
  private forwardedCount = 0;
  private skippedCount = 0;

  /** Subscribe to heard-repeater events. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    dataEventEmitter.on('data', this.onEvent);
    logger.debug('[MeshWars] forwarder started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    dataEventEmitter.off('data', this.onEvent);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }

  private onEvent = (event: DataEvent): void => {
    if (event.type !== 'meshcore:channel-heard') return;
    const data = event.data as { id?: string; heardBy?: HeardRepeater[] } | undefined;
    if (!data?.id || !Array.isArray(data.heardBy) || !event.sourceId) return;
    this.noteHeard(event.sourceId, data.id, data.heardBy, event.timestamp ?? Date.now());
  };

  /**
   * Record the latest heard-by set for a message. The event carries the full
   * set each time, so the newest one replaces the old. The first echo starts
   * a collection window; the ping goes out when it closes.
   */
  noteHeard(sourceId: string, messageId: string, heardBy: HeardRepeater[], at: number): void {
    const key = `${sourceId}:${messageId}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.heardBy = heardBy;
      return;
    }
    this.pending.set(key, { sourceId, firstHeardAt: at, heardBy });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const entry = this.pending.get(key);
      this.pending.delete(key);
      if (entry) void this.flush(entry);
    }, COLLECT_WINDOW_MS);
    this.timers.add(timer);
  }

  private async setting(key: string): Promise<string | null> {
    return databaseService.settings.getSetting(key);
  }

  /** Send one message's ping, if enabled for its source and outside the cooldown. */
  async flush(entry: Pending, now = Date.now()): Promise<void> {
    if ((await this.setting(MESHWARS_SETTINGS.enabled)) !== 'true') return;
    if ((await this.setting(MESHWARS_SETTINGS.sourceId)) !== entry.sourceId) return;

    const apiKey = ((await this.setting(MESHWARS_SETTINGS.apiKey)) ?? '').trim();
    const baseUrl = normalizeBaseUrl(await this.setting(MESHWARS_SETTINGS.baseUrl));
    if (!apiKey || !baseUrl) {
      this.skippedCount++;
      return;
    }

    const last = Number(await this.setting(STATE_KEYS.lastForwardAt)) || 0;
    if (now - last < MIN_FORWARD_INTERVAL_MS) {
      this.skippedCount++;
      return;
    }

    const manager = sourceManagerRegistry.getManager(entry.sourceId);
    if (!manager || !isMeshCoreManager(manager)) {
      this.skippedCount++;
      return;
    }
    const ping = buildPing(manager.getLocalNode(), entry.heardBy, entry.firstHeardAt);
    if (!ping) {
      this.skippedCount++;
      this.lastResult = { at: now, ok: false, repeaters: 0, error: 'Radio has no position or public key' };
      return;
    }

    // Persist before sending, so a slow or failed POST still holds the window.
    await databaseService.settings.setSetting(STATE_KEYS.lastForwardAt, String(now));
    const repeaters = ping.heard_repeats.split(',').length;
    try {
      const response = await fetch(`${baseUrl}/api/mc/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ data: [ping] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        this.forwardedCount++;
        this.lastResult = { at: now, ok: true, repeaters };
      } else {
        this.lastResult = { at: now, ok: false, repeaters, error: `HTTP ${response.status}` };
        logger.warn(`[MeshWars] ingest rejected: HTTP ${response.status}`);
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.lastResult = { at: now, ok: false, repeaters, error };
      logger.warn(`[MeshWars] ingest failed: ${error}`);
    }
  }

  async getStatus(): Promise<MeshWarsStatus> {
    const last = Number(await this.setting(STATE_KEYS.lastForwardAt)) || 0;
    return {
      enabled: (await this.setting(MESHWARS_SETTINGS.enabled)) === 'true',
      sourceId: (await this.setting(MESHWARS_SETTINGS.sourceId)) ?? '',
      baseUrl: normalizeBaseUrl(await this.setting(MESHWARS_SETTINGS.baseUrl)) ?? DEFAULT_MESHWARS_BASE_URL,
      apiKeySet: ((await this.setting(MESHWARS_SETTINGS.apiKey)) ?? '').trim() !== '',
      lastForwardAt: last || null,
      lastResult: this.lastResult,
      forwardedCount: this.forwardedCount,
      skippedCount: this.skippedCount,
      minForwardIntervalMs: MIN_FORWARD_INTERVAL_MS,
    };
  }
}

export const meshwarsForwarder = new MeshWarsForwarder();
