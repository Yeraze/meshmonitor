/**
 * useMeshIssuesViewState — localStorage persistence unit tests (#4964 report
 * reorganization, WP3, spec §7.3/§10.1/§10.5).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_MESH_ISSUES_VIEW_STATE,
  sanitizeViewState,
  useMeshIssuesViewState,
  type MeshIssuesViewState,
} from './useMeshIssuesViewState';

const STORAGE_KEY = 'meshIssues.viewState.v1';

beforeEach(() => {
  localStorage.clear();
});

describe('sanitizeViewState (pure)', () => {
  it('returns the default state for null/undefined/non-object input', () => {
    expect(sanitizeViewState(null)).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
    expect(sanitizeViewState(undefined)).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
    expect(sanitizeViewState('a string')).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
    expect(sanitizeViewState(42)).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
    expect(sanitizeViewState([1, 2, 3])).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
  });

  it('returns the default state when `version` is missing or mismatched', () => {
    expect(sanitizeViewState({ view: 'byNode' })).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
    expect(sanitizeViewState({ version: 2, view: 'byNode' })).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
  });

  it('round-trips a well-formed state', () => {
    const state: MeshIssuesViewState = {
      version: 1,
      view: 'byNode',
      filters: {
        severities: ['critical'],
        tiers: ['B'],
        issueTypes: ['B7_coverage_shadow'],
        sources: ['src-1'],
        q: 'alice',
        includeClosed: true,
        includeDismissed: false,
      },
      sortByType: { B7_coverage_shadow: { key: 'distanceM', dir: 'asc' } },
      expandedTypes: ['B7_coverage_shadow'],
      expandedNodes: [123, 'mesh-wide'],
    };
    expect(sanitizeViewState(state)).toEqual(state);
  });

  it('drops unknown issue types from expandedTypes so a downgrade cannot poison the state', () => {
    const raw = { version: 1, expandedTypes: ['B7_coverage_shadow', 'Z9_future_rule'] };
    expect(sanitizeViewState(raw).expandedTypes).toEqual(['B7_coverage_shadow']);
  });

  it('drops unknown issue types from sortByType keys', () => {
    const raw = {
      version: 1,
      sortByType: {
        B7_coverage_shadow: { key: 'distanceM', dir: 'desc' },
        Z9_future_rule: { key: 'whatever', dir: 'asc' },
      },
    };
    expect(sanitizeViewState(raw).sortByType).toEqual({
      B7_coverage_shadow: { key: 'distanceM', dir: 'desc' },
    });
  });

  it('drops a malformed sortByType entry (bad dir, missing key)', () => {
    const raw = {
      version: 1,
      sortByType: {
        B7_coverage_shadow: { key: 'distanceM', dir: 'sideways' },
        A1_deprecated_role: { dir: 'asc' },
      },
    };
    expect(sanitizeViewState(raw).sortByType).toEqual({});
  });

  it('falls back to the default view when `view` is not a known value', () => {
    expect(sanitizeViewState({ version: 1, view: 'byGalaxy' }).view).toBe('byIssue');
  });

  it('sanitizes a malformed filters object rather than throwing', () => {
    const raw = { version: 1, filters: { severities: 'not-an-array', q: 42 } };
    const result = sanitizeViewState(raw);
    expect(result.filters.severities).toEqual([]);
    expect(result.filters.q).toBe('');
  });

  it('drops unknown severities and unknown issue types from filters', () => {
    const raw = {
      version: 1,
      filters: {
        severities: ['critical', 'apocalyptic'],
        issueTypes: ['B7_coverage_shadow', 'not_a_real_type'],
      },
    };
    const result = sanitizeViewState(raw);
    expect(result.filters.severities).toEqual(['critical']);
    expect(result.filters.issueTypes).toEqual(['B7_coverage_shadow']);
  });

  it('drops non-number/non-"mesh-wide" entries from expandedNodes', () => {
    const raw = { version: 1, expandedNodes: [123, 'mesh-wide', 'garbage', null, 456] };
    expect(sanitizeViewState(raw).expandedNodes).toEqual([123, 'mesh-wide', 456]);
  });
});

describe('useMeshIssuesViewState (hook)', () => {
  it('initializes from the default state when localStorage is empty', () => {
    const { result } = renderHook(() => useMeshIssuesViewState());
    expect(result.current[0]).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
  });

  it('initializes from a previously persisted state', () => {
    const stored: MeshIssuesViewState = {
      ...DEFAULT_MESH_ISSUES_VIEW_STATE,
      view: 'byNode',
      expandedTypes: ['B7_coverage_shadow'],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    const { result } = renderHook(() => useMeshIssuesViewState());
    expect(result.current[0]).toEqual(stored);
  });

  it('falls back to defaults when localStorage holds corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    const { result } = renderHook(() => useMeshIssuesViewState());
    expect(result.current[0]).toEqual(DEFAULT_MESH_ISSUES_VIEW_STATE);
  });

  it('persists a state update to localStorage', () => {
    const { result } = renderHook(() => useMeshIssuesViewState());
    act(() => {
      result.current[1]((prev) => ({ ...prev, view: 'byNode' }));
    });
    expect(result.current[0].view).toBe('byNode');
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(persisted.view).toBe('byNode');
  });

  it('does not crash the component when localStorage.setItem throws (Safari private mode)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const { result } = renderHook(() => useMeshIssuesViewState());
    expect(() => {
      act(() => {
        result.current[1]((prev) => ({ ...prev, view: 'byNode' }));
      });
    }).not.toThrow();
    expect(result.current[0].view).toBe('byNode');
    setItemSpy.mockRestore();
  });
});
