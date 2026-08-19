/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SkyPlot, type SkyPlotSatellite } from './SkyPlot';

const fixture: SkyPlotSatellite[] = [
  { name: 'G01', azDeg: 0, elDeg: 90 }, // zenith → centre
  { name: 'G02', azDeg: 90, elDeg: 45 }, // due east
  { name: 'G03', azDeg: 180, elDeg: 10 }, // low, south
  { name: 'G04', azDeg: 270, elDeg: 60 }, // due west
];

describe('SkyPlot', () => {
  it('renders one dot per satellite', () => {
    render(<SkyPlot satellites={fixture} />);
    expect(screen.getAllByTestId('skyplot-sat')).toHaveLength(fixture.length);
  });

  it('labels each satellite', () => {
    render(<SkyPlot satellites={fixture} />);
    for (const sat of fixture) {
      expect(screen.getByText(sat.name)).toBeInTheDocument();
    }
  });

  it('draws the elevation rings and cardinal labels', () => {
    render(<SkyPlot satellites={fixture} />);
    // Two elevation rings (30°, 60°).
    expect(screen.getAllByTestId('skyplot-ring')).toHaveLength(2);
    for (const c of ['N', 'E', 'S', 'W']) {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });

  it('renders an empty plot (rings + cardinals, no dots) without crashing', () => {
    render(<SkyPlot satellites={[]} />);
    expect(screen.queryAllByTestId('skyplot-sat')).toHaveLength(0);
    expect(screen.getAllByTestId('skyplot-ring')).toHaveLength(2);
    expect(screen.getByText('N')).toBeInTheDocument();
  });

  it('renders the DOP row when dop is provided', () => {
    render(
      <SkyPlot
        satellites={fixture}
        dop={{ gdop: 2.4, pdop: 2.1, hdop: 1.2, vdop: 1.7 }}
      />,
    );
    expect(screen.getByText('2.1')).toBeInTheDocument(); // PDOP
    expect(screen.getByText('1.2')).toBeInTheDocument(); // HDOP
    expect(screen.getByText('1.7')).toBeInTheDocument(); // VDOP
  });

  it('omits the DOP row when dop is null', () => {
    render(<SkyPlot satellites={fixture} dop={null} />);
    expect(screen.queryByLabelText('Dilution of precision')).not.toBeInTheDocument();
  });
});
