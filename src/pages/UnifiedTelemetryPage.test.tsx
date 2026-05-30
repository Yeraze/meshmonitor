/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UnifiedTelemetryPage from './UnifiedTelemetryPage';

const tempEntry = {
  nodeId: '!abcd1234',
  nodeNum: 1,
  telemetryType: 'temperature',
  value: 25, // Celsius from the device
  unit: '°C',
  timestamp: Date.now(),
  sourceId: 'src1',
  sourceName: 'Source One',
  nodeLongName: 'Test Node',
  nodeShortName: 'TN',
};

function mockTelemetryResponse(entries: unknown[]) {
  global.fetch = vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/api/unified/telemetry')) {
      return Promise.resolve({ ok: true, json: async () => entries });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/telemetry']}>
        <UnifiedTelemetryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UnifiedTelemetryPage temperature unit', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('displays Celsius by default', async () => {
    mockTelemetryResponse([tempEntry]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('25.0')).toBeInTheDocument();
    });
    expect(screen.getByText('°C')).toBeInTheDocument();
  });

  it('converts the value and label to Fahrenheit when preference is F', async () => {
    localStorage.setItem('temperatureUnit', 'F');
    mockTelemetryResponse([tempEntry]);
    renderPage();

    await waitFor(() => {
      // 25°C → 77°F, not "25 °F"
      expect(screen.getByText('77.0')).toBeInTheDocument();
    });
    expect(screen.getByText('°F')).toBeInTheDocument();
    expect(screen.queryByText('25.0')).not.toBeInTheDocument();
  });
});

describe('UnifiedTelemetryPage source navigation', () => {
  const srcA = { ...tempEntry, nodeId: '!a', nodeNum: 1, sourceId: 'src1', sourceName: 'RAK4631', nodeLongName: 'Node A' };
  const srcB = { ...tempEntry, nodeId: '!b', nodeNum: 2, sourceId: 'src2', sourceName: 'Heltec_V4', nodeLongName: 'Node B' };

  beforeEach(() => {
    localStorage.clear();
    // jsdom implements neither of these — stub so the component can call them.
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('renders source legend entries as jump buttons', async () => {
    mockTelemetryResponse([srcA, srcB]);
    renderPage();

    const pillA = await screen.findByRole('button', { name: 'RAK4631' });
    const pillB = await screen.findByRole('button', { name: 'Heltec_V4' });
    expect(pillA).toBeEnabled();
    expect(pillB).toBeEnabled();
    // i18n isn't loaded in tests, so the title resolves to the raw key — assert
    // the jump-to-source string was wired up rather than its translated value.
    expect(pillA).toHaveAttribute('title', 'unified.telemetry.jump_to_source');
  });

  it('scrolls to the section when a legend pill is clicked', async () => {
    mockTelemetryResponse([srcA, srcB]);
    renderPage();

    const pillB = await screen.findByRole('button', { name: 'Heltec_V4' });
    fireEvent.click(pillB);

    expect(window.scrollTo).toHaveBeenCalled();
    expect(pillB).toHaveAttribute('aria-current', 'true');
  });
});
