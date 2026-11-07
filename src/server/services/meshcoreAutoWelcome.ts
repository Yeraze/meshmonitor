/**
 * MeshCore Auto Welcome (#6224) — parity with the Meshtastic auto-welcome.
 *
 * When a genuinely-new, named contact is discovered on a source, greet it once
 * with a templated message (a DM by default, or a channel post). The decision
 * is a pure function (testable); the MeshCoreManager owns the race lock, the
 * optional pre-send delay, and the actual send.
 *
 * Mesh-safety (the user set these limits, see the #6224 work-up):
 *   - DM to a brand-new node usually FLOODS (no known forwarding path yet), so
 *     each welcome can cost several transmissions mesh-wide. We send ONCE with
 *     no retry-on-miss.
 *   - Welcome-once: a per-source tracked set (meshcoreAutoWelcomeWelcomed) names
 *     every key already greeted, so a re-advert never re-welcomes. Bounded by
 *     the device contact table; same pattern as meshcoreAutoFavoriteNodes.
 *   - Hourly cap: welcomes beyond maxPerHour are DROPPED, not queued, so a wave
 *     of new-node adverts cannot burst. The recent-send timestamps live in
 *     settings (meshcoreAutoWelcomeSendTimes), so the cap survives a restart.
 *   - Hop gate: skip a node farther than maxHops. A node with no known path
 *     (pathLen null) PASSES the gate — a just-adverted node is usually near and
 *     its path is simply not cached yet — but it still counts against the cap.
 *
 * Airtime Cutoff / congestion gating is intentionally OUT OF SCOPE (#6224).
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

export const AUTO_WELCOME_DEFAULT_MESSAGE = 'Welcome {NAME} to the mesh!';
export const AUTO_WELCOME_DEFAULT_TARGET = 'dm';
export const AUTO_WELCOME_DEFAULT_MAX_HOPS = 3;
export const AUTO_WELCOME_MAX_HOPS_CEIL = 7;
export const AUTO_WELCOME_DEFAULT_DELAY_SECONDS = 30;
export const AUTO_WELCOME_MAX_DELAY_SECONDS = 600;
export const AUTO_WELCOME_DEFAULT_MAX_PER_HOUR = 6;
export const AUTO_WELCOME_MIN_PER_HOUR = 1;
export const AUTO_WELCOME_MAX_PER_HOUR = 60;
/** Cap on the tracked-welcomed set so a huge public mesh can't bloat settings. */
export const AUTO_WELCOME_TRACKED_CAP = 2000;

/** Minimal contact shape the decision needs. */
export interface AutoWelcomeContact {
  publicKey: string;
  advName?: string;
  name?: string;
  /** Hop count of the cached route; null/undefined = no known path (will flood). */
  pathLen?: number | null;
}

export interface AutoWelcomeSettings {
  enabled: boolean;
  message: string;
  /** 'dm' = direct message to the new node, else a channel index as a string. */
  target: string;
  waitForName: boolean;
  maxHops: number;
  delaySeconds: number;
  maxPerHour: number;
}

export type WelcomeDecision =
  | { action: 'send'; text: string; target: 'dm' | 'channel'; channelIdx?: number }
  | { action: 'skip'; reason: string };

/** The display name a contact carries, or null when still nameless. */
export function contactDisplayName(contact: AutoWelcomeContact): string | null {
  // `||` not `??`: firmware reports a nameless contact as "" (#3756).
  return contact.advName || contact.name || null;
}

/**
 * Decode a contact's cached-route hop count. Robust to either a small hop count
 * (2, 3, …) or the packed MeshCore pathLen byte (0xff = direct/0 hops; low 6
 * bits = hops). Returns null when there is no cached path at all.
 */
export function welcomeHopCount(pathLen: number | null | undefined): number | null {
  if (pathLen === null || pathLen === undefined) return null;
  if (pathLen === 0xff) return 0;
  return pathLen & 0x3f;
}

/** Replace the `{NAME}` token (case-insensitive) with the contact's display name. */
export function renderWelcomeMessage(template: string, contact: AutoWelcomeContact): string {
  const name = contactDisplayName(contact) ?? 'neighbor';
  return template.replace(/\{name\}/gi, name);
}

/** How many of the recent send timestamps fall inside the trailing hour from `now`. */
export function sendsInLastHour(sendTimes: number[], now: number): number[] {
  const cutoff = now - 3_600_000;
  return sendTimes.filter((t) => typeof t === 'number' && t > cutoff);
}

/**
 * Pure welcome decision. Given the resolved settings, the contact, whether it
 * was already welcomed, and the recent send timestamps, decide whether to send
 * (and the rendered text + target) or skip (with a reason, for logs/tests).
 */
export function decideAutoWelcome(opts: {
  settings: AutoWelcomeSettings;
  contact: AutoWelcomeContact;
  alreadyWelcomed: boolean;
  recentSendTimes: number[];
  now: number;
}): WelcomeDecision {
  const { settings, contact, alreadyWelcomed, recentSendTimes, now } = opts;
  if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
  if (!contact.publicKey) return { action: 'skip', reason: 'no_public_key' };
  if (alreadyWelcomed) return { action: 'skip', reason: 'already_welcomed' };

  const name = contactDisplayName(contact);
  if (settings.waitForName && !name) return { action: 'skip', reason: 'waiting_for_name' };

  const hops = welcomeHopCount(contact.pathLen);
  // A known path farther than the limit is skipped; an unknown path passes
  // (a fresh advert is usually near, its route just isn't cached yet).
  if (hops !== null && hops > settings.maxHops) return { action: 'skip', reason: 'too_far' };

  if (sendsInLastHour(recentSendTimes, now).length >= settings.maxPerHour) {
    return { action: 'skip', reason: 'rate_capped' };
  }

  const text = renderWelcomeMessage(settings.message, contact);
  if (settings.target === 'dm') return { action: 'send', text, target: 'dm' };
  const channelIdx = Number.parseInt(settings.target, 10);
  if (!Number.isFinite(channelIdx) || channelIdx < 0) {
    return { action: 'skip', reason: 'bad_target' };
  }
  return { action: 'send', text, target: 'channel', channelIdx };
}

export function clampMaxHops(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return AUTO_WELCOME_DEFAULT_MAX_HOPS;
  return Math.min(Math.max(n, 0), AUTO_WELCOME_MAX_HOPS_CEIL);
}

export function clampDelaySeconds(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return AUTO_WELCOME_DEFAULT_DELAY_SECONDS;
  return Math.min(Math.max(n, 0), AUTO_WELCOME_MAX_DELAY_SECONDS);
}

export function clampMaxPerHour(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return AUTO_WELCOME_DEFAULT_MAX_PER_HOUR;
  return Math.min(Math.max(n, AUTO_WELCOME_MIN_PER_HOUR), AUTO_WELCOME_MAX_PER_HOUR);
}

function parseKeyArray(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string | null): number[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Read and clamp the per-source Auto Welcome settings. */
export async function readAutoWelcomeSettings(sourceId: string): Promise<AutoWelcomeSettings> {
  const get = (key: string) => databaseService.settings.getSettingForSource(sourceId, key);
  const [enabled, message, target, waitForName, maxHops, delaySeconds, maxPerHour] = await Promise.all([
    get('meshcoreAutoWelcomeEnabled'),
    get('meshcoreAutoWelcomeMessage'),
    get('meshcoreAutoWelcomeTarget'),
    get('meshcoreAutoWelcomeWaitForName'),
    get('meshcoreAutoWelcomeMaxHops'),
    get('meshcoreAutoWelcomeDelaySeconds'),
    get('meshcoreAutoWelcomeMaxPerHour'),
  ]);
  return {
    enabled: enabled === 'true',
    message: message || AUTO_WELCOME_DEFAULT_MESSAGE,
    target: target || AUTO_WELCOME_DEFAULT_TARGET,
    // Default ON: MeshCore reports nameless nodes first, so without this a node
    // would be greeted as "neighbor" before its advert name arrives.
    waitForName: waitForName == null ? true : waitForName === 'true',
    maxHops: clampMaxHops(maxHops),
    delaySeconds: clampDelaySeconds(delaySeconds),
    maxPerHour: clampMaxPerHour(maxPerHour),
  };
}

/** Whether this public key has already been welcomed on this source. */
export async function wasWelcomed(sourceId: string, publicKey: string): Promise<boolean> {
  const set = parseKeyArray(await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoWelcomeWelcomed'));
  return set.includes(publicKey.toLowerCase());
}

/** The recent send timestamps (ms) pruned to the trailing hour from `now`. */
export async function recentSendTimes(sourceId: string, now: number): Promise<number[]> {
  const times = parseNumberArray(await databaseService.settings.getSettingForSource(sourceId, 'meshcoreAutoWelcomeSendTimes'));
  return sendsInLastHour(times, now);
}

/**
 * Record a successful welcome: mark the key welcomed (capped set) and append the
 * send timestamp (pruned to the last hour). Persisted so both the once-guarantee
 * and the hourly cap survive a restart.
 */
export async function recordWelcomeSend(sourceId: string, publicKey: string, now: number): Promise<void> {
  const settings = databaseService.settings;
  const key = publicKey.toLowerCase();

  const welcomed = parseKeyArray(await settings.getSettingForSource(sourceId, 'meshcoreAutoWelcomeWelcomed'));
  if (!welcomed.includes(key)) {
    welcomed.push(key);
    // Keep the newest if we somehow exceed the cap (drop oldest).
    const trimmed = welcomed.length > AUTO_WELCOME_TRACKED_CAP ? welcomed.slice(-AUTO_WELCOME_TRACKED_CAP) : welcomed;
    await settings.setSourceSetting(sourceId, 'meshcoreAutoWelcomeWelcomed', JSON.stringify(trimmed));
  }

  const times = sendsInLastHour(parseNumberArray(await settings.getSettingForSource(sourceId, 'meshcoreAutoWelcomeSendTimes')), now);
  times.push(now);
  await settings.setSourceSetting(sourceId, 'meshcoreAutoWelcomeSendTimes', JSON.stringify(times));
}

/** Manager surface the orchestration needs (kept thin for testability). */
export interface AutoWelcomeManager {
  sourceId: string;
  /** Send a DM (publicKey set) or a channel post (channelIdx set); send once, no retry. */
  sendMessage: (text: string, toPublicKey?: string, channelIdx?: number) => Promise<boolean>;
}

/**
 * Resolve the welcome decision for a freshly-discovered contact. Returns the
 * decision without sending — the manager applies the pre-send delay and does the
 * send, then calls {@link recordWelcomeSend}. Never throws.
 */
export async function resolveAutoWelcome(
  sourceId: string,
  contact: AutoWelcomeContact,
  now: number = Date.now(),
): Promise<WelcomeDecision> {
  try {
    const settings = await readAutoWelcomeSettings(sourceId);
    if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
    const [alreadyWelcomed, recent] = await Promise.all([
      wasWelcomed(sourceId, contact.publicKey),
      recentSendTimes(sourceId, now),
    ]);
    return decideAutoWelcome({ settings, contact, alreadyWelcomed, recentSendTimes: recent, now });
  } catch (err) {
    logger.warn(`[MeshCoreAutoWelcome:${sourceId}] resolve failed: ${(err as Error).message}`);
    return { action: 'skip', reason: 'error' };
  }
}
