/**
 * MeshCore client-side Ignore / Block (#5408, MESHCORE_IGNORE_BLOCK_SPEC.md).
 *
 * MeshCore firmware has no block or mute, so the policy lives here. One module
 * owns matching for every path that needs it:
 *
 * - ingest (`meshcoreManager.handleBridgeEvent`, `meshcoreMqttManager`) calls
 *   {@link MeshCoreMessageFilterService.classify} before storing a message:
 *   `block` drops it, `ignore` stores it but fires nothing;
 * - read routes call {@link MeshCoreMessageFilterService.annotate} so the
 *   ignored state is computed from the CURRENT lists, never stored on the row.
 *
 * Lists are cached per source and rebuilt after every write. Classification is
 * synchronous (the ingest handler is), so a source's lists must be loaded
 * before its messages arrive — managers call {@link loadSource} on connect. A
 * source that is not loaded yet classifies as `allow` and starts a load.
 *
 * Hit counts are kept in memory and flushed to the DB at most every 30 s and
 * on shutdown. Losing a few counts on a crash is acceptable (spec).
 *
 * Mesh impact: sends nothing. The only timer is the hit-count flush, which
 * touches the DB only; saving a list never re-arms anything that transmits.
 */
import databaseService from '../../services/database.js';
import { compileUserRegex } from '../../utils/safeRegex.js';
import { logger } from '../../utils/logger.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import type {
  MeshCoreIgnoredNodeRow,
  MeshCoreMessageFilterRow,
  MeshCoreMessageFilterInput,
  MeshCoreFilterMode,
  MeshCoreFilterMatchType,
  MeshCoreFilterFields,
} from '../../db/repositories/index.js';

export const MAX_FILTER_PATTERN_LENGTH = 256;
export const HIT_FLUSH_INTERVAL_MS = 30_000;
/** A DM carries a 6-byte (12 hex) sender prefix; shorter keys never prefix-match. */
const MIN_PREFIX_HEX = 12;

export type MeshCoreFilterAction = 'allow' | 'ignore' | 'block';
export type MeshCoreMessageKind = 'dm' | 'channel' | 'room';

export interface MeshCoreClassifyInput {
  /** Full key, a DM's 12-hex prefix, or `channel-<idx>` for a channel message. */
  fromPublicKey?: string | null;
  /** Advert name (DM / room) or the name parsed from `"Name: body"` (channel). */
  fromName?: string | null;
  text?: string | null;
  kind: MeshCoreMessageKind;
}

export interface MeshCoreClassifyResult {
  action: MeshCoreFilterAction;
  entryKind: 'node' | 'rule' | null;
  /** publicKey for a node entry, rule id for a rule. */
  entryId: string | null;
}

const ALLOW: MeshCoreClassifyResult = { action: 'allow', entryKind: null, entryId: null };

// ============ Pure matching helpers ============

/** Escape every RE2/RegExp metacharacter so the string matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a wildcard pattern to an anchored regex source: `*` = any run,
 * `?` = exactly one character, everything else literal.
 */
export function wildcardToRegexSource(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '[\\s\\S]*';
    else if (ch === '?') out += '[\\s\\S]';
    else out += escapeRegex(ch);
  }
  return `^${out}$`;
}

/**
 * Validate a rule pattern. Returns an error message, or null when the pattern
 * is usable. Regex patterns are compiled with RE2 so anything RE2 refuses
 * (lookaround, backreferences, bad syntax) is rejected at save time.
 */
export function validateFilterPattern(matchType: MeshCoreFilterMatchType, pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'Pattern must not be empty';
  if (pattern.length > MAX_FILTER_PATTERN_LENGTH) {
    return `Pattern must be at most ${MAX_FILTER_PATTERN_LENGTH} characters`;
  }
  if (matchType === 'regex') {
    try {
      compileUserRegex(pattern);
    } catch (err) {
      return `Invalid regular expression: ${(err as Error).message}`;
    }
  }
  return null;
}

type Matcher = (value: string) => boolean;

/** Compile a rule to a matcher once. Throws when the pattern cannot compile. */
export function compileRuleMatcher(rule: Pick<MeshCoreMessageFilterRow, 'matchType' | 'pattern' | 'caseSensitive'>): Matcher {
  const flags = rule.caseSensitive ? '' : 'i';
  if (rule.matchType === 'exact') {
    if (rule.caseSensitive) return (v) => v === rule.pattern;
    const needle = rule.pattern.toLowerCase();
    return (v) => v.toLowerCase() === needle;
  }
  const source = rule.matchType === 'wildcard' ? wildcardToRegexSource(rule.pattern) : rule.pattern;
  const re = compileUserRegex(source, flags);
  return (v) => {
    re.lastIndex = 0;
    return re.test(v);
  };
}

function normName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

interface CompiledRule {
  row: MeshCoreMessageFilterRow;
  matcher: Matcher;
}

interface SourceState {
  nodes: Map<string, MeshCoreIgnoredNodeRow>;
  /** normalized advert name -> publicKeys with that name */
  names: Map<string, string[]>;
  rules: CompiledRule[];
}

interface PendingHit {
  sourceId: string;
  entryKind: 'node' | 'rule';
  entryId: string;
  count: number;
  lastHitAt: number;
}

/** A message that can carry the read-time annotation. */
export interface FilterableMeshCoreMessage {
  fromPublicKey: string;
  fromName?: string | null;
  text: string;
  messageType?: string | null;
  filtered?: 'ignore' | 'block';
}

export function kindOfMessage(m: { fromPublicKey: string; messageType?: string | null }): MeshCoreMessageKind {
  if (m.messageType === 'room_post') return 'room';
  if ((m.fromPublicKey ?? '').startsWith('channel-')) return 'channel';
  return 'dm';
}

export class MeshCoreMessageFilterService {
  private states = new Map<string, SourceState>();
  private loading = new Map<string, Promise<void>>();
  /** Last failed load per source, so a broken DB is retried at most every 30 s, not per message. */
  private loadFailedAt = new Map<string, number>();
  private pending = new Map<string, PendingHit>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- cache ----------

  isLoaded(sourceId: string): boolean {
    return this.states.has(sourceId);
  }

  /** Load (or reload) a source's lists from the DB and rebuild its cache. */
  loadSource(sourceId: string): Promise<void> {
    const inflight = this.loading.get(sourceId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const [nodes, rules] = await Promise.all([
          databaseService.getMeshCoreIgnoredNodesAsync(sourceId),
          databaseService.getMeshCoreMessageFiltersAsync(sourceId),
        ]);
        this.setState(sourceId, nodes, rules);
        this.loadFailedAt.delete(sourceId);
      } catch (err) {
        this.loadFailedAt.set(sourceId, Date.now());
        logger.warn(`[MeshCoreFilter:${sourceId}] could not load ignore/block lists: ${(err as Error).message}`);
      } finally {
        this.loading.delete(sourceId);
      }
    })();
    this.loading.set(sourceId, p);
    return p;
  }

  private loadInBackground(sourceId: string): void {
    const failedAt = this.loadFailedAt.get(sourceId);
    if (failedAt !== undefined && Date.now() - failedAt < HIT_FLUSH_INTERVAL_MS) return;
    void this.loadSource(sourceId);
  }

  /** Replace a source's cache. Exposed for tests; production goes through loadSource. */
  setState(sourceId: string, nodes: MeshCoreIgnoredNodeRow[], rules: MeshCoreMessageFilterRow[]): void {
    const nodeMap = new Map<string, MeshCoreIgnoredNodeRow>();
    const names = new Map<string, string[]>();
    for (const n of nodes) {
      const key = n.publicKey.toLowerCase();
      nodeMap.set(key, n);
      const nn = normName(n.name);
      if (nn) names.set(nn, [...(names.get(nn) ?? []), key]);
    }
    const compiled: CompiledRule[] = [];
    for (const row of rules) {
      if (!row.enabled) continue;
      try {
        compiled.push({ row, matcher: compileRuleMatcher(row) });
      } catch (err) {
        logger.warn(`[MeshCoreFilter:${sourceId}] skipping rule ${row.id}: ${(err as Error).message}`);
      }
    }
    this.states.set(sourceId, { nodes: nodeMap, names, rules: compiled });
  }

  /** Drop every cached source (tests). Pending hits are discarded too. */
  resetForTests(): void {
    this.states.clear();
    this.loading.clear();
    this.loadFailedAt.clear();
    this.pending.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // ---------- matching ----------

  private matchNode(state: SourceState, input: MeshCoreClassifyInput): MeshCoreIgnoredNodeRow[] {
    if (input.kind === 'channel') {
      const nn = normName(input.fromName);
      if (!nn) return [];
      return (state.names.get(nn) ?? [])
        .map((k) => state.nodes.get(k))
        .filter((n): n is MeshCoreIgnoredNodeRow => !!n);
    }
    const key = (input.fromPublicKey ?? '').toLowerCase();
    if (!key || key.startsWith('channel-')) return [];
    const exact = state.nodes.get(key);
    if (exact) return [exact];
    if (key.length < MIN_PREFIX_HEX) return [];
    const hits: MeshCoreIgnoredNodeRow[] = [];
    for (const [k, n] of state.nodes) {
      if (k.startsWith(key)) hits.push(n);
    }
    return hits;
  }

  private matchRules(state: SourceState, input: MeshCoreClassifyInput): CompiledRule[] {
    const name = input.fromName ?? '';
    const body = input.text ?? '';
    return state.rules.filter(({ row, matcher }) => {
      if ((row.fields === 'name' || row.fields === 'both') && name && matcher(name)) return true;
      if ((row.fields === 'body' || row.fields === 'both') && body && matcher(body)) return true;
      return false;
    });
  }

  /**
   * Decide what to do with a message. Block beats ignore. With `countHit`
   * (the default) the winning entry's counter moves; read-time annotation
   * passes `countHit: false` so browsing never inflates the counters.
   */
  classify(
    sourceId: string,
    input: MeshCoreClassifyInput,
    opts: { countHit?: boolean } = {},
  ): MeshCoreClassifyResult {
    const state = this.states.get(sourceId);
    if (!state) {
      this.loadInBackground(sourceId);
      return ALLOW;
    }
    if (state.nodes.size === 0 && state.rules.length === 0) return ALLOW;

    const candidates: Array<{ mode: MeshCoreFilterMode; entryKind: 'node' | 'rule'; entryId: string }> = [];
    for (const n of this.matchNode(state, input)) {
      candidates.push({ mode: n.mode, entryKind: 'node', entryId: n.publicKey });
    }
    for (const r of this.matchRules(state, input)) {
      candidates.push({ mode: r.row.mode, entryKind: 'rule', entryId: r.row.id });
    }
    if (candidates.length === 0) return ALLOW;

    const winner = candidates.find((c) => c.mode === 'block') ?? candidates[0];
    if (opts.countHit !== false) this.recordHit(sourceId, winner.entryKind, winner.entryId);
    return { action: winner.mode, entryKind: winner.entryKind, entryId: winner.entryId };
  }

  /**
   * Stamp `filtered` on each message that currently matches an entry. Our own
   * outgoing messages are never filtered. Returns new objects; the input is
   * not mutated. Hit counters do not move.
   */
  annotate<T extends FilterableMeshCoreMessage>(sourceId: string, messages: T[], selfPublicKey?: string | null): T[] {
    const state = this.states.get(sourceId);
    if (!state) {
      this.loadInBackground(sourceId);
      return messages;
    }
    if (state.nodes.size === 0 && state.rules.length === 0) return messages;
    const self = selfPublicKey?.toLowerCase() || null;
    return messages.map((m) => {
      if (self && m.fromPublicKey?.toLowerCase() === self) return m;
      const res = this.classify(
        sourceId,
        { fromPublicKey: m.fromPublicKey, fromName: m.fromName, text: m.text, kind: kindOfMessage(m) },
        { countHit: false },
      );
      if (res.action !== 'allow') return { ...m, filtered: res.action };
      return m.filtered ? { ...m, filtered: undefined } : m;
    });
  }

  /** True when this source has at least one node entry or enabled rule. */
  hasEntries(sourceId: string): boolean {
    const state = this.states.get(sourceId);
    return !!state && (state.nodes.size > 0 || state.rules.length > 0);
  }

  /** Public keys with an entry (either mode) on this source, lowercase. */
  hiddenPublicKeys(sourceId: string): Set<string> {
    return new Set(this.states.get(sourceId)?.nodes.keys() ?? []);
  }

  /**
   * An advert arrived. When the node has an entry, keep its name snapshot
   * current so channel messages under the new name still match.
   */
  noteAdvertName(sourceId: string, publicKey: string, name: string | null | undefined): void {
    const state = this.states.get(sourceId);
    const trimmed = (name ?? '').trim();
    if (!state || !trimmed || !publicKey) return;
    const key = publicKey.toLowerCase();
    const entry = state.nodes.get(key);
    if (!entry || entry.name === trimmed) return;
    const oldName = normName(entry.name);
    entry.name = trimmed;
    if (oldName) {
      const rest = (state.names.get(oldName) ?? []).filter((k) => k !== key);
      if (rest.length > 0) state.names.set(oldName, rest);
      else state.names.delete(oldName);
    }
    const nn = normName(trimmed);
    state.names.set(nn, [...(state.names.get(nn) ?? []).filter((k) => k !== key), key]);
    databaseService.updateMeshCoreIgnoredNodeNameAsync(sourceId, entry.publicKey, trimmed).catch((err) => {
      logger.warn(`[MeshCoreFilter:${sourceId}] could not refresh name for ${key.slice(0, 12)}: ${(err as Error).message}`);
    });
  }

  // ---------- hit counters ----------

  /** Count a hit for a result obtained with `countHit: false` (deduplicating callers). */
  countHit(sourceId: string, result: MeshCoreClassifyResult): void {
    if (result.action === 'allow' || !result.entryKind || !result.entryId) return;
    this.recordHit(sourceId, result.entryKind, result.entryId);
  }

  private recordHit(sourceId: string, entryKind: 'node' | 'rule', entryId: string): void {
    const k = `${sourceId}\u0000${entryKind}\u0000${entryId}`;
    const now = Date.now();
    const prev = this.pending.get(k);
    if (prev) {
      prev.count += 1;
      prev.lastHitAt = now;
    } else {
      this.pending.set(k, { sourceId, entryKind, entryId, count: 1, lastHitAt: now });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushAsync();
      }, HIT_FLUSH_INTERVAL_MS);
      // Never hold the process open for a counter write.
      this.flushTimer.unref?.();
    }
  }

  /** Write every pending hit to the DB. Safe to call at any time. */
  async flushAsync(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const hit of batch) {
      try {
        if (hit.entryKind === 'node') {
          await databaseService.addMeshCoreIgnoredNodeHitsAsync(hit.sourceId, hit.entryId, hit.count, hit.lastHitAt);
        } else {
          await databaseService.addMeshCoreMessageFilterHitsAsync(hit.sourceId, hit.entryId, hit.count, hit.lastHitAt);
        }
      } catch (err) {
        logger.debug(`[MeshCoreFilter:${hit.sourceId}] hit flush failed: ${(err as Error).message}`);
      }
    }
  }

  // ---------- writes (routes go through these so the cache never drifts) ----------

  private async afterWrite(sourceId: string): Promise<void> {
    // Persist counts first so a list read right after a write shows them.
    await this.flushAsync();
    await this.loadSource(sourceId);
    dataEventEmitter.emitMeshCoreFiltersChanged(sourceId);
  }

  async listIgnoredNodes(sourceId: string): Promise<MeshCoreIgnoredNodeRow[]> {
    await this.flushAsync();
    return databaseService.getMeshCoreIgnoredNodesAsync(sourceId);
  }

  async setIgnoredNode(entry: {
    sourceId: string;
    publicKey: string;
    name: string | null;
    mode: MeshCoreFilterMode;
    createdBy: number | null;
  }): Promise<MeshCoreIgnoredNodeRow> {
    const row = await databaseService.upsertMeshCoreIgnoredNodeAsync({ ...entry, publicKey: entry.publicKey.toLowerCase() });
    await this.afterWrite(entry.sourceId);
    return row;
  }

  async removeIgnoredNode(sourceId: string, publicKey: string): Promise<boolean> {
    const n = await databaseService.removeMeshCoreIgnoredNodeAsync(sourceId, publicKey.toLowerCase());
    await this.afterWrite(sourceId);
    return n > 0;
  }

  async listRules(sourceId: string): Promise<MeshCoreMessageFilterRow[]> {
    await this.flushAsync();
    return databaseService.getMeshCoreMessageFiltersAsync(sourceId);
  }

  async createRule(sourceId: string, input: MeshCoreMessageFilterInput, createdBy: number | null): Promise<MeshCoreMessageFilterRow> {
    const row = await databaseService.createMeshCoreMessageFilterAsync(sourceId, input, createdBy);
    await this.afterWrite(sourceId);
    return row;
  }

  async updateRule(
    sourceId: string,
    id: string,
    patch: Partial<MeshCoreMessageFilterInput>,
  ): Promise<MeshCoreMessageFilterRow | null> {
    const row = await databaseService.updateMeshCoreMessageFilterAsync(sourceId, id, patch);
    if (row) await this.afterWrite(sourceId);
    return row;
  }

  async deleteRule(sourceId: string, id: string): Promise<boolean> {
    const n = await databaseService.deleteMeshCoreMessageFilterAsync(sourceId, id);
    if (n > 0) await this.afterWrite(sourceId);
    return n > 0;
  }
}

export type { MeshCoreFilterMode, MeshCoreFilterMatchType, MeshCoreFilterFields };

export const meshcoreMessageFilter = new MeshCoreMessageFilterService();
