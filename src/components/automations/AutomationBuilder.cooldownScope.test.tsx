/**
 * AutomationBuilder — trigger `cooldownScope` field visibility (#4340 Phase 2
 * WP3 §4.1/§4.2). The "Cooldown applies to" select is hidden while
 * cooldownSeconds is unset, blank (cleared via the number renderer), or `0`,
 * and its stored value must survive a set → clear → set round trip (hidden ≠
 * cleared — the builder never deletes params.cooldownScope).
 *
 * Modeled on AutomationBuilder.emojiMode.test.tsx (Phase 1's showIf consumer),
 * adapted for a TRIGGER-level field (form.trigger.params) rather than an
 * action's params.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function buildForm(triggerParams: Record<string, unknown>): WorkflowForm {
  return {
    trigger: { type: 'trigger.message', params: triggerParams },
    rules: [
      {
        conditions: [],
        actions: [{ type: 'action.nothing', params: {} }],
      },
    ],
    combine: null,
  };
}

function renderBuilder(triggerParams: Record<string, unknown>, onChange: (f: WorkflowForm) => void = () => {}) {
  return render(
    <AutomationBuilder
      form={buildForm(triggerParams)}
      variables={[]}
      sources={[]}
      channels={[]}
      scripts={[]}
      regions={[]}
      onChange={onChange}
    />,
  );
}

/** The <select>/<input> control for a FieldDef, found via its `.ae-field` label. */
function controlFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const container = label.closest('.ae-field');
  if (!container) throw new Error(`No .ae-field ancestor found for label "${labelText}"`);
  const control = container.querySelector('select, input, textarea');
  if (!control) throw new Error(`No control found in field "${labelText}"`);
  return control as HTMLElement;
}

describe('AutomationBuilder — trigger cooldownScope (#4340 Phase 2)', () => {
  it('does not render the select when cooldownSeconds is unset', () => {
    renderBuilder({});
    expect(screen.queryByText('Cooldown applies to')).not.toBeInTheDocument();
  });

  it('does not render the select when cooldownSeconds is 0', () => {
    renderBuilder({ cooldownSeconds: 0 });
    expect(screen.queryByText('Cooldown applies to')).not.toBeInTheDocument();
  });

  it('does not render the select when cooldownSeconds is "" (cleared via the number input)', () => {
    renderBuilder({ cooldownSeconds: '' });
    expect(screen.queryByText('Cooldown applies to')).not.toBeInTheDocument();
  });

  it('renders the select when cooldownSeconds is a positive number', () => {
    renderBuilder({ cooldownSeconds: 60 });
    expect(screen.getByText('Cooldown applies to')).toBeInTheDocument();
  });

  it('changing the select writes params.cooldownScope', async () => {
    const user = userEvent.setup();
    let latest: WorkflowForm = buildForm({ cooldownSeconds: 60 });
    const onChange = (f: WorkflowForm) => { latest = f; };
    renderBuilder({ cooldownSeconds: 60 }, onChange);

    const select = controlFor('Cooldown applies to') as HTMLSelectElement;
    await user.selectOptions(select, 'node');

    expect(latest.trigger.params.cooldownScope).toBe('node');
  });

  it('preserves params.cooldownScope across a set → clear → set round trip (hidden ≠ cleared)', async () => {
    const user = userEvent.setup();
    let latest: WorkflowForm = buildForm({ cooldownSeconds: 60, cooldownScope: 'node' });
    const onChange = (f: WorkflowForm) => { latest = f; };
    const { rerender } = renderBuilder({ cooldownSeconds: 60, cooldownScope: 'node' }, onChange);

    expect(screen.getByText('Cooldown applies to')).toBeInTheDocument();
    expect((controlFor('Cooldown applies to') as HTMLSelectElement).value).toBe('node');

    // Clear the cooldown back to '' via the number input.
    const cooldownInput = controlFor('Cooldown (seconds)') as HTMLInputElement;
    await user.clear(cooldownInput);

    // params.cooldownScope must survive even though the field is now hidden.
    expect(latest.trigger.params.cooldownSeconds).toBe('');
    expect(latest.trigger.params.cooldownScope).toBe('node');

    rerender(
      <AutomationBuilder
        form={latest}
        variables={[]}
        sources={[]}
        channels={[]}
        scripts={[]}
        regions={[]}
        onChange={onChange}
      />,
    );
    expect(screen.queryByText('Cooldown applies to')).not.toBeInTheDocument();

    // Re-set a positive cooldown — the select reappears pre-populated with the
    // preserved value, not reset to the first option.
    rerender(
      <AutomationBuilder
        form={buildForm({ cooldownSeconds: 60, cooldownScope: 'node' })}
        variables={[]}
        sources={[]}
        channels={[]}
        scripts={[]}
        regions={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText('Cooldown applies to')).toBeInTheDocument();
    expect((controlFor('Cooldown applies to') as HTMLSelectElement).value).toBe('node');
  });
});
