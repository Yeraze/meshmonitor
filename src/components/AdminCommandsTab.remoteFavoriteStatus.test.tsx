/**
 * @vitest-environment jsdom
 *
 * #4511: the Remote Admin "Node Management" panel must not imply it knows a
 * remote node's favorite/ignored state. The admin protocol has no query that
 * reads those flags back (admin.proto only defines set/remove), so:
 *
 *  - with a remote admin target and nothing sent yet, the selected-node line
 *    says the status is unknown, and the standing readback note renders;
 *  - the node picker's Favorite/Ignored badges (which come from OUR node's DB)
 *    are hidden while the target is remote — showing them there is the
 *    mislabel bug from #950;
 *  - with a local target nothing changes: badges show, no notes.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  isFavorite: true,
};
const remoteNode = {
  nodeNum: 200,
  user: { id: '!000000c8', longName: 'Remote Node', shortName: 'REM1' },
  isIgnored: true,
};

/** Open the Node Management section so its controls are in the DOM. */
function expandNodeManagement() {
  localStorage.setItem('adminCommandsExpandedSections', JSON.stringify({ 'admin-node-management': true }));
}

/** Pick the admin *target* (which device we send commands to). */
function selectAdminTarget(name: string) {
  const input = screen.getByPlaceholderText('Local Node');
  fireEvent.focus(input);
  fireEvent.click(screen.getByText(name));
}

/** Pick the node the favorite/ignore command acts on. */
function selectManagedNode(name: string) {
  const input = screen.getByPlaceholderText('admin_commands.search_node_to_manage');
  fireEvent.focus(input);
  fireEvent.click(screen.getByText(name));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.apiPost.mockResolvedValue({});
  h.apiSendAdminCommand.mockResolvedValue({});
});

describe('AdminCommandsTab — remote favorite/ignored status is not readable (#4511)', () => {
  it('marks the status unknown and renders the readback note when the admin target is remote', async () => {
    expandNodeManagement();
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    selectAdminTarget('Remote Node');
    await waitFor(() => {
      expect(screen.getByText('admin_commands.remote_status_readback_note')).toBeInTheDocument();
    });

    selectManagedNode('Remote Node');
    await waitFor(() => {
      expect(screen.getByText('admin_commands.remote_status_unknown')).toBeInTheDocument();
    });
    // Nothing was sent this session, so the "from this session" wording must
    // not appear -- it would read as a confirmed state.
    expect(screen.queryByText("admin_commands.remote_status_from_session")).not.toBeInTheDocument();
  });

  it('hides the local-DB Favorite/Ignored badges in the node picker while the target is remote', async () => {
    expandNodeManagement();
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    selectAdminTarget('Remote Node');
    await waitFor(() => {
      expect(screen.getByText('admin_commands.remote_status_readback_note')).toBeInTheDocument();
    });

    // Open the management picker; local node is a favorite and remote node is
    // ignored in OUR DB -- neither badge describes the remote target's NodeDB.
    fireEvent.focus(screen.getByPlaceholderText('admin_commands.search_node_to_manage'));
    expect(screen.queryByText('admin_commands.favorite')).not.toBeInTheDocument();
    expect(screen.queryByText('admin_commands.ignored')).not.toBeInTheDocument();
  });

  it('keeps local-target behaviour unchanged: badges show, no readback notes', async () => {
    expandNodeManagement();
    render(<AdminCommandsTab nodes={[localNode, remoteNode]} currentNodeId={LOCAL_NODE_ID} channels={[]} />);

    // Default target is the local node -- no target switch needed.
    selectManagedNode('Local Node');

    await waitFor(() => {
      expect(screen.getByText('admin_commands.favorite')).toBeInTheDocument();
    });
    expect(screen.queryByText('admin_commands.remote_status_unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('admin_commands.remote_status_readback_note')).not.toBeInTheDocument();
  });
});
