/**
 * MeshCoreDeviceActionsSection: the "Device actions" group on MeshCore Device
 * Configuration (#5683 follow-up moved it from the Settings tab).
 *
 * Covers the discovery-results list (#4516: both SNR directions, the new-node
 * marker, the reset-per-run rule), and what the move must not change: each
 * button calls the same action with the same argument, nothing runs on mount,
 * receive-only holds every transmitting control, and each control is gated on
 * the grant its own route checks.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreDeviceActionsSection } from './MeshCoreDeviceActionsSection';
import type { DiscoveredNode } from './hooks/useMeshCore';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const NEARBY = 'Discover Nearby Nodes';
const TOOLTIP = 'Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.';
const NEEDS_NODES = 'This needs the Nodes write permission on this source.';
const NEEDS_CONNECTION = 'This needs the Connection write permission on this source.';

function makeActions(discoverNodes: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(null)) {
  return {
    discoverNodes,
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
  };
}

interface RenderOptions {
  receiveOnly?: boolean;
  canWriteNodes?: boolean;
  canWriteConnection?: boolean;
  isCompanion?: boolean;
  connected?: boolean;
  otherSweepRunning?: boolean;
  onSweepRunningChange?: (running: boolean) => void;
}

function renderSection(actions = makeActions(), options: RenderOptions = {}) {
  render(
    <MeshCoreDeviceActionsSection
      connected={options.connected ?? true}
      loading={false}
      isCompanion={options.isCompanion ?? true}
      actions={actions as never}
      receiveOnly={options.receiveOnly ?? false}
      canWriteNodes={options.canWriteNodes ?? true}
      canWriteConnection={options.canWriteConnection ?? true}
      otherSweepRunning={options.otherSweepRunning}
      onSweepRunningChange={options.onSweepRunningChange}
    />,
  );
  return actions;
}

function renderView(nodes: DiscoveredNode[], opts: { returned?: number; newCount?: number } = {}) {
  const discoverNodes = vi.fn().mockResolvedValue({
    returned: opts.returned ?? nodes.length,
    newCount: opts.newCount ?? nodes.filter((n) => n.isNew).length,
    nodes,
  });
  renderSection(makeActions(discoverNodes));
  return { discoverNodes };
}

const node = (over: Partial<DiscoveredNode> = {}): DiscoveredNode => ({
  publicKey: 'a'.repeat(64),
  name: 'Yeraze Repeater',
  advType: 2,
  snr: 6.25,
  snrToNode: 4,
  rssi: -42,
  isNew: false,
  ...over,
});

const button = (name: string) => screen.getByRole('button', { name });
const TRANSMITTING = ['Advert (nearby, zero-hop)', 'Flood advert', NEARBY, 'Discover Repeaters', 'Discover Sensors'];

describe('MeshCoreDeviceActionsSection: what each button sends', () => {
  it('calls nothing on mount: every action waits for its button', () => {
    const actions = renderSection();
    expect(actions.refreshContacts).not.toHaveBeenCalled();
    expect(actions.sendAdvert).not.toHaveBeenCalled();
    expect(actions.discoverNodes).not.toHaveBeenCalled();
  });

  it('is headed "Device actions" and says nothing here is saved', () => {
    renderSection();
    expect(screen.getByRole('heading', { name: 'Device actions' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing here is a saved setting/)).toBeInTheDocument();
  });

  it('Refresh contacts calls refreshContacts once, with no argument', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await user.click(button('Refresh contacts'));
    expect(actions.refreshContacts).toHaveBeenCalledTimes(1);
    expect(actions.refreshContacts).toHaveBeenCalledWith();
    expect(actions.sendAdvert).not.toHaveBeenCalled();
    expect(actions.discoverNodes).not.toHaveBeenCalled();
  });

  it('the zero-hop advert sends at once, with mode zero_hop', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await user.click(button('Advert (nearby, zero-hop)'));
    expect(actions.sendAdvert).toHaveBeenCalledTimes(1);
    expect(actions.sendAdvert).toHaveBeenCalledWith('zero_hop');
  });

  it('the flood advert still asks first, and sends mode flood only once confirmed', async () => {
    const user = userEvent.setup();
    const actions = renderSection();
    await user.click(button('Flood advert'));
    expect(actions.sendAdvert).not.toHaveBeenCalled();
    await user.click(button('Send flood advert'));
    expect(actions.sendAdvert).toHaveBeenCalledTimes(1);
    expect(actions.sendAdvert).toHaveBeenCalledWith('flood');
  });

  it.each([
    [NEARBY, 'nearby'],
    ['Discover Repeaters', 'repeaters'],
    ['Discover Sensors', 'sensors'],
  ])('%s calls discoverNodes(%s) once', async (name, mode) => {
    const user = userEvent.setup();
    const actions = renderSection();
    await user.click(button(name));
    expect(actions.discoverNodes).toHaveBeenCalledTimes(1);
    expect(actions.discoverNodes).toHaveBeenCalledWith(mode);
  });

  it('tells the host while a sweep runs, so the region sweep can hold', async () => {
    const user = userEvent.setup();
    const onSweepRunningChange = vi.fn();
    renderSection(makeActions(), { onSweepRunningChange });
    await user.click(button(NEARBY));
    await waitFor(() => expect(onSweepRunningChange).toHaveBeenLastCalledWith(false));
    expect(onSweepRunningChange.mock.calls.map(([running]) => running)).toEqual([true, false]);
  });

  it('holds Discover while the region sweep runs', () => {
    renderSection(makeActions(), { otherSweepRunning: true });
    for (const name of [NEARBY, 'Discover Repeaters', 'Discover Sensors']) expect(button(name)).toBeDisabled();
    expect(button('Refresh contacts')).not.toBeDisabled();
  });

  it('offers no Discover on a device that is not a companion', () => {
    renderSection(makeActions(), { isCompanion: false });
    expect(screen.queryByRole('button', { name: NEARBY })).toBeNull();
    expect(button('Refresh contacts')).toBeInTheDocument();
  });
});

describe('MeshCoreDeviceActionsSection: receive-only (#4547)', () => {
  it('disables both advert buttons and Discover x3, each with the control tooltip', () => {
    renderSection(makeActions(), { receiveOnly: true });
    for (const name of TRANSMITTING) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute('title', TOOLTIP);
    }
  });

  it('leaves Refresh contacts enabled: it reads the radio and transmits nothing', () => {
    renderSection(makeActions(), { receiveOnly: true });
    expect(button('Refresh contacts')).not.toBeDisabled();
  });

  it('enables every gated button again once receive-only is off', () => {
    renderSection(makeActions(), { receiveOnly: false });
    for (const name of TRANSMITTING) expect(button(name)).not.toBeDisabled();
  });
});

describe('MeshCoreDeviceActionsSection: each control is gated on its own grant', () => {
  it('without nodes:write: Refresh contacts and Discover are disabled with the reason, adverts are not', async () => {
    const user = userEvent.setup();
    const actions = renderSection(makeActions(), { canWriteNodes: false });
    for (const name of ['Refresh contacts', NEARBY, 'Discover Repeaters', 'Discover Sensors']) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute('title', NEEDS_NODES);
    }
    expect(button('Advert (nearby, zero-hop)')).not.toBeDisabled();
    await user.click(button('Refresh contacts'));
    await user.click(button(NEARBY));
    expect(actions.refreshContacts).not.toHaveBeenCalled();
    expect(actions.discoverNodes).not.toHaveBeenCalled();
  });

  it('without connection:write: both adverts are disabled with the reason, the rest are not', async () => {
    const user = userEvent.setup();
    const actions = renderSection(makeActions(), { canWriteConnection: false });
    for (const name of ['Advert (nearby, zero-hop)', 'Flood advert']) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute('title', NEEDS_CONNECTION);
    }
    expect(button('Refresh contacts')).not.toBeDisabled();
    expect(button(NEARBY)).not.toBeDisabled();
    await user.click(button('Advert (nearby, zero-hop)'));
    await user.click(button('Flood advert'));
    expect(actions.sendAdvert).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send flood advert' })).toBeNull();
  });

  it('the missing grant is the reason shown, ahead of receive-only', () => {
    renderSection(makeActions(), { canWriteNodes: false, canWriteConnection: false, receiveOnly: true });
    expect(button(NEARBY)).toHaveAttribute('title', NEEDS_NODES);
    expect(button('Flood advert')).toHaveAttribute('title', NEEDS_CONNECTION);
  });

  it('with both grants nothing is disabled', () => {
    renderSection();
    for (const name of ['Refresh contacts', ...TRANSMITTING]) expect(button(name)).not.toBeDisabled();
  });
});

describe('MeshCoreDeviceActionsSection: discovery results (#4516)', () => {
  it('lists each responder with a key snippet and both SNR directions', async () => {
    const user = userEvent.setup();
    renderView([node()]);

    await user.click(screen.getByRole('button', { name: NEARBY }));

    await waitFor(() => expect(screen.getByText('Yeraze Repeater')).toBeInTheDocument());
    // Key is abbreviated — the full 64 chars would swamp the row.
    expect(screen.getByText(/^aaaaaaaaaaaa…$/)).toBeInTheDocument();
    expect(screen.getByText('6.25 dB')).toBeInTheDocument();  // SNR here
    expect(screen.getByText('4.00 dB')).toBeInTheDocument();  // SNR at node
  });

  it('marks a newly-discovered node and leaves a known one unmarked', async () => {
    const user = userEvent.setup();
    renderView([
      node({ publicKey: 'a'.repeat(64), name: 'Known One', isNew: false }),
      node({ publicKey: 'b'.repeat(64), name: 'Fresh One', isNew: true }),
    ]);

    await user.click(screen.getByRole('button', { name: NEARBY }));

    await waitFor(() => expect(screen.getByText('Fresh One')).toBeInTheDocument());
    expect(screen.getAllByText('NEW')).toHaveLength(1);
  });

  it('shows a placeholder for a responder with no name', async () => {
    // A repeater that has never advertised has no name anywhere; the row must
    // still appear, since its key and signal are the useful part.
    const user = userEvent.setup();
    renderView([node({ name: null })]);

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Unknown')).toBeInTheDocument());
  });

  it('renders a dash rather than NaN when a signal reading is missing', async () => {
    const user = userEvent.setup();
    renderView([node({ snr: null, snrToNode: null })]);

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Yeraze Repeater')).toBeInTheDocument());
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it('replaces the previous run rather than accumulating across runs', async () => {
    // The issue asks for the list to reset each time; otherwise a node that has
    // since gone out of range would linger and read as still reachable.
    const user = userEvent.setup();
    const discoverNodes = vi.fn()
      .mockResolvedValueOnce({ returned: 1, newCount: 0, nodes: [node({ name: 'First Run' })] })
      .mockResolvedValueOnce({ returned: 1, newCount: 0, nodes: [node({ name: 'Second Run' })] });
    renderSection(makeActions(discoverNodes));

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('First Run')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: NEARBY }));
    await waitFor(() => expect(screen.getByText('Second Run')).toBeInTheDocument());
    expect(screen.queryByText('First Run')).toBeNull();
  });

  it('shows no table before the first sweep', () => {
    renderView([node()]);
    expect(screen.queryByText('Yeraze Repeater')).toBeNull();
  });
});
