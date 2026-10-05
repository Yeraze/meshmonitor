/**
 * @vitest-environment jsdom
 *
 * Header quick-status pill (#5616).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QuickStatusPill } from './QuickStatusPill';
import { STATUS_PRESETS, presetStatusText } from './statusPresets';
import { shouldShowQuickStatus } from './quickStatusGate';
import { AppHeader } from '../AppHeader';
import type { AuthStatus } from '../../contexts/AuthContext';
import { utf8ByteLength } from '../../utils/statusMessage';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { getCurrentConfig, setModuleConfig, showToast } = vi.hoisted(() => ({
  getCurrentConfig: vi.fn(),
  setModuleConfig: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: { getCurrentConfig, setModuleConfig },
}));

vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast }),
}));

// Built from code points so the assertions do not depend on a literal glyph.
const GREEN_CIRCLE = '\u{1F7E2}';
const SOS_SIGN = '\u{1F198}';
const POLICE_LIGHT = '\u{1F6A8}';

function configWith(nodeStatus: string | undefined, supported = true) {
  return {
    moduleConfig: nodeStatus === undefined ? {} : { statusmessage: { nodeStatus } },
    supportedModules: { statusmessage: supported },
  };
}

function renderPill(sourceId: string | null = 'src-a') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuickStatusPill sourceId={sourceId} />
    </QueryClientProvider>,
  );
}

async function openPopover() {
  const pill = await screen.findByTestId('quick-status-pill');
  fireEvent.click(pill);
  return screen.findByTestId('quick-status-popover');
}

beforeEach(() => {
  getCurrentConfig.mockReset();
  setModuleConfig.mockReset();
  showToast.mockReset();
  getCurrentConfig.mockResolvedValue(configWith(''));
  setModuleConfig.mockResolvedValue({ success: true });
});

describe('shouldShowQuickStatus — who sees the pill', () => {
  const base = {
    authenticated: true,
    sourceType: 'meshtastic_tcp' as string | null,
    connectionStatus: 'connected',
    canWriteConfiguration: true,
  };

  it('shows on a connected Meshtastic device source', () => {
    expect(shouldShowQuickStatus(base)).toBe(true);
  });

  it('shows on the legacy single-source view (no source type)', () => {
    expect(shouldShowQuickStatus({ ...base, sourceType: null })).toBe(true);
  });

  it.each(['mqtt_broker', 'mqtt_bridge', 'meshcore', 'reticulum', 'some_future_type'])(
    'hides on a %s source',
    (sourceType) => {
      expect(shouldShowQuickStatus({ ...base, sourceType })).toBe(false);
    },
  );

  it('hides without configuration:write', () => {
    expect(shouldShowQuickStatus({ ...base, canWriteConfiguration: false })).toBe(false);
  });

  it('hides when signed out', () => {
    expect(shouldShowQuickStatus({ ...base, authenticated: false })).toBe(false);
  });

  it.each(['disconnected', 'configuring', 'node-offline', 'user-disconnected'])(
    'hides while the node is %s',
    (connectionStatus) => {
      expect(shouldShowQuickStatus({ ...base, connectionStatus })).toBe(false);
    },
  );
});

describe('AppHeader — quick-status slot', () => {
  const headerProps = (overrides: Partial<React.ComponentProps<typeof AppHeader>> = {}) => ({
    baseUrl: '',
    nodeAddress: '',
    currentNodeId: '',
    nodes: [],
    deviceInfo: null,
    authStatus: { authenticated: false } as AuthStatus,
    connectionStatus: 'connected' as const,
    webSocketConnected: true,
    hasPermission: () => false,
    onFetchSystemStatus: vi.fn(),
    onShowLoginModal: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  });

  const renderHeader = (overrides: Partial<React.ComponentProps<typeof AppHeader>> = {}) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <AppHeader {...headerProps(overrides)} />
      </QueryClientProvider>,
    );
  };

  it('renders no pill and reads no config unless the caller asks for it', async () => {
    renderHeader();
    await Promise.resolve();
    expect(screen.queryByTestId('quick-status-pill')).toBeNull();
    expect(getCurrentConfig).not.toHaveBeenCalled();
  });

  it('renders the pill in header-right, beside the connection status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    const { container } = renderHeader({ showQuickStatus: true, quickStatusSourceId: 'src-a' });
    const pill = await screen.findByTestId('quick-status-pill');
    // header-left is overflow:hidden and would clip the popover.
    expect(container.querySelector('.header-right')!.contains(pill)).toBe(true);
    expect(container.querySelector('.header-left')!.contains(pill)).toBe(false);
    expect(getCurrentConfig).toHaveBeenCalledWith('src-a');
  });
});

describe('QuickStatusPill — visibility', () => {
  it('hides when the firmware has no Status Message module (below 2.7.20)', async () => {
    getCurrentConfig.mockResolvedValue(configWith('', false));
    renderPill();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('quick-status-pill')).toBeNull();
  });

  it('hides when supportedModules is missing from the config', async () => {
    getCurrentConfig.mockResolvedValue({ moduleConfig: { statusmessage: { nodeStatus: 'x' } } });
    renderPill();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('quick-status-pill')).toBeNull();
  });

  it('hides when the config read fails (no configuration:read, or no device)', async () => {
    getCurrentConfig.mockRejectedValue(new Error('Failed to fetch current configuration'));
    renderPill();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId('quick-status-pill')).toBeNull();
  });

  it('shows the current status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    renderPill();
    expect((await screen.findByTestId('quick-status-pill-text')).textContent).toBe('On watch');
  });

  it('shows "Set status" when the status is empty', async () => {
    renderPill();
    expect((await screen.findByTestId('quick-status-pill-text')).textContent).toBe('Set status');
  });

  it('treats an all-default (omitted) statusmessage config as an empty status', async () => {
    // Proto3 omits a sub-message whose fields are all default.
    getCurrentConfig.mockResolvedValue(configWith(undefined));
    renderPill();
    expect((await screen.findByTestId('quick-status-pill-text')).textContent).toBe('Set status');
  });

  it('reads the config once on mount and does not poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPill();
      await screen.findByTestId('quick-status-pill');
      expect(getCurrentConfig).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(getCurrentConfig).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QuickStatusPill — popover', () => {
  it('opens with presets, an input, Save, Clear and the 12-hour note', async () => {
    renderPill();
    const popover = await openPopover();
    for (const preset of STATUS_PRESETS) {
      expect(screen.getByTestId(`quick-status-preset-${preset.id}`)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Custom status')).toBeInTheDocument();
    expect(screen.getByTestId('quick-status-save')).toBeInTheDocument();
    expect(screen.getByTestId('quick-status-clear')).toBeInTheDocument();
    const note = screen.getByTestId('quick-status-note');
    expect(popover.contains(note)).toBe(true);
    expect(note.textContent).toMatch(/12 hours/);
    expect(note.textContent).toMatch(/Clearing the status is not sent/);
  });

  it('re-reads the config when it opens', async () => {
    renderPill();
    await openPopover();
    await waitFor(() => expect(getCurrentConfig).toHaveBeenCalledTimes(2));
  });

  it('closes on Escape', async () => {
    renderPill();
    await openPopover();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('quick-status-popover')).toBeNull();
  });

  it('closes on a click outside', async () => {
    renderPill();
    await openPopover();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('quick-status-popover')).toBeNull();
  });

  it('seeds the input with the current status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    renderPill();
    await openPopover();
    expect((screen.getByLabelText('Custom status') as HTMLInputElement).value).toBe('On watch');
  });
});

describe('QuickStatusPill — presets', () => {
  it('has ten presets, each within the byte limit', () => {
    expect(STATUS_PRESETS).toHaveLength(10);
    for (const preset of STATUS_PRESETS) {
      expect(utf8ByteLength(presetStatusText(preset, preset.defaultLabel))).toBeLessThanOrEqual(79);
    }
  });

  it('has no preset that reads as an emergency or SOS call (#5620 owns that)', () => {
    for (const preset of STATUS_PRESETS) {
      const text = `${preset.id} ${preset.emoji} ${preset.defaultLabel}`;
      expect(text).not.toMatch(/emergency|sos|mayday|urgent(?!\))/i);
      expect(text).not.toContain(SOS_SIGN);
      expect(text).not.toContain(POLICE_LIGHT);
    }
    const help = STATUS_PRESETS.find((preset) => preset.id === 'help');
    expect(help?.defaultLabel).toBe('Need help (non-urgent)');
  });

  it('saves a preset in one click: emoji, space, label', async () => {
    renderPill('src-a');
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-preset-available'));

    const expected = `${GREEN_CIRCLE} Available`;
    await waitFor(() =>
      expect(setModuleConfig).toHaveBeenCalledWith('statusmessage', { nodeStatus: expected }, 'src-a'),
    );
    expect(setModuleConfig).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('quick-status-popover')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toBe(expected));
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not save again when the chosen preset is already the status', async () => {
    getCurrentConfig.mockResolvedValue(configWith(`${GREEN_CIRCLE} Available`));
    renderPill();
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-preset-available'));
    await Promise.resolve();
    expect(setModuleConfig).not.toHaveBeenCalled();
  });
});

describe('QuickStatusPill — free text', () => {
  it('saves typed text', async () => {
    renderPill('src-a');
    await openPopover();
    fireEvent.change(screen.getByLabelText('Custom status'), { target: { value: '  Back at 5  ' } });
    fireEvent.click(screen.getByTestId('quick-status-save'));

    await waitFor(() =>
      expect(setModuleConfig).toHaveBeenCalledWith('statusmessage', { nodeStatus: 'Back at 5' }, 'src-a'),
    );
    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toBe('Back at 5'));
  });

  it('disables Save until the text differs from the current status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    renderPill();
    await openPopover();
    expect(screen.getByTestId('quick-status-save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Custom status'), { target: { value: 'Off watch' } });
    expect(screen.getByTestId('quick-status-save')).not.toBeDisabled();
  });

  it('counts bytes, not characters', async () => {
    renderPill();
    await openPopover();
    const counter = screen.getByTestId('quick-status-counter');
    expect(counter.textContent).toBe('0/79 bytes');

    fireEvent.change(screen.getByLabelText('Custom status'), { target: { value: 'hello' } });
    expect(counter.textContent).toBe('5/79 bytes');

    // One emoji is 4 bytes (and 2 UTF-16 units).
    fireEvent.change(screen.getByLabelText('Custom status'), { target: { value: GREEN_CIRCLE } });
    expect(counter.textContent).toBe('4/79 bytes');
  });

  it('stops at 79 bytes without cutting an emoji in half', async () => {
    renderPill();
    await openPopover();
    const input = screen.getByLabelText('Custom status') as HTMLInputElement;

    // 20 emoji are 80 bytes: the 20th is dropped whole.
    fireEvent.change(input, { target: { value: GREEN_CIRCLE.repeat(20) } });
    expect(input.value).toBe(GREEN_CIRCLE.repeat(19));
    expect(screen.getByTestId('quick-status-counter').textContent).toBe('76/79 bytes');

    fireEvent.change(input, { target: { value: 'a'.repeat(120) } });
    expect(input.value).toBe('a'.repeat(79));
    expect(screen.getByTestId('quick-status-counter').textContent).toBe('79/79 bytes');
  });
});

describe('QuickStatusPill — clear', () => {
  it('saves an empty status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    renderPill('src-a');
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-clear'));

    await waitFor(() =>
      expect(setModuleConfig).toHaveBeenCalledWith('statusmessage', { nodeStatus: '' }, 'src-a'),
    );
    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toBe('Set status'));
  });

  it('is disabled when there is no status to clear', async () => {
    renderPill();
    await openPopover();
    expect(screen.getByTestId('quick-status-clear')).toBeDisabled();
  });
});

describe('QuickStatusPill — optimistic update', () => {
  it('shows the new status before the save resolves', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    let resolveSave: (value: unknown) => void = () => {};
    setModuleConfig.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));

    renderPill();
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-preset-busy'));

    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toMatch(/Busy$/));
    // Marked as pending until the server answers.
    expect(screen.getByTestId('quick-status-pill')).toHaveAttribute('aria-busy', 'true');
    resolveSave({ success: true });
    await waitFor(() => expect(screen.getByTestId('quick-status-pill')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByTestId('quick-status-pill-text').textContent).toMatch(/Busy$/);
  });

  it('rolls back and shows an error when the save fails', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    let rejectSave: (reason: Error) => void = () => {};
    setModuleConfig.mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }));

    renderPill();
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-preset-busy'));

    // Optimistic value first...
    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toMatch(/Busy$/));

    // ...then the node's real status again once the save fails.
    rejectSave(new Error('Not connected to Meshtastic node'));
    await waitFor(() => expect(screen.getByTestId('quick-status-pill-text').textContent).toBe('On watch'));
    expect(showToast).toHaveBeenCalledWith(
      'Could not save the status: Not connected to Meshtastic node',
      'error',
    );
  });

  it('rolls back a failed Clear to the old status', async () => {
    getCurrentConfig.mockResolvedValue(configWith('On watch'));
    setModuleConfig.mockRejectedValue(new Error('nope'));

    renderPill();
    await openPopover();
    fireEvent.click(screen.getByTestId('quick-status-clear'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(screen.getByTestId('quick-status-pill-text').textContent).toBe('On watch');
  });
});
