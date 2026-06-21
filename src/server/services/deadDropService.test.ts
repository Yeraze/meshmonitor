/**
 * DeadDropService tests — the mailbox command brain, exercised against a real
 * (in-memory SQLite) repository.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { DeadDropRepository } from '../../db/repositories/deadDrop.js';
import { DeadDropService, MAX_PENDING_PER_RECIPIENT, MAX_PENDING_PER_SENDER } from './deadDropService.js';
import type { DeadDropContext, DeadDropResult } from './deadDropService.js';
import { createTestDb } from '../test-helpers/testDb.js';

const SOURCE = 'source-a';
const NOW = 2_000_000_000_000;

// A sender DMing a command. Defaults to "ZNOF" sending.
function ctx(overrides: Partial<DeadDropContext> = {}): DeadDropContext {
  return {
    sourceId: SOURCE,
    text: '',
    isDirect: true,
    senderNodeNum: 111,
    senderShortName: 'ZNOF',
    senderLongName: 'ZN Office',
    ...overrides,
  };
}

// WISP retrieving their inbox (node 555 -> !0000022b).
function wisp(text: string): DeadDropContext {
  return ctx({ text, senderNodeNum: 555, senderShortName: 'WISP', senderLongName: 'WISP Node' });
}

describe('DeadDropService', () => {
  let db: Database.Database;
  let repo: DeadDropRepository;
  let svc: DeadDropService;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    repo = new DeadDropRepository(t.db, 'sqlite');
    svc = new DeadDropService(() => repo);
  });

  afterEach(() => db.close());

  async function store(text: string, from: Partial<DeadDropContext> = {}, at = NOW): Promise<string[]> {
    return (await svc.handleCommand(ctx({ text, ...from }), at)).responses;
  }
  async function run(c: DeadDropContext, at = NOW): Promise<string[]> {
    return (await svc.handleCommand(c, at)).responses;
  }
  // Simulate the auto-responder confirming delivery of every played body line.
  async function deliver(result: DeadDropResult, at = NOW): Promise<void> {
    for (const p of result.playOnDelivery ?? []) await svc.markDelivered(SOURCE, p.messageId, at);
  }

  it('returns a no-op (no DM) for non-DM messages', async () => {
    const out = await svc.handleCommand(ctx({ text: 'msg wisp hi', isDirect: false }), NOW);
    expect(out.responses).toEqual([]);
  });

  it('stores a message and reports a 4-char id', async () => {
    const out = await store('msg WISP Hello from the roof');
    expect(out[0]).toMatch(/^Stored for WISP \(id [0-9A-F]{4}\)/);
    const pending = await repo.getPendingForRecipient(SOURCE, ['wisp'], 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('Hello from the roof');
  });

  it('captures a multi-word body greedily', async () => {
    await store('msg WISP meet at the repeater tonight');
    const [m] = await repo.getPendingForRecipient(SOURCE, ['wisp'], 0);
    expect(m.body).toBe('meet at the repeater tonight');
  });

  it('rejects an over-long body in bytes', async () => {
    const body = 'x'.repeat(181);
    const out = await store(`msg WISP ${body}`);
    expect(out[0]).toMatch(/Message too long \(181 bytes\)/);
    expect(await repo.countPendingForRecipient(SOURCE, ['wisp'], 0)).toBe(0);
  });

  it('inbox shows count and sender names', async () => {
    await store('msg WISP one', { senderShortName: 'ZNOF', senderNodeNum: 111 });
    await store('msg WISP two', { senderShortName: 'ALLF', senderNodeNum: 222 });
    const out = await run(wisp('inbox'));
    expect(out[0]).toMatch(/2 msgs from 2 nodes \(ZNOF, ALLF\)/);
    expect(out[0]).toContain("Reply 'inbox play'");
  });

  it('inbox with a single sender suggests a pre-filled play hint', async () => {
    await store('msg WISP only one', { senderShortName: 'ZNOF' });
    const out = await run(wisp('inbox'));
    expect(out[0]).toContain("Reply 'inbox play ZNOF'");
  });

  it('inbox play marks messages played only once their body is delivered (#1)', async () => {
    await store('msg WISP first', { senderShortName: 'ZNOF', senderNodeNum: 111 }, NOW - 1000);
    await store('msg WISP second', { senderShortName: 'ALLF', senderNodeNum: 222 }, NOW);
    const result = await svc.handleCommand(wisp('inbox play'), NOW);

    expect(result.responses[0]).toMatch(/^MSG 1\/2 from ZNOF/);
    expect(result.responses[1]).toBe('first');
    expect(result.responses[2]).toMatch(/^MSG 2\/2 from ALLF/);
    expect(result.responses[3]).toBe('second');
    expect(result.responses[result.responses.length - 1]).toContain('All 2 delivered');

    // Body lines (indices 1 and 3) carry the play-on-delivery hooks.
    expect((result.playOnDelivery ?? []).map(p => p.index).sort()).toEqual([1, 3]);

    // Before delivery is confirmed, nothing is played — a dropped DM resurfaces.
    expect(await repo.getPendingForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(2);
    expect(await repo.getPlayedForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(0);

    // After delivery confirmation, they're played.
    await deliver(result);
    expect(await repo.getPendingForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(0);
    expect(await repo.getPlayedForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(2);
  });

  it('inbox play <sender> filters to that sender', async () => {
    await store('msg WISP from znof', { senderShortName: 'ZNOF', senderNodeNum: 111 });
    await store('msg WISP from allf', { senderShortName: 'ALLF', senderNodeNum: 222 });
    const result = await svc.handleCommand(wisp('inbox play ALLF'), NOW);
    expect(result.responses.filter(l => l === 'from allf')).toHaveLength(1);
    expect(result.responses.some(l => l === 'from znof')).toBe(false);
    await deliver(result);
    // Only the ALLF message was played; ZNOF's remains pending.
    const pending = await repo.getPendingForRecipient(SOURCE, ['wisp', 'wisp node'], 0);
    expect(pending).toHaveLength(1);
    expect(pending[0].body).toBe('from znof');
  });

  it('inbox play <sender> filter matches the !hex/node-num hint forms (#5)', async () => {
    // ALLF is node 222 -> !000000de. A nameless sender plays by !hex/node-num.
    await store('msg WISP from allf', { senderShortName: 'ALLF', senderNodeNum: 222 });
    expect((await run(wisp('inbox play !000000de'))).some(l => l === 'from allf')).toBe(true);
    // store again, retrieve by node-num form
    await store('msg WISP again', { senderShortName: 'ALLF', senderNodeNum: 222 });
    expect((await run(wisp('inbox play 222'))).some(l => l === 'again')).toBe(true);
  });

  it('inbox play caps the batch and reports the remainder', async () => {
    for (let i = 0; i < 7; i++) {
      await store(`msg WISP m${i}`, { senderShortName: 'ZNOF', senderNodeNum: 111 }, NOW - (7 - i) * 1000);
    }
    const out = await run(wisp('inbox play'));
    expect(out).toHaveLength(11); // 5 header+body pairs + 1 summary
    expect(out[out.length - 1]).toContain('2 more');
  });

  it('inbox delete works for the addressed recipient', async () => {
    const stored = await store('msg WISP secret', { senderShortName: 'ZNOF' });
    const id = stored[0].match(/id ([0-9A-F]{4})/)![1];
    const ok = await run(wisp(`inbox delete ${id}`));
    expect(ok).toEqual([`Message ${id} deleted.`]);
    expect(await repo.getByShortId(SOURCE, id)).toBeNull();
  });

  it('inbox delete returns the same response for not-yours and non-existent ids (#7)', async () => {
    const stored = await store('msg WISP secret', { senderShortName: 'ZNOF' });
    const realId = stored[0].match(/id ([0-9A-F]{4})/)![1];

    const notYours = await run(ctx({ text: `inbox delete ${realId}`, senderShortName: 'NOPE', senderNodeNum: 999 }));
    const missing = await run(ctx({ text: 'inbox delete ZZ99', senderShortName: 'NOPE', senderNodeNum: 999 }));
    // Both must be indistinguishable, and the real message must NOT be deleted.
    expect(notYours).toEqual([`Message ${realId} not found.`]);
    expect(missing).toEqual(['Message ZZ99 not found.']);
    expect(await repo.getByShortId(SOURCE, realId)).not.toBeNull();
  });

  it('inbox clear deletes only already-played messages', async () => {
    await store('msg WISP a', { senderShortName: 'ZNOF' });
    await store('msg WISP b', { senderShortName: 'ZNOF' });
    await deliver(await svc.handleCommand(wisp('inbox play'), NOW)); // play + deliver both
    const out = await run(wisp('inbox clear'));
    expect(out).toEqual(['Cleared 2 played messages.']);
    expect(await repo.getPlayedForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(0);
  });

  it('matches recipient by node-id form', async () => {
    await store('msg !0000022b by id', { senderShortName: 'ZNOF' }); // 555 -> 0x22b
    const out = await run(wisp('inbox'));
    expect(out[0]).toMatch(/1 msg from 1 node/);
  });

  it('enforces the per-recipient pending cap', async () => {
    for (let i = 0; i < MAX_PENDING_PER_RECIPIENT; i++) {
      await repo.insertMessage({
        sourceId: SOURCE, shortId: `R${i.toString().padStart(3, '0')}`, recipientName: 'wisp',
        senderNodeNum: 111, senderShortName: 'ZNOF', senderLongName: '', body: 'x',
      }, NOW);
    }
    const out = await store('msg WISP one too many');
    expect(out[0]).toContain('inbox is full');
  });

  it('per-recipient cap counts across the recipient identity forms (#3)', async () => {
    // Resolver expands "wisp" to all of WISP's (node 555) forms.
    const forms = ['wisp', 'wisp node', '!0000022b', '555'];
    const svc2 = new DeadDropService(() => repo, async () => forms);
    // Fill the cap using the !hex form...
    for (let i = 0; i < MAX_PENDING_PER_RECIPIENT; i++) {
      await repo.insertMessage({
        sourceId: SOURCE, shortId: `H${i.toString().padStart(3, '0')}`, recipientName: '!0000022b',
        senderNodeNum: 111, senderShortName: 'ZNOF', senderLongName: '', body: 'x',
      }, NOW);
    }
    // ...then storing via a different form ("wisp") is still capped, not a fresh counter.
    const out = (await svc2.handleCommand(ctx({ text: 'msg wisp blocked' }), NOW)).responses;
    expect(out[0]).toContain('inbox is full');
  });

  it('enforces the per-sender pending cap', async () => {
    for (let i = 0; i < MAX_PENDING_PER_SENDER; i++) {
      await repo.insertMessage({
        sourceId: SOURCE, shortId: `S${i.toString().padStart(3, '0')}`, recipientName: `rcpt${i}`,
        senderNodeNum: 111, senderShortName: 'ZNOF', senderLongName: '', body: 'x',
      }, NOW);
    }
    const out = await store('msg WISP blocked', { senderNodeNum: 111 });
    expect(out[0]).toContain('too many pending messages out');
  });

  it('falls back to help for an unknown command', async () => {
    const out = await run(wisp('flibber'));
    expect(out[0]).toMatch(/^Commands: msg/);
  });
});
