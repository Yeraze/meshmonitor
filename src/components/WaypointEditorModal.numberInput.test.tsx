/**
 * WaypointEditorModal number fields on NumberInput (#5649).
 *
 * Saving a waypoint sends a packet to the mesh, so a blank or out-of-range
 * field must stop the button. Before this, a blank latitude read as
 * `Number('') === 0` and the waypoint went out at latitude 0.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      defaultCoords={{ lat: 26.5, lon: -80.1 }}
      {...overrides}
    />,
  );
  const coords = utils.container.querySelectorAll<HTMLInputElement>('input[type="number"][step="0.000001"]');
  const rebroadcast = utils.container.querySelector<HTMLInputElement>('input[type="number"][min="10"]')!;
  return { ...utils, onClose, onSave, lat: coords[0]!, lon: coords[1]!, rebroadcast };
}

const createButton = () => screen.getByRole('button', { name: /Create/ }) as HTMLButtonElement;

describe('WaypointEditorModal number fields', () => {
  it('blocks Create while a coordinate is blank, and sends nothing', async () => {
    const user = userEvent.setup();
    const { lat, onSave } = renderModal();
    expect(createButton()).toBeEnabled();

    await user.clear(lat);
    expect(lat.value).toBe('');
    expect(lat).toHaveAttribute('aria-invalid', 'true');
    expect(createButton()).toBeDisabled();

    await user.click(createButton());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('re-enables Create once fixed and sends numbers, negatives and decimals intact', async () => {
    const user = userEvent.setup();
    const { lat, lon, onSave } = renderModal();

    await user.clear(lat);
    await user.type(lat, '-33.865143');
    await user.clear(lon);
    expect(createButton()).toBeDisabled();
    await user.type(lon, '151.2099');
    expect(lat).not.toHaveAttribute('aria-invalid');
    expect(createButton()).toBeEnabled();

    await user.click(createButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const input = onSave.mock.calls[0][0];
    expect(input.lat).toBe(-33.865143);
    expect(input.lon).toBe(151.2099);
    expect(typeof input.lat).toBe('number');
    expect(typeof input.lon).toBe('number');
    // The optional rebroadcast interval was left blank: saved as "none", as before.
    expect(input.rebroadcast_interval_s).toBeNull();
  });

  it('blocks a latitude outside -90..90 and a longitude outside -180..180', async () => {
    const user = userEvent.setup();
    const { lat, lon, onSave } = renderModal();

    await user.clear(lat);
    await user.type(lat, '91');
    expect(lat).toHaveAttribute('aria-invalid', 'true');
    expect(createButton()).toBeDisabled();
    await user.clear(lat);
    await user.type(lat, '90');
    expect(createButton()).toBeEnabled();

    await user.clear(lon);
    await user.type(lon, '-181');
    expect(lon).toHaveAttribute('aria-invalid', 'true');
    expect(createButton()).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps the rebroadcast interval optional but never below its 10 minute floor', async () => {
    const user = userEvent.setup();
    const { rebroadcast, onSave } = renderModal();

    // Blank is legal.
    expect(rebroadcast.value).toBe('');
    expect(rebroadcast).not.toHaveAttribute('aria-invalid');
    expect(createButton()).toBeEnabled();

    // Below the floor: blocked, not sent, not replaced by 0 or by the floor.
    await user.type(rebroadcast, '5');
    expect(rebroadcast.value).toBe('5');
    expect(rebroadcast).toHaveAttribute('aria-invalid', 'true');
    expect(createButton()).toBeDisabled();
    await user.click(createButton());
    expect(onSave).not.toHaveBeenCalled();

    // A fraction of a minute is not a legal interval either.
    await user.clear(rebroadcast);
    await user.type(rebroadcast, '10.5');
    expect(createButton()).toBeDisabled();

    await user.clear(rebroadcast);
    await user.type(rebroadcast, '15');
    expect(createButton()).toBeEnabled();
    await user.click(createButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].rebroadcast_interval_s).toBe(900);
  });

  it('clearing a set rebroadcast interval saves it as none', async () => {
    const user = userEvent.setup();
    const { rebroadcast, onSave } = renderModal();
    await user.type(rebroadcast, '20');
    await user.clear(rebroadcast);
    expect(rebroadcast).not.toHaveAttribute('aria-invalid');
    await user.click(createButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].rebroadcast_interval_s).toBeNull();
  });
});
