/**
 * @vitest-environment jsdom
 *
 * Phase 6 (#4416, WP5) regression: 'settings' became a sourcey resource, and
 * AuthContext.hasPermission's sourcey branch hard-returns false whenever no
 * sourceId is resolved and `anySource` isn't passed (no cross-source leak —
 * see AuthContext.test.tsx:212). The Sidebar's Settings nav gate
 * (Sidebar.tsx:~240) sits outside any single-source context, so it must pass
 * `{ anySource: true }` or every non-admin holding a per-source-only
 * settings:read grant loses the Settings nav entry entirely, even though the
 * backend would authorize their requests (PHASE6 spec §5.2, R2).
 *
 * `fakeHasPermission` below reproduces AuthContext's real sourcey branch
 * shape (not just fixed booleans): true only for `{ anySource: true }` or a
 * matching `{ sourceId }`, false for a bare call with no opts. This is what
 * lets these tests fail if Sidebar.tsx's Settings nav call site regresses to
 * the pre-WP5, no-opts form — see the WP5 report for the observed failure
 * from actually reverting that line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import Sidebar from './Sidebar';
import type { ResourceType } from '../types/permission';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',}));

const baseProps = {
  activeTab: 'nodes' as const,
  setActiveTab: vi.fn(),
  isAdmin: false,
  isAuthenticated: true,
  unreadCounts: {},
  unreadCountsData: null,
  onMessagesClick: vi.fn(),
  onChannelsClick: vi.fn(),
  baseUrl: '',
};

const GRANTED_SOURCE = 'src-a';

/**
 * Models a non-admin holding 'settings':'read' on GRANTED_SOURCE only —
 * AuthContext's real sourcey semantics: true for `{ anySource: true }`, true
 * for a matching `{ sourceId }`, false for a mismatched sourceId, and false
 * for no opts at all (the hard-false "no cross-source leak" rule).
 */
const fakeHasPermission = (
  resource: ResourceType,
  _action: 'read' | 'write',
  opts?: { sourceId?: string | null; anySource?: boolean }
): boolean => {
  if (resource !== 'settings') return false;
  if (opts?.anySource) return true;
  if (opts?.sourceId) return opts.sourceId === GRANTED_SOURCE;
  return false;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar — Settings nav entry visibility for a per-source-only settings grant (#4416)', () => {
  it('shows the Settings nav entry for a per-source-only grant (Sidebar must pass anySource)', () => {
    render(<Sidebar {...baseProps} hasPermission={fakeHasPermission} />);
    expect(screen.queryByTitle('nav.settings')).not.toBeNull();
  });

  it('sanity check: the fake itself denies an unscoped call (proves the fixture is not a rubber stamp)', () => {
    expect(fakeHasPermission('settings', 'read')).toBe(false);
    expect(fakeHasPermission('settings', 'read', { sourceId: 'some-other-source' })).toBe(false);
    expect(fakeHasPermission('settings', 'read', { anySource: true })).toBe(true);
  });
});
