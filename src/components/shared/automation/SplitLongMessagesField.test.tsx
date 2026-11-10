/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

import { SplitLongMessagesField } from './SplitLongMessagesField';

describe('SplitLongMessagesField', () => {
  it('renders the toggle and the shared-limit warning, and reports changes', () => {
    const onChange = vi.fn();
    render(<SplitLongMessagesField id="x" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Split long messages'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('note')).toHaveTextContent('up to 3 messages, 10 seconds apart');
  });
  it('adds the per-run total when several channels are targeted', () => {
    render(<SplitLongMessagesField id="x" checked onChange={() => {}} perTargetCount={4} />);
    expect(screen.getByRole('note')).toHaveTextContent('4 channels');
    expect(screen.getByRole('note')).toHaveTextContent('12 messages');
  });
  it('disables the checkbox', () => {
    render(<SplitLongMessagesField id="x" checked onChange={() => {}} disabled />);
    expect(screen.getByLabelText('Split long messages')).toBeDisabled();
  });
  it('states the Meshtastic cap and the queue spacing for protocol="meshtastic" (#6330)', () => {
    render(<SplitLongMessagesField id="x" checked={false} onChange={() => {}} protocol="meshtastic" label="Enable Multiline" />);
    expect(screen.getByLabelText('Enable Multiline')).toBeInTheDocument();
    expect(screen.getByText(/A Meshtastic message holds 200 bytes/)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('up to 3 messages, 10 seconds apart');
    expect(screen.getByRole('note')).toHaveTextContent('30 seconds between sends');
  });
  it('keeps the MeshCore description by default', () => {
    render(<SplitLongMessagesField id="x" checked={false} onChange={() => {}} />);
    expect(screen.getByText(/A MeshCore message holds 160 bytes/)).toBeInTheDocument();
    expect(screen.getByRole('note')).not.toHaveTextContent('30 seconds between sends');
  });
});
