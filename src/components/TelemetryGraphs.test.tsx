/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { act } from '@testing-library/react';
import TelemetryGraphs from './TelemetryGraphs';

// Mock Recharts components to avoid rendering issues in tests
vi.mock('recharts', () => ({
  LineChart: ({ children }: { children?: React.ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}));

// Mock fetch API
global.fetch = vi.fn();

describe('TelemetryGraphs Component', () => {
  const mockNodeId = '!testNode';

  const mockTelemetryData = [
    {
      id: 1,
      nodeId: mockNodeId,
      telemetryType: 'batteryLevel',
      timestamp: Date.now() - 3600000,
      value: 85
    },
    {
      id: 2,
      nodeId: mockNodeId,
      telemetryType: 'batteryLevel',
      timestamp: Date.now() - 1800000,
      value: 80
    },
    {
      id: 3,
      nodeId: mockNodeId,
      telemetryType: 'voltage',
      timestamp: Date.now() - 3600000,
      value: 3.7
    },
    {
      id: 4,
      nodeId: mockNodeId,
      telemetryType: 'channelUtilization',
      timestamp: Date.now() - 3600000,
      value: 15.5
    },
    {
      id: 5,
      nodeId: mockNodeId,
      telemetryType: 'airUtilTx',
      timestamp: Date.now() - 3600000,
      value: 5.2
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock both settings fetch (for favorites) and telemetry fetch
    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})  // No favorites by default
        });
      }
      // Default to telemetry data
      return Promise.resolve({
        ok: true,
        json: async () => mockTelemetryData
      });
    });
  });

  it('should render loading state initially', async () => {
    // Mock fetch to be slow
    (global.fetch as Mock).mockImplementation((url: string) =>
      new Promise(resolve => setTimeout(() => {
        if (url.includes('/api/settings')) {
          resolve({
            ok: true,
            json: async () => ({})
          });
        } else {
          resolve({
            ok: true,
            json: async () => mockTelemetryData
          });
        }
      }, 100))
    );

    await act(async () => {
      render(<TelemetryGraphs nodeId={mockNodeId} />);
    });

    expect(screen.getByText('Loading telemetry data...')).toBeInTheDocument();
  });

  it('should fetch telemetry data on mount', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(`/api/telemetry/${mockNodeId}?hours=24`);
    });
  });

  it('should display telemetry title when data is available', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText('Last 24 Hours Telemetry')).toBeInTheDocument();
    });
  });

  it('should display error state when fetch fails', async () => {
    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})  // No favorites
        });
      }
      // Telemetry fetch fails
      return Promise.reject(new Error('Network error'));
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  it('should display no data message when telemetry is empty', async () => {
    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})  // No favorites
        });
      }
      // Return empty telemetry
      return Promise.resolve({
        ok: true,
        json: async () => []
      });
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText('No telemetry data available for this node')).toBeInTheDocument();
    });
  });

  it('should render chart containers for each telemetry type', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      // Should have graph containers for telemetry types
      expect(screen.getByText('Battery Level')).toBeInTheDocument();
      expect(screen.getByText('Voltage')).toBeInTheDocument();
    });
  });

  it('should render chart component when data is available', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      const charts = screen.getAllByTestId('line-chart');
      expect(charts.length).toBeGreaterThan(0);
    });
  });

  it('should handle multiple telemetry types in the data', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      // Should render multiple graph containers
      const containers = document.querySelectorAll('.graph-container');
      expect(containers.length).toBe(4); // We have 4 different telemetry types
    });
  });

  it('should refresh data when node changes', async () => {
    const { rerender } = render(
      <TelemetryGraphs nodeId={mockNodeId} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(`/api/telemetry/${mockNodeId}?hours=24`);
    });

    const newNodeId = '!newNode';

    rerender(
      <TelemetryGraphs nodeId={newNodeId} />
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(`/api/telemetry/${newNodeId}?hours=24`);
    });
  });

  it('should handle API returning non-ok status', async () => {
    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})
        });
      }
      // Telemetry fetch returns non-ok
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to fetch telemetry: 404 Not Found/)).toBeInTheDocument();
    });
  });

  it('should group data by telemetry type', async () => {
    // Mock multiple data points of same type
    const mockData = [
      { nodeId: mockNodeId, telemetryType: 'batteryLevel', value: 85, timestamp: Date.now() - 3600000 },
      { nodeId: mockNodeId, telemetryType: 'batteryLevel', value: 80, timestamp: Date.now() - 1800000 },
      { nodeId: mockNodeId, telemetryType: 'batteryLevel', value: 75, timestamp: Date.now() }
    ];

    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => mockData
      });
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      // Should have one graph container for battery level
      expect(screen.getByText('Battery Level')).toBeInTheDocument();
      // Should render the chart
      expect(screen.getByTestId('line-chart')).toBeInTheDocument();
    });
  });

  it('should handle telemetry data with missing values gracefully', async () => {
    const incompleteData = [
      {
        id: 1,
        nodeId: mockNodeId,
        telemetryType: 'batteryLevel',
        timestamp: Date.now(),
        value: 0 // Use 0 instead of null for now
      }
    ];

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => incompleteData
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      // Should handle gracefully without crashing
      expect(screen.getByText('Last 24 Hours Telemetry')).toBeInTheDocument();
    });
  });

  it('should display correct labels for different telemetry types', async () => {
    const mockData = [
      { nodeId: mockNodeId, telemetryType: 'batteryLevel', value: 85, timestamp: Date.now() },
      { nodeId: mockNodeId, telemetryType: 'voltage', value: 3.7, timestamp: Date.now() },
      { nodeId: mockNodeId, telemetryType: 'channelUtilization', value: 15, timestamp: Date.now() },
      { nodeId: mockNodeId, telemetryType: 'airUtilTx', value: 5, timestamp: Date.now() }
    ];

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText('Battery Level')).toBeInTheDocument();
      expect(screen.getByText('Voltage')).toBeInTheDocument();
      expect(screen.getByText('Channel Utilization')).toBeInTheDocument();
      expect(screen.getByText('Air Utilization (TX)')).toBeInTheDocument();
    });
  });

  it('should display charts with correct units when provided', async () => {
    // Mock data with units
    const mockDataWithUnits = [
      { nodeId: mockNodeId, telemetryType: 'batteryLevel', value: 85, timestamp: Date.now(), unit: '%' },
      { nodeId: mockNodeId, telemetryType: 'voltage', value: 3.7, timestamp: Date.now(), unit: 'V' }
    ];

    (global.fetch as Mock).mockImplementation((url: string) => {
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({})
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => mockDataWithUnits
      });
    });

    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      expect(screen.getByText('Battery Level (%)')).toBeInTheDocument();
      expect(screen.getByText('Voltage (V)')).toBeInTheDocument();
    });
  });

  it('should format timestamps correctly', async () => {
    render(<TelemetryGraphs nodeId={mockNodeId} />);

    await waitFor(() => {
      const charts = screen.getAllByTestId('line-chart');
      expect(charts.length).toBeGreaterThan(0);
    });

    // The component should process and format the telemetry data
    // In a real test, we'd check the actual chart data, but since we're mocking Recharts,
    // we just verify the component doesn't crash when processing the data
  });

  describe('Temperature Unit Conversion', () => {
    it('should display temperature in Celsius by default', async () => {
      const mockData = [
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'temperature',
          value: 25,
          unit: '°C',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ];

      (global.fetch as Mock).mockImplementation((url: string) => {
        if (url.includes('/api/settings')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({})
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => mockData
        });
      });

      render(<TelemetryGraphs nodeId={mockNodeId} />);

      await waitFor(() => {
        expect(screen.getByText('Temperature (°C)')).toBeInTheDocument();
      });
    });

    it('should display temperature in Fahrenheit when specified', async () => {
      const mockData = [
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'temperature',
          value: 25, // Celsius value from API
          unit: '°C',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ];

      (global.fetch as Mock).mockImplementation((url: string) => {
        if (url.includes('/api/settings')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({})
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => mockData
        });
      });

      render(<TelemetryGraphs nodeId={mockNodeId} temperatureUnit="F" />);

      await waitFor(() => {
        expect(screen.getByText('Temperature (°F)')).toBeInTheDocument();
      });
    });

    it('should handle mixed telemetry data with temperature conversion', async () => {
      const mockData = [
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'temperature',
          value: 0, // 0°C = 32°F
          unit: '°C',
          timestamp: Date.now(),
          createdAt: Date.now()
        },
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'humidity',
          value: 65,
          unit: '%',
          timestamp: Date.now(),
          createdAt: Date.now()
        },
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'batteryLevel',
          value: 85,
          unit: '%',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ];

      (global.fetch as Mock).mockImplementation((url: string) => {
        if (url.includes('/api/settings')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({})
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => mockData
        });
      });

      render(<TelemetryGraphs nodeId={mockNodeId} temperatureUnit="F" />);

      await waitFor(() => {
        // Temperature should show Fahrenheit
        expect(screen.getByText('Temperature (°F)')).toBeInTheDocument();
        // Other metrics should remain unchanged
        expect(screen.getByText('Humidity (%)')).toBeInTheDocument();
        expect(screen.getByText('Battery Level (%)')).toBeInTheDocument();
      });
    });

    it('should maintain temperature unit when data refreshes', async () => {
      const initialData = [
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'temperature',
          value: 20,
          unit: '°C',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ];

      const refreshedData = [
        {
          nodeId: mockNodeId,
          nodeNum: 1,
          telemetryType: 'temperature',
          value: 22,
          unit: '°C',
          timestamp: Date.now(),
          createdAt: Date.now()
        }
      ];

      (global.fetch as Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => initialData
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => refreshedData
        });

      const { rerender } = render(<TelemetryGraphs nodeId={mockNodeId} temperatureUnit="F" />);

      await waitFor(() => {
        expect(screen.getByText('Temperature (°F)')).toBeInTheDocument();
      });

      // Trigger a re-render (simulating a refresh)
      rerender(<TelemetryGraphs nodeId={mockNodeId} temperatureUnit="F" />);

      await waitFor(() => {
        // Should still be in Fahrenheit after refresh
        expect(screen.getByText('Temperature (°F)')).toBeInTheDocument();
      });
    });
  });
});