/**
 * aiSummaryService (#6566): transcript building, the prompt, the endpoint
 * request, and which messages reach it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings: Record<string, string> = {};
const mtRows: any[] = [];
const mcRows: any[] = [];

vi.mock('../../services/database.js', () => ({
  default: {
    settings: { getSetting: async (k: string) => settings[k] ?? null },
    messages: { getChannelTextSince: vi.fn(async () => mtRows) },
    meshcore: { getChannelMessagesSince: vi.fn(async () => mcRows) },
    nodes: {
      getNodeNamesByNums: async (nums: number[]) =>
        new Map(nums.filter((n) => n === 1).map((n) => [n, { longName: 'Alice', shortName: 'AL' }])),
    },
  },
}));
vi.mock('../utils/ssrfGuard.js', () => ({ assertSafeUrl: vi.fn(async () => undefined) }));

import { buildTranscript, buildSystemPrompt, summarizeChannels, runWindowEnd, AI_SUMMARY_DEFAULT_ENDPOINT } from './aiSummaryService.js';

const T0 = Date.UTC(2026, 10, 26, 8, 0);

describe('buildTranscript', () => {
  it('orders oldest first and keeps the newest lines when over budget', () => {
    const lines = [
      { at: T0 + 2000, sender: 'B', channel: 'c', text: 'second' },
      { at: T0, sender: 'A', channel: 'c', text: 'first' },
      { at: T0 + 4000, sender: 'C', channel: 'c', text: 'third' },
    ];
    const all = buildTranscript(lines, 10_000);
    expect(all.text.split('\n').map((l) => l.split(': ')[1])).toEqual(['first', 'second', 'third']);
    expect(all.text.split('\n')[0]).toBe('[2026-11-26 08:00Z] A (c): first');

    const lineLen = all.text.split('\n')[2].length + 1;
    const cut = buildTranscript(lines, lineLen * 2 + 2);
    expect(cut.used).toBe(2);
    expect(cut.dropped).toBe(1);
    expect(cut.text).not.toContain('first');
  });

  it('always keeps at least the newest line', () => {
    const r = buildTranscript([{ at: T0, sender: 'A', channel: 'c', text: 'x'.repeat(500) }], 10);
    expect(r.used).toBe(1);
  });
});

describe('buildSystemPrompt', () => {
  it('adds the length request and extra instructions', () => {
    const p = buildSystemPrompt('Use bullets.', 800);
    expect(p).toContain('under 800 characters');
    expect(p).toContain('Use bullets.');
  });
});

describe('summarizeChannels', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    mtRows.length = 0;
    mcRows.length = 0;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: ' A summary. ' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const mt = { sourceId: 'mt', protocol: 'meshtastic' as const, channel: 0, channelName: 'LongFast' };
  const mc = { sourceId: 'mc', protocol: 'meshcore' as const, channel: 1, channelName: 'gauntlet' };

  it('skips without calling the endpoint below minMessages', async () => {
    mtRows.push({ fromNodeNum: 1, fromNodeId: '!00000001', text: 'hi', createdAt: T0 });
    const r = await summarizeChannels({ targets: [mt], sinceMs: 0, excludeAutomated: true, minMessages: 2 });
    expect(r).toEqual({ messageCount: 1, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops automated Meshtastic messages, names senders, and strips MeshCore name prefixes', async () => {
    mtRows.push(
      { fromNodeNum: 1, fromNodeId: '!00000001', text: 'morning all', createdAt: T0 },
      { fromNodeNum: 2, fromNodeId: '!00000002', text: 'bot reply', createdAt: T0 + 1, isAutomation: true },
      { fromNodeNum: 3, fromNodeId: '!00000003', text: 'who is on?', createdAt: T0 + 2 },
    );
    mcRows.push({ fromName: 'Bob', text: 'Bob: repeater is down', createdAt: T0 + 3 });
    const r = await summarizeChannels({ targets: [mt, mc], sinceMs: 0, excludeAutomated: true, minMessages: 1 });

    expect(r).toMatchObject({ messageCount: 3, summary: 'A summary.', model: 'gpt-4o-mini' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(AI_SUMMARY_DEFAULT_ENDPOINT);
    expect(init.headers.Authorization).toBeUndefined();
    const transcript: string = JSON.parse(init.body).messages[1].content;
    expect(transcript).toContain('Alice (LongFast): morning all');
    expect(transcript).toContain('!00000003 (LongFast): who is on?');
    expect(transcript).toContain('Bob (gauntlet): repeater is down');
    expect(transcript).not.toContain('bot reply');
  });

  it('keeps automated messages when asked, and uses the saved endpoint, model and key', async () => {
    settings.aiSummaryBaseUrl = 'http://localhost:11434/v1';
    settings.aiSummaryModel = 'llama3';
    settings.ai_summary_api_token = 'sk-test';
    mtRows.push({ fromNodeNum: 2, fromNodeId: '!00000002', text: 'bot reply', createdAt: T0, isAutomation: true });
    const r = await summarizeChannels({ targets: [mt], sinceMs: 0, excludeAutomated: false, minMessages: 1 });
    expect(r.messageCount).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body).model).toBe('llama3');
  });

  it('throws a short error without the upstream body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('secret upstream detail', { status: 401, statusText: 'Unauthorized' }));
    mtRows.push({ fromNodeNum: 1, fromNodeId: '!00000001', text: 'hi', createdAt: T0 });
    await expect(summarizeChannels({ targets: [mt], sinceMs: 0, excludeAutomated: true, minMessages: 1 }))
      .rejects.toThrow('AI endpoint error (401): Unauthorized');
  });
});

describe('runWindowEnd', () => {
  it('uses the fire time, not the row time written after a slow AI call', () => {
    expect(runWindowEnd({ startedAt: T0 + 90_000, triggerEvent: JSON.stringify({ sourceId: null, timestamp: T0 }) })).toBe(T0);
  });

  it('falls back to startedAt for a missing, future, or implausible timestamp', () => {
    expect(runWindowEnd({ startedAt: T0, triggerEvent: null })).toBe(T0);
    expect(runWindowEnd({ startedAt: T0, triggerEvent: 'not json' })).toBe(T0);
    expect(runWindowEnd({ startedAt: T0, triggerEvent: JSON.stringify({ timestamp: T0 + 1 }) })).toBe(T0);
    expect(runWindowEnd({ startedAt: T0, triggerEvent: JSON.stringify({ timestamp: Math.floor(T0 / 1000) }) })).toBe(T0);
  });
});
