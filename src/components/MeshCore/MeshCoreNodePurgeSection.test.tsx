/**
 * @vitest-environment jsdom
 *
 * MeshCoreNodePurgeSection (#6041) — the Device Configuration danger-zone
 * action that deletes non-favourite MeshCore nodes. Covers the confirm flow:
 * the dialog shows the count the preview returned, and confirming posts the
 * purge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import apiService from '../../services/api';
import { MeshCoreNodePurgeSection } from './MeshCoreNodePurgeSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const showToastMock = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const SOURCE = 'src-123';

describe('MeshCoreNodePurgeSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the count from the preview and purges on confirm', async () => {
    const getSpy = vi.spyOn(apiService, 'get').mockResolvedValue({ success: true, data: { count: 4 } });
    const postSpy = vi.spyOn(apiService, 'post').mockResolvedValue({ success: true, data: { deleted: 4 } });
    const onPurged = vi.fn();

    render(<MeshCoreNodePurgeSection sourceId={SOURCE} canWriteNodes onPurged={onPurged} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('meshcore-purge-non-favourites-button'));

    // Preview was fetched for this source.
    await waitFor(() => expect(getSpy).toHaveBeenCalledWith(
      `/api/sources/${SOURCE}/meshcore/nodes/purge-non-favourites/preview`,
    ));

    // The dialog surfaces the count it will delete.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('4');

    await user.click(screen.getByRole('button', { name: /Delete 4 nodes/ }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith(
      `/api/sources/${SOURCE}/meshcore/nodes/purge-non-favourites`,
    ));
    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining('4'), 'success');
    expect(onPurged).toHaveBeenCalled();
  });

  it('does not open the dialog when there are no non-favourites', async () => {
    vi.spyOn(apiService, 'get').mockResolvedValue({ success: true, data: { count: 0 } });
    const postSpy = vi.spyOn(apiService, 'post');

    render(<MeshCoreNodePurgeSection sourceId={SOURCE} canWriteNodes />);

    await userEvent.setup().click(screen.getByTestId('meshcore-purge-non-favourites-button'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'info'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('disables the button without nodes:write and never calls the API', async () => {
    const getSpy = vi.spyOn(apiService, 'get');
    render(<MeshCoreNodePurgeSection sourceId={SOURCE} canWriteNodes={false} />);

    const button = screen.getByTestId('meshcore-purge-non-favourites-button');
    expect(button).toBeDisabled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('can be cancelled without purging', async () => {
    vi.spyOn(apiService, 'get').mockResolvedValue({ success: true, data: { count: 2 } });
    const postSpy = vi.spyOn(apiService, 'post');

    render(<MeshCoreNodePurgeSection sourceId={SOURCE} canWriteNodes />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('meshcore-purge-non-favourites-button'));

    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /Cancel/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postSpy).not.toHaveBeenCalled();
  });
});
