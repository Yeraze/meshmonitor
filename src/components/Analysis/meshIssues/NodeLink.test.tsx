/**
 * @vitest-environment jsdom
 *
 * NodeLink — click behavior and source picker.
 *
 * Verifies:
 *  - single-source result → direct navigate + sessionStorage handoff key set
 *  - multi-source result → picker renders; picking a row navigates
 *  - API failure → falls back to `fallbackSourceIds` (usually the finding's
 *    own sourceIds)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import apiService from '../../../services/api';
import NodeLink, { PENDING_SELECTED_NODE_STORAGE_KEY } from './NodeLink';

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn() },
}));
const mockGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

function LocationReporter() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderNodeLink(props: React.ComponentProps<typeof NodeLink>) {
  return render(
    <MemoryRouter initialEntries={['/source/existing/nodes']}>
      <Routes>
        <Route
          path="/source/:sid/nodes"
          element={
            <>
              <NodeLink {...props} />
              <LocationReporter />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NodeLink', () => {
  beforeEach(() => {
    mockGet.mockReset();
    sessionStorage.clear();
  });

  it('navigates directly and sets the pending-select key when the node lives on one source', async () => {
    mockGet.mockResolvedValueOnce({
      success: true,
      data: { sources: [{ sourceId: 'src-solo', sourceName: 'Solo', nodeName: 'Alpha' }] },
    });

    renderNodeLink({ nodeNum: 0x11223344, name: 'Alpha' });

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/source/src-solo/nodes');
    });
    expect(sessionStorage.getItem(PENDING_SELECTED_NODE_STORAGE_KEY)).toBe('!11223344');
    expect(mockGet).toHaveBeenCalledWith('/api/nodes/287454020/sources');
  });

  it('renders a source picker when the node exists on multiple sources', async () => {
    mockGet.mockResolvedValueOnce({
      success: true,
      data: {
        sources: [
          { sourceId: 'src-a', sourceName: 'Source A', nodeName: 'Alpha on A' },
          { sourceId: 'src-b', sourceName: 'Source B', nodeName: 'Alpha on B' },
        ],
      },
    });

    renderNodeLink({ nodeNum: 42, name: 'Alpha' });

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));

    // Picker appears with an item per source.
    const itemA = await screen.findByRole('menuitem', { name: /Source A/ });
    expect(itemA).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Source B/ })).toBeTruthy();

    // Nothing has navigated yet — waiting on user choice.
    expect(screen.getByTestId('location').textContent).toBe('/source/existing/nodes');

    fireEvent.click(screen.getByRole('menuitem', { name: /Source B/ }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/source/src-b/nodes');
    });
    expect(sessionStorage.getItem(PENDING_SELECTED_NODE_STORAGE_KEY)).toBe('!0000002a');
  });

  it('falls back to fallbackSourceIds when the API errors', async () => {
    mockGet.mockRejectedValueOnce(new Error('offline'));

    renderNodeLink({ nodeNum: 99, name: 'Bravo', fallbackSourceIds: ['fallback-src'] });

    fireEvent.click(screen.getByRole('button', { name: 'Bravo' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/source/fallback-src/nodes');
    });
    expect(sessionStorage.getItem(PENDING_SELECTED_NODE_STORAGE_KEY)).toBe('!00000063');
  });

  it('is a no-op when no sources are available and no fallback is provided', async () => {
    mockGet.mockResolvedValueOnce({ success: true, data: { sources: [] } });

    renderNodeLink({ nodeNum: 7, name: 'Charlie' });

    fireEvent.click(screen.getByRole('button', { name: 'Charlie' }));

    // Give the promise a chance to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByTestId('location').textContent).toBe('/source/existing/nodes');
    expect(sessionStorage.getItem(PENDING_SELECTED_NODE_STORAGE_KEY)).toBeNull();
  });

  it('defaults the label to a !hex node id when no name is supplied', () => {
    renderNodeLink({ nodeNum: 0x11223344 });
    expect(screen.getByRole('button', { name: '!11223344' })).toBeTruthy();
  });
});
