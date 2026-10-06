/**
 * @vitest-environment jsdom
 *
 * #5645: the chat NodePopup's status block, relative last-heard line, and
 * keyboard/focus handling. The status block belongs to THIS popup only; the
 * last suite checks it does not leak into the map popups that share the
 * `NodeCardModel`.
 */
import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NodePopup } from './NodePopup';
import DashboardNodePopup from '../Dashboard/DashboardNodePopup';
import { toNodeCardModel } from '../map/popups/nodeCardModel';
import type { DeviceInfo } from '../../types/device';
import type { NodePopupState } from '../../types/ui';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useDisplaySettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

const NODE_ID = '!0000002a';
const now = () => Math.floor(Date.now() / 1000);

function makeNode(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    nodeNum: 42,
    user: { id: NODE_ID, longName: 'Tower Node', shortName: 'TWR', role: '2', hwModel: 9 },
    position: { latitude: 35.1, longitude: -80.6 },
    hopsAway: 3,
    lastHeard: now() - 120,
    ...overrides,
  };
}

const popupState: NodePopupState = { nodeId: NODE_ID, position: { x: 100, y: 400 }, anchorBottom: 432 };

function renderPopup(node: DeviceInfo, extra: Partial<React.ComponentProps<typeof NodePopup>> = {}) {
  const props = {
    nodePopup: popupState,
    nodes: [node],
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    hasPermission: () => true,
    onDMNode: vi.fn(),
    onShowOnMap: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
  return { props, ...render(<NodePopup {...props} />) };
}

describe('NodePopup status block (#5645)', () => {
  it('shows the full status text when the node has one', () => {
    const status = '📡 Monitoring 146.520\nback at 18:00';
    renderPopup(makeNode({ nodeStatus: status }));
    const block = screen.getByTestId('popup-node-status');
    expect(within(block).getByText('Status')).toBeInTheDocument();
    // Verbatim, line break and all; the full text is on `title` for the clamp.
    const text = block.querySelector('[title]') as HTMLElement;
    expect(text.textContent).toBe(status);
    expect(text).toHaveAttribute('title', status);
  });

  it('omits the block entirely for a node with no status', () => {
    renderPopup(makeNode());
    expect(screen.queryByTestId('popup-node-status')).toBeNull();
    expect(screen.queryByText('Status')).toBeNull();
  });

  it('omits the block for an empty status', () => {
    renderPopup(makeNode({ nodeStatus: '' }));
    expect(screen.queryByTestId('popup-node-status')).toBeNull();
  });

  it('updates in place when the status changes while the popup is open', () => {
    const { props, rerender } = renderPopup(makeNode({ nodeStatus: '🏠 At home' }));
    expect(screen.getByTestId('popup-node-status')).toHaveTextContent('🏠 At home');

    rerender(<NodePopup {...props} nodes={[makeNode({ nodeStatus: '🚗 Driving' })]} />);
    expect(screen.getByTestId('popup-node-status')).toHaveTextContent('🚗 Driving');
    expect(screen.queryByText('🏠 At home')).toBeNull();

    rerender(<NodePopup {...props} nodes={[makeNode()]} />);
    expect(screen.queryByTestId('popup-node-status')).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('renders a hostile status as text, with no alert styling', () => {
    const status = '🆘 <img src=x onerror=alert(1)> <script>alert(2)</script>';
    const { container } = renderPopup(makeNode({ nodeStatus: status }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    const block = screen.getByTestId('popup-node-status');
    expect(block.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(block.querySelector('[role="alert"]')).toBeNull();

    const plain = render(<NodePopup {...{
      nodePopup: popupState, nodes: [makeNode({ nodeStatus: 'fine' })], timeFormat: '24', dateFormat: 'MM/DD/YYYY',
      hasPermission: () => true, onDMNode: vi.fn(), onShowOnMap: vi.fn(), onClose: vi.fn(),
    }} />);
    const plainBlock = within(plain.container).getByTestId('popup-node-status');
    expect(block.className).toBe(plainBlock.className);
  });
});

describe('NodePopup last heard (#5645)', () => {
  it('shows a relative time with the absolute time on hover', () => {
    renderPopup(makeNode({ lastHeard: now() - 120 }));
    const line = screen.getByTestId('popup-last-heard');
    expect(line).toHaveTextContent('2 minutes ago');
    expect(line.getAttribute('title')).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(line.className).toBe('node-popup-footer');
  });

  it('dims the line for a node unheard for more than a day', () => {
    renderPopup(makeNode({ lastHeard: now() - 3 * 24 * 3600 }));
    const line = screen.getByTestId('popup-last-heard');
    expect(line).toHaveTextContent('3 days ago');
    expect(line.className).not.toBe('node-popup-footer');
    expect(line).toHaveClass('node-popup-footer');
  });

  it('shows no last-heard line when the node was never heard', () => {
    renderPopup(makeNode({ lastHeard: undefined }));
    expect(screen.queryByTestId('popup-last-heard')).toBeNull();
  });
});

describe('NodePopup keyboard and focus (#5645)', () => {
  function withTrigger() {
    const trigger = document.createElement('button');
    trigger.textContent = 'Tower Node';
    document.body.appendChild(trigger);
    trigger.focus();
    return trigger;
  }

  it('is a labelled dialog and takes focus when it opens', () => {
    renderPopup(makeNode());
    const dialog = screen.getByRole('dialog', { name: 'Tower Node' });
    expect(document.activeElement).toBe(dialog);
  });

  it('Escape closes and returns focus to the trigger', () => {
    const trigger = withTrigger();
    const { props } = renderPopup(makeNode(), { nodePopup: { ...popupState, trigger } });
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('Escape still closes when the trigger has left the page', () => {
    const trigger = withTrigger();
    const { props } = renderPopup(makeNode(), { nodePopup: { ...popupState, trigger } });
    trigger.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('other keys do not close it', () => {
    const { props } = renderPopup(makeNode());
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once closed', () => {
    const { props, rerender } = renderPopup(makeNode());
    rerender(<NodePopup {...props} nodePopup={null} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('keeps Tab inside the popup', () => {
    renderPopup(makeNode());
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(1);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // From the frame itself (where focus lands on open), Shift+Tab wraps too.
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('moves focus into the popup again when another trigger re-targets it', () => {
    const { props, rerender } = renderPopup(makeNode());
    const outside = withTrigger();
    expect(document.activeElement).toBe(outside);
    rerender(<NodePopup {...props} nodePopup={{ ...popupState, position: { x: 300, y: 500 } }} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    outside.remove();
  });

  it('flips below the trigger when there is no room above', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 300, width: 280, top: 0, left: 0, right: 280, bottom: 300, x: 0, y: 0, toJSON: () => ({}),
    });
    try {
      const { unmount } = renderPopup(makeNode(), {
        nodePopup: { nodeId: NODE_ID, position: { x: 200, y: 40 }, anchorBottom: 72 },
      });
      const below = screen.getByRole('dialog');
      expect(below).toHaveAttribute('data-placement', 'below');
      expect(below.style.top).toBe('82px');
      unmount();

      renderPopup(makeNode(), {
        nodePopup: { nodeId: NODE_ID, position: { x: 200, y: 600 }, anchorBottom: 632 },
      });
      const above = screen.getByRole('dialog');
      expect(above).toHaveAttribute('data-placement', 'above');
      expect(above.style.top).toBe('290px');
    } finally {
      rectSpy.mockRestore();
    }
  });
});

describe('status stays out of the map popups (#5645 scope lock)', () => {
  const STATUS = '🆘 map-leak-canary';

  it('the shared NodeCardModel carries no status', () => {
    const nested = toNodeCardModel(makeNode({ nodeStatus: STATUS, nodeStatusUpdatedAt: Date.now() }), 'meshtastic');
    const flat = toNodeCardModel({ nodeNum: 42, longName: 'Tower Node', nodeStatus: STATUS }, 'meshtastic');
    expect(JSON.stringify(nested)).not.toContain('map-leak-canary');
    expect(JSON.stringify(flat)).not.toContain('map-leak-canary');
  });

  it('the dashboard map popup does not show a status', () => {
    const { container } = render(
      <DashboardNodePopup
        pos={{ lat: 35.1, lng: -80.6 }}
        node={{
          nodeNum: 42,
          nodeId: NODE_ID,
          longName: 'Tower Node',
          shortName: 'TWR',
          hopsAway: 3,
          lastHeard: now() - 120,
          nodeStatus: STATUS,
          nodeStatusUpdatedAt: Date.now(),
        }}
      />,
    );
    expect(screen.getByText('Tower Node')).toBeInTheDocument();
    expect(container.textContent).not.toContain('map-leak-canary');
    expect(container.innerHTML).not.toContain('map-leak-canary');
    expect(screen.queryByTestId('popup-node-status')).toBeNull();
  });
});
