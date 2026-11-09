/**
 * @vitest-environment jsdom
 *
 * Remote settings section (#6256 P10): no API call on mount, one group per
 * Read, server error codes shown in plain words, saves go to the remote action.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock((key: string) => key);
});

import { MeshCoreRemoteSettingsSection } from './MeshCoreRemoteSettingsSection';

const PK = 'aa'.repeat(32);

function setup(read = vi.fn(), save = vi.fn()) {
  render(
    <MeshCoreRemoteSettingsSection
      publicKey={PK}
      deviceType="repeater"
      actions={{ readRemoteSettings: read, saveRemoteSettings: save }}
      pathHops={1}
      radio={{ sf: 10, bw: 250, cr: 5 }}
    />,
  );
  // Collapsed by default: open it.
  fireEvent.click(screen.getByRole('button', { name: /meshcore.repeater.remote_title/ }));
  return { read, save };
}

describe('MeshCoreRemoteSettingsSection', () => {
  it('calls nothing on mount and reads exactly the clicked group', async () => {
    const read = vi.fn().mockResolvedValue({
      ok: true,
      data: { values: { floodMax: 3 }, guestPasswordSet: false, errors: {}, firmware: 'v1.18.0', deviceType: 'repeater', sent: 9 },
    });
    const save = vi.fn();
    setup(read, save);
    expect(read).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('repeater-read-adverts'));
    await waitFor(() => expect(read).toHaveBeenCalledWith(PK, ['adverts']));
    await waitFor(() => expect((document.getElementById('mc-rep-floodMax') as HTMLInputElement).value).toBe('3'));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('explains a missing admin session', async () => {
    const read = vi.fn().mockResolvedValue({ ok: false, code: 'ADMIN_SESSION_REQUIRED', error: 'x' });
    setup(read);
    fireEvent.click(screen.getByTestId('repeater-read-access'));
    await waitFor(() => expect(screen.getByTestId('remote-settings-message').textContent).toBe('meshcore.repeater.remote_err_session'));
  });
});
