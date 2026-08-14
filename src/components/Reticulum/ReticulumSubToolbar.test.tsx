/**
 * @vitest-environment jsdom
 *
 * ReticulumSubToolbar (#3960) — the per-source nav. Phase 3 added two items:
 * 'map' (always shown) and 'configuration' (own-mode only, since editable
 * RNode radio config exists only when the bridge owns the radio). These tests
 * lock in that gating so a mode regression can't silently expose the radio
 * form on an attach/tcp_peer source.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReticulumSubToolbar } from './ReticulumSubToolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

function renderToolbar(sourceMode?: string | null) {
  return render(
    <ReticulumSubToolbar
      view="destinations"
      onSelect={() => {}}
      expanded
      onToggleExpanded={() => {}}
      sourceMode={sourceMode}
    />,
  );
}

const item = (id: string) => document.querySelector(`[data-source-nav-item="${id}"]`);

describe('ReticulumSubToolbar', () => {
  it('always shows the map item regardless of mode', () => {
    renderToolbar('attach');
    expect(item('map')).not.toBeNull();
  });

  it('shows the configuration item only in own mode', () => {
    renderToolbar('own');
    expect(item('configuration')).not.toBeNull();
  });

  it('hides the configuration item in attach mode', () => {
    renderToolbar('attach');
    expect(item('configuration')).toBeNull();
  });

  it('hides the configuration item when mode is null/unknown', () => {
    renderToolbar(null);
    expect(item('configuration')).toBeNull();
  });

  it('keeps the pre-existing core items', () => {
    renderToolbar('own');
    for (const id of ['destinations', 'dms', 'interfaces', 'info', 'settings']) {
      expect(item(id)).not.toBeNull();
    }
    // sanity: the label text renders through the i18n fallback
    expect(screen.getByText('Configuration')).toBeTruthy();
  });
});
