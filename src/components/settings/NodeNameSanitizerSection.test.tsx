/**
 * @vitest-environment jsdom
 *
 * NodeNameSanitizerSection (#6382): admin-only, off by default, saves the four
 * keys through /api/settings, and runs the re-scan.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { NodeNameSanitizerSection } from './NodeNameSanitizerSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { authState } = vi.hoisted(() => ({ authState: { isAdmin: true } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: authState.isAdmin } } }),
}));

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | { hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void },
  },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => { saveBarCapture.current = options as typeof saveBarCapture.current; },
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

const STATUS = { success: true, data: { active: true, hits: { total: 5, meshtastic: 3, meshcore: 2, lastHitAt: null } } };

function mockGets(settings: Record<string, string>) {
  apiGetMock.mockImplementation(async (url: string) => (url === '/api/settings' ? settings : STATUS));
}

describe('NodeNameSanitizerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAdmin = true;
    saveBarCapture.current = null;
  });

  it('renders nothing for a non-admin and makes no requests', () => {
    authState.isAdmin = false;
    const { container } = render(<NodeNameSanitizerSection />);
    expect(container.innerHTML).toBe('');
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('defaults to off with the re-scan button disabled, and shows the hit counter', async () => {
    mockGets({});
    render(<NodeNameSanitizerSection />);
    const toggle = await screen.findByTestId('node-name-sanitizer-enabled') as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    expect((screen.getByTestId('node-name-sanitizer-rescan') as HTMLButtonElement).disabled).toBe(true);
    expect((await screen.findByTestId('node-name-sanitizer-hits')).textContent).toMatch(/5/);
  });

  it('saves the four keys, with patterns as a JSON array', async () => {
    mockGets({});
    apiPostMock.mockResolvedValue({ success: true });
    render(<NodeNameSanitizerSection />);
    const toggle = await screen.findByTestId('node-name-sanitizer-enabled') as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));

    fireEvent.click(toggle);
    fireEvent.change(screen.getByTestId('node-name-sanitizer-patterns'), { target: { value: 'spam.example\n\n bit\\.ly/\\S* ' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', {
      nodeNameSanitizeEnabled: 'true',
      nodeNameSanitizeBuiltins: 'true',
      nodeNameSanitizeCustomPatterns: JSON.stringify(['spam.example', 'bit\\.ly/\\S*']),
      nodeNameSanitizePlaceholder: '',
    });
  });

  it('runs the re-scan when the saved setting is on and shows the counts', async () => {
    mockGets({ nodeNameSanitizeEnabled: 'true' });
    apiPostMock.mockResolvedValue({ success: true, data: { scanned: 10, nodesChanged: 2, meshcoreNodesChanged: 1 } });
    render(<NodeNameSanitizerSection />);
    const button = await screen.findByTestId('node-name-sanitizer-rescan') as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));

    fireEvent.click(button);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith('/api/node-name-sanitizer/rescan', {}));
    const result = await screen.findByTestId('node-name-sanitizer-rescan-result');
    expect(result.textContent).toMatch(/10/);
    expect(result.textContent).toMatch(/2/);
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'success');
  });
});
