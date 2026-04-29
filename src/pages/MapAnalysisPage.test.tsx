/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MapAnalysisPage from './MapAnalysisPage';

vi.mock('../contexts/SettingsContext', () => ({
  SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/ToastContainer', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/MapAnalysis/MapAnalysisCanvas', () => ({
  default: () => <div data-testid="map-analysis-canvas" />,
}));
vi.mock('../components/MapAnalysis/MapAnalysisToolbar', () => ({
  default: () => <div data-testid="map-analysis-toolbar" />,
}));
vi.mock('../components/MapAnalysis/AnalysisInspectorPanel', () => ({
  default: () => <div data-testid="analysis-inspector" />,
}));

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/analysis']}>
        <MapAnalysisPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MapAnalysisPage', () => {
  it('renders toolbar, canvas, and inspector', () => {
    renderPage();
    expect(screen.getByTestId('map-analysis-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('map-analysis-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-inspector')).toBeInTheDocument();
  });
});
