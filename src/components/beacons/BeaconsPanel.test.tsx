/**
 * @vitest-environment jsdom
 *
 * The beacons button and its list (#4723, #5232).
 *
 * Three things are load-bearing here and each has bitten this surface before:
 *
 * 1. Accepting never reaches the device without an explicit confirmation.
 * 2. Un-actionable offers are listed WITH their reason rather than hidden.
 * 3. The button survives everything being hidden — a muted beacon is only
 *    reachable through it, so a button that vanished at `pending === 0` would
 *    strand the un-mute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock('react-i18next', () => {
  // A STABLE t reference across renders, like real react-i18next. Returning a
  // fresh function each call would make any useCallback([..., t]) re-fire every
  // render — an effect→setState→render loop the real hook never triggers.
  // Echo key + params so assertions read against stable identifiers.
  const t = (k: string, p?: unknown, q?: Record<string, unknown>) => {
    const params = typeof p === 'object' && p !== null ? p : q;
    return params ? `${k}:${JSON.stringify(params)}` : k;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import BeaconsPanel from './BeaconsPanel';
import { selectOffers, nodeHexId } from './beaconList';
import type { PublicBeaconOffer } from './types';

const NODE = 0xaabbccdd;
const OTHER = 0x11223344;

const offer = (o: Partial<PublicBeaconOffer> = {}): PublicBeaconOffer => ({
  sourceId: 'src-a', nodeNum: NODE, message: 'join us',
  offerChannelName: 'RegionMesh', hasChannelKey: true,
  offerRegion: null, offerPreset: null, hasOffer: true,
  firstSeenAt: 1_000, lastSeenAt: 2_000, dismissedAt: null, mutedAt: null,
  ...o,
});

/** Wire `get` to answer both the count poll and the list fetch. */
function mockApi(offers: PublicBeaconOffer[], counts?: { pending: number; total: number }) {
  const pending = counts?.pending ?? offers.filter((o) => o.dismissedAt == null && o.mutedAt == null).length;
  const total = counts?.total ?? offers.length;
  get.mockImplementation((url: string) => Promise.resolve(
    url.endsWith('/count')
      ? { success: true, data: { pending, total } }
      : { success: true, data: offers },
  ));
}

const renderPanel = (offers: PublicBeaconOffer[], props: Record<string, unknown> = {}) => {
  mockApi(offers);
  return render(<BeaconsPanel sourceId="src-a" channels={[]} {...props} />);
};

/** Render, then open the list. */
async function openList(offers: PublicBeaconOffer[], props: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  renderPanel(offers, props);
  await user.click(await screen.findByTestId('beacons-button'));
  await screen.findByTestId('beacons-modal');
  return user;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset().mockResolvedValue({ success: true });
});

describe('BeaconsPanel button', () => {
  it('renders nothing when the source has never heard a beacon', async () => {
    renderPanel([]);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('beacons-button')).toBeNull();
  });

  it('renders nothing, and fetches nothing, without a source', () => {
    render(<BeaconsPanel sourceId={null} channels={[]} />);
    expect(screen.queryByTestId('beacons-button')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('badges the pending count from the count endpoint', async () => {
    mockApi([], { pending: 3, total: 5 });
    render(<BeaconsPanel sourceId="src-a" channels={[]} />);

    expect((await screen.findByTestId('beacons-badge')).textContent).toBe('3');
    expect(get).toHaveBeenCalledWith('/api/sources/src-a/beacon-offers/count');
  });

  it('keeps the button, without a badge, when everything is hidden (#5232)', async () => {
    // The only route back to a muted beacon. Hiding the button here would make
    // the mute irreversible from the UI.
    mockApi([], { pending: 0, total: 4 });
    render(<BeaconsPanel sourceId="src-a" channels={[]} />);

    await screen.findByTestId('beacons-button');
    expect(screen.queryByTestId('beacons-badge')).toBeNull();
  });

  it('still renders the button when the count request fails outright', async () => {
    // A failed count leaves `totalCount` at its initial 0. Treating that as
    // "no beacons" would make a broken fetch indistinguishable from an empty
    // mesh AND hide the only route to a muted offer — the same trap #4946 fixed
    // for the list. The button shows; opening it surfaces the real error.
    get.mockImplementation((url) => (url.endsWith('/count')
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ success: true, data: [] })));

    render(<BeaconsPanel sourceId="src-a" channels={[]} />);

    expect(await screen.findByTestId('beacons-button')).toBeTruthy();
    expect(screen.queryByTestId('beacons-badge')).toBeNull();
  });

  it('hides the button on a genuine zero, not merely a zero-looking one', async () => {
    mockApi([], { pending: 0, total: 0 });
    render(<BeaconsPanel sourceId="src-a" channels={[]} />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('beacons-button')).toBeNull();
  });

  it('only fetches the list once the button is clicked', async () => {
    mockApi([offer()]);
    render(<BeaconsPanel sourceId="src-a" channels={[]} />);
    await screen.findByTestId('beacons-button');

    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('includeDismissed'));

    await userEvent.setup().click(screen.getByTestId('beacons-button'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/sources/src-a/beacon-offers?includeDismissed=true'));
  });
});

describe('BeaconsModal list', () => {
  it('lists one row per beaconing node', async () => {
    await openList([offer(), offer({ nodeNum: OTHER, offerChannelName: 'OtherMesh' })]);
    expect(screen.getByTestId(`beacon-offer-${NODE}`)).toBeTruthy();
    expect(screen.getByTestId(`beacon-offer-${OTHER}`)).toBeTruthy();
  });

  it('surfaces a failed load instead of collapsing to a silent empty list (#4946)', async () => {
    // A broken fetch must not be indistinguishable from "no beacons".
    get.mockImplementation((url: string) => (url.endsWith('/count')
      ? Promise.resolve({ success: true, data: { pending: 1, total: 1 } })
      : Promise.reject(new Error('boom'))));

    const user = userEvent.setup();
    render(<BeaconsPanel sourceId="src-a" channels={[]} />);
    await user.click(await screen.findByTestId('beacons-button'));

    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('shows an un-actionable offer WITH its reason instead of hiding it', async () => {
    await openList([offer({ hasChannelKey: false })]);

    expect(screen.getByTestId('beacon-offer-reason').textContent).toMatch(/did not include its key/i);
    expect(screen.queryByText('beacons.join_channel')).toBeNull();
  });

  it('shows the advertised region/preset as context, not as an action', async () => {
    await openList([offer({ offerRegion: 1, offerPreset: 0 })]);

    expect(screen.getByText(/Advertises a mesh/i)).toBeTruthy();
    expect(screen.queryByText(/switch preset/i)).toBeNull();
  });

  it('warns about a non-compliant advertised region/preset without blocking the join (#5103)', async () => {
    // Long Fast in the US: fits the band, so the firmware legality check is
    // happy, but FCC §15.247 needs 500 kHz. Warning-only — Join must remain.
    await openList([offer({ offerRegion: 1, offerPreset: 0 })]);

    const warning = screen.getByTestId('beacon-offer-compliance');
    expect(warning.textContent).toMatch(/not compliant in/i);
    expect(warning.getAttribute('role')).toBe('alert');
    expect(screen.getByText('beacons.join_channel')).toBeTruthy();
  });

  it('hides every write action for a read-only viewer', async () => {
    await openList([offer()], { canWrite: false });
    expect(screen.queryByText('beacons.join_channel')).toBeNull();
    expect(screen.queryByText('beacons.dismiss')).toBeNull();
    expect(screen.queryByText('beacons.mute')).toBeNull();
  });

  it('filters by search text', async () => {
    const user = await openList([
      offer(),
      offer({ nodeNum: OTHER, message: 'hello', offerChannelName: 'OtherMesh' }),
    ]);

    await user.type(screen.getByTestId('beacons-search'), 'OtherMesh');

    expect(screen.queryByTestId(`beacon-offer-${NODE}`)).toBeNull();
    expect(screen.getByTestId(`beacon-offer-${OTHER}`)).toBeTruthy();
  });

  it('sorts by a clicked column and flips on a second click', async () => {
    const user = await openList([
      offer({ nodeNum: NODE, offerChannelName: 'Zulu' }),
      offer({ nodeNum: OTHER, offerChannelName: 'Alpha' }),
    ]);

    await user.click(screen.getByTestId('beacon-sort-channel'));
    let rows = screen.getAllByTestId(/^beacon-offer-/);
    expect(rows[0].getAttribute('data-testid')).toBe(`beacon-offer-${OTHER}`);

    await user.click(screen.getByTestId('beacon-sort-channel'));
    rows = screen.getAllByTestId(/^beacon-offer-/);
    expect(rows[0].getAttribute('data-testid')).toBe(`beacon-offer-${NODE}`);
  });

  it('hides dismissed and muted rows until the hidden filter is chosen', async () => {
    const user = await openList([
      offer(),
      offer({ nodeNum: OTHER, mutedAt: 9_000 }),
    ]);

    expect(screen.queryByTestId(`beacon-offer-${OTHER}`)).toBeNull();

    await user.click(screen.getByTestId('beacons-filter-hidden'));
    expect(screen.getByTestId(`beacon-offer-${OTHER}`)).toBeTruthy();
    expect(screen.queryByTestId(`beacon-offer-${NODE}`)).toBeNull();
    expect(screen.getByTestId(`beacon-muted-${OTHER}`)).toBeTruthy();
  });

  it('offers Restore, and only Restore, on a hidden row', async () => {
    const user = await openList([offer({ mutedAt: 9_000 })]);
    await user.click(screen.getByTestId('beacons-filter-hidden'));

    const row = screen.getByTestId(`beacon-offer-${NODE}`);
    expect(within(row).getByText('beacons.restore')).toBeTruthy();
    expect(within(row).queryByText('beacons.dismiss')).toBeNull();
    expect(within(row).queryByText('beacons.join_channel')).toBeNull();
  });
});

describe('actions', () => {
  it('dismisses through the per-broadcast endpoint', async () => {
    const user = await openList([offer()]);
    await user.click(screen.getByText('beacons.dismiss'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/sources/src-a/beacon-offers/${NODE}/dismiss`, undefined));
  });

  it('mutes through the permanent endpoint — a different action, not a longer dismiss', async () => {
    const user = await openList([offer()]);
    await user.click(screen.getByText('beacons.mute'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/sources/src-a/beacon-offers/${NODE}/mute`, undefined));
  });

  it('restores with a single un-mute, whichever flag hid the row', async () => {
    // Un-mute clears both flags server-side, so the user does not have to
    // remember which button hid it.
    const user = await openList([offer({ dismissedAt: 8_000, mutedAt: 9_000 })]);
    await user.click(screen.getByTestId('beacons-filter-hidden'));
    await user.click(screen.getByText('beacons.restore'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/sources/src-a/beacon-offers/${NODE}/unmute`, undefined));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('never writes to the device without an explicit confirmation', async () => {
    const user = await openList([offer()]);

    await user.click(screen.getByText('beacons.join_channel'));
    expect(screen.getByTestId('beacon-confirm-dialog')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('beacon-confirm-go'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      `/api/sources/src-a/beacon-offers/${NODE}/accept`,
      expect.objectContaining({ confirm: true }),
    ));
  });

  it('cancelling the confirmation writes nothing', async () => {
    const user = await openList([offer()]);

    await user.click(screen.getByText('beacons.join_channel'));
    await user.click(screen.getByText('common.cancel'));

    expect(screen.queryByTestId('beacon-confirm-dialog')).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('defaults to a free slot rather than the first one', async () => {
    // Picking an occupied slot by default would make "Replace and join" the
    // path of least resistance, which is exactly backwards.
    const user = await openList([offer()], { channels: [{ id: 1, name: 'Taken' }, { id: 2, name: 'AlsoTaken' }] });

    await user.click(screen.getByText('beacons.join_channel'));
    await user.click(screen.getByTestId('beacon-confirm-go'));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ slot: 3, overwrite: false }),
    ));
  });

  it('warns and asks for overwrite when the chosen slot is occupied', async () => {
    const channels = [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, name: `Ch${id}` }));
    const user = await openList([offer()], { channels });

    await user.click(screen.getByText('beacons.join_channel'));
    expect(screen.getByTestId('beacon-confirm-overwrite-warning')).toBeTruthy();

    await user.click(screen.getByTestId('beacon-confirm-go'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ overwrite: true }),
    ));
  });
});

describe('escape key layering', () => {
  it('closes the list', async () => {
    const user = await openList([offer()]);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('beacons-modal')).toBeNull();
  });

  it('cancels the join dialog without closing the list behind it', async () => {
    // One Escape, one thing dismissed. Closing both would lose the user's place
    // in a list they may have searched and sorted to get to.
    const user = await openList([offer()]);
    await user.click(screen.getByText('beacons.join_channel'));

    await user.keyboard('{Escape}');

    expect(screen.queryByTestId('beacon-confirm-dialog')).toBeNull();
    expect(screen.getByTestId('beacons-modal')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('selectOffers', () => {
  const rows = [
    offer({ nodeNum: 1, offerChannelName: 'Zulu', firstSeenAt: 10, lastSeenAt: 30, message: 'alpha text' }),
    offer({ nodeNum: 2, offerChannelName: null, firstSeenAt: 20, lastSeenAt: 20 }),
    offer({ nodeNum: 3, offerChannelName: 'Alpha', firstSeenAt: 30, lastSeenAt: 10, mutedAt: 5 }),
  ];
  const byLastSeen = { key: 'lastSeenAt', direction: 'desc' } as const;

  it('defaults to pending only', () => {
    expect(selectOffers(rows, 'pending', '', byLastSeen).map((o) => o.nodeNum)).toEqual([1, 2]);
  });

  it('shows only hidden rows on the hidden filter', () => {
    expect(selectOffers(rows, 'hidden', '', byLastSeen).map((o) => o.nodeNum)).toEqual([3]);
  });

  it('searches the message, the channel and the node id', () => {
    expect(selectOffers(rows, 'all', 'alpha text', byLastSeen).map((o) => o.nodeNum)).toEqual([1]);
    expect(selectOffers(rows, 'all', 'alpha', byLastSeen).map((o) => o.nodeNum)).toEqual([1, 3]);
    expect(selectOffers(rows, 'all', nodeHexId(2), byLastSeen).map((o) => o.nodeNum)).toEqual([2]);
  });

  it('searches the resolved node name, not just the hex id', () => {
    const nodeName = (n: number) => (n === 2 ? 'Repeater North' : undefined);
    expect(selectOffers(rows, 'all', 'repeater', byLastSeen, nodeName).map((o) => o.nodeNum)).toEqual([2]);
  });

  it('sorts channel-less offers last when ascending', () => {
    // Someone sorting by channel is looking for the named ones; an empty
    // string would clump them at the top instead.
    const sorted = selectOffers(rows, 'all', '', { key: 'channel', direction: 'asc' });
    expect(sorted.map((o) => o.nodeNum)).toEqual([3, 1, 2]);
  });

  it('sorts by last heard, newest first, by default', () => {
    expect(selectOffers(rows, 'all', '', byLastSeen).map((o) => o.nodeNum)).toEqual([1, 2, 3]);
  });

  it('sorts by first heard independently of last heard', () => {
    expect(selectOffers(rows, 'all', '', { key: 'firstSeenAt', direction: 'asc' }).map((o) => o.nodeNum))
      .toEqual([1, 2, 3]);
  });

  it('breaks ties deterministically so rows do not swap between renders', () => {
    const tied = [offer({ nodeNum: 9, lastSeenAt: 1 }), offer({ nodeNum: 4, lastSeenAt: 1 })];
    expect(selectOffers(tied, 'all', '', { key: 'lastSeenAt', direction: 'asc' }).map((o) => o.nodeNum))
      .toEqual([4, 9]);
  });
});

describe('stylesheet', () => {
  it('defines every class the components reference', () => {
    // Review catch on #4735: three `styles.*` references had no rule in the
    // module, so those buttons rendered unstyled. Nothing failed, because the
    // behavioural tests select by data-testid and a missing CSS-module key is
    // just `undefined` — invisible to React and to TypeScript.
    const dir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(dir, 'Beacons.module.css'), 'utf8');
    const defined = new Set(Array.from(css.matchAll(/^\.([A-Za-z][\w-]*)/gm), (m) => m[1]));

    const used = new Set<string>();
    for (const file of ['BeaconsPanel.tsx', 'BeaconsModal.tsx', 'BeaconJoinDialog.tsx']) {
      const tsx = readFileSync(join(dir, file), 'utf8');
      for (const m of tsx.matchAll(/styles\.([A-Za-z][\w]*)/g)) used.add(m[1]);
    }

    expect(Array.from(used).filter((c) => !defined.has(c))).toEqual([]);
  });
});
