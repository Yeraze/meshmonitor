/**
 * AutomationBuilder — "Use suggested template" and the empty-send warning (#5697).
 *
 * A trigger-specific placeholder on the Message field reads like a saved value,
 * so users saved automations with an empty message that fired and sent nothing.
 * The builder now offers to copy the suggestion in, and says when a step will
 * send nothing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import AutomationBuilder from './AutomationBuilder';
import type { WorkflowForm } from './compile';
import { ACTIONS } from './catalog';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const MOVEMENT_TRIGGERS = ['trigger.leftHome', 'trigger.becameMobile', 'trigger.becameLikelyAircraft'];

function placeholderFor(actionType: string, field: string, trigger: string): string {
  const f = ACTIONS.find((a) => a.type === actionType)!.fields.find((x) => x.name === field)!;
  return f.placeholderByTrigger?.[trigger] ?? f.placeholder!;
}

/** Render the builder with live form state; returns a getter for the latest form. */
function renderBuilder(trigger: string, action: { type: string; params: Record<string, unknown> }) {
  let latest: WorkflowForm | null = null;
  function Harness() {
    const [form, setForm] = useState<WorkflowForm>({
      trigger: { type: trigger, params: {} },
      rules: [{ conditions: [], actions: [action] }],
      combine: null,
    });
    latest = form;
    return (
      <AutomationBuilder form={form} variables={[]} sources={[]} channels={[]} scripts={[]} regions={[]}
        onChange={setForm} />
    );
  }
  render(<Harness />);
  return () => latest!;
}

describe('Use suggested template (#5697)', () => {
  it.each([...MOVEMENT_TRIGGERS, 'trigger.message'])('copies the exact %s suggestion into an empty message', (trigger) => {
    const get = renderBuilder(trigger, { type: 'action.sendMessage', params: { text: '' } });
    const expected = placeholderFor('action.sendMessage', 'text', trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Use suggested template for Message' }));
    expect(get().rules[0].actions[0].params.text).toBe(expected);
    // Tokens intact, and the button goes away once the field has content.
    expect(expected).toContain('{{');
    expect(screen.queryByRole('button', { name: 'Use suggested template for Message' })).not.toBeInTheDocument();
  });

  it('is not offered when the message already has text', () => {
    renderBuilder('trigger.becameMobile', { type: 'action.sendMessage', params: { text: 'mine' } });
    expect(screen.queryByRole('button', { name: /Use suggested template/ })).not.toBeInTheDocument();
  });

  it('is not offered on example-only placeholders', () => {
    renderBuilder('trigger.message', { type: 'action.sendMessage', params: { text: 'hi', to: '' } });
    // "DM to node #" has a placeholder ("blank = channel; …") that is not a template.
    expect(screen.queryByRole('button', { name: /Use suggested template for DM/ })).not.toBeInTheDocument();
  });

  it('offers it on an empty notification body, with the movement suggestion', () => {
    const get = renderBuilder('trigger.leftHome', { type: 'action.notify', params: { title: 'Alert', body: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use suggested template for Body' }));
    expect(get().rules[0].actions[0].params.body).toBe(placeholderFor('action.notify', 'body', 'trigger.leftHome'));
    expect(get().rules[0].actions[0].params.title).toBe('Alert');
  });
});

describe('empty-send warning in the builder (#5697)', () => {
  it('warns that an empty message sends nothing, with a one-tap fix', () => {
    const get = renderBuilder('trigger.becameLikelyAircraft', { type: 'action.sendMessage', params: { text: '' } });
    const warning = screen.getByTestId('empty-send-warning');
    expect(warning).toHaveTextContent('This step will send nothing: the message is empty');
    fireEvent.click(within(warning).getByRole('button', { name: 'Use suggested template' }));
    expect(get().rules[0].actions[0].params.text).toBe(placeholderFor('action.sendMessage', 'text', 'trigger.becameLikelyAircraft'));
    expect(screen.queryByTestId('empty-send-warning')).not.toBeInTheDocument();
  });

  it('notes a notification with only its title', () => {
    renderBuilder('trigger.message', { type: 'action.notify', params: { body: '' } });
    expect(screen.getByTestId('empty-send-warning')).toHaveTextContent('Check this step: the body is empty');
  });

  it('says nothing when the message has text', () => {
    renderBuilder('trigger.message', { type: 'action.sendMessage', params: { text: 'hello' } });
    expect(screen.queryByTestId('empty-send-warning')).not.toBeInTheDocument();
  });
});
