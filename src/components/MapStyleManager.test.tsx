/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MapStyleManager from './MapStyleManager';

// issue #4348 — the "Activate" action and active-style badge are new; the
// delete-while-active guard is the fix for a review finding that a failed
// DELETE must not clear the active-style selection.

const mockApiGet = vi.fn();
vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => mockApiGet(...args),
    getBaseUrl: vi.fn().mockResolvedValue(''),
  },
}));

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockSetActiveMapStyleId = vi.fn();
const mockLoadMapStyles = vi.fn();
const settingsMock = vi.hoisted(() => ({ activeStyleId: null as string | null }));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({
    activeStyleId: settingsMock.activeStyleId,
    setActiveMapStyleId: mockSetActiveMapStyleId,
    loadMapStyles: mockLoadMapStyles,
  }),
}));

const styleA = { id: 'style-a', name: 'Style A', filename: 'a.json', sourceType: 'upload' as const, sourceUrl: null, createdAt: 0, updatedAt: 0 };
const styleB = { id: 'style-b', name: 'Style B', filename: 'b.json', sourceType: 'url' as const, sourceUrl: 'https://example.com/b.json', createdAt: 0, updatedAt: 0 };

describe('MapStyleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.activeStyleId = null;
    mockApiGet.mockResolvedValue([styleA, styleB]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The global react-i18next mock in src/test/setup.ts makes t() return the
  // key itself, so UI copy is asserted by translation key rather than English.

  it('shows an Active badge for the currently active style and an Activate button for the rest', async () => {
    settingsMock.activeStyleId = 'style-a';
    render(<MapStyleManager />);

    await screen.findByDisplayValue('Style A');
    expect(screen.getByText('map_style_manager.active')).toBeDefined();
    expect(screen.getByRole('button', { name: 'map_style_manager.activate' })).toBeDefined();
  });

  it('activating a style calls the shared setActiveMapStyleId setter', async () => {
    const user = userEvent.setup();
    render(<MapStyleManager />);

    await screen.findByDisplayValue('Style A');
    const activateButtons = screen.getAllByRole('button', { name: 'map_style_manager.activate' });
    await user.click(activateButtons[0]);

    expect(mockSetActiveMapStyleId).toHaveBeenCalledWith('style-a');
  });

  it('clears the active style only after a successful delete', async () => {
    settingsMock.activeStyleId = 'style-a';
    mockCsrfFetch.mockResolvedValue({ ok: true });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const user = userEvent.setup();
    render(<MapStyleManager />);

    await screen.findByDisplayValue('Style A');
    const [deleteA] = screen.getAllByRole('button', { name: 'common.delete' });
    await user.click(deleteA);

    await waitFor(() => expect(mockSetActiveMapStyleId).toHaveBeenCalledWith(null));
    expect(mockLoadMapStyles).toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Style A')).toBeNull();
  });

  it('does not clear the active style when the delete request fails', async () => {
    settingsMock.activeStyleId = 'style-a';
    mockCsrfFetch.mockResolvedValue({ ok: false });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const alertSpy = vi.fn();
    vi.stubGlobal('alert', alertSpy);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<MapStyleManager />);

    await screen.findByDisplayValue('Style A');
    const [deleteA] = screen.getAllByRole('button', { name: 'common.delete' });
    await user.click(deleteA);

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('map_style_manager.delete_failed'));
    expect(mockSetActiveMapStyleId).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
