/**
 * @vitest-environment jsdom
 * Disabled sources are not import targets (#5891 P3).
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('./useWalkabout', () => ({
  useWalkaboutSources: () => ({
    data: [
      { id: 'on', name: 'On', type: 'meshtastic_tcp', enabled: true },
      { id: 'off', name: 'Off', type: 'meshtastic_tcp', enabled: false },
    ],
  }),
}));
vi.mock('../utils/coverageImport', async (orig) => ({
  ...(await orig<object>()),
  coverageImportProtocolFor: () => 'meshtastic',
}));

import { useCoverageImportSources } from './useCoverageImports';

describe('useCoverageImportSources', () => {
  it('drops disabled sources for write but keeps them for read', () => {
    const all = () => true;
    expect(renderHook(() => useCoverageImportSources(all, 'write')).result.current.map((s) => s.id)).toEqual(['on']);
    expect(renderHook(() => useCoverageImportSources(all, 'read')).result.current.map((s) => s.id)).toEqual(['on', 'off']);
  });
});
