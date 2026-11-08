/**
 * MeshCore own-key change tracker (P7a, #6254, shared piece S5).
 *
 * Remembers the identity (public key) each MeshCore source's radio reported on
 * its last connect, so a swapped device or a re-keyed radio is noticed. This
 * is independent of the PKI capture's `keyMismatch`, which only runs for a
 * Companion that can export its private key and so misses most changes.
 *
 * State lives in internal per-source settings, so it survives a restart and a
 * reconnect:
 *  - `meshcoreOwnIdentityKey`    last key seen (lowercase 64-hex)
 *  - `meshcoreOwnIdentityChange` JSON `{ previousKey, currentKey, detectedAt }`,
 *                                present until a `security:write` user acknowledges
 * Neither key is in the settings-API allowlist (server-written only).
 *
 * Edge-triggered: `observe` returns `'changed'` once per change. The new key
 * becomes the stored key in the same step, so a repeat observe, a reconnect or
 * a restart returns `'same'`. Nothing here sends anything or runs on a timer.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';

export const OWN_IDENTITY_KEY_SETTING = 'meshcoreOwnIdentityKey';
export const OWN_IDENTITY_CHANGE_SETTING = 'meshcoreOwnIdentityChange';

export type OwnIdentityStatus = 'baseline' | 'same' | 'changed';

export interface OwnIdentityChange {
  previousKey: string;
  currentKey: string;
  /** Epoch ms. */
  detectedAt: number;
}

/** The slice of the settings repository the tracker uses. */
export interface OwnIdentitySettingsStore {
  getSettingForSource(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f]{64}$/;

function parseChange(raw: string | null | undefined): OwnIdentityChange | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<OwnIdentityChange>;
    if (
      typeof v?.previousKey === 'string' &&
      typeof v?.currentKey === 'string' &&
      typeof v?.detectedAt === 'number'
    ) {
      return { previousKey: v.previousKey, currentKey: v.currentKey, detectedAt: v.detectedAt };
    }
  } catch {
    /* corrupt record reads as none */
  }
  return null;
}

export class MeshCoreOwnIdentityTracker {
  /** Per-source chain so two overlapping connects cannot both report the same change. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: () => OwnIdentitySettingsStore = () => databaseService.settings,
    private readonly now: () => number = Date.now,
  ) {}

  private serialize<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(sourceId, next.catch(() => undefined));
    return next;
  }

  /**
   * Record the key the source's radio reports now.
   * `baseline`: first key ever seen (silent). `same`: unchanged, or the input
   * is not a 64-hex key (a placeholder such as `'repeater'` is ignored).
   * `changed`: differs from the stored key; the change record is written first.
   */
  observe(sourceId: string, publicKey: string | null | undefined): Promise<OwnIdentityStatus> {
    const pk = (publicKey ?? '').trim().toLowerCase();
    if (!sourceId || !KEY_RE.test(pk)) return Promise.resolve('same');
    return this.serialize(sourceId, async () => {
      const store = this.store();
      const stored = ((await store.getSettingForSource(sourceId, OWN_IDENTITY_KEY_SETTING)) ?? '').trim().toLowerCase();
      if (!KEY_RE.test(stored)) {
        await store.setSourceSetting(sourceId, OWN_IDENTITY_KEY_SETTING, pk);
        return 'baseline';
      }
      if (stored === pk) return 'same';
      const change: OwnIdentityChange = { previousKey: stored, currentKey: pk, detectedAt: this.now() };
      // Record first, key second: a crash between them re-reports the change
      // (never loses it); the reverse order could drop it silently.
      await store.setSourceSetting(sourceId, OWN_IDENTITY_CHANGE_SETTING, JSON.stringify(change));
      await store.setSourceSetting(sourceId, OWN_IDENTITY_KEY_SETTING, pk);
      logger.warn(
        `[MeshCore:${sourceId}] own public key changed ${stored.slice(0, 8)} -> ${pk.slice(0, 8)}`,
      );
      return 'changed';
    });
  }

  /** The unacknowledged change record, or null. */
  async getChange(sourceId: string): Promise<OwnIdentityChange | null> {
    if (!sourceId) return null;
    return parseChange(await this.store().getSettingForSource(sourceId, OWN_IDENTITY_CHANGE_SETTING));
  }

  /** The key last seen for the source, or null. */
  async getCurrentKey(sourceId: string): Promise<string | null> {
    if (!sourceId) return null;
    const v = ((await this.store().getSettingForSource(sourceId, OWN_IDENTITY_KEY_SETTING)) ?? '').trim().toLowerCase();
    return KEY_RE.test(v) ? v : null;
  }

  /**
   * Clear the change record; the stored key stays as the new baseline. Returns
   * true when a record was cleared. The route enforces `security:write`.
   */
  acknowledge(sourceId: string): Promise<boolean> {
    if (!sourceId) return Promise.resolve(false);
    return this.serialize(sourceId, async () => {
      const store = this.store();
      const had = parseChange(await store.getSettingForSource(sourceId, OWN_IDENTITY_CHANGE_SETTING)) !== null;
      if (had) await store.setSourceSetting(sourceId, OWN_IDENTITY_CHANGE_SETTING, '');
      return had;
    });
  }
}

export const meshcoreOwnIdentityTracker = new MeshCoreOwnIdentityTracker();
