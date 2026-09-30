/**
 * Repeater Configuration fields (#5496). refreshLocalNode() used to read only
 * `get name` and `get radio`, so TX power and position showed defaults. It now
 * also reads the firmware's `get tx`, `get lat` and `get lon`.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, parseRepeaterNumber } from './meshcoreManager.js';

function repeaterManager(replies: Record<string, string>) {
  const m = new MeshCoreManager('src-rep');
  (m as any).deviceType = MeshCoreDeviceType.REPEATER;
  const sent: string[] = [];
  (m as any).sendRepeaterCommand = async (cmd: string) => {
    sent.push(cmd);
    return replies[cmd] ?? '  -> Error: unknown config';
  };
  return { m, sent };
}

describe('MeshCoreManager.refreshLocalNode — repeater (#5496)', () => {
  it('reads TX power and position alongside name and radio', async () => {
    const { m, sent } = repeaterManager({
      'get name': '  -> > MC HR ZG SQ42',
      'get radio': '  -> > 869.6179809,62.5,8,8',
      'get tx': '  -> > 22',
      'get lat': '  -> > 45.815',
      'get lon': '  -> > -15.9819',
    });

    const node = await m.refreshLocalNode();

    expect(sent).toEqual(expect.arrayContaining(['get tx', 'get lat', 'get lon']));
    expect(node).toMatchObject({
      name: 'MC HR ZG SQ42',
      txPower: 22,
      latitude: 45.815,
      longitude: -15.9819,
      radioFreq: 869.6179809,
      radioBw: 62.5,
      radioSf: 8,
      radioCr: 8,
    });
  });

  it('leaves a field unknown when the firmware does not answer it', async () => {
    const { m } = repeaterManager({
      'get name': '  -> > Old Repeater',
      'get radio': '  -> > 910.525,62.5,7,5',
    });

    const node = await m.refreshLocalNode();

    expect(node?.txPower).toBeUndefined();
    expect(node?.latitude).toBeUndefined();
    expect(node?.longitude).toBeUndefined();
    expect(node?.radioFreq).toBe(910.525);
  });
});

describe('parseRepeaterNumber', () => {
  it.each([
    ['  -> > 22', 'int', 22],
    ['> -3', 'int', -3],
    ['  -> > 45.815', 'float', 45.815],
    ['> -15.9819', 'float', -15.9819],
    ['> 0.0', 'float', 0],
  ] as const)('parses %j as %s', (reply, kind, expected) => {
    expect(parseRepeaterNumber(reply, kind)).toBe(expected);
  });

  it.each([
    ['  -> Error: unknown config'],
    [''],
    ['> abc'],
  ])('returns undefined for %j', (reply) => {
    expect(parseRepeaterNumber(reply, 'float')).toBeUndefined();
  });

  it('returns undefined for null and undefined', () => {
    expect(parseRepeaterNumber(null, 'int')).toBeUndefined();
    expect(parseRepeaterNumber(undefined, 'int')).toBeUndefined();
  });
});
