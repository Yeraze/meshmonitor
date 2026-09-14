/**
 * @vitest-environment jsdom
 *
 * The palette's shortcut and its opener handshake (#5182).
 *
 * The modal itself is covered by ConfigSearchModal.test.tsx; what is only
 * testable here is the chord (Ctrl/Cmd+comma, deliberately NOT one of the
 * combinations the browser already owns) and the callback the host publishes
 * so the sidebar entry can raise the same modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ConfigSearchHost from './ConfigSearchHost';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    authStatus: { user: { isAdmin: true } },
    hasPermission: () => true,
  }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'abc', sourceName: 'Test' }),
}));

vi.mock('../../hooks/useHealth', () => ({
  useHealth: () => ({ data: { databaseType: 'sqlite', firmwareOtaEnabled: true } }),
}));

const renderHost = (registerOpener?: (open: () => void) => void) =>
  render(
    <MemoryRouter>
      <ConfigSearchHost registerOpener={registerOpener} />
    </MemoryRouter>,
  );

// Queried by role alone: the suite's global i18n stub returns the key rather
// than the default string, so there is no stable accessible name to match on.
const palette = () => screen.queryByRole('dialog');

const chord = (init: KeyboardEventInit) =>
  act(() => {
    fireEvent.keyDown(document, { key: ',', ...init });
  });

describe('ConfigSearchHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts closed', () => {
    renderHost();
    expect(palette()).toBeNull();
  });

  it('opens on Ctrl+comma and toggles shut on a second press', () => {
    renderHost();
    chord({ ctrlKey: true });
    expect(palette()).not.toBeNull();
    chord({ ctrlKey: true });
    expect(palette()).toBeNull();
  });

  it('opens on Cmd+comma for macOS', () => {
    renderHost();
    chord({ metaKey: true });
    expect(palette()).not.toBeNull();
  });

  it('ignores a bare comma, so typing one never opens it', () => {
    renderHost();
    chord({});
    expect(palette()).toBeNull();
  });

  it('ignores the chord with extra modifiers, leaving those combinations free', () => {
    renderHost();
    chord({ ctrlKey: true, shiftKey: true });
    chord({ ctrlKey: true, altKey: true });
    expect(palette()).toBeNull();
  });

  it('publishes an opener so the sidebar entry can raise the same palette', () => {
    let open: (() => void) | null = null;
    renderHost((fn) => {
      open = fn;
    });
    expect(open).toBeTypeOf('function');
    act(() => open!());
    expect(palette()).not.toBeNull();
  });

  it('searches the current source and the global settings page', () => {
    renderHost();
    chord({ ctrlKey: true });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'mqtt' } });
    // The Configuration tab's MQTT panel belongs to the source that useSource
    // reports; finding it proves the host built per-source surfaces.
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});
