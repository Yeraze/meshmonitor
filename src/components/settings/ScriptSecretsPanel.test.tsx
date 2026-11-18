/**
 * @vitest-environment jsdom
 *
 * (The global react-i18next mock returns keys, so the queries use keys.)
 *
 * Script Secrets panel: lists names (never values), shows the permanent
 * every-script-gets-every-secret warning, sends PUT/DELETE through apiService,
 * and turns the form off with the server's reason when SESSION_SECRET is unset.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockGet = vi.hoisted(() => vi.fn());
const mockPut = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', () => ({
  default: { get: mockGet, put: mockPut, delete: mockDelete },
}));
vi.mock('../icons', () => ({
  UiIcon: () => null,
}));

import ScriptSecretsPanel from './ScriptSecretsPanel';

const listed = (canStore = true, reason?: string) => ({
  success: true,
  data: {
    canStore,
    ...(reason ? { reason } : {}),
    secrets: [
      { name: 'OPENAI_API_KEY', updatedAt: 1_790_000_000_000, status: 'ok' },
      { name: 'OLD_KEY', updatedAt: 1_790_000_000_000, status: 'unreadable' },
    ],
  },
});

describe('ScriptSecretsPanel', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
    mockDelete.mockReset();
  });

  it('lists names and statuses and shows the global warning', async () => {
    mockGet.mockResolvedValue(listed());
    render(<ScriptSecretsPanel />);
    expect(await screen.findByText('OPENAI_API_KEY')).toBeTruthy();
    expect(screen.getByText('OLD_KEY')).toBeTruthy();
    expect(screen.getByText('scripts.secrets.status_unreadable')).toBeTruthy();
    expect(screen.getByText('scripts.secrets.warning_title')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('/api/script-secrets');
  });

  it('adds a secret with an upper-cased name through apiService.put', async () => {
    mockGet.mockResolvedValue(listed());
    mockPut.mockResolvedValue({ success: true, data: { name: 'WEATHER_KEY', updatedAt: 1, created: true } });
    render(<ScriptSecretsPanel />);
    await screen.findByText('OPENAI_API_KEY');
    fireEvent.change(screen.getByPlaceholderText('scripts.secrets.name_placeholder'), { target: { value: 'weather_key' } });
    fireEvent.change(screen.getByPlaceholderText('scripts.secrets.value_placeholder'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByText('scripts.secrets.add'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith('/api/script-secrets/WEATHER_KEY', { value: 'abc123' }));
  });

  it('rejects a bad name before calling the API', async () => {
    mockGet.mockResolvedValue(listed());
    render(<ScriptSecretsPanel />);
    await screen.findByText('OPENAI_API_KEY');
    fireEvent.change(screen.getByPlaceholderText('scripts.secrets.name_placeholder'), { target: { value: '9BAD' } });
    fireEvent.change(screen.getByPlaceholderText('scripts.secrets.value_placeholder'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('scripts.secrets.add'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('deletes after a confirm step', async () => {
    mockGet.mockResolvedValue(listed());
    mockDelete.mockResolvedValue({ success: true });
    render(<ScriptSecretsPanel />);
    await screen.findByText('OPENAI_API_KEY');
    fireEvent.click(screen.getAllByText('scripts.secrets.delete')[0]);
    fireEvent.click(screen.getByText('scripts.secrets.confirm_delete'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('/api/script-secrets/OPENAI_API_KEY'));
  });

  it('disables storing and shows the reason when SESSION_SECRET is unset', async () => {
    mockGet.mockResolvedValue(listed(false, 'SESSION_SECRET is not set.'));
    render(<ScriptSecretsPanel />);
    expect(await screen.findByText('SESSION_SECRET is not set.')).toBeTruthy();
    expect((screen.getByPlaceholderText('scripts.secrets.name_placeholder') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText('scripts.secrets.add').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
