/**
 * Per-source isolation tests for ReticulumRepository's message methods
 * (epic #3960, Phase 2 WP3).
 *
 * Verifies the `reticulum_messages` table (migration 143, keyed on `id` =
 * `${sourceId}_${lxmHashHex}`) truly isolates LXMF messages between sources —
 * the same physical LXM hash observed via two different sources must produce
 * two independent rows (distinct ids), and `list*`/`get*` must never leak the
 * other source's row. Also verifies withSourceScope's fail-closed behavior on
 * an empty sourceId (the #1 hard rule per CLAUDE.md).
 *
 * Uses `createTestDb()` — a real SQLite database built from the full
 * migration registry (migration 143 creates this table) — rather than
 * hand-rolled DDL, so this test can never silently drift from the schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReticulumRepository, type UpsertMessageInput } from './reticulum.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

const PEER_HASH = 'peer'.padEnd(32, '0');
const SELF_HASH = 'self'.padEnd(32, '0');

function makeMessage(overrides: Partial<UpsertMessageInput> = {}): UpsertMessageInput {
  return {
    id: `${overrides.id ?? 'shared-id'}`,
    fromHash: PEER_HASH,
    toHash: SELF_HASH,
    title: 'Hello',
    content: 'Hello world',
    timestamp: 1_700_000_000_000,
    state: 'delivered',
    method: 'opportunistic',
    ...overrides,
  };
}

describe('ReticulumRepository - message per-source isolation', () => {
  let testDb: TestDb;
  let repo: ReticulumRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new ReticulumRepository(testDb.db, 'sqlite');
  });

  afterEach(() => {
    testDb.close();
  });

  // The `id` column is the sole primary key (no composite `(sourceId, id)`
  // uniqueness at the DB level) — isolation instead relies on the row-id
  // convention embedding `sourceId` into `id` itself (`${sourceId}_${hash}`),
  // same as `messages.id`. These tests use realistic, source-prefixed ids
  // (a bare "shared-id" literal reused verbatim across two sources is not a
  // real caller shape, and would genuinely collide on the PK — that's not an
  // isolation bug, it's a violation of the id convention itself).

  it('the same logical LXM hash under two sources produces two independent rows', async () => {
    await repo.upsertMessage(SRC_A, makeMessage({ id: `${SRC_A}_hash1`, content: 'On A' }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: `${SRC_B}_hash1`, content: 'On B' }));

    const onA = await repo.getMessage(SRC_A, `${SRC_A}_hash1`);
    const onB = await repo.getMessage(SRC_B, `${SRC_B}_hash1`);
    expect(onA?.content).toBe('On A');
    expect(onB?.content).toBe('On B');
  });

  it('getMessage(A, id) never returns a row that only exists on B', async () => {
    await repo.upsertMessage(SRC_B, makeMessage({ id: `${SRC_B}_only-on-b` }));
    expect(await repo.getMessage(SRC_A, `${SRC_B}_only-on-b`)).toBeNull();
  });

  it('updateMessageState(A) does not affect the same logical hash on source B', async () => {
    await repo.upsertMessage(SRC_A, makeMessage({ id: `${SRC_A}_hash1`, state: 'delivered' }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: `${SRC_B}_hash1`, state: 'delivered' }));

    await repo.updateMessageState(SRC_A, `${SRC_A}_hash1`, 'failed');

    expect((await repo.getMessage(SRC_A, `${SRC_A}_hash1`))?.state).toBe('failed');
    expect((await repo.getMessage(SRC_B, `${SRC_B}_hash1`))?.state).toBe('delivered');
  });

  it('renameMessageId scoped to A does not touch a same-named row on source B', async () => {
    await repo.upsertMessage(SRC_A, makeMessage({ id: `${SRC_A}_temp-id` }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: `${SRC_B}_temp-id` }));

    await repo.renameMessageId(SRC_A, `${SRC_A}_temp-id`, `${SRC_A}_real-id`);

    expect(await repo.getMessage(SRC_A, `${SRC_A}_temp-id`)).toBeNull();
    expect(await repo.getMessage(SRC_A, `${SRC_A}_real-id`)).not.toBeNull();
    // B's row is untouched — still under its original id.
    expect(await repo.getMessage(SRC_B, `${SRC_B}_temp-id`)).not.toBeNull();
  });

  it('listMessages(A, peerHash) excludes B rows and vice versa', async () => {
    await repo.upsertMessage(SRC_A, makeMessage({ id: 'a1', timestamp: 1000 }));
    await repo.upsertMessage(SRC_A, makeMessage({ id: 'a2', timestamp: 2000 }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: 'b1', timestamp: 1500 }));

    const onA = await repo.listMessages(SRC_A, PEER_HASH);
    expect(onA.map((m) => m.id).sort()).toEqual(['a1', 'a2']);

    const onB = await repo.listMessages(SRC_B, PEER_HASH);
    expect(onB.map((m) => m.id)).toEqual(['b1']);
  });

  it('listThread(A, threadHash) excludes B rows and vice versa', async () => {
    const thread = 'thread-1'.padEnd(32, '0');
    await repo.upsertMessage(SRC_A, makeMessage({ id: 'a1', threadHash: thread, timestamp: 1000 }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: 'b1', threadHash: thread, timestamp: 1000 }));

    const onA = await repo.listThread(SRC_A, thread);
    expect(onA.map((m) => m.id)).toEqual(['a1']);

    const onB = await repo.listThread(SRC_B, thread);
    expect(onB.map((m) => m.id)).toEqual(['b1']);
  });

  it('listConversations(A) excludes B rows and vice versa', async () => {
    await repo.upsertMessage(SRC_A, makeMessage({ id: 'a1', fromHash: PEER_HASH, toHash: SELF_HASH, state: 'delivered' }));
    await repo.upsertMessage(SRC_B, makeMessage({ id: 'b1', fromHash: PEER_HASH, toHash: SELF_HASH, state: 'delivered' }));

    const onA = await repo.listConversations(SRC_A, SELF_HASH);
    expect(onA.map((c) => c.lastMessage.id)).toEqual(['a1']);

    const onB = await repo.listConversations(SRC_B, SELF_HASH);
    expect(onB.map((c) => c.lastMessage.id)).toEqual(['b1']);
  });

  it('upsertMessage/updateMessageState/renameMessageId/getMessage/listMessages/listThread/listConversations all throw on an empty sourceId (withSourceScope fail-closed)', async () => {
    await expect(repo.upsertMessage('', makeMessage())).rejects.toThrow(/requires a sourceId/);
    await expect(repo.updateMessageState('', 'id', 'sent')).rejects.toThrow(/requires a sourceId/);
    await expect(repo.renameMessageId('', 'old', 'new')).rejects.toThrow(/requires a sourceId/);
    await expect(repo.getMessage('', 'id')).rejects.toThrow(/sourceId is required/);
    await expect(repo.listMessages('', PEER_HASH)).rejects.toThrow(/sourceId is required/);
    await expect(repo.listThread('', 'thread')).rejects.toThrow(/sourceId is required/);
    await expect(repo.listConversations('')).rejects.toThrow(/sourceId is required/);
  });
});
