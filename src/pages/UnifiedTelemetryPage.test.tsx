/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
