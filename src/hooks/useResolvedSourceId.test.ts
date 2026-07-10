import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickPrimarySource, useResolvedSourceId } from './useResolvedSourceId';

// --- pure picker ----------------------------------------------------------

describe('pickPrimarySource', () => {
  it('prefers the earliest-created enabled meshtastic_tcp source', () => {
    const sources = [
      { id: 'mqtt', type: 'mqtt_bridge', enabled: true, createdAt: 1 },
      { id: 'tcp-late', type: 'meshtastic_tcp', enabled: true, createdAt: 30 },
      { id: 'tcp-early', type: 'meshtastic_tcp', enabled: true, createdAt: 20 },
    ];
    expect(pickPrimarySource(sources)?.id).toBe('tcp-early');
  });

  it('falls back to the earliest enabled source when no tcp source exists', () => {
    const sources = [
      { id: 'mc-late', type: 'meshcore', enabled: true, createdAt: 40 },
      { id: 'mqtt-early', type: 'mqtt_bridge', enabled: true, createdAt: 10 },
    ];
    expect(pickPrimarySource(sources)?.id).toBe('mqtt-early');
  });

  it('ignores disabled sources', () => {
    const sources = [
      { id: 'tcp-disabled', type: 'meshtastic_tcp', enabled: false, createdAt: 1 },
      { id: 'tcp-enabled', type: 'meshtastic_tcp', enabled: true, createdAt: 5 },
    ];
    expect(pickPrimarySource(sources)?.id).toBe('tcp-enabled');
  });

  it('returns undefined when there are no enabled sources', () => {
    expect(pickPrimarySource([{ id: 'x', type: 'meshcore', enabled: false }])).toBeUndefined();
    expect(pickPrimarySource([])).toBeUndefined();
  });
});

// --- hook ------------------------------------------------------------------

const mockUseSource = vi.fn();
const mockUseQuery = vi.fn();
vi.mock('../contexts/SourceContext', () => ({ useSource: () => mockUseSource() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (opts: unknown) => mockUseQuery(opts) }));
vi.mock('../init', () => ({ appBasename: '' }));

describe('useResolvedSourceId', () => {
  beforeEach(() => {
    mockUseSource.mockReset();
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue({ data: undefined });
  });

  it('returns the context sourceId when present (no fallback fetch)', () => {
    mockUseSource.mockReturnValue({ sourceId: 'ctx-src' });
    expect(useResolvedSourceId()).toBe('ctx-src');
    // fallback query is disabled when a context source exists
    expect(mockUseQuery.mock.calls[0][0].enabled).toBe(false);
  });

  it('returns undefined while the fallback list is loading', () => {
    mockUseSource.mockReturnValue({ sourceId: null });
    mockUseQuery.mockReturnValue({ data: undefined });
    expect(useResolvedSourceId()).toBeUndefined();
  });

  it('resolves the primary source when context is null', () => {
    mockUseSource.mockReturnValue({ sourceId: null });
    mockUseQuery.mockReturnValue({
      data: [
        { id: 'mqtt', type: 'mqtt_bridge', enabled: true, createdAt: 1 },
        { id: 'tcp', type: 'meshtastic_tcp', enabled: true, createdAt: 2 },
      ],
    });
    expect(useResolvedSourceId()).toBe('tcp');
    expect(mockUseQuery.mock.calls[0][0].enabled).toBe(true);
  });
});
