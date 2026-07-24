/**
 * Lifecycle tests for the ATAK/CoT Phase 3 feed server (issue #3691).
 * Exercises start/stop/restart/startFromSettings on real ephemeral TCP
 * ports (no `net` mocking — see docs/internal/dev-notes/ATAK_COT_PHASE3_SPEC.md
 * §5b). `databaseService` and `sourceManagerRegistry` are mocked so no real
 * DB/registry state is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'net';
import { logger } from '../../utils/logger.js';

vi.mock('../../services/database.js', () => {
  const shared = {
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
    atakContacts: { getContacts: vi.fn().mockResolvedValue([]) },
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
    meshcore: { getAllNodes: vi.fn().mockResolvedValue([]) },
  };
  return { default: shared };
});

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: vi.fn().mockReturnValue([]) },
}));

import databaseServiceMock from '../../services/database.js';
import { cotFeedService } from './cotFeedService.js';

type GetSettingMock = { mockImplementation: (fn: (key: string) => Promise<string | null>) => void };

function mockSettings(enabled: boolean, port?: number) {
  const getSetting = (databaseServiceMock as unknown as { settings: { getSetting: GetSettingMock } }).settings.getSetting;
  getSetting.mockImplementation(async (key: string) => {
    if (key === 'cotFeedEnabled') return enabled ? '1' : '0';
    if (key === 'cotFeedPort') return port !== undefined ? String(port) : null;
    return null;
  });
}

describe('CotFeedService lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await cotFeedService.stop();
    vi.restoreAllMocks();
  });

  it('startFromSettings with enabled=false leaves the feed not listening', async () => {
    mockSettings(false);
    await cotFeedService.startFromSettings();
    expect(cotFeedService.getStatus().listening).toBe(false);
  });

  it('startFromSettings with enabled=true and port=0 binds an ephemeral port', async () => {
    mockSettings(true, 0);
    await cotFeedService.startFromSettings();
    const status = cotFeedService.getStatus();
    expect(status.listening).toBe(true);
    expect(status.port).toBeGreaterThan(0);
  });

  it('toggling off after being up stops the server and clears clients (E10)', async () => {
    mockSettings(true, 0);
    await cotFeedService.startFromSettings();
    expect(cotFeedService.getStatus().listening).toBe(true);
    const port = cotFeedService.getStatus().port;

    // Connect a real client so we can verify it gets dropped.
    const net = await import('net');
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    // Give the snapshot-on-connect write a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cotFeedService.getStatus().clientCount).toBe(1);

    mockSettings(false);
    await cotFeedService.startFromSettings();

    expect(cotFeedService.getStatus().listening).toBe(false);
    expect(cotFeedService.getStatus().clientCount).toBe(0);

    await new Promise<void>((resolve) => {
      if (socket.destroyed) return resolve();
      socket.once('close', () => resolve());
    });
  });

  it('changing the port while enabled stops the old listener and binds the new one (E11)', async () => {
    mockSettings(true, 0);
    await cotFeedService.startFromSettings();
    const firstPort = cotFeedService.getStatus().port;
    expect(firstPort).toBeGreaterThan(0);

    mockSettings(true, 0);
    await cotFeedService.startFromSettings();
    const secondPort = cotFeedService.getStatus().port;
    expect(secondPort).toBeGreaterThan(0);
    expect(secondPort).not.toBe(firstPort);
    expect(cotFeedService.getStatus().listening).toBe(true);

    // The old port must be freed — a new listener can bind it directly.
    const probe: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(firstPort, '0.0.0.0', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it('EADDRINUSE never throws — start() resolves with listening=false and logs an error (E1)', async () => {
    const occupied: Server = createServer();
    const occupiedPort: number = await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '0.0.0.0', () => {
        const addr = occupied.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    mockSettings(true, occupiedPort);
    await expect(cotFeedService.startFromSettings()).resolves.toBeUndefined();

    const status = cotFeedService.getStatus();
    expect(status.listening).toBe(false);
    expect(logger.error).toHaveBeenCalled();

    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it('restart() is a no-op when already listening on the same port with the same enabled state', async () => {
    mockSettings(true, 0);
    await cotFeedService.startFromSettings();
    const port = cotFeedService.getStatus().port;

    await cotFeedService.restart({ enabled: true, port });
    expect(cotFeedService.getStatus().port).toBe(port);
    expect(cotFeedService.getStatus().listening).toBe(true);
  });
});
