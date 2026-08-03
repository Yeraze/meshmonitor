/**
 * AutomationBuilder — the #4507 case-sensitivity guidance on `condition.string`
 * actually reaches the DOM.
 *
 * This is a render test rather than a catalog-data test on purpose. A condition
 * block's `description` is never rendered (only the trigger's is), so guidance
 * written there would be invisible while every data-level assertion still
 * passed. Only `FieldDef.help` renders, and only this test proves it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

/** A workflow whose single condition is a text comparison using `op`. */
function renderWithStringOp(op: string) {
  const form: WorkflowForm = {
    trigger: { type: 'trigger.message', params: {} },
    rules: [
      {
        conditions: [{ type: 'condition.string', params: { field: 'text', op, value: '' } }],
        actions: [{ type: 'action.nothing', params: {} }],
      },
    ],
    combine: null,
  };
  return render(
    <AutomationBuilder
      form={form} variables={[]} sources={[]} channels={[]} scripts={[]} regions={[]}
      onChange={() => {}}
    />,
  );
}

/**
 * Scope every assertion to the CONDITION block. The trigger's own "Text matches
 * regex" field carries similar copy (#4507 follow-up), so a document-wide query
 * matches two elements and these tests would pass or fail for the wrong reason.
 */
function conditionBlock() {
  const block = screen.getByText('Operator').closest('.ae-block');
  if (!block) throw new Error('condition block not found');
  return within(block as HTMLElement);
}

describe('AutomationBuilder — string condition case guidance (#4507)', () => {
  it('always shows which operators ignore case', () => {
    renderWithStringOp('contains');
    expect(conditionBlock().getByText(/ignore case/i)).toBeInTheDocument();
    expect(conditionBlock().getByText(/case-sensitive/i)).toBeInTheDocument();
  });

  it('shows the (?i) hint when the operator is regex', () => {
    renderWithStringOp('regex');
    expect(conditionBlock().getByText(/\(\?i\)/)).toBeInTheDocument();
  });

  it('does not show the (?i) hint for non-regex operators', () => {
    renderWithStringOp('contains');
    expect(conditionBlock().queryByText(/\(\?i\)/)).not.toBeInTheDocument();
  });

  it('the trigger carries its own regex hint, independent of the condition', () => {
    // Guards the scoping above: if the trigger hint disappears, these tests
    // must not silently start passing against the wrong element.
    renderWithStringOp('contains');
    expect(screen.getByText(/A regular expression matched against the message text/i))
      .toHaveTextContent(/\(\?i\)/);
  });

  it('renders exactly one Value input whichever operator is selected', () => {
    // The two `value` FieldDef variants share a param name; if their showIf
    // guards ever overlap the user sees two inputs bound to the same key.
    for (const op of ['contains', 'regex', 'eq']) {
      const { unmount } = renderWithStringOp(op);
      expect(screen.getAllByText('Value'), `op=${op}`).toHaveLength(1);
      unmount();
    }
  });
});
