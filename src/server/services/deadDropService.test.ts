/**
 * DeadDropService tests — the mailbox command brain, exercised against a real
 * (in-memory SQLite) repository.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { DeadDropRepository } from '../../db/repositories/deadDrop.js';
import { DeadDropService, MAX_PENDING_PER_RECIPIENT, MAX_PENDING_PER_SENDER } from './deadDropService.js';
import type { DeadDropContext } from './deadDropService.js';
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

// WISP retrieving their inbox.
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

  async function store(text: string, from: Partial<DeadDropContext> = {}, at = NOW) {
    return svc.handleCommand(ctx({ text, ...from }), at);
  }

  it('rejects commands that are not DMs', async () => {
    const out = await svc.handleCommand(ctx({ text: 'msg wisp hi', isDirect: false }), NOW);
    expect(out).toEqual(['Mailbox commands must be sent by DM.']);
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
    expect(await repo.countPendingForRecipient(SOURCE, 'wisp', 0)).toBe(0);
  });

  it('inbox shows count and sender names', async () => {
    await store('msg WISP one', { senderShortName: 'ZNOF', senderNodeNum: 111 });
    await store('msg WISP two', { senderShortName: 'ALLF', senderNodeNum: 222 });
    const out = await svc.handleCommand(wisp('inbox'), NOW);
    expect(out[0]).toMatch(/2 msgs from 2 nodes \(ZNOF, ALLF\)/);
    expect(out[0]).toContain("Reply 'inbox play'");
  });

  it('inbox with a single sender suggests a pre-filled play hint', async () => {
    await store('msg WISP only one', { senderShortName: 'ZNOF' });
    const out = await svc.handleCommand(wisp('inbox'), NOW);
    expect(out[0]).toContain("Reply 'inbox play ZNOF'");
  });

  it('inbox play delivers header+body pairs and marks them played', async () => {
    await store('msg WISP first', { senderShortName: 'ZNOF', senderNodeNum: 111 }, NOW - 1000);
    await store('msg WISP second', { senderShortName: 'ALLF', senderNodeNum: 222 }, NOW);
    const out = await svc.handleCommand(wisp('inbox play'), NOW);

    expect(out[0]).toMatch(/^MSG 1\/2 from ZNOF/);
    expect(out[1]).toBe('first');
    expect(out[2]).toMatch(/^MSG 2\/2 from ALLF/);
    expect(out[3]).toBe('second');
    expect(out[out.length - 1]).toContain('All 2 delivered');

    // Now pending is empty, played retained for clear.
    expect(await repo.getPendingForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(0);
    expect(await repo.getPlayedForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(2);
  });

  it('inbox play <sender> filters to that sender', async () => {
    await store('msg WISP from znof', { senderShortName: 'ZNOF', senderNodeNum: 111 });
    await store('msg WISP from allf', { senderShortName: 'ALLF', senderNodeNum: 222 });
    const out = await svc.handleCommand(wisp('inbox play ALLF'), NOW);
    expect(out.filter(l => l === 'from allf')).toHaveLength(1);
    expect(out.some(l => l === 'from znof')).toBe(false);
    // ZNOF message still pending
    expect(await repo.getPendingForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(1);
  });

  it('inbox play caps the batch and reports the remainder', async () => {
    for (let i = 0; i < 7; i++) {
      await store(`msg WISP m${i}`, { senderShortName: 'ZNOF', senderNodeNum: 111 }, NOW - (7 - i) * 1000);
    }
    const out = await svc.handleCommand(wisp('inbox play'), NOW);
    // 5 header+body pairs = 10 lines + 1 summary
    expect(out).toHaveLength(11);
    expect(out[out.length - 1]).toContain('2 more');
  });

  it('inbox delete works only for the addressed recipient', async () => {
    const stored = await store('msg WISP secret', { senderShortName: 'ZNOF' });
    const id = stored[0].match(/id ([0-9A-F]{4})/)![1];

    // A different node cannot delete it.
    const wrong = await svc.handleCommand(ctx({ text: `inbox delete ${id}`, senderShortName: 'NOPE', senderNodeNum: 999 }), NOW);
    expect(wrong).toEqual(['That message is not addressed to you.']);

    // WISP can.
    const ok = await svc.handleCommand(wisp(`inbox delete ${id}`), NOW);
    expect(ok).toEqual([`Message ${id} deleted.`]);
    expect(await repo.getByShortId(SOURCE, id)).toBeNull();
  });

  it('inbox clear deletes only already-played messages', async () => {
    await store('msg WISP a', { senderShortName: 'ZNOF' });
    await store('msg WISP b', { senderShortName: 'ZNOF' });
    await svc.handleCommand(wisp('inbox play'), NOW); // play both
    const out = await svc.handleCommand(wisp('inbox clear'), NOW);
    expect(out).toEqual(['Cleared 2 played messages.']);
    expect(await repo.getPlayedForRecipient(SOURCE, ['wisp', 'wisp node'], 0)).toHaveLength(0);
  });

  it('matches recipient by node-id form', async () => {
    // Stored addressed to WISP's node id "!0000022b" (555 -> 0x22b)
    await store('msg !0000022b by id', { senderShortName: 'ZNOF' });
    const out = await svc.handleCommand(wisp('inbox'), NOW);
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
    expect(out[0]).toContain("inbox is full");
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
    const out = await svc.handleCommand(wisp('flibber'), NOW);
    expect(out[0]).toMatch(/^Commands: msg/);
  });

  it('tolerates a keyword prefix (betamsg/betainbox) for coexistence', async () => {
    const stored = await svc.handleCommand(ctx({ text: 'betamsg WISP roof check' }), NOW);
    expect(stored[0]).toMatch(/^Stored for WISP \(id [0-9A-F]{4}\)/);

    const inbox = await svc.handleCommand(wisp('betainbox'), NOW);
    expect(inbox[0]).toMatch(/1 msg from 1 node/);

    const play = await svc.handleCommand(wisp('betainbox play'), NOW);
    expect(play.some(l => l === 'roof check')).toBe(true);

    // an unrelated prefix works too (e.g. testmsg)
    const stored2 = await svc.handleCommand(ctx({ text: 'testmsg WISP second' }), NOW);
    expect(stored2[0]).toMatch(/^Stored for WISP/);
  });
});
