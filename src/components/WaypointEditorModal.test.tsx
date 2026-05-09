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
      rebroadcast_interval_s: null,
    });
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
