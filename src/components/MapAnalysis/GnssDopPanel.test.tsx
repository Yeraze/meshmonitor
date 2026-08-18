/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GnssDopPanel from './GnssDopPanel';
import type { GnssDopUiParams, GnssDopMeta } from '../map/layers/gnssDopGeometry';

vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

const HOUR_MS = 3_600_000;
const BASE_TIME = 1_700_000_000_000;

function params(overrides: Partial<GnssDopUiParams> = {}): GnssDopUiParams {
  return { maskDeg: 5, timeMs: BASE_TIME, constellations: ['gps'], ...overrides };
}

describe('GnssDopPanel', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChange = vi.fn();
    onClose = vi.fn();
  });

  it('renders nothing when closed', () => {
    render(<GnssDopPanel open={false} params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    expect(screen.queryByTestId('gnss-dop-panel')).toBeNull();
  });

  it('renders the panel, its legend, and the time control when open', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    expect(screen.getByTestId('gnss-dop-panel')).toBeInTheDocument();
    expect(screen.getByTestId('gnss-dop-legend')).toBeInTheDocument();
    expect(screen.getByTestId('gnss-dop-time')).toBeInTheDocument();
  });

  it('the time scrubber drives the timeMs param the layer consumes', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    fireEvent.change(screen.getByTestId('gnss-dop-time'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ timeMs: BASE_TIME + 3 * HOUR_MS }),
    );
  });

  it('the Now button re-anchors the time to the present', () => {
    const now = 1_700_000_500_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('gnss-dop-time-now'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ timeMs: now }));
    vi.restoreAllMocks();
  });

  it('clamps the elevation-mask input into [0, 90]', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    const mask = screen.getByTestId('gnss-dop-mask');
    fireEvent.change(mask, { target: { value: '95' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maskDeg: 90 }));
    fireEvent.change(mask, { target: { value: '-5' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maskDeg: 0 }));
  });

  it('offers GPS enabled and the other constellations disabled (v1)', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    const gps = screen.getByTestId('gnss-dop-constellation-gps') as HTMLInputElement;
    const galileo = screen.getByTestId('gnss-dop-constellation-galileo') as HTMLInputElement;
    expect(gps.checked).toBe(true);
    expect(gps.disabled).toBe(false);
    expect(galileo.disabled).toBe(true);
  });

  it('never lets the constellation set go empty (an empty request would 400)', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    // Unchecking the only enabled constellation falls back to GPS rather than [].
    fireEvent.click(screen.getByTestId('gnss-dop-constellation-gps'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ constellations: ['gps'] }));
  });

  it('shows the resolution-reduced notice only when the last fetch was clamped', () => {
    const meta: GnssDopMeta = {
      clamped: true, stepDeg: 0.5, requestedStepDeg: 0.2, cellCount: 100, loading: false, error: null,
    };
    const { rerender } = render(
      <GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />,
    );
    expect(screen.queryByTestId('gnss-dop-clamped')).toBeNull();
    rerender(<GnssDopPanel open params={params()} meta={meta} onChange={onChange} onClose={onClose} />);
    expect(screen.getByTestId('gnss-dop-clamped')).toBeInTheDocument();
  });

  it('closes via the header button', () => {
    render(<GnssDopPanel open params={params()} meta={null} onChange={onChange} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('common.close'));
    expect(onClose).toHaveBeenCalled();
  });
});
