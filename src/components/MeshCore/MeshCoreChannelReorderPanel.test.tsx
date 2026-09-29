/**
 * @vitest-environment jsdom
 *
 * MeshCoreChannelReorderPanel (#5379): collects an order, confirms, posts it,
 * and reports what state the device is in afterwards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const csrfFetchMock = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

import { MeshCoreChannelReorderPanel } from './MeshCoreChannelReorderPanel';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CHANNELS = [
  { id: 1, name: 'alpha' },
  { id: 2, name: 'bravo' },
  { id: 3, name: 'charlie' },
];

function renderPanel(channels = CHANNELS) {
  const onFinished = vi.fn();
  const onClose = vi.fn();
  render(
    <MeshCoreChannelReorderPanel
      baseUrl="/base"
      sourceId="src-a"
      channels={channels}
      onFinished={onFinished}
      onClose={onClose}
    />,
  );
  return { onFinished, onClose };
}

async function confirmSave() {
  fireEvent.click(screen.getByTestId('mc-reorder-save'));
  expect(screen.getByTestId('mc-reorder-confirm')).toBeTruthy();
  fireEvent.click(screen.getByTestId('mc-reorder-confirm-go'));
}

beforeEach(() => {
  csrfFetchMock.mockReset();
});

describe('MeshCoreChannelReorderPanel', () => {
  it('disables save until the order changes, then posts the new order after confirm', async () => {
    csrfFetchMock.mockResolvedValueOnce(json({
      success: true,
      data: { status: 'applied', moves: [{ from: 2, to: 1 }, { from: 1, to: 2 }], remap: { permissionsDropped: 0, automationsToReview: [] } },
    }));
    const { onFinished } = renderPanel();

    const save = screen.getByTestId('mc-reorder-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/Move .*bravo up/));
    expect(save.disabled).toBe(false);
    expect(screen.getByTestId('mc-reorder-row-2').textContent).toContain('Slot 2 to 1');

    await confirmSave();

    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = csrfFetchMock.mock.calls[0];
    expect(url).toBe('/base/api/sources/src-a/meshcore/channels/reorder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ order: [2, 1, 3] });
    await waitFor(() => expect(screen.getByTestId('mc-reorder-result').textContent).toContain('Channels reordered'));
    expect(onFinished).toHaveBeenCalled();
  });

  it('allows saving an unchanged order when it closes a gap', () => {
    renderPanel([{ id: 1, name: 'alpha' }, { id: 3, name: 'charlie' }]);
    expect((screen.getByTestId('mc-reorder-save') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('mc-reorder-row-3').textContent).toContain('Slot 3 to 2');
  });

  it('cancel in the confirm dialog sends nothing', () => {
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Move .*charlie up/));
    fireEvent.click(screen.getByTestId('mc-reorder-save'));
    fireEvent.click(within(screen.getByTestId('mc-reorder-confirm')).getByText('Cancel'));
    expect(screen.queryByTestId('mc-reorder-confirm')).toBeNull();
    expect(csrfFetchMock).not.toHaveBeenCalled();
  });

  it('lists automations to review and dropped grants after success', async () => {
    csrfFetchMock.mockResolvedValueOnce(json({
      success: true,
      data: {
        status: 'applied',
        moves: [{ from: 3, to: 1 }],
        remap: { permissionsDropped: 2, automationsToReview: [{ id: 'a1', name: 'Night relay', slots: [3] }] },
      },
    }));
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Move .*charlie up/));
    await confirmSave();
    await waitFor(() => expect(screen.getByText(/Night relay/)).toBeTruthy());
    expect(screen.getByTestId('mc-reorder-result').textContent).toContain('2 channel permission grant(s)');
  });

  it('says the device is back in its original order after a rollback', async () => {
    csrfFetchMock.mockResolvedValueOnce(json({
      success: false, code: 'CHANNEL_REORDER_ROLLED_BACK', error: 'slot 2 write failed',
      result: { status: 'rolled_back' },
    }, 502));
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Move .*bravo up/));
    await confirmSave();
    await waitFor(() => expect(screen.getByTestId('mc-reorder-result').textContent).toContain('back in its original order'));
    expect(screen.getByTestId('mc-reorder-result').textContent).toContain('slot 2 write failed');
  });

  it('shows the last known device slots when the undo could not be confirmed', async () => {
    csrfFetchMock.mockResolvedValueOnce(json({
      success: false, code: 'CHANNEL_REORDER_INCONSISTENT', error: 'link lost',
      result: { status: 'inconsistent', deviceSlots: [{ slot: 1, name: 'bravo' }, { slot: 2, name: null, unknown: true }] },
    }, 500));
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Move .*bravo up/));
    await confirmSave();
    await waitFor(() => expect(screen.getByText('Slot 1: bravo')).toBeTruthy());
    expect(screen.getByText('Slot 2: unknown')).toBeTruthy();
    expect(screen.getByTestId('mc-reorder-result').textContent).toContain('No channel was removed');
  });

  it('reports a refusal as nothing written', async () => {
    csrfFetchMock.mockResolvedValueOnce(json({ success: false, code: 'ORDER_MISMATCH', error: 'The channel list on the device changed' }, 409));
    renderPanel();
    fireEvent.click(screen.getByLabelText(/Move .*bravo up/));
    await confirmSave();
    await waitFor(() => expect(screen.getByTestId('mc-reorder-result').textContent).toContain('Nothing was written'));
  });
});
