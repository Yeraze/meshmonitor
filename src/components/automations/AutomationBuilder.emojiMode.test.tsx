/**
 * AutomationBuilder — `action.tapback` emojiMode field visibility (#4340 WP3
 * §3.5/§3.4). The Emoji field is hidden while Emoji source = "The message's
 * hop count", and its stored value must survive a hopCount → fixed round
 * trip (hidden ≠ cleared — the builder never deletes params.emoji).
 *
 * Test values for the fixed "emoji" param are plain placeholder strings, not
 * real emoji glyphs — the `emoji` FieldKind has no dedicated renderer (falls
 * through to a plain text input, per the spec's finding #4), and keeping
 * glyph literals out of this file avoids any tension with the "no hardcoded
 * emoji glyph outside a HOP_COUNT_EMOJIS interpolation" rule (#4340 C1),
 * which governs the shipped catalog/token copy this suite is testing.
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

const FIXED_EMOJI = 'fixed-emoji-placeholder';

function buildForm(params: Record<string, unknown>): WorkflowForm {
  return {
    trigger: { type: 'trigger.message', params: {} },
    rules: [
      {
        conditions: [],
        actions: [{ type: 'action.tapback', params }],
      },
    ],
    combine: null,
  };
}

function renderBuilder(params: Record<string, unknown>, onChange: (f: WorkflowForm) => void = () => {}) {
  return render(
    <AutomationBuilder
      form={buildForm(params)}
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

describe('AutomationBuilder — action.tapback emojiMode (#4340)', () => {
  it('shows the Emoji field when emojiMode is "fixed"', () => {
    renderBuilder({ emojiMode: 'fixed', emoji: FIXED_EMOJI });
    expect(screen.getByText('Emoji')).toBeInTheDocument();
  });

  it('shows the Emoji field when emojiMode is absent (legacy graph)', () => {
    renderBuilder({ emoji: FIXED_EMOJI });
    expect(screen.getByText('Emoji')).toBeInTheDocument();
  });

  it('hides the Emoji field when emojiMode is "hopCount"', () => {
    renderBuilder({ emojiMode: 'hopCount', emoji: FIXED_EMOJI });
    expect(screen.queryByText('Emoji')).not.toBeInTheDocument();
  });

  it('still shows the Emoji source select in hopCount mode', () => {
    renderBuilder({ emojiMode: 'hopCount', emoji: FIXED_EMOJI });
    expect(screen.getByText('Emoji source')).toBeInTheDocument();
  });

  it('preserves params.emoji across a hopCount → fixed round trip (hidden ≠ cleared)', async () => {
    const user = userEvent.setup();
    let latest: WorkflowForm = buildForm({ emojiMode: 'hopCount', emoji: FIXED_EMOJI });
    const onChange = (f: WorkflowForm) => { latest = f; };
    const { rerender } = renderBuilder({ emojiMode: 'hopCount', emoji: FIXED_EMOJI }, onChange);

    // The Emoji field is hidden in hopCount mode — only Emoji source + Send via sources render.
    expect(screen.queryByText('Emoji')).not.toBeInTheDocument();

    // Switch the "Emoji source" select back to "A fixed emoji".
    const select = controlFor('Emoji source') as HTMLSelectElement;
    await user.selectOptions(select, 'fixed');

    expect(latest.rules[0].actions[0].params.emojiMode).toBe('fixed');
    // The stored fixed emoji was never deleted while the field was hidden.
    expect(latest.rules[0].actions[0].params.emoji).toBe(FIXED_EMOJI);

    // Re-render with the updated form and confirm the Emoji field is visible again,
    // pre-populated with the preserved value.
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
    expect(screen.getByText('Emoji')).toBeInTheDocument();
    expect((controlFor('Emoji') as HTMLInputElement).value).toBe(FIXED_EMOJI);
  });
});
