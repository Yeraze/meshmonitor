/**
 * @vitest-environment jsdom
 *
 * Capability-preservation coverage for the chat-overlay NodePopup after its
 * #4047 Phase 5 WP5 migration onto the popup family
 * (`src/components/map/popups/`). No dedicated test file existed for this
 * component pre-migration (grep-confirmed in the phase spec) — this file
 * fills that gap and guards the behaviors the spec's §2.4 composition table
 * and §4 approved-visible-changes list call out explicitly:
 *   - fixed frame renders (`.node-popup-overlay` — the class the App.tsx
 *     click-outside selector now targets, see §1.3/R1)
 *   - tab bar + traceroute tab only when traceroute permission is granted
 *   - the hops row is now shown (capability GAIN, orchestrator-approved)
 *   - SNR renders to 1 decimal, battery 101 renders "Plugged In" (preserved
 *     NodePopup-only formatting, via SignalItems `snrDecimals`/`showPluggedIn`)
 *   - all five actions (More Details, Show on Map, Delete, Purge, View
 *     History) fire their handlers and close the popup
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodePopup } from './NodePopup';
import type { DeviceInfo } from '../../types/device';
import type { DbTraceroute } from '../../services/database';

// The global setup.ts mock for react-i18next ignores `options.defaultValue`
// (it only interpolates `{{token}}` placeholders into the raw key), so it
// can't produce real English text for the family's `t(key, { defaultValue })`
// / `t(key, defaultLabel)` calls. Override locally — mirrors
// src/components/Dashboard/DashboardNodePopup.test.tsx and
// src/components/map/popups/sections.test.tsx — so these assertions exercise
// the same English copy a real render would produce.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      let out = defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

const localNode: DeviceInfo = {
  nodeNum: 1,
  user: { id: '!00000001', longName: 'Local Node', shortName: 'LCL' },
};

const remoteNode: DeviceInfo = {
  nodeNum: 42,
  user: { id: '!0000002a', longName: 'Tower Node', shortName: 'TWR', role: '2', hwModel: 9 },
  position: { latitude: 35.1, longitude: -80.6 },
  hopsAway: 3,
  snr: 4.567,
  deviceMetrics: { batteryLevel: 101 },
  lastHeard: Math.floor(Date.now() / 1000) - 60,
};

const nodePopupState = { nodeId: '!0000002a', position: { x: 100, y: 200 } };

function allowAll() {
  return true;
}

describe('NodePopup (chat overlay)', () => {
  it('renders nothing when nodePopup is null', () => {
    const { container } = render(
      <NodePopup
        nodePopup={null}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the fixed-position overlay frame with the canonical family chrome', () => {
    const { container } = render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // The wrapper carries the dynamic fixed positioning; the inner NodeCard
    // root carries `.node-popup-overlay`, the class App.tsx's click-outside
    // handler now matches (was `.node-popup` pre-WP5 — see nodes.css §R1).
    const overlay = container.querySelector('.node-popup-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass('node-popup');
    expect(screen.getByText('Tower Node')).toBeInTheDocument();
    expect(screen.getByText('TWR')).toBeInTheDocument();
  });

  it('shows the hops row (capability gain, orchestrator-approved) and formats SNR to 1 decimal / battery 101 as Plugged In', () => {
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('3 hops')).toBeInTheDocument();
    expect(screen.getByText('4.6 dB')).toBeInTheDocument();
    expect(screen.getByText('Plugged In')).toBeInTheDocument();
  });

  it('omits the tab bar and traceroute tab when traceroute permission is absent', () => {
    const { container } = render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={(resource) => resource !== 'traceroute'}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onTraceroute={vi.fn()}
      />,
    );
    expect(container.querySelector('.node-popup-tabs')).toBeNull();
  });

  it('shows the tab bar and traceroute tab (with View History) when traceroute permission + handler are present', () => {
    const traceroutes: DbTraceroute[] = [{
      id: 1,
      fromNodeNum: 1,
      toNodeNum: 42,
      route: '[]',
      routeBack: null,
      snrTowards: '[]',
      snrBack: null,
      timestamp: Date.now() - 1000,
      createdAt: Date.now() - 1000,
    } as unknown as DbTraceroute];
    const onViewTracerouteHistory = vi.fn();

    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onTraceroute={vi.fn()}
        traceroutes={traceroutes}
        currentNodeId="!00000001"
        onViewTracerouteHistory={onViewTracerouteHistory}
      />,
    );

    expect(screen.getByTitle('Traceroute')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Traceroute'));
    const historyBtn = screen.getByText('View History');
    expect(historyBtn).toBeInTheDocument();
    fireEvent.click(historyBtn);
    expect(onViewTracerouteHistory).toHaveBeenCalledWith(1, 42, 'Local Node', 'Tower Node');
  });

  it('More Details fires onDMNode with the node id and closes the popup', () => {
    const onDMNode = vi.fn();
    const onClose = vi.fn();
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={onDMNode}
        onShowOnMap={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/More Details/));
    expect(onDMNode).toHaveBeenCalledWith('!0000002a');
    expect(onClose).toHaveBeenCalled();
  });

  it('Show on Map fires onShowOnMap with the node and closes the popup (position present)', () => {
    const onShowOnMap = vi.fn();
    const onClose = vi.fn();
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={onShowOnMap}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText(/Show on Map/));
    expect(onShowOnMap).toHaveBeenCalledWith(remoteNode);
    expect(onClose).toHaveBeenCalled();
  });

  it('omits Show on Map when the node has no position', () => {
    const noPosNode: DeviceInfo = { ...remoteNode, position: undefined };
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, noPosNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Show on Map/)).not.toBeInTheDocument();
  });

  it('Delete and Purge fire their handlers and close the popup (gated on messages:write + connected)', () => {
    const onDeleteNode = vi.fn();
    const onPurgeNodeFromDevice = vi.fn();
    const onClose = vi.fn();
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={onClose}
        onDeleteNode={onDeleteNode}
        onPurgeNodeFromDevice={onPurgeNodeFromDevice}
        connectionStatus="connected"
        currentNodeNum={1}
      />,
    );
    fireEvent.click(screen.getByText(/Delete/));
    expect(onDeleteNode).toHaveBeenCalledWith(42);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText(/Purge from Device/));
    expect(onPurgeNodeFromDevice).toHaveBeenCalledWith(42);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('omits Purge when not connected, and omits both danger actions without messages:write', () => {
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onDeleteNode={vi.fn()}
        onPurgeNodeFromDevice={vi.fn()}
        connectionStatus="disconnected"
        currentNodeNum={1}
      />,
    );
    expect(screen.getByText(/Delete/)).toBeInTheDocument();
    expect(screen.queryByText(/Purge from Device/)).not.toBeInTheDocument();
  });

  it('disables the run-traceroute button with the shared tooltip when txDisabled (epic #4294 Phase 2)', () => {
    const { container } = render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onTraceroute={vi.fn()}
        connectionStatus="connected"
        txDisabled
      />,
    );
    // Switch to the Traceroute tab (mirrors the existing "shows the tab bar…"
    // test above) — the run button only renders inside that tab body.
    fireEvent.click(screen.getByTitle('Traceroute'));
    const btn = container.querySelector('.node-popup-btn:not(.traceroute-history-btn)');
    expect(btn).not.toBeNull();
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'tx_disabled.control_tooltip');
  });

  it('leaves the run-traceroute button enabled when txDisabled is false and connected', () => {
    const { container } = render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={allowAll}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onTraceroute={vi.fn()}
        connectionStatus="connected"
        txDisabled={false}
      />,
    );
    fireEvent.click(screen.getByTitle('Traceroute'));
    const btn = container.querySelector('.node-popup-btn:not(.traceroute-history-btn)');
    expect(btn).not.toBeNull();
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('title');
  });

  it('omits all danger actions without messages:write permission', () => {
    render(
      <NodePopup
        nodePopup={nodePopupState}
        nodes={[localNode, remoteNode]}
        timeFormat="24"
        dateFormat="MM/DD/YYYY"
        hasPermission={(resource) => resource !== 'messages'}
        onDMNode={vi.fn()}
        onShowOnMap={vi.fn()}
        onClose={vi.fn()}
        onDeleteNode={vi.fn()}
        onPurgeNodeFromDevice={vi.fn()}
        connectionStatus="connected"
        currentNodeNum={1}
      />,
    );
    expect(screen.queryByText(/Delete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Purge from Device/)).not.toBeInTheDocument();
  });
});
