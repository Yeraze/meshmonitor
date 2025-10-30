/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import TracerouteHistoryModal from './TracerouteHistoryModal';
import { DeviceInfo } from '../types/device';
import ApiService from '../services/api';

// Mock ApiService
vi.mock('../services/api', () => ({
  default: {
    getTracerouteHistory: vi.fn(),
  },
}));

// Mock the SettingsContext
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    timeFormat: '24' as const,
    dateFormat: 'MM/DD/YYYY' as const,
    distanceUnit: 'km' as const,
  }),
}));

// Mock the formatTracerouteRoute utility
vi.mock('../utils/traceroute', () => ({
  formatTracerouteRoute: () => 'mocked route',
}));

// Mock formatDateTime utility
vi.mock('../utils/datetime', () => ({
  formatDateTime: () => '2025-01-01 12:00',
}));

describe('TracerouteHistoryModal - Node Direction Display', () => {
  const mockNodes: DeviceInfo[] = [
    {
      nodeNum: 100,
      user: {
        id: '!64',
        longName: 'Local Node',
        shortName: 'LOCAL',
        hwModel: 31,
        role: '1',
      },
      position: { latitude: 40.0, longitude: -75.0, altitude: 100 },
    },
    {
      nodeNum: 200,
      user: {
        id: '!c8',
        longName: 'Remote Node',
        shortName: 'REMOTE',
        hwModel: 31,
        role: '1',
      },
      position: { latitude: 40.1, longitude: -75.1, altitude: 100 },
    },
  ];

  const mockTraceroutes = [
    {
      id: 1,
      fromNodeId: '!64',
      fromNodeNum: 100,
      toNodeId: '!c8',
      toNodeNum: 200,
      route: '[]',
      routeBack: '[]',
      snrTowards: '[]',
      snrBack: '[]',
      timestamp: Date.now() - 60000,
      createdAt: Date.now() - 60000,
      hopCount: 0,
    },
  ];

  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup default mock response
    vi.mocked(ApiService.getTracerouteHistory).mockResolvedValue(mockTraceroutes);
  });

  /**
   * CRITICAL TEST: Verify traceroute history header displays correct node direction.
   *
   * This test prevents regression of issue where node direction was reversed,
   * showing "Remote Node → Local Node" when it should be "Local Node → Remote Node".
   *
   * Expected behavior:
   * - Header should show: From: fromNodeName → To: toNodeName
   * - This represents: traceroute FROM local node TO remote node
   * - NOT: From: toNodeName → To: fromNodeName (which was the bug)
   */
  it('should display header in correct direction: fromNodeName → toNodeName', async () => {
    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // Wait for the component to load data
    await waitFor(() => {
      expect(ApiService.getTracerouteHistory).toHaveBeenCalledWith(100, 200);
    });

    // The header should show the correct direction
    // fromNodeNum=100 (Local Node), toNodeNum=200 (Remote Node)
    // Header should display: "From: Local Node → To: Remote Node"
    expect(screen.getByText(/From:/)).toBeInTheDocument();
    expect(screen.getByText(/To:/)).toBeInTheDocument();

    // Check for the correct order
    const headerText = screen.getByText(/Local Node/).closest('div');
    expect(headerText?.textContent).toMatch(/From:.*Local Node.*→.*To:.*Remote Node/);
  });

  /**
   * CRITICAL TEST: Verify the modal does NOT display reversed direction.
   *
   * This test ensures we don't regress to the bug where nodes were swapped.
   */
  it('should NOT display header in reversed direction', async () => {
    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    await waitFor(() => {
      expect(ApiService.getTracerouteHistory).toHaveBeenCalled();
    });

    // The header text should NOT have Remote Node before Local Node
    const headerText = screen.getByText(/Local Node/).closest('div');
    expect(headerText?.textContent).not.toMatch(/From:.*Remote Node.*→.*To:.*Local Node/);
  });

  /**
   * Test modal title header
   */
  it('should display correct modal title', async () => {
    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    await waitFor(() => {
      expect(ApiService.getTracerouteHistory).toHaveBeenCalled();
    });

    expect(screen.getByText('Traceroute History')).toBeInTheDocument();
  });

  /**
   * Test with empty response
   */
  it('should display message when no traceroutes are found', async () => {
    vi.mocked(ApiService.getTracerouteHistory).mockResolvedValue([]);

    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('No traceroute history found for this node pair.')).toBeInTheDocument();
    });
  });

  /**
   * Test loading state
   */
  it('should display loading state while fetching data', () => {
    // Mock a delayed response
    vi.mocked(ApiService.getTracerouteHistory).mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(mockTraceroutes), 100))
    );

    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    // Should show loading indicator
    expect(screen.getByText('Loading traceroute history...')).toBeInTheDocument();
  });

  /**
   * Test error state
   */
  it('should display error message when fetch fails', async () => {
    vi.mocked(ApiService.getTracerouteHistory).mockRejectedValue(new Error('Network error'));

    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load traceroute history')).toBeInTheDocument();
    });
  });

  /**
   * Test that API is called with correct parameters
   */
  it('should call API with correct fromNodeNum and toNodeNum parameters', () => {
    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    expect(ApiService.getTracerouteHistory).toHaveBeenCalledWith(100, 200);
    // Ensure it's NOT called with reversed parameters
    expect(ApiService.getTracerouteHistory).not.toHaveBeenCalledWith(200, 100);
  });

  /**
   * Test checkbox for showing/hiding failed traceroutes
   */
  it('should display checkbox for filtering failed traceroutes', async () => {
    render(
      <TracerouteHistoryModal
        fromNodeNum={100}
        toNodeNum={200}
        fromNodeName="Local Node"
        toNodeName="Remote Node"
        nodes={mockNodes}
        onClose={mockOnClose}
      />
    );

    await waitFor(() => {
      expect(ApiService.getTracerouteHistory).toHaveBeenCalled();
    });

    const checkbox = screen.getByRole('checkbox', { name: /Show failed traceroutes/i });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toBeChecked(); // Should be checked by default
  });
});
