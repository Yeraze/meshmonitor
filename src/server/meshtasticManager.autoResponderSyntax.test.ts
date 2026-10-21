/**
 * Meshtastic Auto-Responder trigger syntax (#5924).
 *
 * A trigger saved before #5924 has no `syntax` and must match exactly as it
 * did (the anchored placeholder DSL). A `syntax: 'regex'` trigger runs one
 * bare, unanchored, case-insensitive regex, and named groups fill the reply.
 *
 * Drives the private `checkAutoResponder` on the fallback manager with only
 * the settings reads and the send queue stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import databaseService from '../services/database.js';

const managerModule = await import('./meshtasticManager.js');

const REMOTE = 987654321;

function wire(triggers: unknown[]) {
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(async (_s: string, key: string) => {
    if (key === 'autoResponderEnabled') return 'true';
    if (key === 'autoResponderTriggers') return JSON.stringify(triggers);
    return null;
  });
  vi.spyOn(databaseService.settings, 'getSetting').mockResolvedValue(null);
}

const msg = (text: string, packetId: number) => ({ text, fromNodeNum: REMOTE, channel: 0, timestamp: Date.now(), packetId });

describe('Meshtastic Auto-Responder syntax (#5924)', () => {
  let manager: any;
  let enqueue: ReturnType<typeof vi.fn>;
  let packet = 5000;
  const run = async (text: string) => manager.checkAutoResponder(msg(text, ++packet), true, packet);

  beforeEach(() => {
    manager = managerModule.fallbackManager;
    manager.localNodeInfo = { nodeNum: 1, nodeId: '!00000001', longName: 'Local', shortName: 'LCL' };
    manager.autoResponderProcessedPackets = new Set();
    manager.autoResponderCooldowns = new Map();
    manager.canTransmit = () => true;
    manager.isAutomationAirtimeGated = async () => false;
    manager.replaceAcknowledgementTokens = async (s: string) => s;
    enqueue = vi.fn();
    manager.enqueueAutomation = enqueue;
  });

  afterEach(() => vi.restoreAllMocks());

  const sent = () => enqueue.mock.calls.map((c) => c[0]);

  it('a legacy trigger with no syntax is still the anchored DSL', async () => {
    wire([{ id: 'w', trigger: 'weather {city}, w {city}', responseType: 'text', response: 'Sunny in {city}', channels: ['dm'] }]);
    await run('WEATHER Miami');
    await run('w Barnaul');
    await run('say weather Miami'); // anchored: no match
    expect(sent()).toEqual(['Sunny in Miami', 'Sunny in Barnaul']);
  });

  it('a regex-mode trigger matches anywhere, case-insensitively, with named-group params', async () => {
    wire([{ id: 'b', syntax: 'regex', trigger: '🔋\\s*(?<level>\\d{1,3})', responseType: 'text', response: 'level {level}', channels: ['dm'] }]);
    await run('battery 🔋 42 left');
    await run('no battery here');
    expect(sent()).toEqual(['level 42']);
  });

  it('regex mode does not split on commas, and pattern mode does', async () => {
    wire([
      { id: 'r', syntax: 'regex', trigger: '^a{1,2}b$', responseType: 'text', response: 'regex', channels: ['dm'] },
      { id: 'p', syntax: 'pattern', trigger: 'x, y', responseType: 'text', response: 'pattern', channels: ['dm'] },
    ]);
    await run('aab');
    await run('Y');
    expect(sent()).toEqual(['regex', 'pattern']);
  });

  it('a regex-mode trigger the server would reject (ReDoS shape) never matches', async () => {
    wire([{ id: 'bad', syntax: 'regex', trigger: '(a+)+', responseType: 'text', response: 'nope', channels: ['dm'] }]);
    await run('aaaa');
    expect(sent()).toEqual([]);
  });

  it('the per-node cooldown still applies in regex mode', async () => {
    wire([{ id: 'c', syntax: 'regex', trigger: 'ping', responseType: 'text', response: 'pong', channels: ['dm'], cooldownSeconds: 60 }]);
    await run('ping one');
    await run('ping two');
    expect(sent()).toEqual(['pong']);
  });
});
