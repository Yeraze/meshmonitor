/**
 * AutomationBuilder — "Store result in → This run only" on Run a script, and
 * the `{{ steps.* }}` hints under later fields (#5636).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutomationBuilder from './AutomationBuilder';
import { compile, type WorkflowForm, type FormBlock } from './compile';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const trigger: FormBlock = { type: 'trigger.message', params: {} };
const script = (params: Record<string, unknown> = {}): FormBlock => ({ type: 'action.runScript', params: { scriptPath: 'joke.py', ...params } });
const send = (text: string): FormBlock => ({ type: 'action.sendMessage', params: { text } });

/** Builder with real state, so typing and picking behave as in the page. */
function Harness({ initial, onForm }: { initial: WorkflowForm; onForm?: (f: WorkflowForm) => void }) {
  const [form, setForm] = useState(initial);
  return (
    <AutomationBuilder form={form} variables={[{ name: 'saved', type: 'json' }]} sources={[]} channels={[]}
      scripts={[{ value: 'joke.py', label: 'joke.py' }]} regions={[]}
      onChange={(f) => { setForm(f); onForm?.(f); }} />
  );
}

function setup(initial: WorkflowForm) {
  let latest = initial;
  render(<Harness initial={initial} onForm={(f) => { latest = f; }} />);
  return { form: () => latest, user: userEvent.setup() };
}

const target = () => screen.getByRole('combobox', { name: 'Store result in' }) as HTMLSelectElement;
const nameBox = () => screen.queryByRole('textbox', { name: 'Name for this run' }) as HTMLInputElement | null;

describe('AutomationBuilder — Store result in (#5636)', () => {
  const oneScript: WorkflowForm = { trigger, rules: [{ conditions: [], actions: [script()] }], combine: null };

  it('offers nothing, This run only, and each variable; the name box is hidden until asked for', () => {
    setup(oneScript);
    expect(within(target()).getAllByRole('option').map((o) => o.textContent)).toEqual(['— do not store —', 'This run only', 'saved (json)']);
    expect(target().value).toBe('');
    expect(nameBox()).toBeNull();
  });

  it('This run only reveals the name box and stores params.outputName, not resultVariable', async () => {
    const { form, user } = setup(oneScript);
    await user.selectOptions(target(), 'This run only');
    expect(nameBox()).not.toBeNull();
    expect(screen.getByText('Give the result a name.')).toBeInTheDocument();

    await user.type(nameBox()!, 'joke');
    const params = form().rules[0].actions[0].params;
    expect(params).toEqual({ scriptPath: 'joke.py', outputName: 'joke' });
    expect(compile(form()).nodes[1].params).toEqual({ scriptPath: 'joke.py', outputName: 'joke' });
    expect(screen.getByText('{{ steps.joke.output }}')).toBeInTheDocument();
  });

  it('switching to a variable clears the run name; switching to nothing clears both', async () => {
    const { form, user } = setup({ trigger, rules: [{ conditions: [], actions: [script({ outputName: 'joke' })] }], combine: null });
    expect(target().selectedOptions[0].textContent).toBe('This run only');
    expect(nameBox()!.value).toBe('joke');

    await user.selectOptions(target(), 'saved (json)');
    expect(form().rules[0].actions[0].params).toEqual({ scriptPath: 'joke.py', resultVariable: 'saved' });
    expect(nameBox()).toBeNull();

    await user.selectOptions(target(), '— do not store —');
    expect(form().rules[0].actions[0].params).toEqual({ scriptPath: 'joke.py' });
  });

  it('a saved variable target still loads as that variable', () => {
    setup({ trigger, rules: [{ conditions: [], actions: [script({ resultVariable: 'saved' })] }], combine: null });
    expect(target().value).toBe('saved');
    expect(nameBox()).toBeNull();
  });

  it('flags a malformed name and a name used twice', async () => {
    const { user } = setup({
      trigger,
      rules: [{ conditions: [], actions: [script({ outputName: 'joke' }), script({ outputName: 'joke' })] }],
      combine: null,
    });
    expect(screen.getAllByText('Another step already uses this name. Each name must be unique.')).toHaveLength(2);
    const boxes = screen.getAllByRole('textbox', { name: 'Name for this run' });
    await user.clear(boxes[1]);
    await user.type(boxes[1], 'Bad Name');
    expect(screen.getByText(/Start with a lower-case letter/)).toBeInTheDocument();
    expect(screen.queryByText('Another step already uses this name. Each name must be unique.')).toBeNull();
  });
});

describe('AutomationBuilder — steps.* hints (#5636)', () => {
  it('no hint when an earlier step in the same rule stores the output', () => {
    setup({ trigger, rules: [{ conditions: [], actions: [script({ outputName: 'joke' }), send('{{ steps.joke.output }}')] }], combine: null });
    expect(screen.queryByText(/always empty/)).toBeNull();
    expect(screen.queryByText(/may be empty/)).toBeNull();
  });

  it('"always empty" for a name no step stores', () => {
    setup({ trigger, rules: [{ conditions: [], actions: [send('{{ steps.nope.output }}')] }], combine: null });
    expect(screen.getByText(/is always empty: no step stores its output as "nope"/)).toBeInTheDocument();
  });

  it('"always empty" when the storing step is in another rule, though it is listed first', () => {
    setup({
      trigger,
      rules: [
        { conditions: [], actions: [script({ outputName: 'joke' })] },
        { conditions: [], actions: [send('{{ steps.joke.output }}')] },
      ],
      combine: null,
    });
    expect(screen.getByText(/is always empty: the step that stores "joke" does not run before this one/)).toBeInTheDocument();
  });

  it('"may be empty" in FINALLY (ANY) for a conditional rule\'s output', () => {
    setup({
      trigger,
      rules: [
        { conditions: [{ type: 'condition.numeric', params: { field: 'hops', op: '==', value: 0 } }], actions: [script({ outputName: 'joke' })] },
        { conditions: [], actions: [{ type: 'action.nothing', params: {} }] },
      ],
      combine: { mode: 'ANY', actions: [send('{{ steps.joke.output }}')] },
    });
    expect(screen.getByText(/may be empty: the step that stores "joke" does not always run before this one/)).toBeInTheDocument();
    expect(screen.queryByText(/always empty/)).toBeNull();
  });

  it('the substitutions drawer lists the named steps', async () => {
    const { user } = setup({ trigger, rules: [{ conditions: [], actions: [script({ outputName: 'joke' }), send('hi')] }], combine: null });
    await user.click(screen.getByTitle('All available substitutions'));
    const drawer = screen.getByRole('complementary', { name: 'Substitutions reference' });
    expect(within(drawer).getByText('Step results — this run only')).toBeInTheDocument();
    expect(within(drawer).getByText('{{ steps.joke.output }}')).toBeInTheDocument();
    expect(within(drawer).getByText('{{ steps.NAME.ok }}')).toBeInTheDocument();
  });
});
