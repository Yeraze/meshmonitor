/**
 * @vitest-environment jsdom
 *
 * TriggerCard (#5808): collapse / expand, the delete confirmation, the
 * per-trigger toggle, and Done staying off while a number field is invalid.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TriggerCard, TriggerCardAction, type TriggerCardProps } from './TriggerCard';
import { NumberInput } from '../../common/NumberInput';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../../test/mockI18n');
  return createReactI18nextMock();
});

function renderCard(overrides: Partial<TriggerCardProps> = {}) {
  const props = {
    title: 'ping',
    summary: 'pong',
    chips: [{ label: 'TEXT' }, { label: 'DM+CH0' }],
    expanded: false,
    onEdit: vi.fn(),
    onDone: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const view = render(
    <TriggerCard {...props}>
      <input aria-label="pattern field" defaultValue="ping" />
    </TriggerCard>,
  );
  return { ...view, props };
}

describe('TriggerCard', () => {
  it('collapsed: shows title, summary and chips, hides the editor, and Edit asks to expand', () => {
    const { props } = renderCard();
    expect(screen.getByText('ping')).toBeInTheDocument();
    expect(screen.getByText('pong')).toBeInTheDocument();
    expect(screen.getByText('TEXT')).toBeInTheDocument();
    expect(screen.getByText('DM+CH0')).toBeInTheDocument();
    expect(screen.queryByLabelText('pattern field')).toBeNull();
    expect(screen.queryByRole('button', { name: /done/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
  });

  it('expanded: renders the editor, hides the summary, and Done asks to collapse', () => {
    const { props } = renderCard({ expanded: true });
    expect(screen.getByLabelText('pattern field')).toBeInTheDocument();
    expect(screen.queryByText('pong')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    // The first field gets focus when the editor opens.
    expect(screen.getByLabelText('pattern field')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    expect(props.onDone).toHaveBeenCalledTimes(1);
  });

  it('a parent can toggle it open and closed', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <TriggerCard title="t" expanded={open} onEdit={() => setOpen(true)} onDone={() => setOpen(false)} onDelete={() => {}}>
          <input aria-label="field" />
        </TriggerCard>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(screen.getByLabelText('field')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByLabelText('field')).toBeNull();
  });

  it('Delete asks first: Cancel keeps the trigger, Delete removes it', () => {
    const { props } = renderCard({ deletePreview: 'ping, pong' });
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('ping, pong')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(props.onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /delete/i }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes the confirmation without deleting', () => {
    const { props } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('the per-trigger toggle reports changes; disabled turns off Edit, Delete and the toggle', () => {
    const onEnabledChange = vi.fn();
    const { rerender, props } = renderCard({ enabled: true, onEnabledChange, enableLabel: 'Enable ping' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable ping' }));
    expect(onEnabledChange).toHaveBeenCalledWith(false);

    rerender(
      <TriggerCard {...props} enabled onEnabledChange={onEnabledChange} enableLabel="Enable ping" disabled>
        <input />
      </TriggerCard>,
    );
    expect(screen.getByRole('checkbox', { name: 'Enable ping' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /edit/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  it('shows a "needs attention" chip when collapsed with errors', () => {
    renderCard({ invalid: true });
    expect(screen.getByText(/needs attention/i)).toBeInTheDocument();
  });

  it('renders protocol actions before Edit, collapsed and expanded (#5812)', () => {
    const onRun = vi.fn();
    const action = <TriggerCardAction onClick={onRun}>Run now</TriggerCardAction>;
    const { rerender, props } = renderCard({ actions: action });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(buttons.indexOf('Run now')).toBeLessThan(buttons.findIndex((b) => /edit/i.test(b ?? '')));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(props.onEdit).not.toHaveBeenCalled();

    rerender(<TriggerCard {...props} expanded actions={action} />);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
  });

  it('keeps Done off while a number field in the editor holds invalid text', async () => {
    function Harness() {
      const [v, setV] = useState(60);
      return (
        <TriggerCard title="t" expanded onEdit={() => {}} onDone={() => {}} onDelete={() => {}}>
          <NumberInput aria-label="cooldown" value={v} onChange={setV} min={0} max={3600} integer />
        </TriggerCard>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const done = screen.getByRole('button', { name: /done/i });
    expect(done).not.toBeDisabled();
    await user.clear(screen.getByLabelText('cooldown'));
    expect(done).toBeDisabled();
    await user.type(screen.getByLabelText('cooldown'), '30');
    expect(done).not.toBeDisabled();
  });
});
