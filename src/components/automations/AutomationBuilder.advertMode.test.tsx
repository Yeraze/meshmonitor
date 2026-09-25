/**
 * AutomationBuilder — MeshCore advert reach on action.requestData.
 *
 * - The "Advert reach (MeshCore)" select shows only for op = advert.
 * - A NEW requestData block is seeded with zero_hop (first option).
 * - An action saved before the field existed (no advertMode) displays flood,
 *   which is what the server runs, plus the flood cost warning.
 * - zero_hop shows no warning.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutomationBuilder from './AutomationBuilder';
import type { WorkflowForm } from './compile';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const LABEL = 'Advert reach (MeshCore)';
const WARNING = /at most once per hour per source/;

function buildForm(action: { type: string; params: Record<string, unknown> }): WorkflowForm {
  return {
    trigger: { type: 'trigger.schedule', params: { cron: '0 * * * *' } },
    rules: [{ conditions: [], actions: [action] }],
    combine: null,
  };
}

function renderBuilder(action: { type: string; params: Record<string, unknown> }, onChange: (f: WorkflowForm) => void = () => {}) {
  return render(
    <AutomationBuilder
      form={buildForm(action)}
      variables={[]}
      sources={[]}
      channels={[]}
      scripts={[]}
      regions={[]}
      onChange={onChange}
    />,
  );
}

function reachSelect(): HTMLSelectElement {
  const container = screen.getByText(LABEL).closest('.ae-field');
  if (!container) throw new Error('no .ae-field for advert reach');
  return container.querySelector('select') as HTMLSelectElement;
}

describe('AutomationBuilder — requestData advertMode', () => {
  it('is hidden for non-advert ops', () => {
    renderBuilder({ type: 'action.requestData', params: { op: 'telemetry' } });
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
  });

  it('shows flood (with the warning) for a legacy advert action with no advertMode', () => {
    renderBuilder({ type: 'action.requestData', params: { op: 'advert' } });
    expect(reachSelect().value).toBe('flood');
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it('shows zero_hop without a warning when set', () => {
    renderBuilder({ type: 'action.requestData', params: { op: 'advert', advertMode: 'zero_hop' } });
    expect(reachSelect().value).toBe('zero_hop');
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it('writes the chosen mode into the params', () => {
    const onChange = vi.fn();
    renderBuilder({ type: 'action.requestData', params: { op: 'advert', advertMode: 'zero_hop' } }, onChange);
    fireEvent.change(reachSelect(), { target: { value: 'flood' } });
    const form = onChange.mock.calls.at(-1)![0] as WorkflowForm;
    expect(form.rules[0].actions[0].params.advertMode).toBe('flood');
  });

  it('seeds a newly chosen requestData block with zero_hop', () => {
    const onChange = vi.fn();
    const { container } = renderBuilder({ type: 'action.nothing', params: {} }, onChange);
    // The block-type <select> is the one offering action.requestData.
    const typeSelect = Array.from(container.querySelectorAll('select'))
      .find((s) => s.querySelector('option[value="action.requestData"]')) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'action.requestData' } });
    const form = onChange.mock.calls.at(-1)![0] as WorkflowForm;
    expect(form.rules[0].actions[0]).toMatchObject({ type: 'action.requestData', params: { advertMode: 'zero_hop' } });
  });
});
