/**
 * resolveLocalNodeNameForSource (#6251): the "Prefix with node name" option
 * must name the node of the notification's own source, not the primary
 * Meshtastic source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  managers: new Map<string, unknown>(),
  primary: undefined as unknown,
  getLocalNodeNumForSource: vi.fn(),
  getNode: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: { getLocalNodeNumForSource: h.getLocalNodeNumForSource },
    nodesRepo: { getNode: h.getNode },
  },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { sourceId: 'fallback', getLocalNodeInfo: () => null },
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => h.managers.get(id) },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: { kind?: string }) => m.kind === 'meshcore',
  isMeshtasticManager: (m: { kind?: string }) => m.kind === 'meshtastic',
  getPrimaryMeshtasticManager: () => h.primary,
}));

import { resolveLocalNodeNameForSource } from './localNodeNameForSource.js';

const meshtastic = (sourceId: string, longName: string | null) => ({
  kind: 'meshtastic',
  sourceId,
  getLocalNodeInfo: () => (longName ? { longName } : null),
});
const meshcore = (name: string | null) => ({ kind: 'meshcore', getLocalNode: () => (name ? { name } : null) });

beforeEach(() => {
  h.managers.clear();
  h.primary = undefined;
  h.getLocalNodeNumForSource.mockReset().mockResolvedValue(null);
  h.getNode.mockReset().mockResolvedValue(null);
});

describe('resolveLocalNodeNameForSource (#6251)', () => {
  it('uses the MeshCore device name for a MeshCore source, not the Meshtastic primary', async () => {
    h.primary = meshtastic('mt', 'Meshtastic Base');
    h.managers.set('mc', meshcore('MC Companion'));
    expect(await resolveLocalNodeNameForSource('mc')).toBe('MC Companion');
  });

  it('returns null for a MeshCore source with no local node yet', async () => {
    h.primary = meshtastic('mt', 'Meshtastic Base');
    h.managers.set('mc', meshcore(null));
    expect(await resolveLocalNodeNameForSource('mc')).toBeNull();
  });

  it('uses each Meshtastic source its own name', async () => {
    h.primary = meshtastic('mt-a', 'Node A');
    h.managers.set('mt-a', h.primary);
    h.managers.set('mt-b', meshtastic('mt-b', 'Node B'));
    expect(await resolveLocalNodeNameForSource('mt-b')).toBe('Node B');
  });

  it('falls back to the stored local node of that source when not connected', async () => {
    h.getLocalNodeNumForSource.mockResolvedValue('1234');
    h.getNode.mockResolvedValue({ longName: 'Stored Node' });
    expect(await resolveLocalNodeNameForSource('mt-offline')).toBe('Stored Node');
    expect(h.getLocalNodeNumForSource).toHaveBeenCalledWith('mt-offline');
    expect(h.getNode).toHaveBeenCalledWith(1234, 'mt-offline');
  });

  it('keeps the primary-source behaviour when no source id is given', async () => {
    h.primary = meshtastic('mt', 'Meshtastic Base');
    expect(await resolveLocalNodeNameForSource(undefined)).toBe('Meshtastic Base');
  });

  it('returns null rather than throwing when a lookup fails', async () => {
    h.getLocalNodeNumForSource.mockRejectedValue(new Error('db down'));
    expect(await resolveLocalNodeNameForSource('mt-x')).toBeNull();
  });
});
