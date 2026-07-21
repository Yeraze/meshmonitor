/**
 * resolveSourceManager — regression tests for FIX 1 (GAP-M5), migrated in
 * #3962 Phase 4.2a WP4 (Proxy-alias retirement, keystone consumer).
 *
 * Verifies that:
 * - A meshtastic sourceId returns the registered manager (not the primary/fallback).
 * - A meshcore sourceId falls back to the primary/fallback manager without crashing.
 * - An absent sourceId returns the primary manager, or `fallbackManager` when
 *   no primary is registered (invariant I2: NEVER returns undefined).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they're available inside vi.mock factory closures.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  mockFallbackManager: { sourceId: '__fallback__', sourceType: 'meshtastic_tcp' } as const,
  mockRegistry: { getManager: vi.fn() },
  mockGetPrimaryMeshtasticManager: vi.fn(),
}));

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: h.mockFallbackManager,
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: h.mockRegistry,
}));

vi.mock('../sourceManagerTypes.js', async () => {
  const actual = await vi.importActual<typeof import('../sourceManagerTypes.js')>(
    '../sourceManagerTypes.js'
  );
  return {
    ...actual,
    getPrimaryMeshtasticManager: h.mockGetPrimaryMeshtasticManager,
  };
});

import { resolveSourceManager } from './resolveSourceManager.js';

describe('resolveSourceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockGetPrimaryMeshtasticManager.mockReturnValue(undefined);
  });

  it('returns fallbackManager when no sourceId is given and no primary is registered', () => {
    const result = resolveSourceManager(undefined);
    expect(result).toBe(h.mockFallbackManager);
    expect(h.mockRegistry.getManager).not.toHaveBeenCalled();
  });

  it('returns the registered primary manager when no sourceId is given and a primary exists', () => {
    const primary = { sourceId: 'mt-primary', sourceType: 'meshtastic_tcp' };
    h.mockGetPrimaryMeshtasticManager.mockReturnValue(primary);

    const result = resolveSourceManager(undefined);
    expect(result).toBe(primary);
  });

  it('returns the registered meshtastic manager for a meshtastic sourceId', () => {
    const registeredManager = { sourceId: 'mt-src', sourceType: 'meshtastic_tcp' };
    h.mockRegistry.getManager.mockReturnValue(registeredManager);

    const result = resolveSourceManager('mt-src');
    expect(result).toBe(registeredManager);
    expect(h.mockRegistry.getManager).toHaveBeenCalledWith('mt-src');
  });

  it('falls back to fallbackManager for a meshcore sourceId (no TypeError, no primary)', () => {
    const meshcoreManager = { sourceId: 'mc-src', sourceType: 'meshcore' };
    h.mockRegistry.getManager.mockReturnValue(meshcoreManager);

    // Should not throw, should return fallbackManager (no primary registered).
    expect(() => {
      const result = resolveSourceManager('mc-src');
      expect(result).toBe(h.mockFallbackManager);
    }).not.toThrow();
  });

  it('falls back to fallbackManager when sourceId is not registered and no primary exists', () => {
    h.mockRegistry.getManager.mockReturnValue(undefined);

    const result = resolveSourceManager('unknown-id');
    expect(result).toBe(h.mockFallbackManager);
  });

  it('never returns undefined (invariant I2)', () => {
    h.mockRegistry.getManager.mockReturnValue(undefined);
    h.mockGetPrimaryMeshtasticManager.mockReturnValue(undefined);

    expect(resolveSourceManager(undefined)).toBeDefined();
    expect(resolveSourceManager(null)).toBeDefined();
    expect(resolveSourceManager('some-id')).toBeDefined();
  });
});
