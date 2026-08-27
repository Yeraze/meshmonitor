import { describe, it, expect } from 'vitest';
import { computeScriptUsage, scriptKey, type SourceTriggers } from './scriptUsage.js';

describe('scriptKey', () => {
  it('reduces a stored path to its filename', () => {
    expect(scriptKey('/data/scripts/weather.py')).toBe('weather.py');
    expect(scriptKey('weather.py')).toBe('weather.py');
    expect(scriptKey('C:\\scripts\\a.sh')).toBe('a.sh');
  });
});

describe('computeScriptUsage', () => {
  it('returns an empty map when no source uses scripts', () => {
    const sources: SourceTriggers[] = [
      { sourceId: 's1', autoResponderTriggers: [{ id: 'a', responseType: 'text', response: 'hi' }] },
    ];
    expect(computeScriptUsage(sources).size).toBe(0);
  });

  it('detects a Meshtastic auto-responder script by its response path', () => {
    const sources: SourceTriggers[] = [
      {
        sourceId: 's1',
        sourceName: 'Node A',
        autoResponderTriggers: [
          { id: 'a1', trigger: ['weather', 'weather {q}'], responseType: 'script', response: '/data/scripts/weather.py' },
        ],
      },
    ];
    const usage = computeScriptUsage(sources);
    const refs = usage.get('weather.py');
    expect(refs).toHaveLength(1);
    expect(refs![0]).toMatchObject({
      type: 'auto-responder',
      protocol: 'meshtastic',
      sourceId: 's1',
      sourceName: 'Node A',
      triggerId: 'a1',
      triggerName: 'weather, weather {q}',
      enabled: true,
    });
  });

  it('detects a timer script (default responseType) and honors enabled flag', () => {
    const sources: SourceTriggers[] = [
      {
        sourceId: 's1',
        timerTriggers: [
          { id: 't1', name: 'Nightly', scriptPath: '/data/scripts/report.js', enabled: false },
          { id: 't2', name: 'Text only', responseType: 'text', response: 'yo', scriptPath: '/data/scripts/ignored.js' },
        ],
      },
    ];
    const usage = computeScriptUsage(sources);
    expect(usage.get('report.js')).toMatchObject([{ type: 'timer', triggerName: 'Nightly', enabled: false }]);
    // A text-mode timer must not count its residual scriptPath as usage.
    expect(usage.has('ignored.js')).toBe(false);
  });

  it('detects a geofence script only when responseType is script', () => {
    const sources: SourceTriggers[] = [
      {
        sourceId: 's1',
        geofenceTriggers: [
          { id: 'g1', name: 'Zone', responseType: 'script', scriptPath: '/data/scripts/zone.sh' },
          { id: 'g2', name: 'Text', responseType: 'text', scriptPath: '/data/scripts/nope.sh' },
        ],
      },
    ];
    const usage = computeScriptUsage(sources);
    expect(usage.get('zone.sh')).toHaveLength(1);
    expect(usage.has('nope.sh')).toBe(false);
  });

  it('detects MeshCore auto-responder and timer variants', () => {
    const sources: SourceTriggers[] = [
      {
        sourceId: 'mc1',
        sourceName: 'MeshCore',
        meshcoreAutoResponderTriggers: [
          { id: 'ma1', trigger: 'ping', responseType: 'script', response: '/data/scripts/ping.py' },
        ],
        meshcoreTimerTriggers: [
          { id: 'mt1', name: 'Beacon', scriptPath: '/data/scripts/beacon.py' },
        ],
      },
    ];
    const usage = computeScriptUsage(sources);
    expect(usage.get('ping.py')![0]).toMatchObject({ type: 'auto-responder', protocol: 'meshcore' });
    expect(usage.get('beacon.py')![0]).toMatchObject({ type: 'timer', protocol: 'meshcore' });
  });

  it('aggregates references for one script used across multiple sources and types', () => {
    const sources: SourceTriggers[] = [
      {
        sourceId: 's1',
        autoResponderTriggers: [{ id: 'a1', trigger: 'x', responseType: 'script', response: '/data/scripts/shared.py' }],
      },
      {
        sourceId: 's2',
        timerTriggers: [{ id: 't1', name: 'T', scriptPath: '/data/scripts/shared.py' }],
      },
    ];
    const refs = computeScriptUsage(sources).get('shared.py');
    expect(refs).toHaveLength(2);
    expect(refs!.map(r => r.sourceId).sort()).toEqual(['s1', 's2']);
  });

  it('ignores malformed trigger data without throwing', () => {
    const sources: SourceTriggers[] = [
      { sourceId: 's1', autoResponderTriggers: 'not-an-array', timerTriggers: null, geofenceTriggers: undefined },
      { sourceId: 's2', timerTriggers: [{ id: 't', responseType: 'script' /* no scriptPath */ }] },
    ];
    expect(() => computeScriptUsage(sources)).not.toThrow();
    expect(computeScriptUsage(sources).size).toBe(0);
  });
});
