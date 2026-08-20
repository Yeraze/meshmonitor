/**
 * AutomationBuilder — the deviceReboot "Remote target node #" field (#4826).
 *
 * The field used `kind: 'number'`, whose `<input type="number">` silently
 * dropped a hex node id (`!3ca956de`) — the browser rejects the non-numeric
 * value, so it reverted to blank on save. It is now `kind: 'nodeNum'`, a text
 * input that accepts BOTH a decimal and a `!hex` id, stores the decimal node
 * number, and surfaces a validation message for genuinely invalid input.
 *
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutomationBuilder from './AutomationBuilder';
import type { WorkflowForm } from './compile';

// Override the global i18n mock so t(key, default) returns the English default.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const PLACEHOLDER = 'blank = locally-connected node; 1017730782 or !3ca956de';
const INVALID_MSG = 'Enter a node number as a decimal (1017730782) or a hex id (!3ca956de).';

function baseForm(targetNodeNum?: unknown): WorkflowForm {
  return {
    trigger: { type: 'trigger.schedule', params: { cron: '0 0 * * *' } },
    rules: [
      {
        conditions: [],
        actions: [{ type: 'action.deviceReboot', params: targetNodeNum === undefined ? {} : { targetNodeNum } }],
      },
    ],
    combine: null,
  };
}

/** Stateful harness so the controlled input round-trips onChange like the real page. */
function Harness({ initial }: { initial?: unknown }) {
  const [form, setForm] = useState<WorkflowForm>(() => baseForm(initial));
  return (
    <>
      <AutomationBuilder
        form={form}
        variables={[]}
        sources={[]}
        channels={[]}
        scripts={[]}
        regions={[]}
        onChange={setForm}
      />
      <output data-testid="stored">{JSON.stringify(form.rules[0].actions[0].params.targetNodeNum)}</output>
    </>
  );
}

const input = () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
const stored = () => screen.getByTestId('stored').textContent;

describe('AutomationBuilder — deviceReboot target node (#4826)', () => {
  it('stores !3ca956de as the decimal node number 1017730782', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '!3ca956de' } });
    expect(stored()).toBe('1017730782');
    // The input keeps showing what the user typed.
    expect(input().value).toBe('!3ca956de');
    expect(screen.queryByText(INVALID_MSG)).toBeNull();
  });

  it('still accepts a bare decimal node number', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '1017730782' } });
    expect(stored()).toBe('1017730782');
    expect(screen.queryByText(INVALID_MSG)).toBeNull();
  });

  it('shows a validation message for invalid input and does not silently drop it', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: '!nope' } });
    expect(screen.getByText(INVALID_MSG)).toBeInTheDocument();
    // The raw text survives in the field rather than vanishing.
    expect(input().value).toBe('!nope');
  });

  it('renders a persisted decimal value on mount (round-trips through save/reload)', () => {
    render(<Harness initial={1017730782} />);
    expect(input().value).toBe('1017730782');
    expect(screen.queryByText(INVALID_MSG)).toBeNull();
  });

  it('clearing the field stores a blank value', () => {
    render(<Harness initial={1017730782} />);
    fireEvent.change(input(), { target: { value: '' } });
    expect(stored()).toBe('""');
    expect(screen.queryByText(INVALID_MSG)).toBeNull();
  });
});
