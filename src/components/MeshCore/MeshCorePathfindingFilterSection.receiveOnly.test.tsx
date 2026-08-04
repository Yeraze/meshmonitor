/**
 * @vitest-environment jsdom
 *
 * MeshCorePathfindingFilterSection — receive-only mode (#4547 Phase 2 WP4).
 *
 * This section has no immediate-TX control (the filter only narrows which
 * contacts Auto-Pathfinding targets; it never sends anything itself), so the
 * only receive-only behavior is the paused note (interview decision 5:
 * configuration inputs stay fully editable while receive-only).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

const { csrfFetchMock } = vi.hoisted(() => ({ csrfFetchMock: vi.fn() }));
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => csrfFetchMock,
}));

const { saveBarCapture } = vi.hoisted(() => ({ saveBarCapture: { current: null as unknown } }));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options;
  },
}));

import { MeshCorePathfindingFilterSection } from './MeshCorePathfindingFilterSection';

describe('MeshCorePathfindingFilterSection receive-only', () => {
  beforeEach(() => {
    csrfFetchMock.mockReset().mockImplementation((url: string) => {
      if (url.includes('/automation/pathfinding/filter')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: {} }) });
      }
      if (url.includes('/contacts')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, data: [] }) });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
  });

  it('renders the paused note when receiveOnly is true, and nothing when false', async () => {
    const { rerender } = render(
      <MeshCorePathfindingFilterSection baseUrl="" sourceId="src1" canWrite receiveOnly={false} />,
    );
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<MeshCorePathfindingFilterSection baseUrl="" sourceId="src1" canWrite receiveOnly />);
    const note = await screen.findByRole('status');
    expect(note).toHaveTextContent(/receive-only mode/i);
  });

  it('leaves the filter enable checkbox editable — receive-only does not gate configuration', async () => {
    render(<MeshCorePathfindingFilterSection baseUrl="" sourceId="src1" canWrite receiveOnly />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const checkbox = document.getElementById('pathfindingFilterEnabled') as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox).not.toBeDisabled();
  });

  it('still gates configuration inputs on !canWrite, independent of receiveOnly', async () => {
    render(<MeshCorePathfindingFilterSection baseUrl="" sourceId="src1" canWrite={false} receiveOnly />);
    await waitFor(() => expect(csrfFetchMock).toHaveBeenCalled());
    const checkbox = document.getElementById('pathfindingFilterEnabled') as HTMLInputElement | null;
    expect(checkbox).toBeDisabled();
  });
});
