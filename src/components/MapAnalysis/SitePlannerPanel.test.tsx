/**
 * @vitest-environment jsdom
 *
 * Site Planner panel (#4727).
 *
 * This drives a prediction users will act on, so the assertions concentrate on
 * honesty: that it says which numbers came from the radio and which were
 * assumed, that it refuses to predict without an origin, and that it never
 * presents the output as measured coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getCurrentConfig = vi.fn();
const post = vi.fn();

vi.mock('../../services/api', () => ({
  default: {
    getCurrentConfig: (...a: unknown[]) => getCurrentConfig(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k) }),
}));
vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import SitePlannerPanel from './SitePlannerPanel';

const origin = { id: 'n1', lat: 30, lng: -97, isNode: true, name: 'Hilltop' };

const renderPanel = (props: Record<string, unknown> = {}) =>
  render(
    <SitePlannerPanel
      open
      sourceId="src-a"
      origin={origin}
      onClose={() => {}}
      onCoverage={props.onCoverage as never ?? (() => {})}
      {...props}
    />,
  );

beforeEach(() => {
  getCurrentConfig.mockReset().mockResolvedValue({ deviceConfig: { lora: { region: 1, txPower: 27 } } });
  post.mockReset().mockResolvedValue({ success: true, data: { radials: [], assumptions: [] } });
});

describe('SitePlannerPanel', () => {
  it('renders nothing when closed', () => {
    renderPanel({ open: false });
    expect(screen.queryByTestId('site-planner-panel')).toBeNull();
  });

  it('seeds radio values from the live LoRa config and says which came from it', async () => {
    renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledWith('src-a'));

    await waitFor(() =>
      expect((screen.getByTestId('site-planner-txPowerDbm') as HTMLInputElement).value).toBe('27'));
    expect(screen.getByTestId('site-planner-seeded').textContent).toMatch(/site_planner\.seeded/);
  });

  it('says values are assumed when the radio cannot be read', async () => {
    // A prediction on guessed inputs looks exactly as confident as one on real
    // inputs, so the difference has to be stated.
    getCurrentConfig.mockRejectedValue(new Error('offline'));
    renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('site-planner-seeded').textContent).toMatch(/not_seeded/));
  });

  it('refuses to predict without an origin', async () => {
    renderPanel({ origin: null });
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());

    expect((screen.getByTestId('site-planner-run') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('site-planner-origin').textContent).toMatch(/pick_origin/);
  });

  it('distinguishes a node origin from a bare coordinate', async () => {
    const { rerender } = renderPanel();
    await waitFor(() => expect(screen.getByTestId('site-planner-origin').textContent).toMatch(/origin_node/));

    rerender(
      <SitePlannerPanel open sourceId="src-a" onClose={() => {}} onCoverage={() => {}}
        origin={{ id: 'pt', lat: 31, lng: -98, isNode: false }} />,
    );
    // A proposed site with no node must not be labelled as one.
    expect(screen.getByTestId('site-planner-origin').textContent).toMatch(/origin_point/);
  });

  it('posts the seeded parameters and hands the result up', async () => {
    const onCoverage = vi.fn();
    const user = userEvent.setup();
    renderPanel({ onCoverage });
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());

    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/rf/coverage', expect.objectContaining({
      origin: { lat: 30, lng: -97 },
      txPowerDbm: 27,
    })));
    await waitFor(() => expect(onCoverage).toHaveBeenCalled());
  });

  it('surfaces a failure instead of leaving a stale polygon on the map', async () => {
    const onCoverage = vi.fn();
    const user = userEvent.setup();
    post.mockImplementation(() => { throw new Error('boom'); });
    renderPanel({ onCoverage });
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());

    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Clearing the coverage matters: a failed re-run must not leave the
    // previous prediction drawn as though it were current.
    expect(onCoverage).toHaveBeenCalledWith(null);
  });

  it('re-seeds when the source changes', async () => {
    // Carrying one radio's frequency and power to another would predict with
    // the wrong radio while still claiming the values were read from a device.
    const { rerender } = renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledWith('src-a'));

    getCurrentConfig.mockResolvedValue({ deviceConfig: { lora: { region: 2, txPower: 14 } } });
    rerender(
      <SitePlannerPanel open sourceId="src-b" origin={origin} onClose={() => {}} onCoverage={() => {}} />,
    );

    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledWith('src-b'));
    await waitFor(() =>
      expect((screen.getByTestId('site-planner-txPowerDbm') as HTMLInputElement).value).toBe('14'));
  });

  it('lets the user correct the frequency the seeding guessed', async () => {
    // Previously seeded-but-unreachable: a non-US user whose seeding failed
    // had no way to fix the band.
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());

    const input = screen.getByTestId('site-planner-frequencyMhz') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '868');
    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/rf/coverage',
      expect.objectContaining({ frequencyHz: 868e6 })));
  });

  it('always states that this is modelled, not measured', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('site_planner.caveat')).toBeTruthy());
  });

  const radial = (over: Record<string, unknown>) => ({
    bearingDeg: 0, reachKm: 15, limitedByRadius: true, reachablePocketsBeyond: false, hasDataGaps: false, ...over,
  });

  it('explains a radius-limited (circular) result in the panel, not just the polygon popup', async () => {
    // The whole point of this fix (#4727): a circle means "budget outran terrain
    // within the radius", and that must be visible in the panel, not buried in a
    // click-to-open polygon popup.
    const user = userEvent.setup();
    post.mockResolvedValue({ success: true, data: { radiusKm: 15, assumptions: [], radials: [
      radial({ bearingDeg: 0 }), radial({ bearingDeg: 120 }), radial({ bearingDeg: 240 }),
    ] } });
    renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() =>
      expect(screen.getByTestId('site-planner-notice-radius').textContent).toMatch(/result_radius_limited/));
    // 100% radius-limited → the percentage travels in the message.
    expect(screen.getByTestId('site-planner-notice-radius').textContent).toMatch(/"percent":100/);
  });

  it('warns when terrain data was missing (a circle that really is terrain-free)', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ success: true, data: { radiusKm: 15, assumptions: [], radials: [
      radial({ bearingDeg: 0, hasDataGaps: true }),
      radial({ bearingDeg: 180, hasDataGaps: true }),
      radial({ bearingDeg: 270, hasDataGaps: true }),
    ] } });
    renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() =>
      expect(screen.getByTestId('site-planner-notice-gaps').textContent).toMatch(/result_data_gaps/));
  });

  it('shows no shape notice when terrain fully shaped the coverage', async () => {
    const user = userEvent.setup();
    post.mockResolvedValue({ success: true, data: { radiusKm: 15, assumptions: [], radials: [
      radial({ bearingDeg: 0, reachKm: 7, limitedByRadius: false }),
      radial({ bearingDeg: 180, reachKm: 9, limitedByRadius: false }),
      radial({ bearingDeg: 270, reachKm: 5, limitedByRadius: false }),
    ] } });
    renderPanel();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await user.click(screen.getByTestId('site-planner-run'));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByTestId('site-planner-notice')).toBeNull();
  });
});
