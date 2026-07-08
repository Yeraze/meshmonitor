/**
 * Tests for the unified SourceManagerRegistry accepting MeshCoreManager instances.
 * Part of WP1 for issue #3962 Phase 2.
 *
 * Verifies:
 *  1. MeshCoreManager is accepted by addManager and returned by getManager.
 *  2. isMeshCoreManager / isMeshtasticManager partition correctly in a mixed registry.
 *  3. Lifecycle: addManager → registered; removeManager → absent.
 *  4. Manual disconnect (stop() / disconnect()) leaves the manager registered.
 *  5. getAllStatuses() includes the meshcore status shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceManagerRegistry } from './sourceManagerRegistry.js';
import { MeshCoreManager, ConnectionType } from './meshcoreManager.js';
import { isMeshCoreManager, isMeshtasticManager } from './sourceManagerTypes.js';
import type { ISourceManager, SourceStatus } from './sourceManagerRegistry.js';

/**
 * Creates a MeshCoreManager with all I/O stubbed so no real serial/TCP is opened.
 */
function makeMeshCoreManager(sourceId = 'mc-1', sourceName = 'MeshCore Test'): MeshCoreManager {
  const mgr = new MeshCoreManager(sourceId, sourceName);
  // Stub connect so start() doesn't open a real port.
  vi.spyOn(mgr, 'connect').mockResolvedValue(true);
  // Stub disconnect so stop() doesn't hang.
  vi.spyOn(mgr, 'disconnect').mockResolvedValue(undefined);
  return mgr;
}

/**
 * Minimal meshtastic-shaped stub (only needs to satisfy ISourceManager for
 * mixed-registry tests — we don't start it).
 */
function makeMeshtasticStub(sourceId = 'mt-1'): ISourceManager {
  return {
    sourceId,
    sourceType: 'meshtastic_tcp',
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getStatus: (): SourceStatus => ({
      sourceId,
      sourceName: 'Meshtastic Test',
      sourceType: 'meshtastic_tcp',
      connected: true,
      nodeNum: 1234,
      nodeId: '!00001234',
    }),
    getLocalNodeInfo: () => ({
      nodeNum: 1234,
      nodeId: '!00001234',
      longName: 'Test Node',
      shortName: 'TN',
    }),
    startDistanceDeleteScheduler: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn<() => void>(),
  };
}

describe('SourceManagerRegistry + MeshCoreManager (WP1)', () => {
  let registry: SourceManagerRegistry;

  beforeEach(() => {
    registry = new SourceManagerRegistry();
  });

  describe('1. MeshCoreManager accepted and retrievable', () => {
    it('accepts a MeshCoreManager via addManager', async () => {
      const mgr = makeMeshCoreManager();
      await registry.addManager(mgr);
      expect(registry.getManager('mc-1')).toBe(mgr);
    });

    it('getManager returns undefined for unknown id', () => {
      expect(registry.getManager('no-such-id')).toBeUndefined();
    });

    it('MeshCoreManager has sourceType meshcore', () => {
      const mgr = new MeshCoreManager('mc-check');
      expect(mgr.sourceType).toBe('meshcore');
    });

    it('getStatus() no-arg returns correct shape', () => {
      const mgr = new MeshCoreManager('mc-status', 'My MeshCore');
      const status = mgr.getStatus();
      expect(status.sourceId).toBe('mc-status');
      expect(status.sourceName).toBe('My MeshCore');
      expect(status.sourceType).toBe('meshcore');
      expect(status.connected).toBe(false);
    });

    it('getStatus() uses stored sourceName when called with no arg', () => {
      const mgr = new MeshCoreManager('mc-s', 'Stored Name');
      expect(mgr.getStatus().sourceName).toBe('Stored Name');
    });

    it('getStatus(name) overrides stored sourceName', () => {
      const mgr = new MeshCoreManager('mc-s', 'Stored Name');
      expect(mgr.getStatus('Override Name').sourceName).toBe('Override Name');
    });

    it('getLocalNodeInfo() returns null', () => {
      const mgr = new MeshCoreManager('mc-ln');
      expect(mgr.getLocalNodeInfo()).toBeNull();
    });
  });

  describe('2. Type guards partition mixed-type registry', () => {
    it('isMeshCoreManager identifies meshcore managers', async () => {
      const mc = makeMeshCoreManager('mc-2');
      const mt = makeMeshtasticStub('mt-2');
      await registry.addManager(mc);
      await registry.addManager(mt);

      const allManagers = registry.getAllManagers();
      const meshcoreManagers = allManagers.filter(isMeshCoreManager);
      const meshtasticManagers = allManagers.filter(isMeshtasticManager);

      expect(meshcoreManagers).toHaveLength(1);
      expect(meshcoreManagers[0].sourceId).toBe('mc-2');
      expect(meshtasticManagers).toHaveLength(1);
      expect(meshtasticManagers[0].sourceId).toBe('mt-2');
    });

    it('isMeshCoreManager narrows to MeshCoreManager (accesses meshcore-specific methods)', async () => {
      const mc = makeMeshCoreManager('mc-3');
      await registry.addManager(mc);

      const found = registry.getManager('mc-3');
      expect(found).toBeDefined();
      if (found && isMeshCoreManager(found)) {
        // isConnected() is a MeshCoreManager-specific method — accessible after narrowing
        expect(typeof found.isConnected).toBe('function');
        expect(found.isConnected()).toBe(false);
      } else {
        expect.fail('Should have narrowed to MeshCoreManager');
      }
    });

    it('isMeshtasticManager does not match meshcore managers', async () => {
      const mc = makeMeshCoreManager('mc-4');
      await registry.addManager(mc);

      const found = registry.getManager('mc-4');
      expect(found && isMeshtasticManager(found)).toBe(false);
    });
  });

  describe('3. Registry lifecycle', () => {
    it('addManager → getManager present; removeManager → absent', async () => {
      const mgr = makeMeshCoreManager('mc-5');
      await registry.addManager(mgr);
      expect(registry.getManager('mc-5')).toBe(mgr);

      await registry.removeManager('mc-5');
      expect(registry.getManager('mc-5')).toBeUndefined();
    });

    it('addManager calls start() which delegates to connect()', async () => {
      const mgr = makeMeshCoreManager('mc-6');
      mgr.configure({ connectionType: ConnectionType.SERIAL, serialPort: '/dev/ttyACM0', baudRate: 115200, firmwareType: 'companion' });
      await registry.addManager(mgr);
      // connect is stubbed to return true; start() calls connect(pendingConfig)
      expect(vi.mocked(mgr.connect)).toHaveBeenCalled();
    });

    it('removeManager calls stop() which delegates to disconnect()', async () => {
      const mgr = makeMeshCoreManager('mc-7');
      await registry.addManager(mgr);
      await registry.removeManager('mc-7');
      expect(vi.mocked(mgr.disconnect)).toHaveBeenCalled();
    });

    it('addManager throws if the same sourceId is registered twice', async () => {
      const mgr1 = makeMeshCoreManager('mc-dup');
      const mgr2 = makeMeshCoreManager('mc-dup');
      await registry.addManager(mgr1);
      await expect(registry.addManager(mgr2)).rejects.toThrow('already registered');
    });
  });

  describe('4. Manual disconnect keeps manager registered (load-bearing behavior)', () => {
    it('calling stop() directly does NOT remove from registry', async () => {
      const mgr = makeMeshCoreManager('mc-8');
      await registry.addManager(mgr);

      // Manual disconnect: call stop() directly on the manager (not removeManager)
      await mgr.stop();
      expect(vi.mocked(mgr.disconnect)).toHaveBeenCalled();

      // Manager must still be in the registry — routes depend on this
      expect(registry.getManager('mc-8')).toBe(mgr);
    });

    it('calling disconnect() directly does NOT remove from registry', async () => {
      const mgr = makeMeshCoreManager('mc-9');
      await registry.addManager(mgr);

      await mgr.disconnect();
      expect(vi.mocked(mgr.disconnect)).toHaveBeenCalled();

      expect(registry.getManager('mc-9')).toBe(mgr);
    });
  });

  describe('5. getAllStatuses includes meshcore shape', () => {
    it('getAllStatuses returns meshcore manager status', async () => {
      const mgr = makeMeshCoreManager('mc-10', 'My MeshCore Node');
      await registry.addManager(mgr);

      const statuses = registry.getAllStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatchObject({
        sourceId: 'mc-10',
        sourceName: 'My MeshCore Node',
        sourceType: 'meshcore',
        connected: false,
      });
    });

    it('getAllStatuses returns both meshtastic and meshcore statuses', async () => {
      const mc = makeMeshCoreManager('mc-11', 'MeshCore');
      const mt = makeMeshtasticStub('mt-11');
      await registry.addManager(mc);
      await registry.addManager(mt);

      const statuses = registry.getAllStatuses();
      expect(statuses).toHaveLength(2);
      const sourceTypes = statuses.map(s => s.sourceType).sort();
      expect(sourceTypes).toEqual(['meshcore', 'meshtastic_tcp']);
    });
  });

  describe('setSourceName', () => {
    it('updates stored name used by no-arg getStatus()', () => {
      const mgr = new MeshCoreManager('mc-sn', 'Original');
      expect(mgr.getStatus().sourceName).toBe('Original');
      mgr.setSourceName('Renamed');
      expect(mgr.getStatus().sourceName).toBe('Renamed');
    });
  });

  describe('configure + start()', () => {
    it('start() without configure() logs warning and does not call connect()', async () => {
      const mgr = new MeshCoreManager('mc-nocfg');
      vi.spyOn(mgr, 'connect').mockResolvedValue(true);
      // No configure() call
      await mgr.start();
      expect(vi.mocked(mgr.connect)).not.toHaveBeenCalled();
    });

    it('start() after configure() calls connect() with pendingConfig', async () => {
      const mgr = new MeshCoreManager('mc-cfg');
      vi.spyOn(mgr, 'connect').mockResolvedValue(true);
      const cfg = { connectionType: ConnectionType.SERIAL, serialPort: '/dev/ttyACM0', baudRate: 115200, firmwareType: 'companion' as const };
      mgr.configure(cfg);
      await mgr.start();
      expect(vi.mocked(mgr.connect)).toHaveBeenCalledWith(cfg);
    });
  });
});
