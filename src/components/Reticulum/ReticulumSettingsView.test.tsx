/**
 * @vitest-environment jsdom
 *
 * ReticulumSettingsView after the #5683 follow-up: its one control, the
 * destination retention cap, applies to every Reticulum source and moved to
 * Global Settings. The tab keeps a pointer and reads or saves nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/IconStyleContext', () => ({ useIconStyleOptional: () => 'lucide' }));
let canReadSettings = true;
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => canReadSettings }) }));
const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get: apiGet, post: apiPost }, ApiError: class extends Error {} }));

import { ReticulumSettingsView } from './ReticulumSettingsView';

const renderView = () => render(<MemoryRouter><ReticulumSettingsView sourceId="rns-1" /></MemoryRouter>);

describe('ReticulumSettingsView', () => {
  it('no longer holds the retention cap', () => {
    canReadSettings = true;
    renderView();
    expect(screen.queryByLabelText(/destination retention cap/i)).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('points to the cap on Global Settings, at its section', () => {
    renderView();
    expect(screen.getByTestId('reticulum-retention-moved')).toHaveTextContent(
      'The destination retention cap applies to every Reticulum source, so it moved to Global Settings.',
    );
    expect(screen.getByRole('link', { name: 'Open Global Settings' }).getAttribute('href'))
      .toBe('/settings#settings-reticulum');
  });

  it('links to Global Settings on the page itself, for the phone layout with no nav foot', () => {
    renderView();
    expect(screen.getByRole('link', { name: 'Global Settings' }).getAttribute('href')).toBe('/settings');
  });

  it('reads and saves nothing', () => {
    renderView();
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('keeps the pointer for a viewer without settings:read, without the Global Settings link', () => {
    canReadSettings = false;
    renderView();
    expect(screen.getByTestId('reticulum-retention-moved')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Global Settings' })).toBeNull();
  });
});
