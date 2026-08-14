/**
 * @vitest-environment jsdom
 *
 * ReticulumInfoView (#3960 Phase 1b WP5) — status/health panel driven purely
 * by the `status` prop (no fetching of its own). Covers: loading/empty
 * states, disconnected state, and the RNS/bridge version fields WP-B added
 * to `ReticulumStatus` (null → placeholder vs. present → the literal
 * string).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReticulumInfoView } from './ReticulumInfoView';
import type { ReticulumStatus } from '../../types/reticulum';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

function baseStatus(overrides: Partial<ReticulumStatus> = {}): ReticulumStatus {
  return {
    connected: true,
    mode: 'attach',
    interfaceCount: 2,
    destinationCount: 5,
    ...overrides,
  };
}

describe('ReticulumInfoView', () => {
  it('shows a loading message when status is null and loading is true', () => {
    render(<ReticulumInfoView status={null} loading />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows a no-status message when status is null and not loading', () => {
    render(<ReticulumInfoView status={null} />);
    expect(screen.getByText(/no status/i)).toBeInTheDocument();
  });

  it('renders the connected state, mode, and counts', () => {
    render(<ReticulumInfoView status={baseStatus()} />);
    expect(screen.getByTestId('reticulum-info-view')).toBeInTheDocument();
    expect(screen.getByTestId('reticulum-info-status-chip')).toHaveTextContent(/connected/i);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/attach/i);
    expect(screen.getByTestId('reticulum-info-interface-count')).toHaveTextContent('2');
    expect(screen.getByTestId('reticulum-info-destination-count')).toHaveTextContent('5');
  });

  it('renders the disconnected state', () => {
    render(<ReticulumInfoView status={baseStatus({ connected: false, mode: undefined })} />);
    expect(screen.getByTestId('reticulum-info-status-chip')).toHaveTextContent(/disconnected/i);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/unknown/i);
  });

  it('renders tcp_peer mode', () => {
    render(<ReticulumInfoView status={baseStatus({ mode: 'tcp_peer' })} />);
    expect(screen.getByTestId('reticulum-info-mode')).toHaveTextContent(/tcp peer/i);
  });

  it('shows placeholders when rnsVersion/bridgeVersion are absent', () => {
    render(<ReticulumInfoView status={baseStatus()} />);
    expect(screen.getByTestId('reticulum-info-rns-version')).toHaveTextContent('—');
    expect(screen.getByTestId('reticulum-info-bridge-version')).toHaveTextContent(/unknown/i);
  });

  it('shows the actual RNS/bridge version strings when present', () => {
    render(<ReticulumInfoView status={baseStatus({ rnsVersion: '0.8.1', bridgeVersion: '1.2.3' })} />);
    expect(screen.getByTestId('reticulum-info-rns-version')).toHaveTextContent('0.8.1');
    expect(screen.getByTestId('reticulum-info-bridge-version')).toHaveTextContent('1.2.3');
  });
});
