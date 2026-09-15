/**
 * @vitest-environment jsdom
 *
 * Issue #5233 regression pins for the Channels drag-to-reorder handle.
 *
 * The bug was a single missing CSS property, not a logic error: the handle
 * wired up dnd-kit exactly like its siblings but omitted `touch-action: none`,
 * so the browser claimed the touch gesture before `PointerSensor` saw a
 * `pointermove` and an iOS long-press raised the text-selection UI instead of
 * starting a drag. Desktop was unaffected — a mouse never contends for the
 * gesture — which is why it shipped.
 *
 * The pin is on the rendered element rather than the constant alone, because
 * spreading the constant is the part a future handle can forget.
 *
 * The matching pin for the Dashboard sources handle lives in
 * DashboardSidebar.test.tsx, where the Edit-mode harness that reveals it
 * already exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DRAG_HANDLE_TOUCH_STYLE } from './dragHandleStyle';
import ChannelsConfigSection from './configuration/ChannelsConfigSection';
import apiService from '../services/api';
import type { Channel } from '../types/device';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ settings: {}, updateSetting: vi.fn() }),
}));

vi.mock('../hooks/useResolvedSourceId', () => ({
  useResolvedSourceId: () => 'src-1',
}));

/**
 * Assert the properties that make an activator draggable under a finger.
 *
 * `-webkit-touch-callout` is deliberately not checked here: jsdom's CSS
 * implementation doesn't know the property and drops it on serialization, so
 * the element can never report it no matter what React rendered. It is pinned
 * on the constant instead, one describe below.
 */
function expectTouchDraggable(handle: HTMLElement) {
  expect(handle.style.touchAction).toBe('none');
  expect(handle.style.userSelect).toBe('none');
  expect(handle.style.getPropertyValue('-webkit-user-select')).toBe('none');
}

describe('DRAG_HANDLE_TOUCH_STYLE', () => {
  it('carries every property a touch drag activator needs', () => {
    expect(DRAG_HANDLE_TOUCH_STYLE).toEqual({
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
    });
  });

  it('sets touch-action: none — the property whose absence caused #5233', () => {
    // Pinned on its own: the other three only suppress the selection UI.
    // This is the one that lets the drag start at all.
    expect(DRAG_HANDLE_TOUCH_STYLE.touchAction).toBe('none');
  });
});

describe('Channels reorder handle (#5233)', () => {
  const channels = [
    { id: 0, name: 'Primary', psk: 'AQ==', role: 1, uplinkEnabled: false, downlinkEnabled: false },
    { id: 1, name: 'LongTurbo', psk: 'AQ==', role: 2, uplinkEnabled: false, downlinkEnabled: false },
  ] as Channel[];

  const renderSection = () =>
    render(
      <MemoryRouter>
        <ChannelsConfigSection channels={channels} />
      </MemoryRouter>,
    );

  beforeEach(() => {
    vi.restoreAllMocks();
    // Spy on the real singleton rather than replacing the module: apiService is
    // a class instance, so a mock built by spreading its default export drops
    // every prototype method (setBaseUrl among them) and the import chain
    // throws at load time.
    vi.spyOn(apiService, 'get').mockResolvedValue([] as never);
  });

  it('renders a handle a finger can actually drag', () => {
    renderSection();

    const handles = screen.getAllByTestId('channel-drag-handle');
    expect(handles.length).toBeGreaterThan(0);
    handles.forEach(expectTouchDraggable);
  });

  it('draws the handle as an icon, not selectable glyph text', () => {
    // The old markup was a bare ⠿ braille character — selectable content, and
    // what the long-press actually selected. It also broke the project's
    // "app-owned interface icons use UiIcon" rule.
    renderSection();

    const handle = screen.getAllByTestId('channel-drag-handle')[0];
    expect(handle.textContent).not.toContain('⠿');
    expect(handle.querySelector('svg')).not.toBeNull();
  });
});
