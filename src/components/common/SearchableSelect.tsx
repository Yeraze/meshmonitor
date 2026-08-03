/**
 * SearchableSelect — a type-to-filter combobox for lists too long to scroll
 * (issue #4512).
 *
 * The Packet Monitor's node filters were native `<select>`s with one `<option>`
 * per node. On a mesh with hundreds of nodes that is a very long scroll, and on
 * mobile a native select gives you no text field to type-to-jump with, so the
 * only way to reach a node is to scroll the whole list by hand.
 *
 * This is deliberately generic (string values, string labels) rather than
 * node-aware, because the Packet Monitor needs it for two different option
 * kinds — real nodes and relay-byte buckets — and several other views have
 * hand-rolled the same "search box + filtered list" idiom. Callers parse their
 * own value types, exactly as they already do with `e.target.value`.
 *
 * Accessibility: this is a real ARIA 1.2 combobox (`role="combobox"` +
 * `role="listbox"` + `aria-activedescendant`), not a div that opens on click.
 * Nothing else in the codebase implements the pattern, so it is spelled out
 * here rather than assumed.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './SearchableSelect.module.css';

export interface SearchableSelectOption {
  /** Submitted value. Mirrors a native `<option value>` — always a string. */
  value: string;
  /** Displayed text, and the primary thing the query matches against. */
  label: string;
  /**
   * Extra text the query matches but which is not displayed — e.g. a node's
   * hex id and short name when the label shows only its long name. Lets a user
   * find `!a4c1382c` by typing it even though the list shows "Base Station".
   */
  keywords?: string;
}

export interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  /**
   * Label for the always-available "no filter" choice (value `''`), e.g.
   * "All Nodes". Omit to make the control require a real selection.
   */
  emptyLabel?: string;
  /** Shown when nothing is selected and the field is empty. */
  placeholder?: string;
  /** Native tooltip, matching the `title` the replaced `<select>` carried. */
  title?: string;
  ariaLabel?: string;
  className?: string;
  /**
   * Cap on rendered rows. Thousands of DOM nodes in a popover is its own
   * performance problem, and a filter box makes a long tail pointless. The
   * overflow is *reported* in the list, never silently dropped.
   */
  maxVisible?: number;
  disabled?: boolean;
  /** Overridable for i18n; defaults are English. */
  noMatchesText?: string;
  /** Receives the number of matches beyond `maxVisible`. */
  moreMatchesText?: (count: number) => string;
}

/** Case-insensitive substring match over label + keywords. */
function optionMatches(option: SearchableSelectOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    option.label.toLowerCase().includes(q) ||
    (option.keywords ?? '').toLowerCase().includes(q)
  );
}

export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  value,
  onChange,
  options,
  emptyLabel,
  placeholder,
  title,
  ariaLabel,
  className,
  maxVisible = 100,
  disabled = false,
  noMatchesText = 'No matches',
  moreMatchesText = (n) => `…and ${n} more — keep typing to narrow`,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  /** The "no filter" row is an option like any other, so arrow keys reach it. */
  const allOptions = useMemo<SearchableSelectOption[]>(
    () => (emptyLabel !== undefined ? [{ value: '', label: emptyLabel }, ...options] : options),
    [emptyLabel, options],
  );

  const selected = useMemo(
    () => allOptions.find((o) => o.value === value),
    [allOptions, value],
  );

  const matches = useMemo(
    () => allOptions.filter((o) => optionMatches(o, query)),
    [allOptions, query],
  );
  const visible = useMemo(() => matches.slice(0, maxVisible), [matches, maxVisible]);
  const overflowCount = matches.length - visible.length;

  /**
   * Closed: show what is selected. Open: show what the user is typing, so the
   * field doubles as the search box rather than needing a second input.
   */
  const displayValue = open ? query : (selected?.label ?? '');

  const showClear = value !== '' && !disabled;

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const commit = useCallback(
    (option: SearchableSelectOption) => {
      onChange(option.value);
      close();
    },
    [close, onChange],
  );

  // Clicking away is a dismissal, not a selection — the pending query is
  // dropped and the previous value stands.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  // A shrinking result set can strand the highlight past the end of the list.
  useEffect(() => {
    setActiveIndex((i) => (i >= visible.length ? 0 : i));
  }, [visible.length]);

  // Keep the highlighted row in view when arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    // Optional-called: keeping the row in view is a nicety, and environments
    // without it (jsdom, older embedded webviews) must not take the control
    // down with a TypeError.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); setActiveIndex(0); return; }
        setActiveIndex((i) => (visible.length === 0 ? 0 : (i + 1) % visible.length));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); setActiveIndex(0); return; }
        setActiveIndex((i) => (visible.length === 0 ? 0 : (i - 1 + visible.length) % visible.length));
        return;
      case 'Home':
        if (open) { e.preventDefault(); setActiveIndex(0); }
        return;
      case 'End':
        if (open) { e.preventDefault(); setActiveIndex(Math.max(0, visible.length - 1)); }
        return;
      case 'Enter': {
        if (!open) return;
        e.preventDefault();
        const option = visible[activeIndex];
        if (option) commit(option);
        return;
      }
      case 'Escape':
        if (open) {
          // Stop here so an enclosing panel/modal doesn't also close.
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        return;
      case 'Tab':
        // Moving focus away commits nothing — same as dismissing.
        if (open) close();
        return;
      default:
    }
  };

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-searchable-select=""
      data-open={open ? 'true' : 'false'}
    >
      <input
        type="text"
        className={[styles.input, showClear ? styles.hasClear : ''].filter(Boolean).join(' ')}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && visible[activeIndex] ? `${baseId}-opt-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        title={title}
        placeholder={placeholder}
        disabled={disabled}
        value={displayValue}
        data-searchable-select-input=""
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // A plain click on a closed field should open it — focus alone does not
        // fire again when the input is already focused.
        onMouseDown={() => { if (!open) setOpen(true); }}
        onKeyDown={handleKeyDown}
      />

      {/* Clears the filter without opening the list — the common next action
          after having narrowed to one node. */}
      {showClear && (
        <button
          type="button"
          className={styles.clear}
          data-searchable-select-clear=""
          aria-label={emptyLabel ?? 'Clear'}
          title={emptyLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(''); close(); }}
        >
          ×
        </button>
      )}

      {open && (
        <ul
          ref={listRef}
          className={styles.list}
          id={listboxId}
          role="listbox"
          data-searchable-select-list=""
        >
          {visible.map((option, index) => (
            <li
              key={`${option.value}-${index}`}
              id={`${baseId}-opt-${index}`}
              className={[
                styles.option,
                index === activeIndex ? styles.active : '',
                option.value === value ? styles.selected : '',
              ].filter(Boolean).join(' ')}
              role="option"
              aria-selected={option.value === value}
              data-index={index}
              data-value={option.value}
              // mousedown, not click: click fires after blur, which would have
              // already closed the list out from under the pointer.
              onMouseDown={(e) => { e.preventDefault(); commit(option); }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {option.label}
            </li>
          ))}

          {visible.length === 0 && (
            <li className={styles.empty} data-searchable-select-empty="" role="presentation">
              {noMatchesText}
            </li>
          )}

          {overflowCount > 0 && (
            <li className={styles.more} data-searchable-select-more="" role="presentation">
              {moreMatchesText(overflowCount)}
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

export default SearchableSelect;
