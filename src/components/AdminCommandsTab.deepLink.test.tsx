/**
 * @vitest-environment jsdom
 *
 * Admin Commands deep link (#5535): `?node=!xxxxxxxx` from the node-details
 * Remote Admin badge pre-selects that node on mount. See
 * `adminDeepLink.test.ts` for the parser's own validation rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  showToast: vi.fn(),
  apiPost: vi.fn(),
  apiSendAdminCommand: vi.fn(),
}));

// `t` MUST be a stable reference across renders — see the note in
// AdminCommandsTab.txDisabled.test.tsx; a fresh identity loops forever.
vi.mock('react-i18next', () => {
  const t = (_key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : _key);
  return { useTranslation: () => ({ t }) };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('../hooks/useResolvedSourceId', () => ({ useResolvedSourceId: () => 'source-1' }));
vi.mock('../hooks/useTxStatus', () => ({ useTxStatus: () => ({ isTxDisabled: false }) }));

vi.mock('../services/api', () => ({
  default: {
    setBaseUrl: vi.fn(),
    post: h.apiPost,
    sendAdminCommand: h.apiSendAdminCommand,
    exportChannel: vi.fn(),
    importChannel: vi.fn(),
    getAllChannels: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('./SectionNav', () => ({ default: () => null }));
vi.mock('./configuration/ImportConfigModal', () => ({ ImportConfigModal: () => null }));
vi.mock('./configuration/ExportConfigModal', () => ({ ExportConfigModal: () => null }));
vi.mock('./admin-commands/ModuleConfigurationSection', () => ({ ModuleConfigurationSection: () => null }));
vi.mock('./admin-commands/AutoFavoriteManagementSection', () => ({ default: () => null }));
vi.mock('./admin-commands/DeviceConfigurationSection', () => ({ DeviceConfigurationSection: () => null }));

import AdminCommandsTab from './AdminCommandsTab';

const LOCAL_NODE_ID = '!00000064';
const localNode = {
  nodeNum: 100,
  user: { id: LOCAL_NODE_ID, longName: 'Local Node', shortName: 'LOC1' },
};
const remoteNode = {
  nodeNum: 200,
  user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' },
  hasRemoteAdmin: true,
  lastRemoteAdminCheck: Date.now(),
};

/** Set the page URL `AdminCommandsTab` reads `window.location.search` from. */
function setLocationSearch(search: string) {
  window.history.pushState({}, '', `/admin${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.apiPost.mockResolvedValue({});
  h.apiSendAdminCommand.mockResolvedValue({});
  setLocationSearch('');
});

describe('AdminCommandsTab deep link (#5535)', () => {
  it('pre-selects the node named by ?node= on mount', async () => {
    setLocationSearch('?node=!000000c8');
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const input = await screen.findByPlaceholderText('Remote Node');
    expect(input).toHaveValue('Remote Node');
  });

  it('matches the node id case-insensitively', async () => {
    setLocationSearch('?node=!000000C8');
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const input = await screen.findByPlaceholderText('Remote Node');
    expect(input).toHaveValue('Remote Node');
  });

  it('falls back to the local node when ?node= does not match any known node', async () => {
    setLocationSearch('?node=!deadbeef');
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const input = await screen.findByPlaceholderText('Local Node');
    expect(input).toHaveValue('');
  });

  it('falls back to the local node when there is no ?node= param', async () => {
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const input = await screen.findByPlaceholderText('Local Node');
    expect(input).toHaveValue('');
  });

  it('falls back to the local node for a malformed ?node= value', async () => {
    setLocationSearch('?node=not-a-valid-id');
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    const input = await screen.findByPlaceholderText('Local Node');
    expect(input).toHaveValue('');
  });
});
