/**
 * @vitest-environment jsdom
 *
 * "Re-apply after a reboot" switch (#5745): loads the per-source setting on
 * mount and saves it per source through the settings endpoint.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({
  sourceId: 'src-1' as string | null,
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: h.sourceId, sourceName: 'n' }),
}));
vi.mock('../../services/api', () => ({ default: { get: h.get, post: h.post } }));

import StatusMessageReapplyOption from './StatusMessageReapplyOption';

describe('StatusMessageReapplyOption', () => {
  beforeEach(() => {
    h.sourceId = 'src-1';
    h.get.mockReset().mockResolvedValue({});
    h.post.mockReset().mockResolvedValue({ success: true });
  });

  it('is off by default and loads from the source-scoped settings', async () => {
    render(<StatusMessageReapplyOption />);
    const box = await screen.findByLabelText(/Re-apply after a reboot/);
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).not.toBeChecked();
    expect(h.get).toHaveBeenCalledWith('/api/settings?sourceId=src-1');
  });

  it('shows the stored value', async () => {
    h.get.mockResolvedValue({ statusMessageReapplyAfterReboot: 'true' });
    render(<StatusMessageReapplyOption />);
    const box = await screen.findByLabelText(/Re-apply after a reboot/);
    await waitFor(() => expect(box).toBeChecked());
  });

  it('saves per source when toggled', async () => {
    render(<StatusMessageReapplyOption />);
    const box = await screen.findByLabelText(/Re-apply after a reboot/);
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.click(box);
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/settings?sourceId=src-1', { statusMessageReapplyAfterReboot: 'true' }));
    await waitFor(() => expect(box).toBeChecked());
  });

  it('shows an error and keeps the old state when the save fails', async () => {
    h.post.mockRejectedValue(new Error('nope'));
    render(<StatusMessageReapplyOption />);
    const box = await screen.findByLabelText(/Re-apply after a reboot/);
    await waitFor(() => expect(box).not.toBeDisabled());
    fireEvent.click(box);
    await screen.findByRole('alert');
    expect(box).not.toBeChecked();
  });

  it('renders nothing without a source', () => {
    h.sourceId = null;
    const { container } = render(<StatusMessageReapplyOption />);
    expect(container.firstChild).toBeNull();
  });
});
