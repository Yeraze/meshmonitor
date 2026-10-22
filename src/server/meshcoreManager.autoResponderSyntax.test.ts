/**
 * MeshCore Auto-Responder trigger syntax (#5924).
 *
 * A trigger saved before #5924 has no `syntax` and must behave as it did: a
 * bare, unanchored, case-insensitive regex. A `syntax: 'pattern'` trigger
 * runs the Meshtastic placeholder DSL: anchored, homoglyph-normalised, and
 * its `{name}` captures fill the reply (and reach a script as PARAM_<name>).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';
import databaseService from '../services/database.js';

function makeManager(triggers: unknown[]) {
  const m = new MeshCoreManager('test-source');
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string, key: string) => {
      if (key === 'meshcoreAutoResponderEnabled') return 'true';
      if (key === 'meshcoreAutoResponderTriggers') return JSON.stringify(triggers);
      return null;
    },
  );
  const sendMessage = vi.fn().mockResolvedValue(true);
  const mm = m as any;
  mm.sendMessage = sendMessage;
  // Echo the template so the test sees the param substitution alone.
  mm.renderReplyTemplate = async (t: string) => t;
  const run = (text: string, fromPublicKey = 'deadbeefcafebabe0011223344556677') =>
    mm.checkAutoResponder({ id: 'm', fromPublicKey, text, timestamp: Date.now(), snr: 5 }, true, undefined);
  const sent = () => sendMessage.mock.calls.map((c) => c[0]);
  return { m: mm, run, sent };
}

const base = {
  enabled: true,
  responseType: 'text' as const,
  channels: [] as number[],
  listenDMs: true,
  replyAsDM: true,
  cooldownSeconds: 0,
};

describe('MeshCore Auto-Responder syntax (#5924)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a legacy trigger with no syntax is still an unanchored, case-insensitive regex', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'l', name: 'l', pattern: '!(signal|chat)\\b', response: 'ok' }]);
    await run('hey !SIGNAL please');
    await run('!signals'); // \b fails
    expect(sent()).toEqual(['ok']);
  });

  it('a pattern-mode trigger replies with substituted params and is anchored', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'p', name: 'p', syntax: 'pattern', pattern: 'weather {city}, w {city}', response: 'Sunny in {city}' }]);
    await run('WEATHER Miami');
    await run('w Paris');
    await run('say weather Miami');
    expect(sent()).toEqual(['Sunny in Miami', 'Sunny in Paris']);
  });

  it('pattern mode normalises homoglyphs but hands on the original text as the param', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'h', name: 'h', syntax: 'pattern', pattern: 'weather {city}', response: '{city}' }]);
    // Cyrillic "е" in "wеather" still matches the Latin pattern.
    await run('w\u0435ather Miami');
    // The param comes from the original text: "Барнаул", not "Бapнayл".
    await run('weather Барнаул');
    expect(sent()).toEqual(['Miami', 'Барнаул']);
  });

  it('regex mode: named groups fill the reply, and emoji patterns match', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'r', name: 'r', syntax: 'regex', pattern: '🔋\\s*(?<level>\\d+)', response: 'level {level}' }]);
    await run('battery 🔋 42');
    expect(sent()).toEqual(['level 42']);
  });

  it('script responses get the params as PARAM_<name>', async () => {
    const { m, run } = makeManager([{ ...base, id: 's', name: 's', syntax: 'pattern', responseType: 'script', scriptPath: 'x.py', pattern: 'zip {z:\\d{5}}', response: '' }]);
    const runScript = vi.fn().mockResolvedValue({ success: true, wouldSendMessages: [] });
    m.runMeshCoreScript = runScript;
    await run('zip 33076');
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0][2]).toMatchObject({ PARAM_z: '33076' });
  });

  it('the per-sender cooldown still applies in pattern mode', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'c', name: 'c', syntax: 'pattern', pattern: 'ping', response: 'pong', cooldownSeconds: 60 }]);
    await run('ping');
    await run('PING');
    expect(sent()).toEqual(['pong']);
  });

  it('a regex the server rejects never fires', async () => {
    const { run, sent } = makeManager([{ ...base, id: 'x', name: 'x', pattern: '(a+)+', response: 'no' }]);
    await run('aaaa');
    expect(sent()).toEqual([]);
  });
});
