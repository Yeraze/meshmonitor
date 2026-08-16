/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import WaypointEditorModal from './WaypointEditorModal';

function renderModal(overrides: Partial<React.ComponentProps<typeof WaypointEditorModal>> = {}) {
  const onClose = vi.fn();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <WaypointEditorModal
      isOpen
      initial={null}
      onClose={onClose}
      onSave={onSave}
      selfNodeNum={1234567}
      {...overrides}
    />,
  );
  return { ...utils, onClose, onSave };
}

describe('WaypointEditorModal — create mode', () => {
  it('seeds lat/lon from defaultCoords and dispatches onSave with normalized input', async () => {
    const { onSave, getByText, getByLabelText, container } = renderModal({
      defaultCoords: { lat: 26.5, lon: -80.1 },
    });

    const latInput = container.querySelector(
      'input[type="number"][step="0.000001"]',
    ) as HTMLInputElement;
    expect(latInput.value).toBe('26.5');

    fireEvent.change(getByLabelText(/Name/), { target: { value: 'Trailhead' } });
    fireEvent.click(getByText(/Create/));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      lat: 26.5,
      lon: -80.1,
      name: 'Trailhead',
      icon: '📍',
      expire: null,
      locked_to: null,
      virtual: false,
      // #4341: no explicit pick => slot 0, the channel waypoints always used.
      channel: 0,
      rebroadcast_interval_s: null,
    });
  });

  it('shows the Android-notification warning only once a rebroadcast interval is entered (#4752)', () => {
    const { container, queryByRole } = renderModal({ defaultCoords: { lat: 1, lon: 2 } });
    // Off by default: no rebroadcast value, so no warning.
    expect(queryByRole('note')).toBeNull();

    const rebroadcastInput = container.querySelector(
      'input[type="number"][min="10"][step="1"]',
    ) as HTMLInputElement;
    fireEvent.change(rebroadcastInput, { target: { value: '15' } });
    expect(queryByRole('note')?.textContent).toMatch(/Android/i);

    // Clearing it hides the warning again. Whitespace-only counts as cleared:
    // the display guard uses `.trim().length > 0`, matching validate()'s own
    // trim, so the warning and the "interval is set" check never diverge.
    fireEvent.change(rebroadcastInput, { target: { value: '   ' } });
    expect(queryByRole('note')).toBeNull();
    fireEvent.change(rebroadcastInput, { target: { value: '' } });
    expect(queryByRole('note')).toBeNull();
  });

  it('rejects out-of-range latitude', async () => {
    const { onSave, getByText, container } = renderModal();
    const inputs = container.querySelectorAll('input[type="number"][step="0.000001"]');
    fireEvent.change(inputs[0]!, { target: { value: '200' } });
    fireEvent.change(inputs[1]!, { target: { value: '0' } });
    fireEvent.click(getByText(/Create/));

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Latitude/);
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sets locked_to when "Lock to this node" is checked', async () => {
    const { onSave, getByText, getByLabelText, container } = renderModal({
      defaultCoords: { lat: 1, lon: 2 },
      selfNodeNum: 999,
    });
    fireEvent.change(getByLabelText(/Name/), { target: { value: 'Mine' } });
    fireEvent.click(getByText(/Lock to this node/));
    fireEvent.click(getByText(/Create/));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].locked_to).toBe(999);
    // sanity: we sent the expected coords through
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('WaypointEditorModal — broadcast channel (#4341)', () => {
  const CHANNELS = [
    { id: 0, name: '' },
    { id: 1, name: 'gauntlet' },
    { id: 2, name: 'admin' },
    // Channel-Database virtual channel — must never be offered.
    { id: 101, name: 'mqtt-virtual' },
  ];

  it('renders one option per device channel slot and hides virtual channels', () => {
    const { getByLabelText } = renderModal({ channels: CHANNELS });
    const select = getByLabelText('Broadcast channel') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['0', '1', '2']);
    expect(select.options[0]!.textContent).toMatch(/Primary/);
    expect(select.options[1]!.textContent).toMatch(/gauntlet/);
  });

  it('puts the selected channel into the saved payload', async () => {
    const { onSave, getByText, getByLabelText } = renderModal({
      channels: CHANNELS,
      defaultCoords: { lat: 1, lon: 2 },
    });

    fireEvent.change(getByLabelText('Broadcast channel'), { target: { value: '2' } });
    fireEvent.click(getByText(/Create/));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].channel).toBe(2);
  });

  it('falls back to a Primary-only picker when the source reports no channels', () => {
    const { getByLabelText } = renderModal();
    const select = getByLabelText('Broadcast channel') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('0');
  });

  it('disables the picker for a virtual (never transmitted) waypoint', () => {
    const { getByText, getByLabelText } = renderModal({ channels: CHANNELS });
    fireEvent.click(getByText(/Virtual \(do not broadcast\)/));
    expect((getByLabelText('Broadcast channel') as HTMLSelectElement).disabled).toBe(true);
  });

  it('pre-selects the stored channel in edit mode', () => {
    const { getByLabelText } = renderModal({
      channels: CHANNELS,
      initial: {
        sourceId: 's1', waypointId: 7, ownerNodeNum: 1, latitude: 10, longitude: 20,
        expireAt: null, lockedTo: null, name: 'Existing', description: '',
        iconCodepoint: null, iconEmoji: '📍', isVirtual: false, channel: 2,
        rebroadcastIntervalS: null, lastBroadcastAt: null, firstSeenAt: 0, lastUpdatedAt: 0,
      },
    });
    expect((getByLabelText('Broadcast channel') as HTMLSelectElement).value).toBe('2');
  });

  it('shows slot 0 for a waypoint stored before the column existed', () => {
    const { getByLabelText } = renderModal({
      channels: CHANNELS,
      initial: {
        sourceId: 's1', waypointId: 7, ownerNodeNum: 1, latitude: 10, longitude: 20,
        expireAt: null, lockedTo: null, name: 'Legacy', description: '',
        iconCodepoint: null, iconEmoji: '📍', isVirtual: false, channel: null,
        rebroadcastIntervalS: null, lastBroadcastAt: null, firstSeenAt: 0, lastUpdatedAt: 0,
      },
    });
    expect((getByLabelText('Broadcast channel') as HTMLSelectElement).value).toBe('0');
  });
});

describe('WaypointEditorModal — edit mode', () => {
  it('pre-fills fields from `initial` and shows Save (not Create)', async () => {
    const { getByText, container } = renderModal({
      initial: {
        sourceId: 's1',
        waypointId: 7,
        ownerNodeNum: 1,
        latitude: 10,
        longitude: 20,
        expireAt: null,
        lockedTo: null,
        name: 'Existing',
        description: 'desc',
        iconCodepoint: 0x1f3d5,
        iconEmoji: '🏕️',
        isVirtual: false,
        channel: null,
        rebroadcastIntervalS: null,
        lastBroadcastAt: null,
        firstSeenAt: 0,
        lastUpdatedAt: 0,
      },
      defaultCoords: null,
    });
    expect(getByText(/Save/)).toBeTruthy();
    const inputs = container.querySelectorAll('input[type="number"][step="0.000001"]');
    expect((inputs[0] as HTMLInputElement).value).toBe('10');
    expect((inputs[1] as HTMLInputElement).value).toBe('20');
  });
});
