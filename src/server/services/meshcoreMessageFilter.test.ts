/**
 * MeshCore Ignore / Block classifier (#5408): matching rules, precedence,
 * read-time annotation and the hit-count flush.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import databaseService from '../../services/database.js';
import {
  MeshCoreMessageFilterService,
  wildcardToRegexSource,
  validateFilterPattern,
  compileRuleMatcher,
  MAX_FILTER_PATTERN_LENGTH,
} from './meshcoreMessageFilter.js';
import type { MeshCoreIgnoredNodeRow, MeshCoreMessageFilterRow } from '../../db/repositories/index.js';

const SRC = 'src-a';
const KEY = 'ab12cd34ef56'.padEnd(64, '0');
const OTHER = 'ff'.repeat(32);

function node(over: Partial<MeshCoreIgnoredNodeRow> = {}): MeshCoreIgnoredNodeRow {
  return {
    sourceId: SRC, publicKey: KEY, name: 'Spammer', mode: 'ignore',
    createdAt: 1, createdBy: null, hitCount: 0, lastHitAt: null, ...over,
  };
}

let ruleSeq = 0;
function rule(over: Partial<MeshCoreMessageFilterRow> = {}): MeshCoreMessageFilterRow {
  ruleSeq += 1;
  return {
    id: `r${ruleSeq}`, sourceId: SRC, mode: 'ignore', matchType: 'exact', pattern: 'x',
    caseSensitive: false, fields: 'both', enabled: true, createdAt: 1, createdBy: null,
    hitCount: 0, lastHitAt: null, ...over,
  };
}

describe('pattern helpers', () => {
  it('wildcard: * any run, ? one char, everything else literal, anchored', () => {
    const m = compileRuleMatcher({ matchType: 'wildcard', pattern: 'buy*now?', caseSensitive: false });
    expect(m('buy cheap stuff now!')).toBe(true);
    expect(m('BUY NOW!')).toBe(true);
    expect(m('please buy now!')).toBe(false); // anchored start
    expect(m('buy now')).toBe(false); // ? needs exactly one char
    const lit = compileRuleMatcher({ matchType: 'wildcard', pattern: 'a.b(c)[d]+', caseSensitive: true });
    expect(lit('a.b(c)[d]+')).toBe(true);
    expect(lit('axb(c)[d]+')).toBe(false);
    expect(wildcardToRegexSource('a*')).toBe('^a[\\s\\S]*$');
  });

  it('wildcard * spans newlines', () => {
    const m = compileRuleMatcher({ matchType: 'wildcard', pattern: 'a*b', caseSensitive: true });
    expect(m('a\n\nb')).toBe(true);
  });

  it('exact is whole-field equality; case follows caseSensitive', () => {
    const ci = compileRuleMatcher({ matchType: 'exact', pattern: 'Hello', caseSensitive: false });
    expect(ci('hello')).toBe(true);
    expect(ci('hello there')).toBe(false);
    const cs = compileRuleMatcher({ matchType: 'exact', pattern: 'Hello', caseSensitive: true });
    expect(cs('hello')).toBe(false);
    expect(cs('Hello')).toBe(true);
  });

  it('regex is unanchored and honours case', () => {
    const ci = compileRuleMatcher({ matchType: 'regex', pattern: 'b[0-9]+t', caseSensitive: false });
    expect(ci('I am a B12T')).toBe(true);
    const cs = compileRuleMatcher({ matchType: 'regex', pattern: 'b[0-9]+t', caseSensitive: true });
    expect(cs('I am a B12T')).toBe(false);
  });

  it('validateFilterPattern rejects empty, over-long, and RE2-refused patterns', () => {
    expect(validateFilterPattern('exact', '')).toMatch(/empty/);
    expect(validateFilterPattern('wildcard', 'x'.repeat(MAX_FILTER_PATTERN_LENGTH + 1))).toMatch(/at most/);
    expect(validateFilterPattern('regex', '(?=lookahead)')).toMatch(/Invalid regular expression/);
    expect(validateFilterPattern('regex', '(a)\\1')).toMatch(/Invalid regular expression/);
    expect(validateFilterPattern('regex', '[unclosed')).toMatch(/Invalid regular expression/);
    expect(validateFilterPattern('regex', '^ok$')).toBeNull();
    // Wildcard patterns are always literal — no regex errors possible.
    expect(validateFilterPattern('wildcard', '(?=x')).toBeNull();
  });
});

describe('MeshCoreMessageFilterService.classify', () => {
  let svc: MeshCoreMessageFilterService;

  beforeEach(() => {
    svc = new MeshCoreMessageFilterService();
  });

  afterEach(() => {
    svc.resetForTests();
  });

  it('allows everything when the source has no entries', () => {
    svc.setState(SRC, [], []);
    expect(svc.classify(SRC, { fromPublicKey: KEY, text: 'hi', kind: 'dm' }).action).toBe('allow');
  });

  it('matches a DM by full key and by the 6-byte prefix', () => {
    svc.setState(SRC, [node({ mode: 'block' })], []);
    expect(svc.classify(SRC, { fromPublicKey: KEY, text: 'hi', kind: 'dm' })).toEqual({ action: 'block', entryKind: 'node', entryId: KEY });
    expect(svc.classify(SRC, { fromPublicKey: KEY.slice(0, 12).toUpperCase(), text: 'hi', kind: 'dm' }).action).toBe('block');
    // Shorter than 6 bytes never prefix-matches.
    expect(svc.classify(SRC, { fromPublicKey: KEY.slice(0, 8), text: 'hi', kind: 'dm' }).action).toBe('allow');
    expect(svc.classify(SRC, { fromPublicKey: OTHER, text: 'hi', kind: 'dm' }).action).toBe('allow');
  });

  it('matches a room post by its author key', () => {
    svc.setState(SRC, [node()], []);
    expect(svc.classify(SRC, { fromPublicKey: KEY, fromName: 'whoever', text: 'post', kind: 'room' }).action).toBe('ignore');
  });

  it('matches a channel message by advert name, case-insensitive and trimmed', () => {
    svc.setState(SRC, [node({ name: '  Spammer ' })], []);
    expect(svc.classify(SRC, { fromPublicKey: null, fromName: 'SPAMMER', text: 'hi', kind: 'channel' }).action).toBe('ignore');
    expect(svc.classify(SRC, { fromPublicKey: null, fromName: 'Spammer2', text: 'hi', kind: 'channel' }).action).toBe('allow');
    // A DM with the same NAME but another key does not match: keys win for DMs.
    expect(svc.classify(SRC, { fromPublicKey: OTHER, fromName: 'Spammer', text: 'hi', kind: 'dm' }).action).toBe('allow');
  });

  it('text rules check only the selected field(s)', () => {
    svc.setState(SRC, [], [rule({ matchType: 'exact', pattern: 'Bob', fields: 'name' })]);
    expect(svc.classify(SRC, { fromName: 'bob', text: 'hello', kind: 'channel' }).action).toBe('ignore');
    expect(svc.classify(SRC, { fromName: 'alice', text: 'Bob', kind: 'channel' }).action).toBe('allow');

    svc.setState(SRC, [], [rule({ matchType: 'exact', pattern: 'Bob', fields: 'body' })]);
    expect(svc.classify(SRC, { fromName: 'Bob', text: 'hello', kind: 'channel' }).action).toBe('allow');
    expect(svc.classify(SRC, { fromName: 'alice', text: 'bob', kind: 'channel' }).action).toBe('ignore');

    svc.setState(SRC, [], [rule({ matchType: 'exact', pattern: 'Bob', fields: 'both' })]);
    expect(svc.classify(SRC, { fromName: 'Bob', text: 'x', kind: 'channel' }).action).toBe('ignore');
    expect(svc.classify(SRC, { fromName: 'x', text: 'Bob', kind: 'dm' }).action).toBe('ignore');
  });

  it('skips disabled rules', () => {
    svc.setState(SRC, [], [rule({ pattern: 'x', enabled: false })]);
    expect(svc.classify(SRC, { text: 'x', kind: 'channel' }).action).toBe('allow');
  });

  it('block beats ignore across node entries and rules', () => {
    const blockRule = rule({ mode: 'block', matchType: 'wildcard', pattern: '*spam*', fields: 'body' });
    svc.setState(SRC, [node({ mode: 'ignore' })], [blockRule]);
    expect(svc.classify(SRC, { fromPublicKey: KEY, text: 'buy spam', kind: 'dm' }))
      .toEqual({ action: 'block', entryKind: 'rule', entryId: blockRule.id });
    expect(svc.classify(SRC, { fromPublicKey: KEY, text: 'clean', kind: 'dm' }).action).toBe('ignore');
  });

  it('is scoped per source', () => {
    svc.setState(SRC, [node({ mode: 'block' })], []);
    svc.setState('src-b', [], []);
    expect(svc.classify('src-b', { fromPublicKey: KEY, text: 'hi', kind: 'dm' }).action).toBe('allow');
  });

  it('a source that is not loaded yet allows and starts a load', () => {
    const spy = vi.spyOn(svc, 'loadSource').mockResolvedValue();
    expect(svc.classify('never-loaded', { fromPublicKey: KEY, text: 'hi', kind: 'dm' }).action).toBe('allow');
    expect(spy).toHaveBeenCalledWith('never-loaded');
  });

  it('noteAdvertName keeps channel matching on the node’s new name', () => {
    const upd = vi.spyOn(databaseService, 'updateMeshCoreIgnoredNodeNameAsync').mockResolvedValue();
    svc.setState(SRC, [node({ name: 'OldName' })], []);
    svc.noteAdvertName(SRC, KEY.toUpperCase(), 'NewName');
    expect(svc.classify(SRC, { fromName: 'newname', text: 'x', kind: 'channel' }).action).toBe('ignore');
    expect(svc.classify(SRC, { fromName: 'oldname', text: 'x', kind: 'channel' }).action).toBe('allow');
    expect(upd).toHaveBeenCalledWith(SRC, KEY, 'NewName');
    upd.mockRestore();
  });
});

describe('MeshCoreMessageFilterService.annotate', () => {
  it('flags matching messages from the current lists, skips own messages, strips stale flags, and does not count hits', async () => {
    const svc = new MeshCoreMessageFilterService();
    svc.setState(SRC, [node({ mode: 'ignore' })], [rule({ matchType: 'wildcard', pattern: 'secret*', fields: 'body', mode: 'block' })]);
    const self = 'ee'.repeat(32);
    const msgs = [
      { fromPublicKey: KEY.slice(0, 12), text: 'hi', messageType: 'text' },
      { fromPublicKey: 'channel-0', fromName: 'Spammer', text: 'hi' },
      { fromPublicKey: 'channel-0', fromName: 'Alice', text: 'secret sauce' },
      { fromPublicKey: self, text: 'secret mine' },
      { fromPublicKey: OTHER, text: 'fine', filtered: 'ignore' as const },
    ];
    const out = svc.annotate(SRC, msgs, self);
    expect(out.map((m) => m.filtered)).toEqual(['ignore', 'ignore', 'block', undefined, undefined]);
    expect(msgs[0]).not.toHaveProperty('filtered'); // input untouched

    const flush = vi.spyOn(databaseService, 'addMeshCoreIgnoredNodeHitsAsync').mockResolvedValue();
    const flushRule = vi.spyOn(databaseService, 'addMeshCoreMessageFilterHitsAsync').mockResolvedValue();
    await svc.flushAsync();
    expect(flush).not.toHaveBeenCalled();
    expect(flushRule).not.toHaveBeenCalled();
    flush.mockRestore();
    flushRule.mockRestore();
  });
});

describe('hit counters', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('batches hits in memory and flushes at most every 30 s', async () => {
    vi.useFakeTimers();
    const nodeHits = vi.spyOn(databaseService, 'addMeshCoreIgnoredNodeHitsAsync').mockResolvedValue();
    const ruleHits = vi.spyOn(databaseService, 'addMeshCoreMessageFilterHitsAsync').mockResolvedValue();
    const svc = new MeshCoreMessageFilterService();
    const r = rule({ pattern: 'x', fields: 'body' });
    svc.setState(SRC, [node()], [r]);
    svc.classify(SRC, { fromPublicKey: KEY, text: 'hello', kind: 'dm' });
    svc.classify(SRC, { fromPublicKey: KEY, text: 'hello', kind: 'dm' });
    svc.classify(SRC, { fromPublicKey: OTHER, text: 'x', kind: 'dm' });
    expect(nodeHits).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(nodeHits).toHaveBeenCalledTimes(1);
    expect(nodeHits).toHaveBeenCalledWith(SRC, KEY, 2, expect.any(Number));
    expect(ruleHits).toHaveBeenCalledWith(SRC, r.id, 1, expect.any(Number));
    svc.resetForTests();
  });

  it('countHit: false leaves the counters alone', async () => {
    const nodeHits = vi.spyOn(databaseService, 'addMeshCoreIgnoredNodeHitsAsync').mockResolvedValue();
    const svc = new MeshCoreMessageFilterService();
    svc.setState(SRC, [node()], []);
    const res = svc.classify(SRC, { fromPublicKey: KEY, text: 'x', kind: 'dm' }, { countHit: false });
    expect(res.action).toBe('ignore');
    await svc.flushAsync();
    expect(nodeHits).not.toHaveBeenCalled();
    svc.countHit(SRC, res);
    await svc.flushAsync();
    expect(nodeHits).toHaveBeenCalledWith(SRC, KEY, 1, expect.any(Number));
    svc.resetForTests();
  });
});
