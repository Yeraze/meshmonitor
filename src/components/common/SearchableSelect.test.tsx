/**
 * SearchableSelect (#4512) — the combobox that replaced the Packet Monitor's
 * native node `<select>`s.
 *
 * The point of the control is that a list too long to scroll stays reachable by
 * typing, so the tests lean on the behaviours that make that true: filtering by
 * text the label does not show, keyboard operation, and an overflow cap that
 * *tells* you it truncated rather than silently hiding matches.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchableSelect, { type SearchableSelectOption } from './SearchableSelect';

const NODES: SearchableSelectOption[] = [
  { value: '111', label: 'Base Station', keywords: 'BASE !0000006f' },
  { value: '222', label: 'Repeater North', keywords: 'RPTN !000000de' },
  { value: '333', label: 'Mobile Unit', keywords: 'MOB !0000014d' },
];

function setup(props: Partial<React.ComponentProps<typeof SearchableSelect>> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <SearchableSelect
      value=""
      onChange={onChange}
      options={NODES}
      emptyLabel="All Nodes"
      placeholder="Search nodes…"
      ariaLabel="Filter by source node"
      {...props}
    />,
  );
  const input = screen.getByRole('combobox');
  return { onChange, input, ...utils };
}

const optionTexts = () =>
  within(screen.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);

describe('SearchableSelect', () => {
  it('shows the selected option label while closed', () => {
    setup({ value: '222' });
    expect(screen.getByRole('combobox')).toHaveValue('Repeater North');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on focus and offers the empty option alongside the real ones', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    // Caller order is preserved — sorting is the caller's job — with the empty
    // option prepended so arrow keys can reach it like any other row.
    expect(optionTexts()).toEqual(['All Nodes', 'Base Station', 'Repeater North', 'Mobile Unit']);
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  });

  it('filters by label as the user types', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    await user.type(input, 'repea');
    expect(optionTexts()).toEqual(['Repeater North']);
  });

  it('filters by keywords the label never shows — the hex id case', async () => {
    // A user reading the packet table sees "!0000014d" and types that; the
    // dropdown only ever displayed "Mobile Unit".
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    await user.type(input, '!0000014d');
    expect(optionTexts()).toEqual(['Mobile Unit']);
  });

  it('matches case-insensitively on the short name', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    await user.type(input, 'rptn');
    expect(optionTexts()).toEqual(['Repeater North']);
  });

  it('commits the clicked option and closes', async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup();
    await user.click(input);
    await user.type(input, 'base');
    await user.click(screen.getByRole('option', { name: 'Base Station' }));
    expect(onChange).toHaveBeenCalledWith('111');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('selects the empty option to clear the filter', async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup({ value: '111' });
    await user.click(input);
    await user.click(screen.getByRole('option', { name: 'All Nodes' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('navigates and selects with the keyboard alone', async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup();
    await user.click(input);
    // Highlight starts on row 0 ("All Nodes"); two downs reach "Repeater North".
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('222');
  });

  it('tracks the highlighted row in aria-activedescendant', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    const first = input.getAttribute('aria-activedescendant');
    expect(first).toBeTruthy();
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).not.toBe(first);
  });

  it('closes on Escape without changing the value', async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup({ value: '222' });
    await user.click(input);
    await user.type(input, 'base');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // The pending query is discarded, so the field shows the value again.
    expect(input).toHaveValue('Repeater North');
  });

  it('closes on outside pointer-down without changing the value', async () => {
    const user = userEvent.setup();
    const { input, onChange } = setup({ value: '222' });
    await user.click(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers a clear button only once something is selected', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SearchableSelect value="" onChange={() => {}} options={NODES} emptyLabel="All Nodes" />,
    );
    expect(document.querySelector('[data-searchable-select-clear]')).toBeNull();

    const onChange = vi.fn();
    rerender(
      <SearchableSelect value="111" onChange={onChange} options={NODES} emptyLabel="All Nodes" />,
    );
    const clear = document.querySelector('[data-searchable-select-clear]') as HTMLElement;
    expect(clear).not.toBeNull();
    await user.click(clear);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('reports when there is nothing to show', async () => {
    const user = userEvent.setup();
    const { input } = setup();
    await user.click(input);
    await user.type(input, 'zzzznope');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  describe('overflow cap', () => {
    const MANY: SearchableSelectOption[] = Array.from({ length: 250 }, (_, i) => ({
      value: String(i),
      label: `Node ${i}`,
    }));

    it('caps the rendered rows so a huge mesh does not blow up the DOM', async () => {
      const user = userEvent.setup();
      render(<SearchableSelect value="" onChange={() => {}} options={MANY} maxVisible={50} />);
      await user.click(screen.getByRole('combobox'));
      expect(screen.getAllByRole('option')).toHaveLength(50);
    });

    it('says how many it withheld rather than truncating silently', async () => {
      const user = userEvent.setup();
      render(<SearchableSelect value="" onChange={() => {}} options={MANY} maxVisible={50} />);
      await user.click(screen.getByRole('combobox'));
      // 250 options, 50 shown → the user must be told about the other 200.
      expect(screen.getByText(/200 more/)).toBeInTheDocument();
    });

    it('drops the overflow notice once the query narrows below the cap', async () => {
      const user = userEvent.setup();
      render(<SearchableSelect value="" onChange={() => {}} options={MANY} maxVisible={50} />);
      const input = screen.getByRole('combobox');
      await user.click(input);
      await user.type(input, 'Node 24');
      // "Node 24", "Node 240".."Node 249" = 11 matches, under the cap.
      expect(screen.queryByText(/more/)).not.toBeInTheDocument();
      expect(screen.getAllByRole('option')).toHaveLength(11);
    });
  });
});
