/**
 * AutomationsPage (#6449) — "+ New automation" opens a Message-trigger rule
 * whose sender filter starts at "People only", so a rule saved from the starter
 * form skips is_automation messages (the bot-to-bot loop guard).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AutomationsPage from './AutomationsPage';

// See AutomationsPage.templateGallery.test.tsx: init.ts calls setBaseUrl at module scope.
vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), setBaseUrl: vi.fn() },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedGet.mockReset();
  mockedGet.mockImplementation(() => Promise.resolve([]));
});

describe('AutomationsPage — new rule sender filter (#6449)', () => {
  it('starts the Message trigger at "People only (skip automated messages)"', async () => {
    render(
      <MemoryRouter>
        <AutomationsPage />
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole('button', { name: '+ New automation' }));

    const selected = await screen.findByRole('option', { name: 'People only (skip automated messages)', selected: true });
    expect(selected).toBeInTheDocument();
  });
});
