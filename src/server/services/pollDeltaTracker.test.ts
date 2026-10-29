/**
 * Incremental poll replies: a client that merges every delta must end up with
 * exactly the full reply, whatever changed in between (edits, removals,
 * re-adds, reorders, sections appearing and disappearing, restarts, pruned
 * history).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PollDeltaTracker, serializePollReply, type PollBuild } from './pollDeltaTracker.js';
import { mergePollReply, type PollReply } from '../../hooks/pollDelta.js';
import type { PollData } from '../../hooks/usePoll.js';

interface FakeNode {
  nodeNum: number;
  user: { id: string; longName: string };
  lastHeard: number;
  snr?: number;
}

type Sections = Record<string, unknown>;

function buildOf(nodes: FakeNode[], sections: Sections): PollBuild {
  const sectionsJson: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(sections)) sectionsJson[name] = JSON.stringify(value);
  return {
    nodesJson: nodes.map((node) => JSON.stringify(node)),
    nodeNums: nodes.map((node) => node.nodeNum),
    sectionsJson,
  };
}

/** What a client that does not send a cursor would get. */
function fullReply(nodes: FakeNode[], sections: Sections): PollData {
  return JSON.parse(JSON.stringify({ ...sections, nodes })) as PollData;
}

/** One poll as the route sends it and the client merges it. */
class Client {
  base: PollData | null = null;
  cursor = '';
  fullReplies = 0;
  deltaReplies = 0;

  constructor(private readonly tracker: PollDeltaTracker, private readonly key = 'u1|src') {}

  poll(nodes: FakeNode[], sections: Sections): { data: PollData; reply: PollReply } {
    const build = buildOf(nodes, sections);
    const result = this.tracker.apply(this.key, this.cursor, build);
    const sectionsJson = { ...build.sectionsJson };
    for (const name of result.unchangedSections ?? []) sectionsJson[name] = undefined;
    const body = serializePollReply(sectionsJson, result.nodesJson, {
      pollCursor: result.cursor ?? undefined,
      pollDelta: result.delta || undefined,
      removedNodes: result.removedNodes,
      nodeOrder: result.nodeOrder,
      unchangedSections: result.unchangedSections,
    });
    const reply = JSON.parse(body) as PollReply;
    if (reply.pollDelta) this.deltaReplies++;
    else this.fullReplies++;
    const data = mergePollReply(this.base, reply);
    this.base = data;
    this.cursor = reply.pollCursor ?? '';
    return { data, reply };
  }
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function node(n: number, t: number): FakeNode {
  return { nodeNum: n, user: { id: `!${n.toString(16).padStart(8, '0')}`, longName: `Node ${n}` }, lastHeard: t };
}

describe('PollDeltaTracker + mergePollReply', () => {
  let clock: number;
  let tracker: PollDeltaTracker;

  beforeEach(() => {
    clock = 1_000_000;
    tracker = new PollDeltaTracker(() => clock);
  });

  it('first poll is the full reply and carries a cursor', () => {
    const client = new Client(tracker);
    const nodes = [node(1, 10), node(2, 20)];
    const { data, reply } = client.poll(nodes, { connection: { connected: true } });
    expect(reply.pollDelta).toBeUndefined();
    expect(reply.pollCursor).toMatch(/^[0-9a-f]+\.\d+$/);
    expect(data).toEqual(fullReply(nodes, { connection: { connected: true } }));
  });

  it('an unchanged poll sends no node and keeps every reference', () => {
    const client = new Client(tracker);
    const nodes = [node(1, 10), node(2, 20)];
    const sections = { connection: { connected: true }, messages: [{ id: 'm1' }] };
    const first = client.poll(nodes, sections).data;
    const { data, reply } = client.poll(nodes, sections);
    expect(reply.pollDelta).toBe(true);
    expect(reply.nodes).toEqual([]);
    expect(reply.removedNodes).toEqual([]);
    expect(reply.nodeOrder).toBeUndefined();
    expect(reply.messages).toBeUndefined();
    expect(reply.unchangedSections).toEqual(expect.arrayContaining(['connection', 'messages']));
    expect(data.nodes).toBe(first.nodes);
    expect(data.messages).toBe(first.messages);
  });

  it('a changed node is the only one sent; the others keep their references', () => {
    const client = new Client(tracker);
    const nodes = [node(1, 10), node(2, 20), node(3, 30)];
    const first = client.poll(nodes, {}).data;
    const next = [nodes[0], { ...nodes[1], snr: 5 }, nodes[2]];
    const { data, reply } = client.poll(next, {});
    expect(reply.nodes).toEqual([next[1]]);
    expect(reply.nodeOrder).toBeUndefined();
    expect(data).toEqual(fullReply(next, {}));
    expect(data.nodes![0]).toBe(first.nodes![0]);
    expect(data.nodes![2]).toBe(first.nodes![2]);
  });

  it('removals and additions arrive with the new order', () => {
    const client = new Client(tracker);
    client.poll([node(1, 10), node(2, 20), node(3, 30)], {});
    const next = [node(4, 40), node(1, 10), node(3, 30)];
    const { data, reply } = client.poll(next, {});
    expect(reply.removedNodes).toEqual([2]);
    expect(reply.nodeOrder).toEqual([4, 1, 3]);
    expect(reply.nodes).toEqual([node(4, 40)]);
    expect(data).toEqual(fullReply(next, {}));
  });

  it('a section that disappears is absent after the merge', () => {
    const client = new Client(tracker);
    client.poll([node(1, 1)], { messages: [{ id: 'a' }], deviceConfig: { x: 1 } });
    const { data, reply } = client.poll([node(1, 1)], { deviceConfig: { x: 1 } });
    expect(reply.pollDelta).toBe(true);
    expect(data.messages).toBeUndefined();
    expect('messages' in data).toBe(false);
    expect(data).toEqual(fullReply([node(1, 1)], { deviceConfig: { x: 1 } }));
  });

  it('a restart (new epoch) gets the full reply', () => {
    const client = new Client(tracker);
    client.poll([node(1, 1)], {});
    tracker.reset();
    const { data, reply } = client.poll([node(1, 2)], {});
    expect(reply.pollDelta).toBeUndefined();
    expect(data).toEqual(fullReply([node(1, 2)], {}));
  });

  it('a cursor older than a forgotten removal gets the full reply', () => {
    const stale = new Client(tracker);
    const fresh = new Client(tracker);
    stale.poll([node(1, 1), node(2, 2)], {});
    fresh.poll([node(1, 1), node(2, 2)], {});
    fresh.poll([node(1, 1)], {}); // node 2 removed: tombstone
    clock += 16 * 60 * 1000; // past the tombstone TTL
    fresh.poll([node(1, 1)], {}); // prunes it
    const { data, reply } = stale.poll([node(1, 1)], {});
    expect(reply.pollDelta).toBeUndefined();
    expect(data).toEqual(fullReply([node(1, 1)], {}));
  });

  it('an idle state is dropped and its client gets the full reply', () => {
    const client = new Client(tracker);
    client.poll([node(1, 1)], {});
    clock += 11 * 60 * 1000;
    new Client(tracker, 'other|src').poll([], {}); // triggers the sweep
    const { reply } = client.poll([node(1, 1)], {});
    expect(reply.pollDelta).toBeUndefined();
  });

  it('two rows with one nodeNum: full reply, no cursor', () => {
    const client = new Client(tracker);
    const { data, reply } = client.poll([node(1, 1), node(1, 2)], {});
    expect(reply.pollCursor).toBeUndefined();
    expect(data.nodes).toHaveLength(2);
    expect(client.poll([node(1, 1), node(1, 2)], {}).reply.pollDelta).toBeUndefined();
  });

  it('a foreign or malformed cursor gets the full reply', () => {
    for (const cursor of ['nope', 'abc.1', '.5', 'x.y']) {
      const client = new Client(tracker);
      client.poll([node(1, 1)], {});
      client.cursor = cursor;
      expect(client.poll([node(1, 1)], {}).reply.pollDelta).toBeUndefined();
    }
  });

  it('randomized: every client equals the full reply after every poll', () => {
    const rand = rng(42);
    const pool = Array.from({ length: 60 }, (_, i) => i + 1);
    let present = new Map<number, FakeNode>(pool.slice(0, 40).map((n) => [n, node(n, 0)]));
    let order = [...present.keys()];
    let sections: Sections = { connection: { connected: true }, messages: [], channels: [{ id: 0 }] };
    // Clients poll at different rates, so their cursors lag by different amounts.
    const clients = [1, 2, 3, 7].map((every) => ({ every, client: new Client(tracker) }));

    for (let step = 1; step <= 400; step++) {
      clock += 5000;
      const changes = Math.floor(rand() * 6);
      for (let c = 0; c < changes; c++) {
        const r = rand();
        const n = pool[Math.floor(rand() * pool.length)];
        if (r < 0.5 && present.has(n)) {
          present.set(n, { ...present.get(n)!, lastHeard: step, snr: Math.round(rand() * 20) });
        } else if (r < 0.65 && present.has(n)) {
          present.delete(n); // removed (deleted, or hidden by a permission change)
          order = order.filter((x) => x !== n);
        } else if (r < 0.8 && !present.has(n)) {
          present.set(n, node(n, step));
          order.splice(Math.floor(rand() * (order.length + 1)), 0, n);
        } else if (r < 0.9 && order.length > 1) {
          const i = Math.floor(rand() * order.length);
          const [moved] = order.splice(i, 1);
          order.unshift(moved);
        } else {
          sections = { ...sections };
          const which = rand();
          if (which < 0.3) sections.messages = [...(sections.messages as unknown[]), { id: `m${step}` }];
          else if (which < 0.5) delete sections.deviceConfig;
          else if (which < 0.7) sections.deviceConfig = { step };
          else sections.connection = { connected: rand() < 0.8 };
        }
      }
      if (step === 200) tracker.reset(); // restart mid-run
      const nodes = order.map((n) => present.get(n)!);
      for (const { every, client } of clients) {
        if (step % every !== 0) continue;
        const { data } = client.poll(nodes, sections);
        expect(data).toEqual(fullReply(nodes, sections));
      }
      present = new Map(present);
    }
    // Deltas were really used (not full replies throughout).
    for (const { client } of clients) expect(client.deltaReplies).toBeGreaterThan(client.fullReplies);
  });
});

describe('serializePollReply', () => {
  it('matches JSON.stringify of the same object', () => {
    const sections = { connection: { connected: true }, messages: [{ id: 'a', text: 'x"y' }], gone: undefined };
    const nodes = [node(1, 1), node(2, 2)];
    const body = serializePollReply(
      { connection: JSON.stringify(sections.connection), messages: JSON.stringify(sections.messages), gone: undefined },
      nodes.map((n) => JSON.stringify(n)),
      { pollCursor: 'e.1', pollDelta: undefined },
    );
    expect(JSON.parse(body)).toEqual({ connection: sections.connection, messages: sections.messages, nodes, pollCursor: 'e.1' });
  });
});
