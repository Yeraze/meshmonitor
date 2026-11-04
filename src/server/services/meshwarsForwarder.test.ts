import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = new Map<string, string>();
vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
      setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
    },
  },
}));

const localNode = { latitude: 43.61, longitude: -116.2, publicKey: 'abcdef0123456789' };
const meshcoreManager = { getLocalNode: vi.fn(() => localNode) };
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn((id: string) => (id === 'mc1' ? meshcoreManager : undefined)) },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => m === meshcoreManager,
}));

import {
  buildPing,
  normalizeBaseUrl,
  meshwarsForwarder,
  COLLECT_WINDOW_MS,
  MIN_FORWARD_INTERVAL_MS,
  CONFIG_CACHE_MS,
} from './meshwarsForwarder';
import { dataEventEmitter } from './dataEventEmitter';

const fetchMock = vi.fn();

async function enable() {
  settings.set('meshwarsEnabled', 'true');
  settings.set('meshwarsSourceId', 'mc1');
  settings.set('meshwars_api_token', 'key-123');
  // What the settings route does after a save.
  await meshwarsForwarder.refreshConfig();
}

describe('buildPing', () => {
  it('builds a MeshMapper TX ping', () => {
    const ping = buildPing(localNode, [{ hash: 'A3', snr: 5.25, hops: 1 }, { hash: '7f', snr: null, hops: 1 }], 1_700_000_000_500);
    expect(ping).toEqual({
      type: 'TX',
      lat: 43.61,
      lon: -116.2,
      timestamp: 1_700_000_000,
      heard_repeats: 'a3(5.25),7f(0)',
      contact: 'ABCDEF01',
    });
  });

  it('dedupes repeaters and drops non-hex ids', () => {
    const ping = buildPing(localNode, [{ hash: 'a3', snr: 1, hops: 1 }, { hash: 'a3', snr: 2, hops: 1 }, { hash: 'zz', hops: 1 }], 0);
    expect(ping?.heard_repeats).toBe('a3(1)');
  });

  it.each([
    ['no node', null],
    ['no position', { publicKey: 'abcdef01' }],
    ['a 0,0 position', { latitude: 0, longitude: 0, publicKey: 'abcdef01' }],
    ['no public key', { latitude: 1, longitude: 2 }],
  ])('returns null with %s', (_label, node) => {
    expect(buildPing(node as never, [{ hash: 'a3', snr: 1, hops: 1 }], 0)).toBeNull();
  });

  it('returns null when nothing was heard', () => {
    expect(buildPing(localNode, [], 0)).toBeNull();
  });

  it('reports only repeaters that heard the radio directly (hops 1)', () => {
    // Relayed a3 -> 7f -> 2c: only a3 heard us. 7f and 2c heard a relay, and
    // a repeater with unknown hops is not counted either.
    const ping = buildPing(localNode, [
      { hash: 'a3', snr: null, hops: 1 },
      { hash: '7f', snr: null, hops: 2 },
      { hash: '2c', snr: -4.5, hops: 3 },
      { hash: '9b', snr: 6, hops: null },
      { hash: 'd1', snr: 2 },
    ], 0);
    expect(ping?.heard_repeats).toBe('a3(0)');
  });

  it('returns null when only multi-hop repeaters heard the message', () => {
    expect(buildPing(localNode, [{ hash: '7f', snr: null, hops: 2 }, { hash: '2c', snr: -1, hops: 3 }], 0)).toBeNull();
  });
});

describe('normalizeBaseUrl', () => {
  it('defaults to meshwars.com and trims a trailing slash', () => {
    expect(normalizeBaseUrl('')).toBe('https://meshwars.com');
    expect(normalizeBaseUrl('https://mw.example.org/')).toBe('https://mw.example.org');
  });

  it('rejects other schemes and garbage', () => {
    expect(normalizeBaseUrl('ftp://x.org')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
  });
});

describe('meshwarsForwarder', () => {
  beforeEach(() => {
    settings.clear();
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    meshwarsForwarder.start();
  });

  afterEach(() => {
    meshwarsForwarder.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function heard(heardBy: Array<{ hash: string; snr?: number | null; hops?: number | null }>, id = 'msg-1', sourceId = 'mc1') {
    dataEventEmitter.emit('data', {
      type: 'meshcore:channel-heard',
      data: { sourceId, id, heardBy },
      timestamp: Date.now(),
      sourceId,
    });
  }

  it('posts one ping per message after the collection window, with the latest heard set', async () => {
    await enable();
    heard([{ hash: 'a3', snr: 4, hops: 1 }]);
    heard([{ hash: 'a3', snr: 4, hops: 1 }, { hash: '7f', snr: -2, hops: 1 }]);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://meshwars.com/api/mc/ingest');
    expect(init.headers['X-API-Key']).toBe('key-123');
    const body = JSON.parse(init.body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].heard_repeats).toBe('a3(4),7f(-2)');
    expect(body.data[0].contact).toBe('ABCDEF01');
  });

  it('sends nothing when disabled, and starts no timer for the event', async () => {
    await meshwarsForwarder.refreshConfig();
    const timersBefore = vi.getTimerCount();
    heard([{ hash: 'a3', snr: 4, hops: 1 }]);
    expect(vi.getTimerCount()).toBe(timersBefore);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts no timer for a source other than the chosen one', async () => {
    await enable();
    const timersBefore = vi.getTimerCount();
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-1', 'other');
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('a multi-hop flood sends only the direct repeater', async () => {
    await enable();
    heard([{ hash: 'a3', snr: null, hops: 1 }, { hash: '7f', snr: null, hops: 2 }, { hash: '2c', snr: -3, hops: 3 }]);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).data[0].heard_repeats).toBe('a3(0)');
  });

  it('turning it off drops a message still collecting', async () => {
    await enable();
    heard([{ hash: 'a3', snr: 4, hops: 1 }]);
    settings.set('meshwarsEnabled', 'false');
    await meshwarsForwarder.refreshConfig();
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('picks up a setting written without a save (e.g. a restore) once the cache ages out', async () => {
    await meshwarsForwarder.refreshConfig();
    settings.set('meshwarsEnabled', 'true');
    settings.set('meshwarsSourceId', 'mc1');
    settings.set('meshwars_api_token', 'key-123');
    await vi.advanceTimersByTimeAsync(CONFIG_CACHE_MS + 1);
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-1'); // stale cache: triggers a re-read
    await vi.advanceTimersByTimeAsync(0);
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-2');
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a source other than the chosen one', async () => {
    await enable();
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-1', 'other');
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds the cooldown across messages, using the persisted time', async () => {
    await enable();
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-1');
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-2');
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settings.get('meshwarsLastForwardAt')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(MIN_FORWARD_INTERVAL_MS);
    heard([{ hash: 'a3', snr: 4, hops: 1 }], 'msg-3');
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records a failed POST and does not retry it', async () => {
    await enable();
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    heard([{ hash: 'a3', snr: 4, hops: 1 }]);
    await vi.advanceTimersByTimeAsync(COLLECT_WINDOW_MS * 4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const status = await meshwarsForwarder.getStatus();
    expect(status.lastResult).toMatchObject({ ok: false, error: 'HTTP 401' });
    expect(status.apiKeySet).toBe(true);
    expect(JSON.stringify(status)).not.toContain('key-123');
  });
});
