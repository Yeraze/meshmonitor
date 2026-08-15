/**
 * @vitest-environment jsdom
 *
 * Beacon invitation card (#4723).
 *
 * The load-bearing behaviours are the two maintainer decisions: accepting never
 * reaches the device without an explicit confirmation, and un-actionable offers
 * are shown with their reason rather than hidden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo key + params so assertions read against stable identifiers rather
    // than translated copy.
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
  }),
}));
vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import BeaconOffersPanel from './BeaconOffersPanel';

const NODE = 0xaabbccdd;

const offer = (o: Record<string, unknown> = {}) => ({
  sourceId: 'src-a', nodeNum: NODE, message: 'join us',
  offerChannelName: 'RegionMesh', hasChannelKey: true,
  offerRegion: null, offerPreset: null, hasOffer: true,
  firstSeenAt: 1_000, lastSeenAt: 2_000, dismissedAt: null,
  ...o,
});

const renderPanel = (offers: unknown[], props: Record<string, unknown> = {}) => {
  get.mockResolvedValue({ success: true, data: offers });
  return render(<BeaconOffersPanel sourceId="src-a" channels={[]} {...props} />);
};

beforeEach(() => { get.mockReset(); post.mockReset().mockResolvedValue({ success: true }); });

describe('BeaconOffersPanel', () => {
  it('renders nothing when there are no offers — pre-2.8 installs see no empty surface', async () => {
    renderPanel([]);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('beacon-offers-panel')).toBeNull();
  });

  it('renders nothing without a source', () => {
    render(<BeaconOffersPanel sourceId={null} channels={[]} />);
    expect(screen.queryByTestId('beacon-offers-panel')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows an un-actionable offer WITH its reason instead of hiding it', async () => {
    // Maintainer decision: "show but with reason why they won't work."
    renderPanel([offer({ hasChannelKey: false })]);

    expect(await screen.findByTestId(`beacon-offer-${NODE}`)).toBeTruthy();
    expect(screen.getByTestId('beacon-offer-reason').textContent).toMatch(/did not include its key/i);
    // No join button — but the card is still there.
    expect(screen.queryByText('beacons.join_channel')).toBeNull();
  });

  it('never writes to the device without an explicit confirmation', async () => {
    // Clicking Join opens the dialog and must NOT call accept on its own.
    const user = userEvent.setup();
    renderPanel([offer()]);

    await user.click(await screen.findByText('beacons.join_channel'));

    expect(screen.getByTestId('beacon-confirm-dialog')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('beacon-confirm-go'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      `/sources/src-a/beacon-offers/${NODE}/accept`,
      expect.objectContaining({ confirm: true }),
    ));
  });

  it('cancelling the confirmation writes nothing', async () => {
    const user = userEvent.setup();
    renderPanel([offer()]);

    await user.click(await screen.findByText('beacons.join_channel'));
    await user.click(screen.getByText('common.cancel'));

    expect(screen.queryByTestId('beacon-confirm-dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('defaults to a free slot rather than the first one', async () => {
    // Picking an occupied slot by default would make "Replace and join" the
    // path of least resistance, which is exactly backwards.
    const user = userEvent.setup();
    renderPanel([offer()], { channels: [{ id: 1, name: 'Taken' }, { id: 2, name: 'AlsoTaken' }] });

    await user.click(await screen.findByText('beacons.join_channel'));
    await user.click(screen.getByTestId('beacon-confirm-go'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slot: 3, overwrite: false }),
    ));
  });

  it('warns and asks for overwrite when the chosen slot is occupied', async () => {
    const user = userEvent.setup();
    // Every joinable slot taken, so the default lands on an occupied one.
    const channels = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `Ch${id}` }));
    renderPanel([offer()], { channels });

    await user.click(await screen.findByText('beacons.join_channel'));
    expect(screen.getByTestId('beacon-confirm-overwrite-warning')).toBeTruthy();

    await user.click(screen.getByTestId('beacon-confirm-go'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ overwrite: true }),
    ));
  });

  it('hides actions for a read-only viewer', async () => {
    renderPanel([offer()], { canWrite: false });
    await screen.findByTestId(`beacon-offer-${NODE}`);
    expect(screen.queryByText('beacons.join_channel')).toBeNull();
    expect(screen.queryByText('beacons.dismiss')).toBeNull();
  });

  it('dismisses an offer and drops it from the list', async () => {
    const user = userEvent.setup();
    renderPanel([offer()]);

    await user.click(await screen.findByText('beacons.dismiss'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(`/sources/src-a/beacon-offers/${NODE}/dismiss`));
    await waitFor(() => expect(screen.queryByTestId(`beacon-offer-${NODE}`)).toBeNull());
  });

  it('shows the advertised region/preset as context, not as an action', async () => {
    renderPanel([offer({ offerRegion: 1, offerPreset: 0 })]);
    await screen.findByTestId(`beacon-offer-${NODE}`);

    // Present as a note, and there is no control to apply it — applying a
    // region/preset would rewrite the radio's LoRa config.
    expect(screen.getByText(/Advertises a mesh/i)).toBeTruthy();
    expect(screen.queryByText(/switch preset/i)).toBeNull();
  });
});
