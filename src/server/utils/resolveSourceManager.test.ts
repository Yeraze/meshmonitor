/**
 * resolveSourceManager — regression tests for FIX 1 (GAP-M5).
 *
 * Verifies that:
 * - A meshtastic sourceId returns the registered manager (not the singleton).
 * - A meshcore sourceId falls back to the singleton without crashing.
 * - An absent sourceId returns the singleton.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they're available inside vi.mock factory closures.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  mockMeshtasticManager: { sourceId: '__singleton__', sourceType: 'meshtastic_tcp' } as const,
  mockRegistry: { getManager: vi.fn() },
}));

vi.mock('../meshtasticManager.js', () => ({
  default: h.mockMeshtasticManager,
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: h.mockRegistry,
}));

import { resolveSourceManager } from './resolveSourceManager.js';

describe('resolveSourceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the singleton when no sourceId is given', () => {
    const result = resolveSourceManager(undefined);
    expect(result).toBe(h.mockMeshtasticManager);
    expect(h.mockRegistry.getManager).not.toHaveBeenCalled();
  });

  it('returns the registered meshtastic manager for a meshtastic sourceId', () => {
    const registeredManager = { sourceId: 'mt-src', sourceType: 'meshtastic_tcp' };
    h.mockRegistry.getManager.mockReturnValue(registeredManager);

    const result = resolveSourceManager('mt-src');
    expect(result).toBe(registeredManager);
    expect(h.mockRegistry.getManager).toHaveBeenCalledWith('mt-src');
  });

  it('falls back to the singleton for a meshcore sourceId (no TypeError)', () => {
    const meshcoreManager = { sourceId: 'mc-src', sourceType: 'meshcore' };
    h.mockRegistry.getManager.mockReturnValue(meshcoreManager);

    // Should not throw, should return the singleton
    expect(() => {
      const result = resolveSourceManager('mc-src');
      expect(result).toBe(h.mockMeshtasticManager);
    }).not.toThrow();
  });

  it('falls back to the singleton when sourceId is not registered', () => {
    h.mockRegistry.getManager.mockReturnValue(undefined);

    const result = resolveSourceManager('unknown-id');
    expect(result).toBe(h.mockMeshtasticManager);
  });
});
