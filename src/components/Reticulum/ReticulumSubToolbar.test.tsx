/**
 * @vitest-environment jsdom
 *
 * ReticulumSubToolbar (#3960) — the per-source nav. Phase 3 added two items:
 * 'map' and 'configuration'. 'configuration' was own-mode only until #6011
 * put the LXMF identity settings (display name, Announce now) on it; it now
 * shows in every mode, and the page itself hides the RNode radio form outside
 * own mode (ReticulumConfigurationView `showRadio`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReticulumSubToolbar } from './ReticulumSubToolbar';

// The nav foot links to Global Settings (#5683 follow-up) for a viewer with
// settings:read; GlobalSettingsLink.test.tsx covers that link.
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

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

  it.each(['own', 'attach', 'tcp_peer', null])('shows the configuration item in %s mode (#6011)', (mode) => {
    renderToolbar(mode);
    expect(item('configuration')).not.toBeNull();
  });

  it('keeps the pre-existing core items', () => {
    renderToolbar('own');
    for (const id of ['destinations', 'dms', 'interfaces', 'info', 'settings']) {
      expect(item(id)).not.toBeNull();
    }
    // sanity: the label text renders through the i18n fallback
    expect(screen.getByText('Device Configuration')).toBeTruthy();
  });

  // Phase 4 WP4: 'paths' (path table + probe + remote-fleet) exists in every
  // mode — no filtering, unlike 'configuration' above.
  it('shows the paths item in attach mode', () => {
    renderToolbar('attach');
    expect(item('paths')).not.toBeNull();
  });

  it('shows the paths item in tcp_peer mode', () => {
    renderToolbar('tcp_peer');
    expect(item('paths')).not.toBeNull();
  });

  it('shows the paths item in own mode', () => {
    renderToolbar('own');
    expect(item('paths')).not.toBeNull();
  });

  it('shows the paths item when mode is null/unknown', () => {
    renderToolbar(null);
    expect(item('paths')).not.toBeNull();
  });

  // #6118: Pin sidebar parity with Meshtastic and MeshCore. The pin control
  // only renders when `onTogglePin` is wired (SourceNav guards on it).
  it('renders the Pin sidebar control and fires onTogglePin when both props are set', () => {
    const onTogglePin = vi.fn();
    render(
      <ReticulumSubToolbar
        view="destinations"
        onSelect={() => {}}
        expanded
        onToggleExpanded={() => {}}
        pinned={false}
        onTogglePin={onTogglePin}
      />,
    );
    const pin = document.querySelector('[data-source-nav-pin]');
    expect(pin).not.toBeNull();
    expect(pin?.getAttribute('data-pinned')).toBe('false');
    fireEvent.click(pin as Element);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it('omits the Pin sidebar control when onTogglePin is not provided', () => {
    renderToolbar('own');
    expect(document.querySelector('[data-source-nav-pin]')).toBeNull();
  });
});
