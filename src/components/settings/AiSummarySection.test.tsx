/**
 * @vitest-environment jsdom
 *
 * AiSummarySection (#6566): loads the three AI endpoint keys, shows the
 * privacy note, and saves them trimmed through the unscoped POST /api/settings.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AiSummarySection } from './AiSummarySection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: showToastMock }) }));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: { current: null as null | { hasChanges: boolean; onSave: () => Promise<void> } },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => { saveBarCapture.current = options as typeof saveBarCapture.current; },
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({ apiGetMock: vi.fn(), apiPostMock: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

describe('AiSummarySection (#6566)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue({ aiSummaryBaseUrl: 'http://ollama:11434/v1', aiSummaryModel: 'llama3', ai_summary_api_token: '' });
    apiPostMock.mockResolvedValue({ success: true });
  });

  it('loads the stored values and shows the privacy note', async () => {
    render(<AiSummarySection />);
    await waitFor(() => expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).value).toBe('http://ollama:11434/v1'));
    expect((screen.getByLabelText(/Model/) as HTMLInputElement).value).toBe('llama3');
    expect((screen.getByLabelText(/API key/) as HTMLInputElement).type).toBe('password');
    expect(screen.getByTestId('ai-summary-privacy')).toBeTruthy();
    expect(saveBarCapture.current?.hasChanges).toBe(false);
  });

  it('saves all three keys, trimmed', async () => {
    render(<AiSummarySection />);
    await waitFor(() => expect((screen.getByLabelText(/Model/) as HTMLInputElement).value).toBe('llama3'));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: '  sk-1  ' } });
    expect(saveBarCapture.current?.hasChanges).toBe(true);
    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', {
      aiSummaryBaseUrl: 'http://ollama:11434/v1',
      aiSummaryModel: 'llama3',
      ai_summary_api_token: 'sk-1',
    });
    expect(showToastMock).toHaveBeenCalledWith(expect.any(String), 'success');
  });
});
