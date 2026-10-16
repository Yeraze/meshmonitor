/**
 * @vitest-environment jsdom
 *
 * Search box + section chips on MeshCore Device Configuration, the same
 * SectionNav the Meshtastic Configuration tab has. Many sections mount only
 * for some devices or grants, so the chips must follow the same conditions:
 * a chip that points at nothing is a dead button.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

let grants: (resource: string, action: string) => boolean = () => true;
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (resource: string, action: string) => grants(resource, action) }),
}));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));

// Sections load their state on mount; an empty, failed reply leaves them on
// their defaults, which is all these tests need.
const { emptyFetch } = vi.hoisted(() => ({
  emptyFetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => emptyFetch }));

import { MeshCoreConfigurationView } from './MeshCoreConfigurationView';
import type { ConnectionStatus, MeshCoreActions } from './hooks/useMeshCore';

const ALL_IDS = [
  'meshcore-config-name',
  'meshcore-config-location',
  'meshcore-config-radio',
  'meshcore-config-tx-power',
  'meshcore-config-telemetry',
  'meshcore-path-hash',
  'meshcore-default-scope',
  'meshcore-channels',
  'meshcore-contact-sync',
  'meshcore-device-actions',
  'meshcore-local-console',
  'meshcore-observer',
  'meshcore-device-management',
];

function makeActions(): MeshCoreActions {
  const resolved = (value: unknown) => vi.fn().mockResolvedValue(value);
  return new Proxy({} as MeshCoreActions, {
    get: (target, key: string) => {
      const known: Record<string, unknown> = {
        getDefaultPathHashSize: 1,
        getDefaultScope: '',
        fetchSavedRegions: [],
      };
      const record = target as unknown as Record<string, unknown>;
      if (!(key in record)) record[key] = resolved(key in known ? known[key] : true);
      return record[key];
    },
  });
}

function makeStatus({ advType = 1, connected = true } = {}): ConnectionStatus {
  return {
    connected,
    deviceType: advType,
    deviceTypeName: advType === 1 ? 'companion' : 'repeater',
    config: null,
    localNode: { publicKey: 'a'.repeat(64), name: 'Radio', advType },
  } as ConnectionStatus;
}

function renderView(
  props: { advType?: number; connected?: boolean; sourceId?: string | undefined } = {},
) {
  const { advType, connected } = props;
  const sourceId = 'sourceId' in props ? props.sourceId : 'src-1';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MeshCoreConfigurationView
        status={makeStatus({ advType, connected })}
        actions={makeActions()}
        baseUrl={sourceId ? '' : undefined}
        sourceId={sourceId}
      />
    </QueryClientProvider>,
  );
}

const nav = () => screen.getByRole('navigation');
const chipIds = () =>
  within(nav()).queryAllByRole('button').map((b) => b.getAttribute('data-section-id') as string);

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

/** Every chip names one element on the page, and no section lacks a chip. */
function expectChipsMatchPage(container: HTMLElement) {
  const ids = chipIds();
  for (const id of ids) {
    expect(container.querySelectorAll(`[id="${id}"]`), id).toHaveLength(1);
  }
  for (const id of ALL_IDS.filter((id) => !ids.includes(id))) {
    expect(document.getElementById(id), `${id} is on the page but has no chip`).toBeNull();
  }
}

beforeEach(() => {
  grants = () => true;
  (globalThis as { fetch: unknown }).fetch = vi.fn().mockImplementation(emptyFetch);
  (window as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MeshCore Device Configuration section nav', () => {
  it('offers a search box and a chip for every section of a connected companion', () => {
    const { container } = renderView();
    expect(within(nav()).getByRole('searchbox')).toBeInTheDocument();
    expect(chipIds()).toEqual(ALL_IDS);
    expectChipsMatchPage(container);
  });

  it('lists the chips in page order', () => {
    renderView();
    const sections = chipIds().map((id) => document.getElementById(id)!);
    for (let i = 1; i < sections.length; i++) {
      expect(
        sections[i - 1].compareDocumentPosition(sections[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${sections[i - 1].id} before ${sections[i].id}`,
      ).toBeTruthy();
    }
  });

  it('wraps each whole section, header and body, in its id', () => {
    renderView();
    for (const id of chipIds()) {
      const section = document.getElementById(id)!;
      // The local console is a <section> with its own title, not a ConfigSection.
      if (id === 'meshcore-local-console') continue;
      expect(section.querySelector('.automation-section-header'), id).not.toBeNull();
      expect(section.querySelector('.settings-section'), id).not.toBeNull();
    }
  });

  it('drops the companion-only chips on a repeater', () => {
    const { container } = renderView({ advType: 2 });
    expect(chipIds()).toEqual([
      'meshcore-config-name',
      'meshcore-config-location',
      'meshcore-config-radio',
      'meshcore-config-tx-power',
      'meshcore-config-telemetry',
      'meshcore-device-actions',
      'meshcore-local-console',
    ]);
    expectChipsMatchPage(container);
  });

  it('drops the danger zone chip while disconnected', () => {
    const { container } = renderView({ connected: false });
    expect(chipIds()).not.toContain('meshcore-device-management');
    expectChipsMatchPage(container);
  });

  it('drops the per-source chips without a source', () => {
    const { container } = renderView({ sourceId: undefined });
    for (const id of ['meshcore-channels', 'meshcore-contact-sync', 'meshcore-local-console', 'meshcore-observer']) {
      expect(chipIds()).not.toContain(id);
    }
    expectChipsMatchPage(container);
  });

  it('follows the grants: read-only viewers get no console or danger zone', () => {
    grants = (_resource, action) => action === 'read';
    const { container } = renderView();
    expect(chipIds()).not.toContain('meshcore-local-console');
    expect(chipIds()).not.toContain('meshcore-device-management');
    expect(chipIds()).toContain('meshcore-observer');
    expectChipsMatchPage(container);
  });

  it('drops the observer chip without configuration:read', () => {
    grants = (resource, action) => !(resource === 'configuration' && action === 'read');
    const { container } = renderView();
    expect(chipIds()).not.toContain('meshcore-observer');
    expectChipsMatchPage(container);
  });

  it('filters by a keyword and hides every other section', () => {
    renderView();
    fireEvent.change(within(nav()).getByRole('searchbox'), { target: { value: 'dbm' } });
    expect(chipIds()).toEqual(['meshcore-config-tx-power']);
    expect(hiddenIds().sort()).toEqual(ALL_IDS.filter((id) => id !== 'meshcore-config-tx-power').sort());
  });

  it('keeps the page title', () => {
    renderView();
    expect(screen.getByRole('heading', { level: 2, name: 'Device Configuration' })).toBeInTheDocument();
  });
});
