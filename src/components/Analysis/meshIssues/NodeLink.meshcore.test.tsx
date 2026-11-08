/**
 * @vitest-environment jsdom
 *
 * NodeLink MeshCore mode (#6263 S5): publicKey + sourceIds deep-link to the
 * MeshCore contact; no /api/nodes/:nodeNum/sources lookup.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

import apiService from '../../../services/api';
import NodeLink, { PENDING_SELECTED_MESHCORE_CONTACT_STORAGE_KEY } from './NodeLink';

vi.mock('../../../services/api', () => ({ default: { get: vi.fn() } }));
const mockGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

const PK = 'ab'.repeat(32);

function Reporter() {
  const loc = useLocation();
  const state = loc.state as { focusMeshcoreContact?: string } | null;
  return (
    <>
      <div data-testid="location">{loc.pathname}</div>
      <div data-testid="focus">{state?.focusMeshcoreContact ?? ''}</div>
    </>
  );
}

function renderLink(props: React.ComponentProps<typeof NodeLink>) {
  return render(
    <MemoryRouter initialEntries={['/analysis']}>
      <Routes>
        <Route path="*" element={<><NodeLink {...props} /><Reporter /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NodeLink MeshCore mode', () => {
  beforeEach(() => {
    mockGet.mockReset();
    sessionStorage.clear();
  });

  it('opens the contact directly when one source is known, without the nodeNum API', async () => {
    renderLink({ publicKey: PK.toUpperCase(), sourceIds: ['mc-1'], name: 'Hill Repeater' });
    fireEvent.click(screen.getByRole('button', { name: 'Hill Repeater' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/source/mc-1/'));
    expect(screen.getByTestId('focus').textContent).toBe(PK);
    expect(sessionStorage.getItem(PENDING_SELECTED_MESHCORE_CONTACT_STORAGE_KEY)).toBe(PK);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows a source picker for several sources and opens the chosen one', async () => {
    renderLink({ publicKey: PK, sourceIds: ['mc-1', 'mc-2'], fallbackSourceNames: { 'mc-2': 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: `${PK.slice(0, 8)}…` }));
    const item = await screen.findByRole('menuitem', { name: /Second/ });
    fireEvent.click(item);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/source/mc-2/'));
    expect(screen.getByTestId('focus').textContent).toBe(PK);
  });

  it('does nothing when no source is known', async () => {
    renderLink({ publicKey: PK, sourceIds: [], name: 'X' });
    fireEvent.click(screen.getByRole('button', { name: 'X' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('location').textContent).toBe('/analysis');
  });
});
