/**
 * @vitest-environment jsdom
 *
 * Ducting overlay control (#5734): hidden while the admin switch is off, the
 * scrubber's debounce and step labels, and the inline error states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DuctingControl } from './DuctingControl';
import { DUCTING_SCRUB_DEBOUNCE_MS, formatGfsCycle, formatValidTimeLocal } from './layers/ductingGeometry';
import { ApiError } from '../../services/api';

const mocks = vi.hoisted(() => ({
  enabled: true,
  query: { data: undefined as unknown, error: null as unknown, isFetching: false, isPlaceholderData: false },
  forecastArgs: [] as Array<{ hours: number; enabled: boolean }>,
}));

vi.mock('../../hooks/useDuctingForecast', () => ({
  DUCTING_MAX_HOURS_AHEAD: 72,
  DUCTING_STEP_HOURS: 3,
  useDuctingEnabled: () => mocks.enabled,
  useDuctingForecast: (hours: number, enabled: boolean) => {
    mocks.forecastArgs.push({ hours, enabled });
    return mocks.query;
  },
}));

const FORECAST = {
  cycle: '2026-10-20T12:00:00.000Z',
  forecastHour: 9,
  validTime: '2026-10-20T21:00:00.000Z',
};

function renderControl(over: Partial<React.ComponentProps<typeof DuctingControl>> = {}) {
  const props = {
    checked: true,
    onCheckedChange: vi.fn(),
    hoursAhead: 0,
    onHoursAheadChange: vi.fn(),
    ...over,
  };
  const utils = render(<DuctingControl {...props} />);
  return { ...utils, props };
}

const slider = () => screen.getByRole('slider') as HTMLInputElement;

describe('DuctingControl', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.query = { data: undefined, error: null, isFetching: false, isPlaceholderData: false };
    mocks.forecastArgs = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while the admin switch is off', () => {
    mocks.enabled = false;
    const { container } = renderControl();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows only the toggle while unticked, and asks for no forecast', () => {
    const { props } = renderControl({ checked: false });
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(mocks.forecastArgs.every((a) => a.enabled === false)).toBe(true);
    fireEvent.click(box);
    expect(props.onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('is disabled, with no scrubber, when the map cannot draw it (3D)', () => {
    renderControl({ disabledTitle: 'Not available in 3D' });
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('offers 25 steps, now to +72 h', () => {
    renderControl();
    expect(slider().min).toBe('0');
    expect(slider().max).toBe('24');
    expect(slider().step).toBe('1');
  });

  it('commits one step after the slider rests, not one per step dragged', () => {
    vi.useFakeTimers();
    const { props } = renderControl();
    for (const step of [1, 2, 3, 4, 5]) fireEvent.change(slider(), { target: { value: String(step) } });
    // The label follows the slider at once.
    expect(screen.getByTestId('ducting-step').dataset.hours).toBe('15');
    act(() => {
      vi.advanceTimersByTime(DUCTING_SCRUB_DEBOUNCE_MS - 1);
    });
    expect(props.onHoursAheadChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(props.onHoursAheadChange).toHaveBeenCalledTimes(1);
    expect(props.onHoursAheadChange).toHaveBeenCalledWith(15);
  });

  it('labels a loaded step with its local valid time and the GFS run', () => {
    mocks.query = { data: FORECAST, error: null, isFetching: false, isPlaceholderData: false };
    renderControl({ hoursAhead: 9 });
    expect(screen.getByTestId('ducting-step').dataset.hours).toBe('9');
    expect(slider().value).toBe('3');
    expect(screen.getByTestId('ducting-valid-time')).toHaveTextContent(formatValidTimeLocal(FORECAST.validTime));
    expect(screen.getByTestId('ducting-cycle')).toHaveTextContent(formatGfsCycle(FORECAST.cycle));
    expect(formatGfsCycle(FORECAST.cycle)).toBe('2026-10-20 12Z');
  });

  it('does not label a step with the previous step\'s times while the new one loads', () => {
    mocks.query = { data: FORECAST, error: null, isFetching: true, isPlaceholderData: true };
    renderControl({ hoursAhead: 12 });
    expect(screen.queryByTestId('ducting-valid-time')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('map.ducting.loading');
  });

  it.each([
    [503, 'GFS_UNAVAILABLE', 'map.ducting.error_unavailable'],
    [502, 'GFS_UNREADABLE', 'map.ducting.error_unreadable'],
    [400, 'NO_AREA', 'map.ducting.error_no_area'],
    [500, 'INTERNAL_ERROR', 'map.ducting.error_generic'],
  ])('shows one inline line for HTTP %i', (status, code, key) => {
    mocks.query = { data: undefined, error: new ApiError('x', status, { code }), isFetching: false, isPlaceholderData: false };
    renderControl();
    expect(screen.getByRole('alert')).toHaveTextContent(key);
  });

  it('shows the legend, the coarse-levels caveat and the NOAA attribution', () => {
    renderControl();
    expect(screen.getByText('map.ducting.class_normal')).toBeInTheDocument();
    expect(screen.getByText('map.ducting.class_super')).toBeInTheDocument();
    expect(screen.getByText('map.ducting.class_duct')).toBeInTheDocument();
    expect(screen.getByText('map.ducting.caveat')).toBeInTheDocument();
    expect(screen.getByText('map.ducting.attribution')).toBeInTheDocument();
  });
});
