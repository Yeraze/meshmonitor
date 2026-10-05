/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TypedConfirmDialog, type TypedConfirmDialogProps } from './TypedConfirmDialog';

function setup(props: Partial<TypedConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <TypedConfirmDialog
      isOpen
      title="Reset node?"
      confirmLabel="Reset"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      <p>This wipes the node.</p>
    </TypedConfirmDialog>,
  );
  return { onConfirm, onCancel, confirm: () => screen.getByRole('button', { name: 'Reset' }) };
}

describe('TypedConfirmDialog', () => {
  it('renders nothing when closed', () => {
    setup({ isOpen: false });
    expect(screen.queryByText('This wipes the node.')).not.toBeInTheDocument();
  });

  it('shows the title, the body and the word to type', () => {
    setup({ confirmWord: 'BASE' });
    expect(screen.getByText('Reset node?')).toBeInTheDocument();
    expect(screen.getByText('This wipes the node.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('keeps Confirm locked until the word matches', async () => {
    const user = userEvent.setup();
    const { onConfirm, confirm } = setup({ confirmWord: 'BASE' });

    expect(confirm()).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'BAS');
    expect(confirm()).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'E');
    expect(confirm()).toBeEnabled();

    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is case sensitive but ignores surrounding spaces', async () => {
    const user = userEvent.setup();
    const { confirm } = setup({ confirmWord: 'BASE' });

    await user.type(screen.getByRole('textbox'), 'base');
    expect(confirm()).toBeDisabled();
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), ' BASE ');
    expect(confirm()).toBeEnabled();
  });

  it('Enter in the field does not confirm a wrong word', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup({ confirmWord: 'BASE' });

    await user.type(screen.getByRole('textbox'), 'nope{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('without a word it is a plain confirm: no field, Confirm ready', async () => {
    const user = userEvent.setup();
    const { onConfirm, confirm } = setup();

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(confirm()).toBeEnabled();
    await user.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Cancel calls onCancel and never onConfirm', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup({ confirmWord: 'BASE' });

    await user.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('busy locks both buttons even when the word matches', async () => {
    const { confirm } = setup({ busy: true });
    expect(confirm()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
  });

  it('clears the typed word when it opens again', async () => {
    const user = userEvent.setup();
    const props = { title: 'T', confirmLabel: 'Reset', confirmWord: 'BASE', onConfirm: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<TypedConfirmDialog isOpen {...props}>body</TypedConfirmDialog>);
    await user.type(screen.getByRole('textbox'), 'BASE');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeEnabled();

    rerender(<TypedConfirmDialog isOpen={false} {...props}>body</TypedConfirmDialog>);
    rerender(<TypedConfirmDialog isOpen {...props}>body</TypedConfirmDialog>);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });
});
