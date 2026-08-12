/**
 * TemplateGallery (#4577 Phase 3 WP3) tests.
 *
 * These tests never rely on the real `TEMPLATES` registry — WP2 (Auto-Ack)
 * populates it in parallel and its landing is not ordered relative to this
 * file, so every test injects fake templates via the optional `templates`
 * prop. That prop exists for exactly this reason (see TemplateGallery.tsx).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TemplateGallery, { type InstalledAutomationRow } from './TemplateGallery';
import type { AutomationTemplate, BuiltAutomation } from './templates/types';

// AutomationBuilder statically imports GeofenceFieldInput → GeofenceMapEditor →
// BaseMap → TilesetSelector → SettingsContext → config/i18n → init.ts, which
// calls `api.setBaseUrl(...)` at MODULE SCOPE (before any component renders).
// `setBaseUrl` must be on the mock even though this suite never uses it
// directly — same pattern as AdminCommandsTab.txDisabled.test.tsx.
vi.mock('../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), setBaseUrl: vi.fn() },
}));

import apiService from '../../services/api';

const mockedGet = apiService.get as unknown as ReturnType<typeof vi.fn>;
const mockedPost = apiService.post as unknown as ReturnType<typeof vi.fn>;

const SAMPLE_SOURCES = [
  { id: 'src1', name: 'Home Node', type: 'meshtastic-tcp', enabled: true, radio: { txEnabled: true, canTransmit: true } },
];
const SAMPLE_CHANNELS = [
  { name: 'gauntlet', protocol: 'meshtastic', encryption: 'AQ==' },
];

function minimalGraph(triggerId: string, actionId: string, actionParams: Record<string, unknown> = {}) {
  return {
    version: 1,
    nodes: [
      { id: triggerId, type: 'trigger.message', params: {} },
      { id: actionId, type: 'action.sendMessage', params: actionParams },
    ],
    edges: [{ from: triggerId, to: actionId }],
  };
}

/** A simple, single-automation template exercising sourceMulti + channelMulti fields. */
function makeSingleTemplate(): AutomationTemplate {
  return {
    id: 'fake-single',
    name: 'Fake Single',
    description: 'A fake single-automation template for testing.',
    icon: 'bot',
    tags: ['test-tag'],
    params: [
      { name: 'sourceIds', label: 'Sources', kind: 'sourceMulti' },
      { name: 'channels', label: 'Channels', kind: 'channelMulti' },
    ],
    build(values): BuiltAutomation {
      return {
        name: 'Fake Single Automation',
        description: 'desc',
        config: minimalGraph('trig', 'act', {
          sourceIds: values.sourceIds ?? [],
          channels: values.channels ?? [],
        }),
      };
    },
  };
}

/** A "bridge" template whose build() returns TWO automations, for partial-failure coverage. */
function makeDualTemplate(): AutomationTemplate {
  return {
    id: 'fake-dual',
    name: 'Fake Dual',
    description: 'A fake bridge template producing two automations.',
    icon: 'bot',
    tags: ['bridge'],
    params: [],
    build(): BuiltAutomation[] {
      return [
        { name: 'Fake Dual A', description: 'first', config: minimalGraph('trigA', 'actA') },
        { name: 'Fake Dual B', description: 'second', config: minimalGraph('trigB', 'actB') },
      ];
    },
  };
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedGet.mockImplementation((endpoint: string) => {
    if (endpoint === '/api/sources') return Promise.resolve(SAMPLE_SOURCES);
    if (endpoint === '/api/automations/channels') return Promise.resolve(SAMPLE_CHANNELS);
    return Promise.resolve([]);
  });
});

function renderGallery(templates: AutomationTemplate[], onInstalled = vi.fn(), onClose = vi.fn()) {
  render(<TemplateGallery onClose={onClose} onInstalled={onInstalled} templates={templates} />);
  return { onInstalled, onClose };
}

describe('TemplateGallery', () => {
  it('renders a card for each injected template', async () => {
    renderGallery([makeSingleTemplate(), makeDualTemplate()]);
    expect(await screen.findByText('Fake Single')).toBeInTheDocument();
    expect(screen.getByText('Fake Dual')).toBeInTheDocument();
    expect(screen.getByText('test-tag')).toBeInTheDocument();
    expect(screen.getByText('bridge')).toBeInTheDocument();
  });

  it('opens the wizard with the template\'s param fields, populated from injected sources/channels', async () => {
    renderGallery([makeSingleTemplate()]);
    await screen.findByText('Fake Single');
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/sources'));

    await userEvent.click(screen.getByRole('button', { name: 'Use template' }));

    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
    // The sourceMulti/channelMulti pickers render options from the props the
    // gallery loaded via apiService — not hardcoded — proving the wiring.
    expect(await screen.findByRole('checkbox', { name: /Home Node/ })).toBeInTheDocument();
    expect(screen.getByText('gauntlet')).toBeInTheDocument();
  });

  it('installs a single-automation template and reports the created row', async () => {
    const { onInstalled } = renderGallery([makeSingleTemplate()]);
    await screen.findByText('Fake Single');
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/sources'));

    await userEvent.click(screen.getByRole('button', { name: 'Use template' }));

    // Fill a minimal param: select the one available source.
    const sourceCheckbox = await screen.findByRole('checkbox', { name: /Home Node/ });
    await userEvent.click(sourceCheckbox);

    const createdRow: InstalledAutomationRow = {
      id: 'created-1', name: 'Fake Single Automation', description: 'desc', enabled: false, config: '{}',
    };
    mockedPost.mockResolvedValueOnce(createdRow);

    await userEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/automations/import', {
      name: 'Fake Single Automation',
      description: 'desc',
      config: minimalGraph('trig', 'act', { sourceIds: ['src1'], channels: [] }),
    });
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith([createdRow]));
  });

  it('surfaces a partial failure across a multi-automation (bridge) template without rolling back', async () => {
    const { onInstalled } = renderGallery([makeDualTemplate()]);
    await screen.findByText('Fake Dual');
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/api/sources'));

    await userEvent.click(screen.getByRole('button', { name: 'Use template' }));

    const firstRow: InstalledAutomationRow = {
      id: 'created-a', name: 'Fake Dual A', description: 'first', enabled: false, config: '{}',
    };
    mockedPost
      .mockResolvedValueOnce(firstRow)
      .mockRejectedValueOnce(new Error('second automation rejected'));

    await userEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(2));

    // First succeeded and is reported as installed…
    expect(await screen.findByText(/Installed "Fake Dual A"/)).toBeInTheDocument();
    // …second failed and its error is surfaced, verbatim.
    expect(screen.getByText(/Failed to install "Fake Dual B": second automation rejected/)).toBeInTheDocument();

    // Partial failure withholds onInstalled — the caller must not treat this as done.
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('surfaces a load error for the sources/channels picker data without crashing', async () => {
    mockedGet.mockImplementation((endpoint: string) => {
      if (endpoint === '/api/sources') return Promise.reject(new Error('sources down'));
      return Promise.resolve([]);
    });
    renderGallery([makeSingleTemplate()]);
    expect(await screen.findByText('sources down')).toBeInTheDocument();
  });

  it('calls onClose from the gallery close affordance', async () => {
    const { onClose } = renderGallery([makeSingleTemplate()]);
    await screen.findByText('Fake Single');
    await userEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
