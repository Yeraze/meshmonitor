/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MapAnalysisProvider } from './MapAnalysisContext';
import TimeSliderControl from './TimeSliderControl';

describe('TimeSliderControl', () => {
  beforeEach(() => localStorage.clear());

  it('hides itself when timeSlider.enabled is false', () => {
    render(
      <MapAnalysisProvider>
        <TimeSliderControl />
      </MapAnalysisProvider>,
    );
    expect(screen.queryByTestId('time-slider')).not.toBeInTheDocument();
  });

  it('renders when timeSlider.enabled is true', () => {
    localStorage.setItem(
      'mapAnalysis.config.v1',
      JSON.stringify({
        version: 1,
        layers: {},
        sources: [],
        timeSlider: { enabled: true, windowStartMs: 0, windowEndMs: Date.now() },
        inspectorOpen: true,
      }),
    );
    render(
      <MapAnalysisProvider>
        <TimeSliderControl />
      </MapAnalysisProvider>,
    );
    expect(screen.getByTestId('time-slider')).toBeInTheDocument();
  });
});
