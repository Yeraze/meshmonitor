/**
 * AutomationsPage (#4577 Phase 3 WP4) — "Browse templates" entry point tests.
 *
 * These are deliberately light: the deep install-flow behavior (wizard fields,
 * partial-failure reporting, POST /api/automations/import) is already covered
 * by TemplateGallery.test.tsx. This file only proves AutomationsPage wires the
 * gallery in correctly — the button exists, clicking it swaps in the gallery
 * (using the REAL template registry, unlike TemplateGallery's own suite which
 * always injects fakes), and closing it returns to the automations list.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';

// AutomationBuilder statically imports GeofenceFieldInput → GeofenceMapEditor →
// BaseMap → TilesetSelector → SettingsContext → config/i18n → init.ts, which
// calls `api.setBaseUrl(...)` at MODULE SCOPE (before any component renders).
// `setBaseUrl` must be on the mock even though this suite never uses it
// directly — same pattern as TemplateGallery.test.tsx / AdminCommandsTab.txDisabled.test.tsx.
vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setBaseUrl: vi.fn() },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedGet.mockReset();
  // Catch-all: AutomationsList loads /api/automations; the gallery (once
  // opened) loads /api/sources and /api/automations/channels. Everything
  // else this suite doesn't care about resolves to an empty list too.
  mockedGet.mockImplementation(() => Promise.resolve([]));
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AutomationsPage />
    </MemoryRouter>,
  );
}

describe('AutomationsPage — Browse templates', () => {
  it('renders a "Browse templates" button next to "+ New automation"', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: '+ New automation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse templates' })).toBeInTheDocument();
  });

  it('opens the Template Gallery (real registry) when clicked', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Browse templates' }));

    expect(await screen.findByText('Template Gallery')).toBeInTheDocument();
    // Real TEMPLATES registry (WP2's Auto-Ack), not an injected fake — proves
    // AutomationsPage renders <TemplateGallery> without overriding `templates`.
    expect(await screen.findByText('Auto-Ack')).toBeInTheDocument();

    // The automations list underneath is no longer rendered while browsing.
    expect(screen.queryByRole('button', { name: '+ New automation' })).not.toBeInTheDocument();
  });

  it('returns to the automations list when the gallery is closed', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Browse templates' }));
    await screen.findByText('Template Gallery');

    await userEvent.click(screen.getByRole('button', { name: /Close/ }));

    expect(await screen.findByRole('button', { name: '+ New automation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse templates' })).toBeInTheDocument();
  });
});
