/**
 * @vitest-environment jsdom
 *
 * SignalTrendBadge (#6262): the shared badge extracted from NodeDetailsBlock,
 * also mounted for MeshCore contacts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SignalTrendBadge from './SignalTrendBadge';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('./NodeDetailsBlock.css', () => ({}));

const getSignalTrend = vi.fn();
vi.mock('../services/api', () => ({
  default: { getSignalTrend: (...args: unknown[]) => getSignalTrend(...args) },
}));

const PK = 'a'.repeat(64);

describe('SignalTrendBadge', () => {
  beforeEach(() => getSignalTrend.mockReset());

  it('renders the trend label and queries with the nodeId and sourceId', async () => {
    getSignalTrend.mockResolvedValue({
      trend: 'degrading',
      rssi: { delta: -6, unit: 'dBm', recent: -100, baseline: -94 },
    });
    render(<SignalTrendBadge nodeId={PK} sourceId="src-mc" />);
    await waitFor(() => expect(screen.getByText('Degrading')).toBeTruthy());
    expect(getSignalTrend).toHaveBeenCalledWith(PK, 'src-mc');
    expect(screen.getByText('Degrading').closest('.signal-trend')?.getAttribute('title')).toContain('RSSI -6 dBm');
  });

  it('renders nothing for insufficient history', async () => {
    getSignalTrend.mockResolvedValue({ trend: 'insufficient' });
    const { container } = render(<SignalTrendBadge nodeId={PK} sourceId="src-mc" />);
    await waitFor(() => expect(getSignalTrend).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('does not fetch without a sourceId', () => {
    const { container } = render(<SignalTrendBadge nodeId={PK} />);
    expect(getSignalTrend).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});
