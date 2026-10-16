/**
 * @vitest-environment jsdom
 *
 * Search box + section chips on the MeshCore Automations page, the same
 * SectionNav the Meshtastic Automation tab has. Each chip must point at a
 * section that is really on the page, and the filter must hide whole
 * sections, header and body.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));

// Every section loads its settings on mount; an empty, failed reply keeps
// them on their defaults, which is all these tests need.
const { emptyFetch } = vi.hoisted(() => ({
  emptyFetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => emptyFetch }));

import { MeshCoreAutomationsView } from './MeshCoreAutomationsView';
import { meshcoreAutomationNavItems } from '../search/configSections';

const t = ((_key: string, fallback?: string) => fallback ?? _key) as never;

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MeshCoreAutomationsView baseUrl="" sourceId="src-1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const nav = () => screen.getByRole('navigation');
const chipIds = () =>
  within(nav()).queryAllByRole('button').map((b) => b.getAttribute('data-section-id'));

/** Ids the nav's generated stylesheet hides. */
function hiddenIds(): string[] {
  const style = nav().querySelector('style');
  if (!style?.textContent) return [];
  return style.textContent
    .replace(/\{.*$/, '')
    .split(',')
    .map((selector) => selector.trim().replace(/^#/, ''))
    .filter(Boolean);
}

beforeEach(() => {
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(emptyFetch);
  (window as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCore Automations section nav', () => {
  it('has a search box and one chip per section', () => {
    renderView();
    expect(within(nav()).getByRole('searchbox')).toBeInTheDocument();
    expect(chipIds()).toEqual([
      'meshcore-automation-pathfinding',
      'meshcore-automation-auto-ack',
      'meshcore-automation-auto-announce',
      'meshcore-automation-auto-responder',
      'meshcore-automation-forwarding',
      'meshcore-automation-timer-triggers',
    ]);
  });

  it('points every chip at exactly one section on the page, in page order', () => {
    const { container } = renderView();
    const ids = chipIds() as string[];
    for (const id of ids) {
      expect(container.querySelectorAll(`[id="${id}"]`), id).toHaveLength(1);
    }
    const sections = ids.map((id) => document.getElementById(id)!);
    for (let i = 1; i < sections.length; i++) {
      // DOCUMENT_POSITION_FOLLOWING: the later chip's section comes later.
      expect(sections[i - 1].compareDocumentPosition(sections[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('puts each section header inside its own id, so a filter hides all of it', () => {
    renderView();
    for (const id of chipIds() as string[]) {
      expect(document.getElementById(id)!.querySelector('.automation-section-header'), id).not.toBeNull();
    }
  });

  it('filters chips and hides the sections that do not match', () => {
    renderView();
    fireEvent.change(within(nav()).getByRole('searchbox'), { target: { value: 'pathfinding' } });
    expect(chipIds()).toEqual(['meshcore-automation-pathfinding']);
    expect(hiddenIds().sort()).toEqual(
      meshcoreAutomationNavItems(t)
        .map((item) => item.id)
        .filter((id) => id !== 'meshcore-automation-pathfinding')
        .sort(),
    );
  });

  it('says so when nothing matches', () => {
    renderView();
    fireEvent.change(within(nav()).getByRole('searchbox'), { target: { value: 'zzzz-nothing' } });
    expect(chipIds()).toEqual([]);
    expect(within(nav()).getByRole('status')).toHaveTextContent('No matching sections');
  });

  it('keeps the page title', () => {
    renderView();
    expect(screen.getByRole('heading', { level: 1, name: 'Automations' })).toBeInTheDocument();
  });
});
