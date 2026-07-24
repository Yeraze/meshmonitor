/**
 * AutomationBuilder — TX-disabled advisory badge on sendSourceMulti source
 * rows (#4294 Phase 3 WP1). The `sendSourceMulti` picker always lists every
 * sendable source as a checkbox row (selected or not); the badge is a
 * per-row hint keyed off that source's own `txEnabled`, not off whether it
 * happens to be checked. It must render only for a row with
 * `txEnabled === false` (strict — undefined means "unknown", not "off"),
 * and must never disable the checkbox — advisory only.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AutomationBuilder, { type SourceOption } from './AutomationBuilder';
import type { WorkflowForm } from './compile';

// Override the global i18n mock from src/test/setup.ts so t(key, default) returns
// the English default — the component calls t() with an inline fallback string.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | Record<string, unknown>) =>
      typeof defaultValue === 'string' ? defaultValue : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const WARNING_TEXT = 'Transmit is disabled on this source — messages sent through it will be skipped.';

function buildForm(sourceIds: string[]): WorkflowForm {
  return {
    trigger: { type: 'trigger.message', params: {} },
    rules: [
      {
        conditions: [],
        actions: [
          { type: 'action.sendMessage', params: { text: 'hi', sourceIds } },
        ],
      },
    ],
    combine: null,
  };
}

const sources: SourceOption[] = [
  { id: 'src-tx-off', name: 'Receive Only Node', type: 'meshtastic_tcp', enabled: true, txEnabled: false },
  { id: 'src-tx-on', name: 'Normal Node', type: 'meshtastic_tcp', enabled: true, txEnabled: true },
  { id: 'src-tx-unknown', name: 'Unknown TX Node', type: 'meshtastic_tcp', enabled: true },
];

function renderBuilder(sourceIds: string[] = []) {
  return render(
    <AutomationBuilder
      form={buildForm(sourceIds)}
      variables={[]}
      sources={sources}
      channels={[]}
      scripts={[]}
      regions={[]}
      onChange={() => {}}
    />,
  );
}

/** The <label> row (checkbox + name + optional badge) for a given source name. */
function rowFor(name: string): HTMLLabelElement {
  const checkbox = screen.getByRole('checkbox', { name: new RegExp(name) });
  const label = checkbox.closest('label');
  if (!label) throw new Error(`No <label> ancestor found for "${name}" checkbox`);
  return label as HTMLLabelElement;
}

describe('AutomationBuilder — TX-disabled advisory badge (#4294 P3)', () => {
  it('shows the warning badge on the row for a source with txEnabled === false', () => {
    renderBuilder();

    const row = rowFor('Receive Only Node');
    expect(row.querySelector('.ae-tx-warn')).not.toBeNull();
    expect(row).toHaveTextContent(WARNING_TEXT);
  });

  it('does not show the badge on the row for a source with txEnabled === true', () => {
    renderBuilder();

    const row = rowFor('Normal Node');
    expect(row.querySelector('.ae-tx-warn')).toBeNull();
  });

  it('does not show the badge on the row for a source with unknown (undefined) txEnabled', () => {
    renderBuilder();

    const row = rowFor('Unknown TX Node');
    expect(row.querySelector('.ae-tx-warn')).toBeNull();
  });

  it('renders exactly one badge across the picker when only one source is TX-disabled', () => {
    renderBuilder();

    expect(document.querySelectorAll('.ae-tx-warn')).toHaveLength(1);
  });

  it('keeps the checkbox enabled and toggleable for a TX-disabled source that is selected — advisory, not a hard block', () => {
    renderBuilder(['src-tx-off']);

    const row = rowFor('Receive Only Node');
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeDisabled();
    expect(checkbox).toBeChecked();
    expect(row.querySelector('.ae-tx-warn')).not.toBeNull();
  });
});
