/**
 * Tests for MeshCoreManager.setTelemetryMode{Base,Loc,Env}.
 *
 * Exercises the same gating the existing `setAdvertLocPolicy` flow uses:
 *   - companion-only (repeater rejects)
 *   - input validation (mode must be always|device|never)
 *   - bridge payload shape ({ mode })
 *   - localNode reflects the saved mode after success
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import type { TelemetryMode } from './meshcoreManager.js';

interface TestableManager {
  deviceType: MeshCoreDeviceType;
  localNode: {
    publicKey: string;
    name: string;
    advType: MeshCoreDeviceType;
    telemetryModeBase?: TelemetryMode;
    telemetryModeLoc?: TelemetryMode;
    telemetryModeEnv?: TelemetryMode;
  };
  bridgeCalls: Array<{ cmd: string; params: Record<string, unknown> }>;
  bridgeFail?: boolean;
}

function makeManager(opts: {
  deviceType: MeshCoreDeviceType;
  bridgeFail?: boolean;
}): MeshCoreManager & TestableManager {
  const m = new MeshCoreManager('test-source') as MeshCoreManager & TestableManager;
  m.deviceType = opts.deviceType;
  m.localNode = {
    publicKey: 'pk',
    name: 'node',
    advType: opts.deviceType,
  };
  m.bridgeCalls = [];
  m.bridgeFail = opts.bridgeFail;
  // Replace the private bridge transport with a deterministic stub. This
  // mirrors how the existing test in this directory exercises pure logic
  // without spinning up the Python child process.
  // @ts-expect-error - replacing private member for unit testing
  m.sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    m.bridgeCalls.push({ cmd, params });
    if (m.bridgeFail) {
      return { id: '1', success: false, error: 'simulated failure' };
    }
    return { id: '1', success: true, data: params };
  };
  return m;
}

describe('MeshCoreManager telemetry mode setters', () => {
  let manager: ReturnType<typeof makeManager>;

  beforeEach(() => {
    manager = makeManager({ deviceType: MeshCoreDeviceType.COMPANION });
  });

  for (const [methodName, kind, field] of [
    ['setTelemetryModeBase', 'base', 'telemetryModeBase'],
    ['setTelemetryModeLoc', 'loc', 'telemetryModeLoc'],
    ['setTelemetryModeEnv', 'env', 'telemetryModeEnv'],
  ] as const) {
    describe(methodName, () => {
      it('sends set_telemetry_mode_X with the mode string and updates localNode', async () => {
        const ok = await (manager[methodName] as (m: TelemetryMode) => Promise<boolean>)('always');
        expect(ok).toBe(true);
        expect(manager.bridgeCalls).toEqual([
          { cmd: `set_telemetry_mode_${kind}`, params: { mode: 'always' } },
        ]);
        expect(manager.localNode[field]).toBe('always');
      });

      it('accepts all three modes (always|device|never)', async () => {
        for (const mode of ['always', 'device', 'never'] as TelemetryMode[]) {
          const ok = await (manager[methodName] as (m: TelemetryMode) => Promise<boolean>)(mode);
          expect(ok).toBe(true);
          expect(manager.localNode[field]).toBe(mode);
        }
        expect(manager.bridgeCalls.map(c => c.params.mode)).toEqual(['always', 'device', 'never']);
      });

      it('rejects invalid mode values with a thrown Error', async () => {
        await expect(
          (manager[methodName] as (m: unknown) => Promise<boolean>)('whatever'),
        ).rejects.toThrow(/always.*device.*never/);
        expect(manager.bridgeCalls).toHaveLength(0);
      });

      it('returns false without calling the bridge on repeater devices', async () => {
        const repeater = makeManager({ deviceType: MeshCoreDeviceType.REPEATER });
        const ok = await (repeater[methodName] as (m: TelemetryMode) => Promise<boolean>)('always');
        expect(ok).toBe(false);
        expect(repeater.bridgeCalls).toHaveLength(0);
        expect(repeater.localNode[field]).toBeUndefined();
      });

      it('returns false and leaves localNode unchanged when the bridge call fails', async () => {
        const failing = makeManager({ deviceType: MeshCoreDeviceType.COMPANION, bridgeFail: true });
        const ok = await (failing[methodName] as (m: TelemetryMode) => Promise<boolean>)('device');
        expect(ok).toBe(false);
        expect(failing.bridgeCalls).toHaveLength(1);
        expect(failing.localNode[field]).toBeUndefined();
      });
    });
  }
});
