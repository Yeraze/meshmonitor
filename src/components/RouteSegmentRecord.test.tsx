/**
 * RouteSegmentRecord (#5101 P2 WP5).
 *
 * Covers: transport label shown/omitted, legacy note gated on
 * `segment.transportMechanism === null`, and the Clear Record button only
 * rendering when `onClear` is provided (and firing it on click).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RouteSegmentRecord from './RouteSegmentRecord';
import type { RouteSegmentView } from '../services/api';

function makeSegment(overrides: Partial<RouteSegmentView> = {}): RouteSegmentView {
  return {
    id: 1,
    fromNodeNum: 1,
    toNodeNum: 2,
    fromNodeId: '!1',
    toNodeId: '!2',
    fromNodeName: 'Node A',
    toNodeName: 'Node B',
    distanceKm: 12.5,
    timestamp: 1700000000000,
    isRecordHolder: true,
    transportMechanism: 1,
    transport: 'rf',
    ...overrides,
  };
}

const baseProps = {
  timeLabel: 'info.achieved',
  distanceUnit: 'km' as const,
  timeFormat: '24' as const,
  dateFormat: 'MM/DD/YYYY' as const,
};

describe('RouteSegmentRecord (#5101)', () => {
  it('renders the transport label when provided', () => {
    render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} transportLabel="transport.rf" testId="rec" />);
    const el = screen.getByTestId('rec');
    expect(el.textContent).toContain('transport.rf');
  });

  it('omits the transport label when not provided', () => {
    render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} testId="rec" />);
    const el = screen.getByTestId('rec');
    expect(el).not.toHaveAttribute('aria-label');
  });

  it('sets aria-label from info.route_record_label when a transport label is provided', () => {
    render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} transportLabel="transport.rf" testId="rec" />);
    // The test-suite's react-i18next mock (src/test/setup.ts) interpolates
    // `{{key}}` placeholders found IN THE KEY STRING itself, not a resolved
    // translation, so a plain key like `info.route_record_label` is returned
    // unchanged — this only asserts the right key was used, per the pattern
    // in InfoTab.transportBreakdown.test.tsx (`toContain('info.heard_via')`).
    expect(screen.getByTestId('rec')).toHaveAttribute('aria-label', 'info.route_record_label');
  });

  it('renders the distance, from, and to fields', () => {
    render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} testId="rec" />);
    const el = screen.getByTestId('rec');
    expect(el.textContent).toContain('Node A');
    expect(el.textContent).toContain('Node B');
    expect(el.textContent).toContain('!1');
    expect(el.textContent).toContain('!2');
  });

  it('renders the trophy icon only when showTrophy is set', () => {
    const { rerender } = render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} showTrophy testId="rec" />);
    expect(screen.getByTestId('rec').querySelector('svg')).toBeTruthy();

    rerender(<RouteSegmentRecord {...baseProps} segment={makeSegment()} testId="rec" />);
    expect(screen.getByTestId('rec').querySelector('svg')).toBeNull();
  });

  it('shows the legacy note only when transportMechanism is null', () => {
    render(
      <RouteSegmentRecord
        {...baseProps}
        segment={makeSegment({ transportMechanism: null })}
        legacyNote="legacy note text"
        testId="rec"
      />
    );
    expect(screen.getByTestId('rec').textContent).toContain('legacy note text');
  });

  it('hides the legacy note when transportMechanism is set, even if legacyNote is passed', () => {
    render(
      <RouteSegmentRecord
        {...baseProps}
        segment={makeSegment({ transportMechanism: 1 })}
        legacyNote="legacy note text"
        testId="rec"
      />
    );
    expect(screen.getByTestId('rec').textContent).not.toContain('legacy note text');
  });

  it('omits the legacy note when legacyNote is not passed, even for a null-mechanism row', () => {
    render(<RouteSegmentRecord {...baseProps} segment={makeSegment({ transportMechanism: null })} testId="rec" />);
    expect(screen.getByTestId('rec').textContent).not.toContain('legacy note');
  });

  it('renders the Clear Record button only when onClear is provided', () => {
    const { rerender } = render(<RouteSegmentRecord {...baseProps} segment={makeSegment()} testId="rec" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    const onClear = vi.fn();
    rerender(
      <RouteSegmentRecord {...baseProps} segment={makeSegment()} onClear={onClear} clearLabel="info.clear_record" testId="rec" />
    );
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('info.clear_record');
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
