/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const csrfFetch = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => csrfFetch }));

import { SenderNameField } from './SenderNameField';

const reply = (data: unknown, ok = true) => ({ ok, json: async () => ({ success: ok, data }) });

describe('SenderNameField', () => {
  beforeEach(() => csrfFetch.mockReset());

  it('hides when the feature is off and nothing is stored', async () => {
    csrfFetch.mockResolvedValue(reply({ enabled: false, allowedNames: [], firmwareSupported: true }));
    const { container } = render(<SenderNameField baseUrl="" sourceId="s1" onChange={() => {}} />);
    await waitFor(() => expect(csrfFetch).toHaveBeenCalled());
    expect(container.querySelector('select')).toBeNull();
  });

  it('shows the names and reports a pick; empty clears to undefined', async () => {
    csrfFetch.mockResolvedValue(reply({ enabled: true, allowedNames: ['Bot A'], firmwareSupported: true }));
    const onChange = vi.fn();
    render(<SenderNameField baseUrl="" sourceId="s1" onChange={onChange} />);
    const select = await screen.findByRole('combobox');
    await screen.findByRole('option', { name: 'Bot A' });
    fireEvent.change(select, { target: { value: 'Bot A' } });
    expect(onChange).toHaveBeenCalledWith('Bot A');
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('flags a stored name that is no longer allowed', async () => {
    csrfFetch.mockResolvedValue(reply({ enabled: true, allowedNames: ['Bot A'], firmwareSupported: true }));
    render(<SenderNameField baseUrl="" sourceId="s1" value="Gone" onChange={() => {}} />);
    expect(await screen.findByRole('note')).toHaveTextContent('meshcore.sender_name.stale');
  });
});
