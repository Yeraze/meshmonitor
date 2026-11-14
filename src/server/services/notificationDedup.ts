/**
 * Cross-source notification dedup (#5729).
 *
 * Two sources that hear the same mesh packet each raise their own
 * notification. This store lets the dispatcher send ONE per recipient: the
 * first copy notifies, later copies inside the window do not.
 *
 * How it is used:
 *   1. The caller that raises the event puts a `dedup.key` on the payload. A
 *      packet's key is (fromNodeNum, packetId, portnum), see `packetDedupKey`.
 *   2. Each delivery wrapper (Web Push, Apprise, desktop) still runs THIS
 *      source's permission and filter checks for the recipient, exactly as
 *      before. Only a copy that would have been sent then calls `claim`.
 *   3. `claim` answers `first` (send it), `additional` (a new source joined;
 *      Web Push may update the shown notification silently) or `duplicate`
 *      (send nothing). Apprise and the desktop app cannot update a sent
 *      message, so a `first` claim there starts a 5 s hold
 *      (`NotificationHoldStore`, below) and `additional` copies join it; one
 *      message then lists every source.
 *
 * State is per (recipient, key), never per key alone. The source list a
 * recipient sees therefore holds only sources whose copy passed THAT
 * recipient's own permission and filter, so a user who can read one source
 * never learns another source's name (the two-source rule, CLAUDE.md).
 *
 * Memory only, on purpose. A restart forgets the window, so the worst case is
 * one duplicate for a packet that straddles the restart. The store sends
 * nothing and arms no timer: entries expire when they are next looked at, and
 * the map is capped (`NOTIFICATION_DEDUP_MAX_ENTRIES`), oldest out first.
 *
 * The window is a constant for this step, not a setting. It is measured from
 * the FIRST copy and does not slide, so a steady stream of copies cannot hold
 * an entry open.
 */

/** How long after the first copy a later copy counts as the same event. */
export const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;

/** Hard cap on live entries; the oldest is dropped when a new one would exceed it. */
export const NOTIFICATION_DEDUP_MAX_ENTRIES = 10_000;

/** A source whose copy of the event passed the recipient's checks. */
export interface DedupSource {
  sourceId: string;
  sourceName: string;
  /**
   * Web Push only: the click target of this source's copy. Kept for the first
   * source so a silent update still opens the source that heard it first
   * (#5729, decision 3).
   */
  navData?: unknown;
}

/**
 * Dedup instructions carried on a notification payload. Never sent on the
 * wire: delivery wrappers strip it.
 */
export interface NotificationDedupSpec {
  /** Same event ⇒ same key, whichever source heard it. */
  key: string;
  /**
   * Title and body for a notification that names several sources. Used only
   * by a channel that can update a shown notification (Web Push). Message
   * notifications do not need it: they re-render the recipient's template
   * with the joined source names. Without it (and without a template) a later
   * copy is dropped rather than shown.
   */
  merged?: (sourceNames: string[]) => { title: string; body: string };
}

export type DedupClaim =
  /** No live entry: this is the copy to send. */
  | { outcome: 'first'; sources: DedupSource[] }
  /** A live entry exists and this source is new to it. `sources` is in arrival order. */
  | { outcome: 'additional'; sources: DedupSource[] }
  /** A live entry exists and already holds this source. */
  | { outcome: 'duplicate'; sources: DedupSource[] };

interface DedupEntry {
  firstAt: number;
  sources: DedupSource[];
}

export class NotificationDedupStore {
  // Insertion order is first-copy order: an entry is only ever inserted at
  // its `firstAt`, so the front of the map is always the oldest.
  private readonly entries = new Map<string, DedupEntry>();

  constructor(
    private readonly windowMs: number = NOTIFICATION_DEDUP_WINDOW_MS,
    private readonly maxEntries: number = NOTIFICATION_DEDUP_MAX_ENTRIES,
  ) {}

  private static entryKey(recipient: string, key: string): string {
    // `recipient` never holds a newline, so the pair cannot collide.
    return `${recipient}\n${key}`;
  }

  /**
   * Record that `source`'s copy of event `key` is about to be delivered to
   * `recipient`, and say what to do with it. Synchronous, so two sources
   * racing on the same packet cannot both be `first`.
   */
  claim(recipient: string, key: string, source: DedupSource, now: number = Date.now()): DedupClaim {
    const mapKey = NotificationDedupStore.entryKey(recipient, key);
    const existing = this.entries.get(mapKey);
    if (existing && now - existing.firstAt < this.windowMs) {
      if (existing.sources.some(s => s.sourceId === source.sourceId)) {
        return { outcome: 'duplicate', sources: [...existing.sources] };
      }
      existing.sources.push({ ...source });
      return { outcome: 'additional', sources: [...existing.sources] };
    }

    // New event (or the old entry ran out): re-insert so it sits at the back.
    this.entries.delete(mapKey);
    this.prune(now);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    const entry: DedupEntry = {
      firstAt: now,
      sources: [{ ...source }],
    };
    this.entries.set(mapKey, entry);
    return { outcome: 'first', sources: [...entry.sources] };
  }

  /**
   * Undo a `first` claim whose delivery failed, so a later copy from another
   * source can still reach the recipient. Does nothing once a second source
   * has joined: that source's delivery owns the entry now. This is not a
   * retry; nothing is sent until a real second copy arrives.
   */
  release(recipient: string, key: string, sourceId: string): void {
    const mapKey = NotificationDedupStore.entryKey(recipient, key);
    const existing = this.entries.get(mapKey);
    if (existing && existing.sources.length === 1 && existing.sources[0].sourceId === sourceId) {
      this.entries.delete(mapKey);
    }
  }

  /**
   * Drop the entry outright, whatever sources joined it. Used when a HELD
   * message (Apprise / desktop) that collected several sources fails to send:
   * nothing reached the recipient, so the next copy must be free to try. Not
   * a retry; nothing is sent until a real copy arrives.
   */
  forget(recipient: string, key: string): void {
    this.entries.delete(NotificationDedupStore.entryKey(recipient, key));
  }

  /** Drop expired entries from the front; stops at the first live one. */
  private prune(now: number): void {
    for (const [mapKey, entry] of this.entries) {
      if (now - entry.firstAt < this.windowMs) break;
      this.entries.delete(mapKey);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The one store every delivery channel shares, so they agree on what is a duplicate. */
export const notificationDedup = new NotificationDedupStore();

/**
 * Dedup key for a mesh packet: (fromNodeNum, packetId, portnum), as #5729
 * asks. The port is part of the key so a node's position, nodeinfo and text
 * sent close together stay separate events.
 *
 * Returns null when there is no usable packet id (0 or missing): such a copy
 * is never deduped, because nothing ties it to another source's copy.
 */
export function packetDedupKey(
  fromNodeNum: number | null | undefined,
  packetId: number | null | undefined,
  portnum: number | null | undefined,
): string | null {
  // Missing first: `Number(null)` is 0, which would pass the finite test.
  if (fromNodeNum == null || packetId == null || portnum == null) return null;
  const from = Number(fromNodeNum);
  const id = Number(packetId);
  const port = Number(portnum);
  if (!Number.isFinite(from) || !Number.isFinite(id) || !Number.isFinite(port)) return null;
  // A packet id of 0 means "none". Port 0 is a real port (UNKNOWN_APP).
  if (id === 0) return null;
  return `packet:${from >>> 0}:${id >>> 0}:${port}`;
}

/** "A", "A, B" — the source list as a notification shows it. */
export function joinSourceNames(sources: DedupSource[]): string {
  return sources.map(s => s.sourceName).join(', ');
}

/**
 * Web Push `tag` for a deduped event. Every copy of one event carries the
 * same tag, so the browser replaces the shown notification instead of
 * stacking a second one.
 */
export function dedupTag(key: string): string {
  return `mm-${key}`;
}

/**
 * How long Apprise and the desktop app wait after the FIRST copy of an event
 * before sending, to collect every source that heard it (#5729, decision 2).
 * Neither can change a message once sent, so they send one message that
 * lists every source instead of naming only the first.
 */
export const NOTIFICATION_COLLECT_HOLD_MS = 5_000;

/** Sends a held notification. `sources` is in arrival order. True = delivered. */
export type HoldFlush = (sources: DedupSource[]) => Promise<boolean>;

interface HoldEntry {
  recipient: string;
  key: string;
  sources: DedupSource[];
  flush: HoldFlush;
  timer: ReturnType<typeof setTimeout>;
  /** Whatever the caller needs to decide whether a later copy may join. */
  meta?: unknown;
}

/**
 * Collect-then-send for channels that cannot update a sent message (#5729).
 *
 * The first copy of an event (a `first` dedup claim) starts a hold with a
 * FIXED deadline: `holdMs` after that copy. Later copies inside the hold only
 * add their source; they never move the deadline, so a stream of copies
 * cannot delay the message, and nothing here can send more than once per
 * hold. After the deadline the one message goes out and the hold is gone; a
 * copy that arrives later still meets the dedup entry and is dropped.
 *
 * Nothing reads settings, so a settings save cannot reset or re-arm a hold. A
 * restart drops pending holds; `flushAll` (called on graceful shutdown) sends
 * them first, so a clean restart loses nothing. The hold lives in memory like
 * the dedup window it extends, so a crash can lose at most the events of the
 * last 5 seconds, and it can never cause a second send.
 */
export class NotificationHoldStore {
  private readonly holds = new Map<string, HoldEntry>();

  constructor(
    private readonly holdMs: number = NOTIFICATION_COLLECT_HOLD_MS,
    private readonly onFailed: (recipient: string, key: string) => void =
      (recipient, key) => notificationDedup.forget(recipient, key),
  ) {}

  private static mapKey(recipient: string, key: string): string {
    return `${recipient}\n${key}`;
  }

  /**
   * Start a hold for a `first` claim. A second `start` for the same
   * (recipient, key) while one is live only joins it: it can never arm a
   * second timer.
   */
  start(recipient: string, key: string, source: DedupSource, flush: HoldFlush, meta?: unknown): void {
    const mapKey = NotificationHoldStore.mapKey(recipient, key);
    if (this.holds.has(mapKey)) {
      this.join(recipient, key, source);
      return;
    }
    const entry: HoldEntry = {
      recipient,
      key,
      sources: [{ ...source }],
      flush,
      meta,
      timer: setTimeout(() => { void this.fire(mapKey); }, this.holdMs),
    };
    // A pending hold must not keep a shutting-down process alive.
    entry.timer.unref?.();
    this.holds.set(mapKey, entry);
  }

  /**
   * Add a source to a live hold. False when no hold is live (it has already
   * been sent, or there never was one): the caller then drops the copy.
   */
  join(recipient: string, key: string, source: DedupSource): boolean {
    const entry = this.holds.get(NotificationHoldStore.mapKey(recipient, key));
    if (!entry) return false;
    if (!entry.sources.some(s => s.sourceId === source.sourceId)) {
      entry.sources.push({ ...source });
    }
    return true;
  }

  /** The caller's `meta` for a live hold, or undefined. */
  getMeta(recipient: string, key: string): unknown {
    return this.holds.get(NotificationHoldStore.mapKey(recipient, key))?.meta;
  }

  isHeld(recipient: string, key: string): boolean {
    return this.holds.has(NotificationHoldStore.mapKey(recipient, key));
  }

  private async fire(mapKey: string): Promise<void> {
    const entry = this.holds.get(mapKey);
    if (!entry) return;
    // Remove BEFORE sending: a copy arriving during the send is dropped by the
    // dedup entry, never added to a message already on its way.
    this.holds.delete(mapKey);
    clearTimeout(entry.timer);
    const delivered = await entry.flush([...entry.sources]).catch(() => false);
    if (!delivered) {
      // Same as an immediate send that failed: a later copy may still reach
      // the recipient. Not a retry; nothing is sent until a real copy arrives.
      this.onFailed(entry.recipient, entry.key);
    }
  }

  /** Send every pending hold now (graceful shutdown). */
  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.holds.keys()].map(k => this.fire(k)));
  }

  /** Drop every pending hold WITHOUT sending (tests only). */
  clear(): void {
    for (const entry of this.holds.values()) clearTimeout(entry.timer);
    this.holds.clear();
  }

  get size(): number {
    return this.holds.size;
  }
}

/** Shared by Apprise and the desktop app; recipients never collide (`apprise:` / `desktop`). */
export const notificationHold = new NotificationHoldStore();
