/**
 * AutomationBuilder — action.setAutomationEnabled editor (#5445).
 *
 * The Automation field lists existing automations by name and stores the id,
 * with an "Enter an id or template" escape hatch for `{{ }}` ids. The New state
 * select hides when Change = Toggle.
 *
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutomationBuilder, { type AutomationOption } from './AutomationBuilder';
import type { WorkflowForm } from './compile';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const AUTOMATIONS: AutomationOption[] = [
  { id: 'id-a', name: 'Alpha', enabled: true },
  { id: 'id-b', name: 'Bravo', enabled: false },
];
const TEMPLATE_PLACEHOLDER = 'automation id, or {{ var.targetAutomation }}';

function Harness({ params }: { params: Record<string, unknown> }) {
  const [form, setForm] = useState<WorkflowForm>({
    trigger: { type: 'trigger.schedule', params: { cron: '0 22 * * *' } },
    rules: [{ conditions: [], actions: [{ type: 'action.setAutomationEnabled', params }] }],
    combine: null,
  });
  return (
    <>
      <AutomationBuilder form={form} variables={[]} sources={[]} channels={[]} scripts={[]} regions={[]}
        automations={AUTOMATIONS} onChange={setForm} />
      <output data-testid="params">{JSON.stringify(form.rules[0].actions[0].params)}</output>
    </>
  );
}

const params = () => JSON.parse(screen.getByTestId('params').textContent ?? '{}');
const picker = () => screen.getByLabelText('Automation', { selector: 'select' }) as HTMLSelectElement;

describe('AutomationBuilder — setAutomationEnabled (#5445)', () => {
  it('lists automations by name and stores the chosen id', () => {
    render(<Harness params={{ mode: 'set', enabled: 'false' }} />);
    const labels = Array.from(picker().options).map((o) => o.textContent);
    expect(labels).toContain('Alpha');
    expect(labels).toContain('Bravo (disabled)');
    fireEvent.change(picker(), { target: { value: 'id-b' } });
    expect(params().automationId).toBe('id-b');
    expect(screen.queryByPlaceholderText(TEMPLATE_PLACEHOLDER)).toBeNull();
  });

  it('switches to a free-text field for a templated id', () => {
    render(<Harness params={{ automationId: 'id-a', mode: 'set', enabled: 'false' }} />);
    fireEvent.change(picker(), { target: { value: '__custom__' } });
    const input = screen.getByPlaceholderText(TEMPLATE_PLACEHOLDER);
    expect(params().automationId).toBe(''); // the picked id is cleared
    fireEvent.change(input, { target: { value: '{{ var.target }}' } });
    expect(params().automationId).toBe('{{ var.target }}');
  });

  it('opens a saved templated id in free-text mode', () => {
    render(<Harness params={{ automationId: '{{ var.target }}', mode: 'toggle' }} />);
    expect(picker().value).toBe('__custom__');
    expect((screen.getByPlaceholderText(TEMPLATE_PLACEHOLDER) as HTMLInputElement).value).toBe('{{ var.target }}');
  });

  it('hides New state when Change is Toggle', () => {
    render(<Harness params={{ automationId: 'id-a', mode: 'set', enabled: 'false' }} />);
    expect(screen.getByText('New state')).toBeTruthy();
    const mode = screen.getByDisplayValue('Set to') as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: 'toggle' } });
    expect(params().mode).toBe('toggle');
    expect(screen.queryByText('New state')).toBeNull();
  });
});
